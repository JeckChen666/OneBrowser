# 生产部署指南（V0.4-C）

> 目标读者：把 OneBrowser 服务端部署到公网 VPS 的运维者。桌面端安装包另见
> `apps/desktop`（`make dist-mac`）。

## 架构

```
客户端 ──HTTPS──> Caddy(:443, ACME 自动证书) ──> onesrv(:8787, compose 内网)
                                                  ├── Postgres（数据卷，不暴露端口）
                                                  └── S3 兼容对象存储（预签名直连，流量不过服务端）
```

- 快照内容是 E2E 密文：服务端与存储都拿不到明文登录态——对象存储选任意可信厂商即可。
- 上传/下载走预签名 URL **直连**对象存储：API 服务器无大流量，1C1G 的小实例即可起步。

## 首次部署

```bash
git clone … && cd OneBrowser/deploy
cp .env.example .env && vim .env        # 必填：DOMAIN / POSTGRES_PASSWORD / S3_*
docker compose -f docker-compose.prod.yml up -d
curl -fsS https://<域名>/v1/health           # {"ok":true}
curl -fsS 'https://<域名>/v1/health?deep=1'  # deps: db=ok s3=ok
```

要求：80/443 可达（ACME HTTP-01 校验）、域名 A 记录指向本机、出网可及 S3 端点。
升级：`git pull && docker compose -f docker-compose.prod.yml up -d --build server`（迁移自动执行）。

## 密钥清单

| 密钥 | 存放 | 轮换 |
|---|---|---|
| POSTGRES_PASSWORD | .env（chmod 600） | 改 .env + `ALTER USER` + 重启 |
| S3_ACCESS_KEY/SECRET | .env | IAM 侧轮换后改 .env 重启 |
| ACME 证书 | caddy-data 卷自动管理 | 自动续期，勿删卷 |
| ADMIN_TOKEN | .env（chmod 600） | 改 .env 重启（工作台 cookie 随即失效） |
| 客户端主密码 | **只在用户脑中**（E2E，服务端无可轮换项） | 用户侧重新注册 |

`.env` 不入 git；备份密钥另存（密码管理器），与数据备份分开保管。

## 备份与恢复

- **Postgres**（用户/环境元数据/租约；量小）：
  `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U onebrowser onebrowser | gzip > pg-$(date +%F).sql.gz`
  建议每日 cron + 异地保留 ≥7 份。恢复：`gunzip -c pg-x.sql.gz | docker compose … exec -T postgres psql -U onebrowser onebrowser`。
- **对象存储**（密文快照主体）：桶版本化（Versioning）+ 跨区复制，或至少每日增量同步到第二桶。
  丢失后果=用户需重新登录各站点（E2E 密文我们无法代为重建）——务必持久。
- **演练**：新机 `docker compose up` + 恢复 pg dump + 指向同桶，注册新账号跑一次登录→建环境→存基线。

## 治理参数（环境变量，均有默认）

| 变量 | 默认 | 说明 |
|---|---|---|
| SNAPSHOT_RETENTION | 5 | 每环境保留 ready 快照数（0=不清理） |
| STALE_UPLOADING_HOURS | 24 | uploading 残骸清扫阈值 |
| USER_QUOTA_GB | 2 | 每用户快照存储配额（0=不限），超限 413 |
| AUTH_RATE_PER_MIN | 20 | 认证接口每 IP 每分钟令牌（0=不限流） |
| AUTH_RATE_BURST | 10 | 令牌桶容量 |
| GEO_API | ip-api.com | 出口 IP 地理推导（可换源） |
| ADMIN_TOKEN | （空） | 运维工作台口令；**空=不挂载 /admin**。仅展示元数据（E2E 密文不可见），登录走认证限流 |

限流为单实例内存态；横向扩容前需换 Redis 后端（代码入口 `internal/ratelimit`）。

## 运维工作台（/admin）

设 `ADMIN_TOKEN` 后访问 `https://<DOMAIN>/admin/`（未设则路由整体不存在，不暴露任何面）。

- **能力（只读）**：概览（账号/环境/快照计数、存储水位、db/s3 依赖、在线会话、限流与保留策略）、
  账号列表（注册时间/设备数/环境数/快照占用）、环境列表（名称/模式/基线大小与时间/租约占用方）、
  最近快照。15s 自动刷新可关。
- **边界**：环境配置与快照载荷是端到端密文，工作台看不到也不该看到；不能改任何数据。
- **鉴权**：口令登录 → HttpOnly cookie（12h）；也支持 `Authorization: Bearer <ADMIN_TOKEN>` 便于
  curl/拨测。登录接口复用认证限流（AUTH_RATE_PER_MIN）。
- **curl 示例**：`curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<DOMAIN>/admin/api/overview`

## 监控要点

- `GET /v1/health?deep=1`：db/s3 依赖探针（浅探针给 LB 用，别带 deep）。
- 日志：`docker compose -f docker-compose.prod.yml logs -f server`（chi 访问日志 + 迁移/清扫日志）。
- 审计：`audit_log` 表（注册/登录/快照 commit/prune 等），按需导出。
- 告警最低配：外部拨测 `health?deep=1` 非 200 即告警（UptimeRobot 等免费档）。

## 已知边界

- 单实例（限流内存态、WS hub 单点）；扩容前不动。
- Google 站点受 DBSC 限制无法跨设备共享登录态（行业硬限制，README 已披露）。
