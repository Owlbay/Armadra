# 协议包 `@armadra/platform-protocol`：详细设计

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)工作包 **C0-2** 的实现规格；真相源在 `AMA-Link/armadra-cloud` 仓 `packages/platform-protocol/`，Armadra 钉精确版本。上位设计：[平台设计](../platform-saas-architecture.md) §8.2、§16.2、§16.3、§17。
> 规则：包只含 zod schema、类型、纯编解码与常量；不 import `node:*`（`fixtures` 子路径除外，它只在测试里用）；页面、手机、core、cloud、relay 都能直接用。

## §1 目录与入口

```text
packages/platform-protocol/
├── package.json            name @armadra/platform-protocol, type module, exports 见下表, files: dist/, fixtures/
├── tsconfig.json           extends ../../tsconfig.base.json; outDir dist; declaration
├── src/
│   ├── index.ts            只 re-export 子路径的公共类型；不要让使用方从根 import 实现
│   ├── version.ts          PROTOCOL_VERSION、TUNNEL_PATH、子协议名
│   ├── tunnel/             frames.ts（编解码）、handshake.ts（zod）、limits.ts、codes.ts
│   ├── assertion/          claims.ts（zod）、jws.ts（compact JWS 拆装、不含签名）、check.ts
│   ├── cloud-api/          contract/*.ts（oRPC 契约）、events.ts、index.ts
│   ├── core-api/           cloud-login.ts、cloud-register.ts（§31 里 cloud 侧要知道的两条）
│   ├── errors/             registry.ts、index.ts
│   ├── identity-vectors/   constants.ts、vectors.json（生成）、index.ts
│   └── fixtures/           index.ts：按名字读 ../../fixtures/*.bin|*.json（Node 专用）
├── fixtures/               黄金字节（随包发布，§8）
│   ├── tunnel/*.bin        每种帧一份 + 组合序列
│   ├── assertion/*.json    正常 / 过期 / 错 aud / 重放 / 错 alg
│   └── cloud-api/*.json    各响应样例
└── test/                   vitest：往返、黄金字节、schema 快照
```

`package.json` 关键字段：

