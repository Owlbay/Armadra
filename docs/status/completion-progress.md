# 补全进度

> 状态：已验证进度。逐包记录 [补全执行计划](../design/completion-plan.md) §2 的工作包；框架与决定见 [补全架构](../design/completion-architecture.md)。
> 规矩：每节由对应工作包合入时填写「做了什么 / 实测 / 没做」，只改自己那一节；节标题与顺序由 G0-1 预建，不改。实测写命令与结果（通过数、产物路径、PR）；没做写原因与归宿（需用户提供、后续包、外部条件）。

<!-- G0 基线 -->

## G0-1 文档修正与进度载体

未开始。

## G0-2 共享层与页面骨架

未开始。

## G0-3 core 骨架与契约节占位

未开始。

## G0-4 CI 端到端分档

未开始。

## G0-5 hook-client 抽取与动词表生成

未开始。

## G0-6 设计系统 token 与基础件（WP-D1）

未开始。

## G0-7 本地 dev-stack（W-DEVSTACK）

未开始。

## G0-8 密钥后端按平台补齐（W-SECRETS）

未开始。

<!-- G1 各域 core 与第一部分遗留 -->

## G1-1 节点凭据（多账号第二阶段）

未开始。

## G1-2 跨主机交接与 Worker 舰队

未开始。

## G1-3 画面门补齐与计划投递接门

未开始。

## G1-4 ACP 传输与适配器表（A1）

做了什么：

- `core/acp/types.ts` 只再导出 `@armadra/agent/acp`（0.6.2）的协议类型；`client.ts` 的 `AcpProcess` 包装 `AcpClient`：不经 shell 起进程、unix 自成进程组（Windows `taskkill /T`）、stderr 64 KiB 尾巴脱敏、退出对账（`exited.requested` 区分自己要它退的）、`request_permission` 挂起表（`answerPermission` 只认 Agent 的 `optionId`，`cancel` / 断开 / 退出一律回 `cancelled`）。
- `adapters.ts` 七行表（claude / codex / opencode / pi / omp / copilot / ama）与 `acpLaunchPlan`（权限模式 → `modeId` / argv，没有落点答 `acp_mode_unsupported`）。
- `host.ts`：`startAcp` / `startAdapter`（`initialize` 带截止时间、按表偏好与声明能力选 `load` / `resume`、接不上如实新开、`session/load` 回放标 `replay`、`set_mode`，`plan` 找不到模式拒绝启动）、`probeAcp`、`rememberedAcpVersion`。
- `GET /api/agents` 行加 `acp`（契约 §14.1）；状态来源加 `acp`（`registry.ts`、`target-state.ts`、`hook/store.ts`）；`tools/release/compatibility.json` 加 `acp` 键（不进围栏）。

实测：`client.test`（8）、`host.test`（18）、`adapters.test`（9）、`list.test`（+2）、`hook/store.test`（2）对 `fakeAcpAgentPath()` 真子进程含 `--minimal`；`pnpm libs:build && pnpm -r --if-present test` 全绿（desktop 3558 通过），`pnpm check`、`pnpm release:test`（79）通过。

没做：会话、桥、归一化、镜像、路由与 `install` 装配（G2-1）；`mcpServers` 注入——`AcpClient.newSession/loadSession/resumeSession` 固定发 `mcpServers: []`，G1-5 / G2-1 要在 `@armadra/agent` 加参数或另想办法；各家真适配器的版本区间与 Copilot 旗标、Claude / Codex 的 `sessionId: same` 待真跑（G3-7）。

## G1-5 `armadra-hook mcp`（A3）

未开始。

## G1-6 ACP 会话视图页面（W1）

未开始。

## G1-7 `ama` 第七个内置 Agent 与宿主适配器（C1）

未开始。

## G1-8 工作流引擎（C2）

未开始。

## G1-9 实时协同 core（R0）

未开始。

## G1-10 Gateway core 下沉（G0）

做了什么：

