# 中继 `apps/relay`：详细设计（saas 与 personal 两种模式）

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)工作包 **R1（中继内核）**、**R2（personal 控制面）**、**R3（saas 控制面适配）** 的实现规格。上位设计：[平台设计](../platform-saas-architecture.md) §8、§11、§17；协议：[协议包](protocol-package.md)。
> 代码在 `Owlbay/armadra-cloud` 仓；不 import `apps/cloud`，只依赖 `packages/platform-protocol` 与 `packages/cloud-shared`。

## §1 进程与模块

```text
apps/relay/
├── package.json         @armadra/relay；bin: armadra-relay → dist/cli.js；dependencies: @armadra/platform-protocol、ws、@peculiar/x509、acme-client、redis（saas 才 import，动态）
├── src/
│   ├── cli.ts           子命令：saas serve | personal init|serve|status|passwd|links … ；参数解析不用库（与 Armadra core/args.ts 同风格）
│   ├── main.ts          装配：读配置 → 建 ControlPlane → 起 HTTPS/HTTP 服务器 → 挂 tunnel / edge / personal-api / well-known / metrics
│   ├── config.ts        环境变量与参数表（§7）；zod 校验；错即退出 64
│   ├── control/
│   │   ├── types.ts     ControlPlane 接口（§2）
│   │   ├── memory.ts    personal：Map + 进程内事件总线 + 状态文件
│   │   └── redis.ts     saas：Redis 路由 / 限流 / 撤销 / relay:ctl 通道 + cloud JWKS 缓存
│   ├── tunnel/
│   │   ├── server.ts    /t/v1 升级、握手、Tunnel 对象管理（每源一条，替换旧的）
│   │   ├── tunnel.ts    一条隧道：帧收发、流表、窗口、心跳、GOAWAY
│   │   ├── stream.ts    TunnelStream：Duplex 适配（边缘侧的 socket ⇄ 帧）
│   │   └── handshake.ts 握手状态机（hello → challenge → auth → ready）
│   ├── edge/
│   │   ├── server.ts    客户端面：HTTP 请求与 WS 升级 → 解析源 → 校验中继令牌 → 开流
│   │   ├── addressing.ts 子域 / 路径前缀 → sourceId；剥前缀
│   │   ├── forward.ts   把 node:http 的 IncomingMessage / 升级 socket 原样序列化进 OPEN + DATA
│   │   └── internode.ts /x/v1：不持隧道的节点把整条连接转给持有节点（saas）
│   ├── auth/
│   │   ├── jwks.ts      JWKS 缓存（内存 + 可选 Redis），kid 未知时刷新一次，10 分钟 TTL
│   │   ├── relay-token.ts 校验 Armadra-Relay-Token / armadra-relay.* 子协议
│   │   └── tunnel-token.ts 校验隧道令牌 + cnf
│   ├── personal/        仅 personal 模式
│   │   ├── state.ts     state.json 读写（原子写、0600、schema 版本）
│   │   ├── accounts.ts  口令哈希、登录、锁定（identity-vectors）
│   │   ├── sessions.ts  访问令牌（JWT）与刷新令牌（devices[]）
│   │   ├── signer.ts    Ed25519 密钥生成 / 加载、JWKS、四种令牌签发
│   │   ├── sources.ts   注册令牌、注册、源目录、隧道令牌签发
│   │   ├── links.ts     分享链接、访客断言
│   │   ├── api.ts       /v1/* 子集（implement(cloudContract) 的子集，其余 404）
│   │   └── tls.ts       自签 CA / ACME / 文件证书
│   ├── http/
│   │   ├── server.ts    node:https / node:http 监听；按路径分派：/t/v1、/x/v1、/.well-known、/health、/metrics、/v1（personal）、/j 与 /app（personal 托管页面）、其余 → edge
│   │   ├── router.ts    极小路由（方法 + 路径前缀）
│   │   └── errors.ts    `{ code, message }` 输出；状态码查 ERRORS
│   ├── metrics.ts       计数器与直方图，文本格式 /metrics（只绑内网地址或要 METRICS_TOKEN）
│   └── log.ts           结构化日志；永不记录正文与路径以外的头
└── test/                见 §9
```

