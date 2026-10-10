package main

// 标准 HTTP 正向代理（测试用）：绝对 URI 请求直接转发，CONNECT 隧道双向管道。
// 运行：PROXY_LISTEN=:18081 go run . （与站点模式互斥，供 T13 代理链路验收）。

import (
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

func runProxy(addr string) {
	srv := &http.Server{
		Addr:         addr,
		Handler:      http.HandlerFunc(proxyHandler),
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 120 * time.Second,
	}
	log.Printf("test-site proxy listening on %s", addr)
	log.Fatal(srv.ListenAndServe())
}

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("[proxy] %s %s from=%s", r.Method, r.URL.String(), r.RemoteAddr)
	if r.Method == http.MethodConnect {
		handleConnect(w, r)
		return
	}
	// 绝对 URI 形式的明文代理请求
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Header.Del("Proxy-Connection")
	out.Header.Set("Connection", "close")
	out.Close = true
	resp, err := http.DefaultTransport.RoundTrip(out)
	if err != nil {
		http.Error(w, "proxy: upstream "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Connection", "close")
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func handleConnect(w http.ResponseWriter, r *http.Request) {
	dst, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
	if err != nil {
		http.Error(w, "proxy: dial "+err.Error(), http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		dst.Close()
		http.Error(w, "proxy: hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, _, err := hj.Hijack()
	if err != nil {
		dst.Close()
		return
	}
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	go pipe(client, dst)
	go pipe(dst, client)
}

func pipe(from, to net.Conn) {
	_, _ = io.Copy(from, to) // 双向任一方向结束即关闭两侧
	_ = from.Close()
	_ = to.Close()
}

func proxyMain() {
	addr := os.Getenv("PROXY_LISTEN")
	if addr == "" {
		addr = ":18081"
	}
	runProxy(addr)
}
