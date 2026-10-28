// Package leases：模式二（互斥接管）的租约状态机，服务端权威。
//
// 状态流转（规划 §4.5）：
//
//	IDLE ──acquire(B)──► HELD(B)
//	HELD(A) ──acquire(B)──► EVICTING(A→B)：通知 A 驱逐(deadline)，
//	    A 上传快照后 release(snapshotId) → HELD(B)（B 拿到最新快照）
//	    A 失联超时 → sweeper 直接 HELD(B)（stale=true，用旧基线）
package leases

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/store"
	"onebrowser/server/internal/ws"
)

type Notifier interface {
	SendToDevice(userID, deviceID string, msg ws.OutMsg) bool
}

type Service struct {
	DB     *store.Store
	Cfg    config.Config
	notify Notifier
}

func New(db *store.Store, cfg config.Config) *Service {
	return &Service{DB: db, Cfg: cfg}
}

func (s *Service) SetNotifier(n Notifier) { s.notify = n }

func (s *Service) deadlineMS() int64 { return s.Cfg.EvictDeadline.Milliseconds() }

// --- 客户端消息入口（由 ws hub 调用） ---

func (s *Service) HandleClientMsg(ctx context.Context, id auth.Identity, in ws.InMsg, reply func(ws.OutMsg)) {
	envReply := func(t, code, msg string) ws.OutMsg {
		return ws.OutMsg{Type: t, EnvID: in.EnvID, Code: code, Message: msg}
	}
	switch in.Type {
	case ws.TypeAcquire:
		res, err := s.Acquire(ctx, id, in.EnvID)
		switch {
		case err != nil:
			reply(envReply(ws.TypeError, errCode(err), err.Error()))
		case res.Granted:
			reply(ws.OutMsg{Type: ws.TypeGranted, EnvID: in.EnvID, SnapshotID: res.SnapshotID, Stale: res.Stale})
		default:
			reply(ws.OutMsg{Type: ws.TypePending, EnvID: in.EnvID, HolderDeviceID: res.HolderDeviceID,
				HolderEmail: res.HolderEmail, DeadlineMS: s.deadlineMS()})
		}
	case ws.TypeRelease:
		log.Printf("[lease] release env=%s device=%s snapshot=%q", in.EnvID, id.DeviceID, in.SnapshotID)
		err := s.Release(ctx, id, in.EnvID, in.SnapshotID)
		if err != nil {
			reply(envReply(ws.TypeError, errCode(err), err.Error()))
			return
		}
		reply(ws.OutMsg{Type: ws.TypeReleased, EnvID: in.EnvID})
	case ws.TypeHeartbeat:
		if !s.Heartbeat(ctx, id, in.EnvID) {
			reply(ws.OutMsg{Type: ws.TypeLost, EnvID: in.EnvID})
		} // 心跳正常则静默（减少噪音）
	case ws.TypeCancel:
		_ = s.Cancel(ctx, id, in.EnvID)
		reply(ws.OutMsg{Type: ws.TypeCancelled, EnvID: in.EnvID})
	default:
		reply(envReply(ws.TypeError, "unknown_type", "未知消息类型"))
	}
}

// --- 核心状态机 ---

type AcquireResult struct {
	Granted        bool
	SnapshotID     string // granted 时待下载的基线（可为空 = 冷启动）
	Stale          bool
	HolderDeviceID string // pending 时
	HolderEmail    string // pending 且团队环境时：持有成员邮箱（明文元数据，附录 A.6）
}

