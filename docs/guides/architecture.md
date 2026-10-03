# 架构

> 下一阶段目标见 [画布工作平台设计总纲](../design/canvas-platform-design.md)及其专项文档。本文件描述当前实现，不把目标能力提前计入现状。

> 当前实现的架构。画布层细节见 [画布换成 React Flow](../design/canvas-react-flow.md)，
> Agent 运行时与接口契约见 [v3-agent-terminal-plan.md](../contracts/v3-agent-terminal-plan.md)。
> 选型演进的原始讨论见 [ChatGPT 会话归档](../research/chatgpt-conversation-archive.md)。

## 1. 定位

业务由**一个 Electron-free 的 TypeScript core**（`apps/desktop/src/core/`）执行，两种壳装配它：Electron 桌面壳（`apps/desktop`）与无窗口服务器壳（`apps/server`）。2026-09 之前的 Rust Runtime（`apps/runtime` + `crates/`）、Go Host（`apps/host`）与它们之间的 Protobuf 已在 R7d 整体删除；那个时代的设计文档移入 `docs/history/`。进度见 [TypeScript Core 进度](../status/typescript-core-status.md)。

关闭桌面窗口隐藏前台并保留服务；Command Q / 托盘退出经私有控制结束受管会话与后台。core 重启保留 tmux 恢复语义。

Armadra 是一个 local-first 的桌面画布：把 Claude Code、Codex、
opencode 等 CLI Agent 作为终端节点放在一块无限画布上，节点之间连一条线即
建立上下文链接，Agent 可以读取被链接一端的转录、终端画面或白板内容。

所有数据留在本机：SQLite 一个库 + 工作区里的 `.armadra/` 目录。桌面安装没有服务端；
要多设备或多人时，把同一套 core 装进服务器壳（见 §2 末段）。

## 2. 三层结构

```text
┌──────────────────────────── apps/desktop ────────────────────────────┐
│ Electron 桌面壳：窗口、托盘、通知、系统目录选择器、外部链接、          │
│ 拖入文件的真实路径，以及把 core 作为子进程（`ELECTRON_RUN_AS_NODE`）  │
│ 拉起 / 健康检查 / 停止                                                │
│ 健康检查只认自己拉起的那个实例（`/health` 的 instanceId 与子进程      │
│ 启动时打到 stdout 的一致）；不一致时按 endpoints.json 与进程表确认    │
│ 是同一数据目录、由桌面启动的旧 core 后发 SIGTERM 再重拉               │
│  └── 随包资源：`resources/cli/armadra-hook.js`、`resources/migrations/`│
│      `resources/agent/ama.cjs`（钉住的 @armadra/agent）与             │
│      `resources/agent-host/ama-armadra.cjs`（它的宿主适配器）         │
│      （Windows 另有 `resources/session-host/host.cjs` 与              │
│      `resources/cli/armadra-hook.exe`、`armadra-launch.exe` 启动器）  │
│  └── 回环 HTTP 静态服务：内核分配端口，页面从这里加载                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 加载同一套页面（preload 给出基址与凭据）
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/web  React 19 + Vite + React Flow 12 + shadcn/ui + Tailwind v4   │
│ 画布、节点、终端 UI（xterm.js）、编辑器（CodeMirror 6）、设置、会话侧栏 │
│ 浏览器节点在壳里是进程内 `<webview>`                                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP + WebSocket 直连，无协议转发
┌───────────────────────────────▼──────────────────────────────────────┐
│ apps/desktop/src/core  TypeScript + node:http(s) + ws + node:sqlite    │
│ 工作空间与画布、终端（tmux / 直连 PTY / SSH / Windows session-host）、 │
│ 文件、Git、GitHub、身份、调度与自动化、语言服务、浏览器、Hook 服务、   │
│ 会话索引、协作动词、用量快照                                          │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 本机回环 TCP / Unix socket
┌───────────────────────────────▼──────────────────────────────────────┐
│ src/cli/armadra-hook  各 CLI 的 hook 与技能调用的小客户端（单文件 JS）│
│ src/hook-client  端点、令牌、HTTP 与动词工具表（CLI 与适配器共用）    │
│ src/agent-host/ama  ama 的宿主适配器：画布工具、状态上报、子任务、审批│
└──────────────────────────────────────────────────────────────────────┘
```

三条边界不变：

- **apps/web 是唯一页面**。桌面壳与服务器壳加载同一份构建产物。
- **`src/core/` 是唯一执行服务**。所有进程、文件、Git、权限判定都在这里，
  业务逻辑不写进壳的 IPC 处理器，避免出现第二套后端。core 不 import
  `electron`，也不 import 壳的任何目录，由 `core/no-electron.test.ts` 的源码
  扫描守住——它能脱离 Electron 以纯 Node 运行，是服务器壳存在的前提。
- **apps/desktop 的 `src/main/` 只做壳**。主进程提供目录选择、外部链接、系统
  通知与窗口，能给页面的东西只有 `src/shared/ipc.ts` 那张表。

