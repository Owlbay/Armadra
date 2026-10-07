# Armadra 本地 CLI 插件：Spec 与技术方案

> 状态：**目标设计 / 用户已确认，尚未实施**。
> 批准版本：v1.0；批准日期：2026-10-03；源码核对基线：`3e5bc78b`。
> 用户已确认本方案并要求生成完整 goal 命令。本轮仅更新批准记录并交付命令文本；实际开发由用户提交该命令后开始，不在生成命令时激活 goal、安装插件或启动真实 Agent。

## 1. 目标与使用边界

让用户在具备本地命令执行能力的 Codex 中使用 Armadra 插件，以自然语言创建画布节点、建立上下文关系、安排执行依赖、运行 CLI Agent，并查询进度和产出。

首版推荐采用 **CLI + Skill**。插件分发工作流说明与 CLI 客户端；Armadra core 继续是画布、终端和业务写入的唯一执行者。

目标体验：

> “在这个项目的画布中创建 Codex 实现节点与 Claude 审查节点。先实现，再让 Claude 读取实现结果并审查。告诉我运行状态和报告位置。”

预期结果：

1. 插件识别目标工作空间和画布，校验本机 core 与所需 CLI。
2. 一次提交建立节点和上下文连线，画布打开时能看到结果。
3. 显式启动运行；即使画布页面未挂载也能执行。
4. 上游这一轮正常结束后，下游才收到本次运行的任务。
5. Codex 可以有限等待、查询状态、读取有限长度的结果和取消运行。
6. 命令重试不重复创建节点，不重复投递同一条任务。

**宿主前提必须明确：**首版针对本机 Codex（桌面端中的 Codex 或 Codex CLI）。能安装 Skill 的普通 ChatGPT 对话不一定能执行本机命令，不能因此承诺所有 ChatGPT 模式可用。普通云端 ChatGPT、远程调用和内嵌画布属于后续 MCP 适配范围。

## 2. 开发流程与确认门

| 阶段            | 本阶段交付                                    | 进入下一阶段的条件                             |
| --------------- | --------------------------------------------- | ---------------------------------------------- |
| S0 调研         | 官方接入依据、源码现状、方案取舍              | 已完成，见 §3、§15                             |
| S1 Spec         | 本文：范围、接口、状态机、实施批次与验收      | 已于 2026-10-03 确认 §14 决策，进入 S2         |
| S2 实施任务定义 | 基于批准版本生成一条完整 goal 命令            | 命令包含 Spec 路径、范围、阶段、检查与完成条件 |
| S3 实施         | 按 §12 顺序开发，每批先验证关键风险再扩大范围 | 不擅自把后续规划算入本次交付                   |
| S4 验收         | 真实调用链、故障测试、构建与安装证据          | §11 验收矩阵通过；外部条件不足的项如实标注     |

本文里的 CLI、接口、目录和类型若标为“拟新增”，均是设计，不代表现在可执行。用户确认前，不能把本文写成已实施状态，也不改写架构现状文档。

## 3. 现状与差距

### 3.1 可复用能力

| 现有能力                   | 源码依据                                         | 本方案如何复用                                        |
| -------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| 节点、边、画布数据模型     | `packages/shared/src/domain/`                    | 复用类型和校验，补最小必要字段                        |
| 画布文档保存、乐观并发检查 | `core/canvas/documents.ts`                       | 所有图修改仍经 core，保持原有文档语义                 |
| 建 Agent、连线、组队等动词 | `core/collab/control/`                           | 提取可共享业务服务，保留原有 CLI 兼容                 |
| Hook 客户端                | `src/cli/armadra-hook/`                          | 保留画布内部命令、注入及回调，不改变 Hook 容错语义    |
| 依赖判定与后台启动         | `core/dependencies/{evaluate,service,launch}.ts` | 复用判定、启动及恢复机制，增加运行关联                |
| 任务投递与输入安全门       | `core/collab/send-queue.ts`、`send-pump.ts`      | 复用同一条队列、容量限制、驱动租约和半截输入保护      |
| 事件与断线补读             | `core/events/`                                   | 复用广播；运行的权威状态另外持久化                    |
| 本机实例发现               | `core/endpoints.ts`                              | 不硬编码端口，核对实例而非只看文件存在                |
| 私有本机通道               | `core/identity/control.ts`                       | 参考 Unix socket 的权限及生命周期，不复用全权桌面票据 |

上表中 `core/` 指 `apps/desktop/src/core/`，`src/cli/` 指 `apps/desktop/src/cli/`。

### 3.2 不能直接包装现有命令的原因

