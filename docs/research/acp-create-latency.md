# 右键创建 ACP Agent 慢：根因与调优方案

调查日期：2026-10-08。基线为 main `20248839`（v0.2.2）。只做调查，没有改仓库代码。

## 结论

1. **Armadra 自己的链路不慢。** 在隔离环境里，core 从收到 `POST /api/acp/sessions` 到 spawn 适配器约 14 ms。其余步骤（解析程序、注入、set_mode、set_model、读 log）加起来不到 50 ms。全程没有 npx、login shell、which 或版本探测，也没有全局锁和轮询。
2. **主要耗时在适配器的 `session/new`，页面又要等它返回后才让节点能用。** `session/new` 会同步跑完对应 CLI 的整套启动：
   - Claude：启动 SDK 自带的 236 MB `claude` 二进制，加载设置、插件和技能，并**同步执行 SessionStart hook**。已验证：加一个 3 秒的 hook，`session/new` 就多 3.28 秒。
   - Codex：两次 `account/read`（ChatGPT 登录时要做 workspace routing discovery 和 token 刷新，都走网络），再加 `thread/start` 和 `model/list`。
3. **安装或升级适配器后第一次创建是冷启动。** 两个适配器各自带一份约 240 MB 的 CLI 二进制，和终端方式用的 CLI 不是同一个文件，所以缓存不能共用。实测首次 Claude 用了 5.1 秒，热启动只要 0.45 秒。
4. **体感上明显比终端慢，因为 ACP 不能先显示一点东西。** 终端节点 70 ms 就能看到 shell；ACP 节点在 `session/new` 返回前只有骨架屏，输入框也是禁用的。另外 `session/new` 没有截止时间（`initialize` 有 30 秒），Codex 的网络探测卡住时，页面会一直停在骨架屏。

我的临时 HOME 里没有真实账号、插件和 hook，所以第 2 条在用户真实环境里的数值（估计几秒）**无法在隔离环境测到**。下面「诊断建议」给出了在用户机器上直接确认的办法。

## 方法

所有临时脚本都在 `/tmp/acp-lat/`，不提交：

- `bench.mjs`：直接用 `@armadra/agent/acp` 的 `AcpClient` 起适配器，记录 spawn、initialize、session/new、set_mode、set_config_option 各自的时间点。可以选择是否注入 mcpServers（`armadra-hook mcp` 或一个人为调慢的 MCP），也可以给临时 Claude 配置写 hook。
- `trace.cjs`：用 `--require` 预加载进 core，给 `child_process` 的 spawn/exec 和 ACP 帧打点。
- `e2e.mjs`：用 esbuild 把当前源码打包成 core（`/tmp/acp-lat/core/main.js`），加上隔离的 `ARMADRA_DATA_DIR` 和临时 HOME（`probe-home.mjs`）。通过 HTTP 跑 `POST /api/acp/sessions`，并和 `POST /api/terminals` 加敲启动行做对比。
- `mcp-ready.mjs`：测 `armadra-hook mcp` 从启动到 `initialize` / `tools/list` 应答的时间，分别用 node 和打包的 Electron 作为运行器。
- `slow-mcp.mjs`：一个人为调慢的 MCP 服务器。

测试用的 Codex 凭据是写在临时 `CODEX_HOME/auth.json` 里的假 API key（`sk-probe-dummy-not-a-key`），所以不会经过 ChatGPT 的 routing discovery。pi 没有登录，只测到 `auth_required` 为止。所有进程都按 pid 或进程组结束，tmux 只用自己的 `-S` socket。

适配器版本：claude-agent-acp 0.88.0（SDK 0.3.293），codex-acp 2.1.1（自带 codex 0.159.3），pi-acp，opencode。机器上 node 是 26.10.0（mise）。

## 链路与耗时分解

### 右键创建的完整链路

