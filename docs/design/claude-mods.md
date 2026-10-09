# Claude Code mods 注入设计（M1–M3）

日期：2026-10-10 · 状态：目标设计；M1（§2、§3、§6 的契约、§7、§10.1、§10.3）已实施，M2、M3 未实施 · 输入：可行性调研（隔离 HOME 下的原型实测）、Claude Code 2.1.293 的 `plugin-authoring/types/claude-code.d.ts` 与 `reference.md`。基线 `main` 9cd38293；下表的行号是那个基线的。契约是 [core JSON API](../contracts/core-json-api.md) §55，实测进度见 [补全进度](../status/completion-progress.md)。

M1 落地时与本文不同的几处（以代码与契约为准）：hello 在宿主拒绝 fetch 时经 `armadra-hook mod-hello` 送达（本文 §2.5 只说「再发一次 process」，没说走哪条路）；core 分配 `sourceRevision` 时计数器文件不存在就不创建（与 hook 客户端同一条规矩），报告不带绑定照常归约；2.1.293 上 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 不再拒绝插件不带 `auth` 的 fetch，`CLAUDE_CODE_SAFE_MODE` 连设置 hook 也不跑——启动器的两条环境回退照旧保留；mod 的 `PreToolUse` 等九个事件都带 `.catch`，`claude plugin validate` 不再报「gating hook without .catch」。

## 0. 结论

- **做成一层「增强」，不替换现有注入。** 技能插件、`--append-system-prompt-file`、`PermissionRequest` 的 shell hook 全部原样保留；mod 只接管状态上报（M1）、加终端内的状态栏 / 横条 / toast（M1–M2）、加 `/armadra-*` 斜杠命令（M3）。
- **一条启动行决定一切，零用户配置写入。** mod 是第二个 `--plugin-dir`（`<data>/integration/claude/mod/`，manifest 名 `armadra-mod`），由启动器 `run/claude` 在启动时按 core 探测到的版本（门槛 **2.1.293**）与进程环境（`CLAUDE_CODE_SAFE_MODE`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`）二选一：挂 mod 时 `--settings` 换成只含 `PermissionRequest` 的 `settings-permission.json`；否则维持今天的全套 shell hooks。ACP 下用 `CLAUDE_CODE_PLUGIN_DIRS` 给适配器进程（M3）。
- **上报走同一条 hook 通道、同一个 ingest。** `classic.*` 的 `e` 经 `$.http.fetch(…, { socketPath })` 原样 POST 到 `/hook/claude`，`stateSource` 仍是 `hook`，与 OSC 7501 的优先级关系照 §53 不变。唯一的 core 改动是 `terminalBinding.sourceRevision` 允许缺席、由 core 代为分配（mod 的 `$.fs.write` 只能写文本，写不了 16 字节的计数器）。
- **新契约只有一节 §55（协议 1.27）**，在第一个实现包里一次写全（预分配，仓库有 §24–§30 的先例）：hook 请求的 `sourceRevision` 可缺席、`POST /node/mod` hello、`GET /node/overlay` 只读计数、`agents.integration.mods`、`ui.locale` 设置。
- **三个实现包**：`claude-mod-m1-status`（core + 启动器 + 契约 + 探针）→ 之后 `claude-mod-m2-overlay`（core 计数接口 + 横条/toast + 设置子页）与 `claude-mod-m3-commands-acp`（斜杠命令 + ACP 挂载）可并行。

## 1. 现状（file:line）

| 事项                                                                                                                  | 位置                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产物布局：`settings.json`、`plugin/.claude-plugin/plugin.json`、`plugin/skills/armadra/SKILL.md`、`instructions.md`   | `apps/desktop/src/core/hook/install/inject.ts:148-168`（`artifactLayout` 的 `claude` 分支）                                                                                |
| 产物内容：`settings.json` 的 11 个 command hook，`armadra-hook claude`、`timeout: 5`                                  | `inject.ts:337-373`（`artifactFiles`），事件表 `events.ts:42-54`（`CLAUDE_HOOK_EVENTS`）                                                                                   |
| 启动 argv：`--settings` / `--plugin-dir` / `--append-system-prompt-file`                                              | `inject.ts:1108-1136`（`injectionFromLayout`）                                                                                                                             |
| 注入是纯函数，只读磁盘与缓存的 Codex 探测                                                                             | `inject.ts:1075-1101`（`canvasInjection` → `launchInjection`），Codex 版本门 `inject.ts:498-551`（`codexTrustsSessionHooks` / `probedCodexVersion` / `codexHooksWarning`） |
| 启动器正文：字面 argv，`ARMADRA_NODE_ID` 为门，两个 `exec`                                                            | `launcher.ts:176-194`（`posixLauncher`），Windows `.launch` 文件 `windows-launcher.ts:98-135`                                                                              |
| 启动器重写与标记（版本 / 平台 / warning 变了就重写）                                                                  | `inject.ts:840-880`（`prepareInjection` 尾段），`currentLauncher` `inject.ts:749-770`                                                                                      |
| 远端执行主机同一份产物                                                                                                | `remote.ts:109-160`（`remoteIntegrationFiles`，`fingerprint` 只算我们写的文件）                                                                                            |
| 节点环境变量：`ARMADRA_NODE_ID/AGENT_ID/NODE_NAME/NODE_ROLE/ENDPOINT_FILE/CANVAS_CONTROL`                             | `core/terminal/environment.ts:314-335`（`agentEnvironment`），`ARMADRA_HOOK_BIN` `environment.ts:273`                                                                      |
| 端点文件 `hook-endpoint.env`：`ARMADRA_HOOK_SOCK` / `PORT` / `TOKEN` / `NODE_TOKEN_DIR`                               | `core/hook/endpoint.ts:43-60`，客户端解析 `hook-client/endpoint.ts:50-55`                                                                                                  |
| 进程内上报的参考实现（Pi / OMP / opencode）                                                                           | `core/hook/install/extension-template.ts:60-260`（端点解析、头、`terminalBinding` 的 `.seq` 计数器、socket → spawn 退回）                                                  |
| ingest：节点 token 判定、`terminalBinding` 必须带正整数 `sourceRevision` 否则整条丢弃、`stateSource` 由 provider 推出 | `core/hook/ingest.ts:107-210`（`usable` 判定在 170-186）                                                                                                                   |
| 可信回合报告与投递完成判定：`sourceRevision > task.sourceBaseline`                                                    | `core/runs/reports.ts:18-60`（`sourceRevision` 读 `.seq`、`recordTrustedReport`），`core/runs/evaluate.ts:66-80`（`considerReport`）                                       |
| Claude payload 归一化：`PreToolUse` 只看 `tool_name`（AskUserQuestion → waiting）                                     | `core/hook/normalize/claude.ts:44-70`                                                                                                                                      |
| ACP：Claude 适配器 `injection: { mcp: true, reuse: [] }`，注释 D6 说 ACP 下没有 `--settings` / `--plugin-dir` 对应    | `core/acp/adapters.ts:97-114`；适配器进程环境 `core/acp/host.ts:765-768`；画布 MCP 服务器的环境 `core/acp/mcp.ts:60-80`                                                    |
| `@armadra/agent` 0.6.8 的 `AcpSessionOptions` 只有 `mcpServers`，没有 `_meta`                                         | `apps/desktop/node_modules/@armadra/agent/dist/drivers/acp/types.d.ts:136-139`                                                                                             |
| 画布动词表与 `POST /control/<verb>`                                                                                   | `core/collab/control/index.ts:46-76`（`VERBS`），客户端 `cli/armadra-hook/control.ts:104-132`（`runCanvas` → `request(/control/<verb>, map)`）                             |
| 待收消息计数                                                                                                          | `core/collab/mailbox.ts:469-531`（`pendingCount` / `unreadDigest`，`unreadDigest` 带正文，**不能**直接外露）                                                               |
| 版本探测缓存：`claude --version`，24 h TTL，启动 3 s 后扫                                                             | `core/agent/probe.ts:33-39,115-140,180-190`（`storedProbe` / `rememberProbe`），落在 `settings.agents.probes`（`core/settings/local.ts:65`）                               |
| 集成状态与 `launcherWarning`                                                                                          | `core/hook/install/integration.ts:270-300`；契约 §13.2（`docs/contracts/core-json-api.md:588-606`）、`agents.integration` 行（`:2847`）                                    |
| 设置子页「画布注入」组：`launcherWarning` 画成「注入受限」                                                            | `apps/web/src/panels/settings/pages/AgentDetailPage.tsx:112,160-176`；文案 `apps/web/src/i18n/integration.ts:28-37`                                                        |
| 界面语言只在页面：`armadra.locale` 存 localStorage，core 不知道                                                       | `apps/web/src/app/preferences-store.ts:87,343,402-404`；core 设置里没有 `locale`                                                                                           |
| OSC 7501 与 hook 状态的合并规则                                                                                       | 契约 §53（`core-json-api.md:3618-3630`），页面 `apps/web/src/agent/status-store.ts:481-540`（`agentHeaderState`）                                                          |
| 协议版本                                                                                                              | `core/identity/protocol.ts:12`（`PROTOCOL_MINOR = 26`）；契约最大节号 §54                                                                                                  |
| 兼容范围                                                                                                              | `tools/release/compatibility.json`（`acp.adapters.claude.verified.min = 0.85.1`）                                                                                          |

## 2. 总体方案

### 2.1 两个插件目录，一条启动行

```
<data>/integration/claude/
  settings.json              全量 11 个 shell hook（不变，字节不动）
  settings-permission.json   新：只有 PermissionRequest
  plugin/                    技能插件（不变，name = armadra）
  mod/                       新：mod 插件（name = armadra-mod）
    .claude-plugin/plugin.json
    hooks/hooks.json         { "modules": ["./armadra.ts"] }
    hooks/armadra.ts         core 生成的 hooks 模块
  instructions.md            不变