- `apps/server/src/{auth,tls,csp,web-root,der}.ts` 连同测试搬进 `apps/desktop/src/core/gateway/`（`auth.ts` 改名 `admission.ts`），`serve.ts` 的 TLS 装配抽成 `listener.ts` 的 `openGateway(core, options)`；服务器壳的 `serve` 变成「解析参数 → `openGateway` → `adopt`」，行为不变（原有用例全过）。页面 CSP 的本体从 `shell-core/csp.ts` 移进 `core/gateway/csp.ts`，壳原样再导出。
- 本地 CA（用户选定，架构 §14 Q3）：`<数据目录>/tls/ca.{crt,key}`（私钥 0600、十年、pathLen 0）签叶证书（397 天、SAN = 主机名 + 当前私网地址 + 回环）；地址多出一个或剩 30 天就重签叶证书，CA 不变；CA 与私钥对不上时拒绝而不是悄悄换。三种来源：本地 CA / 指定文件 / 服务器壳的自签名；ACME 报 `acme_unavailable`（G3-5）。
- 设置驱动：`gateway.*` 整段进 `LOCAL_PATHS`；`install` 时按设置开启，`GET/PUT /api/gateway`、`POST /api/gateway/pairing`（契约 §17）；端口 0 开启后写回；`private` 档绑 `0.0.0.0` 按连接本地地址只收回环与私网，30 秒复查地址；关掉即断开经它进来的连接（含升级过的流）。服务器壳上 `/api/gateway` 报 `managedBy: "shell"`，`PUT` 409。
- 准入：Cookie 模式照旧；新增原生 App 的 Bearer 模式（`capacitor://localhost` / `https://localhost`，会话绑 Gateway 来源，密钥走响应体、不发 Cookie，CORS 只回 App 来源）与 `POST /api/identity/ws-ticket`（30 秒一次性，`Sec-WebSocket-Protocol: armadra-ticket.<票>`）。`GET /ca.crt` 匿名。
- 配对载荷：`webUrl = …/#pair=<票>&fp=<指纹>`、`deepLink = armadra://pair?host=…&ticket=…&fp=…`，`fp` 是信任锚指纹（本地 CA 时是 CA）；页面的 `#pair=` 解析认带 `&fp=` 的形式。`packages/shared/src/api/gateway.ts` 填了 zod。

实测（2026-10-03，macOS）：

- `core/gateway/*.test.ts` 全过，其中 `gateway.integration.test.ts` 真起 core 走完：PUT 打开 → 只信 `/ca.crt` 的客户端完整验证链 → 配对成 owner → 成员读共享画布、改 Gateway 403 → Bearer 配对/调用/预检 → ws-ticket 升级与重放 401 → 指定文件来源 → 关掉即断流、重开 CA 与端口不变。`apps/server` 全部用例不改断言通过。
- `node tools/probes/gateway-e2e.mjs`（A 档，需 `pnpm --filter @armadra/desktop build`）通过；`ARMADRA_DEV_STACK=1` 且 dev-stack 的 step-ca 在跑时，「指定文件」一段用 step-ca 中间 CA 签的链验证 `fp` 是叶证书指纹、`/ca.crt` 发链里最后一张、只信 step-ca 根的客户端验得过。

没做：

- 设置页与二维码（G2-7）；ACME（G3-5）。
- 只在回环上实测过监听；`private` / `all` 两档的绑定与筛选只有单元用例（用例不许监听非回环接口）。真手机装 CA、iOS `wss` 与原生 App 的钉证书要真机（U6 / G2-10）。
- 打包后的桌面壳里 Gateway 按 `../renderer` 找页面产物，没在打包产物里验证过（asar 内的路径）；找不到时只服务 API。
- `tools/ci/e2e.json` 还没合入（G0-4），`gateway-e2e` 一行等它合入后追加。

## G1-11 身份加固一：口令策略、限流锁定、passkey、TOTP（I1）

**做了什么**

- 迁移 `identity_hardening`（分支上编号取 main 当时最大号 +1，合入时按协调者的顺序改号）：`identity_credentials` 加 `sign_count / aaguid / transports_json / label` 与「一把 passkey 只属于一个人」的唯一索引；新表 `identity_mfa`（多一列 `last_time_step` 做重放防护）、`identity_recovery_codes`（同批共用盐）、`identity_lockouts`；`identity_sessions` 加 `last_seen_at_ms / remote_ip / user_agent`。`db/absorb-host.ts` 改成只搬新旧两边都有的列。
- `identity/policy.ts`：长度（10–64 可配，缺省 12）、不含账号名、随包常见口令表 `common-passwords.txt`（1 万条，按常见词根 × 前后缀 × 键盘序列规则生成，只收长度 ≥ 10 的）；泄露检查调用点 `checkBreach` 恒为 `skipped`，G3-8 填。表以 `?raw` 内联，服务器壳的 esbuild 加了同名插件。
- `identity/throttle.ts`：按来源 IP 的内存令牌桶 20 次 / 分钟；按 principal 5 次失败起锁 1 分钟、翻倍封顶 15 分钟，不看账号是否存在。
- `identity/passkey.ts`：`@simplewebauthn/server` 14.0.3 做全部校验；RP ID 选取（覆盖 / 公网来源公共后缀 / 请求来源，IP 主机答 `passkey_unavailable_on_ip_host`）、内存挑战 2 分钟一次性、可发现凭据登录与 `userHandle` 核对。
- `identity/mfa/`：TOTP（`otplib` 13.5.0，密钥在 SecretStore `armadra-totp-<id>`）、恢复码（scrypt）、两步登录中间票。
- 路由（`accounts-http.ts`）：`passkey/*` 四条做实加列表与删除，`login` 两步与 `mfa/*`，`sessions*`，`lockouts*`；审计动作表 `SECURITY_AUDIT_ACTIONS`。共享层 zod 与契约 §18.1–§18.4。
- 依赖：`pnpm-workspace.yaml` 加 `overrides` 把 `@peculiar/asn1-schema` 统一到 2.10.0——两份并存时 ES256 断言一律校验失败（`ECDSASigValue` 登记在另一份实例里）。

