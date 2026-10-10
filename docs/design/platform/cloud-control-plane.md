# 控制面 `apps/cloud`：详细设计

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)工作包 **C2-1（账号与会话）**、**C2-2（源目录与断言）**、**C2-3（passkey / TOTP / OAuth）**、**C3-3（中继令牌、`me/stream`）**、**C4-2（组织与链接）**、**C6-1 / C6-2（托管与计费预留）** 的实现规格。上位设计：[平台设计](../platform-saas-architecture.md) §4–§6、§9、§11、§16；契约：[协议包](protocol-package.md) §5。
> 代码在 `AMA-Link/armadra-cloud` 仓 `apps/cloud/`；只依赖 `packages/platform-protocol`、`packages/cloud-shared`。

## §1 技术选择（轻量，给出理由）

| 项                    | 选择                                                                              | 理由                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP                  | `node:http` / `node:https` + oRPC `OpenAPIHandler`（`@orpc/server/node`，1.15.4） | 接口层已定 oRPC 契约优先；`/v1/*` 的路径与方法就是契约的 `meta`，一份定义同时出 OpenAPI 文档；不需要第二个框架的路由、中间件与生命周期；与 Armadra core 同一做法 |
| WebSocket             | `ws` 8.21.0                                                                       | 与 Armadra 一致；只有 `/v1/me/stream` 一条                                                                                                                       |
| PostgreSQL 驱动       | `postgres`（postgres.js 3.4.x）                                                   | 零依赖单包、内建连接池与管道、标签模板天然参数化（无字符串拼接 SQL）、原生支持 `LISTEN/NOTIFY` 与事务辅助；比 `pg` 少 4 个传递依赖且 API 更小                    |
| Redis 客户端          | `redis`（node-redis 5.x）                                                         | 官方维护、RESP3、`SUBSCRIBE` 用独立连接的 API 清楚；只用 `GET/SET/INCR/PEXPIRE/EXISTS/PUBLISH/SUBSCRIBE/EVAL`                                                    |
| JWT / JWK             | `node:crypto`（Ed25519）+ 协议包 `./assertion`                                    | 不加 JOSE 库：只需要一种算法、compact 序列化由协议包提供；JWK ↔ KeyObject 用 `createPublicKey/createPrivateKey({ format: "jwk" })`                              |
| 口令 / passkey / TOTP | `node:crypto` scrypt、`@simplewebauthn/server` 14.0.3、`otplib` 13.5.0            | 与 core 同一批库同一版本（参数由 identity-vectors 钉）                                                                                                           |
| 邮件                  | `nodemailer`（SMTP）                                                              | 验证邮件、口令重置；dev-stack 的 mailpit                                                                                                                         |
| 迁移                  | 自写运行器（`packages/cloud-shared/src/db/migrate.ts`，~200 行）                  | 纪律与 core 的 `db/ledger.ts` 同形（SHA-384、拒绝条件、不自动清库）；第三方迁移工具都带自己的账本与方言，无法照搬同一套拒绝条件                                  |
| 运行 TS               | Node 22 原生类型剥离（`erasableSyntaxOnly`）开发态直跑；镜像里 esbuild 单文件     | 不加 tsx / ts-node；与 Armadra 服务器壳的打包方式一致                                                                                                            |

## §2 目录

