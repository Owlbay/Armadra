# Claude Code mods（函数式 hooks 模块）对 Armadra 注入的可行性分析

日期：2026-10-10 · 只读调研，原型只在 `/tmp/armadra-mod-proto/`，用隔离的 `HOME` / `CLAUDE_CONFIG_DIR`、本地假 Messages API（`127.0.0.1:18765`）和一把假 key，没碰 `~/.claude`，也没登录任何真实账号。

## 0. 结论

- **能做，值得做，但只能当一层「增强」，不能替换现有注入。** 在本机 2.1.287 上实测：`--plugin-dir` 指向的插件只要带 `hooks/hooks.json {"modules":[...]}`，在交互式和 `claude -p` 下都会直接加载，不需要开关，没有信任确认（工作区信任对话框照旧出现），也不用写用户配置。
- **收益最大的是状态上报。** mod 用 `classic.*` 事件拿到的 `e`，就是 shell hook 从 stdin 读到的那份 JSON（字段逐一对过），原样 POST 到现有的 `/hook/claude`，core 的 ingest 一行都不用改。每个事件从「起一个 Electron-as-Node 进程，约 78 ms、峰值 RSS 约 58 MB」降到进程内 1–20 ms，零子进程。
- **用户看得见的增强**：状态栏（`$.ui.status`）、横条（`AbovePrompt`）、toast、斜杠命令。值得做，但 API 是 early access，287→293 六个版本里 `.d.ts` 改了约 1575 行，要按版本门槛加探测和降级。
- **必须留在 shell hook 的**：`PermissionRequest`。它要等画布上的人来点允许或拒绝，等待可能超过 mod 每个 hook 10 s 的预算；而且由 mod 去答权限会碰「不得替人回答」这条线。
- **推荐分阶段**：M1 状态上报 + 状态栏（替换除 `PermissionRequest` 以外的 shell hooks）→ M2 横条 + toast → M3 斜杠命令 / ACP 下也挂上 mod。`prompt.compose` 替代技能文本**不推荐**。

## 1. 现状：我们怎么给 Claude Code 注入

入口是 `apps/desktop/src/core/hook/install/inject.ts`。产物都写在 `<data>/integration/claude/` 下，由画布启动器 `<data>/integration/run/claude` 只在 `ARMADRA_NODE_ID` 存在时追加 argv（`injectionFromLayout`，约第 1125 行）。

| 能力 | 实现 | 延迟 / 开销 |
|---|---|---|
| 状态上报（11 个事件） | `--settings <dir>/settings.json`，里面是 `CLAUDE_HOOK_EVENTS`（`events.ts`：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Notification、PermissionRequest、Stop、StopFailure、SessionEnd、SubagentStart、SubagentStop）。每个事件是一个 command hook：`armadra-hook claude`，`timeout: 5`。`armadra-hook` 是 POSIX 启动器 `ELECTRON_RUN_AS_NODE=1 exec <electron> cli/armadra-hook.js`（`src/cli/armadra-hook/launcher.ts`）。每次调用都重读 `hook-endpoint.env` 和节点 token，经 Unix socket 去 `POST /hook/claude` | 实测（打包版 Armadra.app，warm）：**每个事件约 78 ms，峰值 RSS 约 58 MB**，没有 node id 的 no-op 路径约 60 ms，这还没算 Claude 自己 `sh -c` 的开销。一次工具调用至少要起 Pre + Post 两个进程，PreToolUse 是同步的，会直接加在工具延迟上；子代理、通知再各起一个 |
| 权限审批 | 同一个 hook client。`PermissionRequest` 设了 `ARMADRA_PERM_WAIT_SECS` 时，写 pending 文件、轮询画布上人的回答，再打印 allow/deny 的 JSON（`hook.ts::runPermissionWait`） | 进程会一直挂到人回答为止 |
| 技能 | `--plugin-dir <dir>/plugin`，里面是 `.claude-plugin/plugin.json`（name `armadra`）和 `skills/armadra/SKILL.md`（`collab/skill.ts`） | 加载时读一次。技能正文按需进上下文 |
| 画布说明 | `--append-system-prompt-file <dir>/instructions.md`（`canvasInstructions`） | 每轮都在系统提示里，可以吃到 prompt cache |
| 画布动词 | 终端模式：模型经 Bash 调 `armadra-hook canvas <verb>` / `context <verb>`，走 `/control/*`、`/context-link/*` | 每次调用起一个进程（约 80 ms 加上一次模型工具调用） |
| 画布 MCP | **只有 ACP**：`acp/adapters.ts` 里 claude 的 `injection: { mcp: true, reuse: [] }`，`session/new.mcpServers` 带上 `armadra-hook mcp`。注释（D6）写的是 ACP 下没有 `--settings` / `--plugin-dir` 对应 | 每个会话常驻一个 MCP 子进程 |
| 程序自报 OSC 7501 | `core/terminal/program-status*.ts`（契约 §53）。只是展示级提示，不写 `agent_status`，不满足任何门 | 解析 pty 字节，不额外起进程 |

