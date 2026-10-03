# 协调 Agent：ama 接入 Armadra（后续规划第三部分）

> 状态：目标设计（2026-10-02），未开始实施。对应[后续规划](product-roadmap.md)第三部分「协调 Agent 与工作流」，**替代**其中「核心先选用 Pi」一条。
> 修订（2026-10-03，以 [补全架构](completion-architecture.md) §5.2、§5.3 为准，正文保留原文）：按 `@armadra/agent` **0.6.2** 接入（精确版本 devDependency，`compatibility.json` 记 `agent { package, version, hostApi: 1 }`）；子任务改由 **`HostApi.runners`** 接到画布——适配器为每个内置 CLI id 与 `custom:*` 注册 runner，`task(agent=…)` 起画布节点、经新动词 `wait` 取进度，不再 `tools.disable("task")`；§9 的 **B4** 由「RPC 子进程形态」改为 **ACP 形态**（`ama --mode acp`，见 [ACP 会话视图](acp-session-view.md)）。
> Agent 本体是独立仓库 `github.com/yovinchen/armadra-agent`（npm `@armadra/agent`，可执行名 `ama`），其设计见该仓库 `docs/design.md`（下称「文档 A」）。本文只写 Armadra 这一侧：怎样把它变成第七个内置 Agent、适配器放哪、协调者在画布上是什么形态、与新域 `core/workflow/` 怎么分工。
> 范围：`packages/shared/src/{agents,hook-events,domain/node-data}.ts`、`apps/desktop/src/core/{agent,hook,collab,history,workflow,settings}`、`apps/desktop/src/agent-host/`（新）、`apps/desktop/src/cli/armadra-hook/launcher.ts`、`apps/desktop/{electron.vite.config.ts,electron-builder.yml,scripts/after-pack.mjs}`、`apps/server/scripts/build.mjs`、`apps/web/src/panels/settings`、`tools/probes/agent-e2e`。

## §0 结论

| #   | 决定                                                                                                                                                                                                                              | 理由                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 内置 agent id 取 **`ama`**，label「Armadra Agent」                                                                                                                                                                                | 与可执行名、`configHomeWith("ama")`、`armadra-hook ama` 的 hook 模式、`expectedProcess` 词汇一致；`armadra` 作 id 会与产品名、`ARMADRA_*` 保留前缀、`isManagedCommand("armadra-hook")` 子串判断在日志与配置里混在一起 |
| D2  | 第一版节点形态 = **终端节点里跑 `ama` 的 REPL**；RPC 子进程形态后置到会话视图（规划第二部分）                                                                                                                                     | `collab/mailbox.ts:70` 要求调用者是 `nodeType === "terminal"` 且 `agentId !== null`；`send` / 唤醒 / 空闲门全部建立在终端节点与 Hook 状态上                                                                           |
| D3  | 适配器放 **本仓库** `apps/desktop/src/agent-host/ama/`，作为第七条 electron-vite bundle（`out/agent-host/ama-armadra.cjs`），经 `--profile` 交给 `ama --host`                                                                     | 它讲的是本仓库的 Hook 面 HTTP（`/hook/{agent}`、`/control/{verb}`、`/context-link/{verb}`）、`X-Armadra-Hook-Token` / `X-Armadra-Node-Token` 与端点文件，必须和这些一起改一起发                                       |
| D4  | 端点发现、令牌读取、HTTP 客户端从 `src/cli/armadra-hook/{endpoint,http,session,json}.ts` 抽到 `src/hook-client/`，CLI 与适配器**共用源码**，各自打进自己的 bundle；适配器直接讲 HTTP，不 fork `armadra-hook`                      | 审阅结论 S1；两份实现一定会漂                                                                                                                                                                                         |
| D5  | 状态上报走 **进程内扩展通道**（`stateSourceFor("ama") = extension`），事件名沿用 Pi 词汇，`normalizeAs` 把 `ama` 转给 `normalize/pi.ts`                                                                                           | 审阅结论 M4；`pi.ts` 已把 `agent_settled → idle`、`before_agent_start → working + prompt`、`tool_approval_requested → blocked` 做对                                                                                   |
| D6  | `ama` 随桌面壳打包：`@armadra/agent` 作 `apps/desktop` 的 **精确版本 devDependency**，其 `dist/bundle/ama.cjs` 复制到 `out/agent/`，after-pack 放到 `resources/agent/`，启动器与 `armadra-hook` 同形（POSIX sh / Windows `.exe`） | 用户机器不保证有 `node`；现有启动器已经解决了「用随包 Electron 当 Node」与 Windows `.cmd` 转义两个问题，参数化名字即可复用                                                                                            |
| D7  | 画布规则与技能由 core 生成为 `<data>/integration/ama/{instructions.md,skills/armadra/SKILL.md}`，经 profile 注入；API Key 由 core 的 `SecretStore` 保管，启动前写 0600 的 `auth.json` 只传路径                                    | 审阅结论 S2 与「API Key」项；`prepareInjection` 的产物必须确定性且无密钥，所以 `auth.json` 由 `canvas-launch` 在每次启动时写，不进 `injection.json` 的产物清单                                                        |
| D8  | 流程引擎放新域 `core/workflow/`；协调者只有一个工具 `workflow_propose` 产出**草案**，人确认后由 core 运行；协调者另一端只做汇总                                                                                                   | 人在回路与执行记录是 core 的持久化职责；Agent 进程随时会被关掉                                                                                                                                                        |
| D9  | 验收门槛：`agent-e2e` 新增场景 11，用**本地脚本化模型服务**（OpenAI 兼容）驱动 `ama`，不需要真实密钥                                                                                                                              | 场景 6 的教训：真凭据在临时 HOME 下拿不到；协调逻辑的验收对象是画布动词与状态，不是模型质量                                                                                                                           |

