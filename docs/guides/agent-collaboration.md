# Agent 适配与低干扰协作

Armadra 启动真实 CLI，保留各 CLI 的账户、模型选择、工具策略与会话格式。协作层只负责节点身份、链接范围、消息和可读上下文；不把一个 Agent 的系统提示词复制给另一个 Agent。

## 六种 CLI

| CLI            | 启动提示（`promptMode`）              | 恢复指定会话           | 状态通道   | 非默认权限模式               |
| -------------- | ------------------------------------- | ---------------------- | ---------- | ---------------------------- |
| Claude Code    | 位置参数（`argv`）                    | `--resume ID`          | 命令 Hook  | auto-edit / full-auto / plan |
| Codex          | 位置参数（`argv`）                    | `resume ID`            | 命令 Hook  | auto-edit / full-auto / plan |
| OpenCode       | `--prompt TEXT`（`flag-prompt`）      | `--session ID`         | 插件       | 暂仅 CLI 默认                |
| Pi             | 位置参数（`argv`）                    | `--session PATH_OR_ID` | 进程内扩展 | 仅 CLI 默认                  |
| Oh My Pi       | 位置参数（`argv`）                    | `--resume ID`          | 进程内扩展 | auto-edit / full-auto        |
| GitHub Copilot | `--interactive TEXT`（`flag-prompt`） | `--resume ID`          | 命令 Hook  | auto-edit / full-auto / plan |
| ama            | 位置参数（`argv`）                    | `--resume ID`          | 宿主适配器 | auto-edit / full-auto / plan |

`ama` 是 Armadra 自己的协调 Agent（随包的 `@armadra/agent`，第七个内置 Agent），见下文「协调者与 runners」。

「启动提示」这一列只描述**人**在这里敲一条带提示词的启动行时会拼成什么。Agent
新建的节点不走这一列：`canvas open-agent` 的启动行从不带提示词，第一条任务由
`--task` 经投递队列在节点报出第一条空闲之后投进去（[Agent 投递设计 §8](../design/agent-delivery.md)）。
自定义 Agent 可以用 `promptMode` 覆盖 base 的形状，第三种取值 `stdin-after-start`
的意思是「永远不上命令行」。这张表与 `packages/shared/src/agents.ts`、
`core/agent/registry.ts` 三方一致，由 `launch.test.ts` 的一条用例守着。

Gemini CLI 于 2026-09-19 从产品移除（迁移 `0014_retire_gemini.sql` 清理其会话索引、状态、Hook 安装记录与终端节点上的 agent 绑定）。恢复能力表示可以正确构建已有会话 ID 的启动命令；会话索引覆盖六种 CLI（[CLI 协作](../design/cli-collaboration.md) §3）。六种 CLI 都能启动、选择模型、连接节点、主动读上下文、使用收件箱；子 Agent 与额度这类没有实现的能力不显示。CLI 自身扩展提供的工具能力与 Armadra 的适配能力是两件事。

Pi 的 `--resume` 打开选择器；指定会话要用 `--session`。OMP 的 `--plan` 选择规划模型，而 `--plan-yolo` 会自动执行规划，因此不能将它们冒充只读计划模式。Copilot 的 `-p/--prompt` 会进入非交互模式并在完成后退出，这里使用 `--interactive`。不支持的非默认权限模式会在启动前明确报错，不静默降级。设置页和终端菜单只提供有对应参数的权限模式；新建节点会采用保存的默认权限。

节点头部的「更多 → 模型」只对求交集后仍具备 `supportsModelSelection` 的 Agent 出现，选项是各 CLI 自己文档里的别名，不查询任何提供方的模型清单；选完写进节点数据、下一次启动才带上 `--model`，当前会话既不重启也不受影响。CLI 版本探测（`<launchCmd> --version`）失败时能力为 unknown，菜单不出现，不做名称推断。终端节点在首个 Hook 回合后按占位标题自动命名一次，人工改名即锁定，详见 [Agent 自动化设计 §8](../design/agent-automation-design.md)。