- `collab/control/index.ts` 的写操作要求 `Caller.verdict === "verified"`，且调用者绑定真实画布节点。外部 Codex 不能靠设置 `ARMADRA_NODE_ID` 或读取别的节点 token 获得同等身份。
- `send-queue.ts`、依赖启动记录与来源链以 `sourceNodeId` 为中心。外部控制者必须有真实的 actor 表达，不能把它的 ID 塞进节点 ID 字段。
- 普通前端创建的 Agent 会经 `use-session.ts`、`use-launch.ts` 启动；依赖服务已有后台启动能力。新插件必须统一“创建”和“启动”，避免页面打开与后台调度各启动一次。
- `saveBoard()` 自己管理 `BEGIN IMMEDIATE`。新增批量事务不能直接在外层再开事务；需要提取事务内写入函数或显式的事务组合接口。
- 当前连线 `kind = link`、`role = peer / supervises` 表达上下文和角色，不等于执行先后。节点显示为 `done` 也不等于测试通过或成果已经验收。
- 现有 workspace outbox 有保留窗口。运行历史不能只靠短期事件补读还原。
- 尚无外部控制 CLI、插件包、运行级幂等记录和统一运行查询契约。

## 4. 范围与需求

### 4.1 首版范围

| 编号 | 需求                                                                     |
| ---- | ------------------------------------------------------------------------ |
| R01  | 通过本机 CLI 发现 core，列出已有工作空间和画布；选择目标必须使用明确 ID  |
| R02  | 批量增加节点、修改自身创建节点的展示属性、增加或移除明确指定的上下文连线 |
| R03  | 图编辑与进程启动分离；创建图不会自动执行 CLI                             |
| R04  | 运行一组 Agent 任务，支持并行根任务与有向无环依赖；不依赖画布页面        |
| R05  | 运行请求可重试，重复提交返回同一结果；未知投递结果不自动重放             |
| R06  | 查询运行、有限等待事件、取消运行；默认只返回摘要和产物引用               |
| R07  | 启动失败、权限等待、无可靠完成信号、core 重启、节点删除均有明确状态      |
| R08  | 可本地安装的插件包，含简短 Skill、按需参考和可定位的 CLI 客户端          |
| R09  | 既有画布内 Hook、终端、连线、调度与服务器壳行为保持兼容                  |

首版验收平台为 **macOS 本机**。代码保持 Node/TypeScript 可移植，Linux 用自动化测试验证 Unix socket 路径，不提前声称 Linux 桌面真机验收。Windows 暂返回明确的不支持错误，不通过无 ACL 的管道或无认证 TCP 兜底。

首版闭环以 **Codex 与 Claude** 两种真实 CLI 验收；其他注册 Agent 可列出能力，但没有可信完成事件的适配器不得参与自动依赖运行。可用性同时取决于本机安装、登录和 CLI 能力探测。

支持创建的节点：Agent 终端、便签、分组、编辑器、Diff、文件树和浏览器。后三类展示仍复用已有节点能力；浏览器节点只记录 URL，创建图时不导航、不起浏览器进程。自动化和 Agent 活动卡片继续由现有领域管理。

### 4.2 明确后置

- 普通云端 ChatGPT 接入、MCP 服务、隧道、OAuth、公开插件目录发布。
- 在 ChatGPT 中内嵌完整画布、终端或 Electron 浏览器。
- 上游完成后自动刷新文件、报告、浏览器的“更新连线”；它是独立能力，可消费本方案的运行完成与成果引用，另写专项 Spec。
- 工作流模板市场、自动模型路由、成本优化协调器、多账号、多人实时编辑。
- 远端执行主机、自动创建 worktree、创建工作空间、任意 Shell 执行接口。
- 删除用户已有节点、自动合并分支、推送或发布、自动批准 Agent 权限请求。

CLI 允许在已经选择好的工作空间运行 Agent；该目录可以本身就是用户已有的 worktree。上下文共享不会把两个不同目录里的代码改动自动同步，审查任务的输入路径必须明确。

## 5. 架构决策

### 5.1 方案

```text
本机 Codex
  └─ Armadra Skill：按需加载用法、准备批量输入、解释结果
       └─ armadra CLI：参数校验、文件输入、JSON 输出、有限等待
            └─ 本机私有 controller socket
                 └─ core/controller：连接身份、范围检查、命令分发
                      ├─ canvas 领域：保存节点、连线、上下文授权文档
                      └─ core/runs：持久化运行、任务与执行意图
                           ├─ dependencies：等待、完成判定与调度
                           ├─ terminal：启动与附着
                           └─ collab：任务投递与驱动门

core 事件 → 现有 apps/web 画布同步
core 运行快照 → CLI → Codex
```

