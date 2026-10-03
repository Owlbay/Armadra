# 安全审查 2026-10：补全计划新增面

状态：已验证（2026-10-04，分支 `feat/g3-8-security-closing`）。

范围是补全计划（[补全架构](../design/completion-architecture.md)、[补全执行计划](../design/completion-plan.md)）G1–G2 加进来的全部面：身份加固、OAuth、passkey、Gateway / 本地 CA / 配对票、推送与中继加密、节点凭据兑换、ama 模型密钥兑换、崩溃上报剥离、ACP 与工作流的路由授权、实时同步的认证。判据是 `AGENTS.md` 的 P0 / P1 定义与[补全架构](../design/completion-architecture.md) §8.1 的信任边界。

结论：**中危及以上 9 条，全部修复并有测试**；低危 10 条列在 §3，未修；1 条设计约束写在 §4。

## 1. 方法

- 逐个面读实现，对照它的契约节（`docs/contracts/core-json-api.md` §14–§20、§23）与威胁：谁能调、凭什么认人、写操作要不要 CSRF、对象属于哪块画布、值会不会进日志 / 响应 / 审计、长连接在授权变化后还活不活。
- 路由覆盖：路由表（`core/http/routes.ts`）的每条已实现路由在 `route-scopes.ts` 都有声明（既有用例），本次补上路由表之外整段接管的前缀（身份、OAuth、GitHub、自动化、工作流）——每个前缀下的读写都必须有声明或在 `SELF_GUARDED` 里（`main.test.ts`「整段接管的前缀也都声明了 scope 或自己认身份」）。
- 严重度：**高** = 跨主体越权、凭据外泄、可借他人会话执行；**中** = 某条防线缺失但另有一道挡着，或功能性的安全规则不一致；**低** = 纵深防御、需要额外前提、或影响很小。

## 2. 中危及以上（已修复）