**实测**

- 软件认证器（`soft-authenticator.fixture.ts`）与真 Chromium 的 CDP 虚拟认证器（`passkey-cdp.live.integration.test.ts`，跑在 `vitest.live.config.mts`）注册 → 登录都过；`origin` / `challenge` / RP ID 不对、计数器回退、挑战重放即拒。
- RFC 6238 SHA-1 向量、重放拒绝；`security-http.test.ts` 走真 HTTP 覆盖策略、锁定、两步登录、恢复码、passkey、会话列表；`accounts.integration.test.ts` 在整个 core 上跑两步登录。
- 服务器壳 esbuild 产物与桌面 electron-vite 产物里都内联了口令表，CJS 打包后 passkey 与 TOTP 照常工作。

**没做**

- 泄露检查（HIBP）：G3-8。安全页、登录页的两步与 passkey 按钮：G2-8。OAuth：G1-12。
- 策略要求 MFA 而本人未登记时不拦登录，只在会话里带 `mfaEnrollmentRequired: true`，由 G2-8 的页面把人带去登记。
- 需用户提供：稳定域名（passkey 的 RP ID，外部服务 §7.2）；没有时以 IP 访问如实不可用，`https://localhost` 与虚拟认证器可完整验证。

## G1-12 OAuth / OIDC / SSO（I2）

**做了什么**

- `core/identity/oauth/`：`providers.ts`（通用 OIDC：发现文档与 issuer 逐字节核对、JWKS 验签只收 RS256 / ES256、`iss` / `aud` / `azp` / 时效 / `nonce`、缺邮箱补 userinfo；GitHub 特例：`/user` 与 `/user/emails`）、`flow.ts`（`state` 内存 10 分钟取出即删、PKCE S256、浏览器绑定 Cookie 防登录 CSRF；绑定 / 登录 / 建号的决定；登记过 TOTP 的人跳回 `#oauth=mfa&challengeId=` 接 §18.3 的第二步）、`http.ts`（`providers`、`providers/{id}/secret`、`{id}/start`、`{id}/callback`、`bindings`、`{id}/logout`）、`index.ts`（挂原样前缀 `/api/identity/oauth/`；公网来源 = `gateway.publicOrigin` + 壳注入的 HTTPS 域名来源）。测试专用：`fake-issuer.ts`（进程内 OIDC + GitHub 假端点，可注入签名 / nonce / aud / 过期 / `alg: none` / issuer 错误）、`harness.fixture.ts`。
- 绑定键按 issuer 派生（`oidc:<sha256 前缀>`、`github`），不用设置里的 `id`；`clientSecret` 在 SecretStore `armadra-oidc-<id>`；不加迁移。
- 共享层 `identity-security.ts` 的 §18.5 小节（拒绝码表 `OAUTH_CODES`、提供方列表、start、绑定、登出）；契约 §18.5。
- 对共享文件的最小改动：`service.ts` 的 `LoginMethod` 加 `"oauth"`；`audit.ts` 的 `SECURITY_AUDIT_ACTIONS` 追加 `identity.oauth.*`；`accounts-store.ts` 加 `liveOAuth(provider, subject)`；`identity/http.ts` 导出 `isSecure` / `sessionCookies`；`identity/index.ts` 把加固实例交给 OAuth；`accounts-http.ts` 退役 `credentials/oauth/*` 的 501；`gateway/admission.ts` 对 `GET /api/identity/oauth/{id}/callback` 放开 Origin 与 `Sec-Fetch-Site`（`oauthCallbackPath`）。分支叠在 G1-11（PR #34）之上，依赖它的 `openSession` 与 MFA。

**实测**