CLI 不打开 SQLite，不启动第二份 core，不通过模拟鼠标拖线操作界面。插件不安装 Claude/Codex、不复制登录凭据、不改各 CLI 的全局配置。

### 5.2 取舍记录

| 决策         | 选择                                        | 理由                                           |
| ------------ | ------------------------------------------- | ---------------------------------------------- |
| 接入方式     | CLI + Skill                                 | 目标宿主能执行本机命令；减少首版网络与部署依赖 |
| CLI 入口     | 新增 `armadra`，保留 `armadra-hook`         | 外部控制与 Hook 回调身份、失败语义不同         |
| 本机传输     | 独立 Unix socket                            | 复用同用户私有通道模式，不开放公网入口         |
| 运行生命周期 | core 持有                                   | 关闭聊天或画布不取消已启动工作                 |
| 图与任务关系 | `contextLinks` 与 `dependencies` 分开       | 上下文可双向读取，执行依赖必须有向无环         |
| 幂等与恢复   | 数据库记录命令、运行及副作用意图            | 单靠内存锁无法覆盖 core 崩溃和客户端超时       |
| 插件格式     | root `plugin.json` + `skills/` + 客户端脚本 | 采用当前官方推荐格式，本地市场安装验证         |

MCP 并非天然更耗 token。本方案的节省来自按需说明、批量操作和有限输出，不承诺未经测量的节省百分比；后续 MCP 适配应复用同一业务服务。

## 6. 本机身份与连接

以下名称与路径均为拟新增。

1. core 在自身数据目录下提供 `controller.sock`，目录权限 `0700`、socket `0600`。仅接受本地 socket 请求；拒绝浏览器 `Origin` 请求，不提供 TCP fallback。
2. 客户端通过现有数据目录规则或显式 `--data-dir` 找到实例。`doctor` 比对 core `instanceId`、协议版本与能力；文件残留、版本过新、实例不匹配都返回具体错误。
3. `armadra connect --workspace <id>` 请求一个绑定该工作空间的 controller profile；连接记录含 `controllerId`、能力范围、创建与撤销时间。
4. 凭据由客户端在用户私有目录保存，权限 `0600`，数据库仅存摘要；stdout 只返回 profile 名和 scope，不返回凭据。`disconnect` 撤销 profile。
5. CLI 的后续请求显式携带 profile 身份。controller listener 的每个方法都独立校验，不走“没有身份则为 owner”的默认分支。
6. actor 采用区分联合：现有 `node` actor 保持原语义；新增 `controller` actor 携带绑定 workspace 和权限。审计保留 actor 类型，不伪造节点、不取用桌面全权票据。

默认授予：选定工作空间的画布读取、受限图修改、创建及驱动插件管理的 Agent、运行查询和取消。没有全局设置、凭据读取、审批代答或其他 workspace 权限。

`doctor`、`workspaces list` 和初次 `connect` 是私有 socket 上的引导方法，只依赖同一操作系统用户的通道访问权；工作空间列表只返回 ID、名称和根目录等定位信息。其他方法必须有有效 profile。此例外不出现在公网 HTTP 路由上。

**信任边界：**同一操作系统用户可访问该私有通道，本方案不隔离该用户下的恶意进程。profile 的范围用于避免误操作和保留审计，不宣称抵御同用户进程重新连接。请求体中的“已授权”“owner”字段均不能改变实际权限。

撤销 profile 后，排队任务不得继续启动或投递；运行中的任务转为 `blocked`，原因 `authorization_revoked`。已交给 CLI 的工作不能靠撤销网络凭据回滚；用户仍可在 Armadra 内中断它。插件不自动替用户答权限审批。

## 7. CLI 与图操作契约

### 7.1 命令面

以下为**拟新增命令**，当前不可直接使用：

```text
armadra doctor --json
armadra workspaces list --json
armadra connect --workspace <id> --json
armadra disconnect --profile <name> --json
armadra boards list --profile <name> --json
armadra board get --board <id> --summary --json
armadra graph validate --board <id> --file graph.json --json
armadra graph apply --board <id> --file graph.json --key <key> --json
armadra run start --board <id> --file run.json --key <key> --json
armadra run get --run <id> --json
armadra run wait --run <id> --cursor <cursor> --timeout 30 --json
armadra run cancel --run <id> --key <key> --json
armadra run artifacts --run <id> --json
```

全局选项包含 `--profile`、`--data-dir`、`--json`。没有默认 profile 且无法唯一确定目标时，返回 `target_required`；不默认选择最近打开的画布。`--file -` 从 stdin 读取，提示词不经 Shell 拼接。帮助按子命令展开。

默认输出采用短文本；Skill 总是使用 `--json`。JSON 模式 stdout 只有一份结果，stderr 用于不含敏感正文的诊断。core 错误沿用 `{ code, message }`，CLI 包装为：