## §1 与后续规划第三部分的关系

| 规划条目   | 原方案                                | 本文                                                                                              |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 协调 Agent | 核心先选用 Pi，借进程内扩展调画布动词 | 核心是自写的 `ama`（文档 A）；「进程内调画布动词」保留，由本仓库的适配器实现；Pi 扩展事件词汇沿用 |
| 分派与汇总 | —                                     | §4：`canvas_team` / `canvas_send` / `canvas_inbox` 工具 + 汇总到便签                              |
| 人在回路   | —                                     | §5 的 `gate` 步骤；§6 的审批                                                                      |
| 工作流录入 | —                                     | §5：`workflow_propose` 草案 → 模板；引擎细节另写 `docs/design/workflow-engine.md`（本文只定接口） |
| 一键复用   | —                                     | `core/workflow/` 运行模板；挂到自动化由 `schedule` 域调用 workflow 服务                           |
| 执行记录   | —                                     | `workflow_runs` / `workflow_run_steps` 表（§5.3）                                                 |

规划文档第三部分第一条改为：「协调 Agent：Armadra 自己的 `ama`（独立仓库），嵌入形态见 [协调 Agent](coordinator-agent.md)」。

## §2 接入方式

### §2.1 内置 id 的七处一致

| 处                                                      | 现状                                                          | 改动                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/agents.ts`                         | `AGENT_IDS` 六个、`AGENT_REGISTRY` 六条                       | 加 `"ama"` 与 §2.2 的条目                                                                                              |
| `packages/shared/src/domain/node-data.ts:9`             | `agentIdSchema` 把六个 id 写死在数组里                        | 改为引用 `AGENT_IDS` 或加 `"ama"`（保留不依赖注册表的注释意图则加字面量）                                              |
| `packages/shared/src/hook-events.ts`                    | `HOOK_EVENTS` 六键                                            | `AMA_HOOK_EVENTS = [...PI_HOOK_EVENTS, "tool_approval_requested", "tool_approval_resolved"]`；`HOOK_CLIENT_REVISION` 5 |
| `apps/desktop/src/core/agent/registry.ts`               | `AGENT_IDS`、`AGENT_REGISTRY`、`stateSourceFor` 六个 case     | 加 `ama`；`stateSourceFor("ama") → STATE_SOURCE_EXTENSION`                                                             |
| `apps/desktop/src/core/settings/custom-agents.ts`       | `BUILTIN_AGENT_IDS` 六个（`hook/ingest.ts:141` 用它校验路径） | 加 `ama`                                                                                                               |
| `apps/desktop/src/core/hook/normalize/index.ts`         | `case "pi": case "omp"` → `pi.normalize`                      | 加 `case "ama"`                                                                                                        |
| `apps/desktop/src/core/agent/{registry,launch}.test.ts` | 「exactly the six」、`supportedPermissionModes` 断言          | 改七；`ama` 四种模式都有 flag                                                                                          |
| `apps/web/src/panels/settings/pages/AgentPage.tsx:454`  | 遍历 `AGENT_IDS`                                              | 自动出现；补 API Key 字段（§7）与 i18n 文案                                                                            |

`conversations.ts` 的 `CONVERSATION_PROVIDERS = AGENT_IDS` 自动带上。

### §2.2 注册表条目（shared）

```ts
ama: {
  id: "ama", label: "Armadra Agent", color: "#2f6fed",
  launchCmd: "ama", promptMode: "argv",
  permissionFlag: {
    default: [], "auto-edit": ["--permission-mode", "auto-edit"],
    "full-auto": ["--permission-mode", "full-auto"], plan: ["--permission-mode", "plan"],
  },
  modelFlag: "--model", sessionIdFlag: "--session-id",
  resume: { style: "flag", flag: "--resume" }, exitCommand: "/exit",
  // 不声明 subagent：画布规则要它用 canvas open-agent / team，适配器会 disable("task")。
  capabilities: ["hooks", "resume", "contextLink", "browser", "usage", "structuredInputAck", "supportsModelSelection"],
  // 启动器 exec 进 Electron，tmux 的 pane_current_command 看到的是运行器而不是 ama。
  expectedProcess: ["ama", "ama.cjs", "armadra", "Armadra", "Electron", "electron"],
}
```

core 的 `AgentDefinition` 同步加这一条（字段子集）。`launch.ts:402` 的 `expectedProcesses()` 今天只回 `[agentId]`，要改为读注册表的 `expectedProcess`（审阅结论 M5）；`lineNamesProgram` 已能匹配 `name` 与 `name.js`，补 `.cjs` 后缀。

### §2.3 Hook 归一化

适配器在 `/hook/ama` 上报 `{ nodeId, version: 1, payload: { hookEventName, provider: "ama", sessionId, transcriptPath, cwd, toolName?, prompt?, modelId? }, terminalBinding }`——与 `extension-template.ts` 的 `armadraPayload` 同一形状。`normalize/pi.ts` 不改一行；`ingest.ts:178` 的 `stateSourceFor` 给出 `extension`。新增的两个审批事件已在 `pi.ts` 里映射为 `BLOCKED` / `WORKING`，节点头部因此能显示「等待批准」。

### §2.4 注入产物

`hook/install/inject.ts`：`INJECTED_AGENTS` 加 `ama`；`artifactLayout` 新分支：

```text
<data>/integration/ama/
  injection.json        marker（revision、clientBin）
  instructions.md       collab/skill.ts 的 canvasInstructions(skillPath)
  skills/armadra/SKILL.md
  config.json           { version:1, permission:{mode:"default"}, compaction:{enabled:true} }
  profile.json          { version:1, host:<resources>/agent-host/ama-armadra.cjs, instructions:[…], skillDirs:[…],
                          config:…, authFile:<data>/integration/ama/auth.json, sessionDir:<data>/ama/sessions }
