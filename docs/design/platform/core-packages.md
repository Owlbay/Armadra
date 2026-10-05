# Armadra core 侧工作包：详细设计

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)里 Armadra 仓 core 侧工作包的实现规格：**A1-3 客户端源表与远程服务（`core/sources/`，迁移 0039，契约 §33）**、**A2-3 云登录与登记（`core/identity/cloud/`，迁移 0040，契约 §31）**、**A3-0 五条流统一发送队列**、**A3-2 隧道客户端（`core/relay/`，契约 §32）**、**A4-1 邀请多次使用**、**A4-4 服务器壳 CLI**、**A5-1 桌面包内服务器壳**、**A6-2 配额**。上位设计：[平台设计](../platform-saas-architecture.md) §4.3、§5、§8、§10、§13.2、§17；协议：[协议包](protocol-package.md)。
> 规矩：core 不 import `electron` / `../main/` / `../shell-core/`；新外呼登记 `net/outbound.ts`；新接口按 E1 的契约写（`packages/shared/src/contract/<域>.ts` + `meta.legacy` 指向 §31–§33 的路径），匿名面只经 legacy 路径暴露；文案进 `apps/web/src/i18n/`。

## §1 A1-3 客户端源表与远程服务（`core/sources/`，0039，§33）

### 1.1 迁移 `0039_client_sources.sql`

```sql
-- 客户端源表（契约 §33）：这台 core 作为「客户端宿主」记住的别的源，以及它登记过 / 能登录的远程服务。
-- 凭据不在这里：源会话的刷新令牌在 SecretStore `armadra-source-<source_id>`，远程服务的刷新令牌在 `armadra-remote-<service_id>`。
CREATE TABLE client_sources (
  source_id      TEXT PRIMARY KEY CHECK(length(source_id) = 32),
  kind           TEXT NOT NULL CHECK(kind IN ('local', 'direct', 'relayed', 'hosted')),
  label          TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
  base_url       TEXT NOT NULL DEFAULT '' CHECK(length(base_url) <= 2048),      -- direct 的 Gateway 来源
  relay_origin   TEXT NOT NULL DEFAULT '' CHECK(length(relay_origin) <= 2048),  -- relayed：中继来源（relayBaseUrl 由断言响应给，不存）
  fingerprint    TEXT NOT NULL DEFAULT '' CHECK(length(fingerprint) IN (0, 64)), -- direct 的信任锚指纹
  cloud_issuer   TEXT NOT NULL DEFAULT '' CHECK(length(cloud_issuer) <= 2048),  -- relayed：经哪个远程服务
  principal_hint TEXT NOT NULL DEFAULT '' CHECK(length(principal_hint) <= 256),
  added_at_ms    INTEGER NOT NULL CHECK(added_at_ms > 0),
  last_ok_at_ms  INTEGER NOT NULL DEFAULT 0 CHECK(last_ok_at_ms >= 0),
  order_index    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE remote_services (
  service_id    TEXT PRIMARY KEY CHECK(length(service_id) = 32),
  kind          TEXT NOT NULL CHECK(kind IN ('personal', 'saas')),
  issuer        TEXT NOT NULL UNIQUE CHECK(length(issuer) BETWEEN 1 AND 2048),
  label         TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 128),
  account_hint  TEXT NOT NULL DEFAULT '' CHECK(length(account_hint) <= 256),
  fingerprint   TEXT NOT NULL DEFAULT '' CHECK(length(fingerprint) IN (0, 64)), -- personal 自签 CA 的指纹
  added_at_ms   INTEGER NOT NULL CHECK(added_at_ms > 0),
  last_ok_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_ok_at_ms >= 0)
) WITHOUT ROWID;
```

`local` 源一行由 core 启动时 upsert（`source_id = hostId`，`label` = 主机名，`kind = 'local'`，不可删）。

### 1.2 模块

```text
core/sources/
├── index.ts        install(context): SourcesService；注册契约实现
├── store.ts        SQL：list/upsert/delete、remote list/upsert/delete、touchOk
├── service.ts      SourcesService：业务 + SecretStore 读写 + 远程服务客户端
├── remote-client.ts 对远程服务的 /v1 调用（OpenAPILink，协议包 cloud-api）；登记进 net/outbound.ts: cloudApi
├── session-broker.ts POST /api/sources/{id}/session：用刷新令牌换访问令牌（不落盘访问令牌）
└── *.test.ts
```

