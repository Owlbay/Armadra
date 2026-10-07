# 本地 CLI 插件实施与验收记录

批准基线：[Spec v1.0](../design/local-cli-plugin.md)，2026-10-03；R01–R09、D1–D5、P0–P4、A01–A16 均保留。批准 Spec 不作为实施结果改写。本记录随开发追加证据，目标仍未完成。

## 1. 当前批次

| 批次 | 状态                             | 交付与未完成项                                                                                         |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| P0   | macOS 入口通过                   | 纯 Node 客户端、独立 0600 socket、发现与实例检查、doctor；Linux 真运行仍需环境验证                     |
| P1   | 身份、图与 GUI 手动入口通过      | 授权、增量图、幂等事务、编辑租约、owner 显式任务入口；页面不持凭据，现有会话只附着                     |
| P2   | 后台闭环与对应回归通过           | 持久 run/task、DAG、controller 并发、启动/队列/Hook 完成关联、等待与精确取消                           |
| P3   | 代码与确定性故障探针通过         | 恢复、执行意图、unknown 不重放、事件保留/游标、输出分页、产物范围检查；tmux 真机条件缺失               |
| P4   | 已安装，真实宿主通过；双模型待验 | 真实 Codex 宿主已调用安装缓存完成假 Agent 依赖链；真实 Claude、隔离 Codex Hook 信任及 Linux 环境仍缺失 |

## 2. 每批验证

### P0：入口

- 先创建通道与客户端测试；首次执行因入口未实现失败。实现后 5 项通过，desktop 类型检查通过。
- `pnpm plugin:test`：构建客户端到两处临时安装目录，其中一处含空格；从仓库之外执行帮助与 JSON doctor，缺服务退出码为 3；检查 bundle 不引用 SQLite、Electron、node-pty。通过。
- `pnpm --filter @armadra/desktop build` 通过。临时数据目录真起构建后的 core，客户端 doctor 成功，1 次调用、stdout 237 字节。该结果是 macOS 真实传输验证，不是 Agent 或宿主插件验收。
- 新发现：desktop 未声明 shared workspace 依赖；补显式依赖，锁文件只新增该 workspace 链接。未升级其他依赖。

### P1：身份与图

- 先写 6 项授权、图、幂等、回滚与租约测试，首次全部失败；实现后通过。扩展同键并发、跨板引用、能力撤销及通知提交时序测试。
- 图数据、双向上下文授权、profile 对象归属、命令回执、controller 审计事件与 workspace outbox 同事务写入。`saveBoardInTransaction` 保留旧 `saveBoard` 的事务行为。提交后广播使用已持久序号，避免重复记录。
- 新增连续迁移 `0042_local_controllers.sql`，更新 lock；没有改动旧迁移或清库。
- 前端测试复现 manual 节点挂载建 shell、计时器重复输入 CLI 的旧行为（2 项失败）。修复后 2 项通过；后端手动节点创建拒绝测试通过，前端类型检查通过。
- 图保存与事件相关测试阶段共 25 项通过。后续扩展测试一次失败源于测试调用旧 `createBoard` 参数形状错误，按真实接口修正，保留所有关键断言；最终结果继续追加。
- 下一步：实现持久 run/task 和可信报告通道；复用 `launchNode`、`SendPump`、`attempt` 与 `InputSafety`。旧依赖的历史 done 判定不能用于本次任务。
- 扩展回归：17 文件，149 项通过、3 项既有平台条件跳过；新增 controller/CLI 用例全部通过。desktop 类型、客户端路径测试、仓库 7 条规则通过。
- 前端相关回归：8 项通过；前端类型检查通过。`pnpm check` 通过（shared 构建、格式、四包类型、仓库规则、CI workflow、版本一致性）。
- 真实环境预检：Codex CLI 0.159.0 可执行；当前 PATH 及 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 未发现 Claude CLI 或 tmux。继续实现不依赖它们的项目；真实 Claude 审查需可执行路径和有效登录，tmux 恢复真机需已有可用 tmux。不会自动安装 CLI 或改全局凭据。
- P0/P1 真实 core 客户端探针通过：11 次调用，命令/图输入计 1390 字节，stdout 共 2939 字节。覆盖显式选择、凭据不出 stdout、图校验、同键重放、撤销。该字节计量只含参数数组及一次图文件，非 HTTP 总传输量，也不是 token 数据。

