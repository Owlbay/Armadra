# 画布启动器：注入由数据目录里的启动器完成，启动行不再带注入

> 状态：**已实施（2026-10-02）**，与设计的出入：集成页还没有「执行主机 X 的 Worker 旧」提示（§8.4）——控制端只在 `RemoteIntegration.outdatedWorkers()` 里记着，集成状态与 API 都没有给出这一项；`tools/probes/packaged-smoke.mjs` 仍断言信任记录写进临时 HOME，未随本方案改。实测见[状态文档](../status/typescript-core-status.md) §63。取代[画布内注入](./canvas-only-integration.md)的 §2 后半（方言引用里 Codex 的环境变量展开、`.cmd` 包装的词过滤）、§3 的「Codex 的启动行要短」、§4 全部（信任记录）与 §5 的迁移记录形状；取代[远端画布注入](./remote-canvas-injection.md) §2 第 3 条（垫片的生成方式）与 Codex 信任那一段。Hook 事件契约、技能正文、产物目录 `integration/<cli>/`、Worker 中继与一次性迁移的备份规则不变。实施完成后按 §16 回改那两份文档。

## 1. 目标与硬约束

用户拍板：

1. **不改用户的 CLI 配置与系统配置，数据目录之外一个字节不写**（远端主机上只写 Worker 的状态目录）。注入只发生在从画布启动的 Agent 上。
2. Codex 的 Hook 信任改用会话级旗标 `--dangerously-bypass-hook-trust`：零写入。代价接受：用户自己没审过的用户层 / 插件 Hook 在画布内的 Codex 会话里也会跑，TUI 每次启动打一行警告。
3. 旧全局安装的迁移仍然**自动**，并补一步：把当前版本写进 `~/.codex/config.toml` 的 `/<session-flags>/config.toml:*` 信任记录也清掉（已升级过的机器上 `global-migration.json` 已存在，第二步要能单独跑一次）。
4. Windows 在范围内：`cmd.exe`、pwsh 7、Windows PowerShell 5.1，CI 的 windows runner 真跑。

本轮要解决的六个问题（现状代码：`core/hook/install/inject.ts`、`agent/canvas-launch.ts`、`terminal/shell.ts`、`web/agent/launch.ts`）：

| #   | 问题                                                                                                                                         | 本方案                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | 注入的 argv（`--settings <绝对路径>`、Codex 的 `-c` 表）敲进用户的交互式 shell，进了 shell 历史；在画布外重跑那一行照样加载技能与说明        | 启动行只剩「启动器 + 程序 + CLI 自己的旗标」；启动器没有 `ARMADRA_NODE_ID` 时原样 exec 程序，不注入         |
| 2   | Codex 信任记录写进 `~/.codex/config.toml`（远端也写）——整个集成唯一的全局写入                                                                | `--dangerously-bypass-hook-trust`，删掉 `trustCodexSessionHooks` / `untrust…` 与 Worker 的信任写入          |
| 3   | 用户在节点里退出 CLI 后手敲 `claude`，没有注入                                                                                               | 节点终端 `PATH` 最前面放同名垫片，垫片委托给启动器（尽力而为）                                              |
| 4   | 为了把几 KB 的 Codex 行塞进 PTY（约 1 KB 截断），有 `ARMADRA_CODEX_HOOK` 环境展开、`codexTomlString` 的 `cmd.exe` 形、`--%` 等一整套引用逻辑 | 注入的词写在启动器文件里，不经 PTY、不经 shell；`LaunchWord` 的环境形、`codexWords`、`codexTomlString` 全删 |
| 5   | 只走环境变量的注入（`OPENCODE_CONFIG_DIR`、`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`、`ARMADRA_CODEX_*`）导出到整个节点 shell，泄到嵌套进程         | 这些变量由启动器只给 CLI 进程设；节点 shell 的环境里不再有它们                                              |
| 6   | Codex 的 `developer_instructions` 进会话记录：画布外 `codex resume` 仍声称「这是画布节点」，且没有修订标记                                   | 文本加条件句与修订标记；`SKILLS_REVISION` 升 16                                                             |

## 2. 方案总览

每个有注入的 CLI（`INJECTED_AGENTS` 六个）在 `<数据目录>/integration/` 下生成两种可执行文件：

- **启动器** `run/<cli>`：敲进节点 shell 的那一行调用它，程序路径与 CLI 自己的旗标作参数。它是注入发生的唯一位置。
- **垫片** `shims/<cli>`：与 CLI 同名，节点终端的 `PATH` 把 `shims/` 放在最前面。用户手敲 `claude` 时命中它；它把自己的目录从 `PATH` 摘掉，再委托给启动器。

启动器的规则（两个平台相同）：

1. 环境里没有 `ARMADRA_NODE_ID` → 只用调用者给的参数 exec 程序，不设任何变量。shell 历史里的那一行在画布外重跑，就是一次普通启动。
2. 有 → 给 CLI 进程（而不是 shell）设这个 CLI 的环境注入，在调用者的参数**之后**接上注入的 argv，exec 程序。注入的词是文件里的字面量，不经 shell 展开，没有长度问题，也没有引用问题。

### 2.1 机制表

| 平台 \ CLI                | Claude                                                                                               | Codex                                                                                                                                | OpenCode                                        | Pi / OMP                                                                                                           | Copilot                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 注入 argv（启动器追加）   | `--settings <settings.json>` `--plugin-dir <plugin>` `--append-system-prompt-file <instructions.md>` | `--dangerously-bypass-hook-trust` `-c check_for_update_on_startup=false` 八个 `-c hooks.<Event>=[…]` `-c developer_instructions="…"` | 无                                              | `--extension <module>` `--skill <dir>` `--append-system-prompt <file>`（OMP 为 `=` 形与 `--config=<overlay.yml>`） | `--plugin-dir <plugin>`            |
| 注入 env（只给 CLI 进程） | 无                                                                                                   | 无                                                                                                                                   | `OPENCODE_CONFIG_DIR` `OPENCODE_CONFIG_CONTENT` | 无                                                                                                                 | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` |
| macOS / Linux 启动器      | `run/<cli>`：POSIX `sh`，`exec`，不留中间进程（§4）                                                  | 同左                                                                                                                                 | 同左                                            | 同左                                                                                                               | 同左                               |
| Windows 启动器            | `run\<cli>.exe` + `<cli>.launch`：同一个 C# 控制台程序 `armadra-launch.exe` 的副本（§5）             | 同左                                                                                                                                 | 同左                                            | 同左                                                                                                               | 同左                               |
| SSH 节点                  | 启动行仍是裸的 `claude --model …`；远端 `shims/<cli>` → 远端 `run/<cli>`（§6.2）                     | 同左（Codex 的 `-c` 写在远端启动器里）                                                                                               | 同左                                            | 同左                                                                                                               | 同左                               |
| 恢复                      | 启动器每次都注入，恢复与新开相同                                                                     | `codex resume <id>` 在前、注入在后；`--dangerously-bypass-hook-trust` 在 `resume` 子命令后也认（§7.1）                               | 同 Claude                                       | 同 Claude                                                                                                          | 同 Claude                          |

### 2.2 启动行

| 路径                                        | 之前                                         | 之后                                                                                     |
| ------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 页面（新节点、`open-agent` / `team`、恢复） | `<程序> <旗标> <launchWords 引用后>`         | `<launcher> <程序> [程序前置词] <旗标>`（`web/agent/launch.ts`，§8.1）                   |
| 依赖编排 / 节能唤醒 / 冷启动                | `canvasLaunchLine` → `<程序> <旗标> <words>` | `canvasLaunchLine` → `<launcher> <程序> [前置词] <旗标>`                                 |
| SSH 节点                                    | `claude --model …`（远端垫片注入）           | 不变                                                                                     |
| 探针 / 自己 exec 的调用方                   | `GET /api/agents` 的 `launchArgs`            | 直接 exec `<launcher> <程序> …`，或读 `GET /api/agents/{id}/integration` 的 `launchArgs` |

例（zsh，macOS）：

```
'/Users/me/Library/Application Support/Armadra/integration/run/codex' /opt/homebrew/bin/codex resume 019a… --model gpt-5
```

例（pwsh，Windows；`launchTarget` 已把 `codex.cmd` 拆成 `node.exe <cli.js>`）：

```
& 'C:\Users\me\AppData\Roaming\Armadra\integration\run\codex.exe' 'C:\Program Files\nodejs\node.exe' 'C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js' --model gpt-5
```

整行一两百字节，与 CLI、与注入内容无关。页面的 `prompt`（带帧粘贴）若在行上，仍排在 CLI 旗标之后、由启动器追加的注入之前——也就是说注入的旗标会落在位置参数之后；Claude（commander）与 Codex（clap）都接受旗标在位置参数之后，场景 5 要实测一次（§13.3）。

## 3. 文件布局

```
<数据目录>/integration/
  <cli>/                 产物（不变：settings.json、plugin/、instructions.md、config/、armadra-status.*、overlay.yml、skills/、injection.json）
  run/<cli>              POSIX 启动器（0755）                       ─┐ Windows：run\<cli>.exe + run\<cli>.launch
  shims/<cli>            POSIX 垫片（0755）                         ─┘ Windows：shims\<cli>.exe + shims\<cli>.launch
  launcher.json          启动器层的标记：{ revision, clientBin, platform, writtenAt }
  global-migration.json  一次性迁移记录（§10）
  global-backup-<时间戳>/ 迁移备份（不变）
