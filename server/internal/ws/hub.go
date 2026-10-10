package ws

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"onebrowser/server/internal/auth"
)

// LeaseHandler 由 leases.Service 实现（router 装配时注入，避免循环依赖）。
type LeaseHandler func(ctx context.Context, id auth.Identity, in InMsg, reply func(OutMsg))

type Hub struct {
	upgrader websocket.Upgrader
	mu       sync.Mutex
	conns    map[string]map[string]*conn // userID → deviceID → conn
	handler  LeaseHandler
	auth     *auth.Service
}

type conn struct {
	ws   *websocket.Conn
	send chan OutMsg
}

func NewHub(authSvc *auth.Service) *Hub {
	return &Hub{
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin:     func(*http.Request) bool { return true }, // 桌面端无 Origin 概念
		},
		conns: map[string]map[string]*conn{},
		auth:  authSvc,
	}
}

func (h *Hub) SetLeaseHandler(f LeaseHandler) { h.handler = f }

// SendToDevice 向指定设备投递消息；设备不在线返回 false。
func (h *Hub) SendToDevice(userID, deviceID string, msg OutMsg) bool {
	h.mu.Lock()
	c := h.conns[userID][deviceID]
	h.mu.Unlock()
	if c == nil {
		return false
	}
	select {
	case c.send <- msg:
		return true
	case <-time.After(3 * time.Second):
		return false
	}
}

// BroadcastUser 向该用户全部在线设备广播。
func (h *Hub) BroadcastUser(userID string, msg OutMsg) {
	h.mu.Lock()
	devices := h.conns[userID]
	targets := make([]*conn, 0, len(devices))
	for _, c := range devices {
		targets = append(targets, c)
	}
	h.mu.Unlock()
	for _, c := range targets {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// HandleWS: /v1/ws?token=xxx
func (h *Hub) HandleWS(w http.ResponseWriter, r *http.Request) {
	id, err := h.auth.AuthenticateWS(r.Context(), r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	wsConn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &conn{ws: wsConn, send: make(chan OutMsg, 16)}
	h.mu.Lock()
	if h.conns[id.UserID] == nil {
		h.conns[id.UserID] = map[string]*conn{}
	}
	h.conns[id.UserID][id.DeviceID] = c // 同设备重连：旧连接由写泵退出时清理
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		if cur := h.conns[id.UserID][id.DeviceID]; cur == c {
			delete(h.conns[id.UserID], id.DeviceID)
		}
		h.mu.Unlock()
		wsConn.Close()
	}()

	go h.writePump(c, id)
	h.readPump(r.Context(), c, id)
}

func (h *Hub) readPump(ctx context.Context, c *conn, id auth.Identity) {
	c.ws.SetReadLimit(64 << 10)
	_ = c.ws.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.ws.SetPongHandler(func(string) error { return c.ws.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	for {
		var in InMsg
		if err := c.ws.ReadJSON(&in); err != nil {
			return
		}
		_ = c.ws.SetReadDeadline(time.Now().Add(90 * time.Second))
		if h.handler == nil {
			continue
		}
		h.handler(ctx, id, in, func(msg OutMsg) { c.send <- msg })
	}
}

func (h *Hub) writePump(c *conn, id auth.Identity) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteJSON(msg); err != nil {
				log.Printf("ws write %s/%s: %v", id.UserID, id.DeviceID, err)
				return
			}
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
