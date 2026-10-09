# 画布内注入：Hook、技能与画布说明只在从画布启动时生效

> 状态：**已实施（2026-09-26）**，2026-10-02 按[画布启动器](./canvas-launcher.md)回改：注入改由数据目录里的 `run/<cli>` 启动器追加，启动行不再带注入；Codex 的 Hook 信任改用会话级旗标，不再写 `~/.codex/config.toml`。取代 [Agent 接入统一管理](./agent-integration.md) 里「装进各 CLI 全局配置」的那一半；Hook 事件契约、技能正文的归属、旧残留修复保持不变。

## 1. 目标

用户拍板的两条：

1. Armadra 注入到各 CLI 的 Hook、技能与画布说明，**只在从画布启动时生效**；用户在画布外自己启动 CLI，零影响。
2. 升级后自动清掉现有的全局安装，清之前先备份。

此前只有 Claude 的 Hook 是逐次注入（`--settings`）：Codex 写 `~/.codex/hooks.json`，Copilot 写 `~/.copilot/hooks/armadra.json`，OpenCode / Pi / OMP 往各自扫描的目录里放状态模块，六个 CLI 的 `SKILL.md` 全在全局 skills 目录。画布外启动的 CLI 同样读到技能、同样触发 Hook。

## 2. 一个出口

注入产物固定生成在应用数据目录 `integration/<cli>/`，由同目录下每个 CLI 一个的启动器 `run/<cli>`（Windows `run\<cli>.exe` + `.launch`）在 CLI 启动时交给它；启动器只在环境里有 `ARMADRA_NODE_ID` 时注入，没有时原样 exec 程序（[画布启动器](./canvas-launcher.md) §2、§4、§5）：

- `core/hook/install/inject.ts`：`canvasInjection({ dataDir, agentId, nodeId, resume })` 答 `{ args, env }`——启动器追加的字面 argv 与只给 CLI 进程设的环境；`prepareInjection` 把产物、`run/`、`shims/` 与 `launcher.json` 写成当前修订（字节不变就不写）；`removeInjection` 全部收回。
- `core/agent/canvas-launch.ts`：core 里唯一拼启动行的地方（`canvasLaunch` / `canvasLaunchLine`），行是 `<launcher> <程序> [前置词] <旗标>`，权限模式与模型的旗标来自 `planLaunch`，行上没有注入；`canvasEnvironment` 给节点终端的环境半边（`ARMADRA_SHIMS` 与以 `shims/` 开头的 `PATH`），也是「就要起这个 CLI 了」时确保产物最新的时刻。
- 页面自己拼的启动行（新节点、`open-agent` / `team` 建的节点、从历史对话恢复）全部经 `apps/web/src/agent/launch.ts`：`GET /api/agents` 那一行有 `launcher` 时程序换成启动器，原来的程序与前置词作它的参数；对没有 `launcher` 的旧 core 退回把 `launchWords` / `launchArgs` 写在行上（保留一个版本）。

启动行是敲进节点终端的，按那个 shell 的方言引用：`packages/shared/src/shell.ts`（core 里逐字节同一份 `core/terminal/shell.ts`，用例比对两份）分 `posix`（sh/bash/zsh/dash）、`fish`、`cmd`、`powershell`（`pwsh` 7）、`windows-powershell`（`powershell.exe` 5.1）五种，管参数引用与环境变量引用（`"${VAR}"` / `"$VAR"` / `"%VAR%"` / `"${env:VAR}"`）。注入的词写在启动器文件里，不经 shell，所以行上只剩程序路径与 CLI 自己的旗标要引用；5.1 的 `--%` 与环境变量引用只留给对旧 core 的退路。Windows 上 npm / pnpm 装的 CLI 是 `.cmd` 包装，批处理会让 `cmd.exe` 把参数再读一遍，所以启动行绕过包装：`core/agent/windows-shim.ts` 读出背后的 `node <脚本>` 或原生程序，`GET /api/agents` 以 `launchTarget` 答给页面，作启动器的程序与前置词；读不出来的包装由启动器经 `cmd.exe` 起，注入只在词都批处理安全时带（[画布启动器](./canvas-launcher.md) §5.2 第 7 条）。方言取节点终端实际跑的 shell：会话记录里的 `shell`，没有会话时是节点指定的，再没有是 core 的缺省 shell（Windows 上是 `COMSPEC`，页面从 `/api/health` 的 `defaultShell` 得知）；SSH 节点一律 POSIX。

