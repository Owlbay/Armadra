# ACP 接入与会话视图（后续规划第二部分）

> 状态：部分实施（2026-10-04）。已实施：传输与适配器表、会话语义（ACP 作为终端管理器的一个后端）、会话视图、驱动切换、`armadra-hook mcp` 注入、输出到画板、新建向导与简洁模式（[补全进度](../status/completion-progress.md) G1-4、G1-5、G1-6、G2-1、G2-2，契约 §14）。未实施：`elicitation/create`、按模型选择、`pi-acp` 映射文件、ACP 下的节点凭据与 ama 密钥兑换、SSH 节点切 ACP；六家真适配器的真跑与版本区间（C 档场景 12 探针与运行手册已由 G3-7 备好，待用户真跑）。对应[后续规划](product-roadmap.md)第二部分「ACP 接入与会话视图」。现状以[功能预期总表](../status/feature-roadmap.md)与源码为准。
> 修订（2026-10-03，以 [补全架构](completion-architecture.md) §4、§5.1 为准，正文保留原文）：契约节改 **§14**（§13 已被[画布启动器](canvas-launcher.md)占用），正文的「契约 §13.x」读作 §14.x，工作流节是 §15；协议栈改为依赖 `@armadra/agent/acp`（`core/acp/client.ts` 包装它的 `AcpClient`，单测用 `fakeAcpAgentPath()`），不再手写 `types.ts`、不需要 `core/acp/testing/fake-agent.mjs`；适配器表的 ama 一行按 `@armadra/agent` 0.6.2 定稿（`ama --mode acp --profile <path>`，`sessionId: "same"`，`resume: "resume"`，画布工具经 profile 的 `host` 适配器提供、不加 MCP），D12 / Q4 已结；0031 不再为 ACP 预留。
> 范围：`apps/desktop/src/core/{acp,agent,hook,collab,terminal,history}`、`apps/desktop/src/cli/armadra-hook`、`apps/web/src/{acp,nodes,agent,canvas,i18n}`、`packages/shared/src`、`tools/probes/agent-e2e`。
> 前置：[CLI 接入、通信与共享上下文](cli-collaboration.md)（第一部分，本地历史适配器与 `TranscriptEntry`）、[Agent 推式投递](agent-delivery.md)（五态、`send`、租约）、[画布内注入](canvas-only-integration.md)、[原生白板参考](../guides/native-whiteboard-references.md)、[协调 Agent](coordinator-agent.md)（第三部分，另一会话在做；本文只引用、不改它的文件）。
> 设计约束：v3 曾整体移除 ACP 通道（[v3 契约](../contracts/v3-agent-terminal-plan.md) §5.10），原因是两套 Agent 通道让状态、权限和会话侧栏出现两种语义。本文的全部设计围绕一条：**ACP 只是同一个 Agent 节点的另一种驱动方式**，状态五态、审批、连线上下文、`send` 投递、会话侧栏仍走同一套 core 语义，没有第二套。

## §0 结论

| #   | 决定                                                                                                                                                                                                                                                                                                                 | 理由                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | ACP 会话是 **`terminal_sessions` 里的一行**（`backend_kind = 'acp'`），节点数据多一个 `agent.driver: "terminal" \| "acp"`；不新建会话表、不新增节点类型                                                                                                                                                              | `loadSession`、五态的 `live`、会话侧栏、休眠、依赖编排、审批的会话校验全部以这张表为键（§4.1）；第二张表就是第二套语义                                                                               |
| D2  | 一个节点同一时刻只有**一个驱动**。切换 = 结束当前驱动的进程，再用 CLI 自己的会话 id 在另一种驱动下 **resume**；做不到跨进程 resume 的 CLI（Copilot、pi-acp 的部分情况）切换等于开新会话，界面明说                                                                                                                    | 同一个 CLI 进程不能同时被 PTY 和 ACP 驱动；休眠已经证明「结束进程 + resume」是可靠的接回路径（§4.2）                                                                                                 |
| D3  | ACP 流是第四种状态来源 `stateSource = "acp"`，`core/acp/normalize.ts`（`hook/normalize/index.ts` 的 `case "acp"` 转过去）把 `session/prompt`、`session/update`、`session/request_permission` 归一成现有 `AgentEvent`，经 `hook/ingest.ts::apply` 走同一个 reducer、同一张 `agent_status`、同一条 `agent.status` 事件 | ACP 模式下不依赖命令 Hook：`claude-agent-acp` 经 SDK 起 `claude`，`--settings` 那条注入路不可用；而 ACP 流本身就是权威上报（§5.4）                                                                   |
| D4  | 审批走现有 `agent_approvals` 与 `POST /api/approvals/{id}/answer`，`ApprovalRoute` 加 `"acp"`：答复落到挂起的 `session/request_permission` 上；选项（`allow_once` 等）原样存进 `request_json`                                                                                                                        | 节点头部直答、跨设备 CAS、审计表都不动；ACP 只是多了一条「把决定送回去」的路（§5.5）                                                                                                                 |
| D5  | `send` / 收件箱唤醒 / 依赖编排的第一条任务在 ACP 模式下落为一次 `session/prompt`；`interrupt` 落为 `session/cancel`。实现是 `TerminalBridge` 的 ACP 版（`core/acp/bridge.ts`），门链、队列、租约、回执一行不改                                                                                                       | 投递协议的全部语义在 `collab/control/send.ts` 的门链里，不在「怎么写进去」里（§5.6）                                                                                                                 |
| D6  | 画布规则与协作动词在 ACP 模式下经 **`session/new` 的 `mcpServers` 参数**注入：core 起一个 `armadra-hook mcp --node <id>` 的 stdio MCP 服务，工具表从 `collab/control/index.ts::VERBS` 与 `context-link.ts::VERBS` 生成，画布说明放 MCP `instructions`                                                                | 六家 ACP 入口的启动参数各不相同，`--settings` / `--extension` 这类终端模式的注入在 ACP 下只有一半可用；`mcpServers` 是 ACP 规范保证的唯一统一入口（§5.8）。待拍板，见 §12 Q2                         |
| D7  | 转录来源：有本地历史适配器且 ACP 会话 id 与 CLI 自己的会话 id 对得上的，照旧经 `core/history/`；对不上的（Copilot）读 core 自己写的镜像 `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`（归一化 `TranscriptEntry` 行）                                                                                               | 连线读取、摘要、交接、自动命名都吃 `TranscriptEntry`，镜像只是多一个来源，不改读取方（§5.7）                                                                                                         |
| D8  | 会话视图是终端节点的另一种**节点体**（`AcpSessionView`），头部、徽标、菜单与终端视图共用；只用现有 shadcn 组件                                                                                                                                                                                                       | 节点就是那一个节点，换的只是身体（§6）                                                                                                                                                               |
| D9  | 「输出到画板」在页面侧做：便签、白板文字、编辑器节点、Mermaid 四条路都经现有 `canvas-store` 动作与白板 `addItems`；产物带 `source { nodeId, sessionId, messageId }` 并自动与来源节点连线                                                                                                                             | 不新增 control 动词、不新增对象类型，Mermaid 复用 [画板导入 Mermaid 图](mermaid-import.md)（§7）                                                                                                     |
| D10 | 普通用户入口最小范围：新建向导（Agent → 目录 → 任务模板）、`agents.defaultDriver` 缺省 `acp`、本机偏好 `ui.simpleMode` 隐藏终端细节；模板第一版内置在代码里，不入库                                                                                                                                                  | 入口是 ACP 的用户面，范围先收到「不开终端也能用」（§8）                                                                                                                                              |
| D11 | ACP 适配器（`claude-agent-acp`、`codex-acp`、`pi-acp`）第一版**不随包打包**，由用户自己 `npm i -g`，集成页探测版本并给命令；`tools/release/compatibility.json` 记已验证版本                                                                                                                                          | 三个包都带各自 CLI 的 SDK 或二进制，体积与版本锁定问题和 ama 的 D6 一样大；先把协议跑通（§12 Q1）                                                                                                    |
| D12 | 自研 `ama` 建议在它自己的仓库实现原生 `--mode acp`（与 RPC 同形），第三部分 B4「RPC 子进程形态」改为「ACP 形态」；本仓库不写 ama 专用适配器                                                                                                                                                                          | 文档 A 的 RPC 已有 `permission_request` / `permission_resolved` 与 `hello{protocolVersion}` 的骨架，加一层 ACP 外壳比在 Armadra 里再养一套 RPC 客户端便宜，也让 ama 直接能进 Zed / JetBrains（§3.3） |
| D13 | 验收门槛：`agent-e2e` 新增场景 12「六家 ACP」，每家两轮「回复 OK」，Claude 用真实配置目录但前后做字节指纹与 `permissions.defaultMode` 比对，其余五家在临时 HOME；ACP 驱动**从不**自动回答 `elicitation/create`                                                                                                       | 第一部分真跑时 Claude 的启动对话框被一次投递答掉、改了用户配置（`agent-e2e/lib.mjs::claudeDefaultMode`）；ACP 模式没有 TUI 对话框，但指纹守门照做（§11）                                             |
| D14 | 不需要新迁移；预留 **0031**（0030 已被第三部分预留给 `workflow`），合入时以当时最大号 +1 为准。契约新开 **§13**（第三部分的 workflow 节请用 §14）                                                                                                                                                                    | 驱动方式、来源链接、模板都落在节点数据 / 白板 JSON / 设置里；会话行复用现有表（§9）                                                                                                                  |