### 1.3 契约（`packages/shared/src/contract/sources.ts`，§33；全部 owner only，`scope: "settings:write"`，读 `settings:read`）

| procedure                  | legacy                                   | input                                                                                                       | output                                                                                                   | errors                                                                                |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `sources.list`             | `GET /api/sources`                       | `{}`                                                                                                        | `{ sources: ClientSource[], remotes: RemoteService[] }`（无凭据）                                        |                                                                                       |
| `sources.addDirect`        | `POST /api/sources/direct`               | `{ pairLink?: string, origin?: string, code?: string, fingerprint?: string, label? }`                       | `ClientSource`（core 代页面完成配对：`POST <origin>/api/identity/pair`，存刷新令牌）                     | `source_unreachable`、`source_unauthorized`、`fingerprint_mismatch`                   |
| `sources.update`           | `PUT /api/sources/{sourceId}`            | `{ sourceId, label?, orderIndex?, baseUrl?, relayOrigin? }`                                                 | `ClientSource`                                                                                           | `not_found`                                                                           |
| `sources.remove`           | `DELETE /api/sources/{sourceId}`         | `{ sourceId }`                                                                                              | `{}`（删行 + 删 SecretStore；`local` 答 `conflict`）                                                     |                                                                                       |
| `sources.forget`           | `POST /api/sources/{sourceId}/forget`    | `{ sourceId }`                                                                                              | `{}`（只删凭据，保留行 = 「断开」）                                                                      |                                                                                       |
| `sources.session`          | `POST /api/sources/{sourceId}/session`   | `{ sourceId, via?: "direct"\|"relayed" }`                                                                   | `{ accessToken, accessExpiresAtMs, httpBase, wsBase, via, relayToken?, relayTokenExpiresAtMs? }`         | `source_unauthorized`（刷新失败 → 页面走远程服务重取断言）、`source_unreachable`      |
| `sources.remoteAdd`        | `POST /api/sources/remotes`              | `{ kind: "personal", issuer, account, password, label?, fingerprint? } \| { kind: "saas", issuer, label? }` | `{ remote: RemoteService, next: "ready" \| { deviceCode: { userCode, verificationUrl, expiresAtMs } } }` | `credentials_invalid`、`account_locked`、`fingerprint_mismatch`、`source_unreachable` |
| `sources.remoteDevicePoll` | `POST /api/sources/remotes/{id}/poll`    | `{ serviceId }`                                                                                             | `{ status: "pending"\|"ready"\|"denied"\|"expired" }`                                                    |                                                                                       |
| `sources.remoteRemove`     | `DELETE /api/sources/remotes/{id}`       | `{ serviceId }`                                                                                             | `{}`（若本机已登记到它，先 `identity.cloud.revoke`）                                                     |                                                                                       |
| `sources.remoteSources`    | `GET /api/sources/remotes/{id}/sources`  | `{ serviceId }`                                                                                             | `{ sources: RemoteSourceSummary[] }`（远程服务的 `me.sources`，带 `mounted: boolean`）                   | `source_unauthorized`                                                                 |
| `sources.mount`            | `POST /api/sources/remotes/{id}/mount`   | `{ serviceId, sourceId, label? }`                                                                           | `ClientSource`（core 取断言 → 经 `relayBaseUrl` `cloud/login` → 存刷新令牌；`relayed` 行）               | `source_offline`、`cloud_account_unlinked`（透传源的拒绝）                            |
| `sources.remoteSession`    | `POST /api/sources/remotes/{id}/session` | `{ serviceId }`                                                                                             | `{ accessToken, accessExpiresAtMs, issuer, capabilities }`（页面要直接调远程服务（分享、链接）时用）     | `source_unauthorized`                                                                 |

`ClientSource = { sourceId, kind, label, baseUrl, relayOrigin, fingerprint, cloudIssuer, principalHint, addedAtMs, lastOkAtMs, orderIndex, hasCredentials: boolean }`。`RemoteService = { serviceId, kind, issuer, label, accountHint, fingerprint, addedAtMs, lastOkAtMs, registered: boolean /* 本机是否登记到它 */, hasCredentials }`。

手机不经本机 core：同样的操作由页面直接对远程服务与源做（client 包 §2），`sources.*` 只在桌面与服务器壳的页面上用。

### 1.4 SecretStore