- 四包完整回归：shared 284 项、web 2812 项、server 85 项通过；desktop 主套件 3330 项通过（21 项既有平台条件跳过），浏览器 live 套件 3 项通过，桌面脚本 42 项通过（1 项既有平台条件跳过）。日志在 `target/local-cli-evidence/`。
- 首次同时跑四包时 desktop 4 项失败：3 项时间相关用例减少并行负载后原样通过；会话搜索在 Node 22.18.0 稳定复现编号占位符绑定错误。保留既有断言，将查询改为三个普通占位符后，24 项会话用例与完整 desktop 原命令通过。未延长超时、删断言或跳过失败用例。初次失败和复验日志均保留。
- 针对 Windows 的 CI 兼容：Unix socket/0600 用例仅在支持平台定义，另在所有平台执行 Windows 通道不启用、客户端明确不支持、profile 名路径拒绝等断言。macOS 上相关 CLI/Hook 回归 104 项通过（3 项既有平台跳过）；这不算 Windows 真机验收。
- `pnpm release:test` 60 项通过；desktop 构建、客户端构建、`pnpm check` 通过。

### P2：完成判定开始

- 先建立完成判定用例，未实现时因模块缺失失败；实现后 4 项通过。拒绝旧事件游标、旧会话、旧 generation、unverified 和 observed；本次提示词 hash 与输入 revision 必须一致，失败、审批等待、输入等待分别归约。
- 这些是纯状态机测试，尚未计入假 CLI 或真实 Agent 验收。`run start/get/wait/cancel` 目前不可用。
- 现有 Hook binding 已有持久的单调 `sourceRevision`，后续可信事件日志直接复用；不重新发明 Hook 序号，也不改变旧 Hook 容错接口。现有 `InputSafety` 的输入 revision、启动器和投递队列将作为下一批接入点。

### P2：持久运行与真实 PTY 假 CLI

- 新增连续迁移 `0043_controller_runs.sql` 并更新 lock。新增 run/task、节点占用、执行意图、事件与可信报告；队列和投递历史扩展为真实 controller actor，其 `sourceNodeId` 为 null。旧 node 行保留原值，旧依赖服务只推进未归属 run 的记录。
- RunService 复用 `dependencies/launchNode`、SendPump、send/attempt、TerminalManager 和 InputSafety。冻结执行配置，投递只在依赖任务本次可信完成后入队；同键重试不重新启动，并发预算覆盖同 controller 的多个 run。
- 10 项运行接入用例通过：离线画布依赖、幂等、DAG、节点占用、全局并发、未知启动/投递、失败分支、取消、撤销、乱序报告、重放和节点删除。此处是确定性桥接模拟，不是真实模型验证。
- 真实 PTY 假 CLI 探针首次失败，状态为 `completion_unknown`。发现现有终端只注入绑定变量，却未创建 Hook 的持久序号文件。增加 16 字节 count/inverse 初始化，0600 文件/0700 目录；已有序号不重置，损坏拒绝。旧 Hook 仍保留失败容错，缺可靠绑定时 run 不写业务任务。
- 修复后 `node tools/probes/controller-run.mjs` 通过：真正的 CLI→私有 socket→core→PTY→Hook→下游链路，画布未打开。业务 CLI 调用 30 次、计量输入 3387 字节、stdout 18503 字节，Agent 启动 2 次、任务提交 2 次；清理另有一次状态查询。真实模型调用 0，宿主插件尚未安装。上述输入计量为参数数组与输入文件，非 HTTP 总流量。
- 新增实际 manager generation 取消与半截输入断言；36 项 manager 用例、10 项 run 接入、1 项序号用例通过。controller/终端/run 对应回归合计 63 项通过；此前投递/依赖/租约/画布兼容 111 项通过。前端投递回归 7 项通过。
- 外部 controller 投递不会在前端伪造来源节点或连线，只触发目标队列重读。source actor、投递记录、审计及驱动租约均保留 controller 身份。
- 单文件长度触发仓库 1500 行限制，提取只读状态和输入授权函数到 `terminal/manager-status.ts`，没有放宽规则。`pnpm check` 通过；desktop 与客户端构建通过。
- 最后一轮对应回归 10 文件、138 项通过，日志保存至 `target/local-cli-evidence/p2-tests.log`；server 类型检查与客户端打包/异 cwd 路径测试通过。P2 改动后的四包完整回归仍须在最终批次执行。
- 待完成：GUI 手动运行入口、完整取消/权限/恢复竞态、P3 恢复与产物分页、Linux 运行证据、P4 插件安装和真实双 Agent。不能据此标记目标完成。

