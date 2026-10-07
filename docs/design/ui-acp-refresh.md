# 集成页、画布建 Agent、设置弹窗、节点头、ACP 会话视图、画布整理与多端加入刷新

> 状态：**目标设计（2026-10-07）**，按 §9 分 A–E 五个包实施；包 A（§1、§2、契约 §47 §48）实施中。基线 `main`（`fb54e0b1`），协议 `PROTOCOL_MINOR = 21`（`apps/desktop/src/core/identity/protocol.ts:12`），契约最大节号 §46（`docs/contracts/core-json-api.md:3488`）。
> 规范：`docs/design/design-system.md`（下称 DS）硬性规则 + `~/.claude/skills/better-*`；用户偏好：极简、无说明性文字、不中英混排、只用 `apps/web/src/ui/` 里的 shadcn 组件、功能代码里不手写 `<button className>`。
> 编号预分配（避免并行包冲突）：契约 §47、§48（包 A）→ 协议 1.22；§49（包 C）→ 1.23；§50 本轮不用（包 E 无契约改动）。不复用、不改任何已有 §N。

## 0. 结论

| #   | 问题                                             | 结论                                                                                                                                                                                                                                                                                                                 | 包  |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1   | 集成页一行堆满胶囊；原生 ACP 的 CLI 没有安装按钮 | 一家一张 `SettingsGroup`，固定 5 行（CLI / ACP / 画布注入 / 在画布中创建 Agent / 本地历史），**没有问题的行不出任何徽标**；`agents.installAdapter` 扩成两张白名单（适配器包 + CLI 包），`target: "adapter" \| "cli"`，失败可「恢复上一版本」                                                                         | A   |
| 2   | 「在画布中创建 Agent」没有展示，也不保证可用     | 能力来源是注入（终端驱动：`armadra-hook canvas open-agent / team`；ACP 驱动：`session/new.mcpServers` 的 `canvas_open_agent / canvas_team`；ama：`HostApi.runners`）。core 新增 `agents.integration.canvasAgents` 按驱动答可用性；集成页一行 + 节点菜单「派生 Agent…」入口；`pi-acp` 不接 MCP 要如实标「仅终端视图」 | A   |
| 3   | 设置弹窗固定 920×680                             | 改成视口比例：宽 `clamp(760px, 78vw, 1280px)`、高 `clamp(560px, 80vh, 960px)`，再被 `100vw/100dvh − 48px − 安全区` 夹住；平板满宽减 32；手机沿用 `ResponsiveDialog` 底部 Sheet 但改成整高                                                                                                                            | B   |
| 4   | 节点头右上角按钮 hover 才出现                    | 删除 `.node-secondary-action` 的 opacity 0 规则，全部常显；头部右侧统一为「胶囊簇 → 状态 → 审批 → 动作簇」四段，胶囊 18px 高、动作钮 24px、簇内 2px / 簇间 6px                                                                                                                                                       | B   |
| 5   | ACP 会话视图丑、不可点、内容类型覆盖不全         | 按协议 10 种 `session/update` + 4 种内容块 + 3 种工具内容 + 5 种 stopReason 逐类给展示与动作；根因候选是 React Flow 节点默认 `user-select: none` 与会话体缺 `nopan`；镜像补 `image / resource_link` 块，`acp.log` 补活进程快照（plan / usage / commands / title）                                                    | C   |
| 6   | 「整理」把导入内容打散、Agent 簇散落             | 整理单位改为「刚体」：组节点、导入批次（新建时就进一个 `group` 节点）、白板孤岛；顺序按原空间阅读顺序；主从关系按树排（主在左，从在右侧纵向等距），一次整理一条历史；支持只整理选中                                                                                                                                  | D   |
| 7   | 多端加入一次，其他端「全部刷新」                 | 主因已复现：终端尺寸会话级共享，新端 attach 的 resize 改掉所有 tmux 客户端并整屏重绘。改成「窗口尺寸 = 驾驶者的，否则最大端的」、每端客户端独立、`window-size manual`；次因 `announce()` 过频触发全量失效→分级收窄；租约丢失只读不重载                                                                               | E   |

---

## 1. 设置 → 集成

### 1.1 现状问题