- `oauth.test.ts`（32 条，对进程内假 issuer）：绑定 → 登录同一 principal、未绑定拒绝、`allowSignup` + 白名单建 member（只有 `identity:read`）、GitHub 特例与错误 secret、已绑在别人名下、解绑、TOTP 用户走第二步；`state` 重放（不再换令牌）、绑定 Cookie 伪造、未知 state、`email_verified = false`、域名不在白名单（含子域）、五种 `id_token` 故障、ES256、发现文档 issuer 不符、用户取消、`returnTo` 越界、授权地址参数、SSO 登出地址；源码里的每个拒绝码都在共享层表里。
- `oauth.devstack.integration.test.ts`（`ARMADRA_DEV_STACK=1`，对 `pnpm dev-stack up dex keycloak`，3 条全过）：dex 回环公开客户端 PKCE → 绑定 → 登录、重放拒绝、发现文档无 `end_session_endpoint`；Keycloak `armadra-dev`：建号、`unverified` 用户 `oauth_email_unverified`、SSO 仍在时 authorize 直接跳回、`end_session_endpoint` 登出后再 authorize 出登录页。
- `accounts.integration.test.ts` 起真 core：`oauth/providers` 答 `configured: false`，`oauth/github/start` 答 `oauth_not_configured`；`admission.test.ts` 两条回调放行用例。

**没做**

- 设置页的提供方编辑与绑定区块：G2-8（接口与 zod 已备）。
- dev-stack 用例不在 CI 的默认 vitest 里跑（门控 skipped）；没有加进 `tools/ci/e2e.json`。
- 原生 App（Gateway Bearer 模式）发起答 `oauth_browser_required`：授权页开在系统浏览器里，没有发起时的绑定 Cookie。
- OAuth 登录不受 `identity.mfa.requireFor`「未登记也提示」那条影响；登记过 TOTP 的人照样要第二因素。
- 需用户提供（外部服务 §7.1）：
  - [ ] 稳定的公网来源（`gateway.publicOrigin` 或服务器壳 `--public-origin`），HTTPS 域名。
  - [ ] GitHub：Settings → Developer settings → OAuth Apps 新建，回调填 `<公网来源>/api/identity/oauth/github/callback`，scope 只要 `read:user user:email`；把 client id 填进 `identity.oauth.providers[]`，client secret 经 `PUT /api/identity/oauth/providers/github/secret` 存入。
  - [ ] Google / Microsoft Entra / Keycloak 等：各建一个 OIDC 客户端（授权码 + PKCE），回调同上（`…/oauth/<id>/callback`），scope `openid email profile`；Google 填 issuer `https://accounts.google.com`，Entra 填 `https://login.microsoftonline.com/<tenant>/v2.0`；机密客户端的 secret 同样经 `PUT …/secret` 存入。
  - [ ] 要开放 SSO 建号时：`allowSignup: true` 并填 `allowedDomains`（公司邮箱域名）。

## G1-13 推送 core（PU）

未开始。

## G1-14 设计展示页与截图探针（WP-D2）

未开始。

## G1-15 更新链路修正与通道（W-UPD）

未开始。

## G1-16 出站地址表与用量端点政策（W-OUTBOUND）

未开始。

<!-- G2 页面与语义闭环 -->

## G2-1 ACP 会话语义（A2）

未开始。

## G2-2 输出到画板与普通用户入口（W2 + W3）

未开始。

## G2-3 工作流页面、再运行与定时（C3）

未开始。

## G2-4 `HostApi.runners` 与 `wait` 动词（C4）

未开始。

## G2-5 实时协同页面绑定与在线光标（R1）

未开始。

## G2-6 评论（R2）

未开始。

## G2-7 桌面 Gateway 设置页与配对（G1）

未开始。

## G2-8 安全页面：会话 / 设备、MFA / passkey 管理、审计（I3）

未开始。

## G2-9 Agent 权限角色（RB）

未开始。

## G2-10 移动网页：连接页与手机细节（M1）

未开始。

## G2-11 存量界面套用一：按钮、空态、手机对话框（WP-D3a）

未开始。

<!-- G3 平台线 -->

## G3-1 Capacitor 移动壳

未开始。

## G3-2 Windows 真机验收包

未开始。

## G3-3 签名、公证与自动更新端到端

未开始。

## G3-4 Linux 打包验证与夜间冒烟

未开始。

## G3-5 服务器部署：镜像、公网部署指南、备份升级

未开始。

## G3-6 服务端性能基线与多主机管理页面

未开始。

## G3-7 真 CLI 端到端：场景 11 / 12 与三家 TUI

未开始。

## G3-8 安全收尾：泄露检查、公网加固、安全审查

未开始。

## G3-9 分发渠道与许可证声明（W-DIST + W-NOTICES）

未开始。

## G3-10 可选崩溃上报（W-CRASH）

未开始。

## G3-11 存量界面套用二：对话框与其余页面（WP-D3b）

未开始。

<!-- G4 收口 -->

## G4-1 文档收口

未开始。

## G4-2 启动兼容退役

未开始。

## G4-3 发布演练 0.2.0

未开始。