### P3 与 GUI：恢复、产物、边界故障

- 产物、缺失、符号链接逃逸、长声明分页和持久事件 floor：4 项测试通过。≤16 MiB 文件有 SHA-256，大文件明确给 metadata 版本；读取不因文件增长无限持续。引用始终为当前文件，不是不可变历史。
- 恢复 4 项测试通过；core 等终端启动对账完成，先处理旧 run 后允许其队列推进。未知 launch/delivery 不放回队列。direct 丢失失败；已确认投递的存活 pane 无可靠断线期间输入证明时保持 connection_lost。
- owner GUI 手动任务入口已接入同一 RunService，2 项前端测试与 owner/member/伪造字段后端测试通过；节点真实 profile 由 core 查得，审计真人发起，页面不接收凭据。
- 真实 socket/PTY 假 CLI 产物链通过：29 业务 CLI 调用，输入计 3304 字节、输出 19333 字节，2 启动、2 提交、2 个存在的产物引用，真实模型调用 0。
- 杀掉本隔离探针自己的 core 后重启：8 次调用，输入 1749 字节、输出 2745 字节，session_lost、原 runId 不变、提交 1 次、重放 0。
- 精确故障入口仅在嵌入探针注入，不在 CLI/controller 暴露。launch.before / launch.after / delivery.before / delivery.after 全通过：每场景 8 次调用、输入 1749 字节；输出分别 2705 / 2742 / 2738 / 2738 字节；分别 launch_unknown / launch_write_unknown / delivery_unknown / delivery_unknown；提交分别 0 / 0 / 0 / 1，重放均 0。
- 首次精确故障探针发现迁移目录定位缺失；补测试入口 moduleDir。随后发现探针在 core 已被杀后过早重试，改为重启后按原 key/输入取回 receipt，同时保留 response unknown 的 7 退出码分支断言。未放宽业务断言或权限。
- 55 项对应 core 回归通过。`pnpm check` 与 desktop 构建通过。Linux 自动化运行环境、tmux 真机会话仍未可用，不以 macOS 同 API 路径模拟结果计真实通过。

### P4：插件构建与本地安装

