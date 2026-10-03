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

未开始。

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

未开始。

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

未开始。

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
