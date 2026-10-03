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

未开始。

## G1-12 OAuth / OIDC / SSO（I2）

未开始。

## G1-13 推送 core（PU）

**做了什么**

- `core/push/`：设备登记（挂在身份设备上，覆盖式；原生 App 上交 X25519 公钥）、发送队列（先入队再发，总共最多 3 次尝试，令牌作废即撤销设备，终态留 7 天）、触发规则（`agent.approval` / `agent.status` 进入完成或出错 / `agent.delivery` 失败与回执 / `schedule.*` / `resources.threshold` / `board.comment` 提及 / `workflow.gate`，收件人按 `canvas:read` 过滤，正文按种类与设备语言写死、不读事件内容）、三条传输（Web Push：VAPID 密钥对生成到 `<数据目录>/push/vapid.json` 0600、RFC 8291；`direct`：APNs HTTP/2 ES256、FCM v1 RS256 换令牌；`relay`：只发端到端信封）与未配置时的 `log`。配置由设置 `push.*` 与 `ARMADRA_PUSH_*` 环境变量合成，密钥只给文件路径，两个路径进本机设置（`LOCAL_PATHS`）。
- `/api/push/{config,devices,devices/{deviceId},test}`，契约 §19；共享层 `api/push.ts` 的 zod；`apps/web/src/push/service-worker.ts`（订阅与 worker 处理）。
- `apps/push-relay`（`@armadra/push-relay`）：无状态中继，中继令牌即用中继的钥封起来的平台令牌，只收信封，复用 core 的 APNs / FCM 客户端。**按 §14 Q6 只写完、不部署。**
- 迁移 `0030_push.sql`（分支上取 main 最大号 +1，合入时按协调改号）。

**实测**

- 单测：`core/push/*.test.ts` 5 个文件 44 条（`crypto` 设备私钥能解 / 别的钥与改字节解不开；`triggers` 每种事件一条、无 `canvas:read` 收不到、明文无终端原文；`transport-direct` 对进程内 push-sink 验 APNs ES256 签名、FCM RS256 断言、作废撤销、网络失败重试封顶 3 次；`transport-relay`；`routes`）；`apps/push-relay` 9 条（core → 中继 → 假 APNs / FCM 整条线）；`apps/web/src/push` 6 条。
- `pnpm libs:build && pnpm -r --if-present test` 全绿（desktop 3563、web 2912、server 89、shared 298、push-relay 9）；`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。
- A 档探针 `node tools/probes/push-e2e.mjs`：服务器壳 → push-sink 走 iOS 直连（权限请求与 Stop 各一条，ES256 验签、信封可解、明文与线上都没有夹带的终端原文）、Android 直连、Web Push（VAPID 由 sink 验签）、中继四条线，进程内 sink 与 `pnpm dev-stack up push-sink` 的容器各跑一次均通过（容器里 APNs 签名记 `unchecked`，见探针说明）。

**没做**

- 中继不部署、不运营（用户决定）；真 APNs / FCM、真机收推送要发布方的 `.p8`、Firebase 服务账号与运行中继的主机（计划 §5 U8–U10）。
- `schedule.*`、`resources.threshold`、`board.comment`、`workflow.gate` 四种事件今天没有域在发：规则已按契约 §19.6 的字段写好、用例用合成事件覆盖，由调度 / 资源 / G1-9 / G1-8 各自发布时接上。「用户关注的节点」这一层过滤没有数据来源，现在发给全部有 `canvas:read` 的人。
- worker 产物挂到站点根、权限提示与入口归 G2-10；推送设置页区块（「后台服务 → 推送」）的界面归设置页的包，本包只用 G0-3 已建的键。UnifiedPush（ntfy）未做。
- A 档清单 `tools/ci/e2e.json` 由 G0-4 建，合入后追加 `push-e2e` 一行。

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