- 应用 skill-creator，短 Skill 2801 字节，按需命令/失败参考；quick_validate 通过。root plugin.json 无 MCP/Hook 声明。单份纯 Node 客户端 728066 字节，组装到 target/plugins/armadra。
- 包装测试先因 manifest 未组装失败，修复复制资源后两路径（含空格）、异 cwd、资源与纯 Node 依赖检查通过。marketplace 构建按插件名合并，不覆盖其他 entries。
- 原生 Codex CLI marketplace/add 安装通过：`armadra@armadra-local` 0.1.0，缓存 `/Users/bytedance/.codex/plugins/cache/armadra-local/armadra/0.1.0`，原生 list 验证 installed/enabled 均 true。原有三 marketplace 保留，auth.json/hooks.json 与无关配置块未变化；没有公开发布。
- 从安装缓存脚本完成建图→后台依赖→进度→产物链：29 次业务调用、3304 输入字节、19333 输出字节，2 启动/2 提交。仍是确定性假 Agents；Codex 新会话自动加载 Skill/真实双模型未计通过。
- 当前四包完整回归：shared 284、web 2815、server 85、desktop 主套件 3354（21 项既有平台条件跳过）通过；desktop live 3 与脚本 42（1 项既有平台条件跳过）通过。日志在 target/local-cli-evidence/final-\*.log。
- 当前解锁条件：Claude 可执行路径及有效登录；已有 Linux 运行/CI 环境；已有 tmux 用于存活会话真机恢复；Codex 新会话的插件加载行为验证。Codex 0.159.0 登录状态为 Logged in using ChatGPT。扩展常见路径仍未发现 Claude；未自动安装 vendor CLI、复制凭据或切换模型/权限。

### 探针隔离修复

首次临时 core 探针没有设置既有 `ARMADRA_NO_GLOBAL_WRITES=1`，因此 core 启动准备在
Codex config 末尾追加了 8 个临时会话 Hook 的信任表。这违反了本次测试的隔离要求。
核查后只移除这 8 个追加表；此前配置字节保留，移除项单独存到忽略目录
`target/controller-probe-recovery/probe-session-trust-records.toml` 供核查。原有全局
Hook 文件时间仍为 2026-09-30，没有变动；未读取或复制登录凭据。
真实探针已强制禁用全局写入，并增加全局配置前后 SHA-256 一致断言。后续真实
Agent 试验必须使用隔离配置目录及运行时配置覆盖；不得通过信任提示修改真实配置。

### P4 追加：真实宿主、画布与取消竞争