```

`artifactLayout("claude")` 增加 `settingsPermission`、`modDir`、`modManifest`、`modHooks`、`modModule` 五个路径；`artifactFiles` 生成四个新文件。**技能插件不动**：旧版本见到 `hooks.json` 里不认识的 `modules` 键可能让整个插件失败（调研 §5-1），所以 mod 必须独占一个目录；两个插件 name 不同（`armadra` / `armadra-mod`），都带 armadra 前缀。

`injectionFromLayout("claude", …, { claudeMods })`：

| `claudeMods`    | argv                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `false`（今天） | `--settings settings.json --plugin-dir plugin --append-system-prompt-file instructions.md`                             |
| `true`          | `--settings settings-permission.json --plugin-dir plugin --plugin-dir mod --append-system-prompt-file instructions.md` |

### 2.2 门：版本在 core 决定，环境在启动器决定

两层，缺一不可：

1. **版本门（prepare 时）**：`claudeLoadsMods(version)`，常量 `CLAUDE_MODS_MIN = "2.1.293"`，与 `codexTrustsSessionHooks` 同形（`versionParts` 复用）。**未知版本答 `false`**（与 Codex 相反：shell hook 是已验证的路径，mod 不是；探测 3 s 后自然补上）。版本来自 `storedProbe("claude")`，`InjectionRequest` 多一个 `claudeVersion?: string | null` 给测试与远端用。门槛选 293 的原因：`classic.*` 事件在 293 才修好（CHANGELOG），287–292 的 `classic.PreToolUse` 形状不对。
2. **环境门（启动时）**：启动器在节点 shell 里跑，看得见用户 rc 设的变量。`LauncherSpec` 增加可选 `fallback: { whenEnvAny: string[]; args: string[] }`；`posixLauncher` 在最后一个 `exec` 前生成：

   ```sh
   if [ -n "${CLAUDE_CODE_SAFE_MODE:-}" ] || [ -n "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-}" ]; then
     exec "$@" '--settings' '…/settings.json' '--plugin-dir' '…/plugin' '--append-system-prompt-file' '…'
   fi
   exec "$@" '--settings' '…/settings-permission.json' '--plugin-dir' '…/plugin' '--plugin-dir' '…/mod' …
   ```

   `SAFE_MODE` 让插件整个不加载（技能也会丢，这是 Claude 的行为，不是我们的），`NONESSENTIAL_TRAFFIC` 在 2.1.287 实测拒绝插件的全部 `$.http.fetch`；两者都回到今天的全套 shell hooks。**Windows 第一版不挂 mod**：`.launch` 文件没有条件分支，C# 启动器要改源码并重新签名（`windows-launcher.cs`、`scripts/launch-exe.mjs`），放到 M3 之后单独做；`canvasInjection` 在 `process.platform === "win32"` 时 `claudeMods` 恒为 `false`，原因 `windows_launcher` 进集成状态。

启动器内容由 `canvasInjection` 的答复拼出，门的任一边变了（探测写入、版本升级）下一次 `prepareInjection`（每次画布启动前，`canvas-launch.ts::canvasEnvironment`）就重写 `run/claude`——与今天 Codex 版本门的生效方式相同，不加新机制。

### 2.3 降级矩阵

| 情况                                                           | 谁判断           | 结果                                                                                                                         | 集成页显示的原因                             |
| -------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Claude < 2.1.293                                               | core（探测缓存） | 全套 shell hooks                                                                                                             | `version_below_min`                          |
| 没探测到 / 解析不出                                            | core             | 全套 shell hooks                                                                                                             | `version_unknown`                            |
| Windows                                                        | core             | 全套 shell hooks                                                                                                             | `windows_launcher`                           |
| `CLAUDE_CODE_SAFE_MODE`                                        | 启动器           | 全套 shell hooks                                                                                                             | 无（core 不知道；节点会话没有 hello 即可见） |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`                     | 启动器           | 全套 shell hooks                                                                                                             | 同上                                         |
| 组织 web-fetch 策略 / `plugin.register` 拒绝 / 其它 fetch 失败 | mod 运行时       | mod 内退回 `$.process.run([ARMADRA_HOOK_BIN, "claude"], { stdin })`，开销同今天，不丢事件；hello 的 `transport` 报 `process` | `fetch_refused`（来自 hello）                |
| mod 模块没加载（任何原因）                                     | 无人             | 只有 PermissionRequest 上报，状态栏空                                                                                        | 节点会话没有 hello；集成页「本会话未上报」   |