```

`injectionFromLayout` 对 `ama` 返回 `args = ["--profile", profile]`——一个参数，避开 Codex 已踩过的 1 KB 典入上限。`auth.json` 不是产物（§7）。`INTEGRATION_REVISION` 随 `HOOK_CLIENT_REVISION` 自动变。

### §2.5 启动器与打包

| 项               | 现状                                                                                  | 改动                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖             | —                                                                                     | `apps/desktop/package.json` devDependencies `"@armadra/agent": "<精确版本>"`（bundle 是复制不是 import，所以是 dev 依赖）                                                                                                                                                                         |
| bundle 产物      | `out/{core,cli,session-host}`                                                         | `electron.vite.config.ts` 的 `buildCore()` 再做两件事：复制 `node_modules/@armadra/agent/dist/bundle/ama.cjs → out/agent/ama.cjs`；用 `cliConfig` 同款配置打 `src/agent-host/ama/main.ts → out/agent-host/ama-armadra.cjs`                                                                        |
| after-pack       | `bundleResources()` 放 `cli/armadra-hook.js`                                          | 加 `{ from: "out/agent/ama.cjs", to: "agent/ama.cjs" }`、`{ from: "out/agent-host/ama-armadra.cjs", to: "agent-host/ama-armadra.cjs" }`；Windows 再编一个 `agent/ama.exe`                                                                                                                         |
| electron-builder | `files` 排除 `out/cli`、`out/session-host`                                            | 排除 `out/agent/**`、`out/agent-host/**`（都要是 asar 外的真实文件）                                                                                                                                                                                                                              |
| 启动器           | `launcher.ts` 名字写死 `armadra-hook`；`windows-launcher.cs` 读 `armadra-hook.launch` | `writeLauncher(directory, target, { name })`；C# 改为按自身文件名读 `<name>.launch`；`hook-launcher.mjs` 的输出名参数化。core 启动时在 `<data>/bin/` 写 `ama` 启动器（与 hook 客户端同目录，`terminal/environment.ts` 已把该目录加进 `agentPath`，`launchCmd: "ama"` 因此能 `resolveCommand` 到） |
| 进程名门         | `expectedProcesses()` 只回 `[agentId]`                                                | §2.2                                                                                                                                                                                                                                                                                              |
| 服务器壳         | `apps/server/scripts/build.mjs` 只打 `out/main.js`                                    | 同一脚本再复制 `ama.cjs` 到 `out/agent/`、用 esbuild 打 `ama-armadra.cjs` 到 `out/agent-host/`；启动器的运行器是 `process.execPath`（node）                                                                                                                                                       |
| 资源定位         | `hook/install/shared.ts::resolveClientBinary` 找 `armadra-hook`                       | 新 `agentBundle()`：`ARMADRA_AMA_BUNDLE` 覆盖 → `<resourcesPath>/agent/ama.cjs` → `out/agent/ama.cjs`；适配器同理                                                                                                                                                                                 |

### §2.6 版本锁定与升级

- 精确版本写在 `apps/desktop/package.json`；`tools/release/compatibility.json` 加 `"agent": { "package": "@armadra/agent", "version": "x.y.z", "hostApi": 1 }`，`release:check` 校验它与 lockfile 里安装的版本一致，升级必须是一次显式改动。
- `apps/desktop/src/agent-host/ama/host-api.test.ts`：`import { HOST_API_VERSION } from "@armadra/agent/host"`，断言等于适配器写的 `hostApi`。
- 升级流程：agent 仓库发版 → 本仓库一条 PR 改两处版本 → CI 三平台跑单测 + agent-e2e 场景 11 → 合并。
- 兼容性矩阵：适配器 `hostApi` 主版本 ↔ `@armadra/agent` 主版本一一对应；跨主版本不支持混用，`ama` 会拒绝启动（文档 A §9.1）。
- 两边 CI：agent 仓库跑自己的单测与 RPC 黄金记录；本仓库跑 typecheck（含适配器对着锁定版本的类型）、`agent/registry.test`、`hook/normalize.test`、场景 11。

## §3 Armadra 适配器（`apps/desktop/src/agent-host/ama/`）

```text
agent-host/ama/
  main.ts        默认导出 HostModule{ hostApi: 1, create }：无 ARMADRA_NODE_ID 时返回 undefined（画布外 ama 不受影响）
  client.ts      复用 src/hook-client/：候选端点、令牌、HTTP；带 terminalBinding 的序号
  events.ts      订阅 AMA_HOOK_EVENTS 全部事件 → POST /hook/ama；session_shutdown 被 await
  tools.ts       注册画布工具（下表），每个工具 = 一次 /control/{verb} 或 /context-link/{verb}
  instructions.ts api.instructions.add 信任规则（与 collab/skill.ts 的 TRUST_RULE 同一文本，import 共享常量）
```

| 工具                                                        | 后端                                   | 权限类       | 说明                                                      |
| ----------------------------------------------------------- | -------------------------------------- | ------------ | --------------------------------------------------------- |
| `canvas_list`                                               | `/control/list`                        | read         | 相连节点与状态                                            |
| `canvas_open_agent`、`canvas_team`                          | `/control/open-agent`、`/control/team` | write        | 建节点并自动连线；`--worktree` 透传                       |
| `canvas_send`、`canvas_post`                                | `/control/send`、`/control/post`       | write        | 投递 / 留言；正文走 JSON 体，无 shell 转义问题            |
| `canvas_inbox`、`canvas_ack`                                | `/control/inbox`、`/control/ack`       | read / write | 拉取信箱                                                  |
| `canvas_sticky`、`canvas_link`、`canvas_rename`             | 对应动词                               | write        | 汇总落便签                                                |
| `canvas_interrupt`、`canvas_close`                          | 对应动词                               | execute      | 走 §6 审批                                                |
| `context_summary`、`context_transcript`、`context_terminal` | `/context-link/{verb}`                 | read         | 读相连节点上下文，预算由 core 判                          |
| `browser_*`                                                 | `/control/browser-*`                   | 按动词       | 复用 `browser/args.ts` 的 `BROWSER_VERB_SPECS` 生成参数表 |
| `workflow_propose`                                          | `/control/workflow-propose`（新）      | write        | §5                                                        |

动词表与参数不手抄：`tools.ts` 从 `collab/control/index.ts` 的 `VERBS` 与 `browser/args.ts` 生成，一条测试断言两边一致（与 `collab/skill.ts::browserVerbs()` 同一手法）。适配器 `api.tools.disable("task")`，让画布规则 2 成立。

## §4 协调者节点形态与 MVP 闭环

形态：用户在画布上新建 Agent 节点选「Armadra Agent」，core 走 `canvas-launch.ts`：`prepareInjection("ama")` → 写 `auth.json` → 启动行 `ama --profile <path> [--permission-mode …] [--model …] [prompt]` 典入节点终端。REPL 在终端里跑；状态经适配器上报；`send` 给它的正文以括号粘贴 + `\r` 进入 REPL（文档 A §8.2），按信任规则作资料。

MVP 闭环（场景 11 也按此验收）：

1. 用户对协调者说「让 A 审查 `src/x`，B 审查 `src/y`，汇总到便签」。
2. 协调者调 `canvas_team`（两个成员、各自提示词、`--after` 为空），core 建两个节点并连线。
3. 成员完成后按自己的技能 `canvas post` 结论；`collab/wake.ts` 的收件箱唤醒把一条短提示 `send` 进协调者终端。
4. 协调者收到唤醒，调 `canvas_inbox` 读两条结论，`canvas_ack`，调 `canvas_sticky` 写汇总。
5. 若用户随后说「把这次保存为工作流」，协调者调 `workflow_propose` 产出草案；画布出现草案卡，用户确认后入模板库（§5）。

不在 MVP：协调者自己运行工作流、审批在画布上直答、RPC 子进程形态。

## §5 `core/workflow/` 与协调者的分工

### §5.1 分工

| 事                           | 协调者（ama + 适配器）             | `core/workflow/`                                             |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| 拆任务、起成员、读结论、汇总 | 做（画布工具）                     | 不做                                                         |
| 把一次协作沉淀为模板         | 只出**草案**（`workflow_propose`） | 存草案、给人改、确认后存模板                                 |
| 运行模板                     | 不做                               | 做：按步骤 `open-agent` / `team` / `send` / 等 `gate` / 收集 |
| 人工关卡                     | 不做                               | `gate` 步骤停下等 `POST /api/workflows/runs/{id}/gates/{id}` |
| 执行记录                     | 不做                               | `workflow_runs` / `workflow_run_steps`，可回看对比           |
| 定时复用                     | 不做                               | `schedule` 域调用 workflow 服务                              |

### §5.2 草案 JSON（`workflow_propose` 的工具入参 = `/control/workflow-propose` 的 `args.draft`）

```json
{
  "version": 1,
  "title": "双人代码审查",
  "params": [
    { "name": "repo", "type": "path" },
    { "name": "scopeA", "type": "string" },
    { "name": "scopeB", "type": "string" }
  ],
  "roles": [
    {
      "id": "reviewerA",
      "agentId": "claude",
      "permissionMode": "plan",
      "model": null,
      "worktree": null
    },
    {
      "id": "reviewerB",
      "agentId": "codex",
      "permissionMode": "plan",
      "model": null,
      "worktree": null
    },
    { "id": "lead", "agentId": "ama", "permissionMode": "default" }
  ],
  "links": [
    { "from": "lead", "to": "reviewerA" },
    { "from": "lead", "to": "reviewerB" }
  ],
  "steps": [
    {
      "id": "s1",
      "kind": "prompt",
      "role": "reviewerA",
      "prompt": "审查 {{scopeA}}，结论 canvas post 给 lead",
      "after": []
    },
    {
      "id": "s2",
      "kind": "prompt",
      "role": "reviewerB",
      "prompt": "审查 {{scopeB}}，结论 canvas post 给 lead",
      "after": []
    },
    {
      "id": "s3",
      "kind": "collect",
      "role": "lead",
      "from": ["s1", "s2"],
      "prompt": "汇总两份结论到便签",
      "after": ["s1", "s2"]
    },
    { "id": "s4", "kind": "gate", "label": "合并前人工确认", "after": ["s3"] }
  ],
  "source": {
    "boardId": "…",
    "nodeIds": ["…"],
    "proposedBy": "ama",
    "sessionId": "…"
  }
}
```

`kind` 第一版只有 `prompt` / `collect` / `gate`；`after` 的依赖语义复用 `agent_dependencies`（迁移 0027）与 `open-agent --after` 的判定代码。草案经 zod 校验（放 `packages/shared/src/api/workflows.ts`），`agentId` 必须是注册表 id 或 `custom:`。

### §5.3 持久化与接口

- 迁移 `0034_workflow.sql`：`workflow_drafts(id, board_id, proposer_node_id, draft_json, status, created_at)`、`workflow_templates(id, name, template_json, created_from_draft, created_at, updated_at)`、`workflow_runs(id, template_id, params_json, status, started_at, ended_at)`、`workflow_run_steps(run_id, step_id, status, node_id, started_at, ended_at, outcome_json)`。`migrations.lock` 更新。
- 路由 `/api/workflows/*`（草案 list / confirm / discard，模板 CRUD，runs start / cancel / gates answer / list），形状登记进 `docs/contracts/core-json-api.md` 新 §。
- 装配：`core/workflow/index.ts::install(context)`，与 `schedule/index.ts` 同款「迁移未应用则不装」；排在 collab 与 terminal 之后。
- `collab/control/index.ts` 的 `VERBS` 加 `workflow-propose`，`control/workflow.ts` 校验草案后写 `workflow_drafts` 并推 bus 事件，页面出草案卡。

## §6 安全与审批

- 协调者的工具权限由 `ama` 的管线决定（文档 A §7）；画布工具按 §3 的权限类归类，`canvas_close` / `canvas_interrupt` 是 execute，缺省模式下要问。
- 问的渠道：第一版在**节点终端里**答（REPL 的 y / n）；同时 `tool_approval_requested` 上报让节点头部显示「等待批准」。画布直答（复用 `hook/approvals.ts` 的 pending 目录 + `armadra-hook` 的决定回写）第 2 期：适配器 `setBroker` 把请求写进 pending、等页面回答。
- 无人值守（自动化冷启动、`-p`）：`ask → deny`，这正是 `schedule` 域期望的失败方式——一条拒绝写进 tool_result，不会卡住。
- `send` 进协调者终端的任何文字都是资料：信任规则随 `instructions.md` 注入，与六家 CLI 用的是同一段文本。
- 适配器只在 `ARMADRA_NODE_ID` 存在时激活；节点令牌、bearer、`terminalBinding` 三层认证照旧，core 对适配器与 `armadra-hook` 不作区分。

## §7 API Key

| 步骤     | 位置                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 存       | `core/usage/secret-store.ts` 的 `SecretStore("ama-<provider>", dataDir)`；macOS 钥匙串，其余 0600 文件；设置页 Agent 页加「Armadra Agent 的模型密钥」字段，只回布尔 `isSet` 与后端名               |
| 用       | `agent/canvas-launch.ts` 每次启动前 `writeSecret(<data>/integration/ama/auth.json, …)`（`paths.ts` 已有 0600 写法），profile 指它的路径；进程退出不删——目录 0700、文件 0600，与 `hook-secret` 同级 |
| 不做     | 不放进 PTY 环境变量（`ps e` 可见、子进程继承）；不进启动行；不进 `injection.json`                                                                                                                  |
| 远端终端 | SSH 工作空间里的协调者第一版不支持（`remote.ts` 的产物同步不同步密钥）；注册表能力按执行主机裁掉                                                                                                   |

## §8 验收

`tools/probes/agent-e2e/scenario-11-coordinator.mjs`，`agent-e2e.mjs` 的 `only` 缺省集合加 `11`：

1. 起一个本地 OpenAI 兼容的**脚本化模型服务**（`lib.mjs` 新增 `mockModelServer(script)`），脚本按请求序列返回：第一轮 `canvas_team` 工具调用；收到唤醒后 `canvas_inbox` → `canvas_ack` → `canvas_sticky`；再一轮 `workflow_propose`。
2. 临时 HOME 下 `config.json` 指向该服务；`auth.json` 由 core 写入一个假 key。
3. `POST /api/terminals` 带 `nodeId` 与 `agent: "ama"`，启动参数取 `GET /api/agents` 的 `launchArgs`。
4. 断言：`agent_status` 出现 `ama` 行且 `stateSource = extension`；两个成员节点与两条边；成员节点由场景自己 `canvas post`；协调者的便签出现；`workflow_drafts` 一行；全程 `console.errors` 为空。
5. 画布外对照：同一临时 HOME 直接起 `ama -p`，`agent_status` 无该节点，技能与规则不可见。

另：`apps/desktop/src/core/agent/registry.test.ts`、`hook/normalize/normalize.test.ts`（`ama` 的 `agent_settled → idle`）、`hook/install/inject.test.ts`（profile 产物确定性）、`scripts/after-pack.test.mjs`（新资源条目）、`apps/desktop/src/agent-host/ama/*.test.ts`（工具表与 `VERBS` 一致、事件全订阅、无 `ARMADRA_NODE_ID` 不激活）。

## §9 分期

| 期  | 交付物                                                                                                                                                                        | 依赖文档 A |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B1  | §2 全部（七处一致、注入产物、启动器参数化、两条 bundle、after-pack、服务器壳）、§3 适配器（不含 `workflow_propose`）、§7 密钥、场景 11 的 1–4 步（不含草案）、文档登记        | 第 2 期    |
| B2  | `core/workflow/` 域：迁移 0030、草案与模板、`workflow-propose` 动词、草案卡、运行引擎（`prompt` / `collect` / `gate`）、执行记录、`/api/workflows/*` 契约；场景 11 加草案断言 | 第 2 期    |
| B3  | `core/history/ama.ts` 历史适配器（会话索引、转录、成本按 `message.usage` / `model` / `responseId`）；审批画布直答                                                             | 第 3 期    |
| B4  | RPC 子进程形态（会话视图里的协调者）、模板挂到自动化                                                                                                                          | 第 4 期    |

B1 可以在 `@armadra/agent` 第 2 期发 0.2.0 后立即开始；B2 的 core 部分不依赖 agent 版本，可与 B1 并行。

## §10 需要改的文件

新增：

- `apps/desktop/src/agent-host/ama/{main,client,events,tools,instructions}.ts` 与测试
- `apps/desktop/src/hook-client/{endpoint,http,session,json}.ts`（从 `cli/armadra-hook/` 移出，CLI 改 import）
- `apps/desktop/src/core/workflow/{index,types,store,service,engine,routes,draft}.ts` 与测试
- `apps/desktop/src/core/collab/control/workflow.ts`
- `apps/desktop/src/core/db/migrations/0034_workflow.sql`、`migrations.lock`
- `apps/desktop/src/core/history/ama.ts`（B3）
- `packages/shared/src/api/workflows.ts`
- `tools/probes/agent-e2e/scenario-11-coordinator.mjs`
- `docs/design/coordinator-agent.md`（本文）、`docs/design/workflow-engine.md`（B2 前）

修改：

- `packages/shared/src/agents.ts`、`packages/shared/src/domain/node-data.ts`、`packages/shared/src/hook-events.ts`
- `apps/desktop/src/core/agent/registry.ts`、`launch.ts`（`expectedProcesses`）、`canvas-launch.ts`（auth.json）、`registry.test.ts`、`launch.test.ts`
- `apps/desktop/src/core/settings/custom-agents.ts`
- `apps/desktop/src/core/hook/normalize/index.ts`、`hook/install/{inject,shared,events}.ts`、`hook/install/inject.test.ts`
- `apps/desktop/src/core/collab/control/index.ts`（`VERBS`）、`collab/skill.ts`（导出 `TRUST_RULE`）
- `apps/desktop/src/core/history/registry.ts`（B3）
- `apps/desktop/src/cli/armadra-hook/launcher.ts`、`windows-launcher.cs`、`apps/desktop/scripts/hook-launcher.mjs`
- `apps/desktop/electron.vite.config.ts`、`electron-builder.yml`、`scripts/after-pack.mjs`、`scripts/after-pack.test.mjs`、`package.json`
- `apps/server/scripts/build.mjs`
- `apps/web/src/panels/settings/pages/AgentPage.tsx`、`apps/web/src/i18n/*`
- `tools/release/compatibility.json`、`tools/release/version.mjs`（agent 版本检查）
- `tools/probes/agent-e2e/lib.mjs`（`mockModelServer`）、`agent-e2e.mjs`
- `docs/README.md`（登记两份新文档）、`docs/design/product-roadmap.md`（第三部分第一条）、`docs/guides/architecture.md`（§2 图加 `resources/agent/`、`agent-host/`）、`docs/contracts/core-json-api.md`（workflow §）、`docs/status/feature-roadmap.md`（3.2 加协调者行）