- 真实 Codex CLI 新会话通过已安装 `armadra` Skill/client 完成建图、同键重试、后台依赖、查询和产物引用。内层仍是确定性假 Agents，不能计 A16。首轮宿主输出保留在 `target/local-cli-evidence/initial-host-*`；后续增加独立客户端计量，结果以 `host-result.log` 与 `host-client-trace.jsonl` 为准。
- 首轮宿主执行 17 个 command_execution 项，其中只有 2 项是调用安装客户端的脚本组；另 2 项只是检查客户端源码，先前计数 4 已校正。脚本组不等于 CLI 调用次数。首轮真实宿主 usage：input 420678、cached input 394240、output 5955、reasoning output 1621；Skill 2801 字节、宿主 prompt 1647 字节、宿主事件 61854 字节、stderr 1246 字节。没有同条件基线，不计算节省比例。
- 宿主默认只读策略实际拒绝 Unix socket（EPERM）。探针改用仅本次调用的权限 profile：`:read-only` 基线，仅临时目录可写、指定 controller socket 可连；limited network proxy 仅列保留 `.invalid` 域名。实测指定 socket 可连，回环 TCP 仍拒绝。没有全局权限修改或内层 Agent 权限改动。早期全局域名 deny 写法由本机 CLI 拒绝、network.enabled=false 也拒绝 socket；失败与成功分开记录。
- 真实 Chrome/core/PTY 画布探针通过：manual 创建后 0 会话，run 后 1 会话，关页仍 running，重挂载 1 次启动/1 次提交。47 次业务 CLI 调用、参数及输入文件 3539 字节、stdout 34565 字节；清理调用另计。截图与 JSON 在 `controller-canvas.*`。页面持租约时先断言 `lease_held`，只由这个隔离页面显式离开自己的 presence 后建图，没有夺取租约。页面 viewport 保存造成 revision 变化时重读再 run。探针初版查询了不存在的列表路由，已改用真实 workspace sessions 契约；旧失败保留在本批记录。
- 原生取消探针通过：15 次 CLI 调用、2684 输入字节、6459 stdout 字节；本 run cancelled，另一条 run 仍 running，提交共 2 次，重放 0。取消回执与终态不同步时通过有限 get/wait 核对，没有将 cancelling 当作成功。新增 5 项竞争/等待测试，run service 合计 15 项通过，包括 ACK 在取消后返回、可信完成先落库、deadline 原因保留、等待者撤销/断开。
- 2 MiB 原始 PTY 输出探针通过：32 次 CLI 调用、3587 输入字节、24279 stdout 字节，正常完成与两份产物；摘要不超过 8 KiB、details 不超过 32 KiB，无原始日志正文。fixture 在 stdout 写完成后才报告 Stop；`terminalOutputBytes=2097152` 为测试程序写入字节，CLI stdout 为独立计量。
- Linux/macOS CI 新增真实 Unix controller/socket/PTY、取消、大日志、core 崩溃和四个精确边界探针；Windows 保留明确不支持和纯 Node 插件路径检查。workflow 验证先因缺步骤失败，接入后 15 项通过。该工作流尚未在 Linux runner 执行，本机 macOS 结果不替代 Linux 证据。
- Codex 0.159 的零模型 `app-server hooks/list` 探针证明 `-c hooks.state` 不能赋予会话 Hook 信任，结果为 untrusted。没有因此添加绕过 Hook 信任参数、修改真实全局 trust 或复制凭据。真实内层 Codex 需要已有独立登录的隔离 CODEX_HOME 与该临时 core 的可信 Hook；Claude CLI、tmux、Linux 运行条件仍缺失。代码与虚拟进程验证继续完成，真实双 Agent 不宣称通过。
- 宿主计量复跑达到 180 秒保护时限后被终止，原探针退出非零，不能记完整通过。其事件证据已显示同键图/run 重试、run completed、两份存在的产物和 host-proof.json 写入完成，但没有 turn.completed 的 usage 或最终宿主回复。首轮成功证据继续作为已完成宿主验收；本轮结果不是其替代。补充失败也保存 trace/result 的逻辑，未通过增加超时或放宽权限消除失败。
- 产物竞态复查新增测试先稳定失败：stat 校验后、open 前替换文件会读取替换内容。修复为 O_NOFOLLOW 加 descriptor dev/ino 核对，读任何字节前拒绝 artifact_changed；另外验证即时符号链接替换。已有文件变动仍为 changedDuringCheck，输出范围与限制不放宽。
- 第二次计量复跑在 180 秒保护时限内只完成 20 次客户端调用（参数 3714 字节、输入文件 0 字节、stdout 9966 字节；本次使用 stdin，未计量 stdin 正文）。宿主生成的代码按 4 个事件页停止，而这些事件页立即返回，并非已经等待了 4 个超时周期；run 当时仍 running。这次没有产物验收或宿主 usage，不计通过。Skill 与参考文档补充按经过时间限制观察，探针保留 180 秒总保护及原成功断言。
- 本批最终四包完整回归：shared 284、web 2815、server 85、desktop 主套件 3364（21 项既有平台条件跳过）通过，live 3、脚本 42（1 项既有跳过）通过。`pnpm libs:build`、desktop 构建、`pnpm check`、release/test/workflow 合计 61、plugin:test 与 Skill validator 均通过。产物查询 9 项回归包括大小文件替换、父目录 symlink/junction 替换、Unix 文件 symlink、16 MiB 以上不读内容。
- 新构建完整故障探针通过，原生安装缓存依赖闭环仍为 29 次 CLI 调用/3304 参数与输入文件字节/19333 stdout 字节、2 启动/2 提交。取消、core 丢失、四个精确边界均 0 重放；大日志最终复验为 30 次 CLI 调用/3434 输入字节/22240 stdout 字节和 2097152 PTY 写入字节。每次有限等待返回事件的数量会影响查询调用数，故保存每轮实际值，不将不同轮次计量混合。
- 等待指导修复后的真实宿主计量探针完整通过，退出 0，原成功断言全部保留。最新已安装 Skill 2989 字节、宿主 prompt 2829 字节、宿主事件 23349 字节、stderr 1112 字节；6 个 command_execution 项内实际 40 次安装客户端调用，参数 7578 字节、输入文件 0（使用 stdin，正文未计量）、stdout 25941 字节。usage：input 252423、cached input 214144、output 7710、reasoning output 2673、cache write 0。run completed，两份存在产物，2 启动/2 提交，图与 run 重放仍返回原结果，全局配置/Hook/凭据摘要不变。内层仍是假 Agents，realDualAgent:false。不同 prompt/上下文/观测策略下的宿主轮次不能用于计算节省比例。
- 最新证据：`host-result.log`、`host-client-trace.jsonl`、`host-attempt-result.json`、`host-codex-events.jsonl`；此前失败在 `timed-out-*` 与 `event-count-*`，首轮成功在 `initial-*`。所有文件在忽略的 `target/local-cli-evidence`，没有提交或公开发布。真实 CLI 条件持续缺失多个目标轮次，独立开发与回归已完成；目标应保持未完成，待这些条件解锁。