- `armadra-source-<sourceId>`：`{ byOrigin: { [origin]: { refreshToken, deviceId } } }`（直连与中继各一份）。
- `armadra-remote-<serviceId>`：`{ refreshToken, deviceId }`。
- 访问令牌不存；口令不存；`sources.session` 每次用刷新令牌换新对并写回（旋转）。

### 1.5 行为

- `sources.session`：`via` 省略时按 D27 选路：并行 `GET <baseUrl>/api/identity/hello`（1.5 秒）与（若 `relayed`）向远程服务取断言；直连成功且 `hostId === sourceId` → 用直连的刷新令牌换票；否则中继。都不行 → `source_unreachable`。
- 刷新失败（401）且 `relayed` → 自动用远程服务会话重取断言并 `cloud/login`（core 已有映射凭据 → 直接给会话）→ 写新刷新令牌；远程服务会话也失效 → `source_unauthorized`，页面提示重新登录远程服务。
- `last_ok_at_ms` 在每次成功换票时更新。

### 1.6 测试

`store.test.ts`（CRUD、`local` 不可删、顺序）；`service.test.ts`（用 `identity/oauth/harness.fixture.ts` 风格的假远程服务：`addDirect` 对假 Gateway 配对、指纹不符拒绝、`mount` 全流程、刷新失败回退到断言、凭据不出现在任何响应（扫描响应 JSON 无 `refreshToken` / `password`）、member 403）；`session-broker.test.ts`（选路：直连通 / 直连 hostId 不符 / 直连超时走中继 / 都不通）；迁移 `0039` 的 `fresh.fixture.test.ts` 更新。

## §2 A2-3 云登录与登记（`core/identity/cloud/`，0040，§31）

### 2.1 迁移 `0040_cloud_identity.sql`

```sql
ALTER TABLE identity_invitations ADD COLUMN max_uses INTEGER CHECK(max_uses IS NULL OR max_uses > 0);
ALTER TABLE identity_invitations ADD COLUMN uses INTEGER NOT NULL DEFAULT 0 CHECK(uses >= 0);
CREATE TABLE identity_invitation_uses (
  invitation_id TEXT NOT NULL REFERENCES identity_invitations(invitation_id),
  principal_id  TEXT NOT NULL REFERENCES identity_principals(principal_id),
  used_at_ms    INTEGER NOT NULL CHECK(used_at_ms > 0),
  PRIMARY KEY (invitation_id, principal_id)
) WITHOUT ROWID;

-- 本 core 登记到的远程服务（issuer）；一行 = 信任它签的断言 + 向它开隧道。
CREATE TABLE cloud_registrations (
  issuer               TEXT PRIMARY KEY CHECK(length(issuer) BETWEEN 1 AND 2048),
  source_key_ref       TEXT NOT NULL CHECK(length(source_key_ref) BETWEEN 1 AND 256),  -- SecretStore 名（armadra-cloud-source-key）
  jwks_json            TEXT NOT NULL CHECK(length(jwks_json) <= 65536),
  jwks_url             TEXT NOT NULL CHECK(length(jwks_url) <= 2048),
  jwks_fetched_at_ms   INTEGER NOT NULL CHECK(jwks_fetched_at_ms > 0),
  trusted_origins_json TEXT NOT NULL DEFAULT '[]',
  relay_origins_json   TEXT NOT NULL DEFAULT '[]',
  owner_account_id     TEXT NOT NULL DEFAULT '' CHECK(length(owner_account_id) <= 256),
  mode                 TEXT NOT NULL CHECK(mode IN ('personal', 'saas')),
  registered_by        TEXT NOT NULL REFERENCES identity_principals(principal_id),
  registered_at_ms     INTEGER NOT NULL CHECK(registered_at_ms > 0),
  revoked_at_ms        INTEGER NOT NULL DEFAULT 0 CHECK(revoked_at_ms >= 0)
) WITHOUT ROWID;
```

### 2.2 模块

```text
core/identity/cloud/
├── index.ts         installCloud(context, deps: { identity: IdentityService, relay: RelayService })；契约实现 + 匿名 legacy 路由
├── store.ts         cloud_registrations CRUD；邀请 uses 逻辑放 identity/accounts.ts（A4-1）
├── jwks.ts          JWKS 缓存：读 jwks_json；kid 未知 → 刷新一次（outbound cloudJwks，10 秒超时）；失败仍用缓存
├── assertion.ts     verifyAssertion(token, { hostId, now }) → claims；协议包 check + node:crypto verify + ReplayCache(10 min)
├── login.ts         cloudLogin(assertion, invitationToken?) → 会话（§2.4）
├── register.ts      register / revoke / status；源密钥对；向远程服务 sources.register；起 / 停隧道
├── source-key.ts    Ed25519 密钥对生成（node:crypto generateKeyPairSync("ed25519")），PKCS8 进 SecretStore `armadra-cloud-source-key`；公钥 JWK；signSourceJws()
└── *.test.ts
```

