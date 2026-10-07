# 本地 CLI 插件使用

本插件面向可执行本机 Node 命令的 Codex。需要 Node.js ≥22、已运行的 Armadra core、
已有本机 workspace，以及已安装并登录的目标 Agent CLI。v1 使用 macOS/Linux Unix
socket；Windows 明确不支持。当前真实验收状态见[实施与验收](../status/local-cli-plugin.md)。

## 构建与本地安装

```sh
pnpm libs:build
pnpm plugin:build
pnpm plugin:test
node tools/plugins/install-armadra.mjs            # 查看安装计划
node tools/plugins/install-armadra.mjs --install  # 原生 CLI 合并 marketplace 与插件配置
```

产物在 `target/plugins/armadra`，marketplace 根为 `target/plugins`。安装器验证全部资源，
调用 `codex plugin marketplace add` 和 `codex plugin add`，检查 auth.json、hooks.json 和
无关配置块不变。它不发布、不安装 vendor CLI，不替用户登录。其他插件和 marketplace
保留。原生安装的实际缓存路径以安装输出为准，不把 source 目录当作已安装目录。

本机安装记录：`/Users/bytedance/.codex/plugins/cache/armadra-local/armadra/0.1.0`。
真实 Codex CLI 新会话已经通过 `$armadra` 调用这个安装缓存的 Skill 和客户端完成
假 Agent 依赖链；真实双 Agent 验收仍未完成。普通云端 ChatGPT 不能由此获得本机命令能力。

## 显式选择与建图

下列 `CLIENT` 是安装输出路径下的 `scripts/armadra.cjs`，用绝对路径替换。core 使用
既有启动方式，不由插件自动启动。

```text
node CLIENT doctor --json --data-dir DATA_DIRECTORY
node CLIENT workspaces list --json --data-dir DATA_DIRECTORY
node CLIENT connect --workspace WORKSPACE_UUID --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT boards list --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT board get --board BOARD_UUID --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT graph validate --board BOARD_UUID --file graph.json --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT graph apply --board BOARD_UUID --file graph.json --key graph-1 --profile demo --json --data-dir DATA_DIRECTORY
```

graph.json 使用 schemaVersion 1、当前 expectedUpdatedAt 和增量 operations。
创建的 terminal 强制 manual；不会启动 shell。上下文线是 `createContextLink`，
执行依赖写在后续 run 的 `after` 中。不要通过完整文档覆盖未提及的节点。

完整输入说明在插件安装目录的 `skills/armadra/references/commands.md`。
隔离验证可设 `ARMADRA_CONTROLLER_PROFILES_DIR` 为临时可写目录，并在每次客户端
调用中保留。`--data-dir` 只选择 core，不改变 profile 保存目录，也不授予宿主 socket
访问权。正常 profile 默认在 `~/.config/armadra/controller-profiles`。
graph.apply 返回本批 key→UUID 映射和新 revision。写入使用稳定幂等 key，重试保持
原输入；冲突或未知结果先核对原命令，不重发业务任务。

## 后台运行与结果

```text
node CLIENT run start --board BOARD_UUID --file run.json --key run-1 --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT run get --run RUN_UUID --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT run wait --run RUN_UUID --cursor EVENT_CURSOR --timeout 30 --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT run artifacts --run RUN_UUID --cursor 0 --profile demo --json --data-dir DATA_DIRECTORY
node CLIENT run cancel --run RUN_UUID --key cancel-1 --profile demo --json --data-dir DATA_DIRECTORY
```

run.json 冻结任务节点、prompt、DAG、声明输出、并发和 deadline。只有本 profile 管理的
manual Agent 节点参与，工作空间必须允许 execute。根任务由 core 启动，下游在上游
本次可信回合完成后才启动和排队；页面开没开都一样。默认并发 2、最多 4，覆盖同一
controller 的多个 run。Agent 已在工作或节点被占用时拒绝，不另起 PTY。

owner 在 manual 节点头点击“运行任务”，输入明确任务并提交，走同一个 core 服务。
界面不拿 controller 凭据，core 按节点真实归属委托 profile，并记录真人发起者；成员
不能以请求体 owner/controllerId 字段取得这项能力。已启动会话仅附着。

查询默认最多 8 KiB。`run get --cursor OFFSET` 分页任务，`run artifacts --cursor OFFSET`
分页引用；使用 nextCursor。wait 是事件游标，不能与任务/产物 offset 混用。最多 50
事件，`--details` 扩大到不超过 32 KiB；snapshotRequired 要求重取 run get。

产物引用是当前文件，不是历史快照；缺失如实返回。≤16 MiB 文件返回内容 SHA-256，
更大文件仅返回明确标注的元数据版本，读取期间变动也明确标注。解析后的路径必须
留在冻结的 workspace 中，符号链接逃逸拒绝。文件存在不证明任务成功。

## 阻塞与恢复

blocked 提供具体原因。等待审批/输入时由用户处理，插件不代答。unknown 启动或投递
不能盲重试；请求响应丢失可用同 key 同输入取回原结果。取消在 manager 串行门内核对
本次 session/generation，不以进程名杀程序。