两种模式的差异只在 `main.ts` 的装配与 `personal/`；`tunnel/`、`edge/`、`auth/` 对模式零分支。

## §2 `ControlPlane` 接口

```ts
export interface ControlPlane {
  readonly mode: "saas" | "personal";
  readonly issuer: string; // 断言 / 令牌的 iss
  jwks(): Promise<JwkSet>; // 验令牌用；personal = 自己的
  routes: {
    get(sourceId: string): Promise<Route | null>; // { node, tunnelId, sinceMs, coreVersion }
    set(sourceId: string, route: Route, ttlMs: number): Promise<void>;
    touch(sourceId: string, ttlMs: number): Promise<void>; // 心跳刷新
    delete(sourceId: string, tunnelId: string): Promise<void>; // 只删自己的那条（CAS）
  };
  presence: {
    publish(event: PresenceEvent): Promise<void>;
    subscribe(fn: (e: PresenceEvent) => void): () => void;
  };
  limits: {
    hit(
      kind: LimitKind,
      key: string,
    ): Promise<{ allowed: boolean; retryAfterMs?: number }>;
    release?(kind, key): Promise<void>;
  };
  tokens: {
    isRevoked(jti: string): Promise<boolean>;
    revoke(jti: string, expMs: number): Promise<void>;
  };
  nodeCommands?: { subscribe(fn: (c: NodeCommand) => void): () => void }; // saas：relay:node:<node>
}
type LimitKind =
  | "tunnel.connect.src"
  | "edge.connect.ip"
  | "edge.connect.acct"
  | "edge.concurrent.acct"
  | "login.ip"
  | "login.acct"
  | "link.accept.ip";
```

## §3 隧道终端（`tunnel/`）

### 3.1 升级与握手

1. `GET /t/v1` 升级（`ws` `noServer`，`maxPayload = LIMITS.maxFrameBytes + 16`，`perMessageDeflate: false`）。限流 `tunnel.connect.src` 在 `hello` 之后按 `sourceId` 计（10 次 / 分钟）。
2. 第一帧必须是文本 `hello`（10 秒内，否则 4400）。校验 `protocol.major === PROTOCOL_VERSION.major`（否则 `reject protocol_unsupported`，关 4409）；`tunnelToken`：`auth/tunnel-token.ts` 验签（JWKS）、`aud === "relay-tunnel"`、`sub === hello.sourceId`、时间、`jti` 未撤销；取 `cnf.jwk`。
3. 发 `challenge { nonce2, relayNode }`；收 `auth.sig`，用 `cnf.jwk` 验 `sourceId\nnonce\nnonce2\nrelayNode`；失败 `reject signature_invalid` 关 4490。
4. 同一 `sourceId` 已有隧道（本节点）→ 给旧隧道发 `GOAWAY replaced` 并在 `goawayGraceMs` 后关 4491；路由表 `set` 覆盖。其它节点持有（saas）→ 也 `set` 覆盖（旧节点收到 `relay:ctl kick`，自己关旧隧道）。
5. 发 `ready`，切换到二进制模式；`routes.set(sourceId, { node, tunnelId, sinceMs, coreVersion }, 45_000)`；`presence.publish(sourceOnline)`。

### 3.2 隧道状态机

```text
handshaking ──ready──▶ open ──GOAWAY 发出──▶ draining ──流全结束或 grace 到──▶ closed
     │ 任何错误                                   ▲
     └────────────────▶ closed ◀── 心跳两次未答 / 4xxx ┘
```

- 心跳：每 `heartbeatMs` 发 `PING(ts)`；core 答 `PONG` 时 `routes.touch`；连续 `heartbeatMisses` 次无 `PONG` → `terminate()`，`routes.delete`（CAS 自己的 tunnelId）、`presence.publish(sourceOffline)`。core 发来的 `PING` 立即 `PONG`。
- 关闭：所有流 `RST sourceGone`，边缘侧 socket 以 `503 source_offline`（HTTP 尚未写头时）或关闭码 4404 结束。