```json
{
  "schemaVersion": 1,
  "ok": false,
  "requestId": "request-id",
  "error": {
    "code": "revision_conflict",
    "message": "画布已经变化，请重新读取。"
  }
}
```

成功返回 `ok: true` 与 `data`，不附带整份画布。退出码：`0` 为命令执行成功（查询到失败运行仍是查询成功），`2` 参数错误，`3` 连接或版本错误，`4` 授权拒绝，`5` 状态冲突，`6` 内部失败，`7` 请求结果未知。`run wait` 正常超时返回 `0`、`timedOut: true` 和当前状态；超时不代表任务失败。

### 7.2 图变更输入

采用带操作类型的增量命令，不允许客户端通过整份文档覆盖删除未提及的节点。示例 UUID 与时间戳为占位值：

```json
{
  "schemaVersion": 1,
  "expectedUpdatedAt": "2026-10-03T00:00:00.000Z",
  "operations": [
    {
      "op": "createNode",
      "key": "implement",
      "type": "terminal",
      "title": "实现",
      "data": { "kind": "terminal", "agent": { "id": "codex" } }
    },
    {
      "op": "createNode",
      "key": "review",
      "type": "terminal",
      "title": "审查",
      "data": { "kind": "terminal", "agent": { "id": "claude" } }
    },
    {
      "op": "createContextLink",
      "source": { "key": "implement" },
      "target": { "key": "review" },
      "role": "peer"
    }
  ]
}
```

- `key` 只在本次输入内有效，返回稳定 UUID 映射；后续命令使用 UUID。
- 现有节点引用使用 `{ "id": "uuid" }`，禁止靠标题模糊匹配。首版只更新该 profile 创建的节点；连接用户已有节点需显式引用并校验范围。
- `updateNode` 只改标题、颜色、位置、尺寸和分组等白名单字段；`removeContextLink` 指定边 ID。首版不暴露原始节点 `sessionId`、启动命令、账号 token 或状态写入。
- 显式拒绝跨板引用、自环连线、重复 key、非法节点类型、嵌套分组和超出工作空间的文件路径。上下文连线可以成环；执行依赖不能成环。
- 默认每批最多 32 个新节点、128 条连线、256 KiB 请求体。限额集中定义，并返回具体失败项；整批校验失败时零写入。
- 采用现有默认节点尺寸和布局规则，不在 core 复制第二份尺寸表。
- 新终端强制 `launchPolicy: "manual"`（拟新增字段），旧节点缺省保持 `onOpen`。前端会话创建与恢复入口均需识别该字段；未显式启动时连 shell 也不创建。
- 图保存、上下文授权文档、profile 对象归属、幂等结果及事件记录需在同一数据库事务提交。提取现有 `saveBoard` 的事务内变体，事务外统一发布广播。
- 保留画布 viewport、白板、用户未知节点和其他字段。遵守现有编辑租约，不静默接管其他设备的写入权；返回可恢复的 `lease_held`。

幂等键以 `(controllerId, workspaceId, command, key)` 为范围，比较规范化请求摘要。同键同请求返回原结果；同键不同内容返回 `idempotency_conflict`。先查已完成幂等记录，再做旧版本检查，保证“已写入但响应丢失”的重试返回原结果。

### 7.3 内部传输

私有 socket 使用 HTTP + JSON，客户端请求 `POST /controller/v1/commands`，请求体为 `{ requestId, method, params, idempotencyKey? }`。`method` 只允许已登记的命令名，例如 `graph.apply`、`run.start`；禁止传入文件中的函数名或任意 Shell。凭据在 Authorization 头中传递，由客户端从 profile 文件读取。

CLI 与 core 共用 `packages/shared` 的 schema 和版本常量；未知主版本直接拒绝，新增可选字段按能力协商。请求体、响应体和超时均有上限。`run.wait` 在同一请求中有限等待，客户端断开只释放等待者，不取消业务运行。

## 8. 运行模型与执行语义

### 8.1 运行输入

```json
{
  "schemaVersion": 1,
  "expectedUpdatedAt": "2026-10-03T00:00:01.000Z",
  "tasks": [
    {
      "key": "implement",
      "nodeId": "<实现节点 UUID>",
      "prompt": "按已确认要求实现功能，并将变更说明写入 reports/change.md。",
      "after": [],
      "outputs": ["reports/change.md"]
    },
    {
      "key": "review",
      "nodeId": "<审查节点 UUID>",
      "prompt": "审查当前工作目录的修改，读取 reports/change.md，输出 reports/review.md。",
      "after": ["implement"],
      "outputs": ["reports/review.md"]
    }
  ],
  "maxConcurrency": 2,
  "deadlineSeconds": 3600
}
```