1. 画布右键菜单项 `add.agent.<id>`（`apps/web/src/canvas/menus/add-menu.ts:165`）调用 `addNode`，节点数据带 `driver: preferredDriver(agent)`。默认驱动是 `acp`，前提是适配器已安装。这一步纯本地，约等于 0 ms。
2. `TerminalNode` 用 `React.lazy` 加载 `SessionView`（打包后 123 KB）。`useAcpSession` 发起 `acpApi.createSession`，也就是 `POST /api/acp/sessions`（`apps/web/src/acp/SessionView.tsx:46`）。
3. core 侧 `routes.ts::createSession`：`need()` 等 `wiring.ready`（只有 core 刚启动后的第一次需要等）→ 按节点加 `exclusive` 锁 → `prepare` → `manager.spawn(backend:"acp")` → `AcpBackend.create` → `AcpRuntime.open`（`acp/index.ts`）。
4. `open` 依次做：`adapterFor`、`acpInjection`（同步写文件）、凭据兑换（只有节点配置了凭据时才做）、`startAdapter`（`resolveCommand` 是同步 stat，`agentPath` 是一次 readdir）、`acpMcpServers`。
5. `startAcp`（`acp/host.ts`）：spawn（detached，不经 shell）→ `initialize`（30 秒截止）→ `session/new`（带 mcpServers，**没有截止时间**）→ 需要时 `set_mode` → 需要时 `set_config_option`。
6. 返回会话行。页面写回 `sessionId`，然后 `GET …/log`，状态变成 ready，输入框可用。期间没有轮询，后续靠事件推送。

### 隔离环境实测（热缓存，单位 ms）

| 段 | fake | claude-agent-acp | codex-acp（假 API key） | pi-acp | opencode acp |
|---|---|---|---|---|---|
| core 路由 → spawn | ~14 | ~14 | ~14 | ~14 | — |
| spawn → `initialize` 应答 | 40–46 | 175–222 | 136–194（首次 366） | 87–110 | 693–1011 |
| `session/new` | <1 | 245–320（`sdk-initialize` 246–620） | 22–87 | ~200 后返回 auth_required | 378–398 |
| `set_mode` / `set_config_option` | — | 20–28 / 2–3 | 1 / 1 | — | — |
| `POST /api/acp/sessions` 总耗时 | 54–58 | 439–764 | 178–218 | 322（502 auth） | — |
| `GET …/log` | 1–2 | 1–2 | 1 | — | — |

### 影响因素与对照实验

| 因素 | 结果 | 是否在关键路径 |
|---|---|---|
| 适配器刚安装后的首次创建（Claude） | initialize 792 + session/new 4283 = **5.1 s**；第二次 0.45 s | 是：二进制要换页并过 macOS 的首次执行扫描；SDK 自带的 claude 有 236 MB，codex-acp 自带的 codex 有 240 MB |
| Claude 的 SessionStart hook（`sleep 3`） | session/new 从 0.25 s 变成 **3.28 s** | **是**：用户自己的 hook 和插件 hook 全部同步执行 |
| 慢 MCP（3 s 后才应答） | Claude 和 Codex 的 session/new 都不变 | 否：MCP 在后台连接，最多影响首个回合 |
| `armadra-hook mcp` 就绪 | node 40–48 ms，Electron 运行器 61–93 ms | 否 |
| Electron 作为 node 冷启动 | 70 ms（首次 210 ms）；node 30–40 ms | 只影响每个 hook 事件 |
| 3 个 Claude 并发 | 每个 0.77–0.90 s（串行时 0.43–0.54 s） | CPU 争用，影响不大 |
| core 内部的 which、解析、注入 | trace 显示创建期间 core 只 spawn 了适配器一个进程 | 否 |
| login shell | ACP 链路不用；codex app-server 会异步生成 zsh 快照 | 否 |
| Codex 真实 ChatGPT 登录 | 测不了。代码路径是 `account/read` ×2（`authRequired` + `getAuthStateForProvider`）→ `thread/start` → `model/list`，其中 routing discovery 和 token 刷新走网络 | **是**（同一步骤在终端方式下出现过约 15 秒超时，见第二部分） |

### 和终端方式对比（tmux，临时 HOME，没有 rc 文件）

| 段 | 耗时 |
|---|---|
| `POST /api/terminals` | 57 ms |
| 第一屏 shell 输出 | **70 ms**（节点马上就能看到东西） |
| 敲下启动行（等 400 ms 无输出后） | ~510 ms |
| Claude TUI 出现 | 0.57–1.7 s |