### 3.3 流与窗口（`stream.ts`）

每条边缘连接 = 一条流。`TunnelStream` 是 `stream.Duplex`：

- `_write(chunk)`：按 `maxDataChunk` 切块；每块需要流信用与隧道信用都够才发 `DATA`，否则挂起 `callback` 直到收到 `WINDOW`；（背压由 Duplex 水位传给边缘 socket 的 `pipe`）。
- 收 `DATA`：`push(bytes)`；上层消费后（`_read` 被调）累计消费量 ≥ 窗口一半时发 `WINDOW(streamId, consumed)` 并把隧道级消费同样补回（`WINDOW(0, …)`）。
- `END`：`push(null)`；本地 `end()` → 发 `END`。
- `RST`：`destroy(err)`；本地 `destroy()` → 发 `RST clientGone`。
- 超过 `maxStreams` 的 `OPEN`（只有中继发 OPEN，所以这是边缘侧判）→ 边缘答 `429 limit_reached` / 关 4429。

### 3.4 边缘到隧道的序列化（`edge/forward.ts`）

HTTP 请求：`OPEN { kind:"http", method, path, headers, clientOrigin, remoteIp, relayNode }`，然后请求体 `DATA`（流式），`END`；core 侧以 Node 自己的 HTTP 解析器解析——所以中继把头**重新序列化成 HTTP/1.1 请求行 + 头**写进 `DATA`？不：两种做法里选**「OPEN 只带元数据，DATA 里是完整的 HTTP/1.1 字节」**。理由：core 侧把 `Duplex` 直接 `emit("connection")` 给 `http.Server`，Node 负责解析，中继不必理解 HTTP 语义，也不必为 chunked / 100-continue / 升级写特殊路径。所以 `forward.ts` 的做法是：边缘用 `server.on("request")` 拿到已解析的头 → 重新序列化成请求行 + 头（剥掉 `Armadra-Relay-Token`，`X-Forwarded-For` 设为 `remoteIp`，`X-Forwarded-Proto: https`，`Host` 保留原值）→ 写 `DATA`，然后 `req.pipe(stream)`；响应从 `stream` 读出的字节原样写回 `res.socket`（接管 socket：`res.detachSocket()` 后 `socket.write`）。WS 升级：`server.on("upgrade")` → 同样序列化升级请求（剥掉 `armadra-relay.*` 子协议，保留 `armadra-ticket.*`）→ `socket.pipe(stream).pipe(socket)`。`OPEN.kind` 只用于计数与日志。

元数据 `clientOrigin` / `remoteIp` 也进了 `OPEN`，core 的 `relay/admission.ts` 用它们（而不是信任头）。

## §4 客户端边缘（`edge/`）

1. 解析源：`addressing.ts`——saas：`Host` 匹配 `^([0-9a-f]{32})\.src\.<RELAY_DOMAIN>$`；personal：路径前缀 `^/s/([0-9a-f]{32})(/.*)$`，剥掉前缀后再转发。都不匹配 → 404（HTTP）/ 拒绝升级。
2. 校验中继令牌：HTTP 头 `Armadra-Relay-Token`；WS 子协议里 `armadra-relay.<jwt>`。`auth/relay-token.ts`：验签、`aud === "relay"`、`src === sourceId`、时间、`jti` 未撤销。缺 → 401 `relay_token_invalid`；`src` 不符 → 403 `relay_source_mismatch`。
3. 限流：`edge.connect.ip`（200 / 分钟）、`edge.connect.acct`（`sub`，120 / 分钟）、`edge.concurrent.acct`（64 条并发 WS）。
4. 路由：`routes.get(sourceId)`；无 → `503 source_offline`（WS：4404）。持有者是本节点 → 开流；否则（saas）经 `internode.ts` 转发到持有节点（`wss://<node>/x/v1`，头 `X-Armadra-Internode: <HMAC(secret, sourceId|ts)>`，把整条原始连接字节透传；持有节点在 `/x/v1` 上把它当作一条边缘连接处理，但跳过令牌校验（已由入口节点校验，头里带 `clientOrigin` / `remoteIp`）。
5. 对客户端 WS 每 30 秒 `ping`，60 秒无 `pong` 断。
6. 不解析帧内容；不缓存。