上例 prompt 是任务材料，不自动赋予提交、推送、删除或审批权限。`outputs` 是工作空间相对路径清单，用于收集元数据；不自动创建文件、不保证它一定存在。

首版每次运行最多 6 个 Agent 任务，默认并发 2、最大 4；prompt 上限复用现有任务投递限制；运行 deadline 默认 1 小时、最大 24 小时。有限等待最长 60 秒，Skill 每次等待使用 30 秒。

### 8.2 启动与依赖

1. `run start` 校验整组节点、能力、路径、权限、DAG 和并发占用；首版仅运行该 profile 管理的 Agent 节点，已有正在工作的节点返回 `node_busy`。
2. 冻结节点执行配置、prompt、依赖和授权范围，事务写入 run、task、节点占用与待启动意图，立即返回 `runId`。
3. core 调度无依赖根任务，复用终端后台启动与投递门；页面打开只能附着，不得触发第二次启动。
4. 下游所有依赖完成后，才启动和入队它的第一条任务。不能在运行创建时把尚需等待的任务全塞进现有五分钟 TTL 的投递队列。
5. 上游失败或取消使依赖任务进入 `skipped`，保留原因；无关分支继续运行。首版不自动重试已经执行过的业务任务。
6. 运行中修改节点标题、位置不改变冻结任务；修改模型等执行配置不影响本次 run。节点被删除使对应 task 失败，下游跳过；终端不能因 UI 重建而另起一份。
7. 同一节点只能被一个非终态 run 占用，约束落库；并发限制覆盖同一 controller 的运行，不能靠多发几个 run 绕过默认上限。

### 8.3 状态与“完成”

| 对象 | 状态                                                                                             | 含义               |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------ |
| run  | `queued / running / blocked / cancelling / completed / failed / cancelled`                       | 整次运行的聚合状态 |
| task | `pending / starting / delivering / running / blocked / completed / failed / cancelled / skipped` | 单节点任务状态     |

`completed` 表示本次投递对应的 Agent 回合正常结束，**不等于代码正确或测试通过**。真实验证结论来自报告或未来的验证器。本版不把终端出现某个词、PTY 静默或进程退出码 0 当作任务质量结论。

完成判定必须满足：

- 关联本次 `runId / taskId / deliveryId` 与实际 PTY `sessionId / generation`。
- 保存投递前可信事件基准；忽略旧会话、旧 generation、旧 `done` 和事件重放。
- 本次已确认投递后，观察到匹配会话的可信工作回合及其正常结束；只接受 Hook/扩展来源，不接受 `observed` 推测作为下游放行依据。
- 检查 `errored / interrupted`，不能因表面状态为 `done` 就忽略失败标记。
- 若适配器不能可靠关联回合，或遇到其他输入混入，不猜完成：进入 `blocked`，reason 为 `completion_unknown` 或 `external_interference`。首版不提供“强行标成完成”接口。

`blocked` 同时记录具体原因（等待用户审批、需要输入、授权撤销、连接丢失等）。若仍有其他可运行分支，run 仍为 `running`，单任务显示阻塞；无可继续任务且存在阻塞时 run 为 `blocked`。任何终态 task 为失败且其余任务终止后，run 为 `failed`；全部必要 task 正常完成才为 `completed`。

### 8.4 复用边界与身份迁移

对既有 `dependencies`、投递队列与启动器做小范围提取和扩展，不建立第二套 PTY 输入实现。新 run 依赖判断使用本次 task 的完成结果，不能直接复用 `baselineFor("current")` 对旧 `done` 的立即满足语义。

run 管理的启动记录必须带运行归属，只有运行调度器能够把对应任务从待执行推进到启动；旧依赖服务不能同时把它当作未归属的普通节点启动。既有不属于 run 的依赖保持原有语义，共用启动器和会话占用检查。

投递与依赖记录增加 `sourceKind`、`controllerId`、`runId`、`taskId` 等明确关联；既有 node 来源保留不变。controller 来源不要求伪造 `sourceNodeId`，但仍校验目标范围、持久授权、节点占用、驱动租约和输入安全。旧的 node→node 消息仍走原有连线与 hops 限制。需要逐项检查 pump、取消、队列查询、审计与迁移，不能只改 enqueue 的类型。

### 8.5 取消与崩溃恢复