`LoginMethod` 加 `"cloud"`；审计动作 `cloud.login`、`cloud.register`、`cloud.revoke`、`invitation.accept.link`。

### 2.3 契约（`packages/shared/src/contract/cloud.ts`，§31）

| procedure                       | legacy                                             | scope                        | input（协议包 `./core-api`）    | output                                                                                                                                                               | errors                                                                                                                                        |
| ------------------------------- | -------------------------------------------------- | ---------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.cloud.login`          | `POST /api/identity/cloud/login`                   | `null`（匿名，只经 legacy）  | `cloudLoginInputSchema`         | `cloudLoginOutputSchema`（Bearer 模式答 `session.native`；Cookie 模式设 Cookie）                                                                                     | `cloud_not_registered`、`cloud_assertion_invalid`、`cloud_assertion_replayed`、`cloud_account_unlinked`、`invitation_invalid`、`rate_limited` |
| `identity.cloud.register`       | `POST /api/identity/cloud/register`                | `settings:write`（owner）    | `cloudRegisterInputSchema`      | `cloudRegisterOutputSchema`                                                                                                                                          | `cloud_already_registered`、`cloud_issuer_mismatch`、`registration_token_invalid`、`source_unreachable`、`protocol_unsupported`               |
| `identity.cloud.revoke`         | `DELETE /api/identity/cloud/register`              | `settings:write`             | `{ issuer }`                    | `{}`                                                                                                                                                                 | `not_found`                                                                                                                                   |
| `identity.cloud.status`         | `GET /api/identity/cloud`                          | `settings:read`              | `{}`                            | `{ registrations: { issuer, mode, label?, jwksFetchedAtMs, trustedOrigins, relayOrigins, registeredAtMs, tunnel: TunnelStatus }[], sourcePublicKey: Jwk, sourceId }` |                                                                                                                                               |
| `identity.cloud.bind`           | `POST /api/identity/cloud/bind`                    | 本人（任何已登录 principal） | `{ assertion }`                 | `{ bound: true }`（把断言的 `sub` 映射到当前 principal：`oauth/bindings` 同一条路）                                                                                  | 同 login                                                                                                                                      |
| `identity.cloud.trustedOrigins` | `PUT /api/identity/cloud/{issuer}/trusted-origins` | `settings:write`             | `{ issuer, origins: string[] }` | `{ origins }`                                                                                                                                                        |                                                                                                                                               |

`identity.cloud.login` 的限流：按远端地址桶（`identity/throttle.ts` 的 IP 桶）+ 按 `sub` 5 次 / 分钟。

### 2.4 `cloud/login` 算法（`login.ts`）

1. `splitCompactJws`；`header.alg === "EdDSA"`；按 `payload.iss` 查 `cloud_registrations`（未撤销）→ 无 → `cloud_not_registered`。
2. `jwks.key(iss, header.kid)` → 验签 → 失败 `cloud_assertion_invalid`。
3. `checkAudience(aud = hostId)`、`checkTimes(skew 5 min)`、`typ === "armadra-assertion"`；`ReplayCache.seen(jti)` → `cloud_assertion_replayed`。
4. `provider = "cloud:" + sha256(iss).hex.slice(0, 16)`；`identity_credentials(kind='oauth', provider, subject = sub)` 未撤销 → principal；若 principal 已禁用 → `forbidden`。
5. 无映射：`invitationToken` 有 → `accounts.registerWithInvitation({ token, displayName: name ?? sub, createdVia: "cloud" })`（A4-1 的多次消费）→ 写映射凭据 → `created: true`；无 → `cloud_account_unlinked`。
6. `org` 声明且设置 `cloud.orgDefaultRole` 非 `null` 且 principal 是新建的 → 对所有工作空间写该角色的 grants（逐条可撤）。
7. 建设备（`identity_devices_v2`，名字 = `device.name`，平台 = `device.platform`）与会话（`origin` = 请求来源；Bearer / Cookie 按来源）；审计 `cloud.login { iss, sub, principalId, link? }`；答 `cloudLoginOutputSchema`。

### 2.5 登记算法（`register.ts`）

1. 输入 `{ issuer, registrationToken, label? }`；已有同 issuer 未撤销行 → `cloud_already_registered`。
2. `GET <issuer>/.well-known/armadra-platform`（outbound `cloudApi`）→ `protocol.major` 必须等于本地 `PROTOCOL_VERSION.major` → `mode`；issuer 字段必须等于输入（`cloud_issuer_mismatch`）。
3. 源密钥对：`armadra-cloud-source-key` 不存在则生成（所有 issuer 共用同一把源密钥，`sourceId` 就是 `hostId`）。
4. `POST <issuer>/v1/sources/register { registrationToken, sourceId: hostId, publicKey, name: label ?? hostname, kind: shell === "server" ? "server" : "desktop", coreVersion, capabilities: hello.capabilities, protocol }` → 失败透传错误码。
5. `GET <jwksUrl>` → 写 `cloud_registrations`（`trusted_origins_json`、`relay_origins_json`、`owner_account_id`、`mode`）。
6. `relay.start(issuer)`（不 `await`）；审计 `cloud.register`；答 `{ …, tunnel: relay.status(issuer) }`。
7. `revoke`：`relay.stop(issuer)`；行 `revoked_at_ms`；（不删映射凭据——principal 与授予是 owner 的事，可在账号页逐个撤）；审计。

### 2.6 `net/outbound.ts` 新条目

```ts
cloudApi:   { url: "https://<登记的 issuer>", purpose: "远程服务：登记、隧道令牌、断言", cadence: "登记时；隧道令牌每 50 分钟；断言按需", switch: null /* 有 cloud_registrations 行才联网 */, defaultOn: false, documented: true },
cloudJwks:  { url: "https://<issuer>/.well-known/jwks.json", purpose: "验断言的公钥", cadence: "kid 未知时 1 次；最多每 10 分钟 1 次", switch: null, defaultOn: false, documented: true },
relayTunnel:{ url: "wss://<中继节点>/t/v1", purpose: "出站隧道，让客户端经中继访问本 core", cadence: "常连；心跳 20 秒；退避 1–60 秒", switch: "cloud.relay.enabled", defaultOn: true, documented: true },
```

`outbound.test.ts` 的字面量扫描对 `<…>` 占位的条目按前缀放行（现有做法：`url` 是前缀）。

### 2.7 测试

`assertion.test.ts`（fixtures 的 valid / expired / wrong-aud / wrong-alg / replay；离线：JWKS 刷新失败仍用缓存验签通过；`kid` 未知刷新一次）；`login.test.ts`（映射命中 → 会话；未映射无邀请 401；带邀请建号 + 授予 + 映射；重复 login 幂等；org 默认角色开关；Bearer 与 Cookie 两种来源）；`register.test.ts`（假远程服务：protocol major 不符 426；issuer 不符；注册令牌无效透传；成功写行 + 起隧道不阻塞；revoke 停隧道）；`source-key.test.ts`（密钥持久化、JWS 签名可被协议包 fixtures 的公钥流程验证）。

## §3 A3-0 五条流统一发送队列（`core/http/stream-queue.ts`）

### 3.1 目标

把 `events/stream.ts` 的「有界队列 + 一次只飞一帧 + 丢旧」抽成通用 `SendQueue`，终端、实时协同、语言会话、浏览器画面接上；`ws` 设 `maxPayload`；终端在 `bufferedAmount` 超限时暂停读 PTY。隧道里（A3-2）每条流是 `Duplex`，水位有限，没有这一步会把隧道级窗口吃满。

### 3.2 API

```ts
export interface SendQueueOptions {
  maxFrames: number; // 队列上限
  highWaterBytes: number; // socket.bufferedAmount 超过即视为拥塞
  policy: "drop-oldest" | "coalesce" | "pause"; // 事件流 drop-oldest；画面 coalesce（只留最新）；终端 / 实时 / 语言 pause（反压到生产者）
  onDrop?: (dropped: number) => void;
  onPause?: () => void;
  onResume?: () => void;
}
export class SendQueue {
  constructor(
    socket: {
      send(data, cb): void;
      bufferedAmount: number;
      readyState: number;
    },
    options: SendQueueOptions,
  );
  push(frame: string | Uint8Array, key?: string): boolean; // coalesce 用 key 替换同键帧；返回是否接受
  get paused(): boolean;
  close(): void;
}
```

### 3.3 接入

| 流         | policy      | maxFrames | highWaterBytes | 生产者反压                                                              |
| ---------- | ----------- | --------- | -------------- | ----------------------------------------------------------------------- |
| 事件流     | drop-oldest | 256       | 1 MiB          | 无（丢旧，`dropped` 计数照旧）                                          |
| 终端       | pause       | 64        | 4 MiB          | `onPause` → `pty.pause()`，`onResume` → `pty.resume()`（node-pty 支持） |
| 实时协同   | pause       | 256       | 2 MiB          | `onPause` 时停止向该连接广播更新，恢复后发一次完整 sync step 1          |
| 语言会话   | pause       | 256       | 2 MiB          | 上游 LSP 进程 stdout `pause()` / `resume()`                             |
| 浏览器画面 | coalesce    | 4         | 2 MiB          | 只留最新一帧（key = nodeId）                                            |

`ws` 服务器 `maxPayload` = `MAX_FRAME_BYTES`（identity/protocol.ts 的 1 MiB；hello 已报）。

### 3.4 测试

`stream-queue.test.ts`（三种策略、`bufferedAmount` 假值驱动 pause / resume、`close` 清空）；各流的现有测试全过；新增 `terminal/backpressure.test.ts`（假 socket `bufferedAmount` 卡在 5 MiB 时 `pty.pause` 被调、降下后 `resume`）；`events/stream.test.ts` 改为对 `SendQueue` 的委托断言。服务端性能基线（`tools/probes/server-perf.mjs`）不退化（30 终端 + 6 事件流的 p95 不升 10% 以上）。

## §4 A3-2 隧道客户端（`core/relay/`，§32）

### 4.1 模块

```text
core/relay/
├── index.ts        install(context): RelayService { start(issuer), stop(issuer), status(issuer), statusAll() }
├── client.ts       一条隧道：连接、握手、帧循环、心跳、GOAWAY、退避重连、节点轮换
├── streams.ts      OPEN → TunnelDuplex（stream.Duplex，highWaterMark = streamWindow）；窗口记账；emit("connection") 给 admittedServer
├── admission.ts    对隧道来的请求做准入：Origin ∈ trusted_origins ∪ 内置；Bearer → identity.authenticate → runAs；升级要 armadra-ticket；loopbackOnlyPath 拒绝 403
├── nodes.ts        节点列表（GET /v1/sources/me/relay，源 JWS）、延迟探测、轮换
├── settings.ts     cloud.relay.enabled（默认 true）、cloud.relay.preferredNode、cloud.orgDefaultRole（null）
└── *.test.ts
```

`RelayService` 由 `core/main.ts` 在 `listen` **之后**调用 `relay.startAll()`（不 `await`；没有登记行时它什么都不做）。

### 4.2 连接与握手（`client.ts`）

```text
disabled ─start()─▶ connecting ─ws open─▶ authenticating ─ready─▶ ready ─GOAWAY─▶ draining ─关闭─▶ backoff ─定时─▶ connecting
                         │ 失败 / 关闭 ──────────────────────────────────────────────────────────────▶ backoff