| 位置                                                             | 问题                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/panels/settings/pages/IntegrationPage.tsx:188-241` | 一行里把 注入方式、Hook rev、技能 rev、待重新生成、ACP 状态+按钮、注入受限、已清理、旧残留、索引/成本/转录 **最多 11 枚** `Badge` 塞进标签列 `flex-wrap`，正常状态也全画；违反 DS §5.15「没有问题的行不出现任何提示」与 better-layout「hint, don't dump」 |
| `IntegrationPage.tsx:244-265`                                    | 右侧只有「重新生成」「修复」，而 ACP 的「安装 / 重新安装」却混在左列胶囊里（`adapter-install.tsx:130-142`）；动作分两处，阅读顺序断裂                                                                                                                     |
| `apps/web/src/acp/adapter-install.tsx:109-114`                   | `available === false`（不在 `ACP_ADAPTER_PACKAGES`）时只画「ACP 未安装」，**没有任何动作**——OpenCode / Oh My Pi / Copilot / ama 正是这一支                                                                                                                |
| `packages/shared/src/api/acp.ts:43-56`                           | `ACP_ADAPTER_PACKAGES` 只有 claude / codex / pi；`AGENT_CLI_PACKAGES` 只给复制命令用，不能代装；omp 注释「没有公开 npm 包」已过时（见 1.3）                                                                                                               |
| `apps/desktop/src/core/agent/adapter-install.ts:259-266`         | `packageOf` 只认适配器表；契约 §39.7 写死「只装三家」                                                                                                                                                                                                     |
| `IntegrationPage.tsx:202-209`、`i18n/integration.ts:20-26`       | 「未检测到 CLI」是徽标不是行，没有安装动作；`Hook rev 5` / `索引：可用` 这类中英混排、冒号拼接的文案（better-writing：不要从碎片拼句子）                                                                                                                  |
| `IntegrationPage.tsx:60-67`                                      | 加载态是一行文字「读取中…」，DS §5.16 要求 `Skeleton`                                                                                                                                                                                                     |
| `IntegrationPage.tsx:282-294`                                    | 本地历史三项（契约 §12.2）每项一枚徽标，`not-found` 与 `unsupported` 都要说，但不需要三枚常驻                                                                                                                                                             |

### 1.2 目标信息结构

页面 = 「Worker 待升级」分组（不变，`OutdatedWorkers`）+ **一家一张 `SettingsGroup`**（`title` = CLI 名，前面不加头像；DS §2.12 不引商标图）。每张固定 5 行，顺序按用户要做的事排：

```text
Claude Code
┌────────────────────────────────────────────────────────────────┐
│ CLI                 已安装 · 2.1.0                  [重新安装]  │  ← 版本只在这一行出现（DS §5.15 的「版本」行）
│ ACP                 未安装                          [安装]      │  ← 一处状态 + 一处动作
│ 画布注入                                            [重新生成]  │  ← 正常时右侧只有一个 ghost 钮；异常时左值变成问题词
│ 在画布中创建 Agent  会话视图 · 终端视图                          │  ← 见 §2
│ 本地历史            索引 · 成本 · 转录                           │  ← 只列可用的；一项都没有时整行不画
└────────────────────────────────────────────────────────────────┘
```

行的规则（`SettingsRow`，`panels/settings/SettingsRow.tsx`，不改组件）：

| 行                 | 左标签               | 右侧「值」（`text-[13px] text-muted-foreground`，不是徽标）                                                                                          | 右侧动作（至多一个，`Button size="sm"`）                                                                                                                                   | 异常态                                                                                                                                                                             |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                | `CLI`                | 已安装 `· {version}`（`probe.version` 有才带）/ 未检测到                                                                                             | 未检测到且 `AGENT_CLI_PACKAGES` 有它 → `secondary`「安装」；已安装 → `ghost`「重新安装」；表里没有（自定义条目）→ `ghost`「复制命令」（有命令时）                          | 安装中：按钮内 `Spinner` + 文案「安装中」；失败：行下一条 `Alert variant="destructive"` 单行「{包名} 没有装上」+ `AlertAction`「重试」「查看输出」「恢复上一版本」（有上一版本时） |
| ACP                | `ACP`                | 已安装 `· {acp.version}` / 未安装 / 随 CLI（`support: "native"` 且 CLI 已装时，不另写版本）                                                          | `official` / `community`：未装 → `secondary`「安装」，已装 → `ghost`「重新安装」；`native`：**没有动作**（装 CLI 即装 ACP，动作在 CLI 行）                                 | 同上，共用一条 `Alert`                                                                                                                                                             |
| 画布注入           | `画布注入`           | 正常：**空**；`stale` → 待更新；Hook 或技能缺 → `Hook 未生成` / `技能未生成`（两者都缺写「未生成」）；`launcherWarning` → 注入受限（`title` 给原因） | 正常 `ghost`「重新生成」；`stale` / 缺失 → `secondary`「重新生成」；`legacy.found.length > 0` → 第二个动作 `outline` 红字「修复 {count}」（弹层沿用 `LegacyBadge` 的清单） | 不支持 hooks 的条目（`!capabilities.includes("hooks")`）整行不画                                                                                                                   |
| 在画布中创建 Agent | `在画布中创建 Agent` | 见 §2.3：`会话视图 · 终端视图` / `仅终端视图` / `仅会话视图` / `不可用`                                                                              | 不可用且原因可修 → 同一个「安装」或「重新生成」钮（跳回上两行的动作，不另起一套）                                                                                          | —                                                                                                                                                                                  |
| 本地历史           | `本地历史`           | 可用项用 `·` 连：`索引 · 成本 · 转录`；`not-found` 的项写成 `索引（未找到）`；`unsupported` 的项不列                                                 | 无                                                                                                                                                                         | 三项都 `unsupported` → 整行不画                                                                                                                                                    |

去掉的东西：`integration.mode.*` 四枚（注入方式只剩「画布内注入」一种，DS 说明不写）、`已清理全局安装`（迁移完成是一次性事件，改成首次出现时一条 sonner 并记 `localStorage` 已提示）、三枚历史徽标、`Hook rev N` / `技能 rev N`（版本号不进 chrome；需要时在「重新生成」钮 `title` 里写 `第 {n} 版`）。

空态 / 加载：列表空 → `Empty`「没有可接入的 CLI」（已有键）；加载 → 两张 `SettingsGroup` 各 3 行 `Skeleton`（`h-4`，>300ms 才出现，DS §3.2）。

### 1.3 每家要装什么、怎么装

| Agent     | ACP 入口（`core/acp/adapters.ts:86-206`） | 装什么                                     | npm 包（核实来源）                                                                                        | 可执行名   | 备注                                                                                      |
| --------- | ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| claude    | 官方适配器 `claude-agent-acp`             | 适配器；CLI 另装                           | 适配器 `@agentclientprotocol/claude-agent-acp`（已在表）；CLI `@anthropic-ai/claude-code`                 | `claude`   | 适配器经 SDK 起 `claude`，登录沿用                                                        |
| codex     | 官方适配器 `codex-acp`                    | 适配器；CLI 另装                           | 适配器 `@agentclientprotocol/codex-acp`（已在表）；CLI `@openai/codex`                                    | `codex`    | 适配器自带兼容的 `@openai/codex`，但终端驱动仍要 CLI                                      |
| opencode  | 原生 `opencode acp`                       | CLI 即 ACP                                 | `opencode-ai`（npm registry 2026-10-07：1.18.35，bin `opencode`）                                         | `opencode` |                                                                                           |
| pi        | 社区适配器 `pi-acp`                       | 适配器；CLI 另装                           | 适配器 `pi-acp`（已在表，0.0.34）；CLI `@mariozechner/pi-coding-agent`（0.73.1）                          | `pi`       | 适配器不依赖 pi 包，CLI 必须另装                                                          |
| omp       | 原生 `omp acp`                            | CLI 即 ACP                                 | `@oh-my-pi/pi-coding-agent`（npm 18.8.0，bin `omp`；GitHub README 给的是 `bun install -g`，npm 同样可装） | `omp`      | 删除 `acp.ts:50` 「没有公开 npm 包」的注释                                                |
| copilot   | 原生 `copilot --acp --stdio`              | CLI 即 ACP                                 | `@github/copilot`（1.0.93）                                                                               | `copilot`  | 包的 `bin` 键是 `npm-loader.js`，但安装后 PATH 上的名字是 `copilot`；探测仍按 `launchCmd` |
| ama       | 原生 `ama --mode acp`                     | CLI 即 ACP                                 | `@armadra/agent`（0.7.1，bin `ama`）                                                                      | `ama`      |                                                                                           |
| `custom:` | 借 `baseAgent`                            | 不代装，只复制命令（`launchCmd` 是用户的） | —                                                                                                         | —          | 现状不变                                                                                  |

**怎么装**：沿用 `core/agent/adapter-install.ts` 的 `npm install --global <包>`——先用这家 CLI 所在 bin 目录的 npm，再退回 PATH（`locateNpm`，:150-178），子进程 PATH 以那个目录开头；CLI 还没装时只有 PATH 上的 npm 可用。不写 CLI 配置，不碰登录；npm 读用户自己的 `.npmrc`。Windows 的 `.cmd` 包装换 `node npm-cli.js`（`npmInvocation`，:128-146）不变。

**权限**：owner 且 `settings:write`（契约 §39.7 第 2 条不变）；成员 403；远程源（经中继看别人的 core）不出现安装按钮（`available === false` 的现有分支）。

**回滚**：npm 的全局安装是「解包到临时目录再改名」，中途失败不会留下半个包；要防的是「重新安装把能用的版本换成坏的」。任务开始前记 `previousVersion`（`npm ls --global --depth=0 --json <包>` 的 `dependencies.<包>.version`，拿不到就缺席）；`reinstall` 失败或结束后 `installed: false` 时，页面给「恢复上一版本」= `agents.installAdapter { agentId, target, rollback: true }` → `npm install --global <包>@<previousVersion>`。没有 `previousVersion` 就没有这个按钮。

**远端执行主机**：本轮不装。SSH 节点的 ACP 装没装由 Worker `agents.probe` 答（契约 §26.5），缺就 `acp_not_installed`；集成页仍是本机视角。后续包可加 Worker 操作 `agents.installAdapter`（能力位 `remote.integration.v2`），不在本文范围。

### 1.4 交互与状态

- 按钮点下去：按钮进 loading（`Spinner` 替换图标，宽度不变，DS §3.4），轮询 `agents.adapterInstall`（现有 1s 节奏），结束后 `invalidate(["agents"])` 与这家的 `agent-integration`。成功：sonner「{name} 已安装」；失败：行下 `Alert destructive` 单行 + 动作；「查看输出」= 现有 `OutputBadge` 的 `Popover`（最后 40 行，脱敏）改挂在这个按钮上。
- 同一家 CLI 行与 ACP 行的任务互斥（core 已经「同一家在装答同一任务」；两张表合并后键为 `${agentId}:${target}`，同一家两个 target 不并行，第二个答 409 `adapter_install_busy`）。
- 一家都装不了的那台机器（没有 npm，`npm_not_found`）：按钮仍在，点了之后同一条 `Alert`「没有找到 npm」+「复制命令」。
- `custom:` 条目：CLI 行值是 `launchCmd`，动作只有「复制命令」（有命令时）。

### 1.5 文案键（`apps/web/src/i18n/integration.ts`，中英同步；删除不再用的键）

| 键                                   | zh-CN                      | en                                        |
| ------------------------------------ | -------------------------- | ----------------------------------------- |
| `integration.row.cli`                | CLI                        | CLI                                       |
| `integration.row.acp`                | ACP                        | ACP                                       |
| `integration.row.injection`          | 画布注入                   | Canvas injection                          |
| `integration.row.canvasAgents`       | 在画布中创建 Agent         | Create agents on the canvas               |
| `integration.row.history`            | 本地历史                   | Local history                             |
| `integration.state.installed`        | 已安装                     | Installed                                 |
| `integration.state.installedVersion` | 已安装 · {version}         | Installed · {version}                     |
| `integration.state.missing`          | 未安装                     | Not installed                             |
| `integration.state.cliMissing`       | 未检测到                   | Not detected                              |
| `integration.state.viaCli`           | 随 CLI                     | With the CLI                              |
| `integration.state.stale`            | 待更新                     | Out of date                               |
| `integration.state.hookMissing`      | Hook 未生成                | Hook not generated                        |
| `integration.state.skillMissing`     | 技能未生成                 | Skill not generated                       |
| `integration.state.notGenerated`     | 未生成                     | Not generated                             |
| `integration.state.limited`          | 注入受限                   | Injection limited                         |
| `integration.action.install`         | 安装                       | Install                                   |
| `integration.action.reinstall`       | 重新安装                   | Reinstall                                 |
| `integration.action.installing`      | 安装中                     | Installing                                |
| `integration.action.copyCommand`     | 复制命令                   | Copy command                              |
| `integration.action.regenerate`      | 重新生成（已有）           | Regenerate                                |
| `integration.action.repair`          | 修复 {count}               | Repair {count}                            |
| `integration.action.rollback`        | 恢复上一版本               | Restore previous version                  |
| `integration.action.output`          | 查看输出                   | View output                               |
| `integration.install.failed`         | {name} 没有装上            | {name} was not installed                  |
| `integration.install.done`           | {name} 已安装              | {name} installed                          |
| `integration.install.npmMissing`     | 没有找到 npm               | npm not found                             |
| `integration.install.busy`           | 正在装另一项               | Another install is running                |
| `integration.history.index`          | 索引                       | Index                                     |
| `integration.history.cost`           | 成本                       | Cost                                      |
| `integration.history.transcript`     | 转录                       | Transcript                                |
| `integration.history.notFound`       | {part}（未找到）           | {part} (not found)                        |
| `integration.canvasAgents.both`      | 会话视图 · 终端视图        | Session view · Terminal view              |
| `integration.canvasAgents.terminal`  | 仅终端视图                 | Terminal view only                        |
| `integration.canvasAgents.acp`       | 仅会话视图                 | Session view only                         |
| `integration.canvasAgents.none`      | 不可用                     | Unavailable                               |
| `integration.migrated.notice`        | 已清理 {name} 的旧全局安装 | Removed the old global install for {name} |

保留：`integration.nav / empty / loading / legacy.count / repair.* / backup / outdatedHost* / resync* / acp.failure.*`。删除：`integration.mode.* / hook.revision / hook.missing / skill.revision / skill.missing / stale / launcherWarning / migrated / acp.missing / acp.installed / acp.installing / acp.failed / acp.install / acp.reinstall / acp.done / acp.output / agentMissing`（先 grep 其它引用，`NewAgentWizard` 用的 `wizard.*` 不动）。

### 1.6 无障碍

- 每个动作钮都有可见文字，不用纯图标；loading 时文字换成「安装中」，`aria-busy="true"`。
- 失败 `Alert` 用 `role="alert"`；安装成功的 sonner 走 `role="status"`（sonner 默认）。
- 行值文字对 `--card` ≥ 4.5:1（`--muted-foreground` 在 card 上 5.3，DS §2.1）；「修复」红字用 `--danger-text`（6.9）。
- 键盘：Tab 顺序 = 行顺序；`Popover`（输出）Esc 关闭并还焦点到按钮。

---

## 2. 在画布中创建 Agent

### 2.1 现有机制（查清）

| 驱动         | Agent 怎么建 Agent                                                                                                                                                                                                                                                                                                                   | 代码                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 终端驱动     | 注入的技能文本第 2 条要求「要建 Agent 一律 `armadra-hook canvas open-agent` / `canvas team`」；命令经 hook socket 到 `collab/control`，`open-agent` 落节点并自动从调用者连线（`--role supervises` 建主从），`--after` 走依赖表由 core 启动，`team` 一次多个（可 `--chain` / `--gather` / `worktree=`，成员进 worktree 绑定的 Frame） | `core/collab/skill.ts:65-70, 264-270`；`core/collab/control/index.ts:54, 69, 210, 233`；`core/collab/control/nodes.ts`（`openAgent` / `team`）；`core/collab/control/worktree.ts:217-259`（`frameFor`） |
| ACP 驱动     | 同一套动词以 MCP 工具暴露（`canvas_open_agent` / `canvas_team`，`hook-client/verbs.ts:408`），由 `session/new                                                                                                                                                                                                                        | load                                                                                                                                                                                                    | resume.mcpServers`带`armadra-hook mcp` 进去；core 分不出它与命令行的区别、不多给权限 | `core/acp/mcp.ts:1-40`；`core/acp/host.ts:565`（`acpMcpServers`）；适配器表 `injection.mcp`（`adapters.ts:102,118,134,152,168,185`） |
| ama          | 不走 MCP（`injection.mcp: false`，`adapters.ts:203`），由宿主适配器的 `HostApi.runners` 把 `task(agent=…)` 变成画布节点，`wait` 取进度（协调者设计修订）                                                                                                                                                                             | `docs/design/coordinator-agent.md:4`                                                                                                                                                                    |
| SSH 执行主机 | 终端驱动经远端画布注入；ACP 驱动 `mcpServers` 带执行主机上同步过去的 Hook 客户端，准备失败就不带、会话照常                                                                                                                                                                                                                           | `core/acp/ssh.ts:1-30`；契约 §26.5                                                                                                                                                                      |

现状缺口：

1. **ACP 下 Pi 不能建 Agent**：设计 §3.1 写明 `pi-acp`「MCP 参数接受但不接通」，但 `adapters.ts:152` 仍 `mcp: true`，页面无从得知。
2. **`AcpClient.features.mcpServers`**：旧版客户端不带 MCP 时 `sessionOpener` 如实答 `mcpInjected: false`（`mcp.ts:14-19`），但没有任何界面读它。
3. **终端驱动的前提**：Hook + 技能已生成且启动器正常（`launcherWarning` 为 Windows 没有启动器 / Codex 太旧不带 Hook 时，技能照样注入但 `open-agent` 的 hook 身份缺）——页面没有把这三件事合成一个答案。
4. **人的入口**：画布上只有「新建 Agent…」（Dock +，`canvas/menus/add-menu.ts:203`），没有「从这个节点派生一个从」；主从边只能靠 Agent 自己 `--role supervises` 或 `canvas link`。
5. **`team` 不带 `--cwd / --resume`**（协调者设计剩余项）——不在本文范围，记一笔。

### 2.2 core / 契约改动（§48，协议 1.22，包 A）

`agents.integration` 出参追加 `canvasAgents`（已知字段 + 透传的口径不变）：

```json
"canvasAgents": {
  "terminal": "available" | "limited" | "unavailable",
  "acp":      "available" | "limited" | "unavailable" | "none",
  "reasons":  ["hook_missing" | "skill_missing" | "launcher_limited" | "cli_missing" | "acp_missing" | "mcp_not_wired" | "client_without_mcp"]
}
```

判法（`core/hook/install/integration.ts` 里算，纯函数，单测）：

- `terminal`：`hook.installed && skill.installed && !launcherWarning` → `available`；技能在、Hook 缺或 `launcherWarning` → `limited`（能发命令但没有节点身份，core 会拒）；CLI 没装或技能缺 → `unavailable`。
- `acp`：这家没有 `acp` 键 → `none`；`acp.installed === false` → `unavailable`（reason `acp_missing`）；适配器 `canvasTools === "none"`（新字段，见下）→ `limited`（reason `mcp_not_wired`）；`AcpClient.features.mcpServers` 为假 → `limited`（`client_without_mcp`）；否则 `available`。ama 的 `canvasTools: "runners"` → `available`。
- `AcpAdapter` 加 `readonly canvasTools: "mcp" | "runners" | "none"`：claude / codex / opencode / omp / copilot = `mcp`，ama = `runners`，pi = `none`（同时 `injection.mcp` 改 `false`——既然不接通就不带，少起一个 MCP 子进程）。`adapters.test.ts` 守：`canvasTools === "mcp"` ⇔ `injection.mcp`。

事件无变化；`GET /api/agents/{id}/integration` 与 procedure 同一份实现。

### 2.3 展示位置

1. **集成页**第 4 行（§1.2）：`terminal` 与 `acp` 都 `available` → `会话视图 · 终端视图`；只一边 → `仅会话视图` / `仅终端视图`；都不行 → `不可用` + 复用上两行的修复动作（原因是 `acp_missing` 给「安装」，`hook_missing / skill_missing` 给「重新生成」，`cli_missing` 给 CLI 行的「安装」）。`limited` 当作不可用对待但 `title` 带原因词。
2. **新建向导**（`acp/NewAgentWizard.tsx:159-200`）：行尾不加字；行不可用的原因已有。不画「能建 Agent」徽标——向导问的是「用哪家」，不是「它会不会分工」。
3. **节点头 `···` 菜单**（`nodes/terminal-menu.ts`）：Agent 节点多一项「派生 Agent…」→ 打开同一个向导（`wizard-open.ts` 加 `supervisorNodeId`），创建成功后 `addEdge({ source: supervisor, target: new, role: "supervises" })`，并把新节点放在主节点右侧（`placement` 同 core 的 `collab/control/board.ts:171-193` 规则：右侧 +间距，纵向错开）。这就是人替 Agent 做 `canvas open-agent --role supervises` 的那条路，与 Agent 自己做的结果一模一样（头部「主 · N 从」胶囊立刻出现）。
4. **会话视图**不加专门入口：Agent 建 Agent 是它的工具调用，会在工具行里以 `canvas_open_agent` 标题出现（§5 的工具行按 `kind: other` 画扳手图标；标题是 MCP 给的，本文不改）。

文案键：`node.menu.spawnAgent`（`i18n/nodes.ts`）「派生 Agent…」/ "Spawn agent…"；`wizard.title.spawn`（`i18n/acp.ts`，由包 A 加在 `integration.ts` 里改名为 `integration.wizard.spawnTitle` 以避开包 C 的文件）「派生 Agent」/ "Spawn agent"。

---

## 3. 设置弹窗尺寸

### 3.1 现状

`apps/web/src/panels/SettingsDialog.tsx:96`：`h-[680px] w-[920px]` 固定，`max-*` 只在小于它时起作用；DS §2.7 第 140 行把 920×680 写成常量。27 寸屏上弹窗只占视口 1/3，页面内容（集成页五行表）被挤到 680 的高度里反复滚。`ResponsiveDialog.tsx:65-99` ≤767 换底部 Sheet，高度 `auto`——设置有左导航，`auto` 高度让导航与正文抢高度。

### 3.2 目标

| 视口                            | 宽                                                                   | 高                                                                   | 布局                                                                               |
| ------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 桌面 ≥1024                      | `clamp(760px, 78vw, 1280px)`，再 `min(…, 100vw − 48px − 安全区左右)` | `clamp(560px, 80vh, 960px)`，再 `min(…, 100dvh − 48px − 安全区上下)` | 左导航 200 不变；正文列 `max-w-[960px]`，靠左不居中（阅读起点固定）；页头 64 不变  |
| 平板 768–1023                   | `100vw − 32px`                                                       | `100dvh − 48px − 安全区`                                             | 两栏保留（DS §5.13），导航 176                                                     |
| 手机 ≤767（`useCompactLayout`） | Sheet 满宽（现状）                                                   | **整高**：`h-[calc(100dvh-48px-var(--safe-top))]`（现在是 `auto`）   | 沿用现有的手机形态（导航变顶部横滚的分区列表由 `SettingsBody` 现状决定，本文不动） |

落点：`styles/tokens.css` 新增 `--settings-dialog-w` / `--settings-dialog-h`（上面两条 `clamp`），`SettingsDialog.tsx:96` 改为 `w-[var(--settings-dialog-w)] h-[var(--settings-dialog-h)]` + 原来的 `max-*`；`styles/tokens.test.ts` 的 `LAYOUT_CONSTANTS` 只增不改；DS §2.7「对话框 920×680（设置）」改为引用这两条 token。

为什么是 78vw / 80vh：1440×900 得 1123×720（比现在大 22%/6%），1920×1080 得 1280（封顶）×864，1280×800 得 998×640——三档常见屏都在 760–1280 内，不出现「比现在还小」。

### 3.3 测试

- `SettingsDialog.test.tsx`：渲染后 `DialogContent` 的 class 含两条 token；jsdom 不算布局，断言 class 即可。
- `tokens.test.ts`：两条 token 存在且形如 `clamp(`。
- 探针：`tools/probes/design-showcase.mjs --only=components --width=1280,1920,1024,390` 截设置弹窗四档（展示页 `sections/components.tsx` 已有设置分区则复用，没有则加一个「设置」fixture）。

---

## 4. 节点头右上角常显与统一

### 4.1 现状

- `styles/nodes.css:119-137`：`.node-secondary-action { opacity: 0; pointer-events: none }`，hover / 选中 / 打开菜单 / focus-visible 才显示；触屏常显（:139-143）。`NodeShell.tsx:392-396` 的注释说「关闭钮与 ··· 一起出现」——两者一起隐藏，而「主 · 3 从」「6.6 MB」常显，于是同一行里一半常显一半 hover，用户看到的就是「有时有有时没有」。
- 胶囊来源各自为政：`SupervisionBadge.tsx:29-33` `secondary h-[18px] px-1.5 caption`；`HeaderChips.tsx:55-58` 溢出计数 `outline`；`MemoryBadge`（`panels/resources/MemoryBadge.tsx`）自己的 `Popover` 触发器；`nodes.css:166-170` 胶囊 `max-width 130px`、簇 `max-width 28%`。
- 状态胶囊 `StatusPill`（18px）、审批两枚 `Button size="xs"` ghost 带字、`headerActions`（编辑器的保存等）、`···`、`×` 四段之间 `gap-1`（4px）一刀切，簇与簇没有区分（better-layout：簇间 ≥ 2× 簇内）。

### 4.2 目标

**全部常显**。删除 `nodes.css:119-143` 整段（含触屏覆盖与 reduced-motion 里的 `.node-secondary-action`），`NodeShell.tsx` 与各节点里的 `node-secondary-action` / `terminal-secondary-action` 类名只保留给 ≤360 容器查询隐藏用（`nodes.css:192-195`）。头部不再有任何「出现 / 消失」的控件；连线把手的 hover 显示（:207-211）是把手不是按钮，保留。

**头部四段**（从右往左读，`items-center`，头部 30px）：

```text
[色点][标题……][名字][主 · 3 从]  [6.6 MB][交接][排队]  [运行中]  [✓允许][✗拒绝]  [保存][···][×]
 ─── 身份段 ───────────────────   ── 胶囊簇 ──────────   状态     ── 审批 ──     ── 动作簇 ──
```

| 段     | 元素                                                                      | 尺寸与样式                                                                                                                                                                                              | 间距                              |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 身份   | `headerMark` 色点 + 标题 + `NodeNameBadge` + `SupervisionBadge`           | 名字与主从 `Badge variant="secondary"` 18px / caption / `px-1.5`（现状）                                                                                                                                | 内 4px                            |
| 胶囊簇 | `HeaderChips`：内存、账号、交接、依赖、驱动、排队、上下文读取、工作流步号 | 一律 `Badge variant="outline"` 18px / caption / `px-1.5` / `tabular-nums`；异常值（退出码、过期）用 `variant="destructive"`；可点的用 `Badge asChild` 包 `Button variant="ghost" size="xs"`（现有写法） | 内 4px，与身份段 **8px**          |
| 状态   | `StatusPill`                                                              | 18px，不变                                                                                                                                                                                              | 与左右 8px                        |
| 审批   | 两枚 `Button size="xs" variant="ghost"`                                   | 不变；≤440 只留图标（现状）                                                                                                                                                                             | 内 2px，与左右 8px                |
| 动作簇 | `headerActions`（各节点自己的，如编辑器保存）+ `···` + `×`                | 全部 `IconButton size="inline"`（24px，图标 14，`stroke 1.5`）；`×` hover `--danger-text`（现状）                                                                                                       | 内 **2px**，与审批 / 状态 **8px** |

实现：`NodeHeader` 根 `gap-1` 改成四个 `span` 容器各自 `gap-0.5` / `gap-1`，容器之间用 `ml-2`（逻辑属性 `ms-2`）；不新增 CSS 类名以外的东西。`MemoryBadge` 的触发器改成和其他胶囊一样的 `Badge outline` 外观（现在它自己写样式），`DriveBadge / HandoffBadge / DeliveryQueueBadge / DependencyWaitBadge / ContextReadsBadge / AccountBindingBadge` 逐个对齐到同一组 class（建议抽 `nodes/header-chip.ts` 导出一条常量 `HEADER_CHIP_CLASS`，不新造组件）。

溢出：`MAX_VISIBLE_CHIPS = 3` 与 `···{count}` 不变；胶囊 `max-width 130px` 不变，但 `.node-header-chips { max-width: 28% }` 改为 `max-width: 40%`——按钮常显后标题还要能放下，宽节点上 28% 太抠；≤440 隐藏胶囊簇与状态（现状）。

动效：删除 `.node-secondary-action` 的过渡；`×` 的 hover 颜色保留 `--dur-fast`。

### 4.3 无障碍

- `IconButton` 已强制 `aria-label`；审批钮已有。胶囊若可点必须是 `Button`（`Badge asChild`），纯信息胶囊 `title` 给全文。
- 常显后 24px 命中区满足 WCAG 2.5.8；触屏 `::after` 扩到 44 的现有规则保留。
- 焦点环：`IconButton` 用 shadcn 的 `focus-visible` 环，常显后不再需要 `:focus-visible` 才显形的特例。

### 4.4 测试

- `NodeShell.test.tsx`：`···` 与 `×` 在未 hover / 未选中时就在文档里且 `pointer-events` 不是 `none`（jsdom 用 class 断言：没有 `node-secondary-action` 里的 opacity 规则 → 直接断言 `nodes.css` 文本不含 `opacity: 0` 于该选择器，仿 `tokens.test.ts` 读文件的做法）。
- `HeaderChips` 快照：三枚以内全显、第四枚折叠（现有用例不变）。
- 展示页 `sections/canvas.tsx` 加「节点头：全部胶囊 + 审批 + 动作」固定状态；探针 `design-showcase.mjs --only=canvas` 两主题。

---

## 5. ACP 会话视图

### 5.1 现状问题

| 位置                                 | 问题                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acp/store.ts:128-132`、`:85-120`    | `textOf` 只认 `text` 块：`image / resource / resource_link` 全丢；`available_commands_update`、`session_info_update` 没有 case；`plan` / `usage` 存进了 view 但 `MessageList` 从不渲染                                                                                                                                                                                                                                                                                                                                   |
| `acp/MessageList.tsx:48-80`          | 用户消息是一个 `div`，助手消息是 `Markdown`；两者都没有任何动作（复制 / 重发 / 编辑）；没有时间；回合之间没有分隔                                                                                                                                                                                                                                                                                                                                                                                                        |
| `acp/MessageList.tsx:20-40`          | 思考折叠只有一行 11px 按钮，流式思考期间看不出在动                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `acp/ToolCallRow.tsx:63-73, 103-156` | 输出只拼 `text` 块；`locations[]` 不画；`terminal` 内容不处理；`completed` 画成 `idle` 灰胶囊（:46）与「等待」难分；没有复制                                                                                                                                                                                                                                                                                                                                                                                             |
| `acp/DiffBlock.tsx:58-84`            | 只有「打开」；没有「复制」「落为变更节点」；不在工作区内的文件连路径都不能复制                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `acp/PermissionCard.tsx:77-97`       | 只有工具标题；看不到这次要改什么（`toolCall.content` 的 diff / `rawInput`）就得答                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `acp/SessionView.tsx:519-543`        | 回合结束只区分「没完成 / 没送达」；`max_tokens / max_turn_requests / refusal / cancelled` 四种 `stopReason` 全被 `normalize.ts` 折成 `done`，页面没有对应的一行                                                                                                                                                                                                                                                                                                                                                          |
| `acp/SessionView.tsx:548-557`        | 根 `div` 没有 `nopan` / `select-text`；React Flow 给 `.react-flow__node` 的默认样式是 `user-select: none; cursor: grab`（`@xyflow/react/dist/style.css`），节点体只有 `nodrag nowheel`（`NodeShell.tsx:258`）。**「什么都不能点」的根因要在浏览器里核实**：候选是 (a) 文字不可选被当成不可点，(b) 手形工具开着时（`FlowWorkspace.tsx:419` 改 `panOnDrag`）pane 抢了 pointerdown，(c) `ExportMenu` 包住整条助手消息。设计上三条都堵：根 `select-text nopan`，体内所有可点的都是 `Button`，`ExportMenu` 只包工具条不包正文 |
| `acp/PromptBox.tsx`                  | 没有 `/` 命令提示（`available_commands_update`），没有用量，没有「编辑后重发」的回填入口                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 远端                                 | SSH 节点在头部有主机胶囊（`TerminalNode.tsx:431-437`）但会话体内「打开」按工作区相对路径算（`DiffBlock.tsx:18-30`）——远端工作区的根是那台机器的路径，`workspaceRelative` 仍成立；经中继看别人 core 的会话（`sources/scope.ts`）没有任何标识                                                                                                                                                                                                                                                                              |

### 5.2 内容类型 → 展示 → 动作

协议来源：`@armadra/agent/dist/drivers/acp/types.d.ts:36-67, 184-290`（`AcpContentBlock` 四种、`AcpToolCallContent` 三种、`AcpSessionUpdate` 十种、`AcpStopReason` 五种）；core 侧 `clientCapabilities: { fs: false, terminal: false }`（`client.js:76`），所以 `terminal` 内容块与 `fs/*` 请求**不会出现**。

| 类型                                          | 组件与排版                                                                                                                                                                                                                                                                                                                                                                                                                                     | 动作（悬停 / 聚焦出现的 `IconButton inline` 工具条；触屏常显；键盘 Tab 可达）                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message_chunk`                          | 右对齐 `--surface-raised` 气泡（现状），`max-w-[85%]`，`whitespace-pre-wrap`，`overflow-wrap: anywhere`；`image` 块 → 缩略图 `max-h-40` 带 1px `oklch(0 0 0/0.1)`（浅）/ `oklch(1 0 0/0.1)`（深）outline；`resource_link` / `resource` → `Badge outline` 文件名                                                                                                                                                                                | 复制；编辑后重发（把文本回填 `PromptBox`，光标在末尾，不自动发）；重新发送（只在它是最后一回合且该回合失败 / 被取消时）                                                                                                                                                         |
| `agent_message_chunk`                         | 左对齐无底色 `Markdown`（现状），代码块 `Card raised` 12px 等宽 + 右上「复制」；`image` 块同上；`resource_link` → `Item size="sm"`：图标按 `mimeType`，标题 `name`，副标题 `uri` 截断                                                                                                                                                                                                                                                          | 复制整条；输出到画板（现有 `ExportMenu` 四项）；重新生成（最后一回合：重发该回合的用户消息）；`resource_link`：打开（`file://` 且在工作区内 → 编辑器节点；`http(s)` → 浏览器节点；其余只复制链接）、复制链接                                                                    |
| `agent_thought_chunk`                         | `Collapsible`「思考」默认折叠（现状）；流式期间触发器后跟 `Spinner 12`，折叠时显示首行摘要 40 字（`text-muted-foreground`）                                                                                                                                                                                                                                                                                                                    | 展开 / 折叠；复制                                                                                                                                                                                                                                                               |
| `tool_call` / `tool_call_update`              | `Item size="sm"` 一行（图标按 `kind`，现状）：标题 13px、`locations[]` 画成 ≤2 枚 `Badge outline` 文件名（`title` 全路径，多的折成 `+N`）、`StatusPill`（`pending=queued`、`in_progress=working`、`completed=done`（**新 tone，DS §2.3 已定义**）、`failed=failed`）、展开钮；展开区：入参 / 输出各一块（现状）；`content[]` 里 `content` 文本块进输出，`diff` 块各一张 `DiffBlock`，`terminal` 块一行灰字「终端输出不可用」（防御，不会出现） | 展开 / 折叠；复制输出；复制入参；`locations` 胶囊点击 → 打开编辑器并跳到 `line`；`kind: execute` 多一个「复制命令」（`rawInput.command` 或 `rawInput` 字符串）；`failed` 多一个「让它重试」= 发送提示 `请重试：{title}`（文案键，用户可改后再发：走「编辑后重发」同一条回填路） |
| `tool_call.content[].diff`                    | `DiffBlock`（现状）：头行 文件名 · `+n −m` · 动作；`hunk` 复用 `PatchBody`；超过 200 行折叠到 60 行 + 「展开全部」                                                                                                                                                                                                                                                                                                                             | 打开（工作区内）；复制补丁；落为变更节点（`addNode("diff", …)` + 来源连线，与输出到画板同一条历史合并）；复制路径（总有）                                                                                                                                                       |
| `plan`                                        | **回合顶部**一张 `Card` 「计划」（`Collapsible`，默认展开，回合结束后自动折叠成一行 `3/5 已完成`）；每条 `Item size="sm"`：状态图标（`pending` 空圆 / `in_progress` `Spinner` / `completed` 勾，图标 + 文字，不只靠颜色）、内容、`priority: high` 时一枚 `Badge outline`「高」                                                                                                                                                                 | 展开 / 折叠；复制为清单                                                                                                                                                                                                                                                         |
| `current_mode_update`                         | `PromptBox` 的模式 `Select` 跟着变（现状）+ 消息流里一行居中 11px 灰字「模式已切换为 {name}」                                                                                                                                                                                                                                                                                                                                                  | 无                                                                                                                                                                                                                                                                              |
| `config_option_update`                        | 模型目录（现状）                                                                                                                                                                                                                                                                                                                                                                                                                               | 无                                                                                                                                                                                                                                                                              |
| `usage_update`                                | `PromptBox` 底栏右侧 `tabular-nums`「{used} / {size}」+ 2px 高 `Progress`；`cost` 有则在 `title` 里；≥90% 变 `--warn-text`（文字 + 颜色）                                                                                                                                                                                                                                                                                                      | 无                                                                                                                                                                                                                                                                              |
| `available_commands_update`                   | `PromptBox` 里输入 `/` 开头时弹 `Command`（现有组件）列表：`name` + `description`，上下键选、Enter 插入 `/name `                                                                                                                                                                                                                                                                                                                               | 插入                                                                                                                                                                                                                                                                            |
| `session_info_update`                         | 不画。`title` 写进 store；节点标题还是缺省（没改过名）时作为「AI 命名」的建议值（`agents.suggestTitle` 之外的一条来源，页面本地用，不进 core）                                                                                                                                                                                                                                                                                                 | 无                                                                                                                                                                                                                                                                              |
| `session/request_permission`                  | `PermissionCard`（现状位置规则不变）：标题 + **一行可展开的「详情」**（`toolCall.content` 的 diff 预览 / `rawInput` 20 行 / `locations`）；选项按 kind 两组（现状）                                                                                                                                                                                                                                                                            | 允许 / 本次允许 / 拒绝 / 始终拒绝（现状）；展开详情；钉住时焦点自动落到第一枚允许钮（`autoFocus`），Esc 不答                                                                                                                                                                    |
| `elicitation/create`                          | `ElicitationCard`（现状）                                                                                                                                                                                                                                                                                                                                                                                                                      | 现状                                                                                                                                                                                                                                                                            |
| `acp.turn` `end_turn`                         | 不画                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                                               |
| `acp.turn` `max_tokens` / `max_turn_requests` | 回合尾一行居中灰字「已到上限」+ `Button xs outline`「继续」（发送提示「继续」）                                                                                                                                                                                                                                                                                                                                                                | 继续                                                                                                                                                                                                                                                                            |
| `acp.turn` `refusal`                          | `Alert`（非 destructive）「这一轮被拒绝」+「编辑后重发」                                                                                                                                                                                                                                                                                                                                                                                       | 编辑后重发                                                                                                                                                                                                                                                                      |
| `acp.turn` `cancelled`                        | 一行居中灰字「已停止」                                                                                                                                                                                                                                                                                                                                                                                                                         | 重新发送                                                                                                                                                                                                                                                                        |
| `acp.turn.error`                              | `Alert destructive`「这一轮没有完成」+「重试」（现状）                                                                                                                                                                                                                                                                                                                                                                                         | 重试                                                                                                                                                                                                                                                                            |
| 「确认中」/ 没送达                            | 现状（契约 §39.9）                                                                                                                                                                                                                                                                                                                                                                                                                             | 重试沿用 `clientTurnId`                                                                                                                                                                                                                                                         |
| 流式中                                        | 最后一条尾部 `Spinner 12`（现状）；`PromptBox` 发送钮变「停止」（现状）                                                                                                                                                                                                                                                                                                                                                                        | 停止 = `session/cancel`                                                                                                                                                                                                                                                         |

### 5.3 整体排版

```text
┌ 节点头（§4）───────────────────────────────────────────────┐
│ ScrollArea（p-2.5，gap-3 回合之间 / gap-1.5 回合内）        │
│  ── 回合 1 ─────────────────────────── 14:02 ──            │  ← 11px 灰字时间，只在回合第一条用户消息右上
│                               ┌ 用户消息 ┐  [⧉][✎]         │
│  ┌ 计划 3/5 ▸ ┐                                            │
│  助手段落 …                                  [⧉][⇪][↻]     │
│  ▸ 思考 ·「先看一下 src/x…」                                │
│  ⌁ 读取 src/x.ts  [src/x.ts]            已完成  ▸          │
│  ✎ 编辑 src/x.ts  [src/x.ts]            已完成  ▾          │
│    ┌ src/x.ts  +12 −3      打开 · 复制 · 落为变更 ┐        │
│    │ hunk…                                        │        │
│  ┌ 权限 Card（--warn 左边 2px）──────────┐                  │
│  │ 运行 pnpm test              详情 ▸    │                  │
│  │ [允许][本次允许]  [拒绝][始终拒绝]     │                  │
│  └───────────────────────────────────────┘                  │
│  ── 已到上限 ·[继续]──                                      │
├ PromptBox ──────────────────────────────────────────────────┤
│ Textarea（1–6 行）        [模式 ▾][模型 ▾]   12.3k/200k [发送]│
└─────────────────────────────────────────────────────────────┘
```

- 回合分组：`AcpItem.turn` 已有；每回合一个 `section`，第一条用户消息右上角时间（`TranscriptEntry.at`），回合内 `gap-1.5`，回合间 `gap-3`（≥2×，better-layout）。
- 工具条：每条消息 / 工具行右上角一个 `absolute` 的 `IconButton inline` 组，`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`，触屏（`(hover: none)`）常显——**这是消息级的次要动作**，与节点头的常显要求不同；每个钮都有 `aria-label`，Tab 可达时自然显形。
- 文字可选：根 `select-text`（覆盖 React Flow 的 `user-select: none`），`nopan nodrag nowheel`。
- 代码与路径：`font-mono text-[length:var(--text-code)]`，`overflow-wrap: anywhere`；长 URI 截断 `text-overflow: ellipsis` + `title`。
- 用户气泡宽度 `max-w-[85%]`；助手段落 `max-w-[72ch]`（better-typography 量宽）。
- 空 / 加载 / 错误 / 离线：现状保留（`Empty` / `Skeleton` / `Alert` / 顶部 `Alert`）。
- 手机：同一组件（DS §5.1）；工具条常显；`Command` 弹层用 `Sheet bottom`（`ui/command` 已有 `CommandDialog`，手机走 `ResponsiveDialog`）。

### 5.4 远端（SSH 执行主机 / 经中继）

| 情形                                                    | 差异                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH 节点（`data.ssh.hostId`，契约 §26.5）               | 头部主机胶囊（现状）；会话体内**不再重复主机名**。`DiffBlock` / `locations` 的「打开」只在路径落在该工作区根下（远端根）时出现——`workspaceRelative` 用的就是工作区根，无需改；`resource_link` 的 `file://` 同理。「落为变更节点」照常（数据在镜像里）。转录 `transcriptPath` 指向本机镜像。权限请求、取消、模式切换时延更长：发出后按钮立即进 loading（现状「先收起再发」），不加「正在发送」文字 |
| 经中继看别人的 core（`scoped(sessionId)` 的源不是本机） | 节点头 `HeaderChips` 多一枚 `Badge outline`「{源名}」（源名来自 `api/source.ts` 的 `Source.name`）；`PromptBox` 按 `useCanAnswer` / `terminal:drive` 决定可写（现状）；没有安装 / 重新生成这类本机动作（它们本来就在设置页）；「确认中」对账（§39.9）照旧。不做任何「远端模式」的另一套样式                                                                                                       |
| 两份视图同挂（手机焦点页 + 画布）                       | 现状去重（`firstTime`）不变                                                                                                                                                                                                                                                                                                                                                                       |

### 5.5 core / 契约（§49，协议 1.23，包 C）

1. **镜像多两种块**（`core/acp/session.ts` 写镜像处；共享层 `transcriptBlockSchema`，`packages/shared/src/api/acp.ts:397-405`）：`{ type: "image", mimeType, data }`（base64 ≤ 512 KiB，超过则记 `{ type: "image", mimeType, dropped: true }`）与 `{ type: "resource_link", uri, name, mimeType?, title? }`；`resource`（内嵌）按 `text` 有则记成 `text`，否则记成 `resource_link`。镜像 `tool_result` 的 `content[]` 同样保留 `diff` 块（现在截 8000 字符的规则不变，diff 不截）。
2. **`acp.log` 活进程快照**：出参多 `snapshot?: { plan: AcpPlanEntry[], usage: { used, size, cost? } | null, availableCommands: { name, description }[], title: string | null }`，只在有活进程时出现（与 `modes` / `pending` 同一条件）。重载页面后计划与用量不丢。
3. 事件 `acp.update` 原样转发已覆盖十种 update，无变化。`acp.turn` 已带 `stopReason`，无变化。
4. `core/acp/normalize.ts` 不动（状态归一化与展示分离）。

### 5.6 文案键（`apps/web/src/i18n/acp.ts`，包 C 独占此文件）

`acp.turn.at`（`{time}`）、`acp.message.copy`「复制」、`acp.message.copied`「已复制」、`acp.message.editResend`「编辑后重发」、`acp.message.resend`「重新发送」、`acp.message.regenerate`「重新生成」、`acp.thought.working`「思考中」、`acp.tool.copyOutput`「复制输出」、`acp.tool.copyInput`「复制入参」、`acp.tool.copyCommand`「复制命令」、`acp.tool.retry`「让它重试」、`acp.tool.retryPrompt`「请重试：{title}」、`acp.tool.terminalUnavailable`「终端输出不可用」、`acp.tool.status.completed` 改「已完成」（已有）、`acp.tool.locations.more`「+{count}」、`acp.diff.copy`「复制补丁」、`acp.diff.toNode`「落为变更节点」、`acp.diff.copyPath`「复制路径」、`acp.diff.expand`「展开全部」、`acp.plan.title`「计划」、`acp.plan.progress`「{done}/{total} 已完成」、`acp.plan.high`「高」、`acp.plan.copy`「复制为清单」、`acp.mode.switched`「模式已切换为 {name}」、`acp.usage`「{used} / {size}」、`acp.commands.empty`「没有匹配的命令」、`acp.turn.limit`「已到上限」、`acp.turn.continue`「继续」、`acp.turn.continuePrompt`「继续」、`acp.turn.refused`「这一轮被拒绝」、`acp.turn.cancelled`「已停止」、`acp.permission.details`「详情」、`acp.link.open`「打开」、`acp.link.copy`「复制链接」、`acp.image.alt`「Agent 发来的图片」、`acp.source.remote`「{name}」（源名是数据，不翻译）。英文逐条同步；`i18n.test.ts` 的四条守卫自动覆盖。

### 5.7 无障碍

- 工具条按钮全部 `aria-label`；消息区 `role="log"` + `aria-live="polite"`（流式分块不逐块读：只在回合结束时把最后一条助手文本放进一个稳定的 `role="status"` 区域）。
- 工具行是 `Collapsible`：触发器 `aria-expanded`；`StatusPill` 文字 + 颜色（DS §1 第 3 条）。
- 计划项状态用图标 + `sr-only` 文字。
- 焦点：权限卡钉住时 `autoFocus` 到第一枚允许钮，Esc 不答、不关；`Command` 弹层 Esc 关并还焦点到 `Textarea`。
- 对比：助手正文 `--text` 12.5:1；时间 / 灰字 `--muted-foreground` 5.3:1；代码块文字在 `--surface-raised` 上用 `--text`（DS §2.4 末条）。
- 图片 `alt` 用 `acp.image.alt`；装饰 outline 不进 `alt`。
- `prefers-reduced-motion`：工具条 opacity 过渡 `--dur-fast` 以内，Spinner 停成静态点（DS §2.10）。

### 5.8 测试

- `store.test.ts`：十种 update 各一条用例；`image / resource_link` 进 item；`plan` 回合结束自动折叠状态；`session_info_update` 写 `title`。
- `MessageList.test.tsx` / `ToolCallRow.test.tsx`（新）/ `DiffBlock.test.tsx` / `PermissionCard.test.tsx`：每类内容的动作按钮存在且可点（`fireEvent.click` 后调用了 `navigator.clipboard.writeText` / `openFileInEditor` / `onResend`）；`completed` 用 `done` tone。
- `SessionView.test.tsx`：五种 `stopReason` 各画对那一行；根元素含 `select-text nopan`；`/` 触发命令列表。
- core：`session.test.ts` 镜像块；`routes.test.ts` `acp.log.snapshot`。
- 探针：`tools/probes/acp-e2e.mjs` 加一步点工具行展开、点复制（断言剪贴板），`design-showcase.mjs --only=acp` 两主题 + 390 宽；展示页 `fixtures/acp.ts` 补 image / resource_link / plan / 五种 stopReason 的假数据。

---

## 6. 画布「整理」与导入分组

### 6.1 现状

- 算法 `apps/web/src/canvas/tidy.ts:144-190`：按**无向连通分量**分簇，簇内按拓扑深度分列、列内纵向堆叠（:55-109），簇按输入顺序裹进视口比例的矩形。画布侧 `tidy-flow.ts:96-148`：参与的是**顶层**节点与顶层白板对象，`parentId` 的组员跟着 Frame 走；链接取 `document.edges` + `whiteboard.references`。
- 为什么会「打散」：
  1. Mermaid 导入生成的子图框 / 节点 / 连线 / 标签全是 `parentId: null` 的顶层对象（`whiteboard/mermaid/to-items.ts:177-187`），白板 `line` 对象之间**没有链接**（引用只连白板对象 ↔ 节点），所以每个框、每段文字、每条线都是独立的「分量」，各自被当成一个盒子平铺成一长排。导入链接 / 图片 / 文件同理（`dnd/external-content.ts` 直接 `addItems`）。
  2. 主从边（`role: "supervises"`）与对等边在 `tidy` 里一视同仁（`tidy-flow.ts:83` 只取 `source/target`），所以主 Agent 不一定在左、从不一定在右；分量内列内顺序是输入顺序，不是原来的纵向顺序。
  3. 没有「只整理选中」：`canvas.tidy` 一律全画布（`FlowWorkspace.tsx:313-321`）。
  4. 没有动画：`moveNodes` / `moveItems` 瞬移，只有 `fitView` 有 200ms。撤销已是一条（`beginCoalesce("canvas.tidy")`）。
- 「插入 Memory」：仓库里没有这个入口（`grep -ri memory apps/web/src/i18n` 只有内存相关文案）；按用户描述它是「一批一起进来的对象」，与导入链接、导入 Mermaid 同一类，本节用「导入批次」统一处理，不依赖具体入口名。

### 6.2 数据表示：复用 `group` 节点，不加迁移

- 画布已有 `type: "group"` 节点（`packages/shared/src/domain/primitives.ts:3`、`store/defaults.ts:74-75`）与节点 / 白板对象的 `parentId`（`domain/nodes.ts:38`、`whiteboard/model.ts:78`），组员坐标相对组框，整理与拖动天然跟随（`tidy-flow.ts:17-20`）。**导入批次就是一个 `group` 节点**，不新增字段，不改 `whiteboard_json v2`，无迁移。
- 组节点 `data.kind: "group"` 已存在；加可选 `data.origin?: "import" | "team" | "manual"`（共享层 `groupNodeDataSchema` 可选字段，旧数据缺省 `manual`；未知字段按现有「保留原文」规矩，不算形状变化、不进契约）。整理时 `origin` 不影响算法，只给「解组」菜单项文案用。
- 边界：组不能进组（store 现有规则）；批次里已经带 Frame 的（`team` 的 worktree Frame，`collab/control/worktree.ts:217-259`）不再套一层。

### 6.3 生成批次的入口（都走 `canvas-store` 动作，一次操作一条历史）

| 入口                                                              | 现状                                    | 改成                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 导入 Mermaid（`whiteboard/mermaid/import.ts:41-53` `placeGraph`） | `addItems` 顶层对象                     | `≥2` 个对象时先 `addNode("group", { position, size: 包围盒 + 24px 内边距, title: 图的第一行标题或「Mermaid」, data.origin: "import" })`，对象 `parentId` 指向它、坐标转相对；`addNode + addItems` 用 `beginCoalesce("canvas.import")` 并成一条历史 |
| 拖入 / 选择多个文件、图片、链接（`dnd/external-content.ts`）      | `layoutImages` 顶层平铺                 | 同上：一次落 ≥2 个对象时套一个组（标题「导入」），单个不套                                                                                                                                                                                         |
| 输出到画板（`acp/export-to-board.ts`）                            | 单对象 + 来源连线                       | 不变（单个对象）                                                                                                                                                                                                                                   |
| Agent `canvas team`（core）                                       | 带 `worktree=` 的成员进 Frame，其余散落 | core 不改（本包不碰 core）；画布侧整理按主从树处理（§6.4）即可把它们排整齐                                                                                                                                                                         |
| 遗留的散落导入（已有画布）                                        | —                                       | 整理时把**白板孤岛**当刚体：顶层白板对象按「包围盒相交或间距 ≤ 24px」做并查集，同一岛内相对位置不动（§6.4 第 1 步）。不自动补组节点（不改用户数据）；右键多选 → 「成组」菜单项（已有 `setParent`，`store/canvas/nodes.ts:168`）给用户手动补        |

### 6.4 整理算法（纯函数，`canvas/tidy.ts` 重写内核，接口 `tidy(boxes, links, options)` 保留）

输入多两样：`boxes[i].kind: "agent" | "node" | "wb"`，`links[i].role?: "supervises"`，`options.order: "spatial"`（固定）、`options.grid = 8`。

1. **刚体化**：顶层组节点（含组员）、顶层节点、白板孤岛（并查集，阈值 24px）各成一个「单元」；单元的盒子是包围盒。单元内部坐标永不改变。
2. **阅读顺序**：单元按原位置排序：先按 `y` 以 `ROW_GAP`（48）量化成行，行内按 `x`。这是所有后续排列的稳定顺序（代替现在的「输入顺序」），同一画布整理两次结果相同（幂等：第二次整理位移为 0，单测守）。
3. **Agent 簇**：只取 `role: "supervises"` 的边建森林（一个节点最多一个主，`canvas/supervision.ts` 的规则）。每棵树：根在第 0 列；子按阅读顺序纵向堆叠在第 1 列，**顶对齐根的顶边**，相邻间距 `ROW_GAP`；孙在第 2 列，按父的顺序分段堆叠（父 j 的子块起点 = max(父 j 的顶边, 上一段的底边 + ROW_GAP)）；列间距 `COLUMN_GAP`（60）。对等边连着的非 Agent 单元（浏览器、终端、便签、编辑器）挂到它连的那个 Agent 的**同列下方**（作为该 Agent 的「附件」，顺序按阅读顺序）；连着多个 Agent 的挂最近的那个（阅读顺序先者）。这样每条主从边都是「左 → 右、从上到下单调」，父子边不交叉；对等边只在同列内垂直走。
4. **其余分量**：没有主从边的连通分量沿用拓扑分列（现有 `layoutCluster`），但列内顺序改为阅读顺序，且用**重心法**（一遍 barycenter）按上一列邻居的平均 y 排序，减少对等边交叉。
5. **裹行**：簇按阅读顺序裹进 `sqrt(总面积 × 视口比) × 1.15`（现状）；簇间距 `COLUMN_GAP`，行间 `ROW_GAP`。
6. **对齐网格**：所有单元左上角 `round(x / 8) * 8`。
7. **原点**：保持内容包围盒左上角不动（现状）。

复杂度 O(n log n + e)，千级节点无压力（`tools/probes/canvas-stress.mjs` 有现成压力画布）。

### 6.5 范围、动画、撤销

- **只整理选中**：`selectedNodeIds`（`store/canvas/types.ts:120`）与白板选区里的顶层单元 ≥ 2 个时，`canvas.tidy` 只整理这些单元，原点取选区包围盒左上角，其余不动；否则整理全画布。Dock 的「整理」钮与快捷键共用这一条判断；按钮 `title` 不变（「整理画布」），不加下拉——少一个决策点。
- **动画**：整理开始前给 flow 根 `data-tidying="true"`，`canvas.css` 加 `[data-tidying="true"] .react-flow__node, [data-tidying="true"] [data-slot="whiteboard-item"] { transition: transform var(--dur-page) var(--ease-out) }`（220ms，只动 transform），结束后在 `transitionend` / 260ms 兜底移除属性；`prefers-reduced-motion` 下不加属性直接跳；随后 `fitView({ padding: 0.08, maxZoom: 1, duration: 200 })`（现状）。只整理选中时不 `fitView`。
- **撤销**：现状一条历史（`beginCoalesce("canvas.tidy")`）不变；只整理选中同样一条。
- **锁定视图**：现状不动。

### 6.6 文案键

`canvas.tidy`（已有）；`canvas.tidySelection`「整理选中」（Dock `title` 在有选区时切换成它，键盘命令名不变）；`canvas.group.import`「导入」；`canvas.group.mermaid`「Mermaid」（品牌名，i18n-exempt）；`canvas.group.ungroup`「解组」（若右键菜单尚无）。

### 6.7 测试

- `tidy.test.ts`：(a) 一主三从 → 从在右列、顶对齐、等距、x 相同；(b) 两棵树各自成簇；(c) 附件（浏览器）落在所连 Agent 同列下方；(d) 白板孤岛整体平移、内部相对位置不变；(e) 幂等：整理两次位移为 0；(f) 阅读顺序：原来上面的仍在上面；(g) 网格：全部坐标是 8 的倍数；(h) 无主从边的分量沿用拓扑分列。
- `tidy-flow.test.ts`：组节点 + 组员只动组节点；只整理选中时未选中的坐标不变；一次整理一条历史（`undo` 一次全回）。
- `mermaid/import.test.ts`、`dnd/external-content.test.ts`：≥2 个对象时产生一个 `group` 节点且对象 `parentId` 指向它、`origin: "import"`；单个不套组。
- 探针：新建 `tools/probes/canvas-tidy.mjs`（仿 `canvas-stress.mjs`）：装一个固定画布（1 主 3 从 + 浏览器 + 一张 Mermaid 导入 + 散落白板），截「整理前 / 整理后」两张，断言整理后：主从边数与之前相同、没有节点重叠（包围盒相交 = 0）、导入组内相对位置不变；`design-showcase.mjs --only=canvas` 增加「整理后」固定状态。

---

## 7. 多端加入后其他端「全部刷新」（包 E）

> 根因来自 `_shared/join-refresh-investigation.md`（2026-10-07，已在隔离数据目录复现）。本节只写修复设计、文件边界与测试。

### 7.1 根因（已复现 / 已证实）

| 序  | 根因                                                                                                                                                                                                                                                                                                                                                                                  | 位置                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **主因**：终端尺寸是会话级共享的。新页面 attach 后 `onHello` 无条件发一次 resize；core 把会话的**全部** tmux 客户端 pty 改成新来者的尺寸，`window-size latest` + `aggressive-resize on` 让窗口跟着变，所有端的终端整屏重绘（去掉了 smcup/rmcup，每次重绘往 scrollback 追加一屏）。手机焦点页列数约 40，桌面端被压成手机尺寸且**不会自己纠正**（`use-refit` 只在本地容器变化时才发）。 | `apps/web/src/terminal/surface/use-transport.ts:104-107`；`core/terminal/socket.ts:372-377`；`core/terminal/manager.ts:835-866, 949-961`；`core/terminal/tmux/backend.ts:231-238, 396-407`；`core/terminal/tmux/config.ts:44-45, 64-66`；`apps/web/src/terminal/surface/use-refit.ts:37-44`；direct 后端同理 `core/terminal/direct.ts:334-345` |
| 2   | **次因**：`announce()` 触发过频 → `App.tsx` 无键全量 `invalidateQueries()`。CSRF 每次刷新都轮换（约每 13 分钟一次全量重取）；同浏览器新标签页换票后，旧页若刚 `forgetCsrf` 又 `adoptCsrf`，`had === false` 分支也 announce。侧栏、会话、Git、用量一起抖一下。与「别的设备加入」无直接关系，但时机相近。                                                                               | `apps/web/src/app/App.tsx:89-91`；`apps/web/src/api/identity.ts:210-238, 375-411, 802-827`                                                                                                                                                                                                                                                     |
| 3   | **条件触发**（非实时板 / 旧 core）：租约模式下持有者空闲 3 分钟且有人在看，新来者一次 `active` 心跳就拿走租约，旧页 `lost` → `clearLocalEdits` → 重取文档并变只读。默认实时板不触发。                                                                                                                                                                                                 | `core/canvas/presence.ts:458-465`；`apps/web/src/store/canvas/presence.ts:195-221`；`apps/web/src/app/use-board-sync.ts:159-170, 419-423`                                                                                                                                                                                                      |
| 4   | 低概率：Eco 休眠的终端被新端唤醒，旧页 `awake()` → `terminal.reset()` 重连重绘。                                                                                                                                                                                                                                                                                                      | `apps/web/src/terminal/surface/use-hibernation.ts:83-101`；`use-transport.ts:58`                                                                                                                                                                                                                                                               |

已排除（见调查文件）：实时协同回灌、React Flow / SourceProvider 整树重挂、控制面事件全量失效、`location.reload`、service worker、中继 GOAWAY、配对抬 epoch。

### 7.2 目标行为

另一端（手机 / 浏览器 / 第二桌面）attach 同一块画布的终端时，已打开的各端：终端不重绘、不改列行数、scrollback 不追加重复提示符；壳与画布不重挂、查询不全量重取、WS 不断线、相机 / 选区 / 输入不丢。手机端自己得到适合 390px 的尺寸，但**不影响**桌面端。

### 7.3 修复设计

**E-1 终端尺寸按观看者独立（主因）**

- 词汇：终端的多端观看沿用租约词汇——**驾驶者**（持 `terminal.lease` 的人类端，`drive/lease.ts`）与**观看者**；不用「主 / 从」。「主 · N 从」是连线 `role: "supervises"` 的 Agent 主从徽标（`canvas/supervision.ts`），与终端谁在看无关，本包不碰它，也不借它的字。
- 模型：`record.cols/rows` 从「会话尺寸」改成「**窗口尺寸**」；每个 attachment 自己记 `cols/rows`。
- 窗口尺寸取谁的（core，`core/terminal/manager.ts`，纯函数 `windowSizeOf(attachments, lease)`）：
  1. 有人类驾驶者（持租约且仍连着）→ 驾驶者的尺寸。从手机输入就是有意把终端改成手机宽，桌面端此时看到的是裁切视图（见「观看者如何显示」）；
  2. 没有驾驶者 → **面积最大**的那个 attachment 的尺寸（等价于 tmux 的 `largest`）。于是手机只看不输入时永远不影响桌面；手机释放租约（焦点页关闭、空闲释放）后窗口**自动回到**桌面尺寸——这一条修掉「被压成手机尺寸并保持下去」；
  3. 尺寸相同的几端之间不切换（避免抖动）；窗口尺寸只在结果变化时写一次。
- tmux 后端（`tmux/backend.ts::resize`）：只改发出 resize 的那个 attachment 自己的 tmux 客户端 pty；`window-size` 从 `latest` 改为 `manual`，窗口尺寸由 core 在 `windowSizeOf` 结果变化时显式 `resize-window -x -y` 设置一次（`aggressive-resize` 保留无害）。
- 观看者如何显示：每端的 xterm 仍按**本地容器**排版、attach 自己的 tmux 客户端（尺寸 = 本地）。客户端比窗口小 → tmux 裁切（左上对齐）；比窗口大 → 右、下留空。页面不加横向滚动、不加说明文字；手机焦点页的按键条与只读态照旧。想要「按我的尺寸」就去驾驶（聚焦输入即拿租约，现有行为），放手后尺寸自动还给最大端。
- direct / session-host 后端（单 pty）：只有主观看者的 resize 落到 pty；其余 attachment 的 resize 只记在自己的 attachment 上（页面侧 xterm 仍按本地容器排版，内容由服务端按主观看者宽度换行——这是单 pty 的固有限制，如实接受）。
- `manager.attach`：不再用新来者的尺寸覆盖会话尺寸（`:859-860`）；只有它成为主观看者时才设置。
- `manager.resize` / `socket.ts`：resize 帧带 `attachmentId`（socket 层本来知道是哪条连接，不需要页面传）；WS 帧不在契约里（§38.2），无 §N 变化。
- 页面 `use-transport.ts:104-107`：hello 已带 `cols/rows`，attach 后那次 resize 只在本地尺寸与 hello 不同时才发。
- 页面 `use-refit.ts`：不变（只在本地容器变化时发）。
- 多端同尺寸时行为与现在相同；单端时行为完全不变。

**E-2 身份层 `announce` 收窄（次因）**

- `api/identity.ts`：`announce(kind)`，`kind: "appeared" | "gone" | "switched" | "rotated"`。`rememberCsrf` 的 CSRF 轮换、`remember()` 的 Bearer 续期 → `rotated`；`adoptCsrf` 的 `had === false` 只在**之前确实没有会话**（不是 `forgetCsrf` 刚清空）时才算 `appeared`——`forgetCsrf` 另记一位 `forgotten`，`adoptCsrf` 看到它就按 `rotated` 处理。
- `App.tsx:89-91`：只在 `appeared / switched` 时失效，且用 `predicate` 只失效**此前以 401 / 403 失败**的查询（`query.state.status === "error"` 且错误是 `IdentityRequestError` 401/403）；`gone` 走现有登出路径；`rotated` 不失效。
- `onIdentitySessionChange` 的其它订阅者（`grep onIdentitySessionChange`）逐个确认是否只关心 `appeared / gone`。

**E-3 租约模式只降级不重载**（条件触发，顺手修）

- `apps/web/src/store/canvas/presence.ts:195-221` 判定 `lost` 时：只切只读，不 `clearLocalEdits`、不重取文档；本地未提交的编辑保留在撤销栈并标「待同步」（现有 `saveState: "dirty"`）。
- `use-board-sync.ts:419-423`：`markPresenceActivity` 只在真正的编辑动作（`commit`）上触发，pointerdown 不算；这样空闲持有者的租约不会被「摸一下」抢走。

**E-4 休眠唤醒不重置**（低优先级，可延后）

- `use-hibernation.ts:83-101`：收到 `running` 且本地仍是休眠占位时，直接 attach 不 `terminal.reset()`。

### 7.4 文件边界

| 侧   | 文件                                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core | `apps/desktop/src/core/terminal/manager.ts`+test、`core/terminal/socket.ts`+test、`core/terminal/tmux/backend.ts`+test、`core/terminal/tmux/config.ts`+test、`core/terminal/direct.ts`+test、`core/terminal/session-host/*`（单 pty 仲裁）、`core/drive/lease.ts`（只读取，不改）；不碰 `core/identity/*`、不碰契约 |
| web  | `apps/web/src/terminal/surface/use-transport.ts`+test、`use-hibernation.ts`+test、`apps/web/src/api/identity.ts`+test、`apps/web/src/app/App.tsx`+test、`apps/web/src/store/canvas/presence.ts`+test、`apps/web/src/app/use-board-sync.ts`+test                                                                     |
| 探针 | `tools/probes/join-no-refresh.mjs`（新，基于 `_shared/join-refresh-probe/probe.mjs` 收进仓库）、`tools/probes/README.md`                                                                                                                                                                                            |

不与 A–D 任何文件重叠。无契约、无迁移、无 §50。

### 7.5 测试

- core 单测：两个 attachment，B resize 后 A 的 pty 尺寸不变（tmux 与 direct 各一条）；主观看者断开后顺延；持租约者 resize 才改窗口；`attach` 不覆盖会话尺寸。
- web 单测：`use-transport`——hello 尺寸与本地相同时不发 resize；`identity.test.ts`——`rememberCsrf` 轮换、`remember()` 续期只发 `rotated`；`forgetCsrf` 后 `adoptCsrf` 不发 `appeared`；`App.test.tsx`——`rotated` 不调用 `invalidateQueries`，`appeared` 只失效 401/403 失败过的查询；`presence.test.ts`——`lost` 不清编辑、只置只读。
- 探针 `join-no-refresh.mjs`（桌面 1440×900 + 手机 390×844 两端，隔离数据目录）：第二端打开同一块板并 attach 后，断言第一端 (a) `window.__mark` 与 `data-mount-id` 不变（无 reload、无重挂）；(b) 两个终端的 WS 无 close / 重连；(c) attach 后 3s 内第一端终端 **output 帧为 0**（现在是 7 帧）且 `tmux list-clients` 里第一端客户端尺寸不变；(d) 第一端 xterm 最后一行与 attach 前相同（没有重复提示符）；(e) React Query `fetchCount` 只在 `resources/subscription`、`usage` 周期键上增加；(f) 画布 `viewport` 不变。再在第二端发 `resize 40x12`，断言 (c) 仍成立。

---

## 8. core / 契约改动汇总

| 节  | 协议 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 包  |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| §47 | 1.22 | `agents.installAdapter` 入参加 `target?: "adapter" \| "cli"`（缺省 `adapter`）、`rollback?: boolean`；白名单两张（`ACP_ADAPTER_PACKAGES` + `AGENT_CLI_PACKAGES`，后者补 `omp: "@oh-my-pi/pi-coding-agent"`、`pi: "@mariozechner/pi-coding-agent"`、`claude: "@anthropic-ai/claude-code"`、`codex: "@openai/codex"`）；任务键 `${agentId}:${target}`；出参多 `target`、`previousVersion?`；新错误码 `adapter_install_busy`（409）、`adapter_rollback_unavailable`（409）；`agents.adapterInstall` 入参加 `target?`。§39.7 原文不改，§47 写「自 1.22 起扩展」 | A   |
| §48 | 1.22 | `agents.integration` 出参加 `canvasAgents`（§2.2）；`AcpAdapter.canvasTools`；`pi` 的 `injection.mcp` 改 `false`                                                                                                                                                                                                                                                                                                                                                                                                                                            | A   |
| §49 | 1.23 | 镜像块 `image` / `resource_link`；`acp.log` 出参加 `snapshot`（§5.5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | C   |
| §50 | —    | 不需要：包 E 只改终端 WS 帧（§38.2 不在契约里）与页面身份层                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | E   |

`PROTOCOL_MINOR` 由**最后合入**的包改成当时的值；每个包的测试用 `since` 断言各自的 procedure，不断言全局 minor（避免并行冲突）。`docs/contracts/core-json-api.md` 末尾追加节：合入顺序 A → C，后者 rebase。数据库无迁移。

---

## 9. 实现包

| 包  | worktree                              | 范围                                                | 文件边界（只许动这些；`+test` 表示配套测试）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 验证                                                                                                                                                          |
| --- | ------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `armadra-wt/integrations-acp-install` | §1 集成页、§1.3 安装、§2 画布建 Agent、契约 §47 §48 | `packages/shared/src/api/acp.ts`（**只改 :36-75 的两张表与 install schema**）、`packages/shared/src/contract/agents.ts`、`apps/desktop/src/core/agent/adapter-install.ts`+test、`core/acp/adapters.ts`+test（`canvasTools`、pi `mcp:false`）、`core/hook/install/integration.ts`+test（`canvasAgents`）、`core/agent/routes.ts`（若 procedure 登记在此）、`docs/contracts/core-json-api.md`（追加 §47 §48）、`apps/web/src/panels/settings/pages/IntegrationPage.tsx`+test、`pages/integration/*`、`apps/web/src/acp/adapter-install.tsx`+test、`apps/web/src/acp/NewAgentWizard.tsx`（只改安装钮与 `supervisorNodeId`）、`apps/web/src/acp/wizard-open.ts`、`apps/web/src/nodes/terminal-menu.ts`+test、`apps/web/src/i18n/integration.ts`、`apps/web/src/i18n/nodes.ts`（一个键）、`apps/web/src/showcase/fixtures/integration.ts`、`showcase/sections/integration.tsx`、`tools/release/compatibility.json`（若包名表与测试对齐要求） | `pnpm libs:build`、`pnpm --filter @armadra/desktop test`、`pnpm --filter @armadra/web test typecheck`、`pnpm check`、`design-showcase.mjs --only=integration` |
| B   | `armadra-wt/settings-node-chrome`     | §3 设置弹窗、§4 节点头                              | `apps/web/src/panels/SettingsDialog.tsx`+test、`apps/web/src/styles/tokens.css`、`styles/tokens.test.ts`、`styles/nodes.css`、`apps/web/src/nodes/NodeShell.tsx`+test、`nodes/HeaderChips.tsx`+test、`nodes/SupervisionBadge.tsx`、`nodes/NodeNameBadge.tsx`、`nodes/*Badge.tsx`（只改 class）、`apps/web/src/panels/resources/MemoryBadge.tsx`（只改触发器 class）、`nodes/header-chip.ts`（新，常量）、`docs/design/design-system.md`（§2.7、§4 节点行）、`showcase/sections/canvas.tsx`、`showcase/sections/components.tsx`                                                                                                                                                                                                                                                                                                                                                                                                          | `pnpm --filter @armadra/web test typecheck`、`design-showcase.mjs --only=canvas,components --width=390,1024,1280,1920`                                        |
| C   | `armadra-wt/acp-session-style`        | §5 会话视图、契约 §49                               | `apps/web/src/acp/*`（**除** `adapter-install.tsx`、`NewAgentWizard.tsx`、`wizard-open.ts`）、`apps/web/src/i18n/acp.ts`（独占）、`apps/web/src/styles/canvas.css`（只加 `select-text` 相关一条，若需要）、`packages/shared/src/api/acp.ts`（**只改 :120-230 与 :397-410 的载荷 schema**）、`apps/desktop/src/core/acp/session.ts`+test、`core/acp/routes.ts`+test、`docs/contracts/core-json-api.md`（追加 §49）、`showcase/fixtures/acp.ts`、`showcase/sections/acp.tsx`、`tools/probes/acp-e2e.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                  | `pnpm libs:build`、desktop test、web test/typecheck、`acp-e2e.mjs`、`design-showcase.mjs --only=acp`                                                          |
| D   | `armadra-wt/canvas-tidy-layout`       | §6 整理与导入分组                                   | `apps/web/src/canvas/tidy.ts`+test、`canvas/tidy-flow.ts`+test、`canvas/FlowWorkspace.tsx`（只改 `canvas.tidy` 命令与 `data-tidying`）、`store/canvas/view.ts`（`arrangeNodes` 入参）、`store/canvas/types.ts`（入参类型）、`shell/Dock.tsx`（`title` 切换）、`canvas/whiteboard/mermaid/import.ts`+test、`canvas/dnd/external-content.ts`+test、`canvas/menus/context-menu*`（成组 / 解组项，若已有则只加文案）、`packages/shared/src/domain/node-data.ts`（`group` 的可选 `origin`）、`styles/canvas.css`（过渡一条）、`apps/web/src/i18n/canvas.ts`、`tools/probes/canvas-tidy.mjs`（新）、`tools/probes/README.md`、`showcase/sections/canvas.tsx`（「整理后」状态，与 B 冲突时 D 后合）                                                                                                                                                                                                                                            | web test/typecheck、`canvas-tidy.mjs`、`canvas-stress.mjs` 跑通                                                                                               |
| E   | `armadra-wt/join-refresh`（待建）     | §7 终端多端尺寸、身份通知收窄、租约只读             | core：`apps/desktop/src/core/terminal/manager.ts`+test、`core/terminal/socket.ts`+test、`core/terminal/tmux/backend.ts`+test、`core/terminal/tmux/config.ts`+test、`core/terminal/direct.ts`+test、`core/terminal/session-host/*`；web：`apps/web/src/terminal/surface/use-transport.ts`+test、`use-hibernation.ts`+test、`apps/web/src/api/identity.ts`+test、`apps/web/src/app/App.tsx`+test、`apps/web/src/store/canvas/presence.ts`+test、`apps/web/src/app/use-board-sync.ts`+test；`tools/probes/join-no-refresh.mjs`（新）、`tools/probes/README.md`。不碰 `nodes/*`、`acp/*`、契约                                                                                                                                                                                                                                                                                                                                              | `pnpm --filter @armadra/desktop test`、web test/typecheck、`join-no-refresh.mjs`、`realtime-e2e.mjs` 回归                                                     |

交叉点与处理：

- `packages/shared/src/api/acp.ts`：A 与 C 各改不同区段，合并时无冲突；谁后合谁 rebase 看一眼。
- `docs/contracts/core-json-api.md` 末尾：A（§47 §48）先合，C（§49）rebase 后追加。
- `showcase/sections/canvas.tsx`：B 与 D 都加固定状态，D 后合。
- `apps/web/src/acp/NewAgentWizard.tsx`：只有 A 动；C 不碰向导。
- `i18n`：A 用 `integration.ts` + `nodes.ts` 一个键；C 独占 `acp.ts`；D 用 `canvas.ts`；B 不加文案。
- 仓库规则：新增探针登记 `tools/probes/README.md`；本文若要进仓库，登记到 `docs/README.md` 的 `design/`（建议由 A 顺手放 `docs/design/ui-acp-refresh.md`）。
- 合入顺序建议：B（最小、无契约）→ E（无契约、文件不交叉）→ A → C → D。