- `run cancel` 幂等：先落 `cancelling`，停止未开始任务并取消未投递项，再中断本次 task 所绑定的 generation。不得按模糊进程名杀死其他会话。
- 已发出但没有确认结果的 PTY 输入无法保证 exactly-once。记录 `delivery_unknown`，不自动再输入一遍。命令幂等与外部副作用 exactly-once 是两件事。
- core 重启后先读取 run、节点占用、执行意图和实际会话；tmux 存活时重新附着，不重复发送任务。direct 进程已丢失时标明失败/未知，不自动重新执行有副作用的 prompt。
- 取消、正常完成同时到达时以持久化顺序裁决，记录实际完成事实，不能把已完成的工作宣称已回滚。
- deadline 到达后进入取消流程，并保留 `deadline_exceeded` 原因。状态查询与取消不依赖画布是否打开。

## 9. 事件、结果与 token 预算

`run get` 默认返回：run 状态、任务计数、每个任务的状态/原因、最新摘要、结果路径与更新时间；不返回完整终端内容、整个仓库 diff、环境变量或 CLI 凭据。

`run wait` 使用持久化 run 事件的单调游标。超过事件保留窗口时返回 `snapshotRequired` 与快照读取指引，不假装没有新事件。仅在状态变化、完成、失败或需要用户操作时结束等待；客户端超时不取消 run。

建议单次默认结果上限 8 KiB、最多 50 条事件，返回 `truncated`、`nextCursor` 和可继续读取的入口。分页边界不能截断 JSON。详细事件按需读取，每页不超过 32 KiB；不将完整输出转储到 stdout。

`run artifacts` 按声明的 `outputs` 检查当前文件，返回相对路径、存在状态、类型、大小、内容版本及检查时间。路径必须解析后仍在工作空间内，拒绝符号链接逃逸；路径缺失如实返回。首版这些是当前文件引用，不是不可变历史快照，也不从“文件存在”推断 task 成功。

token 验证用同一两节点任务记录：加载的 Skill/帮助字节数、CLI 调用次数、输入输出字节数；宿主提供 token 统计时另记实测值。不用字符数假装精确 token，也不在没有同条件 MCP 基线时宣称节省比例。

## 10. 代码、存储与插件交付

### 10.1 拟新增目录

```text
apps/desktop/src/cli/armadra/       # 外部客户端，参数/传输/输出/等待
apps/desktop/src/core/controller/  # 本机通道、profile、actor、命令适配
apps/desktop/src/core/runs/        # 运行记录、状态归约、执行意图及查询
packages/shared/src/api/           # controller / graph / run schema
tools/plugins/armadra/             # 插件源清单、Skill、按需参考
tools/probes/                      # 外部 CLI 端到端探针
```

使用现有允许的根目录，不新增根级 `plugins/`。构建阶段从单份 CLI 源码生成客户端，并把插件组装到忽略的 `target/plugins/armadra/`：

```text
target/plugins/armadra/
├── plugin.json
├── skills/armadra/SKILL.md
├── skills/armadra/references/commands.md
└── scripts/armadra.cjs
```

CLI 使用 Node.js ≥22，与项目要求一致，不依赖 Electron ABI 或 node-pty。Skill 从自身安装目录定位脚本；不依赖当前工作目录、源码仓库路径或 PATH 中碰巧存在的同名程序。使用参数数组或可靠的文件传参，不拼接含提示词的 Shell 命令。

`plugin.json` 使用官方当前推荐的 portable manifest，仅声明实际存在的资源。首版不生成空 MCP 配置，不声明 Hooks，不修改全局 CLI 集成。客户端 `doctor` 验证 `controller.v1` 和 `runs.v1` 能力、版本兼容与 core 是否运行；缺服务时给出既有启动方式，不隐式启动陌生二进制。

本地 marketplace 安装应合并已有目录配置、保留其他插件，先验证源路径，再更新版本和安装缓存；不以覆盖整个用户配置的方式安装。插件卸载不删除 Armadra 的画布或运行记录。公开插件发布不在本次范围。

### 10.2 数据库与事务

拟新增逻辑表：`controller_profiles`、`controller_objects`、`controller_commands`、`runs`、`run_tasks`、`run_events`、`run_effects`。命名可随现有惯例调整，但以下不变量不变：

- 命令键唯一；保存请求摘要、结果引用与已提交状态。
- 同一运行任务的启动、投递意图各有唯一键；异步副作用有 `pending / executing / applied / uncertain` 状态。
- 非终态 task 对节点的占用唯一，事务校验。
- run 与 task 持久化冻结配置、来源、基准、generation、投递 ID 和原因，不持久化原始终端输出。
- 幂等结果保留至少覆盖对应图对象和运行的存续期；不得因短期事件清理失去重复提交保护。首版不新增自动删除策略。
- 扩展现有发送队列和依赖表，迁移旧记录为 `sourceKind = node`，保持旧字段意义。