```

1. `nodes.pick(issuer)`：有缓存的隧道令牌且未到 50 分钟 → 直接用；否则 `GET /v1/sources/me/relay`（源 JWS）→ `{ tunnelToken, nodes }`；按 `preferredNode` → 延迟 → 权重排序；失败一次换下一个节点。
2. `new WebSocket(node.url + TUNNEL_PATH)`（`ws`，`maxPayload = LIMITS.maxFrameBytes + 16`，`perMessageDeflate: false`，`handshakeTimeout: 10 s`）；`wss://` 必须，`ws://` 只在 `ARMADRA_RELAY_ALLOW_INSECURE=1`（探针）。
3. `hello` → `challenge` → `auth`（源私钥签 `sourceId\nnonce\nnonce2\nrelayNode`）→ `ready`：记 `limits`、`heartbeatMs`；状态 `ready`；`reject` → 按 code：`protocol_unsupported` 停且记错误（不重连直到 core 重启或登记更新）；`source_revoked` → 自动 `revoke` 登记并通知；其它 → backoff。
4. 心跳：收 `PING` 答 `PONG`；自己每 `heartbeatMs` 发 `PING`，两次无 `PONG` → 关闭重连。
5. 退避：`backoff(attempt) = min(60 s, 1 s × 2^attempt) × (0.5 + random)`；`ready` 过则 `attempt = 0`；`GOAWAY` → 不退避，立即换节点重连，旧隧道等流自然结束或 `graceMs`。
6. 隧道断开不影响本地：所有 `TunnelDuplex.destroy(RST sourceGone)`，Node 的 `http.Server` 自己结束这些连接；终端 / Agent / 画布不受影响（它们不依赖连接存活）。

