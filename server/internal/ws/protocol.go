// Package ws：WebSocket 协议定义（模式二信令）。
package ws

// InMsg 客户端 → 服务端
type InMsg struct {
	Type       string `json:"type"` // lease.acquire / lease.release / lease.heartbeat / lease.cancel
	EnvID      string `json:"envId"`
	SnapshotID string `json:"snapshotId,omitempty"` // release 时附带驱逐前上传的新快照
}

// OutMsg 服务端 → 客户端
type OutMsg struct {
	Type           string `json:"type"`
	EnvID          string `json:"envId,omitempty"`
	SnapshotID     string `json:"snapshotId,omitempty"`     // granted：待下载快照
	Stale          bool    `json:"stale,omitempty"`          // granted：是否为失联兜底的旧基线
	HolderDeviceID string `json:"holderDeviceId,omitempty"` // pending：当前持有者
	HolderEmail    string `json:"holderEmail,omitempty"`    // pending（团队环境）：持有成员邮箱
	DeadlineMS     int64  `json:"deadlineMs,omitempty"`     // pending/evict：宽限毫秒
	TeamID         string `json:"teamId,omitempty"`         // team.updated：变更的团队
	Code           string `json:"code,omitempty"`
	Message        string `json:"message,omitempty"`
}

const (
	TypeAcquire   = "lease.acquire"
	TypeRelease   = "lease.release"
	TypeHeartbeat = "lease.heartbeat"
	TypeCancel    = "lease.cancel"

	TypeGranted   = "lease.granted"
	TypePending   = "lease.pending"
	TypeEvict     = "lease.evict"
	TypeReleased  = "lease.released"
	TypeLost      = "lease.lost"
	TypeCancelled = "lease.cancelled"
	TypeEnvUpdate = "env.updated"
	TypeTeamUpdate = "team.updated" // 团队成员/DEK 变更 → 成员端刷新团队与团队环境
	TypeError     = "error"
)