最后一行是真正的盲区，所以 hello（§2.5）是必需的，而且 SessionStart 到达时没有 hello 的会话要在集成页里点名。

### 2.4 与 OSC 7501、hook 状态合并的关系与优先级

不改 §53 的任何规则：

- mod 上报经 `POST /hook/claude`，`event.stateSource = stateSourceFor("claude") = "hook"`（`ingest.ts:198`），`verified` 由节点 token 决定。对 reduce、页面、空闲门、投递门、交接门、调度门而言，**mod 与 shell hook 是同一个来源**，权重完全相同；core 分不出两者，也不该分（协作通道 §3.2：能自报通道就能自报最强的通道）。
- OSC 7501 仍是展示级：有 `hook` 上报时以上报为准，程序自报只在两边都「在跑」时补进度；mod 加载失败退到 PermissionRequest-only 时，页面自然落到「没有上报 → 程序自报画胶囊」那一档，行为与 Claude 根本没装 hook 时一致。
- 页面来源点不新增 `mod` 值：`StateSourceBadge` 照旧显示 `hook`。要看「是 mod 在报」去集成页（§2.5），不去节点头。
- 顺序：mod 的 `classic.Stop` 与 shell hook 的 `PermissionRequest` 可能交错到达，和今天两个 shell hook 进程交错是同一回事，reduce 已经按 `seq` 与 `sourceRevision` 处理。

### 2.5 hello 心跳（可观测性的根）

mod 在 `session.start` 发一次 `POST /node/mod`（hook surface，带节点 token）：

```json
{
  "engine": "claude",
  "version": "2.1.293",
  "base": "2.1.293",
  "surface": "terminal",
  "isInteractive": true,
  "profile": "terminal",
  "transport": "socket",
  "modRevision": 1
}
```

`transport` 在第一次 fetch 被拒后再发一次 `process`。core 只在内存里按 `nodeId` 存最近一条（`core/hook/service.ts` 的 `HookService` 加一张 `Map`），进程重启即空；`GET /api/agents/claude/integration` 的 `mods.sessions` 列出它们。没有正文、没有路径、没有 MCP 工具名。

## 3. M1：状态上报 + 状态栏

### 3.1 生成的模块 `hooks/armadra.ts`

生成器 `core/hook/install/claude-mod/`（新目录，四个文件，便于 M2 / M3 并行）：

| 文件                               | 内容                                                                                                                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template.ts`                      | `claudeModSource(options)` 拼出整个模块：头注释、常量（`ARMADRA_CLIENT`、`ARMADRA_CLIENT_REVISION`、`ARMADRA_MOD_REVISION`、locale 表）、各段拼接。与 `extension-template.ts` 一样是确定性字符串，重装字节不变 |
| `transport.ts`                     | 端点解析（`KEY='v'`，与 `extension-template.ts:140-200` 同一套规则，移植成不依赖 Node 的纯函数）、头、`report(payload)`、fetch → process 退回                                                                  |
| `status.ts`                        | `classic.*` 的 11−1 个注册与 `$.ui.status`                                                                                                                                                                     |
| `ui.ts`（M2）、`commands.ts`（M3） | 空段占位                                                                                                                                                                                                       |

模块骨架（示意，真实源码由生成器写出）：

```ts
import type { Register, EngineInterface } from "claude-code";

const ARMADRA_CLIENT = "<armadra-hook 绝对路径>";
const ARMADRA_CLIENT_REVISION = "5";
const ARMADRA_MOD_REVISION = "1";

async function armadraSession($: EngineInterface) {
  const nodeId = await $.env.get("ARMADRA_NODE_ID");
  const endpointFile = await $.env.get("ARMADRA_ENDPOINT_FILE");
  if (nodeId === undefined || endpointFile === undefined) return undefined;
  const map = armadraParseEndpoint(await $.fs.read(endpointFile));   // 每次都读，不缓存
  const sessionId = await $.env.get("ARMADRA_SESSION_ID");
  const generation = await $.env.get("ARMADRA_SESSION_GENERATION");
  …
}

async function armadraReport($: EngineInterface, payload: unknown): Promise<void> {
  try {
    const session = await armadraSession($);
    if (session === undefined) return;
    const body = JSON.stringify({ nodeId: session.nodeId, version: 1, payload,
      ...(session.binding === undefined ? {} : { terminalBinding: session.binding }) });
    const res = await $.http.fetch(session.sock ? "http://armadra/hook/claude" : `http://127.0.0.1:${session.port}/hook/claude`,
      { method: "POST", headers: session.headers, body, ...(session.sock ? { socketPath: session.sock } : {}) });
    if (res.status === 0 /* refused */) await armadraSpawn($, body);
  } catch {
    try { await armadraSpawn($, /* 同一份 body */); } catch { /* 静默 */ }
  }
}

