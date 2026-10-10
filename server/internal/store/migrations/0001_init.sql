-- OneBrowser 服务端 V0.1.0 初始结构
CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    verifier     TEXT NOT NULL,            -- Argon2id(authKey) PHC 字符串，authKey 为客户端派生的登录等价凭据
    auth_kdf     TEXT NOT NULL,            -- JSON：派生 authKey 的参数（kdf-info 下发用）
    wrapped_dek  TEXT NOT NULL,            -- E2E 密钥信封（密文，服务端不可解）
    kek_kdf      TEXT NOT NULL,            -- JSON：派生 KEK 的参数（密文参数本身无敏感信息）
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT '',
    platform     TEXT NOT NULL DEFAULT '',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,           -- sha256(token)
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id  TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS environments (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('snapshot','exclusive')),
    config_enc      TEXT NOT NULL DEFAULT '',   -- 环境配置 E2E 密文（含代理密码）
    latest_base_id  TEXT,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_envs_user ON environments(user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS snapshots (
    id         TEXT PRIMARY KEY,
    env_id     TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL DEFAULT '',
    based_on   TEXT,
    state      TEXT NOT NULL CHECK (state IN ('uploading','ready','failed')),
    size_bytes BIGINT NOT NULL DEFAULT 0,
    sha256     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snaps_env ON snapshots(env_id, created_at DESC);

-- 模式二：每环境至多一条租约记录
CREATE TABLE IF NOT EXISTS leases (
    env_id            TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL,
    holder_device_id  TEXT NOT NULL,
    pending_device_id TEXT NOT NULL DEFAULT '',
    state             TEXT NOT NULL CHECK (state IN ('active','evicting')),
    acquired_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    evict_deadline    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT NOT NULL,
    device_id  TEXT NOT NULL DEFAULT '',
    event      TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