启动路径与各自的出口：

| 路径                            | 谁拼启动行                                                                      | 环境变量                                      |
| ------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| 页面启动、`open-agent` / `team` | `web/agent/launch.ts::buildAgentLaunch`（`launcher`）                           | `POST /api/terminals` → `ownedEnvironment`    |
| 从历史对话恢复                  | `web/agent/launch.ts::buildResumeLaunch`                                        | 同上                                          |
| 依赖编排                        | `dependencies/launch.ts::launchLine` → `canvasLaunchLine`                       | `spawnForNode` → `ownedEnvironment`           |
| 节能唤醒                        | `terminal/hibernator.ts::resumeLine` → `canvasLaunchLine`（带 resume）          | `Hibernator.environment` → `ownedEnvironment` |
| 计划任务冷启动                  | `schedule/cold-start.ts::launchLine` → `canvasLaunchLine`（冻结 argv + 启动器） | 冷启动器 → `ownedEnvironment`                 |

SSH 节点的启动行不带启动器，也不带本机解析到的程序路径：那些路径都在控制端，注入由执行主机上的垫片交给远端启动器，见[远端画布注入](./remote-canvas-injection.md)。

冻结的计划只存 agent id 与 argv，启动器路径在执行时由 core 现取，不进计划。用户在节点里退出 CLI 后手敲 `claude`，命中节点终端 `PATH` 最前面的同名垫片 `shims/<cli>`，它摘掉自己的目录后委托给启动器（尽力而为：rc 整条重设 `PATH` 时不注入）。

`core/agent/canvas-launch.test.ts` 的结构性用例守住出口：core 里调用 `planLaunch(` 与 `launcherFor(` 的只有 `canvas-launch.ts`，调用 `canvasInjection(` 的只有集成状态；`launchCommand(` 只剩 `open-agent` 回报里显示用；页面里调用 `assembleLaunchCommand(` / `assembleLaunchArgv(` 的只有 `web/agent/launch.ts`，且它读 `?.launcher`。新加一条启动路径而绕过出口，这些用例会先红。

## 3. 实测矩阵

2026-09-26，本机真 CLI，全局配置前后哈希一致。「恢复」一列：恢复会话时是否要把同样的参数再传一遍。