export const register: Register = (on) => {
  on("classic.SessionStart",      async ($, e, next) => { void armadraReport($, e); return next(e); });
  on("classic.UserPromptSubmit",  async ($, e, next) => { void armadraReport($, e); return next(e); });
  on("classic.PreToolUse",        async ($, e, next) => { void armadraReport($, armadraPreToolUse(e)); return next(e); });
  on("classic.PostToolUse",       …);  on("classic.Notification", …);  on("classic.Stop", …);
  on("classic.StopFailure", …);        on("classic.SubagentStart", …); on("classic.SubagentStop", …);
  on("classic.SessionEnd",        async ($, e, next) => { await armadraRace(armadraReport($, e), 800); return next(e); });
  on("session.start", async ($, e, next) => { void armadraHello($, e); void armadraStatus($); return next(e); });
};
```

规则（生成器与测试共同守住）：

- `$` 只传给顶层函数声明；`$.env.get` 的名字全是字面量（`ARMADRA_NODE_ID`、`ARMADRA_ENDPOINT_FILE`、`ARMADRA_SESSION_ID`、`ARMADRA_SESSION_GENERATION`、`ARMADRA_NODE_NAME`、`ARMADRA_HOOK_BIN`、`ARMADRA_MOD_PROFILE`）；没有 `import()`；所有路径 try/catch，宁可静默——hot reload 时失败的 hook 会在用户终端里多一行暗色提示。
- 除 `SessionEnd` 外全部 fire-and-forget（`void`），`next(e)` 立即返回；`SessionEnd` 整条链共享约 1.5 s，自己限 800 ms。
- **`classic.PreToolUse` 的 `e` 是 `ToolCallEnvelope`**（2.1.293 的 `.d.ts:1240` 明说「In shape classic.PreToolUse alone differs」），不是 stdin 形状。`armadraPreToolUse(e)` 拼成 `{ hook_event_name: "PreToolUse", tool_name: e.tool, tool_input: e.input, tool_use_id: e.tool_use_id, session_id, cwd }`——`normalize/claude.ts:60-69` 只读 `tool_name`，其余字段够用即可。其它九个事件的 `e` 就是 stdin 那份 JSON，原样转发。
- 头：`X-Armadra-Hook-Client: 5`、`X-Armadra-Hook-Token`、`X-Armadra-Node-Token`（`$.fs.read(<NODE_TOKEN_DIR>/<nodeId>)`，读不到就降级为未验证上报，不取消）。token 只在函数局部变量里，不进 `$.state` / `$.store` / 任何 UI 文案 / 日志。
- 节点 token 文件与端点文件都在数据目录内（0600 / 0700），CLI 以用户身份运行，读得到；远端主机用远端的 `ARMADRA_ENDPOINT_FILE`（`remote/integration.ts:412`），mod 不写死路径。

### 3.2 `terminalBinding`：core 代为分配 `sourceRevision`

shell hook 与 Pi 扩展在每次上报时对 `context-sequences/<session>-<generation>.seq`（8 字节大端计数 + 8 字节按位取反）做读-改-写，把新值作为 `sourceRevision` 发出（`extension-template.ts:240-260`）。mod 的 `$.fs.write(path, text)` 只能写文本（`.d.ts:3221`），写不出这 16 个字节；只读不写又会与仍在用 shell hook 的 `PermissionRequest` 抢同一个计数器，出现报告 `sourceRevision <= task.sourceBaseline` 被忽略、投递完成永远证不出的路径（`evaluate.ts:75-77`）。

因此 §55 规定：`terminalBinding` 可以**不带** `sourceRevision`（只带 `sessionId`、`generation`），由 core 在收到时对同一个 `.seq` 文件做同样的读-改-写并把新值当作这条报告的 `sourceRevision`。精度与今天相当：shell hook 读计数器的时刻也在事件之后（进程起来之后，约 60–80 ms），mod 的进程内延迟 1–20 ms 只会更近。实现：`core/runs/reports.ts` 加 `allocateSourceRevision(dataDir, sessionId, generation)`（与 `sourceRevision()` 同格式，没有也可创建），`ingest.ts:170-186` 的 `usable` 判定改为「`sourceRevision` 缺席 ⇒ 先 `isCurrentNodeSession` 再分配」。带了数字的客户端一个字节不改。`readBinding`（`ingest.ts:57-86`）放宽 `sourceRevision` 为可选。

### 3.3 状态栏

`session.start` 时与每次 `classic.SessionStart` 后：`$.ui.status(text)`，`text` 为 `<节点名> · <画布名>`；M1 只有 `ARMADRA_NODE_NAME`（没有名字时只画画布名；画布名要等 M2 的 `/node/overlay`，M1 先画 `节点名`，没有名字时不画）。只有名字和一个分隔点，不含任何可翻译的词，所以不依赖语言。`-p` / ACP（`e.surface === null`）不画。287 实测状态行前有一个 `⚠` 前缀，293 上要再看一眼；若仍有且刺眼，`$.ui.status` 改用 `$.ui.log`，或只在 `AbovePrompt`（M2）里显示。

### 3.4 core 改动清单（M1）

| 文件                                                                                                   | 改动                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook/install/inject.ts`                                                                               | `artifactLayout` 五个路径；`artifactFiles` 生成 `settings-permission.json`（只有 `PermissionRequest`，同一个 `hookCommand`）、mod 三件套；`injectionFromLayout` 的 `claudeMods` 选项与 `fallbackInjection`；`CLAUDE_MODS_MIN` / `claudeLoadsMods` / `claudeModsReason`；`InjectionRequest.claudeVersion`；`prepareInjection` 把 `fallback` 填进 `LauncherSpec` |
| `hook/install/launcher.ts`                                                                             | `LauncherSpec.fallback`，`posixLauncher` 的条件分支，`posixShim` 不变                                                                                                                                                                                                                                                                                          |
| `hook/install/claude-mod/{template,transport,status,ui,commands}.ts`                                   | 新                                                                                                                                                                                                                                                                                                                                                             |
| `hook/install/events.ts`                                                                               | `HOOK_CLIENT_REVISION` 不动（线上形状没变，§55 只是放宽）；`INTEGRATION_REVISION` 必须变：产物多了，加 `SKILLS_REVISION`（19）或新开 `MOD_REVISION` 并入 `INTEGRATION_REVISION` 的算式（推荐后者，`<hook>×10000 + <mod>×100 + <skill>`，并在注释里说明可拆读）                                                                                                 |
| `hook/install/remote.ts`                                                                               | 同步 mod 目录与 `settings-permission.json`；远端 `claudeVersion` 不探测 → 远端 **不挂 mod**（第一版），`reason = remote_unprobed`                                                                                                                                                                                                                              |
| `hook/install/integration.ts`                                                                          | `IntegrationState.mods`（§55）                                                                                                                                                                                                                                                                                                                                 |
| `hook/ingest.ts`、`runs/reports.ts`                                                                    | §3.2                                                                                                                                                                                                                                                                                                                                                           |
| `hook/server.ts:61-100`（hook surface 的 router，`/hook/{agentId}` 在 :67，`/<family>/{verb}` 在 :95） | `POST /node/mod`（§2.5）与 M2 的 `GET /node/overlay` 注册在这里，与 `/control/*` 同一道节点 token 门                                                                                                                                                                                                                                                           |
| `identity/protocol.ts`                                                                                 | `PROTOCOL_MINOR = 27`                                                                                                                                                                                                                                                                                                                                          |
| `docs/contracts/core-json-api.md`                                                                      | §55                                                                                                                                                                                                                                                                                                                                                            |
| `docs/design/canvas-only-integration.md` §2–§3、`docs/guides/architecture.md`                          | mod 一行                                                                                                                                                                                                                                                                                                                                                       |
| `tools/release/compatibility.json`                                                                     | `claudeMods: { minVersion: "2.1.293", verified: null }`，由探针 `--record-compat` 写 `verified`，与 `acp` 键同样「只扩不缩」                                                                                                                                                                                                                                   |