`/health`（`{ ok, mode, node, tunnels, streams }`）、`/metrics`（只在 `METRICS_LISTEN` 上，文本格式：`relay_tunnels`, `relay_streams`, `relay_bytes_total{direction}`, `relay_edge_connections_total{result}`, `relay_handshake_total{result}`, `relay_heartbeat_miss_total`）。

## §5 saas 控制面适配（`control/redis.ts`）

| 接口             | Redis                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `jwks`           | `GET <CLOUD_ISSUER>/.well-known/jwks.json`，内存缓存 10 分钟 + Redis `jwks:<issuerHash>`（共享，TTL 10 分钟）               |
| `routes.get/set` | `route:src:<sourceId>` = JSON，`SET … PX 45000`；`touch` = `PEXPIRE`；`delete` = Lua：值里 `tunnelId` 相等才 `DEL`          |
| `presence`       | `PUBLISH relay:ctl <json>`；`SUBSCRIBE relay:ctl`（cloud 也订阅）                                                           |
| `limits.hit`     | `INCR rl:<kind>:<key>` + 首次 `PEXPIRE`（固定窗口）；并发类用 `SADD/SREM rl:edge.concurrent.acct:<acct> <connId>` + `SCARD` |
| `tokens`         | `revoked:jti:<jti>` = 1，`PX` 到 `exp`；`isRevoked` = `EXISTS`                                                              |
| `nodeCommands`   | `SUBSCRIBE relay:node:<RELAY_NODE_ID>`：`{ type:"closeTunnel", sourceId }`、`{ type:"kick", sourceId, reason }`             |

节点启动时把自己写进 `relay:nodes` hash（`node → { url, startedAt }`，TTL 60 秒由心跳续）；cloud 的 `GET /v1/sources/me/relay` 从这里读节点列表。

## §6 personal 模式（`personal/`）

### 6.1 状态文件 `state.json`（`<data-dir>/state.json`，0600，原子写）

```json
{
  "version": 1,
  "issuer": "https://203.0.113.5:8443",
  "account": {
    "name": "me",
    "password": {
      "kdf": "scrypt",
      "cost": 32768,
      "block": 8,
      "parallel": 1,
      "length": 32,
      "salt": "b64",
      "hash": "b64"
    },
    "createdAtMs": 0,
    "failures": 0,
    "lockedUntilMs": 0,
    "updatedAtMs": 0
  },
  "signingKeys": [
    {
      "kid": "k1",
      "privateKeyPkcs8": "b64",
      "publicJwk": {},
      "activeFromMs": 0,
      "retiredAtMs": null
    }
  ],
  "sources": [
    {
      "sourceId": "hex32",
      "name": "我的 MacBook",
      "kind": "desktop",
      "publicJwk": {},
      "coreVersion": "0.2.0",
      "registeredAtMs": 0,
      "lastSeenAtMs": 0,
      "revokedAtMs": null,
      "trustedOrigins": []
    }
  ],
  "registrationTokens": [{ "tokenHash": "hex", "expiresAtMs": 0 }],
  "devices": [
    {
      "deviceId": "hex32",
      "subject": "acct:me",
      "platform": "ios",
      "name": "iPhone",
      "refreshHash": "hex",
      "rotation": 1,
      "expiresAtMs": 0,
      "revokedAtMs": null,
      "lastSeenAtMs": 0
    }
  ],
  "links": [
    {
      "linkId": "hex16",
      "sourceId": "hex32",
      "invitationId": "hex32",
      "label": "给同事",
      "role": "editor",
      "secretHash": "hex",
      "maxUses": 5,
      "uses": 0,
      "expiresAtMs": 0,
      "revokedAtMs": null
    }
  ],
  "settings": { "allowGuests": true, "trustedOrigins": [] }
}
```