### 4.3 流（`streams.ts`）

- `OPEN` → `new TunnelDuplex(streamId, open)`：`_write` 扣信用并发 `DATA`（切块 64 KiB）；收 `DATA` → `push`；`_read` 消费后补 `WINDOW`；`END` / `RST` 对应 `push(null)` / `destroy`。
- `admittedServer = CoreServer.createListener({ admitted: true })`；`admittedServer.emit("connection", duplex)` —— Node 用 `duplex` 解析 HTTP / 升级；`duplex.remoteAddress` 伪装成 `open.remoteIp`，`duplex.encrypted = true`，并把 `open.clientOrigin` 放在 `duplex.armadraOrigin` 供 `admission.ts` 读（不信任头里的 Origin，以 `OPEN` 元数据为准；两者不一致 → 403）。
- 流数超过 `limits.maxStreams` → `RST refused`。

### 4.4 准入（`admission.ts`）

与 Gateway Bearer 模式等价，在 `admittedServer` 的 `request` / `upgrade` 之前（`createListener({ admitted: true, gate })` 加一个可选 `gate` 参数，隧道传入本模块）：

1. 路径在 `loopbackOnlyPath` 表（`/hook/`、`/control/`、`/context-link/`、`/browser/`、`/verify`）→ 403 `forbidden`。
2. `Origin`（来自 `OPEN.clientOrigin`）∈ `trusted_origins_json ∪ { "capacitor://localhost", "https://localhost" }`；`null` 只允许 `/api/identity/*` 匿名路径与 `/health`。
3. 匿名路径（`transport.ts::anonymousPath`）放行；其它：`Authorization: Bearer` → `identity.authenticate` → `runAs`；升级：`Sec-WebSocket-Protocol: armadra-ticket.<t>` 兑换（票由同一隧道上的 `POST /api/identity/ws-ticket` 签——该路由在 Bearer 模式可用，无循环依赖：票签发是普通 HTTP 请求）。
4. 拒绝一律 `401 unauthenticated`（JSON 形状同 §3）；长连接的 4401 / 4403 复核与 Gateway 同一条路。