| CLI                                                                                                                     | Hook                                                                                                                                                                          | 技能                                                                                                       | 画布说明                                                                                                                                           | 恢复                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Claude Code 2.1.260                                                                                                     | `--settings <integration/claude/settings.json>`；与用户自己 `settings.json` 里的 Hook **叠加**而非替换                                                                        | `--plugin-dir <integration/claude/plugin>`，内含 `.claude-plugin/plugin.json` 与 `skills/armadra/SKILL.md` | `--append-system-prompt-file <integration/claude/instructions.md>`                                                                                 | 三样都要重传                                                                                |
| Codex 0.155.1 每个事件一个 `-c 'hooks.<Event>=[…armadra-hook codex…]'`，加一个 `-c hooks.state={…}` 信任记录；信任见 §4 | 没有逐次加载技能的办法：要点并进 developer instructions，并给出完整 `SKILL.md` 的绝对路径                                                                                     | `-c developer_instructions="…"`（追加一条 developer 消息；`model_instructions_file` 会替换基础提示，不用） | Hook 的 `-c` 要重传；developer instructions 首次写进会话记录，恢复时保留，重传不更新                                                               |
| OpenCode 1.18.28                                                                                                        | `OPENCODE_CONFIG_DIR=<integration/opencode/config>`，模块在其 `plugins/`                                                                                                      | 同目录 `skills/armadra/SKILL.md`                                                                           | `OPENCODE_CONFIG_CONTENT='{"instructions":["<instructions.md>"]}'`                                                                                 | 环境变量每次启动都带。OpenCode 会往这个目录装 `package.json` / `node_modules`，所以目录固定 |
| Pi 0.84.4                                                                                                               | `--extension <armadra-status.ts>`                                                                                                                                             | `--skill <skills/armadra>`                                                                                 | `--append-system-prompt <instructions.md>`                                                                                                         | 要重传                                                                                      |
| Oh My Pi 18.1.8                                                                                                         | `--extension=<armadra-status.ts>`                                                                                                                                             | `--config=<overlay.yml>`，内容 `skills.customDirectories: [<skills>]`（`--plugin-dir` 不行）               | `--append-system-prompt=<instructions.md>`                                                                                                         | 要重传                                                                                      |
| Copilot 1.0.8x                                                                                                          | `--plugin-dir <integration/copilot/plugin>`，`plugin.json` 写 `"hooks": "hooks.json"`，`hooks.json` 为 `{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":…}]}}` | 同一插件目录，`plugin.json` 写 `"skills": "skills/"`                                                       | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<integration/copilot/instructions>`，文件在 `.github/instructions/armadra.instructions.md`，头部 `applyTo: "**"` | 要重传                                                                                      |

**启动行长度**：注入的词写在启动器文件里，不经 PTY、不经 shell，整行一两百字节，与 CLI 和注入内容无关（此前 Codex 的几 KB 注入要经 `ARMADRA_CODEX_HOOK` / `ARMADRA_CODEX_INSTRUCTIONS` 环境变量展开，已删除；见[画布启动器](./canvas-launcher.md) §1 第 4 条）。启动器把注入接在调用者全部参数之后，所以行上有 prompt 时注入的旗标落在位置参数后面，Claude 与 Codex 都接受。

节点 id 不上启动行：`ARMADRA_NODE_ID` 等地址变量早已由 `agentEnvironment` 放进节点终端的环境，Hook 客户端与进程内模块都从那里读，启动器也以它为门。

**Codex 启动升级检查**：`Update now?` 提示会把第一条任务当成回答（回车 = 升级，端到端里真把全局 codex 升级过一次）。画布启动 Codex 时逐次加 `-c check_for_update_on_startup=false`。键名从 Codex 0.155.1 的配置结构里读出，并在临时 `CODEX_HOME` 里用一份指向更新版本的 `version.json` 实测：不加时 TUI 停在 `Update available! 0.155.1 -> 0.157.0`，加上后直接进入目录信任提示。

## 4. Codex 的 Hook 信任：会话层信任记录，零写入

Codex 只执行它信任的 Hook，而且**静默**：没有信任，Hook 就不跑。此前的做法是把会话级 Hook 的信任记录写进用户的 `~/.codex/config.toml`（整个集成唯一的全局写入）；2026-10-02 起改为启动器追加 `--dangerously-bypass-hook-trust`；2026-10-09 起再改为把这八个 Hook 的信任记录放进同一层 `-c`（`hooks.state`），并以 `-c features.daemon_auto_start=false` 声明内嵌模式——数据目录之外一个字节不写，TUI 启动时不再打警告，用户自己没审过的 Hook 也不再被放行。实测与版本门槛（`CODEX_SESSION_HOOK_TRUST_MIN` 0.134.0，更旧的版本画布内启动不带 Hook，集成页显示「注入受限」）见[画布启动器](./canvas-launcher.md) §7。旧版本写下的 `/<session-flags>/config.toml:*` 信任记录由迁移的第二步清掉（§5）。

## 5. 升级迁移与集成页

> 2026-10-08 更新：启动迁移不再改用户 HOME 下的任何文件，只清数据目录里旧安装器的标记（记录 `version: 3`）；下面「识别 / 备份 / 删除」的动作改由集成页「清理旧版」在用户点击后执行（`repair.ts`，只认带本产品签名的条目，见 [Agent 集成](./agent-integration.md) §4）。以下保留为当时的设计记录。

`core/hook/install/migrate.ts`，core 启动时（技能正文注册之后）跑一次：

- 识别旧的全局安装：Claude `settings.json` 里我们的 Hook 与旧状态行；Codex `hooks.json` 里的条目与它们在 `config.toml` 的信任记录；Copilot `hooks/armadra.json`；OpenCode / Pi / OMP 扫描目录里的 `armadra-status` 模块；六个 CLI 的 `skills/armadra`（只认带修订号尾注的那份）与更早的技能目录名。
- 先备份：用户也会编辑的文件复制成旁边的 `<文件>.armadra-backup-<时间戳>`（沿用修复按钮的约定），字节没变的备份随即删掉；只有我们写过的文件（模块、`SKILL.md`）备份进 `<数据目录>/integration/global-backup-<时间戳>/<cli>/`——放在原处会被 CLI 当成又一个扩展或技能扫到。
- 只删我们写的：Hook 条目按 `armadra-hook` 识别，模块与技能按内容识别，其余原样写回。
- 只一次：结果写进 `<数据目录>/integration/global-migration.json`，失败也记下来，不会每次启动都去改用户的文件。记录现为 `version: 2`：第二步把旧版本写进 `~/.codex/config.toml` 的 `/<session-flags>/config.toml:*` 信任记录清掉（有变化才在旁边留备份），已有 `version: 1` 的机器只补跑这一步（[画布启动器](./canvas-launcher.md) §10，契约 [§13.3](../contracts/core-json-api.md)）。

集成页每种 CLI 一行：「画布内注入」、Hook 与技能是否为当前修订、启动器少带了东西时的「注入受限」（Windows 没有 `armadra-launch.exe`、Codex 太旧；原因在悬停提示里）、迁移清掉过东西时的「已清理全局安装」（含 Codex 的会话信任记录，悬停看备份路径）、旧残留与修复。不再有「信任记录写在…」。原来的「安装 / 卸载」换成一个「重新生成」，平时不用点——每次从画布启动都会先确保产物最新。

测试套件起的 core 用的是开发者真实的 `HOME`，所以 `ARMADRA_NO_GLOBAL_WRITES=1`（vitest 的 setup 里设）让迁移不发生；用例要测它就显式传临时目录。

## 6. 画布说明

技能正文与画布说明在 `core/collab/skill.ts`（`SKILLS_REVISION` 16），三种形式开头是同一段「画布规则」；Codex 的 `developer_instructions` 首行是 `[Armadra canvas rules r16]` 并带「只在 `ARMADRA_NODE_ID` 已设置时生效」的条件句（[画布启动器](./canvas-launcher.md) §7.3）：

1. 这个终端是画布上的一个节点，协作只走 `armadra-hook canvas …`（含 `post` / `send`）。
2. 用户要求创建其他 Agent、分工或并行时，一律用 `canvas open-agent` / `canvas team` 在画布上建并连线；不用 CLI 自带的子代理或后台任务冒充。
3. 需要浏览器时用画布里的浏览器节点：`armadra-hook browser <动词>`；没有连着的就先 `canvas open-browser --url <网址>`（新增的画布动词，建好后自动从调用者连一条对等边并写两份链接文档）；不用 CLI 自带的浏览器、computer-use 或无头浏览器。

浏览器动词表由 `core/browser/args.ts` 的 `VERBS` 生成，不手抄；`skill.test.ts` 断言每个动词都在、示例里的动词都存在。技能正文开头「本终端跑在 Armadra 画布的一个节点里」在逐次注入之后才真正成立，保留。

## 7. 验证

- 单元：`inject.test.ts`（六个 CLI 的 argv / env 形状、恢复时同样带上、产物与启动器幂等、修订变化时重写、Codex 的旗标与版本门槛、`prepareInjection` 不碰 `config.toml`）；`launcher.test.ts`（真跑 `/bin/sh` 的启动器与垫片）；`migrate.test.ts`（备份、只删自己的、只一次、v1→v2）；`integration.test.ts`（状态、重新生成、启动准备）；`canvas-launch.test.ts`（各路径经启动器、冷启动带启动器、结构性出口）。
- 端到端：`tools/probes/agent-e2e.mjs` 的场景 5，按[画布启动器](./canvas-launcher.md) §13.3：真 Claude 与真 Codex 经启动器在画布内生效，同一行去掉 `ARMADRA_NODE_ID` 重跑与裸程序都不加载、不触发 Hook，新的临时 `CODEX_HOME` 里不生成 `config.toml`。Claude 只能用真实配置目录，而我们对 Claude 只经启动器注入，不写它的全局文件。