所有迁移放到现有 `core/db/migrations/`，实施时取下一连续编号并更新 `migrations.lock`，不能现在预占编号或修改已发布迁移。数据库写入与 run 事件同事务，广播在提交后；进程启动在事务外执行，并通过持久意图恢复。

### 10.3 前端兼容

- 增加并识别手动启动字段；新节点显示“待启动”，用户点击运行走同一 core 服务。
- 展示已有状态徽标，必要时补“等待上游 / 需要处理 / 运行完成”等中英文文案。
- 图修改走 core 的领域服务，前端收到 `board.changed` 后仍经既有 store 同步。
- 上下文边和依赖状态保持分离，首版不必新增永久边类型；任务详情可说明它在等待谁。
- 实施阶段才更新 `guides/architecture.md`、开发指南、现状表和 JSON 契约；契约章节编号只追加不重排。

## 11. 验收矩阵

| 编号 | 场景                                         | 通过条件                                              | 对应需求 |
| ---- | -------------------------------------------- | ----------------------------------------------------- | -------- |
| A01  | core 未启动、发现文件残留、协议版本不匹配    | 明确错误，无误连、无隐式启动                          | R01      |
| A02  | 跨 workspace、伪造节点身份、撤销 profile     | 读写与等待均拒绝；后台未开始任务停止推进              | R01、R07 |
| A03  | 批量创建两个 Agent 与上下文线                | 一次提交全部出现，非法引用零写入                      | R02      |
| A04  | 创建时页面已打开 / 后打开                    | 未 run start 前无 shell、无 CLI；启动后只附着一份会话 | R03、R04 |
| A05  | 同键重试、同键异请求、CAS 冲突、租约冲突     | 不重复建图；明确冲突；不覆盖人工修改                  | R02、R05 |
| A06  | 画布未挂载，运行根节点→审查节点              | 根任务开始，下游仅在本次回合结束后开始                | R04      |
| A07  | 重放旧 done、旧 generation、仅 observed 状态 | 不误放行；必要时明确阻塞                              | R04、R07 |
| A08  | 上游失败、审批等待、用户中断、节点删除       | 正确终态/阻塞原因；下游不误启动                       | R07      |
| A09  | 两次 start 并发、节点被占用、超过并发上限    | 唯一 run / 占用，不能重复启动                         | R05      |
| A10  | 入库后响应丢失、启动/投递边界 core 崩溃      | 可查询原结果；未知副作用不重放                        | R05、R07 |
| A11  | CLI 退出、关闭画布、有限等待超时             | 后台工作继续，超时不是失败                            | R04、R06 |
| A12  | 取消时正在投递、重复取消、取消与完成竞争     | 精确定位 generation，状态可解释，无误杀               | R06      |
| A13  | 大量日志、事件过期、产物路径逃逸             | 输出限额和游标正确；越界文件拒绝                      | R06      |
| A14  | 插件从不同 cwd、含空格路径安装后使用         | 脚本正确定位，命令结果机器可读                        | R08      |
| A15  | 原有 Hook 与 CLI、旧画布、服务器壳           | 原测试与端到端行为保持通过                            | R09      |
| A16  | 真 Codex 实现→真 Claude 审查                 | 实际运行、依赖、报告可验证；不能仅凭假 CLI 宣称通过   | R04、R08 |

先用确定性假 CLI 验证崩溃、超时和竞态，再在隔离测试仓库与临时 Armadra 数据目录运行 A16。不得迁移用户正在使用的数据或全局 Hook；凭据不足时明确记录缺哪个真实验收，不把 mock 结果计入真实通过。安装或真实执行阶段遵循用户后续批准的实施范围。

实现后最少运行：

```sh
pnpm libs:build
pnpm --filter @armadra/shared test
pnpm --filter @armadra/desktop test
pnpm --filter @armadra/web test
pnpm --filter @armadra/server test
pnpm check
```

此外运行新增 CLI/运行故障探针、插件组装检查和 A16；仅当改动打包/发布脚本时追加对应 `pnpm release:test` 及相关构建。验证依据保存到实施进度文档，区分代码通过、假进程通过、真实 CLI 通过和宿主插件安装通过。

## 12. 实施批次与完成定义

| 批次          | 工作                                                                       | 交付条件                     |
| ------------- | -------------------------------------------------------------------------- | ---------------------------- |
| P0 入口验证   | 最小 CLI、私有通道与 doctor，验证本机 Codex 可定位客户端；插件脚本打包原型 | A01、A14，不启动真实业务任务 |
| P1 身份与图   | controller actor、profile、批量图命令、幂等、事务组合、手动启动字段        | A02–A05                      |
| P2 运行闭环   | 持久 run/task、队列来源扩展、后台启动、依赖、完成关联、查询与取消          | A06–A09、A11–A12             |
| P3 故障与输出 | 意图恢复、未知投递、事件游标、结果限额与产物引用                           | A10、A13                     |
| P4 插件验收   | 最终 Skill/参考、本地安装、真实双 Agent 流程、文档与兼容回归               | A14–A16、仓库检查与相关构建  |