两者都要完整跑一遍 CLI 启动，终端方式实际上并不更快。差别在于终端方式 70 ms 就能看到 shell，CLI 的启动过程也看得见；ACP 要等全部完成才显示，所以用户觉得「慢」。

## 根因排序

1. **（主因）CLI 启动全部压在 `session/new` 里同步完成。** Claude 的 `sdk-initialize` 包括启动 236 MB 二进制、加载设置、插件、技能，并同步执行 SessionStart hook。Codex 是 `account/read` ×2（网络）+ `thread/start` + `model/list`。这一段的时长取决于用户自己的 hook、插件数量和网络，在真实 HOME 下很可能是几秒，Armadra 控制不了。
2. **（放大因素）页面在 `session/new` 返回前什么都不给。** 只有骨架屏，输入框禁用，没有阶段提示，也没有截止时间。`session/new` 卡住时页面一直转。
3. **（偶发但明显）冷启动。** 安装或升级适配器（含 Armadra 的「重新安装」）、系统重启后的第一次创建要多 3–5 秒。适配器自带的 CLI 和终端方式用的 CLI 不是同一个文件，两边的缓存互不帮忙。
4. **（小头）** 每个节点都要新起一个 node 进程并加载适配器模块，约 0.2 s。codex-acp 要经过两次 node 中转（codex-acp → codex.js → 原生程序）。opencode 的 initialize 约 0.7–1.0 s。
5. **已排除：** core 路由和锁、`resolveCommand` 和 `agentPath`、注入准备、MCP 注入（不等待）、set_mode/model、读 log、懒加载 chunk、事件轮询、npx、login shell、重复的版本探测。

## 诊断建议（在用户机器上确认主因）

- 现在 core 只把适配器的 stderr 字节数记进 debug 日志（`acp/index.ts` 的 `onStderr`）。claude-agent-acp 会往 stderr 打 `[session/create] phase=<名> durationMs=<n>`。建议**只解析阶段名和毫秒数**，记成 info 日志（只取数字，不写正文，符合「终端原始输出不进日志」的规定）。同时在 `startAcp` 里记录 spawn、initialize、session/new、mode、model 各段耗时。用户复现一次就能知道 `sdk-initialize` 是几秒。
- 让用户暂时禁用 `~/.claude` 里的 SessionStart hook 和插件再对比一次。这一步只能由用户自己做。

## 短期优化（按收益排序）

1. **先显示节点，允许先输入**（收益最大，改动在页面）。不再在会话就绪前禁用 `PromptBox`：第一条输入在前端排队，或者放进 `createSession` 的 `prompt` 字段一起发（`routes.ts` 已经支持，会在开好会话后通过 `writeSubmit` 投递）。骨架屏换成阶段提示：「启动适配器 / 连接 / 加载配置」。阶段需要一个新事件（例如 `acp.starting { phase }`），属于接口形状变化，要在 `core-json-api.md` 新增 §N，不能复用已有节号。
2. **给 `session/new` 加截止时间**，例如 60 秒，超时返回 `acp_session_timeout`。现在 `host.ts` 的 `opener.newSession(cwd)` 不带 signal，Codex 的网络探测卡住时会一直挂着。
3. **预热**：
   - 适配器安装或升级成功后，以及 core 启动后空闲时，自动调用一次 `probeAcp`（只跑到 initialize）。另外直接执行一次适配器自带 CLI 的 `--version`（Claude 是 SDK 包里的 `claude`，Codex 是 codex-acp 的 `node_modules/@openai/codex`），把首次执行扫描和换页提前做掉。冷启动的 5 秒可以降到约 0.5 秒。
   - 右键菜单打开时，或悬停在默认驱动为 ACP 的 Agent 项上时，预先 spawn 并完成 `initialize`，用户点击后直接 `session/new`，10 秒内没用就收掉。能省 0.2–1 秒（opencode 收益最大）。
4. **缓存解析结果**：`resolveCommand` 和 `agentPath` 现在每次都要 stat 和 readdir。耗时不到 5 ms，可以以 PATH 加 mtime 为键做缓存，但优先级低。
5. **不需要调整的部分**：`applyMode` 和 `applyModel` 已经是会话开好后的廉价 RPC（2–28 ms），不值得并行化。MCP 注入已经是异步的，保持现状。

## 长期方案

