-- V0.6 团队协作（设计定稿见 docs/v0.5.0-plan.md 附录 A）
-- 个人路径零迁移成本：team_id IS NULL 的环境与现行完全一致。

-- 用户身份密钥对（X25519）：私钥由本人 KEK 包裹，公钥明文（供他人包裹 team DEK）
ALTER TABLE users ADD COLUMN identity_pub          TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN wrapped_identity_priv TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS teams (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 成员信封：wrapped_team_dek = 用该成员 identity_pub 包裹的 team DEK（服务端不可解）
CREATE TABLE IF NOT EXISTS team_members (
    team_id          TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('pending','active')),
    wrapped_team_dek TEXT NOT NULL,
    joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);

-- 环境归属：NULL=个人环境；团队环境的 user_id 归因为团队 owner（快照配额/S3 key/prune 一致跟随）
ALTER TABLE environments ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_envs_team ON environments(team_id) WHERE deleted_at IS NULL;