**纠正 D6**：本机 `claude-agent-acp` 0.88.0（内置 SDK 0.3.293，也就是 CLI 2.1.293）的 `acp-agent.js` 会接受 `_meta.claudeCode.options` 里的 `plugins`、`settings`、`extraArgs`、`systemPrompt`（约第 7123、7206 行），并且把 `process.env` 整体透传给 CLI 子进程。所以 ACP 下也能挂插件：要么用 `_meta.claudeCode.options.plugins: [{type:"local", path}]`，要么给适配器进程设 `CLAUDE_CODE_PLUGIN_DIRS`。按 reference.md，这个变量正是给「SDK host 起的会话」用的，只从进程环境或 `~/.claude/settings.json` 的 env 读，项目设置里的不认。

## 2. mods 的可用性（实测 + 文档 + 二进制）

- **版本**：官方 CHANGELOG 在 **2.1.287** 写的是「Added Claude Mods」。2.1.285 的二进制里已经有 `functionHooks` 代码（暗发布），但不应该依赖。之后几乎每个版本都在修 mod：289「installed mods not loading…」，290「mods staying off for people who reach Claude through a gateway」以及 `prompt.submit` 的修复，293「Fixed a mod's hooks on classic.* events」，295「Fixed generated type files being written into a --plugin-dir plugin's folder」。
- **要不要用户开启**：`--plugin-dir` 和 `CLAUDE_CODE_PLUGIN_DIRS` 加载的模块**直接生效**。「Enable for this session / Not now」那张卡只针对 Claude 自己写的会话 dev mods 文件夹（二进制里的 `devModsFolder`、`Mods in … load … They run with your permissions`）。实测：
  - `claude -p --plugin-dir …`：session.start、prompt.submit、turn.start、tool.call 前后、turn.complete、session.end 全都到了 recorder。
  - 交互式 TUI（python pty 驱动）：session.start、session.end 都到了，`$.ui.status` 在提示符下画出了 `⚠ armadra: armadra · node-A`。注意前面那个 ⚠ 前缀，在新版本上要再确认一下观感。
  - `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0` 或 `false` 关不掉（这个变量大概是强制开）。`CLAUDE_CODE_SAFE_MODE=1` 会让插件整个不加载。