### 3.5 插件目录副作用的处理

Claude 2.1.287–2.1.294 每次加载向 `--plugin-dir` 写 `tsconfig.json` 与 `.claude-plugin/types/`（约 740 KB），其中 `claude-code-mcp/index.d.ts` 列出会话连接的 MCP 工具；2.1.295 起不再写。规则：

- **目录在我们数据目录内，可以被写**，不是越界；`removeInjection` 的 `rm -rf` 一并清掉。
- `prepareInjection` 只比较与写入 `artifactFiles` 列出的文件，对目录里多出来的文件**既不读也不删**（删会触发交互式会话的 hot reload，mod 的 `register` 重跑并再发一次 hello；不值得）。`remote.ts::fingerprint` 本来只算我们写的文件，不变。
- 集成状态、日志、`GET /api/agents/*/integration`、诊断包（`core/diagnostics/*` 若将来打包数据目录）一律不读、不列、不上传 `mod/.claude-plugin/types/**` 与 `mod/tsconfig.json`；`inject.test.ts` 加一条「`listedArtifacts(claude)` 不含 `types/`」的守卫。
- 由 CLI 写入，权限随 umask；数据目录自身 0700 即足够。没有秘密进入这些文件（我们的模块里也没有：token 只在运行时读）。

## 4. M2：横条 + toast

### 4.1 core：`GET /node/overlay`（§55）

hook surface 上的只读路由，节点 token 必须 `verified`（与 `/control/*` 非 legacy 动词同门）。答：

```json
{
  "revision": 418,
  "node": {
    "id": "n_…",
    "name": "reviewer",
    "role": "sub",
    "agentId": "claude"
  },
  "board": { "id": "b_…", "title": "发布 0.3" },
  "links": {
    "main": [{ "id": "n_…", "name": "lead" }],
    "subs": [],
    "peers": [
      { "id": "n_…", "name": "tester" },
      { "id": "n_…", "name": "" }
    ]
  },
  "inbox": { "pending": 2, "latestSequence": 9131 },
  "outbox": { "queued": 0 },
  "approvals": { "pending": 0 }
}
```

- 只有名字、计数、id；**没有正文、没有路径、没有终端内容**（`unreadDigest` 的 `earliestBody` 不出此门，用 `pendingCount` + 一条 `MAX(sequence)` 查询）。`name` 空串照写（零值照写）。
- `links` 按连线方向分（`context-links.ts` 的 role：`supervises` 的两端分别进 `main` / `subs`，其余 `peers`），即「上下文 / 派发对象」：能 `context` 读的与能 `post` / `send` 的都是这张表。
- `revision`：`max(节点 updatedAt, 连线表 updatedAt, inbox latestSequence, outbox/approvals 计数)` 折成一个单调数，供客户端比较是否需要重画。
- 请求头 `If-None-Match: "<revision>"` 命中答 `304`，省掉 JSON。
- 实现放 `core/collab/overlay.ts`（纯查询函数 + 路由注册），单测覆盖：token 门、无连线、名字为空、不带正文。
- 成本：每个 Claude 节点 3 s 一次、四条索引查询。所有空闲节点合计也在毫秒级；要是将来嫌多，再加「只在前台工作空间」的门，不在这一版。

### 4.2 mod：轮询、横条、toast

- `session.start` 里 `e.surface === "terminal" && e.isInteractive` 才启动 `$.clock.every(3000, poll)`；`-p` 与 ACP 不轮询。`poll` 带 `If-None-Match`，结果写 `$.state`（`armadra-mod.overlay`），hot reload 后状态仍在。
- `on("ui.render", { component: "AbovePrompt" }, …)`：按 `e.props.bodyColumns` 画**一行**：

  ```
  ↑ lead   ↓ —   ↔ tester, +1   ✉ 2
  ```

  没有连线且没有待收时返回 `next(e)`（不画，横条空着就是什么都没有）。只用名字、数字与四个字形，不含可翻译的词；窄于 40 列时省去 `↔` 段。不放按钮（横条自己的 `[-]` 已经能收起；「打开画布节点」要打 core 一个新接口，不进这一版）。

- toast：`inbox.latestSequence` 比上一轮大时 `$.ui.toast(\`✉ ${from}\`)`，`from` 取 `/node/overlay` 外加的 `inbox.latestFrom`（名字，没有名字用标题，`mailbox.ts:514-520` 同一条 COALESCE），**不放正文**。同一批只提示一次（按 `latestSequence` 去重，存 `$.state`）。
- 状态栏（M1 的）在拿到 overlay 后补成 `<节点名> · <画布名>`。

### 4.3 语言

core 不知道界面语言（`preferences-store.ts:343` 只在 localStorage）。M1–M2 的终端文案刻意做成**无词**（名字、数字、字形），避免这个依赖；需要词的地方只有两处：M3 斜杠命令的 `description`（`/help` 与补全会显示）与将来的任何提示。为它们加一个设备级设置 `ui.locale`（`zh-CN` | `en`，`settings/local.ts` 的 `LOCAL_PATHS` 加 `["ui", "locale"]`），页面在 `setLocale` 时同时写它（`preferences-store.ts:402`），core 生成 mod 源码时按它选表。文案表两份一致：`apps/web/src/i18n/integration.ts` 的 `mod.*` 键（页面不显示，只作文案的归属与中英同步守卫），core 侧 `claude-mod/i18n.ts` 镜像一份，测试断言两份相等（与 `events.ts` 镜像 `packages/shared` 同一做法）。locale 改了下一次 `prepareInjection` 重写模块，交互式会话会 hot reload 直接换语言。