2026-09-13 用真实 CLI 跑过 Claude Code 2.1.260、Pi 0.84.4、OMP 18.1.8、Copilot 1.0.8x 的完整集成（`pnpm agent:smoke`，
见[开发指南](./development.md)）：装一次 → 事件到达 → 动词可用 → 卸载后干净。两个没跑通，但都不是卡在安装上：
Codex 0.153.4 装完弹「Hooks need review」（`trusted_hash` 与该版本不再匹配，见 [设计 §8.3](../design/agent-integration.md)），
OpenCode 本机入口 npm postinstall 未执行、根本启动不了（当时的 Gemini 结果已随其移除不再记录）。
2026-09-06 曾跑过 Pi / OMP / Copilot 的状态通道；2026-09-05 核对了它们的 `--help`，并参照 [Pi 官方源码](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、[OMP 官方项目](https://github.com/can1357/oh-my-pi)、[Copilot CLI 官方参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)、[OpenCode CLI 官方参考](https://opencode.ai/docs/cli/)。OpenCode 本机入口执行返回 permission denied，因此该提供商参数由官方文档核对，未声称本机交互验证成功。发现器会检查 Unix 执行权限，不再只因路径上存在普通文件就标记已安装。

## 状态通道与来源徽标

节点头部的状态（RUNNING / NEEDS YOU / DONE）与自动化调度的空闲判断，
都来自同一件事：CLI 自己告诉 core 它在做什么。这条通道按 CLI 分两种形式，能力完全相同：

| 形式       | CLI                         | 怎么交给 CLI（只在从画布启动时）                                                     | 怎么工作                                                             |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 命令 Hook  | Claude Code、Codex、Copilot | Claude `--settings`，Codex 每个事件一个 `-c hooks.<Event>=…`，Copilot `--plugin-dir` | CLI 每个事件调一次 `armadra-hook`，它连 core 的本地 socket 回报      |
| 进程内扩展 | Pi、Oh My Pi                | `--extension` / `--extension=` 指向数据目录里的 `armadra-status.ts`                  | 生成的 TS 扩展在 CLI 进程内连同一个 socket，不 fork 进程             |
| 插件       | OpenCode                    | 节点终端的 `OPENCODE_CONFIG_DIR` 指向数据目录里的配置目录，插件在其 `plugins/`       | 插件在 CLI 进程内连同一个 socket，连不上时才退回 fork `armadra-hook` |

进程内扩展**不比**命令 Hook 更可信：两者用同一个 bearer、同一份每节点令牌、同一条终端绑定发同样的请求，
core 分不出也不会因此多给任何权限。区别只是省掉每个事件一次 fork。

## 集成：只在画布内注入

Hook、技能（`SKILL.md`）与画布说明是一组**注入产物**，生成在 `<数据目录>/integration/<cli>/`，由同目录下的启动器 `run/<cli>` 在 CLI 启动时交给它：画布节点的启动行是 `<launcher> <程序> <旗标>`，启动器路径由 `GET /api/agents` 每行的 `launcher` 给出（契约 §13.1），注入只在环境里有 `ARMADRA_NODE_ID` 时追加；在画布外重跑同一行、或用户自己启动的 CLI 什么都看不到。各 CLI 的参数与恢复时的行为见 [画布内注入](../design/canvas-only-integration.md) §3，启动器见 [画布启动器](../design/canvas-launcher.md)。修订号仍是 `INTEGRATION_REVISION`（`<Hook 修订>×100 + <技能修订>`），变了就在下一次启动时重写产物；Hook 事件契约（`HOOK_CLIENT_REVISION`）不随之变。

数据目录之外不写任何文件：Codex 的 Hook 信任靠启动器追加的会话级旗标 `--dangerously-bypass-hook-trust`。启动不改用户 HOME 下的任何文件：一次性迁移只清数据目录里旧安装器的标记，记在 `<数据目录>/integration/global-migration.json`（`version: 3`）。旧版装进各 CLI 全局配置的东西列在集成页，用户点「清理旧版」才处理。集成页没有「安装 / 卸载」，只有「重新生成」。

### 旧残留与清理

本产品旧版本留在 CLI 全局配置里的东西不会自己消失：程序是我们 Hook 客户端 `armadra-hook`（含开发构建）的
Hook 条目与状态行、调用它的状态模块 `armadra-status.*`、Copilot 的 `hooks/armadra.json`；技能目录 `armadra`、
`armadra-canvas`、`armadra-linked-context`（`SKILL.md` 带我们的修订号尾注或调用我们的客户端）；全局
`AGENTS.md` / `CLAUDE.md` 里的 `armadra:skills` 标记块；以及与我们的条目同在时 Codex `hooks.json` 顶层的
`version`——Codex 用 `deny_unknown_fields` 解析这个文件，多一个陌生键，**整份文件的 hook
全都不跑**，包括用户自己的。

只认这些签名，而且只认 `armadra` 开头的名字：本产品改名前的旧名也不再认。其他工具也会往同一批文件和目录里装
Hook、技能和指令块，名字可能与我们的旧版相似；它们不出现在集成状态里，不出现在清理结果里，也不会被改动或删除。
交给 CLI 的每个名字（Hook 程序、技能、插件、状态模块、MCP 服务器、环境变量）都以本产品名开头，清单见契约 §13.5。

`GET /api/agents/{id}/integration` 的 `legacy.found` 列出这些条目，启动时**不改**任何 CLI 文件。真正动手的只有
设置页的「清理旧版」：先把要重写的文件备份成 `<file>.armadra-backup-<时间戳>`，只删我们的条目，其余原样写回。
报告给出 `{found, removed, kept, backup}`，只含我们自己的条目；`kept` 是我们的、但因旁边有用户文件而留下的那些。
旧技能目录不备份：里面是我们自己生成的说明书，没有用户的东西，而 `SKILL.md` 旁边多一个备份文件反而要教 CLI 忽略；
目录里若还有用户自己放的文件，只删 `SKILL.md`，目录留下并在 `kept` 里写明。指令文件只删标记块本身，
块外的每个字节原样保留（备份整份），块删空了的文件才删除。

清理之前，这些残留的后果是可以直接观察到的：Codex 启动时报 `failed to parse hooks config … unknown field \`version\``，
于是没有任何 hook 跑，节点头上的状态一直停在启动时的样子；而旧指令块让模型去跑旧版画布控制脚本。画布启动时若任一 CLI 有残留，顶部会有一条
通知条指向 设置 → 集成。

### 各 CLI 的配置目录覆盖

写到哪一个目录由各 CLI 自己的环境变量决定，Armadra 照抄它们的语义，不发明新的：

| CLI            | 变量                                                         | 语义                 |
| -------------- | ------------------------------------------------------------ | -------------------- |
| Claude Code    | `CLAUDE_CONFIG_DIR`                                          | 直接就是配置目录     |
| Codex          | `CODEX_HOME`                                                 | 直接就是配置目录     |
| GitHub Copilot | `COPILOT_HOME`                                               | 直接就是配置目录     |
| OpenCode       | `OPENCODE_CONFIG_DIR`，否则 `$XDG_CONFIG_HOME/opencode`      | 前者直接就是配置目录 |
| Pi / Oh My Pi  | `PI_CODING_AGENT_DIR`（OMP 另有 `PI_CONFIG_DIR` 与 profile） | 直接就是 agent 目录  |

这些覆盖变量都**不在**终端子进程的继承白名单里（`terminal/backend.rs::INHERITED_ENV` 只放行 `HOME`、`XDG_*` 等）。
也就是说：给 core 进程设了 `CODEX_HOME`（或 `COPILOT_HOME`、`CLAUDE_CONFIG_DIR`……），安装器会写到那个目录，
而画布上起的 CLI 仍然按自己的 `HOME` 去找——两边指向不同的地方，安装看起来成功但事件不会到。
六种 CLI 都是这个情况，不是某一个的问题；要重定向就改 `HOME`，`pnpm agent:smoke` 用的正是这个办法。

### Copilot 的 `notification`

`notification` 一个名字下面是四件事。官方文档页没有它（参考页只列八个事件），出处是 CLI 自己的 changelog 1.0.18：
该事件「fires asynchronously on shell completion, permission prompts, elicitation dialogs, and agent completion」
（<https://github.com/github/copilot-cli/blob/main/changelog.md>）。区分靠载荷里的 `notification_type`，
唯一有一手出处的取值是 `permission_prompt`（<https://github.com/github/copilot-cli/issues/2586>，其修复在 1.0.26
把它收窄成「只在真的向用户弹出提示时触发」）。

因此只有 `permission_prompt` 映射成 NEEDS YOU，其余一律不映射：shell 跑完不是节点的状态（跑它的那一轮还在跑，
`postToolUse` 已经说过了）；elicitation 对话大概也是「等你」，但没有任何出处给出它的 `notification_type`，编一个字符串
只会打在错的地方；agent completion 已经有权威事件 `agentStop`，而 `notification` 是异步的，晚到的那一条只会盖掉更新的一轮。

### 来源徽标

节点头部的小徽标说明这一条状态是怎么来的：

| 徽标      | 含义                                                       | 能满足空闲门吗 |
| --------- | ---------------------------------------------------------- | -------------- |
| Hook 上报 | CLI 的命令 Hook 报的                                       | 能             |
| 扩展上报  | CLI 进程内的扩展报的                                       | 能             |
| 终端观测  | 没有任何适配，core 只按终端有没有新输出猜的一个弱提示      | **不能**       |
| （没有）  | 还没有人报过。头部按「未知」显示，不当作空闲，也不当作忙碌 | 不能           |

「终端观测」只用于头部的弱提示与自动命名，永远不写进节点状态，也不能让自动化调度认为目标空闲——
猜出来的空闲会把提示词写进一个正在打字的终端。刷新页面后徽标仍在：会话列表和事件推送带的是同一个字段。

## 协作协议：armadra.mailbox.v1

协作默认按需读取。节点菜单的「Agent 协作」可复制 `armadra-hook canvas help`；该命令给出简短用法。六种 CLI 从创建它们的终端继承相同的节点身份，不要求先安装 provider hooks——上一节的适配只关系到状态与空闲门。

1. 在画布上连接两个 Agent 节点，确定允许共享的上下文范围。
2. 发送者完成阶段性工作后存一条短交接：结果、证据文件路径、需要对方判断的具体问题。
3. 接收者在需要协作时主动查看自己的收件箱。应用不自动粘贴消息、不按 Enter、不触发新一轮推理。
4. 接收者处理完后显式确认消息；读取本身不会消耗消息。

```sh
armadra-hook context list
armadra-hook canvas post --to <linked-node-id> --key review-1 --body '构建已通过。变更见 src/api.rs，请审查错误返回。'
armadra-hook canvas inbox --limit 10 --after 0
armadra-hook canvas ack --id <message-id>
```

`armadra-hook` 是随 Armadra 打包的 sidecar（macOS 在 `Armadra.app/Contents/MacOS/`），画布里开的每个终端的 PATH 末尾
都带着它所在的目录，环境里另有 `ARMADRA_HOOK_BIN` 指向它的绝对路径——技能里写的是裸命令名，shell 配置若整个重写了
PATH，模型按技能的说明改用 `"$ARMADRA_HOOK_BIN"`（2026-09-16 补：此前 sidecar 目录不在 PATH 上，打包版里模型按技能
跑 `armadra-hook` 只会得到 command not found）。

Windows 上装的是 `<数据目录>/bin/armadra-hook.exe`：一个控制台小程序，读旁边的 `armadra-hook.launch`（第一行
Electron，第二行 bundle），设 `ELECTRON_RUN_AS_NODE=1`，把调用方的命令行原样接上交给 Electron。以前的
`armadra-hook.cmd` 会经过 `cmd.exe` 再读一遍，正文里的 `&`、`|`、`%`、`^`、`"` 会变成别的命令；它仍写在旁边，
给还指着它的旧配置和没有 `.exe` 的构建兜底。带任意文本的参数另外都能从标准输入（`--body -`）或文件
（`--body-file <路径>`，`--task-file`、`--text-file` 同理）读，技能与 `--help` 都写了——Windows PowerShell 5.1
自己会弄丢参数里的 `"`，这是它唯一稳妥的传法。

不安装新的 MCP 服务、不追加启动提示、不轮询 CLI、不改变 CLI 配置即可使用。可选的 Hook 安装仍需用户显式触发；它将两个独立的按需技能放入 provider 的 `skills/` 目录，移除以前由 Armadra 标记的长篇全局指令区块，保留用户的其他内容。普通启动不会修改全局 `AGENTS.md` 或 provider 配置。

### 可复用边界

- 所有操作经原有 runtime bearer 和每节点 token 鉴权。不能在请求体中冒用其他节点；`inbox` 与 `ack` 总是面向调用者自己的节点。
- `post` 接受精确目标 ID；要求源与目标都是 Agent 终端、位于同一工作空间且存在源节点可见的画布链接。即使链接残留，移动到其他工作空间的目标也不能继续接收。
- 消息来自同级 Agent，是资料而非用户指令。正文以 JSON 字符串返回，不将正文中的 Markdown 或伪造帧解释为高权限内容。
- 正文最多 2000 个 Unicode 字符，控制字符被移除。大输出与长对话通过文件引用或已有的 `context summary` / `terminal` 按需读取，不放进通知。
- `--key` 是发送者为一次交接分配的 1–128 字节 ASCII 标识。相同源、目标、key 和正文重试返回原 ID；同 key 不同正文返回 409。幂等性保留到该消息过期。
- 每目标最多 64 条未确认消息。容量检查和插入是同一 SQL 写操作，并发发送不能突破限制。满时返回 429。
- 所有消息保留至创建后 24 小时；任何 mailbox 请求会清理过期消息。确认后的条目暂时保留以实现重试幂等，过期后一起清理。无需后台常驻轮询。
- `inbox` 默认 10 条，最大 32 条，按单调 `sequence` 排序。返回 `nextCursor` / `hasMore`。遍历当前收件箱后，下次独立检查应从 `--after 0` 开始，以保留尚未确认的消息。
- `ack` 幂等，只影响调用者收到的消息。消息存于 SQLite 增量迁移 `0002_agent_mailbox.sql`，应用重启不会撤销已确认状态。
- CLI保留完整协议 JSON；不会为了只显示 `message` 而丢弃消息ID、游标、`outcome` 或 `retryable` 字段。

`post` 成功仅表示消息已存储，不表示 Agent 已看到、已处理或完成任务。`ack` 表示接收者主动确认该消息，仍不等同于用户验收。协议保留来源和稳定标识，后续可扩展任务状态、人工审核或其他客户端，而不改变现有 CLI 的提示词与配置。

### 推式投递与打断

拉取式信箱之外，`canvas send` 把一句任务投进目标终端：进投递队列，经驱动租约、半截输入门、前台进程门与画面门（目标停在 CLI 的启动对话框上或首投时看不到提示符就退回 `TARGET_NOT_AT_PROMPT`），目标空闲时才写；休眠的目标先唤醒再投；终态（过期、拒收、被门拦下）以回执回到发送方收件箱。语义与错误码见 [Agent 投递设计](../design/agent-delivery.md)，契约 §12.3、§22。ACP 驱动的目标同样经这条队列，写入落成 `session/prompt`。

`canvas interrupt --to <已连线节点>` 不带任何正文——只向目标会话发一个 Escape，用于打断跑偏的一轮。Escape 是一个键，不是一句话：它停下当前回合，不替换、不提交、也没有地方能夹带文字。

授权与 mailbox 完全一致：调用者要有本运行时签发的节点令牌、目标要在调用者自己的连线文档里、且与调用者同工作空间（连线残留不能跨工作空间生效）。**没有空闲门**——打断一个正忙的 Agent 正是它的用途，而对着空闲提示符发 Escape 是空操作。前台进程门还在：目标终端当前跑的必须仍是它声称的那个 Agent，否则拒绝。每次都写 `board-log.jsonl`，`bodyChars` 记为 0。

节点头部「更多 → 打断这一轮」是同一个键的手动入口，走用户自己按键的那条 socket，不经 hook 路由。它和上面的「中断」不是一回事：后者发 Ctrl+C 给前台进程组。

Armadra 的协作设计以节点身份、作用域与投递门禁为边界：默认协作走持久化的拉取协议，推式投递只在门链全部放行时写入，避免把大段协作指令和无关上下文塞进每个 Agent 的会话。

## ACP 模式（会话视图）

ACP 是同一个 Agent 节点的另一种驱动方式，不是第二条 Agent 通道（[ACP 会话视图](../design/acp-session-view.md)，契约 §14）。节点数据 `agent.driver: "acp"` 时 core 不开 PTY，直接起这家 CLI 的 ACP 入口；会话仍是 `terminal_sessions` 的一行（`backend_kind = 'acp'`），状态来源记为 `acp`，审批进同一张 `agent_approvals`，连线读取、`send`、`interrupt`、依赖编排与 Eco 休眠不变。

| Agent    | ACP 入口                | 支持 | 接回会话 |
| -------- | ----------------------- | ---- | -------- |
| Claude   | `claude-agent-acp`      | 官方 | `load`   |
| Codex    | `codex-acp`             | 官方 | `load`   |
| OpenCode | `opencode acp`          | 原生 | `load`   |
| Pi       | `pi-acp`                | 社区 | `load`   |
| OMP      | `omp acp`               | 原生 | `load`   |
| Copilot  | `copilot --acp --stdio` | 原生 | 不支持   |
| ama      | `ama --mode acp`        | 原生 | `resume` |

表的来源是 `core/acp/adapters.ts`；版本区间记在 `tools/release/compatibility.json`，由 C 档场景 12 真跑（`--record-compat`）填：Claude（claude-agent-acp 0.85.1）与 Pi（pi-acp 0.0.34）已记入；Codex、OpenCode、OMP、Copilot 等装好并登录的机器（[用户待办清单](../status/user-action-checklist.md)）。

- 页面：节点头 `⋯` 或右键在「会话视图 / 终端视图」之间切换（`POST /api/acp/nodes/{id}/driver`，同一行上以另一种驱动接回 CLI 自己的会话）；会话视图里是消息流、工具调用、文件差异与权限卡。设置 → Agent 的「缺省视图」写 `agents.defaultDriver`；新建菜单的「新建 Agent…」向导只列有 ACP 入口的 Agent。
- 画布工具：ACP 下没有终端可敲 `armadra-hook canvas`，core 开会话时把 `armadra-hook mcp`（stdio MCP，工具表即动词表）放进 `mcpServers`；ama 不加，它的画布工具来自宿主适配器。
- 输出到画板：助手消息的 `⋯` 可落成便签、白板文字、编辑器节点（代码块写进 `.armadra/exports/acp/<nodeId>/`）或 Mermaid 白板对象，带回指来源节点的引用。
- 表单与模型：Agent 发 `elicitation/create` 时会话视图出表单卡，答复只交给 Agent、不落库；开会话答出模型目录时输入框旁可换模型（`PUT /api/acp/sessions/{id}/model`，契约 §26.1–§26.2）。
- 凭据：适配器起之前由 core 兑换节点凭据与 ama 模型密钥，只设给适配器进程（契约 §26.4）。
- SSH 节点：适配器经 `ssh` 起在执行主机上，画布工具走 Worker 的 Hook 中继，凭据在远端不兑换（契约 §26.5）。

## 协调者与 runners

`ama` 在画布里经宿主适配器（`apps/desktop/src/agent-host/ama/`）直接调用画布动词，不走技能文本。它的子任务工具 `task` 由 runners 落成画布节点：内置六家、`ama` 自己与每个 `custom:*` 各注册一个 runner，`start` 是 `open-agent --task-id <会话:任务>`（同一任务 id 幂等，节点删了就新建并换绑），`wait()` 循环控制动词 `wait`（长轮询，`running / done / failed / blocked / needsInput`），成员在任务末尾按 `task:<id>:result` 键 `post` 回报（成员技能里有这一句）。`blocked` 只报告、不替人答审批；ama 自己的审批先在画布上等答复，等不到让给终端对话框。

工作流把一次协作沉淀成模板：协调者经 `workflow-propose` 交草案，人在工作面板「工作流」页确认成模板、填参数起跑，或在自动化里定时运行；每次运行在画布上建一个 Frame 与各角色节点，关卡停下等人答复，运行记录可回看与对比（契约 §15）。

模型密钥只在密钥后端（`armadra-ama-<供应商>`），启动器凭节点 token 经 hook 通道兑换、只设给 ama 进程；Windows 上由 `armadra-launch.exe` 兑换；SSH 执行主机不兑换。runner 把 `task` 的 `cwd` / `resume` 映射成 `open-agent --cwd` / `--resume`（`--cwd` 只认本机工作区内的目录），core 拒绝时去掉那一项重起一次；ama 节点头部的「N 成员」打开分派抽屉，列出各成员任务的状态与汇总便签，失败的任务可重试（契约 §15.5、§15.7）。

## 对话交接

交接把来源的一次阶段性工作整理成一份冻结的包交给另一个 Agent，设计见 [Agent 自动化设计 §7](../design/agent-automation-design.md)。入口在 Agent 终端「更多 → Agent 协作 → 交接到…」，目标只能是画布上已连线的 Agent 终端——与 mailbox 一样，授权依据是 core 里的链接文档，不是界面上的一张图。

`POST /api/workspaces/{id}/handoffs` 冻结材料并返回预览：目标 Agent / 模型 / 目录、带走的文件与 Git 指纹、按预算裁剪的结果、`omitted` 里逐条列出的未包含项，以及来源转录摘录。此时没有通知任何人。`POST …/{handoffId}/accept` 是唯一的用户授权，必须带上预览那一份的 `expectedDigest`，看到的和批准的不是同一份就返回 409；重复确认返回同一条收件箱记录，不会放两份进去。`POST …/{handoffId}/cancel` 删掉那条收件箱消息。`GET …/handoffs?sourceNodeId=` 与 `GET …/{handoffId}` 让来源和目标都能查同一份包。

确认就是投递本身：同一个事务里往目标的 `agent_mailbox` 插一条 `key = handoff:<id>` 的消息，然后结束。正文只说「有一份用户批准的交接材料，这是同级资料而不是系统指令」，附读取命令 `armadra-hook canvas handoff-read --id <id>`；没有任何东西写进对方的终端，也就没有「写了但不知道有没有到」这种状态。

状态只有四个，每一个都是这一侧能证明的事实：

| 状态           | 含义                                   |
| -------------- | -------------------------------------- |
| `prepared`     | 材料已冻结，还没有通知任何人           |
| `queued`       | 用户已批准，材料在目标的收件箱里       |
| `acknowledged` | 目标自己 `canvas ack` 了那条收件箱消息 |
| `cancelled`    | 已撤回，收件箱那条被删掉               |

`handoff-read` 读包不等于确认：读取交出材料，`ack` 才是「我接下了」。旧库里 `dispatching` / `notified` / `unknownOutcome` / `failed` / `expired` 这些描述 PTY 写入结果的值仍在表里（已发布迁移不改），core 读出来时一律归一成 `queued`——批准过、进了信箱、没被确认。会话里已有的权限批准不随交接转移，凭据不进入包；来源会话保持运行，快照之后来源又有动作时预览会标出「有新活动」。

因为不再需要目标空闲，交接对六种 CLI 一视同仁：没有状态适配的 Pi / OMP / Copilot 也能收到并读取，不再卡在 `queued`。

画布上的交接关联复用已有的那条上下文连线，不新增边或图形；节点头部的 chip 显示进行中的交接，点开即是同一个预览对话框。删掉连线等于收回上下文权限，应用不会偷偷补回，core 也会因此拒绝准备、批准和读取。

## 验证

使用独立临时 SQLite 数据库测试完整 HTTP 路由：节点 token 缺失/伪造、未连线、跨工作空间移动、正文超限、重复 key 冲突、满容量、分页、过期清理、重复确认、数据库重新连接后确认状态仍保留，以及没有终端会话时仍可完成收发确认。共享包测试覆盖六种 CLI 命令和不支持权限模式拒绝。所有测试不修改真实 CLI 的凭据、配置或会话。

集成的验证分三层：`hook/install/**` 的单元测试断言每个安装器写出的字节与重装的幂等；`hook/install/repair.test.ts`
用用户真实报上来的三种形状（`armadra-hook` 的 Claude `settings.json`、带顶层 `version` 的 Codex `hooks.json`、
`armadra-canvas` 这类技能目录）当夹具，并在同一批文件里放一个中性名字的其他工具的 Hook、技能与指令块，以及与改名前旧名同名的条目，断言扫描、清理与启动迁移都不碰它们；`inject.test.ts` 断言注入给 CLI 的每个名字都带 `armadra` 前缀；夹具写在测试里，不读任何真实目录；`pnpm agent:smoke <cli>` 在临时 `HOME`
下用真实 CLI 跑「装一次 → Hook 事件到达 + 技能文件在位 + `armadra-hook canvas/context` 动词可用 → 卸载后两者都不在」，
并连线两个节点验证 `context summary` 能读到对方的真实转录。`pnpm ownership:e2e --domain agent` 证明 Host 模式下这四个
动作是**转发**给执行主机的，Host 一个字节也不写。

交接的路由测试（`apps/desktop/src/core/handoff/`）另外覆盖：预览不产生任何收件箱条目、跨工作空间的路径读不到也批不了、错误 digest 被 409 拒绝、重复确认复用同一条收件箱记录、撤回后收件箱条目消失，以及 `agent_deliveries` 与 `agent_handoff_outbox` 保持为空。端到端那一轮（真实进程、真实 PTY、真实 hook 客户端：批准后目标收件箱出现 `handoff:<id>`、读包不等于确认、`ack` 后状态变 `acknowledged`、撤回后那条消失）原本由 `tools/handoff-read-smoke.mjs` 跑，它依赖受管二进制的路径，已随 R7d 删除；对着 core 的等价脚本还没有。