```

- `run/` 与 `shims/` 的生成由 `prepareInjection` 在写完 `<cli>/` 产物之后做：内容由产物布局与 `canvasInjection` 的字面 `args` / `env` 决定，确定性的，字节相同不写。`launcher.json` 记启动器层的修订；`INTEGRATION_REVISION` 变、`clientBin` 变、平台变都重写。
- 每个 CLI 一个启动器而不是一个通用启动器加参数：文件名就是 CLI 名，`ps` / 任务管理器里看得出；垫片必须同名，顺手就是一种形状。
- Windows 的 `.exe` 是同一个二进制的副本（几 KB），不是硬链接：Windows 不让覆盖正在运行的映像但让改名，沿用 `cli/armadra-hook/launcher.ts::placeExe` 的「忙着就先挪开」。

## 4. POSIX 启动器与垫片规范

### 4.1 `run/<cli>`

生成模板（Claude；`'…'` 是 `posixQuote` 的结果）：

```sh
#!/bin/sh
# Armadra 画布启动器（claude）。由 core 生成，改动会被覆盖。
# 用法：run/claude <程序> [程序前置词…] [CLI 的参数…]
# 没有 ARMADRA_NODE_ID（不是画布节点，或在画布外重跑这一行）时原样启动程序。
[ -n "${ARMADRA_NODE_ID:-}" ] || exec "$@"
exec "$@" '--settings' '/…/integration/claude/settings.json' '--plugin-dir' '/…/integration/claude/plugin' '--append-system-prompt-file' '/…/integration/claude/instructions.md'
```

OpenCode 多两行 `OPENCODE_CONFIG_DIR='…'; export OPENCODE_CONFIG_DIR`（在第二个 `exec` 之前，第一个 `exec` 之后——画布外不设）。Codex 的 `-c developer_instructions="…"` 是一个带 `\n` 转义的 TOML 基本串（沿用 `tomlString` = `JSON.stringify`），整词 `posixQuote`。

规则：

- `$1` 是程序，可以是绝对路径或裸名（垫片传裸名，由已经摘掉垫片目录的 `PATH` 找）；后面的词原样透传。启动器不解析、不改写任何调用者的词。
- 两个 `exec`，没有子进程：CLI 顶替启动器的 pid，进程树与现在一样（`hibernator` 的进程树判定、`paneRunsAgent` 不受影响）。
- 不依赖 `bash`，只用 POSIX `sh`（`#!/bin/sh`）：与远端启动器 `bin/armadra-hook` 同一假设。
- 注入文件写错（路径不存在）由 CLI 报错，与今天一样；启动器自己不检查文件。
- 调用者的参数里出现 `--` 之后的词也照传。

### 4.2 `shims/<cli>`

```sh
#!/bin/sh
# Armadra 画布垫片（claude）：只在画布节点终端的 PATH 最前面。由 core 生成，改动会被覆盖。
shims='/…/integration/shims'
rest=; set -f; old_ifs=$IFS; IFS=:
for entry in $PATH; do [ "$entry" = "$shims" ] && continue; rest="${rest:+$rest:}$entry"; done
IFS=$old_ifs; set +f; PATH=$rest; export PATH
exec '/…/integration/run/claude' claude "$@"
```

- 摘 `PATH` 的循环沿用 `hook/install/remote.ts::shim`，本机与远端共用一个生成函数（§6.2）。
- 摘掉之后才 `exec` 启动器，所以 CLI 再起同名程序（子代理、`!claude` 之类）找到的是真 CLI，不会二次注入；启动器同样看 `ARMADRA_NODE_ID`，嵌套进程里仍带这个变量，但没有垫片就不会经过启动器。
- 节点 shell 的 rc 若整条重设 `PATH`，垫片就丢了，手敲的 `claude` 不带注入；启动行不受影响（它写绝对路径）。与远端文档 §4 第一条同一个边，尽力而为。
- `custom:` 条目若改了程序名（`launchCmd` 不是六个名字之一），没有同名垫片；启动行照样经启动器。

### 4.3 节点终端的 `PATH`

`agent/canvas-launch.ts::canvasEnvironment` 不再答 `OPENCODE_CONFIG_DIR` 这些；它答两个变量：

- `ARMADRA_SHIMS=<数据目录>/integration/shims`（远端已经用这个名字）。
- `PATH=<shims>:<agentPath(ambient, hookDir)>`：`terminal/environment.ts::agentPath` 已经导出，`hookClient()` 给 Hook 客户端目录；`ownedEnvironment` 的对子覆盖 `childEnvironment` 的 `PATH`（direct 后端按名覆盖，tmux 后端 `new-session -e PATH=…` 按会话覆盖，session-host 同 direct）。

`agentPath` 的注释「只追加不前置，用户的同名工具仍然赢」仍成立：垫片把调用委托给 `PATH` 剩余部分找到的那一个，用户的工具还是那一个，只是被包了一层。

## 5. Windows 启动器规范

### 5.1 为什么是一个 C# `.exe`，不是 `.cmd` / `.ps1`，也不是 node 脚本