## 3. 验收矩阵

“部分”只代表已有对应证据，不计完整通过。

| 验收 | 当前证据                                                                | 状态                                                        |
| ---- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| A01  | 无服务/残留、实例与版本失配、Origin 拒绝、真实 0600 socket              | macOS 通过；Linux runner 待执行                             |
| A02  | 无身份、跨 workspace、伪造字段、撤销 profile/read/wait、后台停止推进    | 自动化通过                                                  |
| A03  | 两 Agent/上下文线原子提交、非法引用零写入                               | 自动化及真实 socket 通过                                    |
| A04  | manual 0 shell；真实 Chrome 页面先开/重挂载仅附着 1 会话                | macOS 真画布与假 CLI 通过                                   |
| A05  | 图与 run 同键原结果、异请求冲突、CAS、租约、事务回滚                    | 自动化及宿主假 Agent 链通过                                 |
| A06  | 页面未挂载，根任务可信完成后下游启动，2 启动/2 提交                     | 真 core/PTY 假 CLI 通过；真双 Agent 归 A16                  |
| A07  | 旧 done、旧 session/generation、observed、乱序与未归属事件拒绝          | 自动化通过                                                  |
| A08  | agent_error/interrupted、审批/输入等待、删除节点、分支跳过              | 确定性状态机与桥接通过                                      |
| A09  | 并发 start 原 run、node lock、跨 run 并发预算/未知占用                  | 自动化通过                                                  |
| A10  | response unknown 原 receipt、四个 launch/delivery 精确 SIGKILL、不重放  | direct 故障通过；tmux 真机恢复待环境                        |
| A11  | CLI 一次退出后后台继续、真画布关闭仍 running、有限 wait/abort           | macOS 真通道/画布与假 CLI 通过                              |
| A12  | 投递 ACK 与取消竞争、可信完成竞争、重复 key、另一个 run 存活            | 自动化及真 PTY 假 CLI 通过                                  |
| A13  | 2 MiB 原始日志、8/32 KiB 限额、分页、expired/ahead cursor、symlink 范围 | 自动化及大日志真 PTY 通过                                   |
| A14  | 两安装路径（含空格）、异 cwd、原生 marketplace/cache、真 Codex 宿主调用 | 本机插件与宿主通过；内层是假 CLI                            |
| A15  | shared/web/server/desktop/live/scripts、构建、check/release/workflow    | 本批完整回归与重新构建后的故障探针通过                      |
| A16  | 真 Codex→真 Claude 实现/审查                                            | 未完成：Claude CLI/login、隔离 Codex 登录及 Hook trust 缺失 |