每批先建立对应关键行为测试，再实现，并只跑与改动有关的检查；最终跑完整要求。无需为静态文档本身增加测试。

完成定义：从本机 Codex 调用已安装插件完成“建图→运行→依赖启动→查询→产物引用”的真实闭环；画布不开也能工作；重试不重复执行；取消与恢复可解释；旧功能回归通过。仅生成 plugin manifest、只建出节点或只通过模拟测试均不算完成。

## 13. 风险与后续接口

| 风险                                  | 处理                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| 各 CLI 的完成事件无法稳定关联本次任务 | P2 提前验证；不支持的适配器明确降级，禁止用静默超时当成功     |
| 同用户其他进程/人工终端输入干扰任务   | 运行占用与驱动租约；混入时标记未知，不提供虚假的任务归属      |
| core 已有事务不支持外层组合           | P1 提取事务内函数并测回滚，不直接套嵌套 BEGIN                 |
| 开发构建与打包版 CLI 路径不同         | 独立纯 Node 客户端，插件构建时组装；安装目录定位测试          |
| 业务副作用无法 exactly-once           | 幂等命令 + 持久意图 + uncertain 状态，不自动重放未知输入      |
| 同一目录多个并行 Agent 改文件         | 默认并发保守；有写入冲突的任务设依赖，首版不自动隔离 worktree |
| 原有连线被误认为执行/刷新规则         | Spec、输入字段与 UI 明确区分三类关系                          |

未来 MCP 包装 `controller/runs` 的应用服务，增加远程认证与网络接入，不重新实现画布和调度。未来“更新连线”消费完成结果与资源版本，单独定义刷新的触发与冲突语义；当前不承诺每次 done 都刷新所有邻居。

## 14. 已批准的决策

用户于 2026-10-03 确认“这个方案可行”，并要求生成 goal 命令。以下 D1–D5 作为 v1.0 实施基线；没有新增范围变更。

| 编号 | 已批准决策                                          | 影响                                    |
| ---- | --------------------------------------------------- | --------------------------------------- |
| D1   | 首版为本机 Codex 的 CLI + Skill 插件                | 不含普通云端 ChatGPT 调用和 MCP         |
| D2   | 覆盖建节点/上下文线、依赖运行、查询、取消和结果路径 | 自动刷新成果节点、内嵌 ChatGPT 画布另做 |
| D3   | macOS 真机 + Codex/Claude 双 CLI 验收               | Linux 做通道自动化验证；Windows 后置    |
| D4   | 只操作已有本机工作空间，默认不创建 worktree         | 首版更小，写入冲突通过依赖控制          |
| D5   | 插件先走本地个人/仓库 marketplace 验证              | 不含公开发布、服务器部署及远程账号体系  |

本轮生成最终一条 goal 命令。命令必须完整引用：仓库绝对路径、批准 Spec、R01–R09、P0–P4、A01–A16、范围排除、验证和完成定义；没有用户指定就不添加 token 预算。用户提交命令后进入实施阶段；本次批准不等于命令已经执行。

## 15. 依据与验证记录

### 15.1 官方依据

查阅日期：2026-10-02 至 2026-10-03；这些说明描述宿主产品能力，不能替代目标账号上的安装验证。

- [Package your plugin](https://developers.openai.com/plugins/build/plugins)：插件可打包 Skill；新包推荐根 `plugin.json`；支持本地 marketplace；MCP 为可选组件。
- [Build skills](https://learn.chatgpt.com/docs/build-skills)：Skill 先展示名称与描述，使用时加载完整说明，可附带脚本与参考。
- [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)：API 的工具延迟加载可以降低上下文占用；不能据此假定每个桌面宿主都采用相同配置。
- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions)：未来 MCP App 可作为侧栏应用或对话侧面板；不属于本首版。

### 15.2 本轮验证

本轮只核对源码并写 Spec，没有真实 CLI、数据库迁移或插件安装验收。2026-10-03 实际检查结果：

- `pnpm check` 通过：shared 构建、全仓格式、四个 workspace 类型检查、仓库规则、CI workflow 校验与发布版本一致性。
- `pnpm repo:check` 通过：7 条规则，包含文档索引和相对链接。
- 本轮没有功能代码变更，不运行真实任务，也不把静态检查计入 A01–A16 的功能验收。