### 4.5 契约 §32 与状态

`identity.cloud.status` 的 `tunnel: TunnelStatus`（协议包 `tunnelStatusSchema`）；事件流事件 `cloud.tunnel`（`{ issuer, state }`，`events:read`）给设置页实时显示；设置键 `cloud.relay.enabled`（关 → 全部 `stop`）、`cloud.relay.preferredNode`。§32 散文记：握手、帧表引用协议包、限制、准入规则、关闭码 4404、`net/outbound.ts` 三条目、`ARMADRA_RELAY_ALLOW_INSECURE`。

### 4.6 测试

- `client.test.ts`：假中继（`test/fake-relay.ts`：`ws` 服务器实现握手与帧，协议包 fixtures 的密钥）——握手成功；`reject protocol_unsupported` 停；`source_revoked` 触发撤销；心跳超时重连；`GOAWAY` 换节点不退避；退避序列（假时钟）；**中继不可达时 `install` 与 `start` 立即返回、core 的回环 API 在隧道失败期间全部正常（集成：起真 core，`start` 指向关闭的端口，`GET /health` 与 `GET /api/workspaces` 200，`main.ts` 启动耗时不含对中继的等待）**。
- `streams.test.ts`：经假中继发真 HTTP 请求到 `admittedServer`（`GET /health`、`POST` 带体、chunked 响应、WS 升级回显）；窗口耗尽停发、`WINDOW` 后续发；fixtures `sequence-http-roundtrip.bin` 逐帧比对。
- `admission.test.ts`：Origin 不在表 403；`loopbackOnlyPath` 403；无 Bearer 401；票兑换成功 / 来源不符拒绝；`OPEN.clientOrigin` 与头不一致 403。
- `frames.test.ts`：协议包黄金字节（core 侧也跑一遍，守钉住的版本）。
- 集成 `relay.integration.test.ts`（需 dev-stack `personal` 或 `platform` profile，否则 skip）：core 经真中继开终端、实时板、事件流；4401 换票；撤销登记即断。