```json
{
  "name": "@armadra/platform-protocol",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "sideEffects": false,
  "exports": {
    ".": "./dist/index.js",
    "./tunnel": "./dist/tunnel/index.js",
    "./assertion": "./dist/assertion/index.js",
    "./cloud-api": "./dist/cloud-api/index.js",
    "./core-api": "./dist/core-api/index.js",
    "./errors": "./dist/errors/index.js",
    "./identity-vectors": "./dist/identity-vectors/index.js",
    "./fixtures": "./dist/fixtures/index.js"
  },
  "files": ["dist", "fixtures"],
  "peerDependencies": { "zod": ">=4.0.0 <5" },
  "dependencies": { "@orpc/contract": "1.15.4" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

`@orpc/contract` 是运行时依赖（`cloud-api` 契约用 `oc`）；zod 由使用方提供（Armadra 4.4.3）。

## §2 `./version`

```ts
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;
export const TUNNEL_PATH = "/t/v1"; // major 变化时 /t/v2
export const INTERNODE_PATH = "/x/v1";
export const RELAY_SUBPROTOCOL_PREFIX = "armadra-relay."; // 客户端 WS：armadra-relay.<jwt>
export const TICKET_SUBPROTOCOL_PREFIX = "armadra-ticket."; // 与 core 现有常量相同
export const RELAY_TOKEN_HEADER = "armadra-relay-token";
export const PROTOCOL_HEADER = "armadra-protocol"; // 响应头 Armadra-Protocol: 1.0
export const PLATFORM_WELL_KNOWN = "/.well-known/armadra-platform";
export const JWKS_WELL_KNOWN = "/.well-known/jwks.json";
```

## §3 `./tunnel`

### 3.1 握手（文本帧，JSON；`handshake.ts`）

| 顺序 | 方向         | 形状（zod）                                                                                                                                                                                                                 | 说明                                                            |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1    | core → relay | `hello { type:"hello", protocol:{major,minor}, sourceId: hex32, coreVersion: string, capabilities: string[], tunnelToken: string, nonce: base64url(16B) }`                                                                  | `tunnelToken` 由控制面签（§4.4）                                |
| 2    | relay → core | `challenge { type:"challenge", nonce2: base64url(16B), relayNode: string }`                                                                                                                                                 | relay 已验 `tunnelToken` 并取出 `cnf.jwk`                       |
| 3    | core → relay | `auth { type:"auth", sig: base64url(Ed25519(sourceKey, utf8(sourceId + "\n" + nonce + "\n" + nonce2 + "\n" + relayNode))) }`                                                                                                | relay 用 `cnf.jwk` 验                                           |
| 4    | relay → core | `ready { type:"ready", tunnelId: hex32, limits:{ maxStreams, streamWindow, tunnelWindow, maxFrameBytes }, heartbeatMs, protocol:{major,minor} }` 或 `reject { type:"reject", code: TunnelRejectCode, message }` 后关闭 4490 | `ready` 之后只允许二进制帧；任何文本帧 → `RST`-less 直接关 4400 |

`TunnelRejectCode`：`protocol_unsupported`、`tunnel_token_invalid`、`tunnel_token_expired`、`signature_invalid`、`source_revoked`、`rate_limited`、`replaced`（同源新隧道替换旧隧道时发给旧的，关闭码 4491）。

### 3.2 帧布局（二进制；`frames.ts`）

```text
offset  size  字段
0       1     type (u8)：1 OPEN, 2 DATA, 3 END, 4 RST, 5 WINDOW, 6 PING, 7 PONG, 8 GOAWAY
1       4     streamId (u32 BE)；0 = 隧道级（只允许 WINDOW / PING / PONG / GOAWAY）
5       n     payload
```

| 类型     | payload                                                                                                                                     | 约束                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `OPEN`   | UTF-8 JSON `{ kind:"http"\|"ws", method, path, headers: [name, value][], clientOrigin: string\|null, remoteIp: string, relayNode: string }` | `path` 含 query；`headers` 已剥掉中继令牌与 `armadra-relay.*` 子协议 |
| `DATA`   | 原始字节                                                                                                                                    | `≤ MAX_DATA_CHUNK`                                                   |
| `END`    | 空                                                                                                                                          | 半关（发送方不再发 DATA）                                            |
| `RST`    | `code` u16 BE                                                                                                                               | 见 3.4                                                               |
| `WINDOW` | `credit` u32 BE                                                                                                                             | streamId 0 = 隧道级窗口                                              |
| `PING`   | `ts` f64 BE（ms）                                                                                                                           | 任一侧可发                                                           |
| `PONG`   | 原样回 `ts`                                                                                                                                 |                                                                      |
| `GOAWAY` | UTF-8 JSON `{ reason: "shutdown"\|"rebalance"\|"replaced", graceMs }`                                                                       | 之后不再接受新 `OPEN`                                                |

API：

```ts
export type Frame =
  | { type: "open"; streamId: number; open: OpenPayload }
  | { type: "data"; streamId: number; bytes: Uint8Array }
  | { type: "end"; streamId: number }
  | { type: "rst"; streamId: number; code: number }
  | { type: "window"; streamId: number; credit: number }
  | { type: "ping"; ts: number }
  | { type: "pong"; ts: number }
  | { type: "goaway"; reason: GoawayReason; graceMs: number };
export function encodeFrame(frame: Frame): Uint8Array;
export function decodeFrame(bytes: Uint8Array): Frame; // 抛 FrameError { code: "bad_frame" | "frame_too_large" | "bad_open" }
export const openPayloadSchema: z.ZodType<OpenPayload>;
```

### 3.3 限制（`limits.ts`）

```ts
export const LIMITS = {
  maxFrameBytes: 1_048_576, // 整帧上限；ws maxPayload = maxFrameBytes + 16
  maxDataChunk: 65_536,
  streamWindow: 262_144, // 256 KiB，初始每流信用
  tunnelWindow: 8_388_608, // 8 MiB
  maxStreams: 256,
  heartbeatMs: 20_000,
  heartbeatMisses: 2,
  openHeadersMaxBytes: 32_768,
  handshakeTimeoutMs: 10_000,
  goawayGraceMs: 30_000,
} as const;
```

窗口规则：发送方对每流与隧道各维护一个信用计数，发 `DATA` 时同时扣两个，不足时不发（排队）；接收方消费（交给上层）到累计 ≥ 窗口的一半时发 `WINDOW` 补回消费量。流开启时隐含初始 `streamWindow`；隧道级初始 `tunnelWindow`。违反（信用为负）→ `RST 5` 并关隧道 4400。

### 3.4 RST 码与关闭码（`codes.ts`）

```ts
export const RST = {
  ok: 0,
  protocol: 1,
  refused: 2,
  sourceGone: 3,
  internal: 4,
  flowControl: 5,
  clientGone: 6,
  timeout: 7,
} as const;
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  badFrame: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  sourceOffline: 4404,
  protocolUnsupported: 4409,
  frameTooLarge: 4413,
  limitReached: 4429,
  tunnelAuthFailed: 4490,
  tunnelReplaced: 4491,
  tunnelGoaway: 4492,
} as const;
```

客户端侧（浏览器 / 手机）只会看到 `CLOSE` 里 4xxx 的前七个；449x 只在隧道上。

## §4 `./assertion`

### 4.1 共同头与编码（`jws.ts`）

```ts
export interface CompactJws {
  header: { alg: "EdDSA"; kid: string; typ?: string };
  payload: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}