func (s *Service) Acquire(ctx context.Context, id auth.Identity, envID string) (AcquireResult, error) {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return AcquireResult{}, err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck

	var mode string
	err = tx.QueryRow(ctx, `SELECT mode FROM environments e
		WHERE e.id=$1 AND e.deleted_at IS NULL AND
		  ((e.user_id=$2 AND e.team_id IS NULL) OR
		   (e.team_id IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m
		     WHERE m.team_id = e.team_id AND m.user_id=$2 AND m.state='active')))
		FOR UPDATE OF e`, envID, id.UserID).Scan(&mode)
	if err != nil {
		return AcquireResult{}, errNotFound
	}
	if mode != "exclusive" {
		return AcquireResult{}, errNotApplicable
	}

	var holder, pending, state string
	err = tx.QueryRow(ctx, `SELECT holder_device_id, pending_device_id, state
		FROM leases WHERE env_id=$1 FOR UPDATE`, envID).Scan(&holder, &pending, &state)
	switch {
	case errors.Is(err, pgx.ErrNoRows): // 无租约 → 直接授予
		_, err = tx.Exec(ctx, `INSERT INTO leases (env_id, user_id, holder_device_id, state)
			VALUES ($1,$2,$3,'active')`, envID, id.UserID, id.DeviceID)
		if err != nil {
			return AcquireResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return AcquireResult{}, err
		}
		snap, _ := s.latestBase(ctx, envID)
		return AcquireResult{Granted: true, SnapshotID: snap}, nil

	case err != nil:
		return AcquireResult{}, err
	}

	switch {
	case holder == id.DeviceID: // 幂等：本设备重复 acquire
		_, _ = tx.Exec(ctx, `UPDATE leases SET heartbeat_at=now(), state='active',
			pending_device_id='', evict_deadline=NULL WHERE env_id=$1`, envID)
		if err := tx.Commit(ctx); err != nil {
			return AcquireResult{}, err
		}
		snap, _ := s.latestBase(ctx, envID)
		return AcquireResult{Granted: true, SnapshotID: snap}, nil

	case state == "active": // 他人持有 → 发起驱逐（deadline 用 DB 端时钟，避免客户端/服务器时钟偏差）
		_, err = tx.Exec(ctx, `UPDATE leases SET state='evicting', pending_device_id=$2,
			evict_deadline = now() + make_interval(secs => $3::double precision)
			WHERE env_id=$1`, envID, id.DeviceID, s.Cfg.EvictDeadline.Seconds())
		if err != nil {
			return AcquireResult{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return AcquireResult{}, err
		}
		log.Printf("[lease] evict notice env=%s holder=%s pending=%s", envID, holder, id.DeviceID)
		if s.notify != nil {
			s.notify.SendToDevice(id.UserID, holder, ws.OutMsg{
				Type: ws.TypeEvict, EnvID: envID, DeadlineMS: s.deadlineMS(),
			})
		}
		return AcquireResult{HolderDeviceID: holder, HolderEmail: s.holderEmail(ctx, envID)}, nil

	default: // state == evicting
		if pending == id.DeviceID { // 幂等：本设备已在等待
			if err := tx.Commit(ctx); err != nil {
				return AcquireResult{}, err
			}
			return AcquireResult{HolderDeviceID: holder, HolderEmail: s.holderEmail(ctx, envID)}, nil
		}
		return AcquireResult{}, errEvictionBusy
	}
}

// holderEmail 团队环境的租约持有者邮箱（个人环境返回空，客户端展示设备号）。
// best-effort：查不到不影响租约语义。
func (s *Service) holderEmail(ctx context.Context, envID string) string {
	var email string
	var isTeam bool
	err := s.DB.Pool.QueryRow(ctx, `
		SELECT u.email, (e.team_id IS NOT NULL) FROM leases l
		JOIN environments e ON e.id = l.env_id
		JOIN users u ON u.id = l.user_id
		WHERE l.env_id=$1`, envID).Scan(&email, &isTeam)
	if err != nil || !isTeam {
		return ""
	}
	return email
}

func (s *Service) Release(ctx context.Context, id auth.Identity, envID, snapshotID string) error {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck

	var holder, pending, state string
	err = tx.QueryRow(ctx, `SELECT holder_device_id, pending_device_id, state
		FROM leases WHERE env_id=$1 FOR UPDATE`, envID).Scan(&holder, &pending, &state)
	if err != nil {
		return nil // 无租约：幂等成功
	}
	if holder != id.DeviceID {
		return nil // 非持有者释放：幂等成功
	}

	if state == "evicting" && pending != "" {
		// 移交给等待设备：附带驱逐前上传的最新快照
		_, err = tx.Exec(ctx, `UPDATE leases SET holder_device_id=$2, state='active',
			pending_device_id='', evict_deadline=NULL, acquired_at=now(), heartbeat_at=now()
			WHERE env_id=$1`, envID, pending)
		if err != nil {
			return err
		}
		userID := id.UserID
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		snap := snapshotID
		stale := false
		if snap == "" {
			snap, _ = s.latestBase(ctx, envID)
			stale = true
		}
		if s.notify != nil {
			s.notify.SendToDevice(userID, pending, ws.OutMsg{
				Type: ws.TypeGranted, EnvID: envID, SnapshotID: snap, Stale: stale,
			})
		}
		return nil
	}

	_, err = tx.Exec(ctx, `DELETE FROM leases WHERE env_id=$1`, envID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) Heartbeat(ctx context.Context, id auth.Identity, envID string) bool {
	tag, err := s.DB.Pool.Exec(ctx,
		`UPDATE leases SET heartbeat_at=now() WHERE env_id=$1 AND holder_device_id=$2 AND user_id=$3`,
		envID, id.DeviceID, id.UserID)
	return err == nil && tag.RowsAffected() > 0
}

// Cancel：等待方取消 acquire → 租约回到持有者继续持有。
func (s *Service) Cancel(ctx context.Context, id auth.Identity, envID string) error {
	_, err := s.DB.Pool.Exec(ctx, `UPDATE leases SET state='active', pending_device_id='', evict_deadline=NULL
		WHERE env_id=$1 AND pending_device_id=$2 AND user_id=$3`, envID, id.DeviceID, id.UserID)
	return err
}

// --- 兜底回收 ---

func (s *Service) RunSweeper(ctx context.Context) {
	t := time.NewTicker(s.Cfg.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweepOnce(ctx)
		}
	}
}

func (s *Service) sweepOnce(ctx context.Context) {
	// 1) 持有者失联（心跳超时）→ 回收租约
	if _, err := s.DB.Pool.Exec(ctx, `DELETE FROM leases WHERE state='active'
		AND heartbeat_at < now() - make_interval(secs => $1)`, s.Cfg.HeartbeatTTL.Seconds()); err != nil {
		log.Printf("lease sweep delete: %v", err)
	}

	// 2) 驱逐超时（持有者没在 deadline 内释放）→ 直接移交给等待设备（stale）
	rows, err := s.DB.Pool.Query(ctx, `SELECT env_id, user_id, pending_device_id FROM leases
		WHERE state='evicting' AND evict_deadline < now() AND pending_device_id <> ''`)
	if err != nil {
		log.Printf("lease sweep query: %v", err)
		return
	}
	type expired struct{ envID, userID, pending string }
	var list []expired
	for rows.Next() {
		var e expired
		if err := rows.Scan(&e.envID, &e.userID, &e.pending); err == nil {
			list = append(list, e)
		}
	}
	rows.Close()

	for _, e := range list {
		s.grantExpired(ctx, e.envID, e.userID, e.pending)
	}
}

func (s *Service) grantExpired(ctx context.Context, envID, userID, pending string) {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck
	var stillPending string
	err = tx.QueryRow(ctx, `SELECT pending_device_id FROM leases WHERE env_id=$1 AND state='evicting' FOR UPDATE`,
		envID).Scan(&stillPending)
	if err != nil || stillPending != pending {
		return // 状态已变化（可能刚好 release 了），跳过
	}
	_, err = tx.Exec(ctx, `UPDATE leases SET holder_device_id=$2, state='active',
		pending_device_id='', evict_deadline=NULL, acquired_at=now(), heartbeat_at=now()
		WHERE env_id=$1`, envID, pending)
	if err != nil {
		return
	}
	if err := tx.Commit(ctx); err != nil {
		return
	}
	snap, _ := s.latestBase(ctx, envID)
	if s.notify != nil {
		s.notify.SendToDevice(userID, pending, ws.OutMsg{
			Type: ws.TypeGranted, EnvID: envID, SnapshotID: snap, Stale: true,
		})
	}
	log.Printf("lease evict timeout: env=%s granted to %s (stale)", envID, pending)
}

func (s *Service) latestBase(ctx context.Context, envID string) (string, error) {
	var snap *string
	err := s.DB.Pool.QueryRow(ctx, `SELECT latest_base_id FROM environments WHERE id=$1`, envID).Scan(&snap)
	if err != nil || snap == nil {
		return "", err
	}
	return *snap, nil
}

// --- 错误 ---

var (
	errNotFound      = errors.New("env not found")
	errNotApplicable = errors.New("lease not applicable: env mode is snapshot")
	errEvictionBusy  = errors.New("another eviction in progress, retry later")
)

func errCode(err error) string {
	switch err {
	case errNotFound:
		return "env_not_found"
	case errNotApplicable:
		return "lease_not_applicable"
	case errEvictionBusy:
		return "eviction_busy"
	default:
		return "internal"
	}
}