### 4.4 设置子页（Agent CLI → Claude Code → 画布注入组）

一行 `SettingsRow`，标签 `Mods`（CLI 术语，中英同形），值按 `integration.mods`：

| 状态                             | zh-CN                                 | en                |
| -------------------------------- | ------------------------------------- | ----------------- |
| `gate: "enabled"` 且有会话 hello | `已启用 · N 个会话`                   | `On · N sessions` |
| `gate: "enabled"` 无会话         | `已启用`                              | `On`              |
| `gate: "disabled"`               | `未启用` + `title` 里一句原因（下表） | `Off` + reason    |
| `fetch_refused` 的会话           | 值后加 `Badge outline`「已回退」      | `Fallback`        |

原因文案（键 `integration.mods.reason.*`）：`version_below_min` →「Claude Code {version} 低于 {min}」/ `Claude Code {version} is below {min}`；`version_unknown` →「等待版本探测」/ `Waiting for version probe`；`windows_launcher` →「Windows 启动器暂不支持」/ `Not on the Windows launcher yet`；`remote_unprobed` →「远程机器暂不支持」/ `Not on remote hosts yet`。遵守 §5.15：没有问题的行只显示「已启用」，不写解释段；不展示 MCP 工具名、不展示用户别的插件。

## 5. M3：斜杠命令 + ACP 挂载

### 5.1 斜杠命令

`session.start` 里 `$.command.register` 注册（全部 `immediate: true`，不等回合）：

| 命令             | 对应 `POST /control/<verb>` | argumentHint                                 |
| ---------------- | --------------------------- | -------------------------------------------- | ------------- | -------------------------------- |
| `/armadra-post`  | `post`                      | `--to NAME --key KEY --body TEXT`            |
| `/armadra-inbox` | `inbox`                     | `[--limit N] [--after SEQ]`                  |
| `/armadra-ack`   | `ack`                       | `--id ID`                                    |
| `/armadra-send`  | `send`                      | `--to ID --body TEXT [--key KEY] [--no-queue | --interrupt]` |
| `/armadra-team`  | `team`                      | `--member "AGENT                             | TITLE         | TASK"... [--chain] [--gather …]` |
| `/armadra-open`  | `open-agent`                | `--agent ID [--task TEXT] …`                 |
| `/armadra-list`  | `list`                      | —                                            |

`command.run`（matcher 只列这七个字面名，不读 `next`，validate 列为「answers its own command」）：把 `e.args` 按 `control.ts:104-132` 同一套规则切成 `--flag value` 映射（重复旗标成数组、裸旗标为 `true`、`--dry-run` 透传），POST 到 `/control/<verb>`，答 `{ text }` = core 答复里给人看的那段（与 `armadra-hook canvas` 打印的相同，所以模型读到的也相同）。错误答 `{ text: "<core 的 message>" }`，不抛。人敲命令不消耗模型 token；模型自己仍走 Bash `armadra-hook canvas` 或 MCP，一套实现三个入口。

命名要实测：mod 注册的命令可能显示为 `/armadra-mod:armadra-post`。无论引擎加不加命名空间，最终可见名都以 `armadra` 开头即满足硬约束；若加了命名空间且观感太长，把命令名改成 `post` / `team`（显示 `/armadra-mod:post`），由探针（§7.4）里的 `claude -p '/help'` 输出决定，不在设计里预设。

### 5.2 ACP 下挂 mod

- 挂法：`CLAUDE_CODE_PLUGIN_DIRS=<mod>`（只挂 mod，不挂技能插件：ACP 下画布工具走 MCP，技能文本会让两套说明并存）设给适配器进程（`host.ts:765` 的 `env`），`claude-agent-acp` 把 `process.env` 整体透传给 CLI，`reference.md` 明说这个变量正是给 SDK 宿主起的会话用的。适配器表 Claude 行的 `injection` 增 `mods: true`，`canvas-launch.ts::acpInjection` 据此与版本门（同一个 `claudeLoadsMods`）给出这几对环境变量：`CLAUDE_CODE_PLUGIN_DIRS`、`agentEnvironment(...)` 的六个地址变量（mod 要靠它们找端点）、`ARMADRA_SESSION_ID` / `_GENERATION`、以及 **`ARMADRA_MOD_PROFILE=acp`**。D6 注释改写。
- `_meta.claudeCode.options.plugins` 是另一条路，但 `@armadra/agent` 0.6.8 的 `AcpSessionOptions` 没有 `meta`，要先给包加一个透传字段并升级 `compatibility.json.agent.version`；留作第二步，仅当环境变量路不生效时做。
- **profile = acp 时 mod 不转发 `classic.*`、不画 UI、不轮询**，只注册命令并发 hello（`profile: "acp"`）。原因：ACP 会话的节点状态由 `stateSource: "acp"` 的会话更新写，再来一路 `hook` 来源会让同一个节点有两个写者；斜杠命令经 ACP 的 `available_commands_update` 暴露给我们的会话视图，是 ACP 下 mod 唯一的增量。价值有限，所以这一步做小；`session.append` 投递另立设计，不在 M3。
- `ARMADRA_NODE_ID` 进入适配器进程环境意味着 Bash 子进程里 `armadra-hook canvas` 在 ACP 下也能用了（今天不能）。这是副作用不是目标，不改技能文本；ingest 的「另一个 CLI 的上报」门与节点 token 门不受影响。

## 6. 契约 §55 与设置改动

`docs/contracts/core-json-api.md` 末尾追加 **§55「Claude Code mods：门槛、hello、`/node/overlay` 与 `agents.integration.mods`」**，开头「自协议 1.27 起」。节内：