没有修改用户正在使用的 Armadra 数据库或登录凭据，也没有复制或解析凭据；为检查隔离边界，对配置和凭据文件计算完整性摘要。全局配置的探针隔离遗漏与修复见上；不能将其记作从未发生。业务测试使用临时数据库和目录。没有提交、推送或公开发布。

## 4. 计量

P0 doctor：CLI 调用 1 次，输出 237 字节。安装路径测试每处 2 次客户端调用（帮助、缺服务 doctor），两处共 4 次；构建调用独立计数。宿主 Skill/事件/usage 计量见 P4 追加；真实双 Agent 输入输出尚无结果。参数与输入文件计量均非 HTTP 总传输量。没有 MCP 同条件基线，不报告 token 节省比例。

2026-10-03，宿主 goal 工具在本批结束前报告累计 `tokensUsed: 450641`、
`timeUsedSeconds: 3019`，目标状态为 `active`。这是整个目标的累计值，包含开发、
阅读和验证，不能当作双节点任务实验的 token 用量；双 Agent 实验尚未开始。

## 5. 当前阻塞与解锁条件

独立开发、macOS 自动化、安装及真实宿主假 Agent 链已完成。以下环境条件已在多个
目标轮次重复缺失，上轮目标进入 blocked，不能记 complete。本轮已恢复为 active，
补充真实验收入口后继续按相同条件核查：

- A16：已有可执行、有效登录的 Claude CLI；以及已经独立登录的隔离 CODEX_HOME，
  允许给本测试 core 的 Hook 写入信任记录。不得以复制真实凭据、修改真实全局
  Hook/trust、绕过 CLI 权限或模拟审查来解锁。
- A01/Linux：可运行当前工作目录版本的 Linux 环境，或将同一改动在已配置的 Linux
  CI runner 执行并取得结果。工作流已接入不等于实际通过；本任务不自动提交、推送。
- A10/tmux：已有可用 tmux，以验证真实存活会话恢复、原 generation 附着和未知
  输入不重放。当前 direct 的真实 core 崩溃验证和模拟 tmux 绑定测试已通过。

预检在 `target/local-cli-evidence/real-preflight.json`：本机为 darwin，Codex 使用
ChatGPT 登录，Claude/tmux 及 docker/podman/lima/colima 均未发现；未提供隔离已登录
Codex 目录。条件解锁后继续 A16、Linux 与 tmux 验收，保留当前代码和全部失败证据。

## 6. 恢复后的真实验收准备

- 本轮分类：progress。新增真实 `controller-real.mjs`，对已运行隔离 core、明确
  workspace/board、安装缓存及真实 CLI 做前置检查；不启动 core，不改任何 Hook/
  权限/凭据配置，不安装 CLI，不创建 workspace。
- 前置检查和质量门先因模块/接口缺失失败，实现后 12 项通过：生产 home 重叠、
  目录别名、配置/凭据链接逃逸、fake CLI 版本、项目层信任冲突与路径别名、固定测试被改、
  实际测试失败、审查问题、报告路径/版本与输出界限、预检零业务调用及上下文清理。
- 使用本机 Codex 0.159 的 native schema 与 config/read 确認项目配置层形状；临时
  空配置 home 中查询 trusted 项目成功，没有创建模型任务。证据在 real-config-read.json。
- 当前实际 `--preflight` 输出 blocked：Claude CLI 仍缺，未提供隔离 home 和实际
  临时 core/目标 IDs；CLI 业务调用 0、真实任务 0、配置完整性摘要不变。已继续
  查找 nvm/npm 缓存/volta/asdf/bun 等已有路径，无 Claude 或 tmux。Linux 运行条件未变。