| 方案                                                 | 问题                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.cmd` 启动器                                        | `%*` 让 `cmd.exe` 把参数再读一遍（画布内注入 §2、状态文档 §54.3）：Codex 的 `-c` 值带 `"`，第二遍就翻面；`&`、`%` 都活着。这正是本轮要删掉的 `batchSafeWord` 整套逻辑的根源，不能把它搬进启动器                                                                                                |
| `.ps1` 启动器                                        | 由谁执行？`cmd.exe` 节点里要 `powershell -File`，5.1 把参数交给原生程序时丢 `"`（`shell.ts` 的 `windows-powershell` 注释）；执行策略可能禁 `.ps1`                                                                                                                                              |
| node 脚本（`armadra-hook.js` 同款）                  | 桌面壳只有 Electron 当解释器，要 `ELECTRON_RUN_AS_NODE=1`——敲进 shell 的一行在 `cmd` / `pwsh` / 5.1 三种方言里没有统一的「带环境变量起一个程序」写法，放进节点 shell 环境又会让用户从这个终端起的任何 Electron 应用都变成 node；且 node 不能 exec，CLI 生命周期内多一个 50 MB 的 Electron 进程 |
| 保留 `windows-shim.ts` 的拆包装 + 继续把注入写在行上 | 行上仍有注入（问题 1、4、5 都在），Windows 永远是「另一套」                                                                                                                                                                                                                                    |
| **C# 控制台程序**（选定）                            | 仓库已有同类：`cli/armadra-hook/windows-launcher.cs`，用每台 Windows 自带的 `csc.exe` 编译，几 KB，anycpu。调用者给的命令行尾巴原样交给 `CreateProcessW`，一个字节不经第二次解释；控制台子系统、作业对象 KILL_ON_JOB_CLOSE、Ctrl+C 交给子进程、退出码透传都已验证过                            |

代价：CLI 生命周期内多一个几 KB 的原生父进程（`run\claude.exe`）。`paneRunsAgent` 以 `claude.exe` 匹配 `claude`，父进程反而让判定更稳；ConPTY 下父子共用同一个控制台，Ctrl+C 两边都收到，父进程只是不退出（与 Hook 启动器同一写法）。

### 5.2 `armadra-launch.exe`

新源文件 `apps/desktop/src/cli/armadra-launch/windows-launch.cs`，由 `scripts/hook-launcher.mjs` 泛化后的编译函数构建成 `cli/armadra-launch.exe`（与 `cli/armadra-hook.exe` 并排进 resources；`after-pack.mjs` 的 Windows 目标多编一个；`pnpm --filter @armadra/desktop build` 在 Windows 宿主上也编，开发树才有）。不改 `armadra-hook` 的启动器：它的 `.launch` 是两行定长格式，Hook 配置里写着它的路径，不动。

行为（`Main`）：

1. 读 `<自身路径去掉 .exe>.launch`（UTF-8，`\r\n` 或 `\n`，`key=value` 一行一条，`#` 开头是注释）。首行必须是 `armadra-launch 1`；认不出就 stderr 一句、退出码 1。
2. 取 `tail = Tail(Environment.CommandLine)`（沿用 `windows-launcher.cs::Tail`：argv[0] 之后的原文）。
3. 决定程序：`.launch` 里有 `program=` 时（垫片模式）程序是它，`lead=` 的词依次排在后面，`tail` 整段是 CLI 的参数；没有时（启动器模式）`tail` 的第一个词就是程序，`tail` 原样就是整条命令行。
4. 门：`gate=` 指定的变量（固定 `ARMADRA_NODE_ID`）为空 → 跳过第 5、6 步。
5. 兑换（契约 §20.4、§12.4，2026-10-03 补上）：有 `credential=<客户端>` 且 `ARMADRA_CREDENTIAL_REF` 非空时起 `<客户端> credential`，读它的标准输出 `NAME=value`，名字必须在 `credential-var=` 名单里；有 `ama-keys=<客户端>` 时起 `<客户端> credential --ama`，按行读，名字必须在 `ama-var=` 名单里。客户端失败、名字不认识、`credential=` 为空串（没有客户端）都拒绝启动；值只 `SetEnvironmentVariable` 给 CLI 继承。兑换不受第 8 步跳过注入词的影响。
6. 注入：`env=NAME=value` 逐条 `Environment.SetEnvironmentVariable`（子进程继承本进程环境块）；`arg=value` 逐条按 MSVCRT 规则加引号（`"` → `\"`，引号前的反斜杠加倍，与 `terminal/shell.ts::argvQuote` 同一规则）接在命令行末尾。
7. 垫片模式：从本进程 `PATH` 里摘掉自身目录（大小写不敏感、去掉尾部 `\` 后比较），再启动——与 POSIX 垫片同义。
8. 程序以 `.cmd` / `.bat` 结尾（`custom:` 条目指向读不出的包装）：改为 `cmd.exe /d /s /c "<整行>"`，并且只在每个 `arg=` 都满足 `batchSafeWord`（没有 `" % ^ & | < > ( )`）时注入，否则不注入并在 stderr 打一行「Armadra: <程序> 是批处理包装，画布注入已跳过」。这是今天 `shellCommandLine` 对批处理程序的规则搬到启动器里，内置六个 CLI 走 `launchTarget` 拆包装，不会到这一步。
9. `CreateProcessW(null, commandLine, …, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT)`、作业对象、`ResumeThread`、等退出、透传退出码——照抄 Hook 启动器。**不设** `ELECTRON_RUN_AS_NODE`。

`.launch` 示例（启动器模式，Codex）：

```
armadra-launch 1
gate=ARMADRA_NODE_ID
arg=--dangerously-bypass-hook-trust
arg=-c
arg=check_for_update_on_startup=false
arg=-c
arg=hooks.SessionStart=[{hooks=[{type="command",command="C:\\Users\\me\\AppData\\Roaming\\Armadra\\bin\\armadra-hook.exe codex"}]}]
…
arg=-c
arg=developer_instructions="…\n…"
```