1. **常驻适配器池**：按 (agentId, 环境签名) 预先 spawn 并完成 initialize 的进程，每类保留 1 个。只省 spawn 和 initialize（0.2–1 秒），省不掉 `session/new`。节点有凭据时（§26.4 只把密钥设给该进程的环境）不能用池里的进程。
2. **预建会话池（能省掉主因，但有前提）**：按 (agent, 工作空间根目录, 模式) 预先完成 `session/new`，创建节点时直接领用，领用后再 `set_mode` / `set_config_option`（实测很便宜）。前提条件：
   - mcpServers 的环境变量在 `session/new` 时就绑定了 `ARMADRA_NODE_ID` 和会话行。要改成**延迟绑定**：MCP 服务器在领用时再从 core 获取身份，例如用 `<data>/acp-bind/<poolId>` 或一个带池 id 的令牌，并且必须经过连线授权校验，否则有越权风险（P1）。
   - 只适用于 cwd 是工作空间根目录的节点。
   - 预建会话也会触发用户的 SessionStart hook，可能有副作用。必须由用户主动开启（opt-in），并且限制空闲时长。
3. **一个适配器进程承载多个会话**：ACP 允许一条连接上开多个会话，claude-agent-acp 和 codex-acp 都支持。这样每个工作空间每种 Agent 只需一个适配器，codex-acp 共享一个 app-server，`account/read` 的结果能复用。但这会打破现有的「一个节点一个进程」约定（pid 前台门、进程树回收、按节点休眠、按节点注入凭据），只能作为可选模式，并且只适用于没有节点凭据的节点。
4. **跨驱动复用会话**：切换驱动和休眠唤醒已经用 `session/load` 接回。重点是避免对长会话做全量回放：优先用 `session/resume`（不回放），只有镜像为空时才回放。

---

# 第二部分：canvas_team 一次起 3 个 Codex（终端方式），第 3 个启动失败

现象：`account/read failed during TUI bootstrap: … workspace routing discovery timed out (code -32603)`。启动行是 `<data>/integration/run/codex`，解析到 `~/.local/share/mise/shims/codex`，耗时约 17 s；另外两个正常。

## 事实

- **启动器**（`hook/install/launcher.ts`）：`run/codex` 是 `#!/bin/sh`。有 `ARMADRA_NODE_ID` 时追加注入参数后直接 `exec "$@"`，**没有锁、没有排队、没有重试**。Codex 不设 `CODEX_HOME`（与用户共用 `~/.codex` 和登录态），没有节点凭据时也不兑换任何密钥。注入的参数是 `--dangerously-bypass-hook-trust -c check_for_update_on_startup=false -c hooks.<事件>=… -c developer_instructions=…`（`inject.ts::codexArgs`），每个节点内容相同。
- **canvas_team 和 open-agent**（`collab/control/nodes.ts`）：没有依赖关系时 core 不启动进程，由页面挂载节点后各自创建 PTY 并在 shell 安静 400 ms 后敲启动行。所以 3 个 Codex 几乎同时启动。仓库里没有任何错开启动（stagger）或启动信号量的代码。
- **程序名**：启动行里写的是裸名 `codex`，经 PATH 先找到 mise shim（指向 `mise` 的符号链接）。链路是 mise 解析版本 → `node codex.js` → 原生 codex 0.160.0。多了一个 mise 进程和一个 node 进程，每次几十到几百 ms。
- **Codex 0.160 的 TUI 默认连接共享的后台 app-server daemon**。二进制里能找到这些字符串：`--no-daemon`、`existing_daemon / auto_start`、`local daemon connection failed; starting embedded app server`，以及「To work without the background server, rerun the same command with --no-daemon」。本机 `ps` 显示有一个已运行 2 天的 `~/.codex/packages/app-server-daemon/releases/0.161.0…/codex app-server daemon pid-update-loop`。也就是说 TUI 0.160、daemon 0.161、codex-acp 自带的 0.159.3 三个版本共用一个 `~/.codex`。
- **routing discovery 有共享状态和超时**。相关字符串：`workspace routing discovery timed out`、`workspace routing owner is unavailable`、`account changed during workspace routing discovery`、`configuration changed during workspace routing discovery; retry account/read`、`agent identity bootstrap retry suppressed during shared cooldown`、`Skipping token refresh because auth changed after guarded reload`。
- **复现：Codex 启动本身不能安全并发。** 在全新的临时 `CODEX_HOME`（假 API key）里同时启动 3 个 TUI，**3 个里死了 2 个**，报错是 state DB 迁移竞争：`table backfill_state already exists` 和 `table stage1_outputs already exists`。在已经初始化过的 HOME 里同时启动 5 个都正常，但假 API key 模式不走 routing discovery，所以真实失败的那一步复现不了，需要真实 ChatGPT 账号才能验证。