重启先对账持久意图和实际会话。direct 丢失标失败/未知；tmux 存活按原绑定附着，
从未写入的 queued 任务可以继续。断线期间已运行回合无法排除其他输入时保持
connection_lost，不宣称完成。没有强行完成接口。completed 仅证明 Agent 回合正常
结束，代码质量由报告和实际测试另行判断。

## 可复现验证

```sh
pnpm --filter @armadra/desktop build
pnpm plugin:build
node tools/probes/controller-smoke.mjs
node tools/probes/controller-run.mjs
node tools/probes/controller-run.mjs --cancel
node tools/probes/controller-run.mjs --large-output
node tools/probes/controller-run.mjs --crash
node tools/probes/build-controller-fault.mjs
node tools/probes/controller-run.mjs --fault=launch.before
node tools/probes/controller-run.mjs --fault=launch.after
node tools/probes/controller-run.mjs --fault=delivery.before
node tools/probes/controller-run.mjs --fault=delivery.after
node tools/probes/controller-canvas.mjs
node tools/probes/controller-host.mjs ABSOLUTE_INSTALLED_PLUGIN_DIRECTORY
```

这些使用临时数据库、隔离 workspace 和真实 PTY 中的确定性假 CLI，不是模型验收。
`--client=ABSOLUTE_INSTALLED_SCRIPT` 可从安装缓存验证客户端调用链。真实 Codex→Claude
验收不能以这些结果替代。canvas 探针需要已有 Chrome（可用 CHROME_PATH 指定），
实际打开应用页面；host 探针需要已登录的 Codex，实际调用已安装插件，内层仍是假
Agents。host 仅为本次 exec 定义 `:read-only` 基线的权限 profile：临时目录可写、
指定 Unix socket 可连、limited network proxy 的域名表仅含保留 `.invalid` 域名。
默认只读策略或 network.enabled=false 实际会拒绝 socket。该设置不修改全局权限
或内层 CLI 的权限；具体键遵循[官方权限配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
宿主客户端调用次数与 stdout 字节在 host-client-trace.jsonl 中计量；usage 是宿主
实际报告，不包括假 Agents 的模型用量。没有同条件 MCP 基线，不报告 token 节省比例。

真实内层 Codex 的 Hook 信任只读取配置文件；本机 0.159 实测 `-c hooks.state` 仍为
untrusted。真实验证需要已经独立登录的隔离 CODEX_HOME 和该临时 core 的可信 Hook，
不能复制真实凭据、修改真实全局 Hook/trust 或通过绕过信任参数完成测试。真实
Claude 审查需要已有 CLI 和有效登录。Linux CI 已配置 Unix 探针，但未执行前不计通过。

## 真实双 Agent 验收入口

`controller-real.mjs` 面向**已运行的隔离 core**，使用安装缓存客户端，不启动 core、
不安装或登录 CLI、不写 Hook 信任或权限配置。core 的 data-dir 必须在系统临时目录，
选择的已有 workspace 必须在该 data-dir 中，首次验收要求工作目录未使用（可已有空
Git 仓库）。已有独立登录的 Codex home 不能与生产 home 重叠，配置或凭据符号链接
也不能指向目录外。Claude 的登录在真实任务执行中验证，版本检测不能证明登录。

启动隔离 core 时保留 `ARMADRA_NO_GLOBAL_WRITES=1`，并让其使用已准备好的隔离
Codex home。该 home 必须已有本次 core Hook 的信任记录，且目标工作目录已由用户
信任。探针只通过 native `config/read` 查询项目层，不代答信任或工具审批。core 的
integration 元数据必须表明实际使用的就是该隔离配置路径。

```sh
pnpm controller:real:test
pnpm controller:real:preflight
node tools/probes/controller-real.mjs --preflight \
  --data-dir /absolute/temporary/core-data \
  --codex-home /absolute/isolated/logged-in/codex-home \
  --workspace WORKSPACE_UUID --board BOARD_UUID
node tools/probes/controller-real.mjs --execute \
  --data-dir /absolute/temporary/core-data \
  --codex-home /absolute/isolated/logged-in/codex-home \
  --workspace WORKSPACE_UUID --board BOARD_UUID
```

可用 `--plugin-root ABSOLUTE_INSTALLED_PLUGIN_DIRECTORY` 指定其他已安装缓存。
两种模式不能混用。预检成功仅表示前置条件满足，不代表 A16 通过；条件不足时输出
blocked 和具体原因，模型任务数为 0。执行模式创建故意失败的 slug 实现及固定测试，
显式建两节点/上下文线、重复同键图/run 验证幂等，由 core 启动 Codex 实现及 Claude
审查。最多观察 10 分钟；未完成/审批等待/未知投递时保留原运行，不自动重发。

run completed 后还要检查三份当前产物、固定测试字节未变、真实 Node 测试通过和
Claude 的 reviewedFiles/无问题 verdict。读取报告限 64 KiB，并校验 core 提供的内容
版本与路径。checkpoint、原始输入及质量日志保留在隔离 data-dir 的 real-acceptance；
已有 runId 的重启只查询原运行，没有 runId 的未知变更需先人工按原 key/input 对账。
脚本不清理用户提供的数据目录、取消审批或宣称代码质量来自 completed。

本机目前只有前置/质量检查自动化及无模型 config/read 验证通过；A16 尚未执行。