1. **门与产物**：`CLAUDE_MODS_MIN = 2.1.293`，两个插件目录，`settings-permission.json`，启动器的环境分支，Windows / 远端第一版不挂。
2. **hook 请求的 `terminalBinding.sourceRevision` 可缺席**（§3.2），由 core 分配；带数字的客户端不变。
3. **`POST /node/mod`**（hook surface）：请求体字段表（§2.5）；`204`；节点 token 未验证 `403`；只存内存。
4. **`GET /node/overlay`**（hook surface）：形状（§4.1），`If-None-Match` / `304`，不含正文的承诺。
5. **`agents.integration` 新增可选 `mods`**：

   ```json
   "mods": {
     "gate": "enabled",
     "reason": null,
     "minVersion": "2.1.293",
     "probedVersion": "2.1.296",
     "sessions": [{ "nodeId": "n_…", "version": "2.1.296", "profile": "terminal", "transport": "socket", "reportedAt": "…" }]
   }
   ```

   `reason` 枚举：`version_below_min` / `version_unknown` / `windows_launcher` / `remote_unprobed`；`transport`：`socket` / `tcp` / `process`。共享层 `integrationStateSchema` 同步。

6. **设置 `ui.locale`**：设备级，`zh-CN` | `en`，页面写、core 读，只用于生成终端侧文案。
7. 不写数据库迁移；`HOOK_CLIENT_REVISION` 不动；`INTEGRATION_REVISION` 的算式变化在此说明。

§55 在第一个实现包里一次写全（含 M2 / M3 的部分），代码分包落地；每条前面标注落地的包，避免再开节号。

## 7. 版本探测与缓存

- 来源：`agents.probes.claude`（`probe.ts`），`claude --version` 的第一个 `x.y.z`，TTL 24 h，启动后 3 s 扫一遍；已有机制，不加新探测。`canvasInjection` 读 `storedProbe("claude")`，与 Codex 一样只读不等。
- 用户升级 Claude 后 24 h 内缓存可能仍是旧版本 → 门继续关着，损失只是「多跑一天 shell hook」；集成页的「检查 / 重新生成」应顺手 `forgetProbes()` 后重探（`integration.ts` 的 install / repair 路由里加一行）。
- hello 带来的 `version` 是会话真值；core 不用它改写探测缓存（来源不同、语义不同），只在 `mods.sessions` 里并列显示；若 hello 的 `base` < 门槛而门却开着（缓存指向另一个 `claude`），集成页值旁加一枚 `Badge outline`「版本不一致」——这是用户 PATH 上有两个 claude 的信号。
- 远端主机：Worker 不探测 Claude 版本，第一版 `remote_unprobed`；后续在 `remote/integration.ts` 的同步里顺带跑一次 `claude --version` 即可打开。

## 8. 安全与边界

- 不写 `~/.claude` 下任何文件；不设 `CLAUDE_CONFIG_DIR`；`pluginConfigs` / `userConfig` 一律不用（它们住在用户 settings 里）。mod 的可变输入只有环境变量与我们数据目录里的文件。
- 不替人回答：mod 不注册 `classic.PermissionRequest`、不注册 `tool.check` / `tool.call` 的裁决、不调 `$.prompt.submit` / `$.session.append` / `$.prompt.fill`。`inject.test.ts` 用正则守住生成源码里不出现这些名字。
- 节点 token、hook bearer 只存在于函数局部；`$.ui.status` / `toast` / 横条 / hello / 日志里只有名字、计数、版本。
- `/node/overlay` 与 `/node/mod` 都在节点 token 门后，且 `overlay` 只答调用者自己节点的连线（不跨工作空间、不读未连线节点）。
- 生成的类型文件（§3.5）不读、不列、不传。
- `ARMADRA_NODE_ID` 在 ACP 适配器环境里的泄漏面与终端模式相同（终端模式下节点 shell 本就带它）。

## 9. 风险与回退

| 风险                                                                 | 应对 / 回退                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API early access，`.d.ts` 每版在变                                   | 只用最稳的子集（`classic.*`、`session.start`、`$.env.get`、`$.fs.read`、`$.http.fetch`、`$.process.run`、`$.ui.status/toast`、`AbovePrompt`、`$.command.register`、`$.clock.every`、`$.state`）；探针按版本记录通过情况到 `compatibility.json.claudeMods.verified`；某个版本坏了，把它加进 `CLAUDE_MODS_BROKEN` 名单让门关上，不用发版改模板 |
| `classic.*` 在某个版本又变形                                         | hello 携带版本；core 单测用同一份 fixture 走 `normalize/claude.ts`；探针逐事件比对 shell hook 与 mod 的 payload                                                                                                                                                                                                                              |
| `$.process.run` 在 ACP（SDK 宿主）下不可用（类型注释写「CLI only」） | ACP 下 profile=acp 本就不转发状态，退回路径用不到；终端模式下必有                                                                                                                                                                                                                                                                            |
| hot reload 重跑 `register` 导致重复 hello / 重复 `$.ui.status`       | 都是幂等；core 的 `mods.sessions` 按 `nodeId` 覆盖                                                                                                                                                                                                                                                                                           |
| `settings-permission.json` 单独存在时 Claude 版本旧于 2.1.293        | 不可能：门关着时启动器只引用 `settings.json`                                                                                                                                                                                                                                                                                                 |
| 轮询常驻开销                                                         | 3 s、`If-None-Match`、只在交互式终端；`-p` / ACP 不轮询                                                                                                                                                                                                                                                                                      |
| `$.ui.status` 的 `⚠` 前缀观感                                       | 探针截图确认；不行就改 `$.ui.log` 或并入横条                                                                                                                                                                                                                                                                                                 |
| 两个 claude 在 PATH 上（缓存版本 ≠ 真启动的版本）                    | hello 对账 → 集成页「版本不一致」                                                                                                                                                                                                                                                                                                            |
| 整体回退                                                             | 只改一处：`claudeLoadsMods` 恒 `false`（或 `CLAUDE_MODS_MIN` 设成一个不会达到的版本），启动器下一次 prepare 即回到全套 shell hooks；产物与契约保留，不需要迁移                                                                                                                                                                               |

## 10. 测试

### 10.1 单测（`pnpm --filter @armadra/desktop test`，先 `pnpm libs:build`）