## §1 规划条目与现状对照

| 规划条目     | 现状（源码）                                                                                                                                                                                                                                                | 本部分要做                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 能力核实     | 没有任何 ACP 代码；v3 删掉的 `acp.rs` / `AcpSurface.tsx` 不可复用（分进程时代）。`packages/shared/src/agents.ts` 的注册表没有 ACP 字段                                                                                                                      | §3 的六家核实结论落成 `core/acp/adapters.ts` 与 `/api/agents` 行的 `acp` 字段 |
| 会话视图     | 终端节点体只有 `TerminalSurface`（xterm）；节点头部的状态胶囊、审批允许 / 拒绝、各徽标都读 `agent/status-store`，与节点体无关                                                                                                                               | §6：第二种节点体，头部不动                                                    |
| 两种视图切换 | 休眠已经实现「结束进程 → 同一会话 id 上起下一代 → 敲 resume 行」（`terminal/hibernator.ts::resumeLine`、契约 §11）；`agent_status.session_id` 记着 CLI 自己的会话 id                                                                                        | §4.2：切换复用这条路，只是另一端起的是 ACP 适配器而不是 shell                 |
| 输出到画板   | `canvas sticky` 动词、`addNode("editor", …)`、白板 `addItems`、Mermaid 导入对话框都在；没有「从一段回复出发」的入口，也没有来源链接                                                                                                                         | §7                                                                            |
| 普通用户入口 | 新建菜单（`canvas/menus/add-menu.ts`）直接建节点并敲启动行；没有向导、没有模板；终端细节（权限模式、回收、租约徽标）都在节点菜单里                                                                                                                          | §8                                                                            |
| 状态与审批   | `hook/normalize/*` 六家归一成 `working / waiting / blocked / done`，`hook/reduce.ts` 五条时序规矩，`agent/target-state.ts` 投影五态；审批只有 Claude 能经 Hook 等答复（`hook/approvals.ts`），其余靠往 PTY 敲 `y` / `n`（`agent/approvals.ts::answerKeys`） | §5.4–§5.5：ACP 是六家都能等答复的通道                                         |
| 投递         | `send` 门链七步、队列、租约、回执齐全；写入原语是 `TerminalBridge.writeSubmit`（括号粘贴 + `\r`）                                                                                                                                                           | §5.6：同一个接口的 ACP 实现                                                   |
| 上下文读取   | `context summary / transcript / terminal` 经 `core/history/` 定位与归一化读取；`terminal` 动词读 `bridge.capture`                                                                                                                                           | §5.7：ACP 会话的三样东西各有落点                                              |
| 节能休眠     | `hibernate.ts` 判据 + `hibernator.ts` 执行，阻塞条件里有 `noResume` / `noProviderSession`                                                                                                                                                                   | §5.3：ACP 会话同一套判据，适配器不能跨进程 `session/load` 的记 `noResume`     |

## §2 ACP 规范要点（2026-10-02 核对）

