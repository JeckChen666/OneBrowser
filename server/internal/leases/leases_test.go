package leases

import (
	"context"
	"os"
	"testing"
	"time"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/store"
	"onebrowser/server/internal/ws"
)

// 需要 TEST_DATABASE_URL（指向可丢弃的测试库），否则跳过。
// make test-db 提供：docker run 一个一次性 postgres。
func testDB(t *testing.T) *store.Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.Pool.Exec(context.Background(),
			`TRUNCATE leases, snapshots, environments, auth_sessions, devices, users CASCADE`)
		s.Close()
	})
	return s
}

type fakeNotifier struct {
	sent []sentMsg
}

type sentMsg struct {
	user, device string
	msg          ws.OutMsg
}

func (f *fakeNotifier) SendToDevice(userID, deviceID string, msg ws.OutMsg) bool {
	f.sent = append(f.sent, sentMsg{userID, deviceID, msg})
	return true
}

func newTestService(t *testing.T) (*Service, *fakeNotifier, string, string) {
	db := testDB(t)
	ctx := context.Background()

	// 造一个用户 + exclusive 环境
	userID := store.NewUUID()
	_, err := db.Pool.Exec(ctx,
		`INSERT INTO users (id, email, verifier, auth_kdf, wrapped_dek, kek_kdf)
		 VALUES ($1,$2,'x','{}','x','{}')`, userID, userID+"@t.local")
	if err != nil {
		t.Fatal(err)
	}
	envID := store.NewUUID()
	_, err = db.Pool.Exec(ctx,
		`INSERT INTO environments (id, user_id, name, mode) VALUES ($1,$2,'e2e','exclusive')`,
		envID, userID)
	if err != nil {
		t.Fatal(err)
	}

	cfg := config.Load()
	cfg.EvictDeadline = 300 * time.Millisecond
	cfg.HeartbeatTTL = 300 * time.Millisecond
	svc := New(db, cfg)
	n := &fakeNotifier{}
	svc.SetNotifier(n)
	return svc, n, userID, envID
}

func devA() auth.Identity { return auth.Identity{UserID: "u", DeviceID: "devA"} }
func devB() auth.Identity { return auth.Identity{UserID: "u", DeviceID: "devB"} }

func TestLeaseAcquireGrantAndIdempotent(t *testing.T) {
	svc, _, userID, envID := newTestService(t)
	ctx := context.Background()
	a := auth.Identity{UserID: userID, DeviceID: "devA"}

	res, err := svc.Acquire(ctx, a, envID)
	if err != nil || !res.Granted {
		t.Fatalf("acquire A = %+v, %v", res, err)
	}
	res, err = svc.Acquire(ctx, a, envID) // 幂等
	if err != nil || !res.Granted {
		t.Fatalf("acquire A again = %+v, %v", res, err)
	}
	if !svc.Heartbeat(ctx, a, envID) {
		t.Fatal("heartbeat should succeed for holder")
	}
}

func TestLeaseEvictHandoff(t *testing.T) {
	svc, n, userID, envID := newTestService(t)
	ctx := context.Background()
	a := auth.Identity{UserID: userID, DeviceID: "devA"}
	b := auth.Identity{UserID: userID, DeviceID: "devB"}

	if _, err := svc.Acquire(ctx, a, envID); err != nil {
		t.Fatal(err)
	}

	// B 请求 → pending，A 收到驱逐通知
	res, err := svc.Acquire(ctx, b, envID)
	if err != nil || res.Granted || res.HolderDeviceID != "devA" {
		t.Fatalf("acquire B = %+v, %v", res, err)
	}
	if len(n.sent) != 1 || n.sent[0].msg.Type != ws.TypeEvict || n.sent[0].device != "devA" {
		t.Fatalf("evict notification = %+v", n.sent)
	}

	// A 上传后释放并附带快照 → B 被授予该快照
	if err := svc.Release(ctx, a, envID, "snap-123"); err != nil {
		t.Fatal(err)
	}
	if len(n.sent) != 2 || n.sent[1].msg.Type != ws.TypeGranted ||
		n.sent[1].device != "devB" || n.sent[1].msg.SnapshotID != "snap-123" || n.sent[1].msg.Stale {
		t.Fatalf("granted notification = %+v", n.sent)
	}
	// 新持有者心跳正常
	if !svc.Heartbeat(ctx, b, envID) {
		t.Fatal("heartbeat should succeed for new holder")
	}
}

func TestLeaseEvictTimeoutStaleGrant(t *testing.T) {
	svc, n, userID, envID := newTestService(t)
	ctx := context.Background()
	a := auth.Identity{UserID: userID, DeviceID: "devA"}
	b := auth.Identity{UserID: userID, DeviceID: "devB"}

	if _, err := svc.Acquire(ctx, a, envID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Acquire(ctx, b, envID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond) // 超过驱逐 deadline
	svc.sweepOnce(ctx)

	granted := findMsg(n, ws.TypeGranted, "devB")
	if granted == nil {
		t.Fatalf("sweeper should grant pending device, sent=%+v", n.sent)
	}
	if !granted.Stale {
		t.Fatal("timeout grant should be stale")
	}
}

func TestLeaseHeartbeatTimeoutReclaimed(t *testing.T) {
	svc, _, userID, envID := newTestService(t)
	ctx := context.Background()
	a := auth.Identity{UserID: userID, DeviceID: "devA"}

	if _, err := svc.Acquire(ctx, a, envID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond) // 超过心跳 TTL
	svc.sweepOnce(ctx)

	if svc.Heartbeat(ctx, a, envID) {
		t.Fatal("lease should have been reclaimed after heartbeat timeout")
	}
	// 回收后 B 可直接获得
	res, err := svc.Acquire(ctx, auth.Identity{UserID: userID, DeviceID: "devB"}, envID)
	if err != nil || !res.Granted {
		t.Fatalf("B acquire after reclaim = %+v, %v", res, err)
	}
}

func TestLeaseModeNotApplicable(t *testing.T) {
	svc, _, userID, _ := newTestService(t)
	ctx := context.Background()
	snapEnv := store.NewUUID()
	if _, err := svc.DB.Pool.Exec(ctx,
		`INSERT INTO environments (id, user_id, name, mode) VALUES ($1,$2,'s','snapshot')`,
		snapEnv, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Acquire(ctx, auth.Identity{UserID: userID, DeviceID: "devA"}, snapEnv); err != errNotApplicable {
		t.Fatalf("want errNotApplicable, got %v", err)
	}
}

func findMsg(n *fakeNotifier, typ, device string) *ws.OutMsg {
	for i := len(n.sent) - 1; i >= 0; i-- {
		if n.sent[i].msg.Type == typ && n.sent[i].device == device {
			return &n.sent[i].msg
		}
	}
	return nil
}