## 可能原因（按可能性排序）

1. **3 个 TUI 同时 bootstrap，同时对同一账号做 `account/read`。** 无论是经共享 daemon，还是各自的 embedded app-server，都会同时触发 workspace routing discovery 和 token 刷新。按字符串看，这一步有「owner、冷却、配置或账号变化后重试」等共享状态，并发时有一个等到了超时（约 15 秒，加上 mise、node、shell 启动接近 17 秒）。Armadra 没有加锁，但**同时启动是 Armadra 造成的**。
2. **几个 TUI 同时自动启动或连接 daemon**（`already_running / started / restarted`）。如果其中一个触发了 daemon 重启，另一个正在进行的 discovery 就会被取消或超时。
3. **每个客户端都带 `-c` 配置覆盖。** 在共享 daemon 模式下，可能触发「configuration changed during … discovery; retry」分支，导致反复重试直到超时。这是推测，需要用真实账号验证。
4. 次要因素：mise shim 在并发下可能有锁或版本解析开销；网络本身慢。

## 修复方向

1. **按 (agentId, 配置目录) 错开启动**：在 core 里加一个启动闸门，页面敲启动行前先申请，open-agent、team、定时冷启动都走同一个闸门。Codex 默认要等上一个实例就绪（收到 SessionStart hook，或者等满 3–5 秒）再放行下一个，加 0.5–1.5 s 抖动。这能同时避开迁移竞争和 discovery 竞争，代价是 3 个节点要多等几秒才全部就绪。
2. **启动失败自动重试一次**：节点在 30 秒内退出，并且屏幕或退出原因里出现 `failed during TUI bootstrap`，就退避 2–5 秒后重新敲一次启动行。第二次仍失败就在节点头显示失败原因和「重试」按钮，不要让投递一直等待首次空闲。
3. **评估画布启动时是否加 `--no-daemon`**：
   - 好处：每个节点用独立的 embedded app-server，不争共享 daemon。并且 hook 子进程一定继承节点终端的环境（`ARMADRA_NODE_ID`）。
   - **风险（需要优先验证）**：如果 daemon 模式下 hook 由 daemon 执行，hook 拿到的就是 daemon 的环境而不是节点的，状态和投递会算错节点，甚至没有身份。建议用真实账号在两个节点上分别触发 SessionStart，看 hook 报上来的 `ARMADRA_NODE_ID` 是否正确。
   - 代价：用不了 agents overview 等共享功能，内存更高。
4. **启动行里写绝对路径**：`GET /api/agents` 已经有 `resolvedPath`，传给 `run/codex` 就能绕过 mise shim，少一层进程，也避开 mise 的并发开销。
5. **超时**：没找到 Codex 暴露的 discovery 超时配置项。Armadra 侧应该缩短「投递首条任务」对启动失败节点的等待时间，并把这类失败做成可识别的错误码。
6. **ACP 方式有同样的风险**：team 一次起多个 ACP Codex 节点时，每个 codex-acp 都会起自己的 app-server，同时 `account/read` 两次。而 `session/new` 没有截止时间（见第一部分短期优化第 2 条），出错时页面会一直挂着。建议闸门对 ACP 的 `startAdapter` 同样生效（例如 Codex 并发度限制为 1，或者错开 1–2 秒）。
7. **版本不一致的风险**：codex-acp 自带的 0.159.3、TUI 0.160 和 daemon 0.161 共用 `~/.codex` 里的 SQLite（`state_5.sqlite` 等）。旧版本遇到被新版本迁移过的库可能启动失败。可以在集成页提示版本差异，或者让 codex-acp 通过 `codexPath` 使用用户自己的 codex（需要确认适配器是否开放这个选项）。