```text
apps/cloud/
├── package.json        @armadra/cloud；bin: armadra-cloud
├── src/
│   ├── cli.ts          serve | migrate | keys generate|rotate | seed（dev）| version
│   ├── main.ts         装配：config → db(迁移) → redis → signer → services → http
│   ├── config.ts       §9
│   ├── http/           server.ts（node:http + 分派）、rpc.ts（implement(cloudContract) + OpenAPIHandler 挂 /v1、/.well-known、/health）、context.ts（会话解析、CSRF、Origin）、errors.ts、static.ts（/app、/j、/device 页面）
│   ├── auth/           passwords.ts、sessions.ts、jwt.ts、device-code.ts、passkey.ts、totp.ts、oauth/（providers.ts、flow.ts）、throttle.ts、email-verify.ts、password-reset.ts
│   ├── accounts/       store.ts（SQL）、service.ts
│   ├── devices/        store.ts
│   ├── sources/        store.ts、service.ts（注册、断言、中继令牌、隧道令牌、access）、relay-nodes.ts
│   ├── orgs/           store.ts、service.ts
│   ├── links/          store.ts、service.ts
│   ├── stream/         me-stream.ts（WS）、relay-ctl.ts（Redis 订阅 → 账号过滤 → 推送）
│   ├── signing/        keys.ts（文件 / 表）、jwks.ts
│   ├── audit/          log.ts
│   ├── billing/        counters.ts（阶段 6）
│   ├── hosted/         orchestrator.ts（阶段 6；容器 API 抽象）
│   ├── db/             migrations/0001_….sql …、schema.ts（类型）、index.ts
│   └── mail/           smtp.ts、templates/（中英）
└── test/               单测在 src 旁；集成在 test/integration（需 PG + Redis）
```

## §3 PostgreSQL 迁移（`apps/cloud/src/db/migrations/`，账本 `cloud_migrations`，lock 在仓库根 `migrations.lock`）

### 3.1 `0001_accounts.sql`（C2-1）

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE accounts (
  account_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext UNIQUE,                       -- NULL 只允许 OAuth 无邮箱建号（后续补）
  email_verified_at timestamptz,
  display_name      text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 128),
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_credentials (
  credential_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('password','passkey','oauth')),
  provider       text NOT NULL DEFAULT '' CHECK (char_length(provider) <= 64),
  subject        text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 256),
  secret_hash    bytea NOT NULL DEFAULT ''::bytea,
  salt           bytea NOT NULL DEFAULT ''::bytea,
  kdf            text NOT NULL DEFAULT '' CHECK (kdf IN ('','scrypt')),
  kdf_cost       integer NOT NULL DEFAULT 0,
  kdf_block      integer NOT NULL DEFAULT 0,
  kdf_parallel   integer NOT NULL DEFAULT 0,
  kdf_length     integer NOT NULL DEFAULT 0,
  public_key     bytea NOT NULL DEFAULT ''::bytea,
  sign_count     bigint NOT NULL DEFAULT 0,
  aaguid         text NOT NULL DEFAULT '',
  transports_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  label          text NOT NULL DEFAULT '' CHECK (char_length(label) <= 128),
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE UNIQUE INDEX account_credentials_one_password ON account_credentials(account_id) WHERE kind = 'password' AND revoked_at IS NULL;
CREATE UNIQUE INDEX account_credentials_oauth_subject ON account_credentials(provider, subject) WHERE kind = 'oauth' AND revoked_at IS NULL;
CREATE UNIQUE INDEX account_credentials_passkey_id ON account_credentials(subject) WHERE kind = 'passkey' AND revoked_at IS NULL;  -- subject = credentialID(base64url)