## §5 A4-1 邀请多次使用（`identity/accounts.ts`、`accounts-http.ts`，§10 追加）

- `POST /api/identity/invitations` 加 `maxUses?: number`（1–1000；省略 = 一次性，沿用 `consumed_by`）。
- 消费：`max_uses IS NULL` → 现有条件 UPDATE；否则 `UPDATE identity_invitations SET uses = uses + 1 WHERE invitation_id = ? AND expires_at_ms > ? AND consumed_by = '' AND uses < max_uses` + `INSERT OR IGNORE identity_invitation_uses`；同一 principal 重复接受（`identity_invitation_uses` 已有）→ 幂等成功、不加计数；`BEGIN IMMEDIATE`。
- 列表响应加 `maxUses`、`uses`；契约 §10 追加一段「多次使用」。
- 测试：并发 20 次对 `maxUses = 5` 恰好 5 个成功；同人幂等；过期；撤销后 401；旧一次性路径不变。

## §6 A4-4 服务器壳 CLI（`apps/server/src/cli.ts`、`serve.ts`）

| 命令                                                                                       | 做什么                                                                                                                      |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `armadra-server cloud register --issuer URL --token T [--label L]`                         | 对本机 core（经回环 + owner 会话，与 `invite` 同一取票方式）调 `identity.cloud.register`；打印隧道状态                      |
| `armadra-server cloud revoke --issuer URL`                                                 | `identity.cloud.revoke`                                                                                                     |
| `armadra-server cloud status [--json]`                                                     | `identity.cloud.status`                                                                                                     |
| `armadra-server cloud login --issuer URL --account A`（personal）                          | 交互读口令 → `sources.remoteAdd` → 再 `cloud register`（一步到位：中继自己签注册令牌）                                      |
| `armadra-server invite --cloud-link --issuer URL [--max-uses N] [--role R] [--expires 7d]` | 建邀请（`maxUses`）→ 用 `sources.remoteSession` 的远程会话 `links.create` → 打印 `https://<issuer>/j/<id>#<secret>.<token>` |

容器入口：`ARMADRA_CLOUD_ISSUER` + `ARMADRA_CLOUD_REGISTRATION_TOKEN` 两个环境变量都给时，`entrypoint.sh` 在 `serve` 就绪后（健康检查通过）跑一次 `cloud register`（幂等：已登记则跳过）；用于托管源与 e2e。`cli.test.ts` 覆盖每条命令的参数解析与对假 core 的调用。

## §7 A5-1 桌面包内服务器壳（`apps/desktop/scripts/after-pack.mjs`、`main/index.ts`、`electron-builder.yml`）

- `after-pack.mjs`：把 `apps/server/out/main.js`、`apps/web/dist/` → `resources/server/{main.js,web/}`；`migrations/` 已在包内（core 自带），服务器壳用 `ARMADRA_CORE_MIGRATIONS_DIR` 指过去。
- `main/index.ts` 最前：`if (process.argv[1] === "serve" || process.argv.includes("--serve"))` → `spawn(process.execPath, [resources/server/main.js, "serve", ...rest], { env: { ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" })` 并以其退出码退出；不 `app.whenReady()`。
- `electron-builder.yml`：`extraResources` 加 `server/`；`tools/release/` 的发布物清单与校验加 `resources/server/main.js` 的存在与 `/health.version` 一致。
- 测试：`scripts/after-pack.test.mjs`；`release:test` 的打包清单；B 档 `packaged-smoke` 加一步 `Armadra serve --listen 127.0.0.1:0 --public-origin https://localhost` 起得来且 `/health.version` = 壳版本。

## §8 A6-2 配额（`core/settings` + 各域）

`limits.terminalsPerPrincipal`（16）、`limits.agentsPerWorkspace`（8）：创建终端 / Agent 时计数超限答 `429 limit_reached { details: { limit, current } }`；托管源由编排器上报 `usage_counters`。测试各一条。

## §9 架构文档同步

`docs/guides/architecture.md` 新增 `core/sources/`、`core/identity/cloud/`、`core/relay/`、`http/stream-queue.ts` 的段落与 `armadra-cloud` 仓引用；删除无代码对应的 `ARMADRA_DATABASE_URL`。