垫片模式多 `program=C:\Program Files\nodejs\node.exe` 与 `lead=C:\…\codex.js`。值是原文，不加引号、不转义；生成器拒绝含 `\r` / `\n` 的值（`developer_instructions` 用的是 `\n` 两个字符，不是换行）。`.launch` 与 `.exe` 同目录、同名，`run\` 与 `shims\` 各一套。

### 5.3 没有 `.exe` 时

开发树没在 Windows 上 build、或打包时 `csc` 没找到（`after-pack.mjs` 已有的 WARNING 路径）：`prepareInjection` 不写 `run\` / `shims\`，`launcher.json` 记 `warning`，`GET /api/agents` 的行没有 `launcher`，页面与 core 的三条路都按「没有启动器」拼**裸行**（程序 + 旗标，不注入），集成页显示「启动器不可用：<原因>」。宁可不注入，也不回到把注入写在行上的旧路。

### 5.4 Windows 垫片的程序解析

POSIX 垫片在运行时由 `PATH` 找真 CLI；Windows 上找到的多半是 `claude.cmd`，拆包装的逻辑在 TS（`agent/windows-shim.ts`），不搬进 C#。所以 Windows 垫片的 `.launch` 由 core 在 `canvasEnvironment`（每次节点终端要起这个 CLI 时）写入当时 `launchTargetOf(resolveCommand(cli))` 的结果；解析不到就不写垫片（手敲 `claude` 命中的是 PATH 上的下一个，不注入）。解析结果变了（用户换了 node 版本）下一次开终端时重写。`run\` 的 `.launch` 与解析无关，不随之变。

`PATHEXT` 缺省 `.COM;.EXE;.BAT;.CMD`，`cmd.exe`、pwsh、Git Bash 都按目录顺序找：`shims\claude.exe` 在最前就命中。

## 6. 生成器与远端

### 6.1 一个生成器

新模块 `core/hook/install/launcher.ts`（纯函数）：

```ts
export interface LauncherSpec {
  readonly agentId: string;
  readonly runDir: string; // <root>/integration/run
  readonly shimDir: string; // <root>/integration/shims
  readonly args: readonly string[]; // canvasInjection(...).args
  readonly env: readonly (readonly [string, string])[]; // canvasInjection(...).env
}
export function posixLauncher(spec: LauncherSpec): string; // run/<cli> 的正文
export function posixShim(spec: LauncherSpec): string; // shims/<cli> 的正文
export function launcherFiles(
  spec: LauncherSpec,
  join: PathJoin,
): Map<string, { content: string; mode: number }>;
```

Windows 那半在 `core/hook/install/windows-launcher.ts`：

```ts
export interface WindowsLauncherSpec extends LauncherSpec {
  readonly exe: string; // resources 里的 armadra-launch.exe
  readonly shimTarget?: ShimTarget; // 垫片模式的 program / lead；缺席不写垫片
}
export function launchConfig(
  spec: LauncherSpec,
  mode: "run" | "shim",
  target?: ShimTarget,
): string; // .launch 正文
export function windowsLauncherFiles(
  spec: WindowsLauncherSpec,
): Map<string, { content: string | Buffer; mode: number }>;
```

`prepareInjection` 按平台调其中一个；`remote.ts` 永远调 POSIX 的，`join = path.posix.join`。

### 6.2 远端

`remoteIntegrationFiles` 不再内联注入到 `shims/<cli>`，而是写 `run/<cli>`（POSIX 启动器）与 `shims/<cli>`（委托给 `run/<cli>`），内容来自同一个 `launcherFiles`。远端启动行不变（裸名，靠 `ARMADRA_SHIMS` 在 `PATH` 最前）。远端 Hook 客户端的启动器 `bin/armadra-hook` 不变。

Codex 信任：`integration.sync` 不再带 `codexCommand`；Worker 侧 `syncIntegration` 的信任写入删掉（§10.2）。

## 7. Codex

### 7.1 旗标，实测（2026-10-02，Codex 0.160.0，本机）

- `codex --help`、`codex exec --help`、`codex resume --help` 都列出 `--dangerously-bypass-hook-trust`（「Run enabled hooks without requiring persisted hook trust for this invocation」）。所以 `codex resume <id> … --dangerously-bypass-hook-trust` 这个位置是认的，与 `-c` 一样写在子命令之后。
- 临时 `CODEX_HOME`（空目录、没有 `config.toml`、没有登录）下 `codex exec --skip-git-repo-check --dangerously-bypass-hook-trust -c check_for_update_on_startup=false -c 'hooks.SessionStart=[{hooks=[{type="command",command="echo fired >> <file>"}]}]' "Reply OK"`：请求因 401 失败，但 `SessionStart` 的 Hook **跑了**（文件里有 `fired`），`CODEX_HOME` 里没有生成 `config.toml`。
- 对照：同样的命令不带旗标，Hook 没跑；带 `-c bypass_hook_trust=true` 代替旗标，Codex 打印 `session-flags: \`bypass_hook_trust\` is ignored.`，Hook 也没跑。**只有命令行旗标有效**，`-c`形式不可用（原生二进制里虽有`bypass_hook_trust` 覆盖项，但会话旗标层忽略它）。
- 二进制里的警告原文：`` `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation. ``——TUI 每次启动打这一行，接受。
- 版本：PR openai/codex#24317 修的是 TUI 之前**忽略**这个旗标、仍弹「Hooks need review」的问题（用户给的说法是 0.134 起）。这个旗标本身首次出现在哪个版本没核实到；实现时拿 `@openai/codex@0.133.0` 的 `--help` 对一次，核不到就把门槛定为 **0.134.0**，常量 `CODEX_HOOK_TRUST_BYPASS_MIN`。

### 7.2 版本门槛的处理

`canvasInjection` 对 Codex 读 `agent/probe.ts::storedProbe("codex")`：

- 版本已知且 `< CODEX_HOOK_TRUST_BYPASS_MIN`：**不带旗标也不带八个 `-c hooks.*`**（没有信任又没有旗标，TUI 会停在「Hooks need review」对话框上，正好挡住首投；旧版本不认旗标则直接拒绝启动——两种都比没有 Hook 更糟）。仍带 `check_for_update_on_startup=false` 与 `developer_instructions`。集成页 `warning`：「Codex x.y.z 太旧，画布内启动不带 Hook；0.134 起支持」。状态来源退回画面安静判定（`startsSilently` 已把 Codex 当作不报开场的那类）。
- 版本未知（还没探过、或探测失败）：带。与今天行为一致；探测在装配后 3 秒跑，`GET /api/agents` 绝大多数时候已知。

### 7.3 `developer_instructions`

`collab/skill.ts::developerInstructions` 改成：

```
[Armadra canvas rules r16]
以下规则只在环境变量 ARMADRA_NODE_ID 已设置（本会话由 Armadra 画布启动，`armadra-hook` 可用）时生效；没有它时忽略本段。
The rules below apply only when ARMADRA_NODE_ID is set (this session was started from an Armadra board); otherwise ignore this section.

<canvasRules()>

