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

- 做了什么：`core/workflow/{types,draft,store,dispatch,engine,service,routes,registry,task-runs,index}.ts`；迁移 `0030_workflow.sql`（草案、模板、运行、步骤、runner 任务五张表）；控制动词 `workflow-propose`（工具 `canvas_workflow_propose`）；bus 事件 `workflow.draft` / `workflow.run` / `workflow.gate`（core 与共享层同步）；`packages/shared/src/api/workflows.ts` 的 zod；契约 §15.1–§15.4。运行建 Frame + 起点便签 + 角色节点，节点经依赖编排的启动路径起、提示词经投递队列投，完成判定复用 `dependencies/evaluate.ts`。
- 实测：`core/workflow/*.test.ts`（草案校验、引擎三种步骤、关卡、取消、无页面推进、重启续跑、重投、路由与动词）；`node tools/probes/workflow-e2e.mjs`（真 core + 假 CLI `custom:wfecho` 走通 prompt → collect 两步模板）本机通过。
- 没做：页面（草案卡、模板库、运行记录，G2 的包）；`wait` 动词与 runner 适配（G2-4，`task-runs.ts` 只有存取）；自动化目标（G2-3）；成员访问 `/api/workflows/*` 仍一律 403（按运行查画布的收窄留给 G2-9）；`workflow-e2e` 等 G0-4 的 `tools/ci/e2e.json` 合入后登记进 A 档。

## G1-9 实时协同 core（R0）

未开始。

## G1-10 Gateway core 下沉（G0）

未开始。

## G1-11 身份加固一：口令策略、限流锁定、passkey、TOTP（I1）

未开始。

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
