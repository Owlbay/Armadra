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

做了什么：

- 共享层 `api/acp.ts` 按 ACP 设计 §9.2 填 §14.2–§14.4 的 zod：起会话 / prompt / mode / 驱动切换的请求与答复、`GET …/log`（`entries` 是归一化 `TranscriptEntry`，另带可选 `modes` 与 `pending`，重载能画出模式选择与待答卡）、`acp.update` / `acp.turn`（可带 `error`）/ `acp.driver` 三个事件（并进 `workspaceEventSchema`）、`agent.approval` 里的 ACP 载荷；`answerApprovalRequestSchema.optionId`、答复 `route: "acp"`、会话列表行的 `backend`。线上对象一律 `looseObject`，未知的工具 kind / status 落为缺省。
- 页面 `apps/web/src/acp/`：`store`（纯函数归约：分块按回合合并、工具调用按 id 原地更新、回合边界、回显去重、镜像重建）、`SessionView`（没有会话就 `POST /api/acp/sessions` 并把 id 写回节点数据、先订阅再读镜像、读回之前到的分块丢弃、空 / 加载 / 错误 / 离线四态、单张待答卡固定在输入框上方）、`MessageList`、`ToolCallRow`、`DiffBlock`（复用 `PatchBody` 与 `unifiedLineDiff`，工作区内文件可「打开」）、`PermissionCard`（allow / reject 两组，先收起再答）、`PromptBox`（Enter / Shift+Enter、组字不发、聚焦拿人类租约、失焦与提交交还、回合中变停止、Esc 停止）、`driver.ts`。
- `TerminalNode` 按 `data.agent.driver === "acp"` 选节点体（`SessionView` 按需加载，换驱动 120ms 淡入）；头部 `⋯` 与右键菜单加「会话视图 / 终端视图」，当前项打钩，没有 ACP 入口的 Agent 不出现；侧栏会话行 `backend: "acp"` 徽标；`i18n/acp.ts` 中英同步。`StateSourceBadge` 的 `acp` 已由 G1-4 加好，未改。

实测：`store.test`（10）、`SessionView.test`（9）、`PermissionCard.test`（3）、`PromptBox.test`（8）、`DiffBlock.test`（3）、`TerminalNode.test`（4）、`terminal-menu.test`（+2）、`SessionsSection.test`（+1）、shared `api-acp.test`（5）；`pnpm libs:build && pnpm -r --if-present test` 全绿（web 2946、desktop 3558、server 89、shared 303），web / desktop / server typecheck 与 `pnpm check` 通过。

没做：core 的 `/api/acp/*` 路由、事件与镜像（G2-1，形状照本包的 zod）；契约 §14.2–§14.4 正文（G2-1 写，会话列表 `backend` 一并写）；`agent.driver` 缺省时页面按终端画，不读 `agents.defaultDriver`（core 起会话时写明驱动，G2-2 的向导同）；设计展示页（G1-14）未建，没有加展示段；没有用 msw，假 core 是 `vi.mock("./api")`。

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