- `inject.test.ts`：门开 / 门关两种 argv 快照；`settings-permission.json` 只含 `PermissionRequest`；mod 目录三件套的路径；`listedArtifacts` 不含 `types/`；生成源码里 `$.env.get(` 的实参全是字面量、不含 `import(`、不含 `PermissionRequest` / `tool.check` / `prompt.submit` / `session.append`；所有 `name:` 与 `$.command.register` 的名字以 `armadra` 开头；Windows 平台 `claudeMods === false` 且 `reason === "windows_launcher"`。
- `launcher.test.ts`：`fallback` 分支的 sh 正文快照；`sh -n` 语法检查；`CLAUDE_CODE_SAFE_MODE=1 sh run/claude /bin/echo` 打印的是 classic 那组 argv。
- `claude-mod/template.test.ts`：`tsc --noEmit` 用仓库自带的最小类型垫片 `tools/vendor/claude-mod-api.d.ts`（只声明我们用到的 `Register` / `EngineInterface` 子集，手写、随版本门升级；真 `.d.ts` 的校验在探针里做）；环境里有 `claude` 且 `ARMADRA_CLAUDE_PROBE=1` 时跑 `claude plugin validate <tmp mod dir>` 并断言输出列出的 env 名与 hooks 事件集合；没有 `claude` 跳过不算失败。
- `ingest.test.ts`：`sourceRevision` 缺席 → 分配、`.seq` 文件格式正确、连续两条递增；`isCurrentNodeSession` 为假时仍丢弃；带数字的旧客户端路径不变。
- `collab/overlay.test.ts`：token 门、`304`、无连线、空名字、答复里没有 `body` 字段（JSON 全文正则 `"body"` 不出现）。
- `hook/service` 的 hello：存入、覆盖、进程重启后为空；`integration.state` 的 `mods` 在各 reason 下的快照。
- `i18n.test.ts`（web）：`mod.*` 键中英齐全；desktop 侧断言 `claude-mod/i18n.ts` 与 web 的表逐键相等。
- `acp/adapters.test.ts`、`canvas-launch.test.ts`：Claude 行的 `mods: true` 产生的环境变量集合、门关时为空；`ARMADRA_MOD_PROFILE=acp`。

### 10.2 `claude plugin test`（M2 / M3，有 `claude` 时）

生成器把模块与 `armadra.test.ts` 一起写进临时目录：`mount({ plugin: "armadra-mod", surface, component: "AbovePrompt", props })` 在 `['terminal', 'desktop']` 上各跑一遍，断言无连线时不画、有待收时文本含 `✉ 2`；`classic.SessionStart(...)` 触发后 `mock` 的 `$.http.fetch` 收到的 body 与 fixture 相等；`command.run` 的切词与 `control.ts` 的 fixture 一致。

### 10.3 隔离 HOME 的真 Claude 探针（`tools/probes/claude-mod-launch.mjs`，加进 `release:test` 的可选组与 nightly）

照搬原型：`HOME` / `CLAUDE_CONFIG_DIR` 指向临时目录，`ANTHROPIC_BASE_URL` 指向本地假 Messages API（`srv.mjs`），`ANTHROPIC_API_KEY=fake`，recorder 在一个 Unix socket 上冒充 `/hook/claude`、`/node/mod`、`/node/overlay`；用 `prepareInjection` 真生成产物与 `run/claude`，再以 `ARMADRA_NODE_ID` 等环境起 `claude -p "hi"`：

1. recorder 收到 hello 与 `SessionStart → UserPromptSubmit → PreToolUse → PostToolUse → Stop → SessionEnd`，逐字段与 shell hook 版 fixture 比对（两份都过 `normalize/claude.ts`，得到的 `AgentEvent` 相等）；
2. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 与 `CLAUDE_CODE_SAFE_MODE=1`：仍收到同一组事件（走启动器分支的 shell hook），且**没有** hello；
3. 把 recorder 的 `/hook/claude` 改成拒绝（关闭 socket）：事件经 `armadra-hook` 进程退回到达（stub 的 `ARMADRA_HOOK_BIN` 记录 stdin），hello 的 `transport` 为 `process`；
4. `claude -p '/help'`（M3）输出里命令名的实际拼法；
5. 对 `.claude-plugin/types/claude-code/index.d.ts` 跑一次 `tsc` 校验生成的模块（真类型）；
6. 通过后 `--record-compat` 写 `compatibility.json.claudeMods.verified`。

不碰 `~/.claude`，不登录真实账号。全局配置前后哈希一致是探针的最后一条断言。

## 11. 实现包

| 包                                                        | worktree                          | 范围                                                                                                  | 文件边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 验证                                                          |
| --------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **1 · `claude-mod-m1-status`**                            | `feat/claude-mod-m1-status`       | §2、§3、§6（整节契约）、§7、§10.1 的 inject / launcher / template / ingest / hello 部分、§10.3 的 1–3 | `core/hook/install/{inject,launcher,events,remote,integration}.ts`、新目录 `core/hook/install/claude-mod/`（`ui.ts` / `commands.ts` / `i18n.ts` 留空壳）、`core/hook/{ingest,routes,service}.ts`、`core/runs/reports.ts`、`core/identity/protocol.ts`、`packages/shared` 的 `integrationStateSchema`、`tools/probes/claude-mod-launch.mjs`、`tools/vendor/claude-mod-api.d.ts`、`tools/release/compatibility.json`、`docs/contracts/core-json-api.md` §55、`docs/design/canvas-only-integration.md`、`docs/guides/architecture.md`、`docs/README.md` | `pnpm --filter @armadra/desktop test`、`pnpm check`、探针 1–3 |
| **2 · `claude-mod-m2-overlay`**（依赖 1）                 | `feat/claude-mod-m2-overlay`      | §4 全部、设置 `ui.locale`、设置子页行                                                                 | `core/collab/overlay.ts`（新）+ 路由注册、`core/settings/{local,schema}.ts`、`core/hook/install/claude-mod/{ui,i18n}.ts` 与 `template.ts` 的拼接行、`apps/web/src/app/preferences-store.ts`、`apps/web/src/panels/settings/pages/AgentDetailPage.tsx`、`apps/web/src/i18n/integration.ts`、`docs/design/design-system.md` §5.15 一行                                                                                                                                                                                                                 | desktop + web 测试、`claude plugin test`、探针的 overlay 场景 |
| **3 · `claude-mod-m3-commands-acp`**（依赖 1，与 2 并行） | `feat/claude-mod-m3-commands-acp` | §5 全部                                                                                               | `core/hook/install/claude-mod/commands.ts`、`core/acp/adapters.ts`（Claude 行 + D6 注释）、`core/agent/canvas-launch.ts::acpInjection`、`core/acp/host.ts` 环境拼装、`docs/design/acp-session-view.md` §5.8 一段                                                                                                                                                                                                                                                                                                                                     | desktop 测试、探针 4、ACP e2e 场景里 Claude 一条              |

包 2 与包 3 都只往 `template.ts` 加一行拼接，各自拥有自己的段文件，不会冲突。Windows C# 启动器的条件分支、远端主机版本探测、`_meta.claudeCode.options.plugins`、`session.append` 投递，都是之后的独立包。