| 编号 | 严重度 | 面                  | 问题                                                                                                                                                                                                                                                          | 修复                                                                                                                                                                                                                                     | 测试                                                                                 |
| ---- | ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| H1   | 高     | 终端 / ACP 路由授权 | `POST /api/terminals` 与 `POST /api/acp/sessions` 只按请求体的 `workspaceId` 判 `terminal:create`，体里的 `nodeId` 可以是另一块画布上的节点：A 上的 operator 能给 B 的节点铸节点 token、接上 B 的 ACP 会话与凭据绑定、以 B 的身份用协作动词                   | 路由门在这两条上查节点所在画布（`identity/route-access.ts` 的 `foreignNode`），与体里的不一致即拒；认不出（新节点还没落库）时按体里的判                                                                                                  | `route-access.test.ts`「请求体里的节点属于别的画布」                                 |
| H2   | 高     | 节点凭据            | 成员起终端时带 `credentialRef`（条目名在节点数据里，看得见画布就看得见），或在绑着凭据的节点上开 ACP 会话，core 照样把绑定接上；节点 shell 经 `armadra-hook credential` 就能把 owner 的令牌兑换出来。共享角色里本没有 `credential:use`                        | `terminal/install.ts::ownedEnvironment` 在接绑定之前要全局 `credential:use`，否则 403 `credential_forbidden`（请求体与节点持久绑定两条路都拦）；本机壳与 core 自己的动作按 owner 判。契约 §20.3                                          | `credentials.test.ts`「refuses a member without credential:use」                     |
| H3   | 高     | 资产 / Gateway      | 画布资产按原样的 `image/svg+xml` 回出去；同源导航到资产地址（Gateway 对同源 GET 会补出 Origin）时，一张带脚本的 SVG 作为文档在 Gateway 来源上运行，可用看它的人的 Cookie 会话换 CSRF、调任何接口——editor 借 owner 的会话提权                                  | 资产答案带 `default-src 'none'; …; sandbox`（`assets/routes.ts`）；Gateway 的全部 `/api/**` 答案带沙箱 CSP（M6）                                                                                                                         | `assets/routes.test.ts`、`gateway.integration.test.ts`「每个答案都带 HSTS…」         |
| M1   | 中     | 账号 / 组 / 共享    | 服务器壳上 `/api/identity/` 的账号写路由（建号、设口令、邀请、组、共享）不核 `X-Armadra-CSRF`（G1-11 发现）。Gateway 的 Origin 检查与 `SameSite=Strict` 仍挡着，所以是中                                                                                      | `handleAccounts` 按方法统一：非 `GET` 一律在认人时核 CSRF（`subject()` 不再靠各条路由记得）。契约 §10                                                                                                                                    | `gateway.integration.test.ts`「账号 / 组 / 共享的写路由在 Cookie 会话上要 CSRF」     |
| M2   | 中     | CSRF 规则一致性     | 身份加固与 OAuth 的写路由对 Bearer 请求也要 CSRF，而桌面壳与原生 App 的页面在 Bearer 传输上不发这个头（契约 §17.4 写明 Bearer 模式没有 CSRF）：桌面安全页开 MFA、加通行密钥、撤销会话，App 上同样操作，一律 403。规则两处说法不一，安全页在两种壳上实际不可用 | 一条规则：CSRF 只在 Cookie 会话上核对（`identity/http.ts::csrfRequired`），身份域、加固、OAuth、设备撤销同用。Bearer 不是环境凭据，跨站页面带不上                                                                                        | `security-http.test.ts`「Bearer 传输的写不核对 CSRF」、`gateway.integration.test.ts` |
| M3   | 中     | 会话 / 设备撤销     | 撤销设备或会话、登出、停用账号、收回共享之后，已升级的**终端、语言服务、浏览器画面**流照旧可读可写（只有事件流与实时同步自己复核）                                                                                                                            | `CoreServer.upgrade` 记下升级时的请求身份，授权一变就按同一道路由门、用 `revalidate()` 给的主体复核，不过以 4403 关流；没有请求身份（桌面壳）的流不受影响。契约 §17.4                                                                    | `http/server-revoke.test.ts`                                                         |
| M4   | 中     | 限流                | 只有登录类请求过 IP 桶；`pair`、`session/refresh`、`session/csrf`、`session/logout` 不限                                                                                                                                                                      | 这四条共用同一个来源地址的桶，**只有失败才扣**、桶空即 429（`Throttle.checkIp` / `chargeIp`）——凭据是 256 位随机串，限的是撒网猜票，不让 NAT 后的多人互相挤掉刷新。契约 §18.1                                                            | `security-http.test.ts`「凭据换会话的那几条也限流」                                  |
| M5   | 中     | 审计                | 架构 §8.1 要求 Gateway 开关进审计，实际没有；配对票签发、节点凭据增改删、ama 模型密钥设 / 清也都不留痕                                                                                                                                                        | 新动作 `gateway.configure`、`gateway.pairing.issue`、`credential.create/update/delete`、`ama.credential.set/clear`（值、票、文件路径都不进 `detail`）；安全页审计加「对外服务与凭据」类型，中英文案                                      | `gateway.integration.test.ts`、`credentials.test.ts`、`ama-credentials.test.ts`      |
| M6   | 中     | Gateway 响应头      | HSTS 只在静态产物上；接口答案（含会话、CSRF、原生密钥）没有 HSTS、`nosniff`、`no-store`，门拒掉的答案也没有                                                                                                                                                   | 每个经 Gateway 的答案带 HSTS、`nosniff`、`no-referrer`；`/api/**` 与 `/health` 再带沙箱 CSP、`X-Frame-Options: DENY`、缺省 `no-store`（`gateway/csp.ts`）。原生 App 包里页面的 CSP 放行表 `nativeAppContentSecurityPolicy()`。契约 §17.4 | `csp.test.ts`、`gateway.integration.test.ts`                                         |

另外顺手修掉一条低危：没被域接住的坏 JSON 走到 `CoreServer` 的兜底，`SyntaxError` 的消息引着请求体开头（可能就是一个凭据值），会进日志与崩溃上报。现在直接答 400，不记消息（`server-report.test.ts`）。

## 3. 低危（未修，列出）

| 编号 | 面              | 说明                                                                                                                                                 | 建议                                                                        |
| ---- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| L1   | 长连接          | 复核只在授权变化时发生；访问令牌到期（15 分钟）本身不断流                                                                                            | 按访问令牌到期时间定时复核一次                                              |
| L2   | 口令            | 改口令不撤销这个人的其它会话                                                                                                                         | 设口令成功后按「其它设备全部登出」处理，或在安全页给出提示                  |
| L3   | 邀请            | `POST invitations` 的 `ttlMs` 没有上限（只有 owner / 组 admin 能发）                                                                                 | 夹到 30 天                                                                  |
| L4   | OAuth           | 挂起的 `state` 表满 1000 条时挤掉最老的；发起受 IP 桶限速，但多地址仍能挤掉别人的登录                                                                | 按来源地址分表                                                              |
| L5   | 推送中继        | `/v1/register` 不认证，谁都能为一个平台令牌换中继令牌；载荷是端到端密文、按令牌限速，中继也还没部署（架构 §14 Q6）                                   | 部署前加 App 证明（App Attest / Play Integrity）或发布方签名                |
| L6   | 崩溃上报        | 剥离规则认得常见第三方令牌形状，不认 Armadra 自己的会话密钥（`<会话>.<密钥>`）；这类值很少出现在错误消息里                                           | 加一条形状规则                                                              |
| L7   | 页面            | 口令策略的拒绝码（含 `password_breached`）与 `warn` 档的 `passwordBreached: true` 页面都没有专门文案，`warn` 不提示                                  | 账号页按 `code` 选文案，`warn` 时给一条 Alert                               |
| L8   | GitHub / 自动化 | 这两面（契约 §3.2）对 Bearer 写仍要 CSRF：桌面壳走「无凭据即本机主人」那条路不受影响，原生 App 经 Gateway 用 Bearer 写这两面会 403                   | 与 M2 同一条规则（`csrfRequired`），连同 `github/http.test.ts` 的断言一起改 |
| L9   | 桌面回环        | 既有设计：桌面壳的 core 答任何回环 HTTP 来源（契约 §3.2「明文回环上没带凭据的一次调用按本机主人处理」），本机另一个在回环端口上服务的网页可以调 core | 长期：桌面也走票据换 Bearer，回环无凭据请求不再按主人处理                   |
| L10  | ama 密钥        | 任何 ama 节点的进程都能兑换全部已设的 ama 模型密钥（不按节点区分供应商）                                                                             | 按节点的模型配置只发用得到的那一家                                          |