写入时机：账号变更、源注册 / 撤销、设备签发 / 旋转 / 撤销、链接增删、密钥轮换。心跳 / 在线状态 / 限流 **不** 写文件（只在内存）。`lastSeenAtMs` 每 5 分钟批量写一次。

### 6.2 账号与会话（`accounts.ts`、`sessions.ts`）

- `init`：`armadra-relay personal init --data-dir D --account NAME [--password-file F] [--host H] [--port 8443]`；口令过 identity-vectors 策略；写 `state.json`、生成签名密钥、按 `--tls` 准备证书；打印 CA 指纹。
- 登录：`POST /v1/auth/login { account, password, device }`：`limits.hit("login.ip")` → 账号名相等 → 锁定检查（`lockedUntilMs`）→ scrypt 比对（常量时间）→ 失败计数 / 锁定（identity-vectors `THROTTLE`）→ 成功清零 → 建 `devices[]` 一行（`subject: "acct:<name>"`）→ 签访问令牌（JWT，`sub: "acct:<name>"`）+ 刷新令牌明文（只返回一次，存哈希）。
- 刷新：`POST /v1/auth/refresh`：哈希查 `devices[]`，`rotation` 比对（旧令牌再来 = 重放 → 撤销该设备，答 `session_revoked`），签新对。
- `passwd` 子命令改口令并撤销全部设备。

### 6.3 签名与令牌（`signer.ts`）

Ed25519，`kid` 递增；JWKS 答所有未 `retired` 的公钥；四种令牌按协议包 §4.2 签。`personal rotate-key` 子命令追加新键并把旧键 `retiredAtMs = now + 1h`（最长令牌寿命）。

### 6.4 源（`sources.ts`）

- `POST /v1/sources/registration-tokens`（账号会话）→ 随机 32 字节 → 存哈希 + 10 分钟。
- `POST /v1/sources/register`（匿名 + 令牌）：验令牌 → `sources[]` 新增或替换（同 `sourceId` 未撤销且公钥不同 → `source_taken`，personal 下同一账号可 `--force` 用 `DELETE` 先撤）→ 答 `{ issuer, jwksUrl, relayOrigins: [issuer], trustedOrigins: settings.trustedOrigins ∪ [issuer + "/app"], sourceId, ownerAccountId: "acct:<name>" }`。
- `GET /v1/sources/me/relay`（源 JWS）：验 `kid`=`sourceId` 的公钥在 `sources[]` → 签隧道令牌（`cnf.jwk` = 该公钥）→ `{ tunnelToken, nodes: [{ url: wss://<issuer host>/t/v1 }], limits }`。
- `POST /v1/sources/{id}/assertion`（账号会话或访客设备）：源存在且未撤销；访客只能对其链接指向的源 → 签断言 + 中继令牌 → `{ …, relayOrigin: issuer, relayBaseUrl: issuer + "/s/" + sourceId, online: routes.get != null }`。
- `GET /v1/me/sources`：账号 → 全部；访客 → 其链接的源。

### 6.5 分享（`links.ts`）

平台设计 §17.3。`links.create` 返回 `secret`（随机 32 字节 base64url）；`links.accept { secret }`：`limits.hit("link.accept.ip")`（20 / 分钟）→ `secretHash` 比对 → 未过期、`uses < maxUses`（`null` 不限）→ `uses++` → 建访客设备（`subject: "guest:<linkId>:<rnd8>"`，刷新令牌 30 天）→ 签断言（`link: { linkId, invitationId }`）+ 中继令牌 → 答 `{ sourceId, relayOrigin, relayBaseUrl, assertion, relayToken, guestSession }`。`links.revoke` 撤销链接并撤销所有 `subject` 以 `guest:<linkId>:` 开头的设备。