完整说明在 <skillPath>，需要时用读文件工具读取。Full skill: <skillPath>
```

- `r16` 是 `SKILLS_REVISION`（`events.ts` 与 `collab/skill.ts` 同步升到 16；`INTEGRATION_REVISION` 随之变，所有产物重写）。标记放首行，会话记录里一眼看得出是哪一版写的；`skill.test.ts` 断言首行含当前修订。
- 画布外 `codex resume` 读到的是旧会话记录里的那段，条件句让模型自己判断；真正的保证仍是 Hook 客户端在没有 `ARMADRA_NODE_ID` 时不做事。
- `SKILL.md` 的尾注 `<!-- armadra:skill-revision 16 -->` 与 `canvasInstructions` 不变。

## 8. 接口与契约

### 8.1 `GET /api/agents`

每行（内置与 `custom:`）：

- 新增 `launcher?: string`：这台机器上 `run/<cli>`（Windows `run\<cli>.exe`）的绝对路径。产物还没生成、没有数据目录、Windows 没有 `.exe` 时缺席。`custom:` 条目答它基础 CLI 的。
- **删除** `launchWords`、`launchArgs`。`launchTarget`、`resolvedPath`、`clientRevision`、`skillsRevision`、`probe`、`history` 不变。
- 共享层 `agentInfoSchema`：`launcher: z.string().optional()`；`launchWordSchema`、`launchWords`、`launchArgs` 删掉。

页面 `web/agent/launch.ts::launchInput`：

```
program     = launcher ?? （旧 core）override || target.program || resolvedPath || launchCmd
programArgs = launcher ? [override || target.program || resolvedPath || launchCmd, ...(target?.args ?? [])] : (target?.args ?? [])
```

`assembleLaunchCommand` 把 `programArgs` 放在程序之后、旗标之前（已有行为），`shellWords` / `extraArgs` 的注入分支删掉（`custom.args` 仍走 `extraArgs`——不对，`custom.args` 走 `custom?.args`，`extraArgs` 这个入参本身删掉）。SSH 节点（`remote = true`）不变。

版本错配：

| 页面 \ core | 旧 core（答 `launchWords` / `launchArgs`）                            | 新 core（答 `launcher`）                  |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------- |
| 旧页面      | 现状                                                                  | 两个字段都没有 → 裸行，不注入（不会截断） |
| 新页面      | 没有 `launcher` → 退回读 `launchWords` / `launchArgs`（保留一个版本） | 本方案                                    |

页面与 core 一起发布，错配只在开发时出现；退路选「不注入」而不是「长行」。

### 8.2 `GET /api/agents/{id}/integration`

- `launchArgs`（字面 argv）保留——探针、集成页显示用；`launchEnv`（变量名）保留；**`launchWords` 删除**。
- `globalWrites` 恒为 `[]`：字段留一个版本给旧页面，新页面不再画「信任记录写在 …」（`integration.globalWrite` 文案中英一起删）。
- 新增 `launcher?: string`、`shim?: string`、`launcherWarning?: string`（Windows 没有 `.exe`、Codex 太旧）。
- `hook.installed` 对 Codex 不再看 `codexTrusted`，只看产物。
- `migration` 多 `sessionTrust?: { at, removed: string[], backup?: string, error? }`（§10）。

### 8.3 `POST /api/terminals` 与节点终端环境

`ownedEnvironment` 的画布半边改为 `ARMADRA_SHIMS` 与 `PATH`（§4.3）；`OPENCODE_CONFIG_DIR` 等不再出现在终端环境里。契约 §5 列的四个地址变量不变。

### 8.4 Worker

能力 `remote.integration.v2`：`integration.sync` 不再接受 `codexCommand`（收到就忽略），答复里没有 `trustChanged`；`integration.locate` 不变。控制端只要求 v1 就能同步（旧 Worker 不会写信任——它只在收到 `codexCommand` 时写）；集成页在主机只有 v1 时提示「执行主机 X 的 Worker 旧：之前写的 Codex 信任记录要升级后才会清」。

### 8.5 契约文档

`docs/contracts/core-json-api.md` 末尾加 **§13「画布启动器」**：13.1 `/api/agents` 行的 `launcher`（与 `launchWords` / `launchArgs` 的下线）、13.2 `/integration` 状态的新旧字段、13.3 迁移记录 `version: 2` 的形状、13.4 Worker `remote.integration.v2`。已有 §N 不动。

## 9. 代码里谁拼启动行

`agent/canvas-launch.ts::canvasLaunch` 仍是 core 唯一出口：

```
launcher = launcherFor(dataDir, base)            // run/<cli> 存在且 launcher.json 当前 → 路径；否则 undefined
program  = launcher ?? resolved
lead     = launcher ? [resolved, ...(target?.args ?? [])] : (target?.args ?? [])
args     = [...lead, ...flags]                    // 字面 argv；没有注入——注入在启动器里
line     = shellCommandLine(program, [...lead, ...flags], dialect)
```

- `CanvasLaunch.args` 不再含注入；自己 exec 的调用方（探针）就 exec `program` + `args`，启动器会补。
- `dialect` 只影响引用，`InjectionRequest.dialect`、`startsThroughBatch`、`canvasEnvironment` 的方言参数删掉。
- `frozenArgs`（计划）、`resume`、`ssh` 分支不变；SSH 分支 `launcher = undefined`、程序裸名。
- 依赖编排 / 节能唤醒 / 冷启动三条路不改调用（签名不变）。

结构性用例（`canvas-launch.test.ts`）改为：core 里调用 `canvasInjection(` 的只有 `hook/install/inject.ts` 自己的 `prepareInjection`、`integration.ts`；调用 `launcherFor(` 的只有 `canvas-launch.ts`；页面里 `assembleLaunchCommand(` / `assembleLaunchArgv(` 只在 `agent/launch.ts`，且它读 `?.launcher`。

## 10. 迁移 v2

### 10.1 本机

`hook/install/migrate.ts::migrateGlobalInstalls`：

```
record = readMigration(dataDir)
if record === undefined        → 跑 v1（现有逻辑）再跑 v2，写 { version: 2, … }
else if record.version === 1   → 只跑 v2，把记录升成 version 2（v1 的 agents 原样保留）
else                           → 什么也不做
```

v2 步骤（只针对 Codex）：

1. `~/.codex`（`configHome("codex")`）不存在 → 记 `sessionTrust: { at, removed: [] }`，不建目录。
2. 读 `config.toml`；`toml-state.ts::isEditable` 不通过 → 记 `error`，不改写（与 v1 同一规矩：记下来就不再碰）。
3. `stateKeys` 里以 `/<session-flags>/config.toml:` 开头的键，用 `removeTrustState` 全部去掉（只认前缀，不算哈希——用户自己为这个键写过的记录也会被删，这是 v1 时就覆盖掉的那条边，v1 文档 §4 末尾已写明）。
4. 字节有变化：先把原文件复制成 `config.toml.armadra-backup-<时间戳>`，再原子写回；没变化不留备份。
5. `sessionTrust: { at, path, removed: [键…], backup?, error? }` 写进记录，`version: 2`。

`ARMADRA_NO_GLOBAL_WRITES=1` 时 v1、v2 都不跑（测试套件用真实 `HOME`）。`removeInjection`（集成页卸载）不再碰 `config.toml`。

### 10.2 远端

Worker（新版本）在 `integration.sync` 里：不再收到 `codexCommand`；若 `<状态目录>/integration/global-migration.json` 没有 `sessionTrust`，对执行主机的 `~/.codex/config.toml` 做同样的 v2 步骤一次（存在才做、认不出不改、备份旁边），记进那个文件。旧 Worker 不做，由集成页提示升级（§8.4）。

## 11. 删除清单

| 文件                                                  | 删掉                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook/install/inject.ts`                              | `trustCodexSessionHooks`、`untrustCodexSessionHooks`、`codexTrusted`、`codexSessionTrust`、`CODEX_SESSION_KEY_PREFIX`（前缀常量搬到 `migrate.ts`）、`codexWords`、`codexTomlString`、`CMD_TOML_PLAIN`、`CODEX_HOOK_VAR`、`CODEX_INSTRUCTIONS_VAR`、`Injection.words`、`InjectionRequest.dialect`、`InjectionOptions.skipTrust` / `codexHome`、`PrepareReport.trust`；`import` 里的 `toml-state`、`codex.ts::hookHash/resolvedTimeout` |
| `hook/install/codex.ts`                               | `hookHash` 与其 0.149.1 / 0.155.1 哈希用例可删（迁移只按键删，不再算哈希）；`eventKey`、`uninstall`（v1 迁移用）保留                                                                                                                                                                                                                                                                                                                  |
| `hook/install/integration.ts`                         | `codexTrusted` 判定、`globalWrites` 的 Codex 分支、`skipTrust` / `codexHome` 透传、`prepareAtStartup` 里「有 `~/.codex` 才写信任」                                                                                                                                                                                                                                                                                                    |
| `hook/install/remote.ts`                              | `shim` 里内联注入、`remoteCodexCommand`                                                                                                                                                                                                                                                                                                                                                                                               |
| `remote/integration.ts` / `integration-worker.ts`     | `codexCommand` 的传递与 `trustCodexSessionHooks` 调用、`SyncResult.trustChanged`                                                                                                                                                                                                                                                                                                                                                      |
| `agent/canvas-launch.ts`                              | `startsThroughBatch`、`injection.words`、`dialect` 到 `canvasInjection` 的透传、`canvasEnvironment` 的 `dialect` 参数                                                                                                                                                                                                                                                                                                                 |
| `terminal/shell.ts` ＝ `packages/shared/src/shell.ts` | `LaunchWord` 的 `{ prefix, env }` 形、`shellEnvWord`、`renderLaunchWord` 的环境分支、`verbatimWord` 的环境分支；`LaunchWord` 退化为 `string`（类型别名可留一版）。`isBatchProgram` / `batchSafeWord` 保留（§5.3 的裸行退路与 SSH 行仍可能遇到批处理程序）                                                                                                                                                                             |
| `packages/shared/src/agents.ts`                       | `shellWords`、`extraArgs`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/shared/src/api/agents.ts`                   | `launchWordSchema`、`launchWords`、`launchArgs`（行上）、`IntegrationState.launchWords`                                                                                                                                                                                                                                                                                                                                               |
| `web/agent/launch.ts`                                 | `launchWords` / `launchArgs` 的拼接（保留一版作旧 core 退路后再删）                                                                                                                                                                                                                                                                                                                                                                   |
| `web/.../IntegrationPage.tsx`、`i18n/integration.ts`  | `globalWrites` 渲染、`integration.globalWrite`                                                                                                                                                                                                                                                                                                                                                                                        |
| `terminal/install.ts`                                 | `ownedEnvironment` 的 `dialect` 参数（三处调用）                                                                                                                                                                                                                                                                                                                                                                                      |
| 测试                                                  | `inject.test.ts` 的「Codex's trust records」「Codex's expanded values per shell」两组、`canvas-launch.test.ts` 的 `--%` / `%VAR%` 用例、`windows-launch.test.ts` 的环境展开用例、`codex.test.ts` 的哈希用例                                                                                                                                                                                                                           |

`toml-state.ts` 保留（迁移 v1 / v2 都用）。`agent/windows-shim.ts` 保留（`launchTarget` 仍是 Windows 上拆包装的来源）。

## 12. Hook 上报的来源校验（可选加固，本轮做）

`hook/ingest.ts` 在算出 `provider` 与 `owner` 之后：`owner.agentId` 已知、且 `baseAgent(owner.agentId) !== provider` 时 `debug` 一行并答 204（与「未知节点」同一处理，不让 CLI 看到错误）。效果：`ARMADRA_NODE_ID` 泄到别的 CLI（嵌套进程、用户在节点里手起另一家）时，那家的上报不会改写这个节点的状态。`custom:` 条目按基础 CLI 比。用例：`claude` 节点收到 `/hook/codex` → 丢弃；`custom:mine`（基 claude）收到 `/hook/claude` → 接受。

## 13. 测试计划

### 13.1 单元（`pnpm libs:build && pnpm --filter @armadra/desktop test`）

- `hook/install/launcher.test.ts`（新）：六个 CLI 的 `run/` / `shims/` 正文确定性、字节幂等；**真跑**（非 Windows）：`/bin/sh run/<cli> <假程序> a 'b c'`，假程序是把 argv 与环境写成 JSON 的脚本——没有 `ARMADRA_NODE_ID` 时 argv 原样、环境里没有 `OPENCODE_CONFIG_DIR`；有时注入排在调用者参数之后、`resume <id>` 在前、OpenCode 的变量只在假程序里可见；垫片摘掉自己的目录后委托，假程序放在另一个 `PATH` 目录里被找到；嵌套：假程序再起 `claude` 时命中真程序而非垫片。
- `hook/install/windows-launcher.test.ts`（新，任意平台）：`.launch` 正文、拒绝含换行的值、`program=` / `lead=` 只在垫片模式出现。
- `agent/windows-launch.test.ts`（`it.runIf(win32)`，扩）：用 `scripts/launch-exe.mjs` 把 C# 编到临时目录，复制成 `run\claude.exe` + `.launch`，把 `shellCommandLine` 生成的整行交给真 `cmd.exe`、`pwsh`、`powershell.exe`：十八个值原样到达；`arg=` 里带 `"`、`&`、`%`、中文的 Codex 式 TOML 串原样到达；门关着时没有注入；退出码透传（假程序 `process.exit(7)`）；程序是 `.cmd` 包装时经 `cmd.exe` 起来、不安全的注入词被跳过并有 stderr 提示；垫片模式摘 `PATH`。
- `scripts/launch-exe.test.mjs`（`node --test`，Windows 才编译）：C# 源能用系统 `csc` 编过；`after-pack` 的 Windows 目标把 `cli/armadra-launch.exe` 放进 resources。
- `agent/canvas-launch.test.ts`：三种方言的行形状（含空格路径的启动器在 pwsh 用 `&`）、`args` 不含注入、冷启动 / 唤醒 / 依赖路带启动器、SSH 行裸、Windows 没有 `.exe` 时裸行、结构性用例（§9）。
- `hook/install/inject.test.ts`：Codex 的 `args` 含 `--dangerously-bypass-hook-trust` 且八个 `-c` 在后；版本门槛（探测缓存注入：`0.133.0` → 没有旗标没有 Hook，有说明；未知 → 带）；`prepareInjection` 不碰 `config.toml`（临时 `HOME` 下跑完，`~/.codex/config.toml` 不存在）。
- `hook/install/migrate.test.ts`：没有记录的机器 v1+v2 一起、`version: 1` 的记录只跑 v2 并升版、只删 `/<session-flags>/` 前缀的键、备份只在有变化时留、认不出的 `config.toml` 记 `error` 不改、`ARMADRA_NO_GLOBAL_WRITES` 下不跑、第二次启动不再跑。
- `hook/ingest.test.ts`：§12 两条。
- `collab/skill.test.ts`：`developerInstructions` 首行带 `r16` 与条件句；`SKILLS_REVISION` 两处一致。
- `remote/integration.test.ts`：远端 `shims/claude` → `run/claude`，假 CLI 收到 `--settings …`；`integration.sync` 不带 `codexCommand`；Worker 的 v2 一次性（临时 `HOME` 里放一份带 `/<session-flags>/` 键的 `config.toml`，同步后键没了、备份在、第二次不动）。
- `terminal/environment.test.ts` / `install` 相关：节点终端 `PATH` 以 `shims` 开头，普通终端不带。
- `pnpm --filter @armadra/web test` / `typecheck`：`agent/launch.test.ts` 新 core（`launcher`）与旧 core（`launchArgs`）两种行、SSH 不变；`IntegrationPage.test.tsx` 不再画信任记录、画 `launcherWarning`。
- `pnpm --filter @armadra/shared test`：`assembleLaunchCommand` 的 `programArgs` 顺序、`shell.ts` 两份字节一致（core 用例已有）。
- `pnpm --filter @armadra/server test`：服务器壳装配同一个 core，启动时迁移在临时数据目录下不写全局。
- `pnpm check`：契约 §13、文档登记、`repo:check`。

### 13.2 Windows CI

`ci.yml` 的 windows-latest 已跑 `pnpm --filter @armadra/desktop test`；新增的 `it.runIf(win32)` 用例与 `node --test scripts/launch-exe.test.mjs` 自然进这一步。runner 自带 .NET Framework 4 的 `csc.exe`（`hook-launcher.test.mjs` 已在那里编译过）。

### 13.3 端到端（`tools/probes/agent-e2e.mjs` 场景 5）

- 读 `GET /api/agents` 的 `launcher`，断言 Claude / Codex 的行都有；`GET /api/agents/codex/integration` 的 `launchArgs` 含旗标与八个 `-c`。
- 画布内：`exec <launcher> codex exec --skip-git-repo-check "Reply OK"`（环境带 `ARMADRA_NODE_ID`）——会话记录里有 `[Armadra canvas rules r16]` 与技能路径、Hook 打到 core、`stderr` 里有 `--dangerously-bypass-hook-trust is enabled` 那行。
- 画布外：同一条命令、同一环境但去掉 `ARMADRA_NODE_ID`——这就是「历史里重跑」：会话记录没有画布规则、Hook 没打到 core。Claude 同样两遍（`-p --output-format stream-json`，init 里有没有 `armadra` 插件）。
- 旗标在位置参数之后：Claude 与 Codex 各跑一次 `<launcher> <cli> … "Reply OK"`，确认注入仍被接受（§2.2 末尾）。
- 临时 `CODEX_HOME` 里跑完**没有** `config.toml`（之前断言的是「信任记录只写进了临时 CODEX_HOME」，反过来）。
- 收尾的 `fingerprint()` 已守 `~/.codex/config.toml`、`~/.claude/settings.json` 等字节不变，不用改；加一条：探针起的 core 的数据目录里 `global-migration.json` 的 `version` 为 2 且 `sessionTrust.removed` 为空（探针的 `HOME` 没有旧记录）。
- 场景 1（Codex 首投）顺带证明 TUI 的那行警告不挡首投；场景 4（唤醒）证明 `resume` 行经启动器。

## 14. 已知的边

- 节点 shell 的 rc 整条重设 `PATH` → 手敲不注入（启动行不受影响）。macOS `path_helper` 把已有条目挪到系统路径之后：`shims` 是我们前置的，会被挪到 `/usr/bin` 之后，真 CLI 若装在系统路径里就绕过垫片。本机 CLI 多在 Homebrew / mise 下，不受影响；记在集成页的说明里。
- Windows 垫片的目标是开终端那一刻解析的；之后换 node 版本要重开终端才跟上。
- 核心升级前开的 tmux 会话：环境里没有 `ARMADRA_SHIMS` / 前置的 `PATH`，手敲不注入；新版页面敲的启动行写绝对路径，照常注入。
- `custom:` 条目 `launchCmd` 指向读不出的 `.cmd`：Windows 启动器经 `cmd.exe` 起它，注入只在词都批处理安全时生效——Codex 基的自定义条目在这种包装下不带 Hook（stderr 有提示）。
- Codex < 0.134：没有 Hook（§7.2）。
- 用户自己的用户层 / 插件 Hook 在画布内的 Codex 会话里也会跑（用户接受）。
- `developer_instructions` 的条件句靠模型遵守；硬保证仍是 Hook 客户端的 `ARMADRA_NODE_ID` 门。
- 启动行上的程序路径（`/opt/homebrew/bin/claude`）与今天一样进 shell 历史；进历史的不再有数据目录之内的任何路径（启动器路径除外）。
- 页面 `prompt` 在行上时，注入旗标落在位置参数之后（§2.2）。

## 15. 被否的方案

| 方案                                                      | 为什么不选                                                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 继续把注入写在行上，只把 Codex 的信任换成旗标             | 问题 1、3、4、5 都还在；旗标只解决问题 2                                                             |
| 一个通用启动器 `run/armadra-launch <cli> <程序> …`        | 垫片必须同名，等于还是每个 CLI 一个文件；通用启动器要在运行时找产物，多一层解析，`ps` 里看不出是哪家 |
| 把注入塞进节点 shell 的环境（`CLAUDE_*`、`CODEX_*` 之类） | 多数注入是 argv，不是环境；环境注入正是问题 5                                                        |
| 启动器用 node（`armadra-hook.js` 同款）                   | §5.1：桌面壳要 `ELECTRON_RUN_AS_NODE`，三种 Windows 方言没有统一写法；node 不能 exec                 |
| `.cmd` / `.ps1` 启动器                                    | §5.1                                                                                                 |
| 继续写 Codex 信任记录但只写进临时 `CODEX_HOME`            | 画布内的 Codex 得换配置目录，用户的登录、会话历史、配置全丢                                          |
| `-c bypass_hook_trust=true` 代替旗标                      | 实测被会话旗标层忽略（§7.1）                                                                         |
| 用 `codex app-server` 的 `hooks/trust` 之类动词写信任     | 仍是写用户的 `config.toml`，违反硬约束                                                               |
| 远端继续内联注入到垫片                                    | 两套生成逻辑；统一成「垫片委托启动器」后本机与远端一份代码                                           |
| 由页面而不是 core 判断 Codex 版本门槛                     | 版本缓存在 core 的设置里，`canvasInjection` 已是唯一答注入的地方                                     |

## 16. 实施后要回改的文档

- `docs/design/canvas-only-integration.md`：§2 的 `canvasInjection` 三样答案改两样、方言段去掉 Codex 环境展开与 `.cmd` 词过滤、路径表里加启动器；§3 删「Codex 的启动行要短」、矩阵 Codex 行写旗标；§4 整节改成「信任：会话级旗标，零写入」并指向本文 §7；§5 迁移记录 `version: 2`、集成页去掉「信任记录写在…」；§7 验证改指本文 §13。
- `docs/design/remote-canvas-injection.md`：§2 第 3 条垫片改成「垫片委托 `run/<cli>`」；删掉信任那段；§5 验证改。
- `docs/guides/agent-collaboration.md`：「启动参数由 `GET /api/agents` 的 `launchArgs` 给出」改为 `launcher`。
- `docs/guides/architecture.md`：`integration/` 布局加 `run/`、`shims/`、`launcher.json`；Windows 多一个 `cli/armadra-launch.exe`。
- `docs/status/typescript-core-status.md`：新节记录实测数字（§54 的 Windows 用例改指启动器）。
- `docs/contracts/core-json-api.md`：§13（§8.5）。
- `tools/probes/README.md`：场景 5 的描述。

## 17. 工作分解

五个工作包，**文件所有权互斥**（一个文件只属于一个包；表里没列的文件不许改，确实要改先在本文登记）。各包各开一个分支，分支名按用途（如 `feat/launcher-core`），一个 PR；合入顺序 **WP3 → WP1 → WP4 → WP2 → WP5**，前面的合入 main 后后面的 rebase。接口以本文 §6.1、§8、§9 为准，并行开发时先按接口写桩，rebase 后换成真的。

提交粒度：一个模块（源文件）加它的测试一个提交；提交信息沿用仓库习惯（`feat(core): …——…` / `fix(core): …` / `test(core): …` / `docs: …`，中文，说清改了什么与为什么），不加 AI 署名。

### WP1 启动器生成与注入（core，POSIX）

所有权：`core/hook/install/inject.ts`、`inject.test.ts`、`launcher.ts`（新）、`launcher.test.ts`（新）、`remote.ts`、`integration.ts`、`integration.test.ts`、`index.ts`、`events.ts`、`skills.ts`；`core/collab/skill.ts`、`skill.test.ts`；`core/hook/ingest.ts`、`ingest.test.ts`。

内容：`launcher.ts` 的 POSIX 生成器与 `launcherFiles`；`prepareInjection` 写 `run/` / `shims/` / `launcher.json`，Windows 分支调 WP4 的 `windowsLauncherFiles`（WP4 合入前用一个返回空 Map 的桩，桩放在 `inject.ts` 内部，不新建文件）；`canvasInjection` 去掉 `words` / `dialect`，Codex 加旗标与版本门槛（读 `agent/probe.ts::storedProbe`，只读不改）；删除信任函数；`remote.ts` 改成「启动器 + 委托垫片」、删 `remoteCodexCommand`；`integration.ts` 的状态字段（§8.2）；`SKILLS_REVISION` 16 与 `developerInstructions`；`ingest.ts` 的来源校验。

依赖：WP3 先合入（它从 `inject.ts` 搬走 `CODEX_SESSION_KEY_PREFIX` / 删除对 `trust…` 的引用）。

提交计划：

1. `feat(core): hook/install/launcher.ts——每个 CLI 的 POSIX 启动器与委托垫片的生成器`（+ 用例，真跑 `/bin/sh`）
2. `feat(core): prepareInjection 写 run/ 与 shims/，canvasInjection 只答字面 argv 与 env；Codex 带 --dangerously-bypass-hook-trust、按探测版本决定带不带 Hook；删除信任记录的写入`（+ `inject.test.ts`）
3. `feat(core): 远端注入文件改为启动器加委托垫片，不再向 Worker 传 Codex 信任命令`（`remote.ts`）
4. `feat(core): 集成状态答 launcher / shim / launcherWarning，不再看 Codex 信任，globalWrites 恒空`（+ `integration.test.ts`）
5. `feat(core): Codex developer_instructions 加条件句与修订标记，SKILLS_REVISION 升 16`（+ `skill.test.ts`）
6. `fix(core): Hook 上报的 provider 与节点基础 CLI 不符时丢弃`（+ `ingest.test.ts`）

验证：`pnpm libs:build && pnpm --filter @armadra/desktop test`；合入前 `pnpm check`。

### WP2 启动行出口、终端环境、共享层与契约

所有权：`core/agent/canvas-launch.ts`、`canvas-launch.test.ts`、`core/agent/list.ts`；`core/terminal/shell.ts`、`shell.test.ts`、`packages/shared/src/shell.ts`、`packages/shared/test/shell.test.ts`（两份正文必须逐字节相同）；`core/terminal/environment.ts`、`environment.test.ts`、`core/terminal/install.ts`；`packages/shared/src/agents.ts`、`packages/shared/src/api/agents.ts` 及其测试；`core/dependencies/launch.ts`、`core/terminal/hibernator.ts`、`core/schedule/cold-start.ts`（预计不改；签名若变归本包）；`docs/contracts/core-json-api.md`。

内容：§9 的出口；`launcherFor`；`canvasEnvironment` 答 `ARMADRA_SHIMS` 与前置的 `PATH`；`shell.ts` 删环境形的 `LaunchWord`；`list.ts` 答 `launcher`、不答 `launchWords` / `launchArgs`；共享层 schema 与 `assembleLaunchCommand`；契约 §13。

依赖：WP1 的 `canvasInjection` 新形状与 `launcher.json`（rebase 到 WP1 之后再合）。

提交计划：

1. `refactor(shared): shell.ts 去掉由环境变量展开的词形，LaunchWord 只剩字面值——core 的那份逐字节同步`（两份 + 两套用例一起）
2. `feat(core): canvas-launch 经 run/<cli> 启动器拼行，argv 不再含注入；canvasEnvironment 答 ARMADRA_SHIMS 与前置 PATH`（+ `canvas-launch.test.ts`、`environment.test.ts`、`install.ts`）
3. `feat(shared): /api/agents 行加 launcher，删 launchWords / launchArgs；assembleLaunchCommand 删 shellWords / extraArgs`（+ `list.ts` + shared 用例）
4. `docs: 契约 §13 画布启动器——/api/agents 的 launcher、集成状态字段、迁移记录 v2、Worker remote.integration.v2`

验证：`pnpm libs:build && pnpm --filter @armadra/desktop test`、`pnpm --filter @armadra/shared test`、`pnpm --filter @armadra/web typecheck`（页面在 WP5 之前会红，只看共享层类型）、`pnpm check`。

### WP3 迁移 v2 与远端 Worker

所有权：`core/hook/install/migrate.ts`、`migrate.test.ts`、`codex.ts`、`codex.test.ts`、`toml-state.ts`、`toml-state.test.ts`（若有）；`core/remote/integration.ts`、`integration-worker.ts`、`integration.test.ts`、`operations.ts`、`handshake.ts`（能力常量）。

内容：§10 的 v1→v2；`CODEX_SESSION_KEY_PREFIX` 与按前缀删除搬进 `migrate.ts`（不从 `inject.ts` 导入）；`codex.ts` 删 `hookHash`；Worker 删信任写入、加 v2 一次性步骤、能力 `remote.integration.v2`；控制端 `sync` 不传 `codexCommand`、按能力提示。

依赖：无（先合）。注意 WP3 合入时 `inject.ts` 仍导出 `trustCodexSessionHooks`，WP3 只是不再调用；WP1 随后删除。

提交计划：

1. `feat(core): 一次性迁移加第二步——清掉当前版本写进 ~/.codex/config.toml 的 /<session-flags>/ 信任记录，记录升 version 2，已迁移过的机器只跑这一步`（+ `migrate.test.ts`）
2. `refactor(core): codex.ts 去掉 hookHash——迁移只按键删除，不再算 Codex 的信任哈希`（+ `codex.test.ts`）
3. `feat(core): Worker 的 integration.sync 不再写 Codex 信任，改为一次性清掉旧记录；能力 remote.integration.v2，控制端按能力提示升级`（+ `remote/integration.test.ts`）

验证：`pnpm libs:build && pnpm --filter @armadra/desktop test`、`pnpm --filter @armadra/server test`、`pnpm check`。

### WP4 Windows 启动器

所有权：`apps/desktop/src/cli/armadra-launch/windows-launch.cs`（新）；`core/hook/install/windows-launcher.ts`（新）、`windows-launcher.test.ts`（新）；`core/agent/windows-launch.test.ts`；`apps/desktop/scripts/hook-launcher.mjs`、`hook-launcher.test.mjs`、`launch-exe.mjs`（新，或并进前者）、`after-pack.mjs`、`after-pack.test.mjs`；`apps/desktop/package.json` 的 build 脚本若要在 Windows 宿主编译则归本包。

内容：§5 全部。`windowsLauncherFiles` 按 §6.1 的接口；`canvasEnvironment` 写垫片 `.launch`（§5.4）需要 `launchTargetOf` 的结果——这段逻辑放在 `windows-launcher.ts` 里导出 `shimTargetFor(agentId)`，由 WP1 的 `prepareInjection` 调用。

依赖：接口来自本文；真机验证在 Windows（CI 的 windows-latest 必过）。

提交计划：

1. `feat(desktop): armadra-launch.exe——Windows 的画布启动器，读 .launch 注入、命令行尾巴原样交给 CreateProcess；构建脚本泛化为编两个 C# 程序`（+ 脚本测试 + `after-pack`）
2. `feat(core): windows-launcher.ts——run\ 与 shims\ 的 .launch 写法与文件集，垫片目标由 launchTargetOf 解析`（+ 用例）
3. `test(core): windows-launch 用例改为经启动器——真 cmd.exe / pwsh / 5.1 整行到达、门、退出码、.cmd 包装的退路、垫片摘 PATH`

验证：Windows 上 `pnpm libs:build && pnpm --filter @armadra/desktop test`（含 `node --test scripts/*.test.mjs`）；非 Windows 上同一命令确认 `runIf` 跳过；`pnpm check`。

### WP5 页面、探针与文档回改

所有权：`apps/web/src/agent/launch.ts`、`launch.test.ts`、`apps/web/src/panels/settings/pages/IntegrationPage.tsx`、`IntegrationPage.test.tsx`、`apps/web/src/i18n/integration.ts`、`apps/web/src/api/*`（若有类型）；`tools/probes/agent-e2e/scenario-5-canvas-only.mjs`、`lib.mjs`、`tools/probes/README.md`；`docs/design/canvas-only-integration.md`、`docs/design/remote-canvas-injection.md`、`docs/guides/agent-collaboration.md`、`docs/guides/architecture.md`、`docs/status/typescript-core-status.md`、本文的状态行。

内容：§8.1 的页面拼法与旧 core 退路；集成页去信任记录、画 `launcherWarning` 与远端 Worker 提示（文案进 `i18n/integration.ts` 中英同步，复用现有 Badge）；场景 5（§13.3）；§16 的文档回改；跑一次完整 `agent-e2e`（场景 1、4、5 必跑）并把结果写进状态文档。

依赖：WP2 的 `launcher` 字段。

提交计划：

1. `feat(web): 启动行经 /api/agents 的 launcher 拼——程序与前置词作启动器的参数；旧 core 退回 launchWords / launchArgs`（+ `launch.test.ts`）
2. `feat(web): 集成页去掉「信任记录写在…」，显示启动器警告与远端 Worker 待升级`（+ 页面测试 + i18n）
3. `test(probes): 场景 5 改为经启动器——画布外重跑同一行不注入、临时 CODEX_HOME 不生成 config.toml、旗标在位置参数后仍生效`
4. `docs: 画布内注入与远端注入按启动器方案回改；协作指南与架构里的 integration 布局；状态文档记实测`

验证：`pnpm --filter @armadra/web test`、`pnpm --filter @armadra/web typecheck`、`pnpm check`；`pnpm libs:build && pnpm --filter @armadra/desktop build && node tools/probes/agent-e2e.mjs --only 1,4,5`。