## 4. 设计约束（不是缺陷，需要部署方知道）

**operator 等于在服务器上以 core 的系统用户执行任意命令。** `terminal:create` 就是开 shell；节点 token 文件、hook 的应用令牌、`file` / `file-encrypted` 后端的 SecretStore、库文件都在同一个系统用户下，一个 operator 的 shell 可以读到它们。H2 关掉的是「core 主动把 owner 的凭据交给成员的进程」这条路，不是这条约束本身。部署建议：服务器壳跑在专用系统用户或容器里（[服务器部署](../guides/server-deployment.md) 的镜像就是），只把 operator 及以上给信任的人；需要隔离的成员各起一台服务器壳。

## 5. 审过、没有发现的面

- **passkey**（`identity/passkey.ts`）：全部校验交给 `@simplewebauthn/server`；挑战内存 2 分钟一次性；`origin` 与 RP ID 由服务端定；IP 主机拒绝；`sign_count` 按库的判定存。
- **TOTP / 恢复码**：密钥在 SecretStore；记最后一个时间步防重放；恢复码 scrypt；停用与换码要一个当前有效的码。
- **OAuth**：`state` 一次性、PKCE S256、`nonce`、浏览器绑定 Cookie（`SameSite=Lax`、`__Host-`）；`returnTo` 只收本站路径；JWKS 只收 RS256 / ES256；`clientSecret` 不出接口。
- **Gateway / 本地 CA / 配对**：CA 与叶私钥 0600、目录 0700；配对票两分钟一次性、只进 URL 片段；Bearer 只认 `capacitor://localhost` / `https://localhost` 两个来源、会话绑在 Gateway 来源上；WS 票 30 秒一次性；`native` 密钥只在原生传输上进响应体，网页端一律 `HttpOnly; SameSite=Strict; Secure` 的 `__Host-` Cookie。
- **推送**：端到端信封 X25519 + HKDF-SHA256 + AES-256-GCM，每条一次性密钥对；收件人按 `canvas:read` 过滤并排除撤销的设备与停用的账号；载荷只有标题、短正文、深链；中继令牌 AES-GCM 封装、无状态。
- **节点凭据与 ama 兑换**：只在本机 hook 面；应用令牌 + 验过的节点 token；只答节点此刻绑定的那一条 / 只答 ama 节点；`no-store`；不记日志。
- **崩溃上报**：整段删 `extra`、环境、请求、cookie、局部变量；面包屑不留 `data`；字符串替换家目录、环境变量值、令牌形状、URL 账号与查询串，截断 300 字符。
- **ACP / 工作流路由**：ACP 会话按会话行、驱动切换按节点、工作流按草案 / 运行 / 画板查画布；模板只有 owner；关卡答复要运行所在画布上的 operator；查不到对象一律拒。
- **实时同步**：升级要 `canvas:read`，每一帧更新要 `canvas:write`（在实时域里判）；授权变化时复核，不够以 4403 关；评论改正文只有作者、删除作者或 owner。

## 6. 本次验证

- `pnpm --filter @armadra/desktop exec vitest run src/core/identity src/core/gateway src/core/http src/core/terminal src/core/acp src/core/agent src/core/assets src/core/main.test.ts` 全过。
- `ARMADRA_DEV_STACK=1` 对 `pnpm dev-stack up hibp` 的容器：`policy.devstack.integration.test.ts` 通过（夹具口令命中、其余不命中）。
- 完整验证命令与 CI 结果见[补全进度](completion-progress.md) G3-8 节。