- **hot reload**：交互式会话会监视 `--plugin-dir`。我们改了插件文件，正在跑的会话会重载模块（重跑 `register`，丢掉定时器，并且再触发一次 `session.start`）；hook 失败时，transcript 里会多一行暗色提示。`-p` 每次都是全新加载；长时间运行的 SDK / desktop 会话要设 `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` 才会监视。
- **非交互 / ACP**：`-p` 实测会加载。ACP 见第 1 节的纠正，2.1.293 理论上可以，**还没实测**。
- **组织策略**：managed 插件可以在 `plugin.register` 上 `{refuse}` 掉 user 层的模块；`$.http.fetch` 受组织 web-fetch 策略约束；managed settings 的 hooks 在链首，deny 优先。
- **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`**：在 2.1.287 上会**直接拒绝插件的所有 `$.http.fetch`**（`refused: nonessential network traffic is disabled for this session`）。文档说只拒绝带 `auth` 的请求，实际更严。这是硬风险，必须有降级。
- **副作用**：2.1.287–2.1.294 每次加载都会往插件目录写 `tsconfig.json` 和 `.claude-plugin/types/`（约 740 KB），其中 `claude-code-mcp/index.d.ts` 会列出会话已连接的 MCP 工具 schema。这个目录在我们的数据目录里，`removeInjection` 会整个 `rm -rf`，不算越界，但：①不能把它当作我们自己的文件去做字节比较；②里面的 MCP 工具名属于用户信息，不要上传、不要进日志。

## 3. mod 运行环境与能力边界

- 没有 Node、没有 DOM，只能通过 `$` 访问外界；有 Web API（URL、TextEncoder、crypto.subtle）。不能 `import()`；静态分析要求 `$` 只传给顶层的函数声明（实测 `const post = async ($) => …` 被 validate 拒绝了）。`$.env.get` 的变量名必须写成字面量。
- **和 core 通信**：
  - `$.http.fetch(url, { socketPath })`：**支持 Unix socket**，正好对上我们 `hook-endpoint.env` 里的 `ARMADRA_HOOK_SOCK`（远端或 Windows 用 `ARMADRA_HOOK_PORT` 走 TCP）。实测在 2.1.287 可用。
  - `$.fs.read/write`：可以读 `ARMADRA_ENDPOINT_FILE` 和节点 token 文件（单个文件 4 MiB 上限）。也能当降级通道，往 spool 文件写事件。
  - `$.process.run/spawn`：可以退回去调 `armadra-hook`，开销等于今天。
  - **没有入站通道**：core 推不进 mod，只能轮询（`$.clock.every` + fetch）。也可以长连 `$.process.spawn` 一个 watcher，但那等于又常驻一个 Node 进程。
- **预算**：每个 hook 每次派发 10 s（`HookBudget.ms`），`.catch` 1 s，`session.end` 整条链共享约 1.5 s。fetch 的等待不计入预算；`clock.sleep` 计入。
- **注入到模型 / 会话**：`$.session.append`（一条 isMeta 的 user 行，模型能读到，从下一轮循环开始生效）、`$.prompt.submit`（空闲时排一轮）、`session.receive`（拦截投递）、`prompt.compose` / `prompt.section` / `prompt.context`。

## 4. 能替代或增强什么

| 设想 | 评估 |
|---|---|
| **状态上报**（替代 shell hook 进程） | **强烈推荐。** 用 `on("classic.<Event>")` 把 `e` 原样转成 `{nodeId, version:1, payload, terminalBinding?}` 发到 `/hook/claude`，ingest、reduce、契约都不用改。实测 2.1.287 的 SessionStart、UserPromptSubmit、PostToolUse、Stop、SessionEnd 字段和 stdin 版一致；**PreToolUse 在 287 上拿到的是 tool.call 的形状**（`{tool, command, tool_use_id}`），293 已修。门槛设 ≥2.1.293，或者对 287–292 用 `tool.call` 自己拼。Notification、StopFailure、Subagent* 同理（还要逐个实测）。必须 fire-and-forget（`void forward()`），所有异常吞掉，不能挡住工具调用 |
| **权限审批** | **保留 shell hook。** 在 `--settings` 里只留 `PermissionRequest`：它的等待可能超过 10 s 预算，`ARMADRA_PERM_WAIT_SECS` 是秒级到分钟级，而且这是人做的决定，不该让 mod 去答。mod 最多观察 `tool.check` 的 ask 判定，给节点打 `blocked` 提示 |
| **状态栏** `$.ui.status` | 推荐。节点名直接读 `ARMADRA_NODE_NAME`、`ARMADRA_NODE_ROLE`，不用联网；之后可以加未读数或连线数。文案要进 i18n：mod 是生成的源码，可以由 core 生成时从 `apps/web/src/i18n` 同源的表里取，或者干脆只放符号和名称 |
| **横条** `AbovePrompt` | 推荐，放 M2。显示「上游 / 下游连线、待收消息数、派发对象」。数据来源：`/context-link/list` 和 `/control/inbox`（带节点 token），`$.clock.every(2–5 s)` 轮询，结果放 `$.state`。只读展示；按钮最多做「打开画布节点」「收起」，**不做任何代答** |
| **toast**（同级消息到达） | 推荐，和横条共用同一次轮询：未读数上升就弹一次。只放「来自 X 的消息」，**不放正文**（正文是别人的终端或文件内容） |
| **投递**（`session.append` / `prompt.submit` 替代 PTY 粘贴） | 很有吸引力，可以绕开启动对话框里的投递 bug，但会改变投递语义：idle 门、回执、串行门都要重审。**单独立项，不进 MVP** |
| **斜杠命令**（`/armadra-post`、`/armadra-team`…） | 可以，放 M3。`$.command.register` 加上 `command.run` 直接打 `/control/*`，人用的时候不消耗模型 token。名字只用 armadra 前缀；mod 注册的命令会自动带插件命名空间，要实测最终显示成什么 |
| **`prompt.compose` 替代技能或 `--append-system-prompt-file`** | **不推荐。** 现有做法已经是每个节点注入、可缓存的；改了之后旧版本还得保留旧路径，两套并存，收益约等于零 |
| **和 OSC 7501 的关系** | 不冲突。§53 定义的 OSC 7501 是任何 pty 字节都能伪造的展示级提示；mod 上报走的是带节点 token 的 hook 通道，和现在 shell hook 同级（`stateSource: "hook"`），可以作判据。页面合并规则照旧：有 hook 上报时以上报为准，OSC 只补进度 |

## 5. 风险

1. **版本门槛与降级**：<2.1.287 没有 mods。更麻烦的是，旧版本见到 `hooks.json` 里不认识的 `modules` 键，可能让整个插件加载失败，连技能也一起丢（旧版没法测）。→ **mod 单独放一个插件目录**（例如 `<data>/integration/claude/mod/`，manifest name 还是 armadra 前缀，比如 `armadra-mod`），作为第二个 `--plugin-dir`；技能插件保持不动。启动器按探测到的 Claude 版本决定：≥门槛时挂 mod，`--settings` 只留 PermissionRequest；否则维持今天的全套 shell hooks。
2. **双报和漏报**：mod 和 shell hook 同时在时会重复上报；mod 加载失败时会漏报。→ 由启动行二选一，不靠运行时去重；mod 在 session.start 先发一个 `armadra` 自有的 hello（或者 core 从 SessionStart 的来源区分），让集成页能看出「mod 已生效」；用一次 `claude plugin validate` 当安装期自检。
3. **网络被拒**（NONESSENTIAL_TRAFFIC、组织 fetch 策略、`plugin.register` 拒绝）：mod 检测到 fetch 被拒后，退回 `$.process.run([ARMADRA_HOOK_BIN, "claude"], { stdin })`，开销等于今天但不丢事件；或者写 spool 文件让 core 去 watch（要改 core，后议）。mod 整个被拒时没有任何信号，这就是第 2 条 hello 心跳的用处。
4. **运行时**：没有 Node 可用，只有 `$`。静态校验很严（`$` 的传法、env 字面量、不能 `import()`），生成器要按规矩写，CI 里跑 `claude plugin validate`（有 Claude 才跑，跳过不算失败）。
5. **性能**：进程内 hook 便宜，但轮询（横条、toast）是常驻开销。间隔 ≥2 s，只在 `isFullscreen` / 可见时拉，响应只取计数和名称。
6. **API 稳定性**：early access，`.d.ts` 每版都在变。→ 只用核心最稳的那部分（`classic.*`、`session.start/end`、`$.http.fetch`、`$.env.get`、`$.ui.status/toast`、`AbovePrompt`）；`tools/release/compatibility.json` 记已验证版本；core 生成 mod 源码时按版本选模板。
7. **安全约束**：节点 token 只在 mod 内存里，不进 status、toast、日志、`$.store`。生成的类型文件里有 MCP 工具名，属于用户信息，不上传。hot reload 的暗色提示会出现在用户终端里，所以 mod 内部必须全部 try/catch，宁可静默。
8. **远端执行主机**（`remote.ts`）：远端 Claude 的 socket 和端口要用远端 endpoint 文件；mod 只读 `ARMADRA_ENDPOINT_FILE`，不写死路径。

## 6. 分阶段方案

### M1（MVP）：状态上报 + 状态栏
- `apps/desktop/src/core/hook/install/inject.ts`
  - `artifactLayout("claude")` 增加 `modDir`、`modManifest`、`modHooks`、`modModule`（`<dir>/mod/.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.ts`）。
  - `artifactFiles`：生成 mod 三件套；`settings.json` 生成两份，`settings.json` 是全量的，`settings-permission.json` 只含 PermissionRequest。
  - `injectionFromLayout`：多一个 `options.claudeMods` 参数（由探测的版本决定），为真时 `--settings settings-permission.json --plugin-dir plugin --plugin-dir mod`。
- 新文件 `apps/desktop/src/core/hook/install/claude-mod-template.ts`（仿 `extension-template.ts`）：生成 register.ts 源码。依次读 endpoint 文件（解析 `KEY='VALUE'`）、节点 token，`classic.*` 转发；fetch 被拒时用 `$.process.run` 退回 `ARMADRA_HOOK_BIN`；`$.ui.status` 显示节点名。
- `apps/desktop/src/core/agent/probe.ts`：Claude 版本探测，门槛常量 `CLAUDE_MODS_MIN = 2.1.293`（因为 classic.* 在 293 才修好）。
- `events.ts`：`HOOK_CLIENT_REVISION` 或 `INTEGRATION_REVISION` 要加一（产物变了）。
- `remote.ts`：同步 mod 目录。
- 文档：`docs/design/canvas-only-integration.md` 和 `docs/guides/architecture.md` 补 mod 注入；`docs/contracts/core-json-api.md` 的 hook 节**不改形状**（payload 不变）。只有新增 hello 事件时才开新的 §N。
- 测试：
  - `inject.test.ts`：分别快照 ≥门槛和 <门槛两种情况的 argv 和文件；mod 源码里不能出现 `armadra` 以外的注入名；检查 settings-permission.json 只含 PermissionRequest。
  - `claude-mod-template.test.ts`：生成的源码能通过 tsc（用 `.d.ts` 快照，或者 vendoring 一份最小类型）；环境里有 `claude` 时跑 `claude plugin validate`。
  - 集成测试（可选，nightly）：照搬本次原型，假 Messages API + recorder socket + 隔离 `CLAUDE_CONFIG_DIR`，跑 `claude -p`，断言 recorder 收到的 payload 和 shell hook 版逐字段一致（同一份 fixture 走 `hook/normalize/claude.ts`）。
  - 降级：设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 时仍然收到事件（走的是 process 退回路径）。

### M2：横条 + toast
- core 新增一个只读聚合：`/control/overlay`（或复用 `context-link/list` 和 `inbox` 的计数），只返回名称、计数、角色，**不含正文**。要登进契约，开新的 §N。
- mod 用 `$.clock.every(3000)` 拉取，写进 `$.state`；`ui.render {component:"AbovePrompt"}` 画；未读数上升时 `$.ui.toast`。
- 文案：生成时由 core 按界面语言注入一张小表，来源和 `apps/web/src/i18n` 同步，中英两份。
- 测试：`claude plugin test`（kit 的 `mount` 在 terminal / desktop 两个 surface 上各跑一遍），加 core 路由的单测。

### M3：斜杠命令 + ACP 也挂 mod
- `$.command.register` 注册 `armadra-post`、`armadra-team` 等，`command.run` 直接打 `/control/*`。
- `acp/session.ts` 在 `session/new` 的 `_meta.claudeCode.options.plugins` 里放技能插件和 mod 插件，同时把 `settings` 也带上（PermissionRequest 在 ACP 下本来就走 `canUseTool`，不用 shell hook）。顺手修正 D6 的说法。
- 投递改走 `session.append`：另起设计文档。

## 7. 原型与证据

- `/tmp/armadra-mod-proto/mod/`：可以 validate 的 mod（classic.* 转发版）。
- `/tmp/armadra-mod-proto/srv/srv.mjs`：recorder（Unix socket）加假 Messages API。
- `/tmp/armadra-mod-proto/rec.log`、`tui.out`、`debug.log`：实测输出。
- 关键时间（`-p`，2.1.287）：classic.PostToolUse → Stop → SessionEnd 之间间隔约 14 ms；mod 事件从发出到 recorder 收到 1–20 ms。shell hook client warm 时约 78 ms 一次，峰值 RSS 约 58 MB。