export function splitCompactJws(token: string): CompactJws; // 不验签；格式错抛 { code: "jws_malformed" }
export function buildSigningInput(
  header: object,
  payload: object,
): { signingInput: Uint8Array; encodedHeader: string; encodedPayload: string };
export function joinCompactJws(
  encodedHeader: string,
  encodedPayload: string,
  signature: Uint8Array,
): string;
```

签名与验签在各仓用 `node:crypto`（`sign(null, data, privateKey)` / `verify(null, data, publicKey, sig)`，Ed25519，JWK 经 `createPublicKey({ key: jwk, format: "jwk" })`）；浏览器侧永远不验签（只拿着用）。

### 4.2 四种令牌的声明（`claims.ts`）

| 令牌                    | `typ`               | 签发者                  | 声明                                                                                                                                                                                                                        | 寿命    |
| ----------------------- | ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 云访问令牌              | `armadra-access`    | cloud / relay(personal) | `iss, sub: accountId, aud: "cloud", sid: sessionId, exp, iat, jti, ver: 1`                                                                                                                                                  | 15 分钟 |
| 源访问断言              | `armadra-assertion` | 同上                    | `iss, sub: accountId \| "guest:<linkId>:<rnd>", aud: sourceId, exp, iat, jti, ver: 1, name?, email?, emailVerified?: boolean, org?: { orgId, role }, link?: { linkId, invitationId }, device: { deviceId, platform, name }` | 5 分钟  |
| 中继令牌                | `armadra-relay`     | 同上                    | `iss, sub: accountId \| guest, aud: "relay", src: sourceId, exp, iat, jti, ver: 1`                                                                                                                                          | 1 小时  |
| 隧道令牌                | `armadra-tunnel`    | 同上                    | `iss, sub: sourceId, aud: "relay-tunnel", cnf: { jwk: Ed25519 公钥 JWK }, exp, iat, jti, ver: 1`                                                                                                                            | 1 小时  |
| 源 JWS（core → 控制面） | `armadra-source`    | core                    | `iss: sourceId, aud: issuer, iat, exp (+60 s), jti`；头 `kid = sourceId`                                                                                                                                                    | 60 秒   |

每种各导出 `xxxClaimsSchema`（zod，非 strict）与类型。`platform` 枚举：`ios / android / desktop / browser / server`。

### 4.3 校验辅助（`check.ts`）

```ts
export interface CheckOptions {
  nowMs: number;
  skewMs?: number /* 默认 300_000 */;
  expectedAud: string;
  expectedIss?: string;
}
export function checkTimes(
  claims: { exp: number; iat: number; nbf?: number },
  o: CheckOptions,
): CheckFailure | null;
export function checkAudience(
  claims: { aud: string },
  o: CheckOptions,
): CheckFailure | null;
export type CheckFailure = {
  code: "expired" | "not_yet_valid" | "audience_mismatch" | "issuer_mismatch";
};
export class ReplayCache {
  constructor(ttlMs: number, max?: number);
  seen(jti: string, expMs: number, nowMs: number): boolean;
}
```

`ReplayCache` 是纯内存结构（core 与 personal relay 用）；cloud / saas relay 用 Redis `revoked:jti` + 同一接口的适配。

### 4.4 隧道令牌为什么带 `cnf`

relay 节点不查库：验隧道令牌只需要控制面 JWKS；核对 core 真的持有源私钥靠握手里对 `nonce|nonce2|relayNode` 的签名与 `cnf.jwk` 比对。SaaS 与 personal 完全相同。

## §5 `./cloud-api`：`/v1/*` 契约

用 `@orpc/contract` 的 `oc` 定义，一个域一个文件，`index.ts` 合成 `cloudContract`。每条 `.meta({ path, method, scope, since })`；`scope`：`anonymous`、`session`（云会话）、`owner`（账号本人）、`source`（源 JWS）、`org:admin`、`org:owner`。cloud 用 `implement(cloudContract)`；页面 / 手机 / core 用 `createORPCClient(new OpenAPILink(cloudContract, { url }))`。路径与形状：

### 5.1 `platform`

| procedure         | 方法 / 路径                         | scope     | input | output                                                                                                                                                      |
| ----------------- | ----------------------------------- | --------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform.info`   | `GET /.well-known/armadra-platform` | anonymous | `{}`  | `{ mode: "saas"\|"personal", issuer: url, protocol: {major,minor}, capabilities: string[], relay: { addressing: "subdomain"\|"path" }, webApp: url\|null }` |
| `platform.jwks`   | `GET /.well-known/jwks.json`        | anonymous | `{}`  | `{ keys: Jwk[] }`                                                                                                                                           |
| `platform.health` | `GET /health`                       | anonymous | `{}`  | `{ ok: true, version, mode }`                                                                                                                               |

capabilities（字符串，只增）：`auth.password`、`auth.passkey`、`auth.totp`、`auth.oauth`、`auth.device-code`、`orgs`、`links.source-invite`、`links.org-join`、`sources.hosted`、`billing`、`me.stream`。personal 报 `auth.password`、`auth.device-code`、`links.source-invite`、`me.stream`。

### 5.2 `auth`

| procedure                                                                                  | 方法 / 路径                                              | scope     | input                                                                    | output                                                                                                               | errors                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `auth.register`                                                                            | `POST /v1/auth/register`                                 | anonymous | `{ email, password, displayName, device: DeviceInput }`                  | `SessionResult`                                                                                                      | `email_taken`、`password_too_short`…（identity-vectors 的策略码）、`rate_limited`            |
| `auth.login`                                                                               | `POST /v1/auth/login`                                    | anonymous | `{ account: string /* email 或 personal 的账号名 */, password, device }` | `SessionResult \| { mfa: { challengeId, methods: ("totp"\|"recovery")[] } }`                                         | `credentials_invalid`、`account_locked { retryAfterMs }`、`account_disabled`、`rate_limited` |
| `auth.mfaVerify`                                                                           | `POST /v1/auth/mfa/verify`                               | anonymous | `{ challengeId, code }`                                                  | `SessionResult`                                                                                                      | `mfa_invalid`、`mfa_expired`                                                                 |
| `auth.refresh`                                                                             | `POST /v1/auth/refresh`                                  | anonymous | `{ refreshToken }`                                                       | `SessionResult`                                                                                                      | `session_expired`、`session_revoked`                                                         |
| `auth.logout`                                                                              | `POST /v1/auth/logout`                                   | session   | `{}`                                                                     | `{}`                                                                                                                 |                                                                                              |
| `auth.deviceStart`                                                                         | `POST /v1/auth/device/start`                             | anonymous | `{ device }`                                                             | `{ deviceCode, userCode: "XXXX-XXXX", verificationUrl, expiresAtMs, intervalMs }`                                    | `rate_limited`                                                                               |
| `auth.devicePoll`                                                                          | `POST /v1/auth/device/poll`                              | anonymous | `{ deviceCode }`                                                         | `{ status: "pending" } \| { status: "approved", session: Session } \| { status: "denied" } \| { status: "expired" }` | `rate_limited`（慢于 `intervalMs`）                                                          |
| `auth.deviceApprove`                                                                       | `POST /v1/auth/device/approve`                           | session   | `{ userCode, approve: boolean }`                                         | `{}`                                                                                                                 | `device_code_expired`、`not_found`                                                           |
| `auth.passkeyRegisterOptions` / `passkeyRegister` / `passkeyLoginOptions` / `passkeyLogin` | `POST /v1/auth/passkey/*`                                | 视情况    | 与 core §18.2 同形                                                       | 同                                                                                                                   |                                                                                              |
| `auth.totpEnroll` / `totpConfirm` / `totpDisable` / `recoveryCodesRotate`                  | `POST /v1/auth/totp/*`、`/v1/auth/recovery-codes/rotate` | session   | 与 core §18.3 同形                                                       | 同                                                                                                                   |                                                                                              |
| `auth.oauthStart` / `oauthCallback`（REST，302）                                           | `GET /v1/auth/oauth/{provider}/start`、`/callback`       | anonymous | —                                                                        | 302                                                                                                                  | 不进契约，只在 `cloud-api.md` §2.6 描述                                                      |

```ts
const deviceInputSchema = z.object({
  platform: z.enum(["ios", "android", "desktop", "browser", "server"]),
  name: z.string().min(1).max(128),
  pushPublicKey: z.string().optional(),
});
const sessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
  account: z.object({
    accountId: z.string(),
    email: z.string().nullable(),
    displayName: z.string(),
    emailVerified: z.boolean(),
  }),
  device: z.object({ deviceId: z.string() }),
});
type SessionResult = { session: Session };
```

浏览器来源（`app.<cloud>` 自己的页面）上登录类答案不带 `refreshToken`，改设 `__Host-armadra-cloud` Cookie（30 天）+ `X-Armadra-CSRF`；规则与 core §17.4 相同，判定按 `Origin`。

### 5.3 `me`

| procedure         | 方法 / 路径                  | scope   | input              | output                                                                                                                |
| ----------------- | ---------------------------- | ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `me.get`          | `GET /v1/me`                 | session | `{}`               | `{ accountId, email, displayName, emailVerified, orgs: { orgId, slug, name, role }[], mfaEnabled }`                   |
| `me.update`       | `PATCH /v1/me`               | session | `{ displayName? }` | 同上                                                                                                                  |
| `me.sources`      | `GET /v1/me/sources`         | session | `{}`               | `{ sources: SourceSummary[] }`                                                                                        |
| `me.devices`      | `GET /v1/me/devices`         | session | `{}`               | `{ devices: { deviceId, platform, name, lastSeenAtMs, current }[] }`                                                  |
| `me.deviceRevoke` | `DELETE /v1/me/devices/{id}` | session | `{ deviceId }`     | `{}`                                                                                                                  |
| `me.streamTicket` | `POST /v1/me/stream/ticket`  | session | `{}`               | `{ ticket, expiresAtMs }`（30 秒一次性；WS 升级 `GET /v1/me/stream` 用 `Sec-WebSocket-Protocol: armadra-ticket.<t>`） |

`SourceSummary = { sourceId, name, kind: "desktop"\|"server"\|"hosted", online: boolean, lastSeenAtMs, owner: boolean, via: "owner"\|"link"\|"org", relayOrigin, coreVersion }`。

### 5.4 `sources`

| procedure                   | 方法 / 路径                                        | scope                | input                                                                                                        | output                                                                                                               | errors                                                                                                 |
| --------------------------- | -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `sources.registrationToken` | `POST /v1/sources/registration-tokens`             | session              | `{ orgId? }`                                                                                                 | `{ registrationToken, expiresAtMs, issuer }`（一次性，10 分钟）                                                      | `email_unverified`（按配置）、`limit_reached`                                                          |
| `sources.register`          | `POST /v1/sources/register`                        | anonymous + 注册令牌 | `{ registrationToken, sourceId, publicKey: Jwk, name, kind, coreVersion, capabilities: string[], protocol }` | `{ issuer, jwksUrl, relayOrigins: string[], trustedOrigins: string[], sourceId, ownerAccountId }`                    | `registration_token_invalid`、`source_taken`（同 id 已被别的账号登记且未撤销）、`protocol_unsupported` |
| `sources.heartbeatHint`     | `GET /v1/sources/me/relay`                         | source               | `{}`                                                                                                         | `{ tunnelToken, expiresAtMs, nodes: { url: wss, region?, weight }[] , limits }`                                      | `source_revoked`                                                                                       |
| `sources.list`              | `GET /v1/sources`                                  | session              | `{ orgId? }`                                                                                                 | `{ sources: SourceSummary[] }`（我拥有或可达的）                                                                     |                                                                                                        |
| `sources.get`               | `GET /v1/sources/{sourceId}`                       | session              | `{ sourceId }`                                                                                               | `SourceSummary & { trustedOrigins, capabilities, registeredAtMs }`                                                   | `not_found`                                                                                            |
| `sources.update`            | `PATCH /v1/sources/{sourceId}`                     | owner                | `{ sourceId, name?, trustedOrigins? }`                                                                       | 同上                                                                                                                 |                                                                                                        |
| `sources.revoke`            | `DELETE /v1/sources/{sourceId}`                    | owner                | `{ sourceId }`                                                                                               | `{}`（踢隧道、撤令牌）                                                                                               |                                                                                                        |
| `sources.assertion`         | `POST /v1/sources/{sourceId}/assertion`            | session              | `{ sourceId, device? }`                                                                                      | `{ assertion, assertionExpiresAtMs, relayToken, relayTokenExpiresAtMs, relayOrigin, relayBaseUrl, online: boolean }` | `source_access_denied`、`source_revoked`、`rate_limited`                                               |
| `sources.accessList`        | `GET /v1/sources/{sourceId}/access`                | owner                | `{ sourceId }`                                                                                               | `{ access: { accountId, email, via, linkId, grantedAtMs }[] }`                                                       |                                                                                                        |
| `sources.accessRevoke`      | `DELETE /v1/sources/{sourceId}/access/{accountId}` | owner                | `{ sourceId, accountId }`                                                                                    | `{}`                                                                                                                 |                                                                                                        |

`relayBaseUrl`：saas = `https://<sourceId>.src.<relay 域>`；personal = `https://<relay>/s/<sourceId>`。客户端只用它，不自己拼。

### 5.5 `links`

| procedure      | 方法 / 路径                       | scope                                         | input                                                                                                                                                                      | output                                                                                                                               | errors                                                                                  |
| -------------- | --------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `links.create` | `POST /v1/links`                  | owner（source_invite）/ org:admin（org_join） | `{ kind: "source_invite", sourceId, invitationId, label, role, expiresAtMs, maxUses? } \| { kind: "org_join", orgId, label, expiresAtMs, maxUses?, sources?: sourceId[] }` | `{ linkId, url: "https://<issuer>/j/<linkId>", secret?: string /* 只有 org_join 与 personal 的 source_invite 返回 */, expiresAtMs }` | `source_access_denied`、`org_role_insufficient`                                         |
| `links.get`    | `GET /v1/links/{linkId}`          | anonymous                                     | `{ linkId }`                                                                                                                                                               | `{ kind, label, role?, sourceName?, orgName?, expiresAtMs, exhausted: boolean, requiresAccount: boolean }`                           | `link_invalid`                                                                          |
| `links.accept` | `POST /v1/links/{linkId}/accept`  | session（saas）/ anonymous（personal 访客）   | `{ linkId, secret?, device? }`                                                                                                                                             | `{ sourceId?, relayOrigin?, relayBaseUrl?, assertion?, relayToken?, orgId?, guestSession?: Session }`                                | `link_invalid`、`link_expired`、`link_exhausted`、`link_secret_invalid`、`rate_limited` |
| `links.list`   | `GET /v1/links?sourceId=\|orgId=` | owner / org:admin                             | `{ sourceId?, orgId? }`                                                                                                                                                    | `{ links: LinkSummary[] }`                                                                                                           |                                                                                         |
| `links.revoke` | `DELETE /v1/links/{linkId}`       | owner / org:admin                             | `{ linkId }`                                                                                                                                                               | `{}`                                                                                                                                 |                                                                                         |

### 5.6 `orgs`（仅 saas）

`orgs.create`（`POST /v1/orgs { slug, name }`）、`orgs.get`、`orgs.update`、`orgs.delete`（org:owner）、`orgs.members`（`GET /v1/orgs/{id}/members`）、`orgs.memberRole`（`PATCH …/members/{accountId} { role }`）、`orgs.memberRemove`、`orgs.sources`（`GET /v1/orgs/{id}/sources`）、`orgs.sourceAttach`（`POST …/sources { sourceId }`，源 owner 且组织成员）、`orgs.sourceDetach`。角色 `owner / admin / member`。

### 5.7 `me.stream` 事件（`events.ts`）

WS 文本帧 JSON，`discriminatedUnion("type")`：`sourceOnline { sourceId, sinceMs, relayOrigin }`、`sourceOffline { sourceId, atMs }`、`sourceRevoked { sourceId }`、`accessRevoked { sourceId }`、`linkUsed { linkId, sourceId?, orgId?, by: { accountId?, guest?: boolean }, atMs }`、`ping { ts }`。客户端每 30 秒发 `{ type: "ping" }`，服务端回 `pong`。

### 5.8 `billing`（仅 saas，阶段 6）

`billing.plan`（`GET /v1/orgs/{id}/billing`）、`billing.usage`（`GET /v1/orgs/{id}/usage?period=`）。只读。

## §6 `./core-api`

cloud / relay 侧唯一要知道的 core 形状（给 e2e、落地页与 CLI 用）；Armadra 的 `packages/shared/src/contract/cloud.ts` 从这里 import 同一份 schema，保证不漂移：

```ts
export const cloudLoginInputSchema = z.object({
  assertion: z.string(),
  invitationToken: z.string().optional(),
});
export const cloudLoginOutputSchema = z.object({
  session: nativeSessionSchema /* 与 core §3 的 native 会话同形 */,
  principal: z.object({
    principalId: z.string(),
    kind: z.enum(["owner", "member"]),
    displayName: z.string(),
  }),
  created: z.boolean(),
});
export const cloudRegisterInputSchema = z.object({
  issuer: z.string().url(),
  registrationToken: z.string(),
  label: z.string().optional(),
});
export const cloudRegisterOutputSchema = z.object({
  issuer: z.string(),
  sourceId: z.string(),
  relayOrigins: z.array(z.string()),
  trustedOrigins: z.array(z.string()),
  tunnel: tunnelStatusSchema,
});
export const tunnelStatusSchema = z.object({
  state: z.enum([
    "disabled",
    "connecting",
    "authenticating",
    "ready",
    "draining",
    "backoff",
  ]),
  node: z.string().nullable(),
  since: z.number().nullable(),
  streams: z.number(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
});
```

## §7 `./errors`

```ts
export const ERRORS = {
  // 通用
  bad_request: { status: 400 }, unauthenticated: { status: 401 }, forbidden: { status: 403 }, not_found: { status: 404 }, conflict: { status: 409 }, rate_limited: { status: 429 }, internal: { status: 500 }, unavailable: { status: 503 },
  // 账号
  email_taken: { status: 409 }, credentials_invalid: { status: 401 }, account_locked: { status: 429 }, account_disabled: { status: 403 }, email_unverified: { status: 403 }, session_expired: { status: 401 }, session_revoked: { status: 401 }, mfa_required: { status: 401 }, mfa_invalid: { status: 401 }, mfa_expired: { status: 410 },
  password_too_short: { status: 400 }, password_common: { status: 400 }, password_contains_name: { status: 400 }, password_breached: { status: 400 },
  device_code_pending: { status: 428 }, device_code_expired: { status: 410 }, device_code_denied: { status: 403 },
  // 源
  registration_token_invalid: { status: 401 }, source_taken: { status: 409 }, source_revoked: { status: 410 }, source_offline: { status: 503 }, source_access_denied: { status: 403 }, protocol_unsupported: { status: 426 },
  // 链接 / 组织
  link_invalid: { status: 404 }, link_expired: { status: 410 }, link_exhausted: { status: 410 }, link_secret_invalid: { status: 403 }, org_role_insufficient: { status: 403 }, org_slug_taken: { status: 409 },
  // 中继
  relay_token_invalid: { status: 401 }, relay_source_mismatch: { status: 403 }, limit_reached: { status: 429 },
  // core §31–§33（core 自己答；这里登记是为了两仓用同一份表）
  cloud_not_registered: { status: 401 }, cloud_account_unlinked: { status: 401 }, cloud_assertion_invalid: { status: 401 }, cloud_assertion_replayed: { status: 401 }, cloud_already_registered: { status: 409 }, cloud_issuer_mismatch: { status: 400 }, invitation_invalid: { status: 401 }, source_unreachable: { status: 502 }, source_unauthorized: { status: 401 },
} as const satisfies Record<string, { status: number }>;
export type ErrorCode = keyof typeof ERRORS;
export const errors = { pick: (...codes: ErrorCode[]) => ... }; // 给 oc.errors() 用
```

线上形状永远 `{ code, message, requestId?, details? }`。两仓各有一条扫描测试：源码里所有 `code: "…"` 字面量都在本表（cloud / relay 全仓；Armadra 只扫 `core/relay/`、`core/identity/cloud/`、`core/sources/`）。

## §8 `./identity-vectors`

常量（从 core 源码抄，加测试向量；core 侧 `identity/passwords.test.ts` 与 `throttle.test.ts` 各加一条「与协议包常量相等」的断言，cloud / relay 的实现直接 import）：

```ts
export const PASSWORD_POLICY = {
  minLengthDefault: 12,
  minLengthFloor: 10,
  minLengthCeiling: 64,
  rejectCommon: true,
  rejectContainsName: true,
};
export const SCRYPT = {
  cost: 1 << 15,
  block: 8,
  parallel: 1,
  length: 32,
  saltBytes: 16,
};
export const TOKEN_HASH_PREFIX = "armadra/identity/v1/"; // sha256(prefix + kind + "\0" + value)
export const THROTTLE = {
  lockThreshold: 5,
  lockBaseMs: 60_000,
  lockMaxMs: 15 * 60_000,
  failureWindowMs: 60 * 60_000,
  ipBucketCapacity: 20,
  ipBucketWindowMs: 60_000,
};
export const SESSION = {
  accessTtlMs: 15 * 60_000,
  refreshTtlMs: 30 * 24 * 60 * 60_000,
  refreshLeadMs: 2 * 60_000,
  wsTicketTtlMs: 30_000,
};
export const ASSERTION = {
  ttlMs: 5 * 60_000,
  replayWindowMs: 10 * 60_000,
  skewMs: 5 * 60_000,
};
export const RELAY_TOKEN = { ttlMs: 60 * 60_000 };
export const TUNNEL_TOKEN = { ttlMs: 60 * 60_000 };
export const REGISTRATION_TOKEN = { ttlMs: 10 * 60_000 };
export const DEVICE_CODE = {
  ttlMs: 10 * 60_000,
  intervalMs: 5_000,
  userCodeAlphabet: "BCDFGHJKLMNPQRSTVWXZ",
  userCodeLength: 8,
};
export const vectors: {
  scrypt: { password; salt; hex }[];
  tokenHash: { kind; value; hex }[];
}; // vectors.json
```

`vectors.json` 由 `scripts/gen-vectors.mjs` 用 `node:crypto` 生成一次并提交；两仓的测试对着它跑。

## §9 `./fixtures`

| 文件                                                                                                                                                          | 内容                                                              | 谁读                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tunnel/open-http.bin`、`open-ws.bin`、`data-64k.bin`、`end.bin`、`rst-3.bin`、`window-stream.bin`、`window-tunnel.bin`、`ping.bin`、`pong.bin`、`goaway.bin` | 每种帧一份                                                        | Armadra `core/relay/frames.test.ts`；cloud 仓 `apps/relay/src/tunnel/frames.test.ts`         |
| `tunnel/sequence-http-roundtrip.bin`                                                                                                                          | 一次完整 HTTP 往返的帧序列（OPEN、DATA×2、END、DATA、END）        | 同上 + 两仓的隧道状态机测试                                                                  |
| `tunnel/handshake.json`                                                                                                                                       | hello / challenge / auth / ready 四条样例（固定密钥、固定 nonce） | 两仓握手测试                                                                                 |
| `assertion/keys.json`                                                                                                                                         | 测试用 Ed25519 密钥对（JWK，公私都有，**只用于测试**）            | 所有签名 / 验签测试                                                                          |
| `assertion/valid.jwt`、`expired.jwt`、`wrong-aud.jwt`、`wrong-alg.jwt`、`guest.jwt`、`with-link.jwt`、`relay-token.jwt`、`tunnel-token.jwt`、`source-jws.jwt` | 各一份，`iat` 固定为 1_760_000_000_000                            | core `identity/cloud/assertion.test.ts`；cloud `assertion/*.test.ts`；relay `auth/*.test.ts` |
| `cloud-api/*.json`                                                                                                                                            | 每条 procedure 一份 input / output 样例（schema 快照测试用）      | cloud 契约测试；Armadra `apps/web/src/sources/*.test.ts`                                     |
| `errors.json`                                                                                                                                                 | §7 表的 JSON 版                                                   | 两仓错误码扫描测试                                                                           |

`./fixtures` 入口：`readFixture(name): Uint8Array`、`readJsonFixture<T>(name): T`、`TEST_KEYS`、`FIXED_NOW_MS`。

## §10 版本与发布

- semver 按平台设计 §16.3；`PROTOCOL_VERSION` 随包；`CHANGELOG.md` 中英。
- 0.1.0 = 本文全部内容（阶段 6 的 `OPEN kind=tls` 不在内）。
- 发布由 `release.yml` 在 `v*` 标签上做（trusted publishing，用户配置后才真的发）；没发之前 Armadra 用 `pnpm link ../armadra-cloud/packages/platform-protocol`（不提交）。

## §11 测试清单（C0-2 验收）

- `frames.test.ts`：每种帧编解码往返；黄金字节逐字节相等；超限 / 坏类型 / streamId 0 的非法类型各抛对应 `FrameError`。
- `handshake.test.ts`：四条消息的 zod 通过 / 缺字段拒绝；签名输入拼接与 fixtures 相同。
- `assertion.test.ts`：拆装 compact JWS；`checkTimes` 的 skew 边界；`ReplayCache` 的 TTL 与容量淘汰。
- `cloud-api.test.ts`：契约路径唯一、每条有 `scope`、所有 `errors` 在注册表、每条 fixture 通过各自 schema；OpenAPI 生成（`@orpc/openapi`）快照存 `docs/contracts/cloud-openapi.json`（cloud 仓）。
- `identity-vectors.test.ts`：scrypt 向量（Node 实现）、令牌哈希向量。
- `pnpm --filter @armadra/platform-protocol test`、`typecheck`、`build`；`pnpm pack` 出的 tarball 里有 `fixtures/`。
