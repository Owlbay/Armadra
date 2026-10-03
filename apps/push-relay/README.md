# 推送中继

`@armadra/push-relay` 是商店版 App 的最小推送中继：商店版 App 的 APNs `.p8` 与 Firebase 服务账号属于发布方，不能随包分发给每个用户的 core，所以 core 把**已经端到端加密的**通知交给这里，由这里转给 Apple / Google（[补全架构](../../docs/design/completion-architecture.md) §10 的 `relay` 传输，契约 §19.5）。

**是否运营由发布方决定**（架构 §14 Q6：代码写完，暂不上线）。没有中继时，商店版 App 只有前台通知；自己构建 App 的部署用 core 的 `direct` 传输直连，网页与 PWA 走 Web Push。

## 它看得到什么

| 看得到                                   | 看不到                                          |
| ---------------------------------------- | ----------------------------------------------- |
| 平台（ios / android）与平台令牌          | 标题、正文、深链、工作空间、节点                |
| 折叠键（tag 的摘要）、是否紧急           | 设备私钥（只在设备上）                          |
| 密文信封 `{ v, alg, epk, salt, iv, ct }` | core 的地址与身份（中继令牌不含任何 core 信息） |

信封是设备注册时上交的 X25519 公钥 + 一次性密钥对的 ECDH，HKDF-SHA256 派生 AES-256-GCM（`apps/desktop/src/core/push/crypto.ts`）。App 在 iOS Notification Service Extension / Android 数据消息处理器里用设备私钥解开再显示。中继只收信封，没有明文入口。

**无状态**：中继令牌就是平台令牌用中继自己的钥封起来的密文，不存任何表；重启、多实例、换机器都不影响。换钥（`ARMADRA_RELAY_SECRET_FILE`）等于让所有中继令牌作废——core 收到 `badToken` 撤销设备，App 下次启动重新登记。内存里只有每个令牌每分钟 60 条的限流窗口。

## 接口

```text
POST /v1/register  { "platform": "ios" | "android", "token": "<平台令牌>" }
                   → 200 { "relayToken": "…" }
POST /v1/push      { "relayToken": "…", "envelope": { v, alg, epk, salt, iv, ct },
                     "collapseId": "…", "urgent": true }
                   → 202 { "accepted": true }
                   → 400 { "code": "invalid" | "badToken" | "platformUnavailable" }
                   → 410 { "code": "gone" }            平台说令牌作废
                   → 429 { "code": "rateLimited" }
                   → 502 { "code": "upstream" }        上游失败，core 会重试
GET  /health       → 200 { "ok": true, "platforms": ["ios", "android"] }
```

App 自己调 `/v1/register` 拿中继令牌，再以 `transport: "relay"` 与设备公钥登记给它连接的 core（`PUT /api/push/devices`）；core 推送时调 `/v1/push`。

## 运行

```sh
pnpm --filter @armadra/push-relay build      # esbuild → out/main.js，只依赖 Node 自带模块
pnpm --filter @armadra/push-relay test
head -c 32 /dev/urandom > relay.secret && chmod 600 relay.secret
ARMADRA_RELAY_SECRET_FILE=relay.secret \
ARMADRA_RELAY_APNS_KEY_FILE=AuthKey_XXXXXXXXXX.p8 ARMADRA_RELAY_APNS_KEY_ID=XXXXXXXXXX \
ARMADRA_RELAY_APNS_TEAM_ID=YYYYYYYYYY ARMADRA_RELAY_APNS_TOPIC=<bundle id> ARMADRA_RELAY_APNS_PRODUCTION=1 \
ARMADRA_RELAY_FCM_CREDENTIALS_FILE=service-account.json \
node apps/push-relay/out/main.js
```

| 变量                                                              | 用途                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `ARMADRA_RELAY_HOST` / `ARMADRA_RELAY_PORT`                       | 监听地址，缺省 `127.0.0.1:8095`；公网前面放 TLS 反向代理 |
| `ARMADRA_RELAY_SECRET_FILE`                                       | 32 字节随机数（原始或 base64），封中继令牌               |
| `ARMADRA_RELAY_APNS_KEY_FILE` / `_KEY_ID` / `_TEAM_ID` / `_TOPIC` | 发布方的 APNs `.p8`、Key ID、Team ID、bundle id          |
| `ARMADRA_RELAY_APNS_PRODUCTION`                                   | `1` = 生产 APNs，否则 sandbox                            |
| `ARMADRA_RELAY_FCM_CREDENTIALS_FILE` / `_PROJECT_ID`              | 发布方的 Firebase 服务账号 JSON；项目 id 缺省取账号里的  |
| `ARMADRA_RELAY_APNS_ENDPOINT` / `ARMADRA_RELAY_FCM_ENDPOINT`      | 只给测试：指向 dev-stack 的 `push-sink`                  |

密钥一律只给文件路径。APNs 与 FCM 至少配一个，否则进程拒绝启动。

## 本地验证

用例（`src/relay.test.ts`）在进程内起 dev-stack 的 `push-sink`（`tools/dev-stack/push-sink.mjs`）当 APNs / FCM，走「core 的 relay 传输 → 中继 → 假 APNs / FCM」整条线，断言 provider token 验签通过、苹果 / Google 看到的是同一个信封且设备私钥能解、作废与换钥都让 core 撤销设备、明文进不来。A 档探针 `tools/probes/push-e2e.mjs` 对着 `pnpm dev-stack up` 起的 `push-sink` 再走一遍。

| 文件           | 职责                                                   |
| -------------- | ------------------------------------------------------ |
| `src/relay.ts` | 路由、中继令牌封解、信封校验、限流                     |
| `src/apns.ts`  | iOS 一侧：复用 core 的 `ApnsClient` 与 `apnsBody`      |
| `src/fcm.ts`   | Android 一侧：复用 core 的 `FcmClient` 与 `fcmMessage` |
| `src/main.ts`  | 读环境变量、起 HTTP 服务                               |