- 执行入口保留 run/checkpoint、graph/run 原输入与稳定 key，未知变更不自动重试；
  run completed 后另查当前产物、固定测试 hash、Node 测试与 Claude review verdict。
  真模型分支因环境不足尚未运行，不能以 12 项检查或 config/read 计 A16 通过。
- 用法在使用指南的“真实双 Agent 验收入口”。本批没有改动 core/CLI/已安装插件内容，
  沿用已通过的四包与故障探针结果；新增入口的测试、workflow 和 pnpm check 另行记录。

- 路径别名扩展先暴露 canonical project 与未存在 cwd 尾部不一致，保留原 trust/
  untrusted/冲突断言，对现存父目录做统一规范化后 12 项全部通过。新增测试已接入
  三平台 CI；本机 pnpm check 与 release:test（61 项）通过。A16 真任务仍未运行。

## 7. 恢复后阻塞审计

恢复后的三个连续目标轮次均未获得真实 Claude、隔离已登录 Codex 配置、Linux 或
tmux 环境。第一轮完成真实验收入口与检查，第二轮无进展，仅复核条件；第三轮
再次实测相同缺失，预检仍为 blocked，业务调用/真实任务均 0，配置摘要未变化。
证据在 resumed-block-audit-2.json、resumed-block-audit-3.json 与
real-acceptance-preflight.json。独立工作已完成，本轮将目标重新标为 blocked，
保留完整原目标，未标 complete。解锁条件继续按 §5，实际命令见使用指南。

2026-10-05 再次恢复后，连续三轮重新核查相同条件：Claude/tmux/Linux 环境仍未发现，
没有提供隔离 Codex 配置。Codex 仍为 0.159.0，插件缓存资源存在，工作树仍在原
基线且改动未提交；无法用旧基线 CI 结果验证当前未提交改动。实际预检仍 blocked，
业务调用/真实任务为 0，配置摘要不变。证据为 oct05-resumed-audit-2.json、
oct05-resumed-audit-3.json 和 real-acceptance-preflight.json。本次恢复没有独立必要
工作可推进，重新将目标标为 blocked；A16/Linux/tmux 均未完成，完整目标未缩减。

2026-10-06 恢复后的三轮核查仍为同一环境阻塞。真实 Claude、隔离 Codex 配置、
Linux/tmux 均未解锁，真实预检业务调用/任务为 0；本轮重新标 blocked，未标 complete。
证据在 oct06-resumed-audit-2.json、oct06-resumed-audit-3.json 及
real-acceptance-preflight.json。没有修改业务实现、凭据或权限，没有重复已通过回归。

## 上游合并（2026-10-07）

- 拉取 `origin/main` 至 `596c5ca7`（0.2.1），合并本地 CLI 插件实现。保留已发布 0001–0041 迁移及其锁定字节，本地未发布迁移顺延为 0042、0043；队列扩展保留 0029 引入的 `settled_by`、`notified_at`。旧测试临时数据目录的迁移账本与新版不同，保留旧目录，不自动迁移、清库或改写账本。
- 上游契约 §1–43 保留，本地私有 controller、run、产物契约追加为 §44–46。投递 REST/RPC 接受 controller 的 null 来源并保留 run/task 身份，新增传输一致性与旧队列回执迁移测试。
- 普通租约画布仍支持原子建图；实时 Yjs 画布返回 `realtime_active`，SQL 图修改不会绕过实时文档。实时画布的原子外部编辑需要另行实现跨文档事务，不以直接写表代替。
- 本次合并后的验证结果在完成后追加；此前的验收数据仅对应合并前版本，真实双 Agent、Linux、tmux 的待验收状态保持。

合并验证过程中发现并修复两项兼容问题：新的响应式对话框约定要求手动启动入口使用 `ResponsiveDialog`；PTY 假 CLI 必须呈现输入提示符才能通过新增画面门。保留原来的回执、状态、投递次数和恢复断言，未跳过失败用例，也未降低生产输入门。