第四个目录 `apps/server` 是无窗口服务器壳：同一份 `apps/web` 产物、同一套 core，
对外只有 TLS 一个面，认证走设备配对与可撤销会话。对外的那一层（TLS、本地 CA、
准入、CSP、页面托管、配对载荷）在 core 的 Gateway 域 `core/gateway/`：服务器壳的
`serve` 只是「解析参数 → `openGateway`」，桌面壳按设置 `gateway.*` 开关同一个
Gateway（契约 §17）。用法见
[开发指南](development.md#无窗口服务器壳)，进度见
[TypeScript Core 实施进度](../status/typescript-core-status.md) §11。

`apps/push-relay` 是商店版 App 的最小推送中继（无状态，只转发端到端加密的信封），
复用 core `push/transport-direct.ts` 的 APNs / FCM 客户端；是否运营由发布方定，
见它的 [README](../../apps/push-relay/README.md) 与契约 §19。

## 3. 画布层

窗口浮层以侧栏之外的可用画布区域为布局容器。标题栏图标共用 44px 高度的
中心线；底部 Dock 与右侧导航区分别预留空间。窄窗口使用紧凑工具菜单，并把
缩略图与用量球移到 Dock 上方；缩略图是自写的 `canvas/flow/Minimap.tsx`，
按窗口宽度自己决定收起，不跟随画布库的断点。用量球位于缩略图左侧。

用量快照保留供应商返回的基础与模型专属额度窗口，每个窗口独立显示已用比例和
重置时间。数据采集时间与额度重置时间分开显示；后台刷新和手动刷新共用串行化
与冷却时间，前端只轮询缓存，不把缓存轮询时间当成数据更新时间。

core 自己的全部出站地址登记在 `core/net/outbound.ts`（用途、频率、关闭开关；
`outbound.test.ts` 扫源码，没登记的 `https://` 真实主机过不了测试）。借用 CLI
登录令牌的两个额度端点（Claude `api/oauth/usage`、Copilot `copilot_internal/user`
与它的设备流）默认关（`usage.claudeUsage` / `usage.copilotUsage`），关着时不读凭据、
不发请求，本机在用的那家在快照里报 `unavailable` + `reason: "policy_off"`，页面第一次
看到时提示一次；Codex 端点默认开、标「非官方端点」，答 HTML 时报 `unavailable` +
`reason: "unsupported"`。

各 CLI 留在本机的会话记录经**本地历史适配器**读（`core/history/`，每家一个
`HistoryAdapter`，在 `history/registry.ts` 的 `HISTORY_ADAPTERS` 登记，目前 claude、
codex）：根目录（`history/home.ts`，规则与 `hook/install/shared.ts::configHomeWith`
同一份）、定位、会话列表与解析、归一化记录（`TranscriptEntry`，由
`history/entries.ts` 从 JSON 读出）和成本来源都在适配器上。会话索引的 provider、
成本来源表、`context summary / transcript`、转录面板与交接的转录读取都从注册表
派生；CLI 自己报来的转录路径永远先认，所以没有适配器的 CLI 只要报了路径也读得到。

本地成本按 agent 采集：适配器上的 `cost: { kind: "jsonl", source }` 声明自己的
字节预筛与逐行解析（`AgentCostSource`），`core/usage/cost-sources.ts` 的
`COST_SOURCES` 从注册表收集。扫描器只认这张表——没有本地来源的 agent 不在表里，
`byAgent` 里标 `source: "none"`，界面显示「暂无本地用量数据」而不是零。接入一家
新 agent 就是写一个适配器并登记，聚合（`summarize()` 的 `ranges`：24h / 7d / 30d /
全部）、契约与界面都不用改。

**工作面板一次只开一个**（`panels/WorkPanelSheet.tsx`）：资源管理器、资源、
问题、用量、GitHub、自动化、交接停在右侧，宽度来自一张表——右上工具簇也读
那张表，好让开着抽屉时它自己让开。Git 是唯一停在**底部**的一块
（[Git 工具窗口](../design/git-tool-window.md)）：它是「日志 / 提交」两个页签
的窗口，日志页三栏要的是宽度而不是高度，所以它不在那张宽度表里，高度记进偏
好、可拖动、可最大化。占地方这件事仍然共用同一条规则，所以打开它照样会关掉
右侧那一块。

Git 的读分两级。逐检出的那一批（status、diff、branches、history、reflog、
worktrees、stashes、tags、remotes、integration、hunks、commit / commit-file）
都带一个工作空间相对的 `path`，缺省是工作空间根。工作空间级的三条不带：
`POST …/git/log` 把所有已发现检出的提交合并成一张图，`GET …/git/refs` 一次
给出所有检出的分支树，`GET …/git/identity` 说这个检出提交出去会署谁的名。写
全部经仓库队列（`GitRepositoryAction`）；队列与 Git 命令都在执行主机上——本机
工作空间在 core 里，远端工作空间在 Worker 里（下一段）。

执行位置只有一条缝：`core/remote/execute.ts` 的 `executeOn`。文件、导入与
Git 的路由做完权限与参数解析后，按工作空间的 `executionHostId` 要么在本进程
里查 `core/remote/operations.ts` 的操作表，要么把同一个操作名经 `ssh` 发给那
台主机上的 Worker——Worker 就是同一份 core 包以 `worker --stdio` 启动，不开
数据库、不监听端口，只读写 stdio 帧（`core/remote/server.ts`）。两边跑同一段
代码，远端工作空间绝不回退到控制端的磁盘。Worker 也能主动推帧（`requestId`
为空），各域经 `listenRemote` 订阅：Git 长操作在 Worker 的仓库队列里排，进度
与结局推回控制端的镜像（`core/remote/git-operations.ts`）；文件监听由 Worker
的平台 watcher 推变化，连接断开或 Worker 太旧时退回控制端 2 秒轮询；资源面板
每拍对每台远端主机做一轮 `resources.read`（`core/resources/remote.ts`）。语言
服务走同一台主机上的第二个 Worker（`worker --stdio --language-link`，
`core/remote/language.ts`），语言服务器是它的子进程；长时间没有会话时控制端
关掉这条连接（`core/remote/language-idle.ts`），下次按需重连。交接材料经 Worker
在执行主机上采集（`handoff.capture`，`core/remote/handoff-worker.ts`）；来源
Agent 在另一台执行主机的 SSH 终端里时，只有它的转录到那台主机上读
（`core/handoff/remote-capture.ts`，读不了答 501 `handoff_host_offline`）。控制
连接每次握手的版本与能力汇成 Worker 舰队（`core/remote/fleet.ts`）：执行主机行的
`worker`、集成状态的 `outdatedHosts` 与「重新同步」都读它。比一帧大的上传与下载分块传输、按 Worker
已收的字节续传（`core/remote/transfer.ts`）。画布 SSH 终端里的 CLI 由 Worker
同步过去的产物与垫片注入，Hook 经 Worker 的 unix socket 中继回控制端
（`core/remote/integration.ts`，见[远端画布注入](../design/remote-canvas-injection.md)）。

画布引擎是 React Flow 12（`@xyflow/react`，MIT），白板层自写。
**`canvas-store` 是画布在内存里的唯一真相**，React Flow 只是受控视图：
`nodes` / `edges` 由 `document.nodes / edges` 与白板文档投影出来
（`canvas/sync/project.ts`），用户手势经 `onNodesChange` 等回调翻译成
`canvas-store` 的动作，没有反向派生。

- **节点**是 `armadra` 类型的自定义节点（`canvas/flow/nodes/ArmadraNode.tsx`），
  节点体是普通 React 组件，所以终端、编辑器、iframe 直接渲染在节点里。
  拖拽只从头部起（`dragHandle`），体内的指针事件归节点体自己。
- **分组**是 `group` 节点（`canvas/flow/nodes/GroupNode.tsx`），子节点用
  React Flow 的 `parentId` 子流，坐标相对父级。
- **上下文链接**是 `link` 类型的边（`canvas/flow/edges/LinkEdge.tsx`）：
  两端节点相对边的中点之间的贝塞尔曲线，方向与标签由两端的节点类型算出来。
- **白板内容**（手绘、几何、文字、图片、直线）是 `wb.*` 节点，与节点共用
  同一套相机、选择和撤销栈；内容引用是 `reference` 边。引用的来源可以是一个
  白板对象，也可以是一个 Frame——引用 Frame 等于引用它圈住的那一片（成员清单
  加上成员一起栅格化的图，`canvas/frame-reference.ts`）。
- **撤销 / 重做**是自写的逐实体差异栈（`store/canvas/history.ts`），
  远端在撤销期间新增的实体不受影响。
- **⌘/Ctrl + 滚轮缩放**由画布自己算（`canvas/interaction/wheel-zoom.ts`），
  不依赖 React Flow 的按键状态：那份状态由 keydown 落在谁身上决定，终端拿到
  焦点时并不可靠。

节点类型共 9 种（`packages/shared/src/domain/primitives.ts` 的 `NODE_TYPES`）：
`terminal`（含 Agent）、`sticky`、`group`、`editor`、`diff`、`files`、`browser`、
`automation`、`agentActivity`。
入库的连线只有一种：`link`；派生的视觉边（子代理 rope 等）每帧算出来，不入库。

## 4. Agent 运行时

Agent 节点就是终端节点里跑着一个 CLI，没有中间协议：

1. core 在 PTY 里启动 CLI，注入 `ARMADRA_NODE_ID`、`ARMADRA_ENDPOINT_FILE`
   等环境变量。
2. **画布内注入**：适配只随画布启动带上，不写各 CLI 的全局配置，画布外启动的 CLI
   不受影响（[画布内注入](../design/canvas-only-integration.md)）。唯一出口是
   `core/hook/install/inject.ts::canvasInjection`，产物（插件目录、扩展、技能、画布说明、
   Claude 的 settings）生成在 `<数据目录>/integration/<cli>/`；同目录下每个 CLI 一个启动器
   `run/<cli>` 按各 CLI 实测的参数引用它们，只在有 `ARMADRA_NODE_ID` 时注入
   （[画布启动器](../design/canvas-launcher.md)），启动行只是 `<launcher> <程序> <旗标>`，
   节点终端 `PATH` 最前面的同名垫片 `shims/<cli>` 让手敲的 CLI 也经启动器：Claude / Codex / Copilot 是**命令 Hook**（行是 `armadra-hook`），
   Pi / Oh My Pi 是生成的 **TS 扩展**，OpenCode 是插件。core 里拼启动行的只有
   `core/agent/canvas-launch.ts`，页面只有 `web/agent/launch.ts`；整行按节点 shell 的方言
   引用（posix、fish、cmd.exe、PowerShell 7 / 5.1），Windows 上绕过 npm 的 `.cmd` 包装直接
   起真正的程序，启动器是 C# 写的 `armadra-launch.exe` 副本加 `.launch` 文件。数据目录之外
   不写任何文件（Codex 的 Hook 信任用会话级旗标）；升级时旧的全局安装与旧版写下的 Codex
   信任记录由 `migrate.ts` 先备份再清掉一次。SSH 终端里的 CLI 由 Worker 同步的产物、远端启动器与同名垫片注入、
   Hook 经 Worker 中继（§3 远端一段）。
3. 命令 Hook 每个事件调一次 `armadra-hook`；进程内扩展在 CLI 自己的进程里说同一套 HTTP。
   Windows 上 `armadra-hook` 是一个 C# 小启动器（`cli/armadra-hook/windows-launcher.cs`，
   打包时用系统自带的 `csc.exe` 编），把调用方的命令行原样交给
   `ELECTRON_RUN_AS_NODE` 的 runner，参数不经 `cmd.exe` 第二次解释；没有 `.exe` 的构建
   退回 `.cmd`。正文含 shell 特殊字符时，任何参数都可以改从标准输入（`--x -`）或文件
   （`--x-file`）读。
   两者都读 `<数据目录>/hook-endpoint.env` 找到 core（优先 Unix socket，其次回环 TCP），
   带 per-node token 与终端绑定回报——同样的凭据、同样的请求，core 不因来源多给权限。
4. core 归一化各家载荷（`hook/normalize/`）、reduce 成节点状态
   （`working` / `waiting` / `blocked` / `done`），连同来源标识 `stateSource`
   （`hook` / `extension` / `observed`）通过工作空间事件 WebSocket 推给前端，
   并随 `GET /api/workspaces/{id}/sessions` 一起返回，使刷新后节点头部的来源徽标不丢。
5. 没有任何适配的终端只有 `observed`：core 按已有的输入围栏与输出计数给一个弱提示，
   它不写进状态、也不能满足自动化提示词的空闲门（`core/terminal/` 的 `input_idle`）。
6. 权限请求在节点头部直答，答案写回 `<数据目录>/pending/`，hook 客户端阻塞读取
   （目前只有 Claude 的 Hook 能等答复）。

内置 Agent 定义集中在 `packages/shared/src/agents.ts`（launch 命令、prompt 传递方式、
权限模式对应的 argv、resume 方式、能力位），core 侧只镜像 id 与启动程序
（`core/agent/`）。自定义 CLI 用 `custom:<id>`。

模型列表不写死：`GET /api/agents/{id}/models` 依次取 CLI 自己的说法
（`claude --help` 的 `--model` 别名、Codex `config.toml` 里配好的 `model` 与各
profile）、models.dev 目录中该 provider 的条目、以及离线兜底表，按发布日期倒序
并标注每条的来源。目录本身启动时读 `<数据目录>/models-catalog.json`，
缓存超过 24 小时就拉一次 `https://models.dev/api.json`，之后每天一次；联网只发生在
core 侧。同一份目录供计费（内置表 → 目录 → `model-pricing.json`）与上下文上限
（目录 → 家族规则）使用，
来源与更新时间在设置页「账号与用量」里显示（`GET /api/models/catalog`）。

Agent 之间的协作走 core 的两个动词表面：

- `POST /context-link/{verb}`：读取被链接节点的转录、摘要或终端画面。
- `POST /control/{verb}`：`list` / `open-terminal` / `open-agent` / `open-browser` / `team` / `sticky` /
  `link` / `rename` / `color` / `post` / `inbox` / `ack` / `handoff-read` / `interrupt` / `close` / `send` / `outbox` / `cancel` / `workflow-propose`。`team` 一次建一组 Agent 节点，成员之间的先后写进依赖表（`core/dependencies`）。成员（与 `open-agent --worktree`）可以各带一条 worktree：检出不存在时经 Git 域同一条写队列新建，成员放进绑着它的 Frame（`core/collab/control/worktree.ts`）。

依赖编排在 core 里（`core/dependencies/`，迁移 0027）：`open-agent --after` 与 `team`
把「下游等哪些上游、等当前还是下一轮结束」写进依赖表，服务订阅 `agent.status` /
`terminal.exit` / `board.changed` 并每 30 秒扫一次（过期、上游被删、重启后补判）。
条件满足时由 core 启动下游——节点已有 shell 就往里敲，没有就经终端桥起一个——
再把第一条任务放进投递队列，与 `send` 走同一条出队路；页面不在也照样生效。节点头的
「等待 X」徽标读的是这张表，不再是节点数据里的 `pendingLaunch`。契约见 [core JSON 契约](../contracts/core-json-api.md) §8。

工作流在 core 里（`core/workflow/`）：协调者经 `workflow-propose` 交草案，人经
`/api/workflows/*` 确认成模板、按参数起跑。一次运行在画布上建一个 Frame（起点便签 +
每个角色一个 Agent 节点），角色节点交给依赖编排的启动路径起，提示词经投递队列投出
（发起方是起点便签）；步骤是否完成用与依赖边相同的判定。引擎订阅 `agent.status` /
`agent.delivery` / `terminal.exit` 并每 30 秒扫一次，页面不在、重启之后都照样推进。契约见
[core JSON 契约](../contracts/core-json-api.md) §15。

所有 Agent 终端都能调用 `armadra-hook canvas help` 读取短帮助。画布启动的 CLI 带着
画布说明（一段「画布规则」）与按需技能：协作只走 `armadra-hook canvas`，要别的 Agent
用 `open-agent` / `team`，要浏览器用画布浏览器节点。详见
[Agent 适配与协作协议](./agent-collaboration.md)。

经 ACP 驱动的 Agent 没有终端可敲命令，画布工具改由 `armadra-hook mcp` 承担：它在
stdio 上讲 MCP（`initialize` / `tools/list` / `tools/call` 手写，不引 SDK），工具表就是
`src/hook-client/verbs.ts` 的 `VERB_TOOLS`，每次 `tools/call` 是一次与
`armadra-hook canvas|context|browser` 逐字节相同的 HTTP 调用（同一份节点令牌与会话绑定），
`initialize.instructions` 是 `collab/skill.ts::mcpInstructions`。core 开会话时经
`core/acp/mcp.ts` 把它放进 `session/new` 的 `mcpServers`（命令、`ARMADRA_NODE_ID`、端点
文件；ama 不加）；`@armadra/agent` 的 `AcpClient` 声明 `features.mcpServers` 才带，旧版照旧
开会话、答 `mcpInjected: false`。

ACP 只是同一个 Agent 节点的另一种驱动方式（`core/acp/`，[ACP 会话视图](../design/acp-session-view.md)，
契约 §14）。节点数据 `agent.driver: "acp"` 的节点不开 PTY：core 直接起适配器
（`host.ts`，协议栈是 `@armadra/agent/acp`），会话是 `terminal_sessions` 里
`backend_kind = 'acp'` 的一行。ACP 是终端管理器的**一个后端**（`bridge.ts`），所以行、代次、
人类租约、退出通知、Eco 休眠（同一行上起下一代并 `session/load`）只有一份实现：`writeSubmit`
（括号粘贴加回车）落为 `session/prompt`，单个 `ESC` 落为 `session/cancel`，`capture` 读镜像，
`send` 的门链、收件箱唤醒、`interrupt`、依赖编排与调度一行不改。状态是第四种来源 `acp`：
`session.ts` 说出回合边界的信号，经 `hook/normalize` 的 `case "acp"`（`normalize.ts`）与
`hook/ingest.ts::apply` 进同一个 reducer；`request_permission` 进同一张 `agent_approvals`，
答复经 `agent/approvals.ts` 的 `"acp"` 路由回到挂起的请求，回合取消、退出、切换、休眠时一律
回 `cancelled`。每条 `session/update` 先写镜像 `<数据目录>/acp/<nodeId>/<会话 id>.acp.jsonl`
（`mirror.ts`；读取方经 `history/acp-mirror.ts`，连线读取认得这个后缀）再发 `acp.update`。
驱动切换（`POST /api/acp/nodes/{id}/driver`）结束当前驱动、在同一行上以另一种驱动接回 CLI
自己的会话；画布注入在 ACP 下只留入口认得的那一半（`agent/canvas-launch.ts::acpInjection`），
其余由 MCP 承担。

浏览器节点的 Agent 工具是 `armadra-hook browser <动词>`，动词清单只有一份
（`core/browser/verb-spec.ts`，`--help` 与技能都由它生成）；执行下沉在 core
（`core/browser/cdp/`），CDP 调用经一张白名单，执行任意 JS 不开放
（[浏览器节点的 Agent 工具](../design/browser-agent-tools.md)）。桌面壳里 CDP 在壳主
进程：Agent 第一次驱动时接上调试器并拿租约；在那之前，被某个 Agent 终端连着的浏览器
节点由壳**被动旁听**——core 按链接文档把「被连着的节点」推给壳
（`core/browser/observe.ts`），壳只订阅 `Runtime` / `Log` / `Network`（不取头与正文），
事件记进每页 500 条的缓冲，不发输入、不算租约，所以 `read --mode console / network`
读得到第一次驱动之前的记录。headless 后端从开标签起就在记。

## 5. 数据模型与持久化

```text
                  ┌──────────────── 内存真相 ────────────────┐
                  │  canvas-store（document + whiteboard）     │
                  └───┬───────────────────────┬──────────────┘
          nodes/edges  │                       │ 白板文档整份序列化
                        ▼                       ▼
        Workspace / Board / Node / Edge      白板快照（不透明 JSON）
        （SQLite 的 nodes / edges 表）        （boards.whiteboard_json）
```

- 持久化两条通道由 `PUT /api/workspaces/{id}/boards/{boardId}/document` 一次带走。
  节点与连线仍是 `nodes` / `edges` 表——core、hook、控制动词、会话侧栏只认这张表；
  节点 id 就是那一行的 uuid，白板对象是 `wb:<uuid>`，都不查表；分组是 `group` 节点。
- 白板对象与内容引用序列化成一份 `{"engine":"armadra-flow","version":2,…}` 的
  JSON 存进 `boards.whiteboard_json`，**core 不解析它**（只看长度与摘要）。
  上限 8 MiB，超了这一轮不保存并提示。不认识的 `engine` / 更高的 `version`
  按「保留原文」处理：不覆盖，也不显示成空白板。
- **图片资产不进快照**：字节走 `POST /api/workspaces/{id}/assets`（或按路径
  `.../assets/import`），内容寻址落在工作区的
  `.armadra/assets/<sha256 前 16 位>.<ext>`，快照里只留 URL 与工作区相对路径。
- 保存是 CAS：请求带 `expectedUpdatedAt`，冲突返回 `409`。请求体仍是整份文档
  （服务端按 id 做 upsert + 删掉请求里没有的行），所以「谁的改动算数」由
  CAS 加客户端变基决定，不是按字段合并。
- 保存成功后 core 广播 `board.changed{boardId, updatedAt}`。同一块板的另一个
  窗口按这个 `updatedAt` 判断这条事件是不是自己刚存的那一次：不是就重取文档，
  经 `canvas/sync/merge.ts` 合进 `canvas-store`——视口留本地的，本地这一轮动过的
  实体（`store/canvas/pending.ts` 记账）留本地的，其余照收远端的。远端灌入
  **不进也不清**撤销栈，手势进行中先不合，等松手。
- 多设备同开一块板时，core 在内存里记在线表与**一把写租约**（`core/canvas/presence.ts`，
  不入库、不进 outbox）：页面每 10 秒心跳，只有一个客户端时无感；有别人在看时租约归
  正在编辑的一方，别人手里的租约让 `PUT …/document` 答 423 `canvas_lease_held`（判在
  CAS 之前），本页转只读并在右上角显示谁在编辑、可确认接管。core 自己的写者（控制
  动词、调度、依赖编排）不经租约。契约见 [core JSON 契约](../contracts/core-json-api.md) §9。
- 控制动词新建节点时，core 在 `board.changed` **之后**再广播一条
  `node.created{boardId, nodeId, nodeType, originNodeId}`。前者只说「板变新了」，
  后者说「新出现的是哪一个、谁要的」：正开着这块板的页面据此把新节点选中并把
  相机对准它，和从新建菜单建出来的一模一样（`canvas/created-node.ts`）。后台
  标签页、开着别的板的窗口、以及正在拖拽或输入的时候都不跟。
- 节点的默认尺寸只有一份，在 `apps/web/src/nodes/registry.ts`：控制动词建节点
  时**不写 `size`**，页面投影时按类型补（`canvas/sync/project.ts`）。

SQLite 的迁移只有一个目录——`apps/desktop/src/core/db/migrations/`，0001 起一条
连续序列，字节由根 `migrations.lock` 守住（R7d 把原先分散在两处的来源合成一处）。
基础表由 `0001_initial.sql` 创建；`0002_agent_mailbox.sql` 增量添加消息箱：

| 表                                    | 内容                                                |
| ------------------------------------- | --------------------------------------------------- |
| `workspaces` / `boards`               | 工作空间与看板，`boards.whiteboard_json` 存白板快照 |
| `nodes` / `edges`                     | 节点与入库的上下文链接                              |
| `terminal_sessions` / `terminal_logs` | 终端会话与回放日志                                  |
| `agent_status`                        | 每个 Agent 节点的当前状态（hook reduce 的结果）     |
| `agent_approvals`                     | 权限请求与答复                                      |
| `agent_mailbox`                       | 持久化拉取消息箱（幂等发送、确认、过期）            |
| `context_links`                       | 供 Agent 查询的链接视图                             |
| `hook_installs`                       | 每个 CLI 的 hook 安装记录                           |
| `conversations`                       | 会话索引（provider + session id → 标题）            |

`core/db/open.ts` 在同一 `BEGIN IMMEDIATE` 事务内先检查迁移账本，再执行已知迁移与启动恢复。未知版本、校验和不符、脏记录、损坏账本、无账本的非空 schema 或迁移历史缺口均拒绝启动；失败回滚并关闭连接，不改名、删除或重建原库。账本表与校验和算法沿用最初那套（SHA-384），所以装过旧版本的库照常打得开。既有 SQL 迁移文件保持原字节。

迁移 0015 是**单向门**：它把原先另一个进程的私有库并了进来，应用之后这个 `canvas.db` 旧实现再也打不开。所以应用它之前 core 先 `VACUUM INTO` 一份 `canvas.db.before-ts-core-<时间戳>` 并验证那份副本能打开——回滚不是再跑一条迁移，而是用这份备份替换整个文件。

终端原始输出、密钥和 `.env` 不进入画板持久化。

**写入所有权机制已删除（历史注记，R7c/R7d）。** 画布、设置、文件、会话、Agent、Git
六个域曾各有一行 `write_ownership` 记录，声明「此刻由哪个实现写」，页面按它路由每
一次读写，切换窗口里画布变成只读。那个机制存在的唯一理由是**有两个写者**；一个
core 里没有第二个，所以 2026-09-20 连同 `/api/ownership`、`/api/ownership/domains`
两条路由、前端的 `canvas-ownership/` 与各域的 `host-session.ts` 一起删除，页面收口
为「本地总是可编辑」。当时的设计见 [Host 业务所有权迁移](../history/host-business-migration.md)（历史文档）。

## 6. 进程、端口与文件位置

来源与凭据检查**按壳分档**。桌面壳里 core 就在壳的进程树内，壳经 preload 直接把
凭据注入页面，没有中间的票据链。服务器壳保留完整的设备配对、可撤销凭据、会话轮转、
CSRF 与 Origin 校验（[服务器账号、中转与共享](../design/server-accounts-and-sharing.md)）。
分进程时代的票据链设计见 [桌面壳原生 Host 会话](../history/host-native-session.md)
与[设备认证](../history/host-device-auth.md)，两份都是历史文档。

| 项                  | 值                                                                                                  | 覆盖方式                                        |
| ------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| core 监听           | `127.0.0.1:43120`                                                                                   | `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` |
| core 监听（壳内）   | `tcp:127.0.0.1:0`，端口由内核分配、stdout 公告                                                      | `ARMADRA_RUNTIME_LISTEN`                        |
| 壳的静态服务        | `127.0.0.1:<内核分配>`，页面从这里加载                                                              | —                                               |
| Web 开发服务器      | `127.0.0.1:1420`                                                                                    | `vite --port`                                   |
| 数据目录（macOS）   | `~/Library/Application Support/Armadra`                                                             | `ARMADRA_DATA_DIR`                              |
| 数据目录（Windows） | `%LOCALAPPDATA%\Armadra`                                                                            | 同上                                            |
| 数据目录（Linux）   | `$XDG_DATA_HOME/armadra`                                                                            | 同上                                            |
| 数据库              | `<数据目录>/canvas.db`                                                                              | `ARMADRA_DATABASE_URL`                          |
| 迁移目录            | `apps/desktop/src/core/db/migrations`（包内 `resources/migrations`）                                | `ARMADRA_CORE_MIGRATIONS_DIR`                   |
| Hook 端点文件       | `<数据目录>/hook-endpoint.env`（0600）                                                              | —                                               |
| 节点 token          | `<数据目录>/node-tokens/<nodeId>`                                                                   | —                                               |
| 待答权限            | `<数据目录>/pending/`                                                                               | —                                               |
| 画布注入产物        | `<数据目录>/integration/<cli>/`                                                                     | —                                               |
| 画布启动器与垫片    | `<数据目录>/integration/run/<cli>`、`shims/<cli>`、`launcher.json`（Windows 为 `.exe` + `.launch`） | —                                               |
| Hook 客户端启动器   | `<数据目录>/bin/armadra-hook`（Windows 为 `.exe`，兜底 `.cmd`）                                     | —                                               |
| 随包 ama 启动器     | `<数据目录>/bin/ama`（Windows 为 `armadra-hook.exe` 的拷贝 `ama.exe` + `ama.launch`）               | `ARMADRA_AMA_BUNDLE`、`ARMADRA_AMA_HOST`        |
| ama 的模型密钥      | 只在密钥后端（`armadra-ama-<供应商>`）；`run/ama` 凭节点 token 经 hook 通道兑换、只设给 ama 进程    | —                                               |
| 账号偏好            | `<数据目录>/settings.json`                                                                          | —                                               |
| 本机偏好            | `<数据目录>/worker-settings.json`                                                                   | —                                               |
| 模型目录缓存        | `<数据目录>/models-catalog.json`（0600）                                                            | —                                               |
| 价格覆盖            | `<数据目录>/model-pricing.json`                                                                     | —                                               |
| 私有 tmux server    | `<数据目录>/tmux.sock` + `tmux.conf`（0700 目录）                                                   | —                                               |
| 工作区产物          | `<工作区>/.armadra/`（assets、exports、板日志）                                                     | —                                               |

偏好分两个文件：`settings.json` 跟着账号走，`worker-settings.json` 属于这台
机器（`core/settings/local.ts`：终端后端、浏览器可执行文件、电源策略、
CLI 路径覆盖与探测缓存）。载入时合成一份文档、写入时再拆开，所以
`GET /api/settings` 仍是一个对象；`GET /api/settings/local` 告诉界面哪些键属于
本机。

core 启动时把 PATH 换成补齐过的版本（Homebrew、mise shims、mise Node 安装
目录），并把同一份 PATH 交给所有终端子进程——从 `.app` 启动的 GUI 进程拿到的是
裸系统 PATH，否则终端里能用的 CLI 会被误判为未安装。

终端后端（`core/terminal/`）：`tmux`（默认，会话跨 core 重启存活）、`direct`
（node-pty 直连）、`ssh`（设置里配置的远程主机），Windows 另有 session-host
守护进程（`src/session-host/`，包内 `resources/session-host/host.cjs`），
它持有 ConPTY 会话，使之比壳活得更久。早期方案见
[windows-session-daemon.md](../design/windows-session-daemon.md)。

节能休眠（`core/terminal/hibernate.ts` 判据、`hibernator.ts` 执行）：空闲满阈值、
能用 CLI 自己的 resume 接回来的 Agent 会话被结束以释放内存，行以
`termination_intent = 'hibernate'` 记下；页面聚焦、投递或计划冷启动时在同一个会话
id 上起下一代并敲恢复行。设计见 [terminal-host-design.md](../design/terminal-host-design.md) §7.2。

## 7. 安全边界

- 桌面壳里的 core 只绑回环地址；CORS 只放行回环 HTTP 来源（`http://127.0.0.1:*`、
  `http://localhost:*`，以及 Unix socket / 命名管道调用者用的无端口形式）。
  自定义 scheme 不在放行之列，页面也不再用任何一种。
- Hook 表面有独立鉴权（per-node token）和独立 body 上限，优先走 Unix socket。
- 所有路径参数都限制在工作区根目录内（core 的路径解析）；导入的图片
  字节复制进 `.armadra/assets/`，不暴露原位置。
- 页面能让壳做的事只有 `apps/desktop/src/shared/ipc.ts` 那张表；`shell:open-external`
  按 scheme 白名单限 `http` / `https`，对话框返回路径而不是字节。渲染进程
  `contextIsolation: true`、`nodeIntegration: false`，唯一桥是 preload。
- CSP 见 `apps/desktop/src/shell-core/csp.ts`：`connect-src` 只留本机 core 的
  http/ws，`<webview>` 供浏览器节点使用。
- core 自己拥有的密钥（Copilot 令牌、GitHub PAT 等）只经 `core/secrets` 的
  `SecretBackend { kind, get, set, delete }` 存取，名字一律 `armadra-*`：macOS 桌面壳
  走 `security(1)` 钥匙串（`keychain`）；Windows / Linux 桌面壳的 core 是 fork 出的
  `ELECTRON_RUN_AS_NODE` 子进程，封与解经 fork 的 IPC 通道问主进程的 `safeStorage`
  （`main/secrets.ts`，`dpapi` / `libsecret`；Linux 的 `basic_text` / `unknown` 当作
  没有钥匙串）；服务器壳用 `<数据目录>/secrets/master.key` 做 AES-256-GCM
  （`file-encrypted`，探针可用 `ARMADRA_SECRET_BACKEND=file-encrypted` 指定）；其余与
  `ARMADRA_SECRET_BACKEND=file` 是 0600 明文（`file`）。
  壳说了要用 `safeStorage` 而通道不在时拒绝，不降级成明文。旧名字的条目第一次读写时
  一次性迁移，记录在 `secrets/migrated.json`。设置页只显示种类。
- 节点凭据（`core/agent/credentials/`，契约 §20）：条目在 `agent_credentials` 表，值在
  SecretStore `armadra-credential-<ref>`；`kind → 变量名` 由 core 写死。起终端时
  `terminal/install.ts::ownedEnvironment` 校验 `credentialRef`，节点 shell 的环境里只有条目名
  `ARMADRA_CREDENTIAL_REF`；CLI 启动时 POSIX 启动器 `run/<cli>` 调 `armadra-hook credential`
  经本机 hook 面 `POST /credential`（节点 token）现取，只在自己的进程里设变量再 `exec`。
  `file` 后端、SSH 节点与 Windows 拒绝。
- 服务器壳默认不监听非回环地址，对外服务是显式动作；它的配对码不可复用，
  token 不出现在 URL 里，撤销设备后正在进行的流立即终止。
- 服务器壳认证出的主体经 `AsyncLocalStorage` 跟着请求走（`core/identity/gate.ts` 的
  `runAs`），`core/identity/route-access.ts` 挂在 core 分发与升级之前，按
  `route-scopes.ts` 给每条路由的 scope 判定。成员只拿到被共享工作空间上的授权，全局
  路由分三类：按对象落到工作空间的（Agent 状态、上下文读取按节点所在画布，审批答复与
  关闭确认按请求所在画布要 `approval:answer`）、无害的全局读（Agent 目录、模型、终端
  后端、状态页，被共享过任意一块画布即放行）、本机管理（设置、执行主机、SSH、数据、
  用量、集成、GitHub、自动化等，只给 owner）。组内 `admin` 能管本组成员与只指向本组的
  邀请。工作空间列表按授权过滤；授权一变，已开的事件流重新判定，不够就以 4403 关掉，
  失去写权的客户端当场交出画布写租约。没有请求主体时放行——桌面壳里没有第二个人，行为
  不变。设计见[服务器账号与共享](../design/server-accounts-and-sharing.md) §6，契约见
  [core JSON 契约](../contracts/core-json-api.md) §10。

## 8. 未实现

- **Windows 持久化会话**：session host 已实现并在 Windows CI 上通过，没有在真机上
  长时间运行过（进度 §13、§33）。启动行方言、`.cmd` 绕过与 `.exe` 启动器同样只在
  Windows CI 上跑过（进度 §54、§57、§61）。
- **多人实时协同**：core 侧（`core/realtime/`，契约 §16.1–§16.2、§16.4）：每块板
  一个 `Y.Doc`，快照 + 更新流是实时板的真相，表由物化得来；core 自己的写者经
  `saveBoard` 前的拦截写进文档；awareness 按连接改写身份、校验形状。页面侧
  （`apps/web/src/realtime/`）：开板时 `realtime || enabled` 就连 `…/sync`，
  `Y.Doc` 与 `canvas-store` 双向绑定（origin 断开回声环），`Y.UndoManager` 接管
  撤销，在线条与光标层来自 awareness，断线时本地照常编辑、重连补齐。设置
  `collab.realtime`（缺省开）关掉时新板留在 §5 的编辑租约。评论（G2-6）尚未实现；
  实时板的视口不进文档，只留在本窗口。
- **自动更新**：electron-updater 已接通（`apps/desktop/src/main/updates/`），但未
  签名的构建里更新器是关闭的——「没签名 = 什么也验证不了 = `notConfigured`」，
  它绝不会报 `upToDate`（`shell-core/updates/availability.ts`）。
