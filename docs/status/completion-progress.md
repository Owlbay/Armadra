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

**做了什么**（契约 §20）

- core `agent/credentials/`：`kind → 变量名` 封闭表（第一版只开 Claude `oauth-token`、Copilot `github-token`，其余入表 `enabled: false`）；条目表 `agent_credentials`（新迁移，按协调改用 main 最大号 +1），值在 SecretStore `armadra-credential-<ref>`；`/api/credentials` 增删改查，答复只有 `isSet`。
- 起终端：`POST /api/terminals` 的 `agent.credentialRef` 在起进程前校验（`credential_mismatch` / `credential_kind_disabled` / `credential_unsupported_here` / `credential_backend_insecure`）；节点 shell 环境里只有条目名 `ARMADRA_CREDENTIAL_REF`。唤醒、依赖编排、冷启动读节点数据里的绑定。
- 值的通道：POSIX 启动器 `run/<cli>` 在门内调 `armadra-hook credential`，经本机 hook 面 `POST /credential`（节点 token 必须验过）现取，只认这家 CLI 的变量名，在启动器进程里 `export` 后 `exec`；失败或名字不认识时拒绝起 CLI，不退回默认登录。
- 页面：设置 → Agent 的「节点凭据」区块（列表只显示名字与 `Agent · kind`，新建对话框里未启用的种类灰掉标「待实测」，`file` 后端时只显示原因）；节点头 `AccountBindingBadge` 可选可切（默认登录 + 本 CLI 的条目），写进 `agent.account.credentialRef`；`agentSessionRequest` 上行 `credentialRef`；文案在 `i18n/credentials.ts`。
- 密钥后端多一个 `ARMADRA_SECRET_BACKEND=file-encrypted`（探针用，不碰钥匙串）。

**实测**

- `credentials.test.ts`（17）：映射表封闭、路由只回 `isSet`、库里无值、`file` 后端 / Windows 拒绝、启动前各拒绝码、兑换只认绑定（含 core 重启后读节点数据）、日志无值、hook 面 token 校验、POSIX 启动器的凭据段（设值、无门不问、客户端失败或变量名不认识时拒绝）。
- 页面：`AccountBindingBadge.test`（5）、`AgentCredentials.test`（3）、`launch.test` 的上行用例。
- A 档 `node tools/probes/credentials-e2e.mjs`：15 步全过（CLI 看到的长度正确、节点 shell `env` 里计数为 0、值不在画面 / 日志 / 答复、不匹配被拒、删条目后重跑启动器拒绝）。

**没做 / 需用户提供**

- T1–T9（CLI 协作 §7.4，计划 §5 U1、U5）需要真实账号，按下面的清单做：
  1. T1：两个 Claude 订阅（A 已 `/login`，B 用 `claude setup-token`）。设置 → Agent 加 B 的 `oauth-token`，在 Claude 节点头选它、重启终端；`/status` 应显示 B；前后对 `~/.claude.json` 与凭据文件做字节指纹，应不变。
  2. T2：可丢弃的 Claude 测试账号，验刷新令牌是否轮换（不影响本包开关）。
  3. T3：两个带 Copilot 的 GitHub 账号与 B 的细粒度 PAT（Copilot Requests）。加 `github-token`、Copilot 节点选它；`/user show` 应是 B，`config.json` 的 `lastLoggedInUser` 不变。
  4. T4–T7：Codex / Pi / OMP / OpenCode 的 API key 与已登录状态，按 §7.4 验优先级；通过一项就把 `inject.ts::CREDENTIAL_KINDS` 里对应行改 `enabled: true` 并同步契约 §20.1。
  5. T8：任一凭据，在节点里让模型执行 `env | grep -c <变量名>`，记录计数（预期 1：CLI 的子进程继承，设置页脚注已说明）。
  6. T9：Windows 机器。当前 Windows 一律 `credential_unsupported_here`：C# 启动器 `armadra-launch.exe` 还没有兑换段，要补上并在真机验证后才能开放（与计划「Windows 开放」不同，见下）。
- 偏离计划：Windows 未开放（启动器缺兑换段，本机无法编译验证 C#）；计划写「Windows 与 Linux 都开放」，Linux 已开放（`libsecret` 后端）。
- 设计展示页样本：展示页由 G1-14 建，凭据区块与账号标记的样本待其分区就位后补。

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