出处：[协议总览](https://agentclientprotocol.com/protocol/overview)、[初始化](https://agentclientprotocol.com/protocol/initialization)、[会话建立](https://agentclientprotocol.com/protocol/session-setup)、[提示回合](https://agentclientprotocol.com/protocol/prompt-turn)、[工具调用](https://agentclientprotocol.com/protocol/tool-calls)、[文件系统](https://agentclientprotocol.com/protocol/file-system)、[终端](https://agentclientprotocol.com/protocol/terminals)、[v1 schema](https://agentclientprotocol.com/protocol/v1/schema)。当前稳定线是 **protocolVersion 1**（整数，`initialize` 协商）；v2 草案里的 `session/close`、`session/delete` 等本文不依赖。

| 项         | 规范                                                                                                                                                                                                                                                                                                                                                                                         | 本文怎么用                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 传输       | JSON-RPC 2.0，客户端起 Agent 子进程，stdin / stdout 走 NDJSON；路径一律绝对路径，行号从 1 起                                                                                                                                                                                                                                                                                                 | `core/acp/client.ts` 只做这一层：按 `\n` 切帧（不用 `readline`，它会按 Unicode 行分隔符切），请求 id 自增        |
| 生命周期   | `initialize`（`protocolVersion`、`clientCapabilities{fs{readTextFile,writeTextFile},terminal}`，回 `agentCapabilities{loadSession, sessionCapabilities{list,resume,…}, promptCapabilities{image,audio,embeddedContext}, mcpCapabilities}` 与 `authMethods`）→ 可选 `authenticate` → `session/new{cwd, mcpServers[]}` 或 `session/load{sessionId}`（回放历史）/ `session/resume`（不回放）    | 一个节点一个适配器进程、一个会话；`loadSession` 与 `sessionCapabilities.resume` 决定 D2 的切换是 resume 还是新建 |
| 提示回合   | `session/prompt{sessionId, prompt: ContentBlock[]}`，回 `stopReason: end_turn \| max_tokens \| max_turn_requests \| refusal \| cancelled`；期间 Agent 发 `session/update`，`sessionUpdate` 取 `user_message_chunk / agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / plan / available_commands_update / current_mode_update / config_option_update / usage_update` | 回合开始 → `working`（新回合）；`stopReason` → `done`（`cancelled` 记 `interrupted`，`refusal` 记 `errored`）    |
| 工具调用   | `tool_call{toolCallId, title, kind: read/edit/delete/move/search/execute/think/fetch/switch_mode/other, status: pending/in_progress/completed/failed, content[], locations[], rawInput/rawOutput}`；`content` 可含 `diff{path, oldText, newText}` 与 `terminal{terminalId}`                                                                                                                  | 会话视图的工具行与差异块；`status` 变化不改节点状态（仍是 `working`）                                            |
| 权限       | Agent 调 `session/request_permission{sessionId, toolCall, options[{optionId, name, kind: allow_once/allow_always/reject_once/reject_always}]}`，客户端回 `outcome: {selected, optionId}` 或 `cancelled`；回合被取消时客户端**必须**回 `cancelled`                                                                                                                                            | D4：请求挂起 → `blocked`；答复经现有审批路由；`session/cancel` 时统一回 `cancelled`                              |
| 取消       | 客户端发通知 `session/cancel{sessionId}`；Agent 尽快停止并以 `cancelled` 结束回合；取消后仍可能收到最后几条 `tool_call_update`                                                                                                                                                                                                                                                               | `interrupt` 动词与节点头「打断这一轮」                                                                           |
| 文件与终端 | 客户端可选实现 `fs/read_text_file` / `fs/write_text_file` 与 `terminal/create` / `output` / `wait_for_exit` / `kill` / `release`，Agent 只有在 `clientCapabilities` 声明了才会调                                                                                                                                                                                                             | 第一版 **不声明**：文件与终端由 CLI 自己做，与终端模式一致；工具调用的 `diff` 内容仍会到（Agent 侧生成）         |
| 模式与配置 | `session/set_mode{sessionId, modeId}`，`availableModes` 在 `session/new` 响应与 `current_mode_update` 里；`session/set_config_option` 改模型等                                                                                                                                                                                                                                               | 权限模式 → 各适配器的 modeId（§5.2）；模型选择经 `config_option`，不支持的沿用启动参数                           |
| `_meta`    | 保留给扩展，实现**不得**假设其内容                                                                                                                                                                                                                                                                                                                                                           | 适配器的 AIR / `_meta.codex.*` 一律忽略，不进节点状态                                                            |

## §3 六种 CLI 与 ama 的 ACP 支持（2026-10-02 核实）

本机只装了 Codex 0.159.3（`codex --help` 没有 `acp` 子命令，只有 `app-server`，`--listen stdio://`），其余按官方文档、仓库与 npm 页面核实；`claude` / `pi` 在本机 PATH 上不可见，`--help` 未跑。来源标注：**文**＝官方文档，**仓**＝该项目仓库 README / issue，**测**＝要真跑才知道。

### §3.1 对照表

| CLI            | 支持形态                                                                                                                                                                                  | 启动                                                                                                                                                                      | 鉴权                                                                                                                                          | 跨进程 resume 同一会话                                                                                                                                                                                                | 权限模式映射                                                                                                                                                    | 出处                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | **官方适配器**（Zed 维护，`@agentclientprotocol/claude-agent-acp`，旧名 `@zed-industries/claude-code-acp` 已弃用）；`claude` 本体没有 `--acp`                                             | `claude-agent-acp`（npm 全局装）；适配器经 Claude Agent SDK 起 `claude`                                                                                                   | 沿用 Claude Code 自己的登录（`claude /login`）或 `ANTHROPIC_API_KEY`；`CLAUDE_CONFIG_DIR` 可指定配置目录                                      | **可**：`loadSession: true` 且声明 `sessionCapabilities.resume`，`session/load` 读 `~/.claude/projects/**/<id>.jsonl` 回放，`resume` 不回放；ACP sessionId 是否就是 Claude 会话 id：测                                | ACP 模式 `default / acceptEdits / plan / bypassPermissions`，与终端的 `--permission-mode` 同名；模式是提示不是硬门，适配器仍会对每个工具问 `request_permission` | 仓 [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)、[npm 弃用说明](https://www.npmjs.com/package/@zed-industries/claude-code-acp)、[Zed 公告](https://zed.dev/blog/claude-code-via-acp)、[PR #1089](https://github.com/agentclientprotocol/claude-agent-acp/pull/1089)（resume / fork 修复）；模式与 `loadSession` 见 [acpx #747](https://github.com/openclaw/acpx/issues/747) 的核实记录 |
| Codex          | **官方适配器**（ACP 组织维护，`@agentclientprotocol/codex-acp` 1.10.x，Apache-2.0）；本体没有 `acp`，[openai/codex #9085](https://github.com/openai/codex/issues/9085) 已关为 not planned | `codex-acp`（npm 包自带兼容的 `@openai/codex`，`CODEX_PATH` 可换本机二进制）；它起 `codex app-server`                                                                     | 沿用 `$CODEX_HOME/auth.json` 的 ChatGPT 登录（「shared with codex CLI」）或 `CODEX_API_KEY` / `OPENAI_API_KEY`；`NO_BROWSER=1` 关掉浏览器登录 | **可**：2.0.0 起 `session/load` → app-server `thread/resume`，`session/resume`、fork 也有；会话就是 `$CODEX_HOME/sessions` 的 rollout，`codex resume <id>` 认同一个 id：测                                            | 四个 ACP 模式 `read-only / workspace-write / agent / agent-full-access`，`INITIAL_AGENT_MODE` 设初值；对应本仓 `plan / default / auto-edit / full-auto`         | 仓 [codex-acp](https://github.com/agentclientprotocol/codex-acp)、[PR #481](https://github.com/agentclientprotocol/codex-acp/pull/481)、[PR #536](https://github.com/agentclientprotocol/codex-acp/pull/536)；文 [Zed 的 Codex 页](https://zed.dev/acp/agent/codex-cli)                                                                                                                                               |
| OpenCode       | **原生**：`opencode acp`                                                                                                                                                                  | `opencode acp`，协议版本 1，NDJSON over stdio                                                                                                                             | 沿用 `opencode auth login` 存下的提供商凭据（`auth.json`）；画布注入用的 `OPENCODE_CONFIG_DIR` / `OPENCODE_CONFIG_CONTENT` 环境变量照常生效   | **可**：`session/list / load / resume / fork / close` 全有，会话就是 `opencode.db` 里的行（第一部分 H2 已经在读）                                                                                                     | 模式 = agent（`build` / `plan`）经 `session/set_mode`；`auto-edit` / `full-auto` 终端模式也不支持，ACP 同样只有 `default` / `plan`                              | 文 [ACP Support](https://opencode.ai/docs/acp/)、[v2 CLI `acp`](https://opencode.ai/v2/docs/cli/acp/)；已知问题 [#42442](https://github.com/anomalyco/opencode/issues/42442)（`session/load` 响应不带 `sessionId`）                                                                                                                                                                                                   |
| Pi             | **社区适配器** `pi-acp`（已进 ACP 注册表）；上游 [讨论 #4444](https://github.com/earendil-works/pi/discussions/4444) 自 2026-05 起未定，PR #836 曾被拒                                    | `npx pi-acp` / `pi-acp`，它起 `pi --mode rpc`；`PI_ACP_PI_COMMAND` 指定 pi 路径；`--` 之后的参数透传给 pi（`--extension`、`--skill`、`--append-system-prompt` 走这条）    | 沿用 pi 自己的 `auth.json`                                                                                                                    | **可（经映射）**：会话仍在 `~/.pi/agent/sessions/`，适配器用 `~/.pi/pi-acp/session-map.json` 把 ACP sessionId 映射到会话文件；`session/load` 与 `resume` 都有                                                         | 无模式；`terminal/*` 不委托、MCP 参数接受但不接通                                                                                                               | 仓 [pi-acp](https://github.com/leoschwarz/pi-acp)；文 pi 的 `--mode rpc` 说明（[深入 Pi](https://flaviocopes.com/pi/)）                                                                                                                                                                                                                                                                                               |
| Oh My Pi       | **原生**：`omp acp`（`--mode acp` 同义）                                                                                                                                                  | `omp acp`，stdio；`--approval-mode yolo` 等启动旗标照收                                                                                                                   | 沿用 `agent.db` 凭据池 / `/login`；文档明说「只给编辑器内置 Agent 配的凭据不共享」                                                            | **可**：声明 list / load / resume / fork / close；会话就是 `<agent 目录>/sessions/` 的文件                                                                                                                            | `default` / `plan` 经 `session/set_mode`；`write` / `yolo` 走 `--approval-mode` 启动旗标（与终端模式同一张表）；权限选项四种齐全                                | 文 [omp ACP](https://omp.sh/docs/acp)；仓 [oh-my-pi](https://github.com/can1357/oh-my-pi)                                                                                                                                                                                                                                                                                                                             |
| GitHub Copilot | **原生**：`copilot --acp`（2026-01-28 公测）                                                                                                                                              | `copilot --acp --stdio`（缺省）或 `--port`；`--available-tools` / `--excluded-tools` / `--effort` 是服务级旗标；`--plugin-dir` 与 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 照常 | 沿用 GitHub 登录（钥匙串）或 `COPILOT_GITHUB_TOKEN`；BYOK 可无 GitHub 登录                                                                    | **不可（跨进程）**：`loadSession: true` 与 `session/list` 只在同一进程内有效，[#1767](https://github.com/github/copilot-cli/issues/1767) 开着；终端里的会话与 ACP 进程互不可见。`/resume` 等交互式命令在 ACP 下不可用 | 没有文档化的 `session/set_mode`；`--allow-all-tools`（对应 `full-auto`）、`--plan`（对应 `plan`）是否在 `--acp` 下生效：测                                      | 文 [ACP server](https://docs.github.com/en/copilot/reference/acp-server)、[changelog](https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/)；仓 [#936](https://github.com/github/copilot-cli/issues/936)、[#1767](https://github.com/github/copilot-cli/issues/1767)、[#3256](https://github.com/github/copilot-cli/issues/3256)                                             |

归纳：

- 六家都能以 **stdio NDJSON** 被 core 直接起；没有一家需要 PTY。原生三家（OpenCode、OMP、Copilot）与 Codex 的适配器都保留各自的账户与配置目录；Claude 的适配器用 SDK，登录沿用，但终端模式的 `--settings` / `--plugin-dir` / `--append-system-prompt-file` 三条注入在 ACP 下没有对应参数（D6 的由来）。
- **跨进程 resume** 五家可、一家不可。能 resume 的前提是 ACP sessionId 与 CLI 自己的会话 id 的对应关系：OpenCode、OMP 直接相等；Claude、Codex 大概率相等（测）；Pi 要读 `pi-acp` 的映射文件。Copilot 只能在同一进程里 `session/load`，所以它的 ACP 会话必须靠进程常驻，不能休眠（§5.3）。
- **权限模式**没有统一词汇：每家一张 `PermissionMode → modeId / 启动旗标` 的表，放 `core/acp/adapters.ts`（§5.2），与 `packages/shared/src/agents.ts::permissionFlag` 并排，由一条测试守两边覆盖的模式集合相同。

### §3.2 本机可跑的核实（只读）

`codex --help`、`codex app-server --help`、`codex features --help` 跑过：没有 `acp` 子命令，`app-server --listen` 支持 `stdio://` / `unix://` / `ws://`，与 `codex-acp` 的「起 app-server 再翻译」一致。Claude、Pi 在当前 shell 的 PATH 上找不到，实施第一批（A1）时先用 `GET /api/agents` 的 `resolvedPath` 规则（`agent/registry.ts::resolveCommand`，含 Homebrew / mise 补齐）再探一遍，适配器程序名用同一条规则探。

### §3.3 自研 `ama`

文档 A（`armadra-agent/docs/design.md`）通篇没有 ACP。它的 `--mode rpc`（§13.2）是 stdio JSONL，`hello{protocolVersion:1, capabilities:[approvals, images, hooks]}`，命令组里有 prompt / steer / abort、session、approvals（`permission_request{timeoutMs}` → `permission_response{requestId, decision}`，超时自动拒并发 `permission_resolved`）。

建议（D12）：`ama` 加原生 `--mode acp`，与 RPC 同一套引擎、不同外壳——Pi 讨论区和 OMP 都走了这条路。对本仓库的影响只有两处：`core/acp/adapters.ts` 多一行（`ama --mode acp --profile <path>`，`--host` 适配器照常提供画布工具，此时 D6 的 MCP 注入对 ama **不开**，避免两套工具表）；[协调 Agent](coordinator-agent.md) §9 的 B4「RPC 子进程形态」改成「ACP 形态」。先后：等六家跑通之后再做，不阻塞第三部分 B1–B3。这一条要文档 A 的作者拍板（§12 Q4）。

## §4 核心约束：同一节点的两种驱动方式

### §4.1 驱动方式与会话行

```ts
// packages/shared/src/domain/node-data.ts —— terminalAgentSchema 新增
driver: z.enum(["terminal", "acp"]).optional(); // 缺省按 settings.agents.defaultDriver
```

| 概念        | 终端驱动（现状）                                                 | ACP 驱动                                                                                                                    |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 进程        | PTY 里的 shell，shell 里敲启动行                                 | core 直接 `spawn` 适配器 / CLI 的 ACP 入口，stdio 是协议，不开 PTY                                                          |
| 会话行      | `terminal_sessions`（`backend_kind` 为 `tmux` 等）               | 同一张表，`backend_kind = 'acp'`、`shell` = 适配器程序、`command` = 启动 argv、`pid` = 适配器 pid、`generation` 每次重起 +1 |
| 页面附着    | WebSocket 附着 PTY                                               | `POST /api/terminals/{id}/attach` 回 409 `acp_session`；页面订阅 `acp.update` 事件并拉 `GET /api/acp/sessions/{id}/log`     |
| 状态来源    | `hook` / `extension` / `observed`                                | `acp`（`stateSourceIsReported("acp") === true`）                                                                            |
| CLI 会话 id | Hook 报的 `agent_status.session_id`                              | 同一列：`session/new` 响应的 `sessionId`（经 §5.2 的映射规则换成 CLI 自己的 id）                                            |
| 转录        | CLI 自己的文件 / 库，经 `core/history/`                          | 同左；对不上的读镜像（D7）                                                                                                  |
| 写入        | `TerminalBridge.write` / `writeSubmit`（括号粘贴 + `\r`）        | `session/prompt`；`ESC` 单字节写入 → `session/cancel`                                                                       |
| 前台进程门  | `paneRunsAgent`（`expectedProcess`）                             | `foreground()` 回适配器程序名；`expectedProcess` 表加各适配器名（`claude-agent-acp`、`codex-acp`、`pi-acp`）                |
| 休眠        | 敲 `exitCommand` → 进程退出 → `termination_intent = 'hibernate'` | `session/cancel`（若在回合里）→ 杀适配器 → 同一标记；唤醒 = 再起适配器 + `session/load`                                     |

ACP 驱动的节点在画布上**仍是终端节点**：`NODE_TYPES` 不变，侧栏会话行不变，`canvas open-agent` / `team` 建出来的节点按 `settings.agents.defaultDriver` 决定走哪条（Agent 新建的节点同样按缺省，不另给旗标——第一版不让 Agent 选驱动方式）。

### §4.2 切换

切换是节点菜单里的一个动作（「更多 → 会话视图 / 终端视图」），core 路由 `POST /api/acp/nodes/{nodeId}/driver {driver}`：

1. 目标节点在 `awaiting-approval` 时拒绝（409 `awaiting_approval`）：先答完。
2. 结束当前驱动。终端 → ACP 走休眠的收尾（敲 `exitCommand`、等退出、超时 `terminate`）；ACP → 终端走 `session/cancel` + 杀适配器。行以 `termination_intent = 'switch'` 结束（新值，现有 `recycle` / `hibernate` 之外的第三种，TEXT 列不用迁移）。
3. 读 `agent_status.session_id`。有、且目标驱动能 resume（终端：注册表有 `resume`；ACP：适配器表 `resume !== "none"`）→ 带 resume 起下一代；否则起新会话，`acp.driver` 事件里带 `resumed: false`，节点头部 toast 一句「没有接上原会话，已新开」。
4. 起下一代：终端侧就是 `wakeNode` 那条路（`resumeLine`）；ACP 侧是 `core/acp/host.ts::start({ resume })`。`generation` +1，`agent_status` 清状态（`session` 事件的 rule 4），`stateSource` 换。
5. 投递队列里排着的东西不动：出队门链在新驱动下重跑。

同一个节点不会出现两个活会话：第 2 步没完成之前第 4 步不开始，`driveTarget` 在这段时间答 `starting`（`sleeping()` 为真），`send` 排队。

### §4.3 会话 id 与历史适配器对齐

`agent_status.session_id` 永远存 **CLI 自己的会话 id**，这是终端模式、休眠、会话索引、交接都在用的那个值。ACP 侧的对齐规则写在适配器表的 `sessionId` 字段：

| 取值      | 含义                                                                    | 适用                                    |
| --------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `same`    | ACP `sessionId` 就是 CLI 的会话 id                                      | OpenCode、OMP；Claude、Codex 待测后归入 |
| `mapFile` | 读适配器自己的映射文件（只读），取不到就按 `opaque`                     | pi-acp                                  |
| `opaque`  | 对不上；`agent_status.session_id` 存 ACP id，`transcript_path` 指向镜像 | Copilot                                 |

`collab/nodes.ts::historyHint` 不改：`transcriptPath` 有就先认（`history/registry.ts::locateHistory` 的既有规矩），所以 `opaque` 的节点自然落到镜像。

### §4.4 同一套语义在 ACP 下的落点

| 语义            | 现有代码                                            | ACP 下                                                                                       |
| --------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 四态 + 五态     | `hook/reduce.ts`、`agent/target-state.ts`           | 事件来源换成 `core/acp/normalize.ts`，reducer 与投影不改                                     |
| 审批            | `agent_approvals`、`/api/approvals/{id}/answer`     | 多一条送回路（D4）                                                                           |
| 连线上下文      | `collab/context-link.ts`、`core/history/`           | `terminal` 动词读渲染后的消息尾部；`transcript` / `summary` 照旧（D7）                       |
| `send` / 收件箱 | `collab/control/send.ts`、`send-pump.ts`、`wake.ts` | `writeSubmit` → `prompt`（D5）                                                               |
| 会话侧栏        | `agent/sessions.ts` 读 `terminal_sessions` + 状态   | 同一行，多一个 `backend: "acp"` 徽标                                                         |
| 休眠            | `terminal/hibernate.ts`                             | 同一判据（§5.3）                                                                             |
| 依赖编排        | `core/dependencies/`                                | 下游节点没有会话时 `spawnForNode` 按 `driver` 起 ACP 会话，第一条任务照旧经投递队列          |
| 自动命名        | `suggest-title` 读转录                              | 同一入口；ACP 会话首回合结束时触发（`lastEventAt` 已有）                                     |
| 成本            | `core/history/` 的成本来源                          | 同一份文件 / 库；Copilot 的 `usage_update` 不进成本（它是会话累计值，第一部分 §12.1 已单列） |

## §5 core：`core/acp/`

### §5.1 目录

```text
core/acp/
  types.ts       协议类型（只写本文用到的子集，手写，不引 SDK）
  client.ts      JSON-RPC over NDJSON：请求 / 通知 / 挂起的服务端请求（request_permission）
  adapters.ts    六家 + ama 的启动与映射表（§5.2）
  host.ts        进程托管：spawn、initialize、session/new|load、stderr 收集、退出对账
  session.ts     一个节点一个 AcpSession：prompt / cancel / set_mode、挂起的审批、镜像写入
  normalize.ts   ACP 事件 → AgentEvent（归一化放这里，hook/normalize/index.ts 的 case "acp" 转过来）
  bridge.ts      TerminalBridge 的 ACP 实现（write / writeSubmit / capture / foreground / generation / terminate）
  mirror.ts      <data>/acp/<nodeId>/<sessionId>.acp.jsonl 的写与读（TranscriptEntry 行）
  mcp.ts         session/new 的 mcpServers 参数：armadra-hook mcp 的命令、环境与令牌
  routes.ts      /api/acp/*（§9.2）
  index.ts       install(context)：装配、订阅 agent.status / terminal.exit、休眠巡检接入
  testing/fake-agent.mjs  单测用的假 ACP Agent（脚本化 session/update 序列）
```

core 不 import 任何 ACP SDK：协议子集小、NDJSON 一层就够，少一个要锁版本的依赖。

### §5.2 适配器表

```ts
// core/acp/adapters.ts
export interface AcpAdapter {
  readonly agentId: AgentId | "ama";
  /** "native" 原生入口 | "official" 官方适配器 | "community" 社区适配器 */
  readonly support: "native" | "official" | "community";
  readonly program: string; // 在补齐过的 PATH 上找：opencode / omp / copilot / claude-agent-acp / codex-acp / pi-acp
  readonly args: readonly string[]; // ["acp"] / ["--acp", "--stdio"] / []
  readonly sessionId: "same" | "mapFile" | "opaque";
  readonly resume: "load" | "resume" | "none"; // 跨进程接回用哪个方法；none = 新开
  /** PermissionMode → session/set_mode 的 modeId，或启动 argv；两者可同时有 */
  readonly modes: Readonly<
    Record<PermissionMode, { modeId?: string; args?: readonly string[] } | null>
  >;
  /** 画布注入在 ACP 下还能用的那一半（§5.8）：环境变量与透传参数 */
  readonly injection: {
    env?: readonly (readonly [string, string])[];
    args?: readonly string[];
    passthrough?: "--";
  };
  readonly expectedProcess: readonly string[];
}
```

| agentId  | program            | args                             | sessionId  | resume | modes（default / auto-edit / full-auto / plan）                                                        | 注入                                                             |
| -------- | ------------------ | -------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| claude   | `claude-agent-acp` | `[]`                             | same（测） | load   | `default` / `acceptEdits` / `bypassPermissions` / `plan`（都是 modeId）                                | 只有 MCP（D6）；`CLAUDE_CONFIG_DIR` 不设，沿用用户登录           |
| codex    | `codex-acp`        | `[]`                             | same（测） | load   | `workspace-write` / `agent` / `agent-full-access` / `read-only`（modeId；`INITIAL_AGENT_MODE` 设初值） | MCP + `CODEX_CONFIG` JSON 带 `developer_instructions`（测）      |
| opencode | `opencode`         | `["acp"]`                        | same       | load   | `build` / null / null / `plan`                                                                         | `OPENCODE_CONFIG_DIR` + `OPENCODE_CONFIG_CONTENT` 照旧 + MCP     |
| pi       | `pi-acp`           | `[]`                             | mapFile    | load   | `default` / null / null / null                                                                         | `-- --extension … --skill … --append-system-prompt …` 透传 + MCP |
| omp      | `omp`              | `["acp"]`                        | same       | load   | `default` / `--approval-mode write` / `--approval-mode yolo` / `plan`（modeId）                        | `--extension= --config= --append-system-prompt=` 照旧 + MCP      |
| copilot  | `copilot`          | `["--acp","--stdio"]`            | opaque     | none   | `default` / `--allow-tool=write`（测） / `--allow-all-tools`（测） / `--plan`（测）                    | `--plugin-dir` + `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 照旧 + MCP   |
| ama      | `ama`              | `["--mode","acp","--profile",…]` | same       | load   | 与[协调 Agent](coordinator-agent.md) §2.2 的 `permissionFlag` 相同（argv）                             | 只走 `--host`，**不加 MCP**                                      |

`null` 的模式在界面上不出现（与现在设置页「只提供有对应参数的权限模式」同一规矩）。`GET /api/agents` 的每一行加 `acp: { support, program, installed, version?, resume }`（契约 §13.1），`installed` 用 `resolveCommand` 探；没装的在新建向导里灰掉并给安装命令。

### §5.3 进程托管与节能

- 一个节点一个适配器进程，随会话行活；core 退出时全部 `SIGTERM`（与 PTY 会话同一处收尾）。stderr 进 core 日志（debug 级，带 nodeId），不进镜像。
- 适配器退出（非 core 所为）→ `terminal.exit` 事件 + `terminalGoneEvent`，与 PTY 死亡同一条路；页面在会话视图顶端给一行「已退出 · 重新连接」。
- **休眠**：`hibernate.ts` 的判据照用。阻塞条件新增：`resume === "none"` 记 `noResume`（Copilot 永不休眠）；`sessionId === "mapFile"` 且映射文件里查不到时记 `noProviderSession`。执行：回合进行中不睡（已有 `busy` 判据），`request_permission` 挂着不睡（`awaiting-approval`），空闲满阈值 → 杀适配器、行以 `hibernate` 结束。唤醒 = `host.start({ resume: sessionId })`，`session/load` 回放的历史**不进**镜像（镜像里已经有），只用来恢复适配器状态；回放期间 `acp.update` 不发给页面。
- 资源采样：会话 pid 就是适配器 pid，子树（SDK 起的 `claude`、app-server）照 `processesUnder` 算，所以内存徽标的数字对得上。
- SSH 节点第一版不支持 ACP 驱动：适配器要在执行主机上跑，Worker 代起留到后续批次（与第一部分 D5 同一条边界）。

### §5.4 事件归一化

`core/acp/normalize.ts` 产出的是现有 `AgentEvent`（`hook/normalize/event.ts`），`stateSource = "acp"`：

| ACP                                                                   | AgentEvent                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `session/new` / `session/load` 成功                                   | `kind: "session"`，`sessionPhase: "start"`，`sessionId`（按 §4.3 换成 CLI 的 id）、`transcriptPath`（镜像或 CLI 文件） |
| 我方发出 `session/prompt`                                             | `working`，`newTurn: true`，`prompt` 摘要进 `lastMessage`                                                              |
| `tool_call` / `tool_call_update`                                      | `working`（不带 `newTurn`）；`kind: "execute"` 的 `title` 进 `lastMessage`                                             |
| `session/request_permission` 到达                                     | `blocked`，`pendingId = <nodeId>-<epochMs>-acp-<toolCallId>`                                                           |
| `request_permission` 已答                                             | `working`                                                                                                              |
| `session/prompt` 响应 `end_turn` / `max_tokens` / `max_turn_requests` | `done`（`errored: false`）                                                                                             |
| 响应 `cancelled`                                                      | `done`，`interrupted: true`                                                                                            |
| 响应 `refusal` 或 JSON-RPC error                                      | `done`，`errored: true`，`lastMessage` 记错误                                                                          |
| 适配器退出                                                            | `terminalGoneEvent`（已有）                                                                                            |
| `elicitation/create`                                                  | `waiting`（`awaitingInput: true`）；页面答完发 `working`。core **不**自动答，超时也不答（D13）                         |
| `plan` / `usage_update` / `available_commands_update`                 | 不进状态；进 `acp.update` 给页面                                                                                       |

`session/update` 的分块（`agent_message_chunk` 等）不进 reducer，只进镜像与页面事件：reducer 看的是回合边界，与 Hook 模式对齐。`hook/normalize/index.ts` 加 `case "acp"`，`agent/registry.ts::stateSourceFor` 不改（它按 provider 答的是 Hook 通道；ACP 的来源由 `core/acp` 自己写死）。

### §5.5 审批

`session/request_permission` 到达时：

1. `insertApproval` 一行，`request_json = { protocol: "acp", toolCall, options }`；挂起的 JSON-RPC 请求 id 记在 `AcpSession` 内存里（不落库：进程没了请求也没了）。
2. 发 `agent.approval` 事件，节点头部出允许 / 拒绝（现有），会话视图出带全部选项的卡片（§6）。
3. `POST /api/approvals/{id}/answer` 的 body 放宽：`decision: "allow" | "deny"` 之外可带 `optionId`。`agent/approvals.ts::answerApproval` 先记录（CAS 不变），再按路由送达：`ApprovalRoute` 加 `"acp"`——找到挂起的请求，回 `{ outcome: { outcome: "selected", optionId } }`；只给了 `decision` 时取第一个 `allow_*` / `reject_*` 选项。
4. `session/cancel`、切换驱动、休眠、适配器退出：所有挂起的请求回 `{ outcome: "cancelled" }`，审批行 `answer = "cancelled"`、`answered_by = "core"`（审计表照写）。
5. `allow_always` 选项由适配器自己记忆（在它进程内有效），core 不缓存决定：每次都问人，与 Hook 模式一致。

### §5.6 send、收件箱与打断

`core/acp/bridge.ts` 实现 `TerminalBridge`，`terminal/install.ts::setTerminalBridge` 装的是一个按 `backend_kind` 分派的组合桥：PTY 会话走原来的，`acp` 会话走这里。

| 方法                           | ACP 实现                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `writeSubmit(text)`            | `session/prompt({ prompt: [{ type: "text", text }] })`；信封（`--- ARMADRA MESSAGE … ---`）原样保留，不拆 |
| `write(data)`                  | `data === "\u001b"` → `session/cancel`；其他内容拒绝（`acp_no_raw_write`）——ACP 没有「半截输入」          |
| `capture(lines)`               | 镜像尾部渲染成文本（`collab/transcript.ts::renderEntries`），取最后 `lines` 行                            |
| `foreground()`                 | `{ command: adapter.program }`                                                                            |
| `generation()` / `terminate()` | 会话行的代次；`terminate("process")` = cancel + kill，`"session"` = 同上并结束行                          |
| `observed()`                   | `undefined`：ACP 会话永远有上报，不走 §4.3 启发式                                                         |
| `driveTarget()`                | 同一个 `targetState()`；`InputSafety.pending` 恒 false                                                    |
| `spawnForNode()`               | `driver === "acp"` 时起适配器并 `session/new`；否则原路                                                   |
| `wakeNode()` / `sleeping()`    | §5.3                                                                                                      |

门链第 6 步「五态」与第 7 步「租约」原样生效：人正在会话视图输入框里打字时页面按现有 `POST /api/terminals/{id}/drive` 拿人类租约（输入框聚焦 → `takeover`，失焦或提交 → `release`），Agent 的 `send` 在这段时间排队——与终端模式「人在打字就不是 Agent 的回合」同一条规矩。收件箱唤醒（`wake.ts`）的那一行短提示也经 `writeSubmit`，所以 ACP 节点同样会在空闲时被叫去读信箱。

### §5.7 上下文读取与镜像

- 镜像 `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`：每条 `session/update` 聚合成 `TranscriptEntry`（`agent_message_chunk` 按回合合并成一条 assistant 记录，`tool_call` → `tool_use` 块，`tool_call_update.content` → `tool_result` 块，`user_message_chunk` / 我方 prompt → user 记录），`endOffset` 按字节。0600，目录 0700，与 `pending/` 同级。
- `history/registry.ts::readHistoryEntries` 在适配器之前先认 `.acp.jsonl` 后缀（`history/acp-mirror.ts`），其余读取方不改。`locateHistory` 不改。
- `context summary` / `transcript` 对 `same` 的节点读 CLI 自己的文件（与终端模式字节相同）；对 `opaque` 读镜像。`context terminal` 读 `capture`（§5.6）。
- 交接（`handoff/capture.ts`）经同一条路，自然覆盖。
- 页面重载：`GET /api/acp/sessions/{id}/log?after=<offset>` 读镜像，不向适配器要 `session/load`。

### §5.8 画布工具注入（MCP）

ACP 规范把 `mcpServers` 放在 `session/new` 参数里，六家入口都收。core 在 `session/new` 时传一条：

```json
{
  "name": "armadra",
  "command": "<数据目录>/bin/armadra-hook",
  "args": ["mcp"],
  "env": [
    { "name": "ARMADRA_NODE_ID", "value": "…" },
    { "name": "ARMADRA_ENDPOINT_FILE", "value": "…" }
  ]
}
```

`armadra-hook mcp` 是 Hook 客户端的新子命令：stdio 上讲 MCP（`initialize` / `tools/list` / `tools/call` 三个方法手写，不引 MCP SDK），每个工具就是一次现有的 `/control/{verb}` 或 `/context-link/{verb}` HTTP 调用，带同一份节点令牌与 `terminalBinding`——core 分不出它和 `armadra-hook canvas` 的区别，也不多给权限。工具表与参数从 `collab/control/index.ts::VERBS`、`context-link.ts::VERBS`、`browser/verb-spec.ts` 生成，一条测试断言与 `armadra-hook canvas --help` 的动词集合一致（[协调 Agent](coordinator-agent.md) §3 对 ama 适配器用的是同一手法；两边的生成器放 `src/hook-client/verbs.ts` 共用，若第三部分的 `src/hook-client/` 抽取先合入就直接用，否则 A3 先在 `cli/armadra-hook/` 里做、之后搬）。MCP `initialize` 结果的 `instructions` 放 `collab/skill.ts` 的画布说明与信任规则（CLI 会把它并进系统提示）。`SKILL.md` 不再需要：工具描述本身就是说明。

终端模式的注入产物与启动行**一个字节不改**：`canvasInjection` 对 ACP 驱动只产出 §5.2 「注入」一列里还能用的那一半（环境变量与透传参数），其余由 MCP 承担。

## §6 前端：会话视图

`apps/web/src/acp/`：

```text
acp/
  store.ts            每个 sessionId 一份：消息、工具调用、计划、当前模式、挂起审批、用量；吃 acp.update 事件与 /log 增量
  SessionView.tsx     节点体：ScrollArea 里的消息流 + 底部输入
  MessageList.tsx     user / assistant / thought（thought 折叠，Button 切换）
  ToolCallRow.tsx     一行：kind 图标 + title + status 徽标（Badge）；展开（Button）看 rawInput / content
  DiffBlock.tsx       tool_call content 里的 diff：复用 nodes/DiffNode 的 hunk 渲染
  PermissionCard.tsx  request_permission 的卡片：toolCall 标题 + 选项按钮（按 kind 分 allow / reject 两组，Button variant 区分）
  PromptBox.tsx       Textarea + 发送 Button + 模式 Select（availableModes）；Enter 发送、Shift+Enter 换行；聚焦即拿人类租约
  export-to-board.ts  §7
```

- `TerminalNode.tsx` 按 `data.agent.driver` 选节点体：`acp` → `SessionView`，否则 `TerminalSurface`。头部（状态胶囊、允许 / 拒绝、各徽标、更多菜单）一行不动；`terminal-menu.ts` 加「会话视图 / 终端视图」一项，当前驱动打钩，不支持 ACP 的 Agent 不出现。
- 审批：头部的允许 / 拒绝继续可用（答第一个 allow / reject 选项）；会话视图的卡片给全部选项。两处都走 `answerApproval`，先 `resolveApproval` 收起再发请求（现有做法）。
- 文件差异：`DiffBlock` 只渲染 ACP 给的 `oldText / newText`，不去读磁盘；点文件名用 `editor-reveal.ts` 开编辑器节点。
- 打断：头部「打断这一轮」照旧（走 `write(ESC)` → `session/cancel`）。
- 文案进 `apps/web/src/i18n/acp.ts`；用到的组件只有已有的 `badge / button / scroll-area / textarea / select / separator / status-pill / tooltip / dropdown-menu / popover`，不新增组件库条目，不加说明性文字。
- 窄屏：会话视图是普通节点体，焦点页与底部导航无改动。

## §7 输出到画板

入口：会话视图里每条 assistant 消息悬停出一个 DropdownMenu「输出到画板」，以及选中文字的右键菜单。四条路：

| 内容                | 落成                            | 动作                                                                                                                                                                                                        | 来源链接                                                                                                                        |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 整条回复 / 选中段落 | 便签节点                        | `addNode("sticky", { content, position: 来源节点右侧 })`                                                                                                                                                    | `stickyNodeDataSchema` 加可选 `source`；再 `addEdge(stickyId, agentNodeId)`                                                     |
| 短结论              | 白板文字对象                    | `whiteboard/store.addItems([{ kind: "text", text, meta: { source } }])`                                                                                                                                     | 白板 item 加可选 `meta.source`（v2 格式不变，未知字段按现有「保留原文」规矩），再 `createContentReference(itemId, agentNodeId)` |
| 代码块              | 编辑器节点                      | 文件写到工作区根下 `.armadra/exports/acp/<nodeId>/<会话前缀>-<messageId>-<n>.<ext>`（`POST …/exports/{nodeId}/text`，契约 §14.5：通用文件路由不许在 `.armadra` 里建目录），再 `addNode("editor", { path })` | `editorNodeDataSchema` 加可选 `source`；`addEdge`                                                                               |
| Mermaid 代码块      | 白板对象（flowchart）或图片对象 | 直接调 `canvas/whiteboard/mermaid` 的导入（跳过粘贴确认对话框：来源明确）                                                                                                                                   | 同白板文字                                                                                                                      |

```ts
// packages/shared/src/domain/node-data.ts
export const contentSourceSchema = z.object({
  nodeId: z.string().uuid(),
  sessionId: z.string().max(200),
  messageId: z.string().max(200).optional(),
});
```

- 来源链接是**连线**：便签 / 编辑器节点与来源 Agent 之间一条 `link` 边（对等），白板对象一条 `reference`。于是它们立刻能被别的 Agent 经 `context summary` 读到（`context-link.ts::readableAs` 已覆盖 sticky / editor / shape），也能再连给第三个节点。
- 头部的 `source` 只用于显示「来自 <节点标题> · <时间>」与「跳回来源」（`sidebar/goto-node.ts`）；core 不读它。
- 一次操作一条历史（`addNode` + `addEdge` 用 `history.ts` 的合并段），撤销一次全回。
- 由 Agent 自己落便签仍走 `canvas sticky` 动词，不变。

## §8 普通用户入口

最小可行范围（D10）：

1. **新建向导**（`apps/web/src/acp/NewAgentWizard.tsx`，Dialog 三步）：选 Agent（只列 `installed && acp.installed` 的，其余灰掉并给 `npm i -g …` 命令，复制按钮）→ 选目录（工作区根 / 最近用过的 cwd，Select）→ 选任务（模板 chips，Toggle group；或自己写一句，Textarea）。完成即 `addNode("terminal", { agent: { id, driver: "acp" } })` 并把任务作为第一条 prompt 经 `POST /api/acp/sessions` 带上。入口：新建菜单第一项「新建 Agent…」；原来的各 CLI 直建项保留在下面。
2. **缺省驱动**：`settings.agents.defaultDriver: "acp" | "terminal"`，缺省 `acp`；某家没装适配器时该家退回 `terminal`。
3. **简洁模式**：本机偏好 `ui.simpleMode`（缺省关）。开着时：节点菜单隐藏「回收 / 权限模式 / 终端视图」，头部徽标只留状态与审批，侧栏「会话」默认展开，新建菜单只剩「新建 Agent…」与便签 / 白板。不删任何功能，只是不显示。
4. **任务模板**：`apps/web/src/acp/templates.ts`，内置五条（解释这个仓库 / 修一个 bug / 补测试 / 审查当前改动 / 写一份计划），文案在 i18n；模板只是 prompt 文本 + 建议权限模式。用户自定义模板第二期（存 `settings.json`）。

不做：引导页、账号登录向导（各 CLI 的登录仍在终端里做；向导检测到没登录时给一条命令）、模型推荐。

## §9 数据与契约

### §9.1 存储

不需要迁移（D14）。改动都在已有的 JSON 列与文件里：

| 东西                | 落点                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| 驱动方式            | 节点数据 `agent.driver`（`nodes.data_json`）                                         |
| ACP 会话行          | `terminal_sessions`：`backend_kind = 'acp'`，`termination_intent` 多一种 `'switch'`  |
| 状态来源            | `agent_status.state_source = 'acp'`（TEXT）；共享层 `AGENT_STATE_SOURCES` 加 `"acp"` |
| 审批选项            | `agent_approvals.request_json`                                                       |
| 镜像                | `<数据目录>/acp/<nodeId>/<sessionId>.acp.jsonl`                                      |
| 来源链接            | 节点数据 `source`、白板 item `meta.source`                                           |
| 缺省驱动 / 简洁模式 | `settings.json` 的 `agents.defaultDriver`；`worker-settings.json` 的 `ui.simpleMode` |

预留迁移号 **0031**（0030 归第三部分的 `workflow`），只在实施中发现必须落库的东西（例如 ACP 用量要进成本）时启用；编号以合入时最大号 +1 为准，`migrations.lock` 同步。

### §9.2 契约 §13 草案（`docs/contracts/core-json-api.md`）

§13.1 `/api/agents` 行的 `acp`：

```json
{
  "id": "codex",
  "acp": {
    "support": "official",
    "program": "codex-acp",
    "installed": true,
    "version": "1.10.0",
    "resume": "load"
  }
}
```

§13.2 会话：`POST /api/acp/sessions {workspaceId, nodeId, cwd, agentId, permissionMode?, model?, resume?, prompt?}` → 会话行（`terminalSessionSchema`，`backend: "acp"`）；`POST /api/acp/sessions/{id}/prompt {text}` → `{ turnId }`；`POST …/cancel`；`POST …/mode {modeId}`；`GET …/log?after=<offset>` → `{ entries: TranscriptEntry[], endOffset }`；`POST /api/acp/nodes/{nodeId}/driver {driver}` → `{ sessionId, resumed }`（§4.2）。错误码：`acp_adapter_missing`、`acp_session`、`awaiting_approval`、`acp_no_raw_write`、`acp_protocol`（带适配器的 JSON-RPC error）。

§13.3 事件：`acp.update { sessionId, nodeId, update }`（`update` 是 ACP `session/update` 的 `update` 原样）、`acp.turn { sessionId, nodeId, turnId, stopReason }`、`acp.driver { nodeId, driver, sessionId, resumed }`。`agent.approval` 的 `request` 里多 `options[]`。

§13.4 审批答复：`POST /api/approvals/{pendingId}/answer { decision, optionId? }`。

共享层：`packages/shared/src/api/acp.ts`（上面的 zod），`terminalBackendKindSchema` 加 `"acp"`，`agentInfoSchema.acp` 可选，`answerApprovalRequestSchema.optionId` 可选。

## §10 批次

统一验证：`pnpm libs:build && pnpm -r --if-present test`；改到页面的再跑 `pnpm --filter @armadra/web typecheck`；新增文件、契约节或迁移以后跑 `pnpm check`。单测不起真 CLI：`core/acp/testing/fake-agent.mjs` 是一个脚本化的 ACP Agent（按剧本吐 `session/update`、发 `request_permission`、按 `session/cancel` 回 `cancelled`），所有 core 侧用例对着它跑。

| 批次 | 内容                                                                                                                                                                                                                                    | 依赖                                         | 可并行         | 验收                                                                                                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | `core/acp/{types,client,adapters,host}.ts` + `testing/fake-agent.mjs`；`GET /api/agents` 的 `acp` 字段；`tools/release/compatibility.json` 加 `acp` 条目（六家已验证版本）                                                              | —                                            | 与 A3、W0 并行 | `client.test`（分帧、并发请求、服务端请求挂起）、`host.test`（initialize 协商、`session/new` / `load`、退出对账）、`adapters.test`（模式集合与 `permissionFlag` 一致）、`list.test`                                              |
| A2   | `core/acp/{session,normalize,bridge,mirror,routes,index}.ts`；`terminal_sessions` 的 `acp` 行与组合桥；`hook/normalize/index.ts` 的 `case "acp"`；审批 `"acp"` 路由与 `optionId`；休眠 / 唤醒 / 切换；`history/acp-mirror.ts`；契约 §13 | A1                                           | 与 A3 并行     | `normalize.test`（§5.4 全表）、`session.test`（审批挂起 / 取消一律回 `cancelled`）、`bridge.test`（`writeSubmit` → prompt，ESC → cancel，`capture` 读镜像）、`driver-switch.test`、`hibernate.test` 新增 ACP 用例、`routes.test` |
| A3   | `armadra-hook mcp`：`cli/armadra-hook/mcp.ts` + `hook-client/verbs.ts`（工具表生成）；`core/acp/mcp.ts` 拼 `mcpServers` 参数；`canvasInjection` 对 ACP 驱动的裁剪                                                                       | —                                            | 与 A1 并行     | `mcp.test`（三个方法、工具表与 `VERBS` 一致、`tools/call` 走同一 HTTP 与令牌）、`inject.test` 新增 ACP 分支                                                                                                                      |
| W0   | 共享层：`api/acp.ts`、`node-data.ts` 的 `driver` / `source`、`AGENT_STATE_SOURCES`、`terminalBackendKindSchema`、i18n `acp.ts` 骨架                                                                                                     | —                                            | 先做           | `packages/shared` 测试；`i18n.test` 键集合                                                                                                                                                                                       |
| W1   | `apps/web/src/acp/{store,SessionView,MessageList,ToolCallRow,DiffBlock,PermissionCard,PromptBox}.tsx`；`TerminalNode` 节点体切换；`terminal-menu` 的切换项；`StateSourceBadge` 的 `acp`；侧栏会话行徽标                                 | W0（契约 §13 定稿即可，用 msw 假 core 开发） | 与 A2 并行     | `SessionView.test`（事件流 → 消息 / 工具行 / 审批卡；回合边界）、`PermissionCard.test`（选项按 kind 分组、答一次即收起）、`PromptBox.test`（Enter / Shift+Enter、聚焦拿租约）、`TerminalNode.test` 切换                          |
| W2   | 输出到画板：`acp/export-to-board.ts` + 菜单；Mermaid 直连导入；`source` 显示与跳回                                                                                                                                                      | W1                                           | 与 W3 并行     | `export-to-board.test`（四条路各建出对应对象 + 一条边 / 引用，一次撤销全回；来源字段形状）                                                                                                                                       |
| W3   | 普通用户入口：`NewAgentWizard`、`templates.ts`、`agents.defaultDriver`、`ui.simpleMode`                                                                                                                                                 | W1                                           | 与 W2 并行     | `NewAgentWizard.test`（未装适配器灰掉并给命令、完成即建节点带首条 prompt）、`simple-mode.test`（隐藏项清单）                                                                                                                     |
| E2   | `tools/probes/agent-e2e/scenario-12-acp.mjs`（§11）；`lib.mjs` 加 `acpAdapterInstalled()`、`promptViaApi()`                                                                                                                             | A1–A3、W1                                    | 最后           | 六家各两轮；指纹不变；审批一次经页面答                                                                                                                                                                                           |
| X2   | 文档：`guides/architecture.md` §4 加 ACP 驱动一段、`guides/agent-collaboration.md` 加「ACP 模式」小节、`status/feature-roadmap.md` 3.2 加行；本文状态改「已实施」                                                                       | 全部                                         | —              | `pnpm check`                                                                                                                                                                                                                     |

### 文件归属与冲突

| 共享文件                                                                               | 涉及批次               | 处理                                                                                                                                |
| -------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/{api/agents,api/terminals,domain/node-data,domain/primitives}.ts` | W0                     | W0 独占、先合入；A1 / A2 / W1 基线取 W0 之后                                                                                        |
| `core/agent/{list,approvals}.ts`、`hook/normalize/index.ts`、`terminal/install.ts`     | A1（list）、A2（其余） | A1 只加 `acp` 字段；其余 A2 独占                                                                                                    |
| `core/terminal/{hibernate,hibernator}.ts`                                              | A2                     | A2 独占                                                                                                                             |
| `core/hook/install/inject.ts`、`cli/armadra-hook/*`                                    | A3                     | A3 独占；第三部分 D4 要把 `cli/armadra-hook/{endpoint,http,session,json}.ts` 抽到 `src/hook-client/`——谁先合入谁定目录，后者 rebase |
| `apps/web/src/nodes/{TerminalNode,terminal-menu}.tsx`                                  | W1                     | W1 独占                                                                                                                             |
| `apps/web/src/canvas/menus/add-menu.ts`、`panels/settings/pages/AgentPage.tsx`         | W3                     | W3 独占                                                                                                                             |
| `docs/contracts/core-json-api.md` §13                                                  | A2                     | 第三部分的 workflow 节用 §14                                                                                                        |
| `tools/release/compatibility.json`                                                     | A1                     | 第三部分 B1 加 `agent` 键，A1 加 `acp` 键，不同键                                                                                   |
| `tools/probes/agent-e2e/lib.mjs`                                                       | E2                     | 等全部合入；第三部分的场景 11 若先合入则 rebase                                                                                     |

先后顺序：W0 先合入；之后 A1、A3、W1 并行；A1 合入后 A2；W1 合入后 W2、W3 并行；最后 E2、X2。与第三部分的交叉只有 `src/hook-client/` 与 `compatibility.json`，上表已写处理。

## §11 验收与真 CLI 端到端

场景 12「六家 ACP」（`tools/probes/agent-e2e/scenario-12-acp.mjs`），复用场景 10 的装配：

1. 预检：每家的 `acp.installed`；没装的记 `skipped`（与 E1 同一规矩），不装。
2. 六家各起一个 ACP 驱动的节点，经 `POST /api/acp/sessions` 带首条 prompt「回复 OK」。断言 `agent_status.state_source = 'acp'`，回合结束后 `state = 'done'`，镜像有一条 assistant 记录。
3. 对 Claude 节点发一条会触发写文件的 prompt，等 `agent.approval`，经页面点卡片上的 `reject_once`；断言审批行 `answer` 与 `request_json.options` 形状，节点回到 `done`，文件没写。
4. 连成环沿环 `send` 一轮，断言六条 `delivered`（ACP 下就是六次 prompt）；下游 `context summary` 读上游读得到内容。
5. 对 Claude 节点切换到终端视图再切回：断言两次都 `resumed: true`，`agent_status.session_id` 不变，终端里 `claude --resume <id>` 起来后对话还在。Copilot 节点切换断言 `resumed: false` 且事件里有说明。
6. 对一家（OpenCode）压 `ARMADRA_TEST_ECO_IDLE_SECONDS` 走一次休眠与唤醒，断言适配器 pid 变了、会话 id 没变。
7. 全程 `console.errors` 为空。

**不改真实配置的防护**（D13）：

- Claude 的钥匙串登录只认真实配置目录（第一部分 §7.1），所以 Claude 用真实 `CLAUDE_CONFIG_DIR`。开场与收尾对 `~/.claude/settings.json`、`~/.claude.json`、`.credentials.json` 做字节指纹（`lib.mjs::fingerprint`），并单独盯 `permissions.defaultMode`（`claudeDefaultMode()`）——任一变化判场景失败。
- 其余五家在临时 HOME（场景 6 的函数），凭据只复制 API key 条目。
- core 的 ACP 驱动**从不**自动回答 `elicitation/create`、`request_permission`；探针也只经页面答。ACP 模式没有 TUI 启动对话框，第一部分那次事故的路径不存在，指纹仍然要对。
- 每家限两轮、`--model` 取各家最便宜的（经 `session/set_config_option` 或启动参数），回合超时 90 秒即取消；`usage_update` 有的家断言两轮合计 token 小于 5 万。

## §12 风险与待确认

风险：

- **适配器版本漂移**：`claude-agent-acp`、`codex-acp` 发版频繁（resume / fork 刚修过），`_meta` 扩展（AIR）多。对策：`compatibility.json` 记验证过的版本区间，`initialize` 协商失败或版本不在区间时集成页标黄；core 只认 v1 规范字段。
- **ACP sessionId 与 CLI 会话 id 的对应**对 Claude / Codex 未实测（§3.1 的「测」）。对不上就按 `opaque` 处理，功能降级但不坏：切换与休眠变成新开会话，转录读镜像。
- **Copilot 不能跨进程 resume**：ACP 节点永不休眠，常驻内存；界面在内存徽标旁说明。上游 #1767 合入后把 `resume` 改成 `load` 即可。
- **MCP 注入与各家对 `mcpServers` 的实现差异**（pi-acp 收下但不接通；OpenCode 不支持 MCP over ACP 的某些形态）。对策：`armadra-hook` CLI 仍在适配器环境的 PATH 上，`instructions` 里保留一句「也可以直接跑 `armadra-hook canvas …`」；pi-acp 这家暂靠透传的 `--skill`。
- **两种视图的心智差异**：终端视图能看到 CLI 自己的 UI（如 Claude 的信任目录提示），ACP 下这些由适配器处理或不出现。新建向导对第一次用的目录提前说明。

待确认（请拍板，括号里是推荐）：

| #   | 问题                                                                                          | 推荐                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 三个 npm 适配器要不要随包打包（像 ama 的 D6）？                                               | **第一版不打包**（D11）：用户 `npm i -g`，集成页探测 + 给命令；跑通后再评估打包体积与锁定成本                                           |
| Q2  | ACP 模式的画布工具走 `session/new.mcpServers`（D6），还是逐家找启动参数把 `SKILL.md` 塞进去？ | **MCP**：规范统一、六家都收、工具表从 `VERBS` 生成；Claude 在 ACP 下没有别的注入路。`SKILL.md` 那条路在终端模式保留不动                 |
| Q3  | `settings.agents.defaultDriver` 缺省值                                                        | **`acp`**（装了适配器的家）：第二部分的目标用户是普通用户；开发者在设置里改回 `terminal` 或按节点切                                     |
| Q4  | `ama` 要不要在它的仓库里实现原生 `--mode acp`（D12）                                          | **要**，排在六家之后；本仓库不写 ama 专用 ACP 适配器。需要文档 A 的作者同意并改第三部分 B4 的描述                                       |
| Q5  | 第一版要不要向 Agent 声明 `fs` / `terminal` 能力（让 CLI 经 core 读写文件、起终端）           | **不声明**：文件与终端由 CLI 自己做，与终端模式一致，少一层审计边界；等会话视图稳定后再评估「经 core 起的终端能进画布终端节点」这种收益 |
| Q6  | 迁移号 0031 与契约 §13 的预留（第三部分已占 0030，契约节未编号）                              | 本文占 **0031 / §13**，第三部分 workflow 用 **§14**；合入时以当时最大号为准，实施代理先核对 `migrations/` 与契约再动手                  |