### 6.6 TLS（`tls.ts`）

| `--tls`               | 做法                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self-signed`（默认） | 首次：`@peculiar/x509` 生成 CA（Ed25519 不被所有客户端接受，用 ECDSA P-256）10 年 + 叶证书 90 天（SAN = `--host` 的 IP / DNS，加 `localhost`、`127.0.0.1`）；存 `<data-dir>/tls/{ca.crt,ca.key,leaf.crt,leaf.key}`（0600）；到期前 7 天自动换叶；`GET /ca.crt` 发 CA；`status` 与启动日志打印 CA 指纹（DER SHA-256，与 core Gateway `tls.source=localCa` 的定义一致） |
| `acme`                | `acme-client`：`--acme-email`、`--acme-directory`（缺省 Let's Encrypt 生产；dev-stack 指向 pebble）、`--acme-challenge http-01\|tls-alpn-01`；账号密钥与证书在 `<data-dir>/acme/`；续期：剩 30 天时，每 12 小时重试，失败继续用旧证书并计数                                                                                                                           |
| `file`                | `--tls-cert`、`--tls-key`；文件变化时（`fs.watch`）热加载                                                                                                                                                                                                                                                                                                             |
| `plain`               | 只允许 `--listen 127.0.0.1:*`；给反向代理用                                                                                                                                                                                                                                                                                                                           |

### 6.7 托管页面

`--web-root <dir>`（镜像内缺省 `/app/web`，从 `armadra-server` 镜像复制同版本构建产物）：`GET /app/*` 与 `GET /j/<linkId>` 都答 `index.html`（SPA）；`/j/` 的落地逻辑在页面里（client 包 §6）。CSP 由中继下发：`connect-src 'self'`。没有 `--web-root` 时 `/j/*` 答一个最小 HTML（纯文本说明 + 深链 `armadra://join?...`）。

## §7 配置（环境变量 / 参数；参数优先）

| 变量                          | saas | personal | 说明                                              |
| ----------------------------- | ---- | -------- | ------------------------------------------------- |
| `RELAY_MODE`                  | ✔   | ✔       | `saas` / `personal`（子命令覆盖）                 |
| `RELAY_LISTEN`                | ✔   | ✔       | `0.0.0.0:8443`                                    |
| `RELAY_PUBLIC_ORIGIN`         | ✔   | ✔       | 对外来源；personal 缺省 `https://<--host>:<port>` |
| `RELAY_NODE_ID`               | ✔   | —        | 节点名（缺省主机名）                              |
| `RELAY_DOMAIN`                | ✔   | —        | `src.<域>` 的 `<域>`                              |
| `RELAY_CLOUD_ISSUER`          | ✔   | —        | cloud 的 issuer URL（JWKS 从这里拉）              |
| `RELAY_REDIS_URL`             | ✔   | —        |                                                   |
| `RELAY_INTERNODE_SECRET`      | ✔   | —        | 节点间 HMAC；缺省生成并拒绝多节点                 |
| `RELAY_INTERNODE_URL`         | ✔   | —        | 本节点对其它节点的地址                            |
| `RELAY_TLS_CERT` / `_KEY`     | ✔   | ✔       | 文件证书                                          |
| `RELAY_DATA_DIR`              | —    | ✔       | `state.json`、tls/、acme/                         |
| `RELAY_TLS`                   | —    | ✔       | `self-signed` / `acme` / `file` / `plain`         |
| `RELAY_WEB_ROOT`              | —    | ✔       | 托管页面目录                                      |
| `RELAY_METRICS_LISTEN`        | ✔   | ✔       | 缺省不开                                          |
| `RELAY_LOG_LEVEL`             | ✔   | ✔       | `info`                                            |
| `RELAY_ALLOW_INSECURE_TUNNEL` | ✔   | ✔       | 允许 `ws://`（只在 dev-stack）                    |

## §8 错误码与关闭码

全部取自协议包 `./errors` 与 `./tunnel` 的 `CLOSE`；本仓不出现本地字面量（扫描测试）。

## §9 测试清单

单测（vitest，`apps/relay/src/**/*.test.ts`）：

- `tunnel/handshake.test.ts`：四步正常；坏 major 4409；令牌过期 / 错 aud / 错 sub / 撤销；签名错 4490；10 秒超时 4400；fixtures `handshake.json` 逐条。
- `tunnel/tunnel.test.ts`：心跳两次未答关闭并删路由（假时钟）；`GOAWAY` 后拒绝新 OPEN、旧流自然结束、grace 到强关；同源替换 4491。
- `tunnel/stream.test.ts`：窗口耗尽时 `DATA` 停发、`WINDOW` 后继续；隧道级窗口共享；信用为负 → RST 5 + 4400；64 KiB 切块；`END` / `RST` 双向。
- `edge/addressing.test.ts`：子域 / 路径两种解析与剥前缀；非法 → 404。
- `edge/forward.test.ts`：请求行与头的重新序列化（剥令牌、加 X-Forwarded-_、保留 Host）；升级请求保留 `armadra-ticket._`剥`armadra-relay.\*`。
- `auth/*.test.ts`：中继令牌 / 隧道令牌对 fixtures 的各种失败；JWKS `kid` 未知刷新一次、刷新失败用缓存。
- `control/memory.test.ts`：路由 TTL、限流窗口与并发集合、撤销 TTL。
- `control/redis.test.ts`（需 `REDIS_URL`，CI 服务容器）：同上 + `relay:ctl` 发布订阅 + CAS 删除。
- `personal/*.test.ts`：口令向量、锁定序列（5 次后 1 分钟、翻倍、15 分钟封顶、1 小时清零）、刷新旋转与重放撤销、注册令牌一次性、链接次数与过期、访客撤销、`state.json` 原子写与 0600、密钥轮换后旧令牌仍可验到 `retiredAtMs`。
- `personal/tls.test.ts`：自签 CA 生成、SAN、指纹定义、叶证书到期换发（假时钟）。
- `errors.scan.test.ts`：源码 `code: "…"` 全在注册表。

集成（`apps/relay/test/integration/`，用假 core：`test/fake-core.ts` 跑一个最小 `http.Server` + `ws`，经协议包隧道客户端的测试实现连上来）：

- `roundtrip.test.ts`：HTTP GET/POST（含 chunked 体）、WS 回显 1000 帧、二进制帧、并发 100 流、源下线 503 / 4404、重上线路由更新。
- `two-nodes.test.ts`（saas，需 Redis）：客户端连到不持隧道的节点经 `/x/v1` 通；节点 A 断，`route` 过期后 503。
- `personal-e2e.test.ts`：`init` → `serve` → 登录 → 注册令牌 → 假 core 注册 + 取隧道令牌 + 握手 → 客户端取断言 → 经 `/s/<id>/` 访问假 core → 链接 accept → 访客断言。

## §10 本地运行

```sh
# cloud 仓
pnpm install && pnpm libs:build
pnpm relay:personal            # = node apps/relay/src/cli.ts personal serve --data-dir .data/personal --host 127.0.0.1 --port 8102 --tls self-signed --web-root ../Armadra/apps/web/dist（存在才托管）
#   首次自动 init：账号 dev，口令随机写 .data/personal/dev.env；打印 CA 指纹
pnpm dev:up && pnpm dev        # saas：起 PG + Redis，再起 cloud(8100) + relay(8101, 隧道同端口 /t/v1)
armadra-relay personal status  # 读 state.json：账号、源、链接、证书与指纹
```

Docker：`docker run -v relay:/data -p 8443:8443 ghcr.io/owlbay/armadra-relay personal serve --host <公网 IP>`；首次用 `… personal init --account me` 交互设口令（或 `-e RELAY_PERSONAL_PASSWORD_FILE=/run/secrets/pw`）。`deploy/personal/compose.yml` 是同一条命令的 compose 写法。