CREATE TABLE account_mfa (
  account_id   uuid PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  totp_secret  bytea NOT NULL,                 -- AES-256-GCM 信封（ARMADRA_CLOUD_MASTER_KEY）
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_recovery_codes (
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  PRIMARY KEY (account_id, code_hash)
);
CREATE TABLE account_lockouts (
  account_id       uuid PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
  failures         integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  device_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  platform       text NOT NULL CHECK (platform IN ('ios','android','desktop','browser','server')),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  push_public_key text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);
CREATE INDEX devices_account ON devices(account_id) WHERE revoked_at IS NULL;

CREATE TABLE account_sessions (
  session_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  device_id    uuid NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  refresh_hash bytea NOT NULL UNIQUE,
  rotation     integer NOT NULL DEFAULT 1,
  origin       text NOT NULL DEFAULT '',         -- 浏览器 Cookie 会话绑定来源；Bearer 为空
  csrf_hash    bytea,
  remote_ip    inet,
  user_agent   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX account_sessions_account ON account_sessions(account_id) WHERE revoked_at IS NULL;

CREATE TABLE device_codes (
  device_code_hash bytea PRIMARY KEY,
  user_code        text NOT NULL UNIQUE,
  device_platform  text NOT NULL, device_name text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
  account_id       uuid REFERENCES accounts(account_id) ON DELETE CASCADE,
  session_id       uuid,
  last_polled_at   timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_tokens (                       -- 验证邮件、口令重置
  token_hash bytea PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE signing_keys (
  kid         text PRIMARY KEY,
  alg         text NOT NULL DEFAULT 'EdDSA',
  public_jwk  jsonb NOT NULL,
  private_ref text NOT NULL,                      -- 密钥文件里的条目名；私钥不进库
  active_from timestamptz NOT NULL,
  retired_at  timestamptz
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_account_id uuid,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('account','source','guest','system')),
  action      text NOT NULL,
  org_id      uuid,
  target      text NOT NULL DEFAULT '',
  remote_ip   inet,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb   -- 不放令牌、口令、正文
);
CREATE INDEX audit_log_actor ON audit_log(actor_account_id, at DESC);
CREATE INDEX audit_log_org ON audit_log(org_id, at DESC);
```

### 3.2 `0002_sources.sql`（C2-2）

```sql
CREATE TABLE sources (
  source_id        char(32) PRIMARY KEY CHECK (source_id ~ '^[0-9a-f]{32}$'),
  owner_account_id uuid NOT NULL REFERENCES accounts(account_id),
  org_id           uuid,                          -- 0003 加外键
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  kind             text NOT NULL CHECK (kind IN ('desktop','server','hosted')),
  public_jwk       jsonb NOT NULL,
  core_version     text NOT NULL DEFAULT '',
  protocol_major   integer NOT NULL, protocol_minor integer NOT NULL,
  capabilities     jsonb NOT NULL DEFAULT '[]'::jsonb,
  trusted_origins  jsonb NOT NULL DEFAULT '[]'::jsonb,
  registered_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX sources_owner ON sources(owner_account_id) WHERE revoked_at IS NULL;

CREATE TABLE source_registration_tokens (
  token_hash  bytea PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  org_id      uuid,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by_source char(32)
);

CREATE TABLE source_access (
  source_id  char(32) NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  via        text NOT NULL CHECK (via IN ('owner','link','org')),
  link_id    uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (source_id, account_id)
);
CREATE INDEX source_access_account ON source_access(account_id) WHERE revoked_at IS NULL;
```

### 3.3 `0003_orgs_links.sql`（C4-2）

```sql
CREATE TABLE organizations (
  org_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             citext UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$'),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  owner_account_id uuid NOT NULL REFERENCES accounts(account_id),
  plan             text NOT NULL DEFAULT 'free',
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, account_id)
);
ALTER TABLE sources ADD CONSTRAINT sources_org_fk FOREIGN KEY (org_id) REFERENCES organizations(org_id) ON DELETE SET NULL;

CREATE TABLE links (
  link_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('source_invite','org_join')),
  org_id        uuid REFERENCES organizations(org_id) ON DELETE CASCADE,
  source_id     char(32) REFERENCES sources(source_id) ON DELETE CASCADE,
  invitation_id char(32),
  secret_hash   bytea,                           -- 只有 org_join 存
  label         text NOT NULL DEFAULT '' CHECK (char_length(label) <= 128),
  role          text CHECK (role IN ('viewer','editor','operator','driver')),
  sources_json  jsonb NOT NULL DEFAULT '[]'::jsonb,   -- org_join 附带可达源
  max_uses      integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses          integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  issued_by     uuid NOT NULL REFERENCES accounts(account_id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'source_invite' AND source_id IS NOT NULL AND invitation_id IS NOT NULL) OR (kind = 'org_join' AND org_id IS NOT NULL AND secret_hash IS NOT NULL))
);
CREATE TABLE link_uses (
  link_id    uuid NOT NULL REFERENCES links(link_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  used_at    timestamptz NOT NULL DEFAULT now(),
  result     text NOT NULL CHECK (result IN ('accepted','exhausted','expired','secret_invalid')),
  PRIMARY KEY (link_id, account_id, used_at)
);
ALTER TABLE source_access ADD CONSTRAINT source_access_link_fk FOREIGN KEY (link_id) REFERENCES links(link_id) ON DELETE SET NULL;
```

### 3.4 `0004_billing.sql`（C6-2）

```sql
CREATE TABLE billing_plans (plan text PRIMARY KEY, limits jsonb NOT NULL);     -- { maxSources, maxOnlineMinutes, maxTunnelBytes }
INSERT INTO billing_plans VALUES ('free', '{"maxSources":3,"maxOnlineMinutes":null,"maxTunnelBytes":null}');
CREATE TABLE billing_subscriptions (
  org_id uuid PRIMARY KEY REFERENCES organizations(org_id) ON DELETE CASCADE,
  plan   text NOT NULL REFERENCES billing_plans(plan),
  status text NOT NULL CHECK (status IN ('active','past_due','cancelled')),
  period_start date NOT NULL, period_end date NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage_counters (
  org_id uuid NOT NULL, period date NOT NULL, metric text NOT NULL CHECK (metric IN ('sources','online_minutes','tunnel_bytes')),
  value bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, period, metric)
);
CREATE TABLE hosted_sources (                   -- C6-1
  source_id char(32) PRIMARY KEY REFERENCES sources(source_id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(org_id),
  container_ref text NOT NULL, image text NOT NULL, volume_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('creating','running','stopped','failed','deleting')),
  last_backup_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
```

### 3.5 迁移运行器（`packages/cloud-shared/src/db/migrate.ts`）

- 启动时（`cloud serve` 与 `cloud migrate`）：`SELECT pg_advisory_lock(7230001)` → 账本表不存在且 schema 非空 → 拒绝（`unknown schema`）；存在则逐条比对：未知版本 / 校验和不符（SHA-384）/ `success = false` 脏记录 / 编号缺口 → **拒绝启动并退出 78**，不自动清库；缺的按序执行，每个一个事务（文件首行 `-- no-transaction` 时不包事务）；`cloud_migrations(version int PK, description text, installed_on timestamptz, success bool, checksum bytea, execution_time bigint)`。
- `tools/repo-check.mjs` 的 `migrations` 规则：目录 `apps/cloud/src/db/migrations`，编号连续，字节 sha256 记进 `migrations.lock`。
- relay 不碰库。

## §4 Redis 键（平台设计 §4.2 + 本文补）

| 键                          | 值 / TTL                                               | 写者         | 读者                 |
| --------------------------- | ------------------------------------------------------ | ------------ | -------------------- |
| `route:src:<sourceId>`      | JSON `{ node, tunnelId, sinceMs, coreVersion }` / 45 s | relay        | relay、cloud（在线） |
| `relay:nodes`               | hash `node → { url, startedAt }`                       | relay        | cloud（节点列表）    |
| `presence:acct:<accountId>` | set deviceId / 90 s                                    | cloud stream | cloud                |
| `rl:<kind>:<key>`           | 计数 / 窗口                                            | 两者         | 两者                 |
| `revoked:jti:<jti>`         | 1 / 到 exp                                             | cloud        | relay、cloud         |
| `wsticket:<hash>`           | JSON `{ accountId, deviceId }` / 30 s 一次性（GETDEL） | cloud        | cloud                |
| `devicecode:poll:<hash>`    | 1 / intervalMs（慢轮询限制）                           | cloud        | cloud                |
| `jwks:<issuerHash>`         | JSON / 10 min                                          | relay        | relay                |
| 通道 `relay:ctl`            | `sourceOnline / sourceOffline / kick / revokeJti`      | relay、cloud | relay、cloud         |
| 通道 `relay:node:<node>`    | `closeTunnel / kick`                                   | cloud        | relay                |

## §5 核心流程与状态机

### 5.1 会话

- 访问令牌 = JWT（`armadra-access`，15 分钟，无状态）；刷新 = `account_sessions` 行（30 天；每次刷新 `rotation + 1`、新 `refresh_hash`；旧令牌再来 → 整个会话 `revoked_at`，答 `session_revoked`）。
- 解析会话（`http/context.ts`）：`Origin` 必须恰好一个；来源是 `app.<cloud>` 自身 → Cookie `__Host-armadra-cloud`（会话 id + 随机，哈希存 `refresh_hash`，CSRF 头 `X-Armadra-CSRF` 对写方法必查）；其它来源（桌面页面、手机、服务器壳）→ `Authorization: Bearer <访问令牌>`。两者不混。
- 撤销设备 → 该设备全部会话 `revoked_at`，并 `PUBLISH relay:ctl { revokeJti }`？不需要：中继令牌 1 小时，接受这段窗口；要即时则把该账号近期签出的 `jti` 列表（Redis `issued:acct:<id>` set，TTL 1 h）逐个写 `revoked:jti`。做即时版。

### 5.2 设备码流

```text
pending ──approve(账号会话)──▶ approved ──poll──▶ consumed（签会话一次）
   │ deny ──▶ denied            │ 10 分钟 ──▶ expired
```

`userCode` 8 位无歧义字母（identity-vectors），`verificationUrl = https://app.<cloud>/device?code=XXXX-XXXX`（页面登录后 `auth.deviceApprove`）；`poll` 快于 `intervalMs` → `rate_limited`。

### 5.3 源注册与断言

1. `sources.registrationToken`：账号会话（按配置要求邮箱已验证）；`limit_reached` 当账号拥有的未撤销源 ≥ 计划上限（free 3，阶段 6 前常量）。
2. `sources.register`（匿名 + 令牌）：事务——令牌 `used_at IS NULL AND expires_at > now()` 条件更新 → `sources` upsert（同 id 未撤销且 owner 不同 → `source_taken`；同 owner → 更新公钥与元数据）→ `source_access(owner)` → 审计 `source.register` → 答 `relayOrigins`（`relay:nodes` 的公网地址列表，缺省 `https://*.src.<RELAY_DOMAIN>` 的根）与 `trustedOrigins`（`[APP_ORIGIN, "capacitor://localhost", "https://localhost"]`）。
3. `sources.heartbeatHint`（源 JWS）：`kid` 查 `sources.public_jwk` 验签 → 签隧道令牌（`cnf.jwk`）→ 节点列表（`relay:nodes`，按 region 排序）。
4. `sources.assertion`（账号会话）：`source_access` 未撤销 或 owner 或（源在组织且账号是成员，仅当 `org.sourceDefaultAccess` 打开，缺省关）→ 签断言（`org` 从 `org_members` 取、`device` 从会话）+ 中继令牌 → `online = route 存在`。限流 `assert.acct` 60 / 分钟。
5. `sources.revoke`：`revoked_at`、`PUBLISH relay:ctl { kick, sourceId }`、撤销所有 `src = sourceId` 的中继令牌（`issued:src:<id>` set）、`source_access` 全撤、`me.stream` 推 `sourceRevoked`。

### 5.4 链接

- `links.create`（source_invite）：调用者是该源 owner 或源所在组织的 admin；`invitation_id` 由 core 返回（页面先在 core 建邀请）；不存令牌。（org_join）：组织 admin；`secret` 随机 32 字节，存 sha256。
- `links.accept`：事务 `UPDATE links SET uses = uses + 1 WHERE link_id = $1 AND revoked_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR uses < max_uses) RETURNING *` → 0 行则按原因答 `link_expired / link_exhausted / link_invalid`（各写 `link_uses.result`）；同一账号重复 accept 幂等（已有 `source_access` 则不 `uses + 1`）；`org_join` 校验 `secret_hash`；写 `source_access(via link)`（org_join 对 `sources_json` 的每个）、`org_members(member)`；答断言 + 中继令牌（source_invite）或 `orgId`；`me.stream` 对签发者推 `linkUsed`。

### 5.5 `me.stream`

升级 `GET /v1/me/stream`，子协议 `armadra-ticket.<t>`（`me.streamTicket` 的 30 秒票，Redis GETDEL）；连接后订阅 `relay:ctl`，过滤到「该账号可达的源集合」（登录时算一次，`source_access` 变化时经 Redis 通道 `acct:<id>` 刷新）；每 30 秒服务端 `ping`；`presence:acct` 刷新。

## §6 错误码

全部来自协议包 `./errors`；本仓扫描测试守。HTTP 状态查表；`requestId` 每响应带（`crypto.randomUUID()` 前 8 位），同时进日志。

## §7 安全

- 口令 scrypt（identity-vectors），常见口令表与 core 相同文件（协议包不带 2 MB 文本，cloud 仓自带一份、测试比对 sha256 与 core 公布的值一致）；泄露检查（HIBP k-anonymity）可配，dev-stack 用 `hibp` 替身。
- 锁定：`account_lockouts` + Redis `rl:login.ip`（算法同 identity-vectors `THROTTLE`）。
- 签名密钥文件 `ARMADRA_CLOUD_SIGNING_KEY_FILE`（JSON：`[{ kid, privateKeyPkcs8Pem, activeFrom, retiredAt }]`，0600）；`cloud keys generate` 生成；`keys rotate` 追加；启动时把公钥 upsert 进 `signing_keys`；JWKS 答未 retired 的全部；签名用 `activeFrom ≤ now` 的最新。
- 主密钥 `ARMADRA_CLOUD_MASTER_KEY`（32 字节 hex）只封装 TOTP 密钥。
- 所有查询带 `account_id` / `org_id` 过滤；`sources.get` 只对 owner / 可达者 / 组织成员答；审计写 `audit_log`（不写令牌）。
- CSP（托管页面）：`default-src 'self'; connect-src 'self' https://*.src.<RELAY_DOMAIN> wss://*.src.<RELAY_DOMAIN>; img-src 'self' data: blob:`。
- 不记录请求体；访问日志只有方法、路径（去 query）、状态、耗时、`requestId`、账号 id。

## §8 托管页面与落地页（`http/static.ts`）

`ARMADRA_CLOUD_WEB_ROOT`（镜像内 `/app/web`，`Dockerfile` 从 `ghcr.io/ama-link/armadra-server:<deploy/compat.json 的 web>` `COPY --from`）：`/app/*`、`/j/<linkId>`、`/device` 都答 `index.html`；`/health` 与 `/v1/*` 优先。没有 web root 时 `/j/*` 答最小 HTML（深链 `armadra://join?link=<id>&s=<片段由脚本原样转交>`——片段不发往服务器，HTML 里一段内联脚本把 `location.hash` 拼进深链）。

## §9 配置

| 变量                                   | 必填 | 说明                                                     |
| -------------------------------------- | ---- | -------------------------------------------------------- |
| `ARMADRA_CLOUD_ISSUER`                 | ✔   | `https://api.<cloud>`；JWT `iss`                         |
| `ARMADRA_CLOUD_APP_ORIGIN`             | ✔   | `https://app.<cloud>`；Cookie 来源与 CSP                 |
| `ARMADRA_CLOUD_LISTEN`                 |      | `0.0.0.0:8100`                                           |
| `ARMADRA_CLOUD_DATABASE_URL`           | ✔   | `postgres://…`                                           |
| `ARMADRA_CLOUD_REDIS_URL`              | ✔   | `redis://…`                                              |
| `ARMADRA_CLOUD_SIGNING_KEY_FILE`       | ✔   |                                                          |
| `ARMADRA_CLOUD_MASTER_KEY`             | ✔   | 32 字节 hex                                              |
| `ARMADRA_CLOUD_RELAY_DOMAIN`           | ✔   | `src.<域>` 的 `<域>`（与 relay 一致）                    |
| `ARMADRA_CLOUD_SMTP_URL`               |      | 没有就不发邮件（验证与重置功能答 `unavailable`）         |
| `ARMADRA_CLOUD_REQUIRE_EMAIL_VERIFIED` |      | `0/1`，缺省 0（dev）；参考部署 compose 里 1              |
| `ARMADRA_CLOUD_OAUTH_<ID>_*`           |      | `CLIENT_ID`、`CLIENT_SECRET`、`ISSUER`（OIDC）、`SCOPES` |
| `ARMADRA_CLOUD_HIBP_URL`               |      | 泄露检查；缺省关                                         |
| `ARMADRA_CLOUD_WEB_ROOT`               |      | 托管页面                                                 |
| `ARMADRA_CLOUD_TLS_CERT` / `_KEY`      |      | 不给就是 HTTP（放在反向代理后）                          |
| `ARMADRA_CLOUD_LOG_LEVEL`              |      | `info`                                                   |

## §10 测试清单

单测：`auth/passwords.test.ts`（向量）、`auth/throttle.test.ts`（序列）、`auth/jwt.test.ts`（四种令牌对 fixtures 的签 / 验、kid 轮换）、`auth/device-code.test.ts`（状态机、慢轮询）、`sources/service.test.ts`（注册令牌一次性、`source_taken`、断言内容、`online`）、`links/service.test.ts`（次数、过期、幂等、org_join secret）、`stream/relay-ctl.test.ts`（过滤）、`http/context.test.ts`（Cookie vs Bearer、CSRF、Origin）、`errors.scan.test.ts`。

集成（`test/integration/*.test.ts`，`ARMADRA_CLOUD_TEST_DATABASE_URL` + `REDIS_URL`，CI 服务容器；每个文件用独立 schema `test_<rnd>` 并在结束时 drop）：

- `migrate.test.ts`：空库迁到最新；篡改一条校验和 → 拒绝启动；缺号 → 拒绝；脏记录 → 拒绝；`-- no-transaction`。
- `accounts.test.ts`：注册 → 登录 → 刷新 → 旋转重放撤销 → 设备撤销；浏览器 Cookie 路径与 CSRF。
- `sources.test.ts`：注册令牌 → 注册 → 源 JWS 取隧道令牌 → 断言 → 撤销 → `kick` 发布。
- `links.test.ts`：§5.4 全流程含并发 accept（10 并发对 `max_uses = 5` 恰好 5 成功）。
- `me-stream.test.ts`：票一次性；`relay:ctl` 事件 2 秒内到达；不可达的源不推。
- `openapi.test.ts`：`OpenAPIGenerator` 输出与 `docs/contracts/cloud-openapi.json` 无 diff（`--check`）。

## §11 本地运行

```sh
pnpm dev:up                # docker compose（deploy/dev/compose.yml）起 postgres:17.11-alpine(127.0.0.1:5440) + redis:8.8.3-alpine(127.0.0.1:6390) + mailpit
pnpm db:migrate            # armadra-cloud migrate（读 .env.dev）
pnpm cloud:keys            # 首次：生成 .data/dev/signing-keys.json 与 master key 到 .env.dev
pnpm dev                   # 并行起 cloud(http://127.0.0.1:8100) 与 relay saas(http://127.0.0.1:8101)，node --watch
pnpm seed                  # 建 dev@armadra.test / 口令写 .data/dev/seed.env，一个组织 dev-org
pnpm test                  # 单测；集成测试在 pnpm test:integration（需要 dev:up）
```
