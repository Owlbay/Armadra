# core 的 JSON 面

> 状态：实施契约。章节 §N 被代码注释引用，编号只增不改。
> 范围：`/api/github/*`、`/api/automations/*`、`GET /api/identity/hello`，以及自动化域**存进库里**的那份 JSON。它们由 R7a 落地（[实施进度](../status/typescript-core-status.md) §15）；R7 收尾删掉 `proto/`、`packages/protocol`、`packages/host-client` 与 `/rpc/*` 之后，这份文档是这三块的唯一说法。
> 不在范围：`/api/workspaces/*` 那 163 条路由（[TypeScript Core](../design/typescript-core.md) §5.1）。R7 之前它们与当时并存的 Rust Runtime 逐条对账、一个字节都不变；R7 收尾后 core 已是唯一实现，这张对账表本身随之拆除，但这 163 条路由不属于本文档的编码范围。

## 1. 为什么有这份文档

R7a 之前 GitHub 与自动化两块面板走的是 `/rpc/armadra.v1.*`：二进制 protobuf 帧，形状由当时 `proto/` 里的 `.proto` 说了算。R7 把 `proto/` 与两份生成码一起删掉了，所以这两块在删除之前必须先有一份**不依赖那些文件也读得懂**的说法——否则删除那一步会同时删掉「这条记录长什么样」的唯一定义。

这份文档就是那个说法。它描述线上的字节，不描述任何一端的类型。

## 2. 编码规则

形状是 **protobuf 的 JSON 映射**。选它不是因为还想留着 protobuf，而是因为它是一份已经写死的规范：R7 手写编解码时有一份逐字段的参照，而不是一个「当初大概是这么转的」。

| 类型               | 线上                           | 例                                       |
| ------------------ | ------------------------------ | ---------------------------------------- |
| 字段名             | camelCase                      | `updatedAtUnixMs`                        |
| `string` / `bool`  | 原样                           | `"octocat"` / `true`                     |
| `int32` / `uint32` | `number`                       | `42`                                     |
| `int64` / `uint64` | **十进制字符串**               | `"1788557900000"`                        |
| `bytes`            | **base64**（标准表，带 `=`）   | `"3q2+7w=="`                             |
| 枚举               | **枚举值名**                   | `"GITHUB_ISSUE_STATE_OPEN"`              |
| `repeated`         | 数组                           | `[]`                                     |
| 消息               | 对象；**未设置时整个字段缺席** | `"author": { … }` 或没有 `author` 这个键 |
| `oneof`            | 摊平成那**一个**被设置的字段   | `"schedule": { "cron": { … } }`          |

三条额外的规矩：

1. **零值照写**。`""`、`0`、`"0"`、`false`、`[]` 都出现在响应里。一份缺字段的 JSON 和一份字段为零的 JSON 对读者是两句话，而同一条记录只该有一句。**例外**是消息字段与 `optional` 标量：它们有显式的「在不在」，缺席就是缺席。
2. **`int64` 不用 `number`**。Issue 编号、id 与时间戳都是 64 位，`number` 在 2^53 之上会悄悄改值——一条被改了 id 的评论会被贴到别人的行上。
3. **不认识的字段不是拒绝的理由**。一个更新过的 core 写的记录要读得回来；页面侧的 zod 把认不出来的枚举名落回 `*_UNSPECIFIED`，而不是让整页消失。

错误一律 `{ code, message }`。`message` 是给人看的一句话，`code` 是可以分支的机器码——**两张面的 `code` 必须一致**，见 §3.3 与 §4.4。

## 3. 身份

### 3.1 `GET /api/identity/hello`

不要求凭据：它回答的是「这台 core 是谁、支持什么」，而那正是一次配对**之前**就要知道的事。要求一个 `Origin`。

```json
{
  "protocol": { "major": 1, "minor": 0 },
  "hostInstanceId": "0123456789abcdef0123456789abcdef",
  "hostId": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "capabilities": ["identity.native-session.v1", "automation.plans.v1"],
  "maxFrameBytes": 4194304
}
```

`capabilities` 与 `HostService/Hello` 报的是**同一张表**：页面靠 `automation.plans.v1`、`github.issues.v1` 这类名字决定开不开一块面板。改一个名字等于让所有已装机器的那块面板一起熄灭。

### 3.2 两张 JSON 面的认证

`/api/github/*` 与 `/api/automations/*` 都要求：

- 恰好一个 `Origin` 头；
- 写操作在 Cookie 会话上要 `X-Armadra-CSRF`（至多一个）；`Authorization: Bearer` 传输（桌面壳的原生传输、Gateway 上的原生 App）不核，与 §17.4、§18 同一条规则（`core/identity/http.ts::csrfRequired`，安全审查 L8）；
- 一份会话凭据——原生传输（明文 + 回环来源）读 `Authorization: Bearer`，浏览器会话读 Cookie。

**明文回环上没带凭据的一次调用按本机主人处理**（`core/identity/service.ts` 的 `localOwner`）。桌面壳的会话是原生的，密钥在壳里，既不发 Cookie 也到不了 `apps/web/src/api/request.ts` 的那个 `fetch`；而那台壳就在同一台机器上。TLS 的服务器壳上这条路不存在，凭据仍然是必须的。主人必须是一台**没被撤销的真设备**——自动化的授权记录要拿它的 epoch 复核，一个编出来的设备标识会让计划在第一次投递时被自己的复核拒掉。

**自 0.2.0 起桌面壳不再按主人处理回环匿名请求**（安全审查 L9）：上面那条路只在 core 的启动选项 `loopbackAnonymousOwner`（`core/main.ts`，缺省 `false`；不传时读 `ARMADRA_LOOPBACK_OWNER=1`）打开时存在，判定在 `core/identity/http.ts::anonymousLoopbackOwner`。桌面壳的页面在这两面上带票据换来的 `Authorization: Bearer`（`apps/web/src/api/request.ts`，401 时换一枚重发一次；回环 CORS 的 `access-control-allow-headers` 因此多了 `authorization`），壳不把这个变量带给 core；服务器壳显式传 `false`。只有探针（`tools/probes/probe-home.mjs`）与 `armadra.sh run web` 起的裸 core 打开它。关着时明文回环上没带凭据的调用照 401 回答（GitHub 面 `UNAUTHENTICATED`、自动化面 `unauthenticated`）。

**自 0.2.0 起 core 回环监听上的每一条 `/api/` 与每一条流都要会话**（安全审查 L9 收尾，G5-28）：上面两面之外，路由表里其余 `/api/` 路由与 WebSocket 原来没有请求身份、按本机主人放行，本机任何一个回环端口上的网页都能读设置、开终端、连事件流。现在 `loopbackAnonymousOwner` 关着时（两种壳都是），身份域在 core 自己的监听上装一道门（`core/identity/loopback.ts`，经 `CoreServer.admission`）：

- **不要会话的**只有 `/health`、`/api/health`、`/api/identity/*`（hello、配对、刷新、登录等各自认自己的凭据）与 `/api/gateway/pairing-code/exchange`（§24），与 Gateway 的匿名面是同一张名单（`core/identity/transport.ts::anonymousPath`）。CORS 预检照旧不要凭据。
- **HTTP**：恰好一个 `Origin`，加一份会话凭据——回环明文来源读 `Authorization: Bearer`，别的来源读 Cookie 且写方法要 `X-Armadra-CSRF`。不报 `Origin` 的调用（`curl`、本机别的进程）没有会话可言，同样 401。
- **WebSocket**：浏览器的升级带不了头，凭据是 `Sec-WebSocket-Protocol: armadra-ticket.<票>`。票由 `POST /api/identity/ws-ticket`（带 Bearer，只发给回环明文来源的原生传输，否则 400 `bearer_required`）换来，答 `{ ticket, expiresAt }`，30 秒、一次性，绑着签票时的来源，升级的来源对不上不认——与 Gateway 上原生 App 的票（§17.4）同一个形状与做法。升级被拒时状态行是 `401 unauthenticated`。
- 拒绝一律是 401 `{ "code": "unauthenticated", "message": "需要一个已配对设备的会话" }`；Cookie 会话 CSRF 不对是 403 `forbidden`。门判在读请求体之前，路由存不存在也不先回答（没带会话打一条不存在的路径同样 401）。
- 认出来的会话进这次请求的身份（`runAs`），路由门、事件订阅与长连接的到期复核（4401 / 4403，§17.4）与 Gateway 进来的请求走同一条路。经 Gateway 交接进 core 的请求已在 TLS 一侧认过人，不再过这道门。

调用方：桌面壳的页面把请求层装在本机源上（`apps/web/src/api/shell-transport.ts` → `api/source.ts` 的 `localSource`，复用原生 App 的 `bearerFetch` / `ticketedWebSocket`，自 E1 起不再改写全局 `fetch` / `WebSocket`）：每个发往 core 的请求带 Bearer、每条流先换票；还没有会话先向壳要票配对，401 时复核 → 刷新 → 重新要票，只重发一次；访问密钥到期前两分钟主动轮转，流不必因 4401 重连。`<img>` 与编辑器的「下载」带不了头，经本机源的 `fetch` 取回再交给 `blob:` 地址（`api/assets.ts`）。托盘经 `shell-core/core-session.ts` 用同一张票换自己的会话，来源是 core 自己的回环基址。Windows 上 core 的私有通道还不开，壳经 fork 的 IPC 通道取票（`armadra:identity-ticket`，`core/identity/control.ts::startTicketIpc`、`main/core-ticket.ts`）。接管了上一个 core 或外接 Runtime 时这个壳没有 IPC 通道，取票答 `channelUnavailable`，页面挂一条通知条请人重开应用，不静默 401。

**本机设备复用**：回环明文来源的票兑换时，复用主人名下同名、没被撤销、且签过的会话全都来自回环明文来源的那台设备（`core/identity/service.ts` 的 `consumeBootstrap`），只多一条会话；页面每次加载、托盘每次启动不再各建一台「本机桌面」。经 Gateway（HTTPS 来源）配对的设备每次都是新的，也不会被本机配对认领。

### 3.3 稳定的 `code`

GitHub 那一面（§5、§41.1）的 `code` 自协议 1.11 起是 snake_case，与其余 `/api/` 一致，取自错误码注册表（`packages/shared/src/contract/errors.ts`）；从前的 UPPER_SNAKE 拼法（延续自历史上 `/rpc/` 兼容面，R7 已删除）已换掉，状态与固定的英文原话不变：

| HTTP | `code`            | 从前的拼法           | 意思                                         |
| ---- | ----------------- | -------------------- | -------------------------------------------- |
| 400  | `bad_request`     | `INVALID_ARGUMENT`   | 请求本身不合法                               |
| 401  | `unauthenticated` | `UNAUTHENTICATED`    | 设备会话无效或过期                           |
| 403  | `forbidden`       | `PERMISSION_DENIED`  | 授权位不够，或 CSRF 没过                     |
| 404  | `not_found`       | `NOT_FOUND`          | 仓库 / Issue / PR / 连接不存在，或动词不存在 |
| 409  | `conflict`        | `CONFLICT`           | 远端或存下来的修订号变了，重新读             |
| 429  | `rate_limited`    | `RESOURCE_EXHAUSTED` | 触到 GitHub 的限流，等它重置                 |
| 500  | `internal`        | `INTERNAL`           | GitHub 操作失败（原话固定，不带细节）        |
| 501  | `unsupported`     | `UNSUPPORTED`        | 这台 core 没有可用的 GitHub 凭据             |
| 504  | `unknown_outcome` | `UNKNOWN_OUTCOME`    | 写出去了而结果没读到——**重新读，不要重试**   |

页面（`api/request.ts` 的 `MESSAGE_BY_CODE`、`api/github.ts` 的 `classifyGithubFailure`）在**一个 minor** 里两种拼法都认（还没升级的 core 答的是大写），每对取同一句界面文案；下一个 minor 删去大写拼法。身份域（§17、§18）的 UPPER_SNAKE 在它迁到契约时（E3-7）再换。

自动化那一面的 `code` 也是 snake_case：`bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`unsupported`、`internal_error`。

### 3.4 WebSocket 流的传输：心跳、帧上限与背压

五条流（事件流、终端、实时协同、语言会话、浏览器画面）的帧格式不变；下面三条是 `ws` 层与发送端的行为（`core/http/server.ts`、`core/http/stream-queue.ts`，平台规格 core 包 §3）。

- **心跳**：core 每 25 秒给每条流发一个 `ws` ping 控制帧（不是数据帧，页面看不见，浏览器自己回 pong）；连续两次没有 pong 就直接断开（不走关闭握手，客户端看到 `1006`），按断线重连处理。
- **单帧上限**（客户端发给 core 的一帧）：缺省 1 MiB（与 §3.1 hello 报的 `maxFrameBytes` 同一个数）；终端 16 MiB（`input` 帧整段带着粘贴）、实时协同 16 MiB（§16.1）、语言会话 4 MiB（超过 JSON-RPC 单条上限的消息仍由会话以错误回答）。超过的帧以 `1009` 关流。
- **背压**：一条连接的发送缓冲（`bufferedAmount`）过了高水位之后按流的语义处理，降到一半以下恢复：

| 流         | 策略        | 高水位 | 队列上限 | 跟不上时                                                                                                |
| ---------- | ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------- |
| 事件流     | drop-oldest | 1 MiB  | 256 帧   | 丢最旧的帧，连接不断（与原来一样）；要补的用 `?cursor=` 续订                                            |
| 终端       | pause       | 4 MiB  | 64 帧    | 暂停读这条连接背后的 PTY（tmux 客户端 / 会话宿主连接；direct 后端是整个会话的 PTY），排空后恢复；不丢帧 |
| 实时协同   | pause       | 2 MiB  | 256 帧   | 停止向这条连接广播别人的更新与 awareness；恢复时补一帧 step1、一帧整份状态的 step2 与当前全部 awareness |
| 语言会话   | pause       | 2 MiB  | 256 帧   | 暂停读语言服务器的 stdout（同一服务器的其它会话一起等）；远程执行主机上的会话不能暂停，只排队           |
| 浏览器画面 | coalesce    | 2 MiB  | 4 组     | 只留最新一帧（头帧与 JPEG 一组）；hello 与错误帧不合并                                                  |

`pause` 的队列满了（对端完全不读）以 `1013` 关流，客户端按退避重连，重连后终端重绘 / 补快照、实时协同重新 step1 / step2；不会悄悄丢帧。

## 4. 自动化：`/api/automations/*`

工作空间跟着查询串走：`?workspaceId=<id>`。一次调用可以说它想操作哪个工作空间，不能说它有什么权限。

### 4.1 路由

| 方法   | 路径                                       | 请求体                                              | 响应                                 |
| ------ | ------------------------------------------ | --------------------------------------------------- | ------------------------------------ |
| `GET`  | `/api/automations/plans`                   | —（`?after=&limit=`）                               | `{ plans, nextId, hasMore }`         |
| `POST` | `/api/automations/plans`                   | `{ planId, config, payload, expectedRevision }`     | `PlanSnapshot`                       |
| `GET`  | `/api/automations/plans/{planId}/payload`  | —                                                   | `{ planId, payload, payloadSha256 }` |
| `POST` | `/api/automations/plans/{planId}/activate` | `{ expectedRevision, configVersion, configSha256 }` | `PlanSnapshot`                       |
| `POST` | `/api/automations/plans/{planId}/pause`    | `{ expectedRevision }`                              | `PlanSnapshot`                       |
| `POST` | `/api/automations/plans/{planId}/run`      | `{ expectedRevision }`                              | `RunSnapshot`                        |
| `GET`  | `/api/automations/plans/{planId}/runs`     | —（`?after=&limit=`）                               | `{ runs, nextId, hasMore }`          |
| `GET`  | `/api/automations/command-sessions`        | —（`?after=&limit=`）                               | `{ sessions, nextId, hasMore }`      |
| `POST` | `/api/automations/command-sessions`        | `{ sessionId, rootPath, launch }`                   | `CommandSession`                     |

`PlanSnapshot` 是 `{ plan, revision, configSha256 }`，`RunSnapshot` 是 `{ run, revision }`。`revision` 在这一面是 `number`（修订号是小整数，不是 64 位的时间戳）。

**写入侧收的是普通 JSON**：`config` 是一份 `AutomationPlanConfig`，`launch` 是一份 `CommandLaunchSpec`。0020 之前它们是 base64 的 protobuf（`configBase64` / `launchBase64` / `payloadBase64`），因为那时候库里存的就是字节；现在不是了。

### 4.2 `configSha256`：规范 JSON 的 SHA-256

激活一个计划要带上它的配置摘要，core 拿它确认「你批准的和我存的是同一份」。

摘要 = SHA-256(**规范 JSON** 的 UTF-8 字节)，其中规范 JSON 是：

- 按 §2 编码的那份 JSON；
- 对象的键按名字（UTF-16 码元序）**升序**排列；
- 没有任何空白。

JSON 本身不定义键的顺序，所以一份「原样 stringify」的文本在两个只是插入顺序不同的进程里会算出两个数；排序让「同一份配置」这句话可判定。实现是 `core/schedule/json.ts` 的 `canonicalJson`，唯一的调用点是 `core/schedule/plan.ts` 的 `configHash`。

> **摘要换过一次数。** 0020 之前它是 `toBinary(AutomationPlanConfig)` 的 SHA-256。换掉是因为一个只有 protobuf 序列化器才算得出来的数不能是「这份配置」的身份。直接后果：**升级之后已经激活的计划要重新授权一次**。产品未发布，这是可接受的代价。`command_sessions.launch_sha256` 同理。

### 4.3 载荷是文本

计划的私有载荷（命令的 stdin / Agent 的 prompt）在线上是 **UTF-8 原文**，不是 base64：它本来就是用户自己敲进去的东西，base64 只会让人读不懂自己的计划。

```json
{ "planId": "plan-1", "payload": "跑一次检查", "payloadSha256": "3q2+7w==" }
```

`payloadSha256` 是**那些字节**的 SHA-256 的 base64，计划的配置里 `payloadRef` 指的就是它。库里这一张表（`automation_payloads`）**仍然存字节**：它按内容寻址，换一种表示就会改掉所有已冻结计划指向的那个引用。这是迁移 0020 与本节之间唯一一处「线上和库里不同形状」的地方。

### 4.4 库里存的就是线上发的

迁移 `0020_automation_json.sql` 给 `automation_plans`、`automation_activations`、`automation_runs`、`automation_receipts` 与 `command_sessions` 各加了一个 JSON 列（`payload_json` / `launch_json`），并把原来的 protobuf BLOB 列改成可空。写入只写 JSON 列，读优先读 JSON 列。

存的是 §4.2 的**规范文本**，所以同一条记录在库里只有一种字节。

已经装过的机器在应用完 0020 之后行还是只有 BLOB——SQL 里没有 protobuf 解码器——所以转换由 core 启动时的 `core/schedule/convert-legacy.ts` 做一遍：只碰 `payload_json IS NULL AND payload IS NOT NULL` 的行、一个事务、解不开就整体回滚并拒绝启动。**R7 删掉那个文件与那两个 BLOB 列。**

## 5. GitHub：`/api/github/*`

工作空间同样跟着 `?workspaceId=` 走。自协议 1.11 起同一份实现也登记成 `github.*` procedure（§41.1）；失败的 `code` 是 snake_case（§3.3）。

### 5.1 动词

24 个动词各一条 `POST /api/github/<verb>`，`<verb>` 是 RPC 方法名的 kebab-case：

`get-credential`、`configure-credential`、`revoke-credential`、`resolve-repository`、`list-issues`、`get-issue`、`create-issue`、`update-issue`、`set-issue-state`、`comment-issue`、`get-status-mapping`、`put-status-mapping`、`move-issue`、`list-pulls`、`get-pull`、`create-pull`、`submit-review`、`get-checks`、`rerun-checks`、`merge-pull`、`delete-branch`、`link-reference`、`unlink-reference`、`list-references`。

请求体是那个动词自己的参数（不含 `meta`：工作空间在查询串上，身份只来自会话），响应是它的返回消息，两者都按 §2 编码。

> **为什么全是 POST 而不是 REST 的 GET/PUT/DELETE。** 这 24 个动词里有 11 个是读，但它们的参数是一份结构化的过滤器（`GithubIssueFilter` 有六个字段，其中一个是自由文本查询），塞进查询串要么被截断要么要一层自定义编码。统一成「一个动词一条 POST，参数在身体里」让这一面只有一种读法。这是一处与 R7a 任务措辞的偏离，记在[实施进度](../status/typescript-core-status.md) §15.4。

### 5.2 两条不随动词变的规矩

- **列表不带正文。** `list-issues` / `list-pulls` 的每条记录 `body` 都是 `""`：一百条正文装不进一次合理的响应，而一个被截断的正文比一个缺席的更糟——详情请求会把整份拿回来。
- **令牌从不外传。** `configure-credential` 的 `token` 是这一面上唯一会外发的值，而且只是入站；`get-credential` 答的是一份状态（哪种来源、能不能用、账号名），永远不是一次回声。

外部连接（`link-reference` / `list-references` 的 `GithubExternalReference`）带 `forge`：`github` | `gitea` | `gitlab`。请求里不给或给空串按 `github`，答复里总有值；指向 Gitea / GitLab 的连接由 §29.6 核对仓库，API 根取自那一面的配置。

`list-issues` 的分组来自 Projects v2 字段时，core 按 cursor 把 project 的条目翻完，最多 50 页（5000 条）；翻到上界还有下一页，响应的 `statusGroupsPartial` 为 `true`——没读到的 Issue 落在「未分组」，但它们其实可能有 Status。

### 5.3 枚举名

页面按名字分支，所以这些字符串是契约：

- `GithubIssueState`：`GITHUB_ISSUE_STATE_{UNSPECIFIED,OPEN,CLOSED}`
- `GithubPullState`：`GITHUB_PULL_STATE_{UNSPECIFIED,OPEN,CLOSED,MERGED}`
- `GithubStatusSource`：`GITHUB_STATUS_SOURCE_{UNSPECIFIED,NONE,LABEL,PROJECT_FIELD}`
- `GithubWriteState`：`GITHUB_WRITE_STATE_{UNSPECIFIED,APPLIED,PENDING,FAILED,CONFLICTED,SKIPPED}`
- `GithubCheckConclusion`：`GITHUB_CHECK_CONCLUSION_{UNSPECIFIED,PENDING,SUCCESS,FAILURE,NEUTRAL,CANCELLED,SKIPPED,TIMED_OUT,ACTION_REQUIRED,STALE}`
- 其余（`GithubCredentialSource`、`GithubSecretStore`、`GithubIssueStateReason`、`GithubMergeMethod`、`GithubMergeableState`、`GithubReviewState`、`GithubReferenceKind`、`GithubReferenceTargetKind`）同样是 `<ENUM_NAME>_<VALUE>` 的全大写拼法，逐条列在 `packages/shared/src/api/github.ts`。

## 6. 历史背景：曾经有两张面说同一句话

`/rpc/armadra.v1.GithubService/*` 与 `/rpc/armadra.v1.AutomationService/*` 是 R7 之前与本文档并存的 protobuf 兼容面。在删除之前，两张面对同一条记录必须说同一句话，各有一条用例逐字段比对：

- `apps/desktop/src/core/github/http.test.ts`「两张面对同一条记录说同一句话」；
- `apps/desktop/src/core/schedule/api.test.ts`「两张面对同一个计划说同一句话」（连 `configSha256` 一起比）;
- `apps/desktop/src/core/identity/http.test.ts`「答一份与 HostService/Hello 逐字段相同的能力表」。

R7 删掉 `/rpc/*` 之后，这三条用例与它们比对的那一半一起消失；现在这三个文件只测本文档描述的 JSON 面本身。

## 7. 节点的上下文读取记录：`GET /api/nodes/{nodeId}/context-reads`

谁读过这个节点的上下文。节点头的「被读取 N 次」读它；写者是跨连线的四个读取动词（`context list|summary|transcript|terminal`），每读一次落一行（设计 `design/agent-delivery.md` §13）。

不挂在 `/api/workspaces/{id}/` 下，因为它问的是一个节点的历史，而节点标识全局唯一。权限与画布同一档（`canvas:read`）。

| 参数    | 位置   | 默认 | 说明                 |
| ------- | ------ | ---- | -------------------- |
| `limit` | 查询串 | 20   | 最近多少条，上限 200 |

回：

```json
{
  "total": 7,
  "bytes": 91234,
  "reads": [
    {
      "id": "0192…",
      "readerNodeId": "node-1",
      "readerHandle": "planner",
      "readerTitle": "规划",
      "verb": "summary",
      "bytes": 1804,
      "atMs": 1789000000000
    }
  ]
}
```

- `verb` 是四个值之一：`summary` / `transcript` / `terminal` / `content`（内容类节点）。
- `readerHandle` 与 `readerTitle` 在读者节点已被删除时缺席；`readerNodeId` 永远在。
- 从没被读过的节点回 `{"total":0,"bytes":0,"reads":[]}`，不是 404：「没有人读过」是一个答案。

## 8. 依赖编排：`/api/workspaces/{workspaceId}/dependencies`

`canvas open-agent --after` 与 `canvas team` 建的等待关系（设计 `design/agent-automation-design.md` §6）。等待与启动都归 core：条件满足时由 core 起终端、敲启动行、把第一条任务排进投递队列，页面开不开都一样。表在迁移 0027（`agent_dependency_launches` 一个下游一行，`agent_dependencies` 一条边一行）。权限与画布同一档（`canvas:read` / `canvas:write`）。

| 方法与路径                             | 说明                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET …/dependencies`                   | 还没了结的下游（`state != launched`），按下游分组；`?nodeId=` 只看一个，`?all=true` 连已启动的也给 |
| `POST …/dependencies`                  | 旧节点数据里带依赖的 `pendingLaunch` 迁入：`{ "nodeId", "after": [id…] }`，重复调用不重复建        |
| `DELETE …/dependencies/{dependencyId}` | 取消一条边；这个下游其余的边都已满足时 core 当场启动它                                             |

`GET` 回：

```json
{
  "launches": [
    {
      "nodeId": "node-b",
      "workspaceId": "ws",
      "boardId": "board",
      "state": "waiting",
      "reason": null,
      "attempts": 0,
      "hasTask": true,
      "sessionId": null,
      "createdAt": "2026-09-25T08:00:00.000Z",
      "launchedAt": null,
      "dependencies": [
        {
          "id": "0192…",
          "workspaceId": "ws",
          "downstreamNodeId": "node-b",
          "upstreamNodeId": "node-a",
          "upstreamTitle": "Builder",
          "condition": "current",
          "state": "waiting",
          "reason": null,
          "baseline": {
            "state": "working",
            "eventAt": "2026-09-25T07:59:58.000Z"
          },
          "createdAt": "2026-09-25T08:00:00.000Z",
          "updatedAt": "2026-09-25T08:00:00.000Z",
          "expiresAt": "2026-09-26T08:00:00.000Z",
          "resolvedAt": null
        }
      ]
    }
  ]
}
```

- 下游 `state`：`waiting` / `launched` / `failed`（重试用完或启动行拼不出来）。
- 边的 `condition`：`current` 等上游手上这一轮，`next` 等上游下一次成功结束。创建时记下 `baseline`，之后只认基准之后的结束，旧 done 不会被重放成放行。
- 边的 `state`：`waiting` / `satisfied` / `failed` / `missing` / `expired` / `cancelled`。失败、中断、退出（`reason` 为 `upstreamFailed` / `upstreamInterrupted` / `upstreamExited`）、上游被删（`missing`）、过期（`expired`，`reason: "ttl"`）都不放行，由人取消那条边。`reason` 是稳定码，不翻译。
- 下游只在每条边都是 `satisfied` 或 `cancelled` 时启动。
- `DELETE` 回 `{ "dependency": {…} }`；别的工作空间的 id、不存在的 id 都是 404 `{ "code": "not_found", "message" }`。

## 9. 在线设备与编辑租约：`/api/workspaces/{workspaceId}/boards/{boardId}/presence|lease`

多台设备（或同一台上的多个窗口）看同一块画布时，谁在看、谁能写（设计 `design/canvas-platform-design.md` H04 的前置）。**全部在内存里**：core 重启后没有人在看任何画布，没有迁移、没有表。实现在 `core/canvas/presence.ts`。

一个客户端 = 一个页面标签或窗口，用自己生成的 `clientId`（`[A-Za-z0-9_-]{8,128}`）标识。每个客户端还记着它来自哪台**设备**：服务器壳上是请求会话绑着的身份域设备（`identity_devices`），桌面壳上一律是「本机」。同一台设备上的两个窗口仍是两个客户端、仍然只有一个能写，但快照里它们的 `deviceKey` 相同，页面据此说「本机另一个窗口正在编辑」、接管不再确认。显示用的 `deviceName` 优先取身份域登记的设备名，取不到才用客户端报上来的（截到 64 个字符）。

### 9.1 心跳与离开

| 方法与路径                     | 说明                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `POST …/presence`              | 心跳：`{ "clientId", "deviceName"?, "active"? }`，登记或续期，回 §9.4 的快照 |
| `DELETE …/presence/{clientId}` | 离开（切走画布、关页面）；没登记过的客户端离开也是 200                       |

- 页面的心跳由控制面上的订阅 `boards.presence` 承担（§36.4，core 每 10 秒替页面续期；取消订阅或断线即离开）；`active` 与「立刻问一次谁拿着租约」仍用 `POST …/presence`。**30 秒**没有心跳算断开，从表里摘掉。
- `active` 是「自上次心跳以来有没有被人操作过」，core 据此判断持有者是否空闲。
- 权限：心跳与离开只要 `canvas:read`（只读的客户端也要让别人看见自己）。
- 心跳的回答在 §9.4 的快照之外多一个 `writable`：发这次心跳的人有没有这块工作空间的 `canvas:write`，每次现判。为假时这个客户端照样登记在线，但**不会**拿到租约（下面的自动规则只在能写的客户端之间分），手里已有的租约也在这一拍交出，页面据此把画布当只读。事件里没有这个字段。
- 心跳与拿租约的回答还多一个 `deviceKey`：发这次请求的设备的标识（与 §9.4 里各客户端的 `deviceKey` 同一种写法）。它因人而异，事件里也没有；页面记下最近一拍的值，拿它和租约持有者的比。

### 9.2 拿租约与接管

`POST …/lease`：`{ "clientId", "deviceName"?, "takeover"? }`，回 §9.4 的快照。权限 `canvas:write`。

- 租约空着或本来就是自己的：直接给。
- 别人拿着且没带 `"takeover": true`：423 `canvas_lease_held`。
- 带 `"takeover": true`：无条件转给请求者。二次确认是页面的事（持有者与请求者 `deviceKey` 相同时页面不确认——同一个人）；原持有者此后的保存都会被 423 拒绝。从别的客户端手里接过来的那一次写一条审计 `canvas.lease.takeover`（`target` 为画布 id，`detail: { from, to, sameDevice }`，请求者的 principal 与设备由请求身份补上）。

租约的自动规则：

1. **单客户端无感**：租约空着时，唯一在看的客户端的第一次心跳就拿到它；只剩一个客户端时租约自动归它。没有写权限的客户端（§9.1 的 `writable` 为假）不参与分配。
2. 有别人在看时，空着的租约归**带 `active: true` 的心跳**或**带 `clientId` 的保存**，谁先到归谁。
3. 持有者断开（心跳过期或 `DELETE`）立刻释放；持有者空闲超过 **3 分钟**且有别人在看时释放。没人争时不因空闲释放。
4. **授权变化当场复判**（服务器壳）：授予、撤销、改角色、组成员增删、停用账号、撤销设备、登出之后，core 按每个客户端最近一次请求的会话重新认证并判一遍：看不见这块画布了的摘掉，只剩读权限的交出租约，变了就发一帧 `canvas.presence`。被撤销的一方手里的租约由此立即释放，不等 30 秒的心跳过期。

### 9.3 保存

`PUT …/document` 的请求体多一个可选字段 `clientId`。租约判定在 revision CAS **之前**：

| 情形                                             | 结果                                                |
| ------------------------------------------------ | --------------------------------------------------- |
| 租约在别的客户端手里（带不带 `clientId` 都一样） | 423 `{ "code": "canvas_lease_held", "message" }`    |
| 租约空着、带 `clientId`                          | 放行，并把租约给这个客户端                          |
| 租约空着、不带 `clientId`                        | 放行，不拿租约（没有身份的旧写者）                  |
| 自己持有                                         | 放行；之后照旧走 CAS，修订号旧了仍是 409 `conflict` |

`clientId` 格式不对是 400 `bad_request`。423 与 409 的处理完全不同：423 是「别人正在写」，页面转只读并按远端重载；409 是「手里那份旧了」，页面变基重放。core 自己的写者（控制动词、调度、依赖编排）直接调 `saveBoard`，不经过租约。

### 9.4 快照与事件

心跳、离开、拿租约都回同一个形状；事件流上的 `canvas.presence` 是同样的字段加上 `type`：

```json
{
  "type": "canvas.presence",
  "boardId": "0192…",
  "clients": [
    {
      "clientId": "5b7c…",
      "deviceName": "工作本",
      "deviceKey": "3f1a9c0e7b2d4a61",
      "lastSeenAt": "2026-09-26T08:00:10.000Z"
    },
    {
      "clientId": "9e21…",
      "deviceName": "iPad · Safari",
      "deviceKey": "",
      "lastSeenAt": "2026-09-26T08:00:04.000Z"
    }
  ],
  "lease": {
    "clientId": "5b7c…",
    "deviceName": "工作本",
    "deviceKey": "3f1a9c0e7b2d4a61",
    "acquiredAt": "2026-09-26T07:58:00.000Z"
  }
}
```

- `lease` 为 `null` 表示没人持有。`clients` 按 `clientId` 排序。
- `deviceKey` 是设备标识的摘要（16 位十六进制），不是身份域的设备标识本身；空串表示说不出来自哪台设备（匿名的旧写者）。只用来比较「是不是同一台」。
- 事件只在有人来、有人走、租约换手时发；普通的续期心跳不发，所以事件里的 `lastSeenAt` 可能落后，最新值以心跳的回答为准。
- `canvas.presence` **不进 outbox**（`core/events/stream.ts` 的 `EPHEMERAL_EVENTS`）：带游标续订的客户端不会补到过去的在线表，它重连后的第一次心跳自己会拿到当前那一份。

## 10. 账号、组、邀请与共享：`/api/identity/*` 的管理面

规格是 [服务器账号与共享](../design/server-accounts-and-sharing.md) §3；实现在 `core/identity/accounts-http.ts`。和 §3 同一个前缀、同一套认证（Origin、写操作的 CSRF、会话凭据）；CSRF 只在 Cookie 会话上核对——凭据是 `Authorization: Bearer` 的请求（桌面壳的原生传输、Gateway 的原生 App，§17.4）不是环境凭据，不要求也不核对 `X-Armadra-CSRF`。下表每一条非 `GET` 的路由都是写。失败的 `code` 是身份域的 UPPER_SNAKE（`UNAUTHENTICATED` / `PERMISSION_DENIED` / `INVALID_ARGUMENT` / `NOT_FOUND` / `CONFLICT`），做不到的是 501 `NOT_IMPLEMENTED`。

| 方法与路径                                                                                                                                         | 谁能调                                                                                                                            | 答案                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET principals`                                                                                                                                   | `identity:read`（成员登录即有）                                                                                                   | `{ principals: [{ principalId, kind, displayName, disabledAtMs, hasPassword, … }] }`                                                   |
| `POST principals` `{ displayName }`                                                                                                                | `identity:manage`                                                                                                                 | 201，新成员                                                                                                                            |
| `POST principals/{id}/disable`                                                                                                                     | `identity:manage`；owner 不能被停用                                                                                               | `{ disabled: true }`                                                                                                                   |
| `POST credentials` `{ kind: "password", principalId, password }`                                                                                   | 本人或 `identity:manage`                                                                                                          | 201 `{ credentialId }`                                                                                                                 |
| `GET/POST invitations`，`DELETE invitations/{id}`                                                                                                  | 指向工作空间的要那块的 `workspace:share`；只指向组的要能管那个组（`identity:manage` 或本组 `admin`）                              | 签发只在这一次返回明文 `token`（`<invitationId>.<secret>`）；作废后兑换是 401；组管理员的 `GET` 只列指向他所管的组、不带工作空间的那些 |
| `POST invitations/{id}/accept` `{ token }`                                                                                                         | 已登录的任何人                                                                                                                    | `{ role, groupId, workspaceId }`                                                                                                       |
| `POST register` `{ token, displayName, password, deviceName? }`                                                                                    | 匿名                                                                                                                              | 201，与 `login` 同形的会话，外加 `invitation: { role, groupId, workspaceId }`；不带 `token` 是 501（开放注册）                         |
| `POST login` `{ principalId, password, deviceName? }`                                                                                              | 匿名                                                                                                                              | 会话                                                                                                                                   |
| `GET/POST groups`，`PATCH/DELETE groups/{id}`，`PUT/DELETE groups/{id}/members/{principalId}` `{ role: "admin" \| "member" }`                      | 列表 `identity:read`；建、改名、删组 `identity:manage`；组成员与组内角色 `identity:manage` 或本组 `admin`（组管理员动不了 owner） | 组带 `members` 数组                                                                                                                    |
| `GET grants?workspaceId=`，`PUT grants` `{ workspaceId, subjectKind, subjectId, role }`，`DELETE grants` `{ workspaceId, subjectKind, subjectId }` | 该工作空间的 `workspace:share`（只有 owner 有）                                                                                   | `GET` 带编译后的 `permissions` 与角色表 `roles`                                                                                        |
| `GET audit?workspaceId=&principalId=&limit=`                                                                                                       | `identity:manage` 或 `workspace:share`                                                                                            | `{ entries }`                                                                                                                          |

角色是 `viewer` ⊂ `editor` ⊂ `operator` ⊂ `driver`，编译表只在 `core/identity/roles.ts`。

G5-02 追加：`POST credentials` 的答案多 `revokedSessions`（数字）：设成功之后撤掉这个人的其它会话（安全审查 L2）——本人换口令时留下发请求的这个会话，owner 或 `identity:manage` 替人设时那个人的会话全部撤掉；这个人手里还没用的口令重置令牌（§25）一并作废，审计 `identity.credential.set` 的 `detail` 多 `revokedSessions`。`POST invitations` 的 `ttlMs` 缺省 7 天、最长 30 天（安全审查 L3），更长的夹到 30 天，不是正整数答 400 `INVALID_ARGUMENT`；答案的 `expiresAtMs` 是夹过之后的。

**多次使用（A4-1，表 `identity_invitation_uses` 在迁移 `0040`）。** `POST invitations` 可带 `maxUses`（1–1000 的整数，其它值答 400 `INVALID_ARGUMENT`；省略 = 一次性，沿用旧行为）；答案与 `GET invitations` 的每一项多 `maxUses`（一次性为 `null`）与 `uses`（已兑换的不同的人数）。兑换（`accept`、口令注册、云登录）在同一笔事务里以 `uses < max_uses` 的条件 UPDATE 计数并记下是谁，并发的第 N+1 个什么也改不动、答 401；同一个人再次兑换是幂等成功，不加计数、用满之后也仍成功（过期、作废之后不行）。用满时 `consumedBy` / `consumedAtMs` 记最后一位与时刻，作废沿用空主体。替某人签发口令重置链接是 `POST principals/{id}/password-reset`，见 §25。

**判定在哪里生效**（R8）：

- **成员会话的授权快照只有 `identity:read`**，共享得来的授权每次判定时现编（`Authorizer.permits` = 快照 ∪ 现编）。所以撤销一条共享之后的**下一个请求**就是 403，不用等会话过期。`GET session` 报的 `scopes` 是现编之后的那份。
- **路由门**（`core/identity/route-access.ts`，挂在 `core/http/server.ts` 分发之前与升级之前）：路由表声明的 scope（`core/http/route-scopes.ts`）按这次请求的主体判，不够是 403 `{ "code": "forbidden", "message" }`。只在服务器壳上有请求主体；桌面壳里一律放行。全局路由对成员逐条归类，权限表在 [设计](../design/server-accounts-and-sharing.md) §6：按对象落到工作空间的（Agent 状态、被读取、审批答复、关闭确认按节点或请求所在的画布判），无害的全局读（Agent 目录、模型、模型目录、终端后端、公开状态页，被共享过任意一块画布即可），其余本机管理一律 403。`GET /api/workspaces` 放行但只留他有 `canvas:read` 的；`PATCH/DELETE /api/workspaces/{id}` 要 `workspace:share`；终端：创建要 `terminal:create@workspace`（按请求体的 `workspaceId`），写自己开的要 `terminal:create`、写别人的（含附着 `…/ws`）要 `terminal:drive`。「自己开的」按 `terminal_sessions.creator_principal_id`（迁移 0028）判，core 重启之后照旧。
- **事件流**：升级前要 `events:read@workspace`；授权一变（授予、撤销、组成员、停用、撤销设备、登出）已开的订阅当场复核，不再有权的以关闭码 **4403** 关掉，重连在升级前拿到 403。

## 11. 节能休眠：`POST /api/terminals/{sessionId}/wake`

空闲的 Agent 会话被结束以释放内存、之后用 CLI 自己的 resume 接回来（设计 `design/terminal-host-design.md` §7.2）。没有新表：休眠就是那一行 `terminal_sessions` 以 `termination_intent = 'hibernate'` 结束，恢复要的 cwd、shell、Agent、provider 会话 id（`agent_status.session_id`）、权限模式与模型都已经在库里。权限与其余终端路由同一档（`terminal:write`）。

- `GET /api/terminals/{sessionId}` 与其余回会话行的路由多一个字段 `hibernation`：以休眠结束的行是 `"hibernated"`，其余恒为 `null`。页面据此不替节点新建会话。
- `POST /api/terminals/{sessionId}/wake`：在**同一个会话 id** 上起下一代，敲 CLI 的恢复行（Claude `--resume <id>`、Codex `resume <id>`……形状来自 `agent/launch.ts` 的注册表），等前台变成这个 Agent，回会话行（`status: "running"`、`generation` 加一）。节点已经醒着（别处先叫醒了，或者有人重新起过）就回它现在的那一行，不起第二个。接不回来是 409 `{ "code": "wake_failed", "message" }`；会话不属于任何节点、节点没有休眠也没有活会话是 409 `not_hibernated`。
- 工作空间事件 `terminal.hibernation`：`{ "type": "terminal.hibernation", "sessionId", "nodeId", "state", "reason"? }`，`state` 是 `hibernated`（进程确认结束之后才发）/ `resuming` / `running` / `failed`。`reason` 在 `resuming` / `running` 时是唤醒来源（`focus` / `delivery` / `schedule`），在 `failed` 时是稳定码（`noProviderSession`、`spawnFailed`、`agentDidNotStart` 等），不翻译。
- 资源采样里休眠的会话照列，`unknownReason: "hibernated"`、`alive: false`、各项数字为 `null`。
- 设置：`terminal.ecoMode`（布尔，缺省 `true`）、`terminal.ecoIdleMinutes`（5–1440，缺省 30）。

## 12. CLI 协作的补充形状

设计见 [CLI 接入、通信与共享上下文](../design/cli-collaboration.md)。

### 12.1 成本行的 `unit` 与 `requests`

`GET /api/usage/cost` 与 `POST /api/usage/cost/refresh` 里每个 agent 的成本行（`ranges.*.byAgent[]` 与 `ranges.*.points[].agents[]`）多两个字段（代码在 `core/usage/cost.ts` 的 `AgentCost`，共享层 `costAgentSchema`）：

- `unit`：`"tokens"` 或 `"premiumRequests"`。共享层缺省 `"tokens"`。
- `requests`：`unit` 为 `"premiumRequests"` 时的请求数；`"tokens"` 的行恒为 0。共享层缺省 0。

```json
{
  "agent": "copilot",
  "source": "local",
  "unit": "premiumRequests",
  "requests": 37,
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0 },
  "costUsd": 0,
  "complete": true
}
```

- 目前只有 Copilot 按请求计。来源是 `session-state/<id>/events.jsonl` 里 `session.usage_checkpoint` 的 `totalPremiumRequests`，那是**会话累计值**：每条只把比上一条多出来的部分记到它自己的时间点上，所以一个会话跨几个窗口时各窗口各算各的增量，合起来等于最后一条的值。累计值变小视为会话从头计。
- 请求数不折算成 token 或金额：这一行的 `tokens` 为零、`costUsd` 为 0、`complete` 为 `true`。
- 窗口合计（`totals`、`today`、`last30Days`、`daily`）、`byModel`、`peak` 与 `unpricedModels` 只合并 token，不含请求数；`sessions` 与 `activeIntervals` / `longestStreak` 把只有请求数的会话和时间段也算进去。`currentSession` 只看按 token 计的会话。
- 只有请求数而没有 token 时，`status` 仍是 `"ok"`。
- OpenCode 按 token 计（`source: "local"`、`unit: "tokens"`），用量来自它库里 assistant 消息的 `tokens`。定价规则不变：价格表认得的模型按表算；认不出、而 OpenCode 自己在消息里记了大于零的 `cost` 时，用它记的数作这个模型的 `costUsd`，这个模型算有价格（不让 `complete` 变假，也不进 `unpricedModels`）。它记 0 的按没有价格处理。

G5-25 追加：`GET /api/usage` 与 `POST /api/usage/refresh` 里 Claude 那一行因出站政策关着而是 `status: "unavailable"`、`reason: "policy_off"` 时，多一个可选字段 `estimate`（代码在 `core/usage/local-window.ts`，共享层 `usageEstimateSchema`）——本机转录估出来的额度窗口，不是额度端点的答案，界面标「本地估算」：

```json
{
  "source": "local",
  "windows": [
    {
      "key": "five_hour",
      "label": "5h",
      "windowStartMs": 1791093600000,
      "resetsAtMs": 1791111600000,
      "used": 1250000
    },
    {
      "key": "seven_day",
      "label": "7d",
      "windowStartMs": 1790524800000,
      "used": 8400000
    }
  ]
}
```

- 数据是成本扫描（本节上文）最近一趟的 Claude 日桶与小时桶，读快照时现算；成本扫描关着（`usage.cost.enabled`）或还没扫过就没有这个字段。设置 `usage.claudeLocalWindow`（缺省 `true`）关掉也没有。
- `used` 是输入 + 输出 + 缓存写的 token；缓存读不计。
- `five_hour`：从上一个窗口之外第一条活动所在的本地整点起算，持续 5 小时，`resetsAtMs` 是结束时刻；最近的窗口已经结束时报从当前整点起、`used: 0`、没有 `resetsAtMs` 的窗口（下一条活动才开窗口）。`seven_day`：含今天在内的 7 个本地日，滚动，没有 `resetsAtMs`。
- `limit` 只在知道这一档额度时才有；没有就只报用量，页面不算百分比。

### 12.2 `/api/agents` 行的历史数据可用性

`GET /api/agents` 的每一行（内置与 `custom:` 条目）多一个 `history`，说本机有没有这家 CLI 的本地历史，三项分别对应会话索引、本地成本与连线读取的转录（代码在 `core/history/availability.ts`）。不新开路由；共享层 `agentInfoSchema.history` 可选，旧 runtime 不带这个字段时页面不画这三项。

```json
{
  "id": "opencode",
  "history": {
    "index": "available",
    "cost": "available",
    "transcript": "not-found"
  }
}
```

每项取值四选一，按顺序判：

- `unsupported`：这家没有历史适配器（`HISTORY_ADAPTERS` 里没有它），三项都是；适配器没有成本来源时只有 `cost` 是。
- `disabled`：`custom:` 条目关掉了 `contextLink`，只影响 `transcript`。
- `not-found`：适配器的根目录一个都不存在。
- `available`：至少一个根目录存在。

`custom:` 条目按它的 `baseAgent` 找适配器。只 stat 根目录、不扫描文件，所以 `available` 只说明「有地方可读」，不保证有会话或有成本；页面对 `not-found` 与 `unsupported` 写状态词，不写成 0。

### 12.3 投递终态回执

排队项（`agent_send_queue`）因为过期、目标侧拒收或出队时门链拒绝而结束时，core 往发送方的收件箱写一条回执（迁移 0029 的 `settled_by` / `notified_at`，代码在 `core/collab/receipts.ts`）。发送方自己取消的（`canvas cancel`），以及发送当下就拿到拒绝回执的（如 `--no-queue`），不写。

`canvas inbox` 的每一行多一个 `kind`：`"message"` 是同级消息，`"receipt"` 是回执。回执行的 `from` / `fromTitle` 是**那条投递的目标**，`key` 是 `receipt:<queueId>`，正文写目标名、原因（最后一次没投出去的码）、尝试次数（为 0 时省略）与正文字数，不带原消息正文：

```json
{
  "sequence": 12,
  "id": "<mailbox id>",
  "from": "<目标节点 id>",
  "fromTitle": "审查",
  "fromHandle": null,
  "fromRole": "peer",
  "kind": "receipt",
  "key": "receipt:<queueId>",
  "body": "投往「审查」的消息已过期（TARGET_BUSY，正文 412 字）。",
  "createdAt": 1790000000,
  "expiresAt": 1790086400
}
```

- 三种正文：`已过期`（清扫）、`被对方拒收`（`DELETE /api/workspaces/{id}/deliveries/{queueId}`）、`在出队时被拦下`（门链硬拒绝；尝试次数含被拦下的那一次）。
- 原因是 `TARGET_NOT_AT_PROMPT`（目标终端停在 CLI 自己的对话框上，见 `agent-delivery.md` §4.3「画面门」）时，码后面补一句人话：`（TARGET_NOT_AT_PROMPT：对方终端停在 CLI 的对话框上，没有替人回答，正文 4 字）`。其余码原样写。
- 回执不计入收件箱唤醒，也不占 `MAX_PENDING`；`post` 拒绝以 `receipt:` 开头的 key（400 `key_invalid`）。
- 每条终态同时写一行投递记录（`GET /api/workspaces/{id}/deliveries`，`outcome` 为 `expired` 或 `cancelled`，`receipt` 是队列 id），并发 `agent.delivery` 事件：`{ "type": "agent.delivery", "traceId", "sourceNodeId", "targetNodeId", "outcome": "expired" | "cancelled", "code"? }`，`code` 是最后一次没投出去的码。
- 发送方节点已经不在画布上、目标节点已经不在画布上（收件箱外键填不了），或者是收件箱唤醒（来源就是目标自己）时不写回执，投递记录与事件照发。
- 每条终态只通知一次；清扫只删回执已经写过的、或者不需要回执的终态行。

### 12.4 Armadra Agent 的模型密钥：`/api/agents/ama/credentials`

设计见 [协调 Agent](../design/coordinator-agent.md) §7。代码在 `core/agent/ama-credentials.ts`，共享层 `amaCredentialStatusSchema`。

| 方法与路径                                      | 请求体              | 答复                     |
| ----------------------------------------------- | ------------------- | ------------------------ |
| `GET /api/agents/ama/credentials`               | —                   | 状态                     |
| `PUT /api/agents/ama/credentials/{provider}`    | `{ "apiKey": "…" }` | 状态（已存）             |
| `DELETE /api/agents/ama/credentials/{provider}` | —                   | 状态（删一个不在的也成） |

```json
{
  "backend": "keychain",
  "providers": [
    { "id": "anthropic", "isSet": false },
    { "id": "deepseek", "isSet": true }
  ]
}
```

- 答复**从不带值**，只有每家是否已设与后端（`keychain` / `dpapi` / `libsecret` / `file-encrypted` / `file`）。供应商列表由 core 给（ama 需要 key 的内置供应商），页面不自己列；不在列表里的 `provider` 答 `400 bad_request`，`apiKey` 不是非空单行也是 `400`；密钥后端打不开答 `503 secret_unavailable`。
- 每家一条密钥条目 `armadra-ama-<provider>`，这是值唯一的落点。不写任何 key 文件，profile 没有 `authFile`（ama 自己用户级的 `auth.json` 与登录照常可用）。
- 怎么到 ama：与节点凭据（§20.4）同一条兑换路。画布启动器 `run/ama` 在 `ARMADRA_NODE_ID` 门之后调 `armadra-hook credential --ama`，后者带节点 token 经本机 hook 通道 `POST /credential/ama`（体 `{ "nodeId": "…" }`）兑换；门与 `/credential` 相同（应用 bearer、节点 token 必须验过），外加节点在画布上是 ama（或以它为基础的自定义 Agent），否则 `403 forbidden`；密钥后端打不开 `503 secret_unavailable`。答复 `{ "variables": [{ "variable": "AMA_API_KEY_DEEPSEEK", "value": "…" }] }`，带 `cache-control: no-store`、不记日志。启动器只认 `AMA_API_KEY_<供应商>` 这十五个名字，设在自己的进程里再 `exec` ama：值不进节点 shell 的环境、启动行与 shell 历史，不落盘（启动器按换行切答复，不用 here-doc）。兑换失败或名字不认识时拒绝启动；一个都没设时照常启动。ama 起的子进程不继承 `AMA_*`（ama 自己剥掉）。
- **只答节点用得到的那一家**（安全审查 L10）：core 读节点数据的 `agent.model`（ama 的 `<供应商>/<模型>`，或带 `provider` 字段的对象），只答这一家的变量；这一家不收密钥（`ollama`、`lmstudio`、`chatgpt`、ama 自己 config 里的自定义供应商）时 `variables` 为空。节点没设模型时 ama 从已设的里挑缺省，只能答全部已设的，并记一条审计 `ama.credential.unscoped`（`target` 是节点标识，`detail` 只有 `{ reason: "no_model" }`）。运行中在 ama 里换到别家的模型拿不到那家的密钥，要在节点上改模型后重启。
- Windows：启动器 `run\ama.exe` 的 `.launch` 带 `ama-keys=<客户端>` 与 `ama-var=<名字>` 行，做同一段兑换（客户端子进程的标准输出按换行切，`\r\n` 也认）。
- 限制：执行主机（SSH）那份不做这段兑换，那里的 ama 只用它自己的 `auth.json` 与环境变量。
- 权限：`/api/agents` 一族，读 `settings:read`、写 `settings:write`。

## 13. 画布启动器

设计见 [画布启动器](../design/canvas-launcher.md)。注入（Hook、技能、画布说明）不再写在敲进节点 shell 的启动行上，而由数据目录里每个 CLI 一个的启动器 `integration/run/<cli>`（Windows `run\<cli>.exe`）在 CLI 启动时追加；启动器只在环境里有 `ARMADRA_NODE_ID` 时注入，没有时原样启动程序。启动行只剩「启动器 + 程序 + 程序前置词 + CLI 自己的旗标」。

### 13.1 `GET /api/agents` 行的 `launcher`

每一行（内置与 `custom:` 条目）多一个可选的 `launcher`：这台机器上这家 CLI 的启动器的绝对路径（代码在 `core/agent/list.ts`，来自集成状态；共享层 `agentInfoSchema.launcher`）。`custom:` 条目答它 `baseAgent` 的。

```json
{
  "id": "codex",
  "resolvedPath": "/opt/homebrew/bin/codex",
  "launcher": "/Users/me/Library/Application Support/Armadra/integration/run/codex"
}
```

- 缺席：还没生成、启动器层的标记 `integration/launcher.json` 不是当前修订或当前平台、Windows 没有 `armadra-launch.exe`。这时调用方拼**裸行**（程序 + 旗标，不注入），不回到把注入写在行上。
- 拼法：`<launcher> <程序> [程序前置词…] <旗标…> [prompt]`。程序是 `launchTarget.program` / `resolvedPath` / `launchCmd` 中先有的那个（用户的启动命令覆盖优先），前置词是 `launchTarget.args`。启动器把注入接在调用者的全部参数之后，所以 prompt 在行上时注入的旗标落在它之后。
- 自己 exec 的调用方（探针）直接 exec `<launcher> <程序> …`，并在环境里带 `ARMADRA_NODE_ID`。要看注入本身，读 §13.2 的 `launchArgs`。
- **下线**：当前 core 不再答 `launchWords` 与 `launchArgs`。共享层把这两个字段留作可选、标为弃用一个版本：新页面对没有 `launcher` 的旧 core 退回读它们；旧页面对新 core 两个字段都读不到，拼出裸行（不注入，也不会截断）。
- 自 0.2.0 起 `launchWords` / `launchArgs` 不再出现在 `GET /api/agents` 的行上：共享层 schema 去掉了这两个字段与 `launchWordSchema`，页面不再有旧 core 退路（§13.2 的 `launchArgs` 不受影响）。
- SSH 节点不受影响：行仍是裸的 `<程序名> <旗标…>`，由执行主机 `PATH` 最前面的远端垫片交给远端启动器。

节点终端的环境（`POST /api/terminals` 带 `agent` 与 `nodeId` 时、依赖编排、冷启动、节能唤醒）里，画布这一半只有两个变量：`ARMADRA_SHIMS=<数据目录>/integration/shims` 与以它开头的 `PATH`（其后与普通终端的 `PATH` 相同）。`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`、`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`、`ARMADRA_CODEX_HOOK`、`ARMADRA_CODEX_INSTRUCTIONS` 不再出现在终端环境里：前三个由启动器只给 CLI 进程设，后两个已删除。SSH 节点的终端不带这两个（远端的 `ARMADRA_SHIMS` 由远端 shell 命令设）。§5 列的地址变量不变。

### 13.2 `GET /api/agents/{id}/integration` 的状态字段

代码在 `core/hook/install/integration.ts`，共享层 `integrationStateSchema`。

| 字段              | 变化                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `launchArgs`      | 保留：启动器追加的字面 argv（显示与探针用）                                                                            |
| `launchEnv`       | 保留：启动器给 CLI 进程设的变量名                                                                                      |
| `launchWords`     | **删除**                                                                                                               |
| `globalWrites`    | 恒为 `[]`（数据目录之外不写任何文件）；字段留一个版本给旧页面                                                          |
| `launcher`        | 新增，可选：`run/<cli>` 的绝对路径，存在且是当前修订时才有                                                             |
| `shim`            | 新增，可选：`shims/<cli>` 的绝对路径，存在时才有                                                                       |
| `launcherWarning` | 新增，可选：画布内启动少带了东西的原因——Windows 没有 `armadra-launch.exe`；Codex 版本低于 0.134.0，画布内启动不带 Hook |
| `hook.installed`  | 对 Codex 只看产物，不再看信任记录；Codex 的 `hook.path` 是它的启动器（有时）                                           |

```json
{
  "agentId": "codex",
  "mode": "canvas",
  "launchArgs": [
    "--dangerously-bypass-hook-trust",
    "-c",
    "check_for_update_on_startup=false",
    "…"
  ],
  "launchEnv": [],
  "globalWrites": [],
  "launcher": "/…/integration/run/codex",
  "shim": "/…/integration/shims/codex"
}
```

### 13.3 迁移记录 `version: 2`

`<数据目录>/integration/global-migration.json`（代码在 `core/hook/install/migrate.ts`）。`version: 2` 在 v1 的 `agents` 之外多一个 `sessionTrust`：把旧版本写进 `~/.codex/config.toml` 的 `/<session-flags>/config.toml:*` 信任记录清掉的那一步。没有记录的机器 v1、v2 一起跑；已有 `version: 1` 的只跑 v2 并把记录升版，`agents` 原样保留。`ARMADRA_NO_GLOBAL_WRITES=1` 时都不跑。

```json
{
  "version": 2,
  "migratedAt": "2026-10-02T08:00:00.000Z",
  "agents": { "codex": { "removed": [], "backups": [] } },
  "sessionTrust": {
    "at": "2026-10-02T08:00:00.000Z",
    "path": "/Users/me/.codex/config.toml",
    "removed": ["/<session-flags>/config.toml:session_start:0:0"],
    "backup": "/Users/me/.codex/config.toml.armadra-backup-20261002080000"
  }
}
```

- `path` 缺席：这台机器没有 Codex 的配置目录（不建）。`removed` 为空、没有 `backup`：文件里没有这类键，字节没变。`error`：文件认不出，没有改写。
- 集成状态（§13.2）里 Codex 的 `migration.sessionTrust` 是同一份：`{ at, removed, backup?, error? }`。

### 13.4 Worker 能力 `remote.integration.v2`

- 新 Worker 在握手里多报 `remote.integration.v2`（`core/remote/operations.ts::INTEGRATION_V2_CAPABILITY`）。`integration.sync` 不再接受 `codexCommand`（收到就忽略），答复只有 `{ missing, written }`，没有 `trustChanged`；`integration.locate` 不变。
- 新 Worker 在第一次 `integration.sync` 时对执行主机的 `~/.codex/config.toml` 做一次 §13.3 的第二步，记进它状态目录下的 `integration/global-migration.json`。
- 控制端只要求 `remote.integration.v1` 就能同步，且不再发 `codexCommand`（旧 Worker 只在收到它时写信任）。只有 v1 的主机控制端记为「Worker 旧」：它之前写下的 Codex 信任记录要等 Worker 升级后才会被清。
- 远端注入文件改为与本机同一个生成器：`run/<cli>`（POSIX 启动器）与委托给它的 `shims/<cli>`。

## 14. ACP：`/api/acp/*` 与 `/api/agents` 行的 `acp`

> 自协议 1.12 起这些路由同时是 `acp.*` procedure（§43.1），旧路径与 procedure 调同一份实现。

设计见 [ACP 会话视图](../design/acp-session-view.md) 与 [补全架构](../design/completion-architecture.md) §5.1。ACP 是同一个终端节点的另一种驱动方式；协议栈是 `@armadra/agent/acp`（精确版本），core 只包装它的 `AcpClient`（`core/acp/client.ts`）。

### 14.1 `GET /api/agents` 行的 `acp`

每一行多一个可选的 `acp`：这家 CLI 在这台机器上怎么说 ACP（代码在 `core/agent/list.ts`，表在 `core/acp/adapters.ts`；共享层 `agentAcpInfoSchema`）。`custom:` 条目答它 `baseAgent` 的；没有 ACP 入口的行不带这个键。

```json
{
  "id": "codex",
  "acp": {
    "support": "official",
    "program": "codex-acp",
    "installed": true,
    "version": "1.10.2",
    "resume": "load"
  }
}
```

| 字段        | 含义                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support`   | `native`（CLI 自带入口：`opencode acp`、`omp acp`、`copilot --acp`、`ama --mode acp`）/ `official`（官方适配器）/ `community`（社区适配器 `pi-acp`） |
| `program`   | 在补齐过的 `PATH` 上找的程序名：`claude-agent-acp`、`codex-acp`、`opencode`、`pi-acp`、`omp`、`copilot`、`ama`                                       |
| `installed` | `program` 每次请求都按 `resolveCommand`（与 `resolvedPath` 同一条规则）探，不缓存                                                                    |
| `version`   | 可选：本进程最近一次对这家起会话或探测时 `initialize` 报的 `agentInfo.version`。列表从不为它起进程，没有就缺席；`installed: false` 时也缺席          |
| `resume`    | 跨进程接回用哪个方法：`load`（`session/load`，回放）/ `resume`（`session/resume`，不回放）/ `none`（只能新开，Copilot；这样的会话不休眠）            |

- 七家的表：`claude` 官方 `load`、`codex` 官方 `load`、`opencode` 原生 `load`、`pi` 社区 `load`、`omp` 原生 `load`、`copilot` 原生 `none`、`ama` 原生 `resume`。`resume` 是偏好：起会话时按 Agent 在 `initialize` 声明的能力协商，偏好的方法不支持就用另一个，两个都不支持就新开并如实告诉页面没有接上。
- 权限模式在 ACP 下的落点（`session/set_mode` 的模式 id 或启动 argv）不在行上；没有落点的模式（OpenCode 的 `auto-edit` / `full-auto`，Pi 除 `default` 外的三个）不出现在会话视图里，以它起会话答 `acp_mode_unsupported`。`plan` 在 Agent 不提供对应模式 id 时拒绝启动（`acp_mode_unavailable`），不以可写模式起。
- 起会话失败的错误码（G2-1 的路由原样答出，形状 `{ code, message }`）：`acp_not_installed`、`acp_spawn_failed`、`acp_exited`、`acp_initialize_failed`、`acp_initialize_timeout`、`acp_protocol_version`、`acp_auth_required`（Agent 要先在 CLI 里登录）、`acp_session_failed`、`acp_mode_unsupported`、`acp_mode_unavailable`。消息里不带适配器的 stderr。
- 实跑验证过的版本区间记在 `tools/release/compatibility.json` 的 `acp` 键（`{ protocolVersion: 1, adapters: { <id>: { program, verified: null | { min, max? } } } }`），不进发布说明的兼容围栏；`program` 与适配器表由测试对齐。
- 状态来源词汇多一个 `acp`（`agent_status.state_source`）：由 core 在 ACP 驱动的会话上写入，与 `hook` / `extension` 一样算上报（`stateSourceIsReported`），客户端无法自称。

### 14.2 会话路由 `/api/acp/*`

实现：`apps/desktop/src/core/acp/routes.ts`；形状：共享层 `api/acp.ts`。ACP 会话**就是** `terminal_sessions` 的一行（`backend: "acp"`，§5.1 的会话行形状不变），所以行、代次、人类租约（`POST /api/terminals/{id}/drive`）、`terminate`、`wake`、会话侧栏都照旧作用于它。路径里的 `{sessionId}` 是这一行的 id，不是 ACP 会话 id。权限与终端同一档：读要 `terminal:read`，开会话要 `terminal:create`（记创建者），往别人开的会话里写要 `terminal:drive`，按会话行查画布。

| 方法与路径                              | 请求                                                                               | 应答                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST /api/acp/sessions`                | `{ workspaceId, nodeId, cwd, agentId, permissionMode?, model?, resume?, prompt? }` | `200` 会话行（§5.1，`backend: "acp"`）                                                                        |
| `POST /api/acp/sessions/{id}/prompt`    | `{ text }`                                                                         | `200 { turnId }`；回合的结局经 `acp.turn`（§14.3）                                                            |
| `POST /api/acp/sessions/{id}/cancel`    | 无                                                                                 | `204`；`session/cancel`，挂起的审批一律回 `cancelled`                                                         |
| `POST /api/acp/sessions/{id}/mode`      | `{ modeId }`                                                                       | `204`                                                                                                         |
| `GET /api/acp/sessions/{id}/log?after=` | 无                                                                                 | `200 { entries: TranscriptEntry[], endOffset, modes: { currentModeId, availableModes[] } \| null, pending? }` |
| `POST /api/acp/nodes/{nodeId}/driver`   | `{ driver: "acp" \| "terminal" }`                                                  | `200 { sessionId, resumed }`                                                                                  |

- **起会话**：`nodeId` 不必已经在画布文档里（新建向导先起会话、节点随后落盘）；同一个节点已经有活着的 ACP 会话时答那一行（两台设备同时挂载、重试都不起第二个）；有活着的**终端**会话时 `409 conflict`（先切换驱动）；节点最近那一行是结束了的 ACP 行时在同一行上起下一代并接回。`prompt` 在会话开好后作为第一条提示发出（人类驾驶者）。没有 ACP 入口的 Agent 答 `400 acp_unsupported`；起不来的原样答 §14.1 的错误码（`acp_not_installed` 400、`acp_mode_unsupported` 400、`acp_mode_unavailable` 409、`acp_auth_required` 409、其余 502）。`custom:` 条目借基础 CLI 的适配器；基础 CLI 自己就是 ACP 入口（`native`）时，条目的 `launchCmd` 与 `args` 顶替表里的程序。
- **提示**：等同在终端里敲一行并回车——经 `writeSubmit`，人类驾驶者（抢占租约，永不被拒）。同一会话一次一个回合，后到的排队。会话行已经结束（休眠、core 重启、适配器自己退了）时先在**同一行**上起下一代并以 CLI 会话 id 接回，再发；这一行已被节点的另一行取代时 `409 conflict`。
- **镜像**：`entries` 是镜像 `<数据目录>/acp/<nodeId>/<ACP 会话 id>.acp.jsonl` 从字节偏移 `after` 起的完整记录（`TranscriptEntry`：`{ role: "user" | "assistant", blocks[], endOffset, at? }`，相邻的助手文本已合并），`endOffset` 是下一次的 `after`。**core 先写镜像再发 `acp.update`**：页面先订阅再读，读回来之前到的分块已经在 `entries` 里。镜像只记对话：我方的提示、助手文本、工具调用（`tool_use`）与它的终态结果（`tool_result`，正文截到 8000 字符）；思考、计划、用量、模式变化只经事件。`modes` 与 `pending`（挂起的审批，形状 `{ pendingId, protocol: "acp", toolCall, options[] }`）描述活着的进程，没有进程时 `modes: null`、无 `pending`。
- **驱动切换**（ACP 设计 §4.2）：节点在 `blocked` / `waiting` 时 `409 awaiting_approval`；SSH 节点两种驱动都起在执行主机上（§26.5）。否则结束当前驱动（终端先敲 CLI 的退出命令等它自己退，再结束；ACP 回合里先 cancel 再收掉进程），行以 `termination_intent = 'switch'` 结束；再在**同一行**上以另一种驱动起下一代（代次 +1，行 id 不变）：ACP 侧以 `agent_status.session_id` 接回（适配器表 `resume: "none"` 的新开），终端侧起 shell 并敲 CLI 的恢复行（不能续接时敲普通启动行）。`resumed` 如实说接上了没有。已经是目标驱动且活着时什么都不动，答 `resumed: true`。切换期间节点算「睡着」，`send` 排队。节点数据里的 `agent.driver` 由页面写回（不进撤销栈）。
- **§26 追加**：`PUT /api/acp/sessions/{id}/model { modelId }` → `204`（§26.2）；`GET …/log` 多 `models`（形状同 `modes`，`{ currentModelId, availableModels: [{ modelId, name, description? }] } | null`）与 `elicitations`（挂起的 elicitation，§26.1），后者与 `pending` 一样只在有进程时出现。
- **其余路由在 ACP 行上**：`GET /api/terminals/{id}/ws` 升级前答 `409`（没有 PTY 可附着）；`POST …/paste` 只收带回车的整段（`enter: false` 答 `409 acp_no_raw_write`）；`GET …/capture` 是镜像尾部渲染成的散文；`terminate` 的 `interrupt` 是 `session/cancel`。协作动词与调度经终端桥写入：`writeSubmit`（括号粘贴 + 回车）落为 `session/prompt`，单个 `ESC` 落为 `session/cancel`，其他字节答 `acp_no_raw_write`。

### 14.3 事件

工作空间事件流（§5）多三种，`sessionId` 一律是会话行 id（一行一帧）：

```text
{ "type": "acp.update", "sessionId": "…", "nodeId": "…", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "…" } } }
{ "type": "acp.turn", "sessionId": "…", "nodeId": "…", "turnId": "3-2", "stopReason": "end_turn" }
{ "type": "acp.driver", "nodeId": "…", "driver": "terminal", "sessionId": "…", "resumed": true }
```

- `acp.update.update` 是 ACP `session/update` 的 `update` 原样（v1 规范字段；`_meta` 不解释）；core 发出的一条之前已经写进镜像。我方发出的提示也以一条 `user_message_chunk` 发出，别的设备看得见是谁说了什么。`session/load` 的回放从不发出。
- `acp.turn`：一次提示的结束。`stopReason` 是规范的五个值之一；提示以 JSON-RPC 错误结束时没有 `stopReason`，带 `error: { code, message }`（`acp_protocol`，或进程没了时 `acp_exited`）。
- `acp.driver`：一次切换完成（§14.2）。
- 状态不另起事件：ACP 会话的状态经同一条 `agent.status` 发出，`status.stateSource = "acp"`。归一化（ACP 设计 §5.4）：我方发出提示 → `working`（新回合），工具调用 → `working`，`request_permission` → `blocked`（带 `pendingId`），答了或取消了 → `working`，`end_turn` / `max_tokens` / `max_turn_requests` → `done`，`cancelled` → `done` + `interrupted`，`refusal` 或错误 → `done` + `errored`；会话开好（新开或接回）→ `session` / `start`，`sessionId` 是 ACP 会话 id、`transcriptPath` 是 CLI 自己的转录（会话 id 对得上且本地找得到时）或镜像。适配器退出走终端退出（`terminal.exit`），与 PTY 死掉同一条路。

### 14.4 审批

`session/request_permission` 进现有的 `agent_approvals`，`pendingId` 形如 `<nodeId>-<epochMs>-acp-<n>`，`request_json` 为 `{ "protocol": "acp", "toolCall": {…}, "options": [{ "optionId", "name", "kind" }] }`；`agent.approval` 事件的 `request` 是这条审批记录（ACP 载荷在它的 `request` 字段里）。

- 答复：`POST /api/approvals/{pendingId}/answer { decision: "allow" | "deny", optionId? }`。ACP 审批的 `optionId` 必须是 Agent 给的选项之一且与 `decision` 同类（`allow_*` / `reject_*`），否则 `400 bad_request`（审计记 `option_invalid`）；不给 `optionId` 时取第一个同类选项（节点头的允许 / 拒绝）。别的审批带 `optionId` 同样 `400`。先记录（CAS 不变），再送达：应答的 `route` 为 `acp` 表示已回到挂起的请求，`none` 表示进程已经不在。
- 回合被取消、适配器退出、切换驱动、休眠：挂起的请求一律回 `cancelled`，审批行 `answer = "cancelled"`、`answered_by = "core"`，审计照写（`route: "acp"`），并以 `agent.approval`（`request.resolved = true`、`decision: "cancelled"`）通知各端收起按钮。core 启动时把上一个进程留下的未答 ACP 审批同样记成 `cancelled`。
- core 从不替人选项，也从不自动回答 `request_permission`；`allow_always` 由适配器自己在进程内记忆。
- **§26 追加**：`elicitation/create` 同样进 `agent_approvals`（`request_json = { protocol: "acp", elicitation }`，状态 `waiting` 带 `pendingId`），答复体多一种 `{ elicitation: { action, content? } }`，见 §26.1。

### 14.5 输出到画板：`POST /api/workspaces/{workspaceId}/exports/{exportId}/text`

会话视图把 Agent 回复里的代码块落成编辑器节点（[ACP 会话视图](../design/acp-session-view.md) §7）时先把代码写成文件。`exportId` 是来源 Agent 节点的 uuid；文件落在工作区根下 `.armadra/exports/acp/<exportId>/<name>`，`.armadra` 带自忽略的 `.gitignore`，不进 `git status`。通用文件路由不允许在 `.armadra` 里建目录，所以这是单独一条路由，与 PNG 导出（`…/exports/{exportId}/png`）同一张权限表（`assets:read`）。

```json
{ "name": "msg-3-1.ts", "content": "export const a = 1;\n" }
```

答复与 PNG 导出同形：`{ "path": "<绝对路径>", "relativePath": ".armadra/exports/acp/<exportId>/msg-3-1.ts", "bytes": 20 }`。同名覆盖。

- `name` 是单个文件名：`[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}`，不含 `..`；`exportId` 不是 uuid、`name` 不合规、缺 `name` / `content`、正文超过 1 MiB 一律 400 `bad_request`。
- 只读打开的工作空间 403 `forbidden`。远端工作空间不再答 501：经 Worker 操作 `assets.exportText`（能力 `remote.assets.v1`；正文超过帧内上限时先分块传输）写在执行主机上，答复里的 `path` 是那台机器上的路径。
- 页面只把它用于输出到画板；共享层 `exportTextRequestSchema`。
- 落点跟着来源 Agent 的工作目录：core 按 `exportId` 找这个工作空间里归该节点的最近一个终端会话，取它的 `cwd`；`cwd` 存在、解开符号链接后严格在工作区根之内、且不在 `.armadra` / `.git` 里时，文件落在 `<cwd>/.armadra/exports/acp/<exportId>/<name>`（那个 `.armadra` 同样自忽略），否则退回工作区根。`relativePath` 始终相对工作区根（例 `packages/api/.armadra/exports/acp/<exportId>/msg-3-1.ts`），编辑器节点直接用它。请求体不带路径，写到哪里只由 core 记的会话决定。

## 15. 工作流与 runners：`/api/workflows/*`

> 自协议 1.12 起这些路由同时是 `workflows.*` 与 `coordinator.*` procedure（§43.2、§43.3），旧路径与 procedure 调同一份实现。

协调者把一次协作沉淀成**草案**，人确认后成为**模板**，模板按参数**运行**（设计 `design/coordinator-agent.md` §5、`design/completion-architecture.md` §5.4）。表在迁移 `0034_workflow.sql`（`workflow_drafts` / `workflow_templates` / `workflow_runs` / `workflow_run_steps` / `workflow_task_runs`）。zod 在 `packages/shared/src/api/workflows.ts`，core 的手写校验在 `core/workflow/draft.ts`，两边规则相同。§15.5 是 `wait` 动词与 `workflow_task_runs` 行；§15.6（自动化目标 `WORKFLOW_RUN`）由 G2-3 填写。

权限按前缀（`http/route-scopes.ts`）：读 `canvas:read`，写 `agent:launch`。路径里没有工作空间，服务器壳上的路由门按草案 / 运行 / 画板查出画布再判，成员的逐条权限与关卡答复见 §23.3。失败一律 `{ code, message }`，`code` 是 snake_case 的稳定码。

### 15.1 草案 JSON 与 `workflow-propose`

控制动词 `workflow-propose`（`collab/control/index.ts::VERBS`；工具名 `canvas_workflow_propose`）：`args.draft` 是草案 JSON（JSON 调用时是对象，命令行上是它的 JSON 字符串，两种都收），`--dry-run` 只校验不落库。成功回 `{ draftId, status: "pending", title }` 并推 `workflow.draft`；草案不成立回 `400 invalid_draft`，消息指出第一处问题。

```json
{
  "version": 1,
  "title": "双人代码审查",
  "params": [
    { "name": "scopeA", "type": "string", "label": null, "default": null }
  ],
  "roles": [
    {
      "id": "reviewerA",
      "agentId": "claude",
      "title": null,
      "permissionMode": "plan",
      "model": null,
      "worktree": null
    },
    { "id": "lead", "agentId": "codex" }
  ],
  "links": [{ "from": "lead", "to": "reviewerA", "role": "supervises" }],
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
      "kind": "collect",
      "role": "lead",
      "from": ["s1"],
      "prompt": "汇总到便签",
      "after": ["s1"]
    },
    { "id": "s3", "kind": "gate", "label": "合并前人工确认", "after": ["s2"] }
  ],
  "source": {
    "boardId": "…",
    "nodeIds": ["…"],
    "proposedBy": "ama",
    "sessionId": "…"
  }
}
```

- `version` ≥ 1 的整数；模板改一次就要更大（§15.2）。`title` 1–160 字。
- `params[]` ≤ 32：`name` 匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`，`type` 是 `string` / `path` / `text`（缺省 `string`），可选 `label`、`default`。提示词里 `{{name}}` 在起跑时代入；没声明的 `{{…}}` 原样留着。
- `roles[]` 1–8：`id` 匹配 `^[A-Za-z][A-Za-z0-9_-]{0,31}$`；`agentId` 是注册表 id 或 `custom:…`；`permissionMode` 是 `default` / `auto-edit` / `full-auto` / `plan` 或 null（这个 CLI 有没有这个模式在起跑时查）；`model` ≤ 120 字；`worktree` 是 worktree 名或相对路径，起跑时与 `canvas team` 一样备好检出，角色的终端开在里面。
- `links[]` ≤ 32：两个不同角色之间的线，`role` 是 `peer`（缺省）或 `supervises`（`from` 是主）。
- `steps[]` 1–32，`id` 同角色的规则、草案内唯一；`after` 是别的步骤 id，不能成环。`kind`：
  - `prompt`：把 `prompt`（代入参数后 ≤ 2000 字）投给 `role` 的节点；
  - `collect`：先把 `from` 里各步骤的产出放进 `role` 节点的收件箱，再投 `prompt`（末尾加一句「来源步骤的结论在收件箱里」，代入后连这一句 ≤ 2000 字）；`from` 必须都写在它的 `after` 里；
  - `gate`：停下等人答复（§15.3），`label` 1–160 字。
- `source` 可选，原样存着；未知字段丢掉。

### 15.2 草案与模板

| 方法与路径                                | 说明                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/workflows/drafts`               | `?boardId=`、`?status=pending\|confirmed\|discarded` 过滤，新的在前，最多 200 条 → `{ drafts }` |
| `GET /api/workflows/drafts/{id}`          | `{ draft }`                                                                                     |
| `POST /api/workflows/drafts/{id}/confirm` | `{ name?, draft? }`：`draft` 给了就是人改过的那份（重新校验）→ `{ draft, template }`            |
| `POST /api/workflows/drafts/{id}/discard` | `{ draft }`                                                                                     |
| `GET /api/workflows/templates`            | `{ templates }`，最近改过的在前                                                                 |
| `POST /api/workflows/templates`           | `{ name?, template }` → `201 { template }`；`name` 缺省取 `template.title`                      |
| `GET /api/workflows/templates/{id}`       | `{ template }`                                                                                  |
| `PUT /api/workflows/templates/{id}`       | `{ name?, template }`，`template.version` 必须大于库里那份，否则 `409 template_version_stale`   |
| `DELETE /api/workflows/templates/{id}`    | `204`；已有的运行不受影响（运行存的是起跑时的模板快照）                                         |

草案行：`{ id, workspaceId, boardId, proposerNodeId, status, templateId, draft, createdAt, updatedAt }`，`status` 是 `pending` / `confirmed` / `discarded`；不是 `pending` 的草案再确认或丢弃回 `409 draft_not_pending`。模板行：`{ id, name, version, createdFromDraft, template, createdAt, updatedAt }`。

### 15.3 运行、步骤与关卡

| 方法与路径                                     | 说明                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/workflows/runs`                     | `{ templateId, params?, boardId? }` → `201 { run }`；`boardId` 缺省取模板的 `source.boardId` |
| `GET /api/workflows/runs`                      | `?templateId=`、`?boardId=`、`?limit=`（1–200，缺省 50），新的在前 → `{ runs }`              |
| `GET /api/workflows/runs/{id}`                 | `{ run }`                                                                                    |
| `POST /api/workflows/runs/{id}/cancel`         | `{ run }`；已结束回 `409 run_finished`                                                       |
| `POST /api/workflows/runs/{id}/gates/{stepId}` | `{ decision: "approve" \| "reject", note? }` → `{ run }`；不在等人回 `409 gate_not_waiting`  |

起跑当场拒绝的：缺参数或参数未声明（`400 missing_param` / `bad_request`）、代入后超长（`400 prompt_too_long`）、角色的 CLI 没有那个权限模式（`400 permission_mode_unsupported`）、这台机器不认识的 `agentId`（`400 invalid_draft`）、画布不存在（`404`）、worktree 备不好（Git 的拒绝原样）。这些都在动画布之前。

起跑之后 core 在画布上建一个 Frame（标题是模板标题），里面一张起点便签和每个角色一个 Agent 终端节点；便签向每个角色连一条 `supervises` 线，草案的 `links` 照原样连。角色节点由依赖编排的启动路径起终端、敲启动行；提示词是投递队列里的一条（`origin: "first-task"`，发起方是起点便签），门链、租约、回执与 `canvas send` 相同。**页面开不开都一样**；重启后按库里的状态续跑。

```json
{
  "run": {
    "id": "0192…",
    "templateId": "0192…",
    "templateVersion": 1,
    "title": "双人代码审查",
    "workspaceId": "ws",
    "boardId": "board",
    "frameId": "node-frame",
    "params": { "scopeA": "src/a" },
    "status": "waiting",
    "reason": null,
    "roles": { "reviewerA": "node-a", "lead": "node-l" },
    "startedAt": "2026-10-03T08:00:00.000Z",
    "endedAt": null,
    "steps": [
      {
        "stepId": "s1",
        "kind": "prompt",
        "role": "reviewerA",
        "status": "done",
        "nodeId": "node-a",
        "startedAt": "2026-10-03T08:00:00.000Z",
        "endedAt": "2026-10-03T08:03:10.000Z",
        "reason": null,
        "outputs": [
          {
            "key": "review",
            "body": "结论…",
            "at": "2026-10-03T08:03:00.000Z",
            "target": "node-l"
          }
        ],
        "decision": null,
        "note": null
      }
    ]
  }
}
```

- 运行 `status`：`running` / `waiting`（有关卡在等人）/ `succeeded` / `failed` / `cancelled`；`reason` 是 `<stepId>:<步骤 reason>`（失败时）或 `cancelledByUser`。
- 步骤 `status`：`pending` / `running` / `waiting`（关卡）/ `done` / `failed` / `skipped`（它等的步骤没成功）/ `cancelled`。一步在 `after` 全部 `done` 时开始；全部步骤结束后，全 `done` 记 `succeeded`，否则 `failed`。
- `prompt` / `collect` 何时算完：投递落地之后，角色节点**下一轮干净地结束**（判定与 §8 的依赖边相同：只认基准之后的结束）。失败的 `reason`：`turnFailed` / `turnInterrupted`（这一轮出错或被中断）、`nodeDeleted`、`nodeExited`（终端退出而这一轮没结束）、`roleMissing`、`QUEUE_FULL`，以及投递三次都没投进去时最后一次排队项的码（如 `TARGET_STARTING`）。
- `outputs`：角色节点在这一步开始之后 `canvas post` 的正文（最多 8 条，回执与引擎放进收件箱的副本不算），`target` 是收件节点。关卡的答复记在 `decision` 与 `note`。
- 取消：没结束的步骤记 `cancelled`、还排着的提示词收回，节点留在画布上。

### 15.4 事件

三帧经 `WS /api/workspaces/{id}/events`，帧里不带正文，页面据此重读上面的路由：

```text
{ "type": "workflow.draft", "draftId": "…", "boardId": "…", "status": "pending" }
{ "type": "workflow.run", "runId": "…", "boardId": "…", "status": "running", "stepId": "s1", "stepStatus": "done" }
{ "type": "workflow.gate", "runId": "…", "boardId": "…", "stepId": "s3", "label": "合并前人工确认", "state": "waiting", "nodeId": "node-frame" }
```

- `workflow.draft`：草案出现、被确认或丢弃。
- `workflow.run`：运行或其中一步换了状态；只有运行换状态时没有 `stepId` / `stepStatus`。
- `workflow.gate`：`state` 是 `waiting` / `approved` / `rejected` / `cancelled`；`nodeId` 是运行的 Frame（运行还没有 Frame 时缺席）。推送只在 `waiting` 时叫人，深链打开这个 Frame（§19）。

### 15.6 自动化目标 `WORKFLOW_RUN`

定时运行一个模板走 §4 的自动化面：计划的 `target.kind` 是 `AUTOMATION_TARGET_KIND_WORKFLOW_RUN`，`target.workflowRun` 指明模板与画布，参数是计划的**载荷**。misfire、并发、授权复核与运行记录都与别的目标相同；到点时 core 调工作流服务起跑（与 `POST /api/workflows/runs` 同一条路），不往任何终端写。共享层的 zod 是 `workflowRunTargetSchema` / `workflowRunPayloadSchema`（`packages/shared/src/api/workflows.ts`）。

```json
{
  "target": {
    "executionHostId": "…",
    "kind": "AUTOMATION_TARGET_KIND_WORKFLOW_RUN",
    "sessionId": "",
    "generation": "0",
    "nodeId": "",
    "coldStartPolicy": "AUTOMATION_COLD_START_POLICY_SKIP",
    "workflowRun": {
      "templateId": "0192…",
      "templateVersion": 3,
      "boardId": "board"
    }
  }
}
```

载荷（UTF-8，`POST /api/automations/plans` 的 `payload`）：`{"params":{"scope":"src/a"}}`，名字同 §15.1 的参数名规则、值是 ≤ 2000 字的字符串；空对象表示全用模板的缺省值。

- **定义时核**：模板存在；`templateVersion` 给 0 时存成模板当前的版本，给了别的数必须等于当前版本（否则 `conflict`）；画布属于计划的工作空间（否则 `not_found`）；参数按模板校验（缺参数、未声明的参数、代入后超长都是 `bad_request`）。工作流目标不能带会话、代数、节点或启动定义，冷启动策略归成 `SKIP`。
- **版本冻结**：模板之后改过（`PUT …/templates/{id}` 让版本变大）或被删，到点的探测答「不受支持」，这次运行记 `SKIPPED` / `TARGET_UNSUPPORTED`，连续几次后计划标「需要处理」；要人按新版本重新保存计划。
- **闸门**按模板（`automation_gates.node_id = "workflow:<templateId>"`）：同一个模板同一时刻只有一个定时运行在跑，`FORBID` / `QUEUE_ONE` 照常生效。
- **起跑即投递**：工作流运行的 id 由这次投递的 `operationId` 推出（SHA-256 → UUID 形），重试与超时之后的复核认得出「已经起过」，不会起第二次。起跑当场被拒（§15.3 那几种）记 `FAILED`，理由码是 `WORKFLOW_` + 拒绝码大写（如 `WORKFLOW_PERMISSION_MODE_UNSUPPORTED`）。
- **收据跟着运行走**：运行在跑记 `RUNNING`（理由 `WORKFLOW_RUNNING` / 有关卡在等人时 `WORKFLOW_WAITING`），结束记 `SUCCEEDED` / `FAILED` / `CANCELLED`（理由 `WORKFLOW_SUCCEEDED` / `WORKFLOW_FAILED` / `WORKFLOW_CANCELLED`）；自动化运行因此从起跑占着闸门直到工作流运行结束。
- **模板升级**（G5-08 追加）：`PUT /api/workflows/templates/{id}` 的答复多一列 `frozenSchedules: [{ scheduleId, workspaceId, templateVersion, reason, missingParams, unknownParams }]`，列出指向这个模板、仍冻结在旧版本上的计划（已删除的不列）；`reason` 是 `compatible`（存着的参数按新版本全部成立，可直接升级）、`missing_params`（新版本多了没有缺省值的参数，名字在 `missingParams`）或 `param_mismatch`（存着的参数新版本不认了，名字在 `unknownParams`，或代入后超长）。`POST /api/workflows/templates/{id}/upgrade-schedules?workspaceId=` `{ scheduleIds }`（1–200 个）把该工作空间里参数相容的计划改到模板当前版本 → `{ upgraded: [{ scheduleId, revision }], frozen: [{ scheduleId, reason, missingParams, unknownParams }] }`：只换 `templateVersion`，其余配置与载荷原样，原来启用的按新的一版重新启用（同 §4 的定义 + 激活，认人与 `/api/automations/*` 相同，只有计划的创建者能改）；不相容的原样不动，`frozen.reason` 另有 `not_found`（不是这个模板的计划）、`forbidden`、`conflict`、`failed`。已是当前版本的计划算进 `upgraded`。不相容的计划由人在编辑计划时按新版本补参数，保存即存成当前版本。路由权限与改模板相同（服务器壳上只有 owner）。

### 15.5 `wait` 动词、`open-agent --task-id` 与 `workflow_task_runs`

协调者 `ama` 的 `task(agent=<id>)` 经宿主适配器的 runner 落成画布节点（设计 `design/completion-architecture.md` §5.3）。两处 hook 面控制动词（`/control/<verb>`，调用方是协调者节点，要节点令牌）：

**`open-agent` 的两个参数**

- `task-id`：幂等键，1–100 个字母、数字或 `.` `_` `:` `-`（runner 用 `<ama 会话 id>:<ama 任务 id>`）。同一个协调者再用同一个 `task-id` 起：节点还在就答回那个节点（`result.reused: true`，不建、不投、不起）；节点已删就新建，任务行换绑过去。被别的协调者用过回 `409 task_conflict`。带它时 core 记一行 `workflow_task_runs`（`runner_id` = `agent`），并把节点交给依赖编排的启动路径起终端、敲启动行（与工作流角色节点同一条，页面开不开都一样）；`result` 多 `taskRunId` 与 `reused`。
- `name`：节点标题，与 `title` 同义（两者都给时取 `title`）。
- 权限模式这个 CLI 没有：`400 permission_mode_unsupported`，附 `supported: [...]`（与 §15.3 同码；`team` 同此）。
- `cwd`：成员终端开在哪个目录。工作区根下的相对路径或落在工作区里的绝对路径，按 core 所在机器的路径规则解析并解开符号链接后判断；在工作区外（含经 `..` 或符号链接出去）回 `400 cwd_outside_workspace`，目录不存在或不是目录回 `400 bad_request`，与 `worktree` 同给回 `400 bad_request`，远端执行主机上的工作区回 `400 cwd_unsupported`。成立时写进节点数据的 `cwd`（解开链接后的绝对路径），`result` 与演练结果多 `cwd`。
- `resume`：接回这个 CLI 自己的一段会话（1–200 个字母、数字或 `.` `_` `:` `-`），core 起节点时敲的是 `agent/launch.ts` 的 resume 行（Claude `--resume <id>`、Codex `resume <id>` …）。值是这块画布上一个成员节点的 id 时（runner 的 `sessionRef.sessionId` 就是节点 id），取那个节点上报过的会话 id。这个 CLI 不能续接（或自定义条目关掉了 `resume`）、节点跑的不是同一家、或节点从没报过会话 id，回 `400 resume_unsupported`。成立时写进节点数据的 `agent.resume`，节点交给依赖编排的启动路径由 core 起（不带 `task-id` 也一样），`result` 多 `resume`（实际接回的会话 id）。ama 的 runner 把 `request.cwd` / `request.resume` 映射成这两个参数，遇到 `cwd_outside_workspace` / `cwd_unsupported` / `resume_unsupported` 时去掉那一个再起一次（成员开在工作区根、或新开会话）。

**`wait`**

| 参数      | 说明                                                                 |
| --------- | -------------------------------------------------------------------- |
| `task`    | 必填，`open-agent --task-id` 给过的 id                               |
| `node`    | 可选，任务所在节点；对不上回 `409 task_node_mismatch`（附 `nodeId`） |
| `since`   | 上一次答回来的 `since` 原样；第一次省略。格式不对回 `400`            |
| `timeout` | 秒，0–60，缺省 30；`30s` 也收。超出回 `400`                          |

只有起这个任务的协调者能等它（别的节点 `403 forbidden`），没有这个任务 `404 task_not_found`。答复在 `result` 里：

```json
{
  "status": "blocked",
  "since": "42-blocked",
  "taskId": "sess:t1",
  "nodeId": "node-m",
  "approvalId": "node-m-1730000000000-123",
  "reason": "approval",
  "events": [
    {
      "type": "post",
      "seq": 42,
      "key": "task:sess:t1:progress",
      "body": "…",
      "at": "2026-10-03T08:00:00.000Z"
    },
    { "type": "status", "state": "blocked", "at": "2026-10-03T08:00:01.000Z" }
  ]
}
```

- `status` 五值：`running`（在做，或第一条任务还在排队）/ `done` / `failed` / `blocked`（成员停在权限请求上，带 `approvalId`；**只报告，动词与 runner 都不替人回答**）/ `needsInput`（成员在等人回话，`reason: "question"`）。
- `done`：成员 `post` 了键为 `task:<taskId>:result`（或 `task:<taskId>:result:<轮次>`）的消息，`result: { text, key }` 是那条正文；或者投递之后成员这一轮干净地结束（判定同 §8 的依赖边），此时没有 `result`，runner 改读 `context summary`。
- `failed` 的 `reason`：`nodeDeleted`、`turnFailed` / `turnInterrupted`、投递排队项过期或被取消时它最后一次的码（如 `TARGET_STARTING`）。
- `events`：游标之后成员发出的、键是 `task:<taskId>` 或以 `task:<taskId>:` 开头的 `post`（`seq` 是收件箱序号，递增，一次最多 32 条，不漏不重），以及状态变化（`agent_status.state` 与游标里记的不同才报一条）。没有新事件、也没结束时，请求挂到 `timeout` 再答当时的状态；`since` 不变。
- `since` 是不透明字符串（现为 `<post 序号>-<状态>`），调用方原样带回。
- 结束（`done` / `failed`）时 core 写 `workflow_task_runs` 的 `status`、`ended_at` 与 `result_json`（`{ text }` 或 `{ reason }`，只写第一次），并把那条结果 `post` 标成已收——runner 已替协调者取走它，收件箱唤醒不再提示一遍。带 `task` 起的任务在开始时就写 `result_json.task`（第一条任务的正文，G5-09 追加），结束写的 `text` / `reason` 与它并存，换绑与重试都保留它；它只给 §15.7 的重试用，不出现在任何答复里。

**`help`** 的 `result` 多一个 `agents`：这台机器上 `open-agent --agent` 认的 id（内置的与设置里的 `custom:*`）。ama 的适配器为其中每个内置 CLI（`ama` 除外：ama 把名为 `ama` 的 runner 当成它自己的子会话）与每个 `custom:*` 注册一个 runner。

**审批**：`ama` 节点也注入 `ARMADRA_PERM_WAIT_SECS`（与 Claude 同一个开关 `hooks.replyApprovals`，ACP 会话不注入）。适配器的审批回答者按 §5.5 写 `<pending>/<id>.json`、带 `pendingId` 报 `tool_approval_requested`，轮询 `<id>.answer`；请求文件与上报只有工具名与原因，不带工具输入。等不到就让给 ama 自己在终端里的对话框。

### 15.7 分派抽屉：`/api/workflows/tasks`

协调者（ama）经 §15.5 分派出去的任务，页面右侧「分派」抽屉读这一面（设计系统 §5.4，G5-09）。

| 方法与路径                                 | 说明                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `GET /api/workflows/tasks?boardId=`        | 协调者节点在这块画板上的任务行，新的在前，最多 200 行 → `{ tasks }`；缺 `boardId` 回 `400 bad_request` |
| `POST /api/workflows/tasks/{taskId}/retry` | 把起任务时的正文从协调者节点再投给同一个成员节点 → `{ task }`（行回到 `running`、重新计时）            |

任务行：`{ taskId, coordinatorNodeId, runnerId, nodeId, status, startedAt, endedAt, reason, retryable }`。`status` 同 §15.5（`running` / `done` / `failed` / `stopped`）；`reason` 是失败时记下的理由（`turnFailed` 等），否则 `null`；`retryable` = 失败或停止、且库里记着任务正文。任务正文与成员的结果正文都不进答复。

- 重试走投递队列（`origin: "first-task"`，发起方是协调者节点），门链、租约与回执与 `canvas send` 相同，不替人回答任何提示。拒绝：没有这个任务 `404 not_found`；不是 `failed` / `stopped` `409 task_not_failed`；没记正文（不带 `--task` 起的）`409 task_prompt_missing`；成员节点已不在协调者那块画板上 `409 task_node_missing`；目标队伍满了 `409 queue_full`。
- 权限：列表是 `canvas:read`（按 `boardId` 查画布），重试是 `agent:launch`（按任务的协调者节点查画布）；服务器壳的路由门在 `identity/route-access.ts`。
- 没有专门的事件：抽屉开着时每 5 秒重读，`workflow.*` 帧到达时也重读。
- 汇总便签由页面在画布文档里认：来源是这个协调者（`data.source.nodeId`）或与它连着线的便签。`canvas sticky` 写的便签自 G5-09 起带 `data.source = { nodeId: <写它的节点>, sessionId: "" }`。

## 16. 实时协同：`…/boards/{boardId}/sync` 与评论

实现：`apps/desktop/src/core/realtime/`；共享常量与 zod：`packages/shared/src/api/realtime.ts`。评论路由在 `realtime/comments-routes.ts`（§16.3）。

### 16.1 `WS /api/workspaces/{id}/boards/{boardId}/sync`

一块板一条流，帧全是二进制（文本帧以 `4400` 关流）。外层一个 lib0 varUint 的消息类型，与 `y-websocket` 同一套编码：

| 类型 | 名称            | 内容                                                                                       |
| ---- | --------------- | ------------------------------------------------------------------------------------------ |
| `0`  | sync            | `y-protocols/sync` 的消息：子类型 `0` step1（状态向量）、`1` step2（缺的更新）、`2` update |
| `1`  | awareness       | `y-protocols/awareness` 的更新（形状见 §16.4）                                             |
| `3`  | query awareness | 无载荷；core 回一帧当前全部 awareness                                                      |

- **握手**：升级成功后 core 先发自己的 step1 与当前 awareness；客户端发自己的 step1，core 回 step2。断线重连同样走 step1 / step2，离线期间的本地改动随之补齐。
- **升级前**（HTTP 状态行，没有 socket）：板不存在或不在这个工作空间 `404`；没有 `canvas:read` `403`；设置 `collab.realtime` 关着而且这块板还不是实时板 `409 realtime_disabled`。第一个连上的客户端把板切到实时（§16.2），之后不再切回，除非设置关掉（见下）。
- **写权限**：step2 / update 帧要 `canvas:write`。只读连接发来**会改变文档**的写帧，core 丢弃它并以 `4403` 关流；回答服务端 step1 的空 step2 放过。授权变化时复核：失去读权限、或者本来能写现在不能写，都以 `4403` 关流。
- **关闭码**：`1001` core 退出或板的文档被逐出（重连即可）；`1009` 单帧超过 16 MiB；`4400` 坏帧（解不开的消息或更新）；`4403` 见上（不要以写者身份重连，按只读处理）。
- **能力**：`GET /api/identity/hello` 的 `capabilities` 含 `canvas.realtime.v1` 表示这个 core 说这套协议。

文档结构（`Y.Doc` 的根类型）：

| 根               | 类型                         | 内容                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodes`          | `Y.Map<nodeId, Y.Map>`       | 每个节点一张 `Y.Map`，键与 `CanvasNode` 同名：`type title color position size collapsed expandedHeight parentId labels note data createdAt updatedAt`，值是 JSON、按字段 LWW；`data.content` 是字符串时放在键 `content` 的 `Y.Text` 里，`data` 里不再带它 |
| `edges`          | `Y.Map<edgeId, JSON>`        | `{ source, target, kind, role?, createdAt, updatedAt }`，整条 LWW                                                                                                                                                                                         |
| `whiteboard`     | `Y.Map<itemId, string>`      | 白板 `items[]` 的每一项一条 JSON 串，按 item LWW                                                                                                                                                                                                          |
| `whiteboardRefs` | `Y.Map<referenceId, string>` | 白板 `references[]` 的每一项一条 JSON 串                                                                                                                                                                                                                  |
| `meta`           | `Y.Map`                      | `whiteboardEnvelope`：白板 JSON 去掉两个数组后的外壳（JSON 串）；`whiteboardRaw`：认不出外壳的白板原文。视口不进文档                                                                                                                                      |

`id` 与 `boardId` 不存进节点与边的值里，由键与所在的板给出。core 不解析白板 item 的内容，只认外壳：`items` / `references` 两个数组、每项有唯一的字符串 `id`。

### 16.2 物化与 `board.changed`

- **真相**：`boards.realtime = 1` 的板，真相是 `board_snapshots.state` 加其后的 `board_updates`；`nodes` / `edges` / `whiteboard_json` 是物化出来的缓存。每条更新逐条落库（`seq` 递增，`principal_id` 为 `null` 表示 core 自己的写者）；每 500 条或最后一个客户端离开时写快照并删掉 `seq ≤ 快照` 的行；core 重启按快照 + 更新重放，表落后时补物化。
- **物化**：最后一次更新之后 1 秒、最后一个客户端离开、core 退出，或任何人读这块板（`GET …/document` 与 core 内部的读）之前，把文档投影写进表。表真的变了才前进 `updatedAt` 并广播 `board.changed`。对实时客户端，`board.changed` 只说明表追上了文档，**不要**据此重新加载。白板物化时 `items` 按 `z` 再按 `id` 排、`references` 按 `id` 排，节点与边按 `createdAt` 再按 `id` 排。
- **清理**：文档里表放不下的东西（校验不过的节点、悬挂或校验不过的边、指向非组的 `parentId`、撞名的 `data.handle`、已属于别的板的 id）在物化前由 core 以一次事务从文档里删掉或清掉，清理本身作为一条更新同步给所有客户端。
- **旧写法**：实时板上带 `clientId` 的 `PUT …/document` 答 `409 { "code": "realtime_active" }`；租约（§9）在实时板上不拦写入，`canvas.presence` 的 `lease` 恒为 `null`，在线表只用于显示。
- **core 自己的写者**（控制动词、调度、依赖编排）照旧调用保存：请求相对它读到的那一份做三方 diff，在文档副本上试写并过一遍与非实时板相同的拒绝（`400` 校验 / 撞名、`409` 修订号旧了），通过后以 `origin: "core"` 的事务写进文档再物化；文档里别人并发改的、写者没碰的字段原样保留。没有客户端时 core 也加载文档，空闲 60 秒后卸载。
- **实时状态**：`GET /api/workspaces/{id}/boards/{boardId}/realtime`（`canvas:read`）答

  ```json
  { "realtime": true, "materializedSeq": 42, "enabled": true }
  ```

  `enabled` 是设置 `collab.realtime`（缺省 `true`）。页面在 `realtime || enabled` 时连 `…/sync`，否则留在租约 + CAS。

- **关回租约模式**：设置关掉之后，新板不再切换；已经是实时板的，在没有客户端连着时（卸载或下一次 core 写入）先物化、再标 `realtime = 0` 并删掉更新流与快照，表重新成为真相。有客户端连着的板继续服务到它们离开。

### 16.3 评论：`/api/workspaces/{id}/boards/{boardId}/comments*` 与 `board.comment`

评论不进 `Y.Doc`，落 `board_comments`；实时板与租约板一样可用。读要 `canvas:read`，写要 `canvas:write`（路由门与域内各判一次）。板不存在或不在这个工作空间 `404`。

一条评论：

```json
{
  "id": "0192…",
  "boardId": "0191…",
  "anchor": { "kind": "node", "id": "9b1c…" },
  "body": "请 @[Vera](principal:3f2a…) 看一下",
  "authorPrincipalId": "",
  "parentId": null,
  "createdAtMs": 1760000000000,
  "updatedAtMs": 1760000000000,
  "resolvedAtMs": null,
  "mentions": ["3f2a…"]
}
```

| 字段                | 规则                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchor`            | 三选一：`{kind:"node", id}`、`{kind:"item", id}`（白板 item id）、`{kind:"point", x, y}`（画布坐标，有限数）；id 1–200 字符                           |
| `body`              | 去掉首尾空白后 1–10 000 字符。提及写成 `@[显示名](principal:<id>)`。页面按 Markdown（GFM）渲染：不渲染裸 HTML、链接只开 `http(s)`、图片只显示替代文字 |
| `authorPrincipalId` | 写入时取请求的 principal（本机壳的 owner 为 `""`），客户端不能指定                                                                                    |
| `parentId`          | 回复指向一条**顶层**评论（只有一层）；回复的锚点随父评论，请求里的 `anchor` 被忽略                                                                    |
| `resolvedAtMs`      | 只有顶层评论能解决；回复随父评论                                                                                                                      |
| `mentions`          | core 认出来的提及：正文里的 principal 存在、没停用、对这个工作空间有 `canvas:read`；认不出的记号照原文留着，不叫任何人。最多认 20 个                  |

| 方法与路径                            | 权限                             | 请求                                                                                                                | 应答                                                                                          |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET …/comments`                      | `canvas:read`                    | 查询 `anchorKind=node\|item&anchorId=…`（只要这个锚点的，含回复）、`resolved=false`（去掉已解决的线程与它们的回复） | `200 { comments: [评论…], people: [{principalId, name}] }`，按创建时间；`people` 是可提及的人 |
| `POST …/comments`                     | `canvas:write`                   | `{ anchor, body, parentId? }`                                                                                       | `201` 评论                                                                                    |
| `PATCH …/comments/{commentId}`        | `canvas:write`，且是作者         | `{ body }`                                                                                                          | `200` 评论；不是作者 `403 forbidden`（owner 也不能改别人的话）                                |
| `DELETE …/comments/{commentId}`       | `canvas:write`，且是作者或 owner | —                                                                                                                   | `204`；顶层评论的回复一起删；记审计 `canvas.comment.delete`                                   |
| `POST …/comments/{commentId}/resolve` | `canvas:write`                   | `{ resolved?: boolean }`（缺省 `true`）                                                                             | `200` 评论；回复 `400`                                                                        |

校验失败 `400 bad_request`，评论不存在 `404 not_found`。

**事件** `board.comment`（工作空间事件流）：每次写入一帧，不带正文：

```json
{
  "type": "board.comment",
  "boardId": "0191…",
  "action": "created",
  "comment": {
    "id": "0192…",
    "parentId": null,
    "anchorKind": "node",
    "anchorId": "9b1c…"
  },
  "mentions": ["3f2a…"]
}
```

`action` 为 `created | updated | resolved | reopened | deleted`；`anchorId` 在点锚时省略。`mentions` 是这一次**新叫到**的人且不含作者：新建时是全部提及，改正文时只是新加的，其余动作为空。页面收到后重新拉列表；推送域（§19）按 `mentions` 给有 `canvas:read` 的人发「有人在评论里提到了你」，深链指向锚定的节点。

**对 Agent 可读**：Agent 经上下文连线读一个节点（`context summary | transcript | terminal`）时，回答末尾附上锚在该节点上、未解决的评论线程（提及换成 `@显示名`，至多 8 KiB），与正文一起脱敏、计入这条连线的读取预算。已解决的线程不附。白板引用（链接文档里 `kind: "shape"` 的一项）同样附上：白板对象取锚点 `item`（`sourceShapeId` 去掉 `wb:` 前缀与原样两种都认），Frame（`shapeType: "group"`）取锚在那个分组节点上的；评论只从读者自己的板查，同样至多 8 KiB、脱敏，有评论时这一段计入读取预算（`context_reads` 的目标记为引用的 id），没有评论时回答与以前逐字节相同。

### 16.4 awareness 状态

`…/sync` 的 awareness 帧（类型 `1`）里每个 clientID 一份状态，JSON：

```json
{
  "principalId": "",
  "deviceId": "Yk3…（页面的 clientId）",
  "name": "macOS · Chrome",
  "color": 2,
  "cursor": { "x": 120.5, "y": -40 },
  "selection": ["9b1c…", "wb:item-1"],
  "focusNodeId": "9b1c…"
}
```

| 字段          | 规则                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `principalId` | core 一律改写成这条连接的 principal（本机壳的 owner 为 `""`），客户端填什么都不算                                              |
| `deviceId`    | 必填，1–128 字符：页面的 `clientId`（同一个人的两个窗口各一个）                                                                |
| `name`        | 必填，≤ 80 字符，只用于显示                                                                                                    |
| `color`       | 必填，整数 `1..8`：成员色序号（设计系统 §2.5）。页面加入时取在场者没用的最小一个（从 2 起），各观看者看到的同一个人颜色相同    |
| `cursor`      | 可选，画布坐标（有限数）；指针离开画布时省略                                                                                   |
| `selection`   | 可选，≤ 256 个 id（每个 1–128 字符）；白板对象带 `wb:` 前缀                                                                    |
| `focusNodeId` | 可选，正在看的节点 id                                                                                                          |
| `viewport`    | 可选，`{ x, y, zoom }`：视口**中心**的画布坐标（有限数）与缩放（`0.01..100`）。页面节流约 100ms 写；跟随时对上它，没有就跟光标 |

- core 只留上表里的键；形状不对或序列化后超过 16 KiB 的状态**整条丢弃**（不转发、不断流），`null`（离开）照常转发。
- 一条连接只能写自己登记过的 clientID：别的连接已经登记的 clientID 在它发来的帧里被丢掉。
- 页面按共享层 `awarenessStateSchema` 再校验一次，认不出的不进在线表、不画光标。
- 共享层 `AWARENESS_LIMITS` 与 core `realtime/awareness.ts` 的上限逐条一致（`awareness.test.ts` 守）。
- 实时板的视口不进文档、也不 PUT：页面按 `boardId` 记在本机 `localStorage`（`armadra.realtimeViewport.<boardId>`），开板时恢复；`viewport` 只用于跟随，core 不读。

## 17. Gateway：`/api/gateway*`

> 自协议 1.14 起 `GET /api/gateway`、`PUT /api/gateway`、`POST /api/gateway/pairing` 同时是 `gateway.*` procedure（§43.7），旧路径与 procedure 调同一份实现；配对短码换票（§24）是匿名面，只经旧路径。

Gateway 是 core 对外的 HTTPS 面（`apps/desktop/src/core/gateway/`，[补全架构](../design/completion-architecture.md) §7）。服务器壳的 `serve` 用命令行参数打开它；桌面壳按设置 `gateway.*` 打开它。下面三条路由在 core 的主监听器上与 Gateway 上都答，路由门按 `settings:read` / `settings:write` 判——只有 owner，成员一律 403 `forbidden`。字段名 camelCase，时间是带时区的 ISO 8601，错误 `{ code, message }`。

### 17.1 `GET /api/gateway`

```json
{
  "enabled": true,
  "running": true,
  "managedBy": "settings",
  "listen": "private",
  "port": 8443,
  "publicOrigin": "",
  "address": { "host": "0.0.0.0", "port": 8443 },
  "origin": "https://192.168.1.20:8443",
  "origins": [
    "https://192.168.1.20:8443",
    "https://mac.local:8443",
    "https://127.0.0.1:8443"
  ],
  "tls": {
    "source": "localCa",
    "certFile": "",
    "keyFile": "",
    "acmeEmail": "",
    "fingerprint": "5f1c…（64 位小写十六进制）",
    "subject": "CN=192.168.1.20",
    "names": ["192.168.1.20", "mac.local", "127.0.0.1"],
    "notAfter": "2027-11-04T00:00:00.000Z",
    "caAvailable": true,
    "acme": null
  },
  "error": null
}
```

- `managedBy`：`settings`（桌面壳）或 `shell`（服务器壳，配置来自命令行；这时 `enabled` 恒为 `true`，`port` 是实际绑定的端口）。
- `listen` / `port` / `publicOrigin` / `tls.{certFile,keyFile,acmeEmail}` 是设置里的值；`address`、`origin`、`origins` 与 `tls` 的其余字段是运行中的事实，没在运行时为 `null` / `[]`。
- `origin` 是首选来源（二维码用它）：公网来源优先，否则第一个私网地址，然后主机名，最后 `127.0.0.1`。`origins` 是来源白名单：Origin / Host 必须命中其中之一。`https://localhost` 永远不在里面（它是 Android 版 App 的来源）。
- `tls.source`：`localCa`、`file`、`acme`、`selfSigned`（只有服务器壳没给证书时）。`fingerprint` 是**信任锚** DER 的 SHA-256：本地 CA 时是 CA，其余是叶证书。`caAvailable` 表示 `GET /ca.crt` 有东西可发。
- `tls.acme`：ACME 来源在跑时的续期状态，其余来源为 `null`（旧 core 不带这个键）：

  ```json
  {
    "directory": "https://acme-v02.api.letsencrypt.org/directory",
    "challenge": "http-01",
    "profile": null,
    "names": ["armadra.example.com"],
    "notAfter": "2026-12-30T08:00:00.000Z",
    "renewAt": "2026-11-30T08:00:00.000Z",
    "failures": 0,
    "lastError": null
  }
  ```

  `challenge` 是 `http-01` / `tls-alpn-01`（环境变量 `ARMADRA_ACME_CHALLENGE`，缺省 `http-01`；旧 core 不带这个键，即 `http-01`）。`profile` 是 `shortlived` / `classic` / `null`（CA 缺省）；`renewAt` 是下一次续期，失败后是下一次重试；`failures` 是连续失败次数，到 3 次时 core 记一条错误日志通知运维，期间**继续用旧证书**直到它过期；`lastError` 是 `{ code, message }`。证书是公共 CA 签的，没有信任锚可发，`caAvailable` 为 `false`，`fingerprint` 是叶证书的、每次续期都会变。

- `error`：最近一次没能开启的原因，开着或关着时为 `null`。`code` 取值：`acme_misconfigured`（缺邮箱、缺对外来源、对外来源是回环地址、`ARMADRA_ACME_*` 取值不对，或 `tls-alpn-01` 而端口为 0）、`acme_port_unavailable`（`http-01` 挑战端口开不了，或 `tls-alpn-01` 首签时 Gateway 的端口开不了）、`acme_failed`（CA 拒绝或连不上，`message` 是原因）、`tls_files_missing`、`port_in_use`、`port_forbidden`、`identity_unavailable`（库没过统一库迁移）、`gateway_failed`（其余，`message` 是原因）。

### 17.2 `PUT /api/gateway`

请求体是设置 `gateway.*` 的子集，未给的键不动：

```json
{
  "enabled": true,
  "listen": "private",
  "port": 0,
  "publicOrigin": "",
  "tls": { "source": "localCa", "certFile": "", "keyFile": "", "acmeEmail": "" }
}
```

- `listen`：`loopback` 只绑 `127.0.0.1`；`private` 绑 `0.0.0.0` 但只接受落在回环与本机私网地址（RFC 1918、`100.64.0.0/10`、IPv6 ULA）上的连接；`all` 不筛。
- `port`：0–65535；`0` = 由内核分配，开启后把实际端口写回设置，之后固定。
- `publicOrigin`：空串或一个规范拼法的 `https` 来源（反向代理时填）。
- 不认识的键、类型或取值错误一律 400 `bad_request`，不让规范化悄悄退回缺省。
- 回答是写入并对账之后的 §17.1。开着时改了任何键会重开监听；`enabled: false` 即刻停止监听并断开经它进来的每一条连接（升级过的流也在内）。没能开启不算请求失败：200，原因在 `error`。
- 服务器壳上答 409 `gateway_managed_by_shell`。

### 17.3 `POST /api/gateway/pairing`

请求体可选：`{ "origin"?: string, "deviceName"?: string }`。`origin` 必须在 `origins` 里（否则 400 `invalid_origin`），缺省用首选来源；`deviceName` 1–64 字符，缺省「Gateway 配对」。没在运行时 409 `gateway_not_running`。

```json
{
  "origin": "https://192.168.1.20:8443",
  "ticket": "0123…ef.AbC…",
  "fingerprint": "5f1c…",
  "expiresAt": "2026-10-03T08:02:00.000Z",
  "webUrl": "https://192.168.1.20:8443/#pair=0123…ef.AbC…&fp=5f1c…",
  "deepLink": "armadra://pair?host=192.168.1.20%3A8443&ticket=0123…&fp=5f1c…"
}
```

- 票两分钟、一次性，绑在 `origin` 上；兑换走 `POST /api/identity/pair`（§3），配出来的设备拿 owner 的全套授权。成员走邀请。
- 网页链接把票与指纹放在片段里（不上请求行、不进日志）；页面认 `#pair=<票>` 与 `#pair=<票>&fp=<64 位十六进制>` 两种。
- 原生 App 按 `fp` 钉信任锚，不装 CA；锚变了（重置 CA、换证书文件）就重新扫码，不自动信任新证书。
- 私网档位上回答多一个 `code`（8 位配对码，`XXXX-XXXX`），其余档位为 `null`，见 §24。

### 17.4 Gateway 上的匿名面与原生 App

- `GET /ca.crt`：匿名，`application/x-x509-ca-cert`，PEM。本地 CA 时是 CA；服务器壳的自签名证书是它自己；指定文件时是链文件里的最后一张，只有一张时 404 `ca_unavailable`。只在 Gateway 上，core 的回环监听没有它。
- 来源是 `capacitor://localhost` 或 `https://localhost`（且不在 `origins` 里）的请求走 **Bearer 模式**：会话绑定的来源是 App 连上的 Gateway 来源 `https://<Host>`（必须在 `origins` 里，否则 403）；凭据只认 `Authorization: Bearer <访问密钥>`，Cookie 不看、没有 CSRF；`POST /api/identity/pair`、`/session/refresh` 与登录把密钥放在响应体的 `native` 里、不发 Cookie（与桌面壳的原生传输同一形状，§3）；`/session/refresh` 与 `/session/logout` 只认 Bearer 里的刷新票、不核 CSRF（带了也不看）；CORS 只回 App 自己的来源，预检放行 `authorization, content-type, x-armadra-csrf`。
- **响应头**（`core/gateway/csp.ts`）：经 Gateway 的每个答案都带 `Strict-Transport-Security: max-age=31536000`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；`/api/**` 与 `/health` 再带 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox`、`X-Frame-Options: DENY`，以及缺省的 `Cache-Control: no-store`（答案自己写了缓存策略时以它为准，如资产）。静态产物用页面的 CSP（`serverContentSecurityPolicy`）。画布资产（`GET …/assets/{assetId}`）无论经不经 Gateway 都带 `default-src 'none'; …; sandbox`：直接导航到一张 SVG 时它是一份沙箱里的文档，脚本不跑。
- **原生 App 包里页面的 CSP**（`nativeAppContentSecurityPolicy()`）：桌面那一份摘掉回环授权，`connect-src` 加 `https: wss:`、`img-src` / `media-src` 加 `https:`（Gateway 地址配对前未知，证书由原生层钉扎）；其余逐字继承。
- **长连接复核**：经 Gateway 升级的流（事件、实时同步、终端、语言服务、浏览器画面）在授权变化（撤销设备或会话、登出、停用账号、收回共享）时按同一道路由门、用复核后的主体再判一次，不过即以 **4403** 关流（`core/http/server.ts`）。复核按**会话**认，不按升级时那一把访问密钥：页面刷新过访问密钥，流照旧。访问密钥到期（15 分钟）那一刻再按会话复核一次（安全审查 L1）：刷新过就续到新的到期时刻；没刷新以 **4401** 关（不是授权被收回，页面照常重连，升级前的门要新凭据——原生 App 换 WS 票遇 401 先轮转再换）；刷新过而门不再放行以 **4403** 关。没有请求身份的流（桌面壳）不设这个定时。
- `POST /api/identity/ws-ticket`（只在 Gateway 的 Bearer 模式下）：要 Bearer 会话，回 `{ "ticket": string, "expiresAt": string }`，票 30 秒、一次性、只在内存里。浏览器 WebSocket 带不了头，App 升级时在 `Sec-WebSocket-Protocol` 里带 `armadra-ticket.<票>`，服务端回同一个子协议。Cookie 模式请求它答 400 `bearer_required`。

## 18. 身份扩展：口令策略、passkey、MFA、会话、OAuth、审计

规格是 [补全架构](../design/completion-architecture.md) §8.3；实现在 `core/identity/`（`policy.ts`、`throttle.ts`、`passkey.ts`、`mfa/`，路由在 `accounts-http.ts`），形状的 zod 在 `packages/shared/src/api/identity-security.ts`。和 §10 同一个前缀、同一套认证（Origin、会话凭据；下面标「写」的在 Cookie 会话上要 `X-Armadra-CSRF`，Bearer 传输不要）。整段 `/api/identity/` 不经路由门（`core/http/route-scopes.ts` 的 `SELF_GUARDED`），本人与 `identity:manage` 的判定在身份域里。

**错误码**：身份域原有的五种仍是 UPPER_SNAKE（`UNAUTHENTICATED` / `PERMISSION_DENIED` / `INVALID_ARGUMENT` / `NOT_FOUND` / `CONFLICT`）；本节新增的具名拒绝是 snake_case，页面按 `code` 选文案。错误体只有 `{ code, message }`。迁移是 `identity_hardening`（`identity_credentials` 加 `sign_count / aaguid / transports_json / label`，新表 `identity_mfa`、`identity_recovery_codes`、`identity_lockouts`，`identity_sessions` 加 `last_seen_at_ms / remote_ip / user_agent`）。

### 18.1 口令策略与锁定

设口令（`POST credentials` `{ kind: "password" }`）与持邀请注册（`POST register`）先过策略，第一条不过的规则就是 `code`，HTTP 400：

| `code`                   | 规则                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `password_too_short`     | 码点数 < `identity.passwordMinLength`（缺省 12，可配 10–64）                       |
| `password_too_long`      | UTF-8 超过 1024 字节                                                               |
| `password_contains_name` | 含显示名或 principal 标识（不分大小写；三个字符以下的名字不参与）                  |
| `password_too_common`    | 在随包的常见口令表（`core/identity/common-passwords.txt`，1 万条）里，小写精确比对 |
| `password_breached`      | 泄露检查命中，且 `identity.breachCheck` 是 `block`（见下）                         |

**泄露检查**（`identity.breachCheck`，`core/identity/policy.ts`）：HIBP Pwned Passwords 的 k-匿名范围接口，只发 SHA-1 的前 5 位，带 `Add-Padding: true`，次数为 0 的填充行不算命中；4 秒超时。`auto`（缺省）在服务器壳与开了 Gateway 的桌面上按 `warn`，其余按 `off`。

| 档位    | 命中时                                                                         | 查不成（离线、超时、非 200）                         |
| ------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `off`   | 不发请求                                                                       | —                                                    |
| `warn`  | 照常设，答案多一个 `passwordBreached: true`；审计 `identity.password.breached` | 照常设；审计 `identity.password.breach_check_failed` |
| `block` | 400 `password_breached`，不设；审计 `identity.password.breached`               | 同 `warn`：不阻止设口令，只记审计                    |

审计的 `detail` 只有 `{ mode, ip }`，口令与哈希都不进。地址可用 `ARMADRA_HIBP_BASE` 换成 dev-stack 的 `hibp` fixture（出站表 `core/net/outbound.ts` 的 `hibpRange`）。

登录类请求（`login`、`mfa/verify`、`passkey/login/*`、`register`）的限流与锁定，HTTP 429，带 `Retry-After`（秒）。凭据换会话的那几条（`pair`、`session/refresh`、`session/csrf`、`session/logout`）共用同一个来源地址的桶，但**只有失败才扣**、桶空时同样答 429 `rate_limited`——它们的凭据是 256 位随机串，限的是撒网猜票，不让一台 NAT 后的多人互相挤掉刷新：

| `code`           | 什么时候                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rate_limited`   | 同一来源地址（socket 对端，不读 `X-Forwarded-For`）超过每分钟 20 次                                                                               |
| `account_locked` | 这个 `principalId` 连续 5 次口令或第二因素失败之后：锁 1 分钟，每多一次失败翻倍，封顶 15 分钟；锁着时不校验口令。成功清零，一小时没有新失败也清零 |

锁定按调用方报上来的 `principalId` 计，**不看账号是否存在**：不存在的账号也会被锁、答同一个 429，锁定因此不泄露存在性。

| 方法与路径                            | 谁能调            | 答案                                                                        |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `GET lockouts`                        | `identity:manage` | `{ lockouts: [{ key, principalId, failures, lockedUntilMs }] }`，只列锁着的 |
| `DELETE lockouts/{principalId}`（写） | `identity:manage` | `{ principalId, unlocked }`（原来是否锁着）                                 |

审计：`identity.login.failed`（`detail.reason`：`password` / `mfa` / `passkey` / `locked`）、`identity.lockout`（新上锁）、`identity.lockout.clear`。

### 18.2 passkey

`@simplewebauthn/server` 校验；attestation 只收 `none`，不做证明链校验；登录走可发现凭据（不给 `allowCredentials`）。挑战在内存里 2 分钟、一次性。

**RP ID**：`identity.rpId` 非空时用它（请求来源的主机必须是它或它的子域，否则 `passkey_rp_id_mismatch`）；否则取公网来源（`gateway.publicOrigin`）的主机名，多个公网来源取按标签的公共后缀（至少两段，取不到就用第一个）；都没有时取请求来源的主机。**主机是 IP 字面量时**一律 `passkey_unavailable_on_ip_host`。改 RP ID 会让已登记的 passkey 全部失效。

| 方法与路径                                                               | 谁能调                           | 答案                                                                                                                                                     |
| ------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET passkey`                                                            | 已登录                           | `{ available, rpId, reason, passkeys: [{ credentialId, label, aaguid, transports, createdAtMs }] }`；不可用时 `available: false`、`reason` 是下表的 code |
| `POST passkey/register/options` `{ label? }`（写）                       | 已登录（给自己登记）             | `{ challengeId, options }`，`options` 是 `PublicKeyCredentialCreationOptionsJSON`                                                                        |
| `POST passkey/register/verify` `{ challengeId, response, label? }`（写） | 同一个人、同一个来源要的挑战     | 201 `{ credentialId, label, aaguid, transports, createdAtMs }`；`response` 是 `PublicKeyCredential.toJSON()`                                             |
| `POST passkey/login/options` `{}`                                        | 匿名                             | `{ challengeId, options }`（`PublicKeyCredentialRequestOptionsJSON`）                                                                                    |
| `POST passkey/login/verify` `{ challengeId, response, deviceName? }`     | 匿名                             | 与 `login` 同形的会话；**视为已满足第二因素**；失败一律 401 `UNAUTHENTICATED`                                                                            |
| `DELETE passkey/{credentialId}`（写）                                    | 本人；别人的要 `identity:manage` | `{ credentialId, removed: true }`；看不到的答 404                                                                                                        |

| `code`（400）                    | 意思                                        |
| -------------------------------- | ------------------------------------------- |
| `passkey_unavailable_on_ip_host` | 以 IP 访问，WebAuthn 不可用；口令照旧       |
| `passkey_rp_id_mismatch`         | 请求来源不在配置的 RP ID 之下               |
| `passkey_challenge_expired`      | 挑战不存在、用过或过期（2 分钟）            |
| `passkey_verification_failed`    | 注册应答没过校验（来源、挑战、RP ID、签名） |

计数器按库的判定写回 `sign_count`；回退（克隆的认证器）由库拒绝。审计：`identity.passkey.add`、`identity.passkey.remove`、`identity.login`（`detail.method: "passkey"`）。

G5-02 追加：`PATCH passkey/{credentialId}` `{ label }`（写）给自己的 passkey 改名，答 `{ credentialId, label }`。`label` 1–64 个字符（按字符不按字节）、首尾无空白、无控制字符，否则 400 `INVALID_ARGUMENT`。只有本人：别人的（调用方有 `identity:manage` 也一样）、撤销了的、不存在的同样答 404。审计 `identity.passkey.rename`。

### 18.3 MFA：TOTP、恢复码与两步登录

TOTP 是 RFC 6238（`otplib`）：SHA-1、6 位、30 秒，前后各容一个时间步；记最后用过的时间步，**同一个码第二次一律拒**。密钥在 SecretStore（条目名 `armadra-totp-<principalId>`），库里只有条目名。恢复码 10 个（`xxxxx-xxxxx`，大小写、空格与连字符不计），只存 scrypt 哈希，用掉即作废。

**两步登录**：`POST login` 口令对了且这个人有**已确认**的 TOTP 时，不建会话，答：

```json
{
  "mfaRequired": true,
  "challengeId": "…",
  "expiresAtMs": 1760000000000,
  "methods": ["totp", "recovery"]
}
```

然后 `POST mfa/verify { challengeId, code }`（匿名）换出与 `login` 同形的会话。中间票 5 分钟、绑定来源、最多试 5 次；第二因素失败与口令失败计入同一个锁定。没有登记 TOTP 而 `identity.mfa.requireFor` 覆盖这个人（`all`，或 `members` 下的非 owner）时照常建会话，响应体多一个 `mfaEnrollmentRequired: true`，页面据此把人带去登记。

| 方法与路径                                 | 谁能调               | 答案                                                                                              |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| `GET mfa`                                  | 已登录               | `{ enrolled, pending, enrolledAtMs, verifiedAtMs, recoveryCodesRemaining, requireFor, required }` |
| `POST mfa/totp/enroll`（写）               | 已登录               | `{ secret, otpauthUri }`（只在这一次出现）；已确认过的答 409 `mfa_already_enrolled`               |
| `POST mfa/totp/confirm` `{ code }`（写）   | 已登录               | `{ recoveryCodes }`（10 个，只在这一次出现）                                                      |
| `POST mfa/verify` `{ challengeId, code }`  | 匿名                 | 会话                                                                                              |
| `POST mfa/recovery-codes` `{ code }`（写） | 本人，要当前有效的码 | `{ recoveryCodes }`，旧的全部作废                                                                 |
| `POST mfa/disable` `{ code }`（写）        | 本人，要当前有效的码 | `{ disabled: true }`                                                                              |
| `POST mfa/reset` `{ principalId }`（写）   | `identity:manage`    | `{ principalId, reset }`：替丢了手机的人清掉 TOTP 与恢复码                                        |

| `code`                   | HTTP | 意思                                           |
| ------------------------ | ---- | ---------------------------------------------- |
| `mfa_invalid_code`       | 401  | 码不对、用过（重放）或格式不对                 |
| `mfa_challenge_expired`  | 401  | 中间票不存在、过期、来源不对或试满了，回到口令 |
| `mfa_already_enrolled`   | 409  | 已有确认过的 TOTP，先停用                      |
| `mfa_secret_unavailable` | 503  | SecretStore 读写不了 TOTP 密钥                 |

审计：`identity.mfa.enroll`、`identity.mfa.disable`、`identity.mfa.reset`、`identity.mfa.recovery.used`、`identity.mfa.recovery.regenerate`、`identity.login`（`detail.method`：`totp` / `recovery`）。

### 18.4 会话列表与撤销

| 方法与路径                          | 谁能调                            | 答案                                                                                                                                                 |
| ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET sessions`                      | 已登录                            | `{ sessions: [{ sessionId, principalId, deviceId, deviceName, createdAtMs, lastSeenAtMs, expiresAtMs, remoteIp, userAgent, current }] }`，只列活着的 |
| `GET sessions?all=1`                | `identity:manage`（owner 看全部） | 同上，所有人的                                                                                                                                       |
| `DELETE sessions/{sessionId}`（写） | 本人；别人的要 `identity:manage`  | `{ sessionId, revoked: true }`；看不到的答 404                                                                                                       |
| `POST sessions/revoke-others`（写） | 已登录                            | `{ revoked }`：撤掉我除当前之外的全部会话（「其它设备全部登出」）                                                                                    |

`remoteIp` 是建会话那一刻的 socket 对端，`userAgent` 截到 256 字符；`lastSeenAtMs` 是最近一次认证成功，一分钟内不重写。撤销在下一个请求上生效（认证每次读库）。审计：`identity.session.revoke`、`identity.session.revoke-others`。

G5-02 追加：`GET devices`（我的设备，`{ devices, nextId, hasMore }`）的每一行多两个可选字段。`platform` 由这台设备最近那个会话的 UA 归出来，取 `macos / windows / linux / ios / android / web / unknown` 之一：认得出浏览器、说不出系统的是 `web`，空 UA 与认不出的是 `unknown`。UA 原文不在这个答案里。`lastSeenAtMs` 是这台设备所有会话（含已撤销、已过期的）里最大的 `lastSeenAtMs`。设备上没有任何会话时两项都不带；`lastSeenAtMs` 为 0（迁移 0032 之前的会话）时也不带。共享层 `DEVICE_PLATFORMS`。

### 18.5 OAuth / OIDC

实现在 `core/identity/oauth/`（`providers.ts` 协议、`flow.ts` 状态与决定、`http.ts` 路由），挂在比 `/api/identity/` 更长的原样前缀 `/api/identity/oauth/` 上；形状的 zod 在 `identity-security.ts` 的 §18.5 小节。一条代码路径：**通用 OIDC**（发现文档 `/.well-known/openid-configuration`，文档里的 `issuer` 必须与配置逐字节相同（只忽略末尾斜杠）；授权码 + PKCE S256 + `state` + `nonce`；`id_token` 按 JWKS 验签，只收 RS256 / ES256，核 `iss`、`aud`（多个时 `azp`）、`exp` / `iat` / `nbf`（容 60 秒）、`nonce`；缺邮箱时补一次 userinfo，`sub` 必须相同），以及唯一的特例 **GitHub**（`/login/oauth/authorize` + `access_token`，主体是 `GET /user` 的数字 `id`，邮箱取 `GET /user/emails` 里 `primary` 的那条与它的 `verified`）。外呼只许 HTTPS 或回环明文 HTTP，超时 10 秒，发现文档与 JWKS 缓存 1 小时，遇到不认识的 `kid` 重取一次 JWKS。

**提供方**在设置 `identity.oauth.providers[] { id, kind: "github" | "oidc", issuer?, clientId, scopes, allowSignup, allowedDomains, enabled }`（不加迁移）；`scopes` 空时 OIDC 用 `openid email profile`、GitHub 用 `read:user user:email`。`clientSecret` 在 SecretStore（条目名 `armadra-oidc-<id>`），不入库、不出接口；OIDC 公开客户端（PKCE）可以没有，GitHub 必须有。**公网来源**是 `gateway.publicOrigin` 加上壳注入的、主机名不是 IP 字面量的 HTTPS 来源（服务器壳的 `--public-origin`）；回调固定 `<公网来源>/api/identity/oauth/{id}/callback`，`start` 必须从其中一个来源发起。

**绑定**写 `identity_credentials(kind='oauth', provider, subject)`：`provider` 列是由 issuer 派生的键（`oidc:` + issuer 的 SHA-256 前 43 个 base64url 字符；GitHub 是 `github`）而不是设置里的 `id`——换了 issuer 而保留 `id` 时，旧绑定不会被新 issuer 的同名主体冒领。一个第三方身份只能绑一个 principal（唯一索引）。

| 方法与路径                                                                     | 谁能调                            | 答案                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET oauth/providers`                                                          | 匿名                              | `{ configured, providers: [{ id, kind }] }`：`configured` = 有公网来源；只列能用的（开着、有公网来源、GitHub 有 secret）                                                                                                                                                           |
| 同上                                                                           | `identity:manage`                 | 每行再加 `issuer?, clientId, enabled, allowSignup, allowedDomains, hasClientSecret, usable, callbackUrls`（每个公网来源一条，填到提供方的回调）；列全部提供方                                                                                                                      |
| `PUT oauth/providers/{id}/secret` `{ clientSecret }`（写）                     | `identity:manage`                 | `{ id, hasClientSecret: true }`                                                                                                                                                                                                                                                    |
| `DELETE oauth/providers/{id}/secret`（写）                                     | `identity:manage`                 | `{ id, hasClientSecret: false }`                                                                                                                                                                                                                                                   |
| `POST oauth/{id}/start` `{ mode?: "login" \| "bind", returnTo?, deviceName? }` | `login` 匿名；`bind` 已登录（写） | `{ authorizeUrl, expiresAtMs }`，同时下发浏览器绑定 Cookie（`armadra_<hostId>_oauth`，HTTPS 上换成 `__Host-armadra_` 前缀，`HttpOnly; SameSite=Lax; Path=/`，10 分钟）。页面随后 `location.assign(authorizeUrl)`。`returnTo` 只收站内路径（`/` 开头、不是 `//`、无片段），缺省 `/` |
| `GET oauth/{id}/callback?state&code`（或 `error`）                             | 提供方跳回                        | 302 到 `<发起时的来源><returnTo>#oauth=<结果>`；`state` 不认识时答 JSON 400 `oauth_state_invalid`                                                                                                                                                                                  |
| `GET oauth/bindings`                                                           | 已登录                            | `{ bindings: [{ credentialId, providerId, kind, createdAtMs }] }`：我的；设置里认不出的提供方 `providerId` 为空串                                                                                                                                                                  |
| `DELETE oauth/bindings/{credentialId}`（写）                                   | 本人                              | `{ credentialId, revoked: true }`；别人的答 404（owner 撤别人的走 `DELETE credentials/{id}`）                                                                                                                                                                                      |
| `POST oauth/{id}/start?native=1`（同上的请求体）                               | 同上，只认原生传输上的请求        | `{ authorizeUrl, expiresAtMs, nativeState }`，**不发** Cookie。`nativeState` 是一次性的收尾密钥，App 记在本机；浏览器上的请求带 `native=1` 答 400 `INVALID_ARGUMENT`（R-56）                                                                                                       |
| `POST oauth/{id}/native` `{ state, nativeState, code? \| error? }`             | 原生 App 收到深链后（匿名）       | 与回调同一套决定，答 JSON：`{ result: "signedIn" \| "signedUp", session, mfaEnrollmentRequired? }`（`session` 与原生传输上登录类答案同形，密钥在 `session.native`）、`{ result: "mfa", challengeId }`、`{ result: "bound" }`；失败是下表的 `{ code, message }`                     |
| `POST oauth/{id}/logout` `{ returnTo? }`                                       | 匿名                              | `{ endSessionUrl }`：OIDC 发现文档有 `end_session_endpoint` 时是 RP 发起登出的地址（`client_id` + `post_logout_redirect_uri`），否则 `null`；本机会话仍由 `POST session/logout` 结束                                                                                               |

**回调**是从提供方跳回的顶层导航（没有 `Origin`、`Sec-Fetch-Site: cross-site`、`SameSite=Strict` 的会话 Cookie 带不上），所以它不认会话：`state` 内存里 10 分钟、**取出即删**（重放、过期、浏览器绑定 Cookie 不对都是 `oauth_state_invalid`），`bind` 的发起者在 `start` 时就记进状态。Gateway 的门只对 `GET /api/identity/oauth/{id}/callback` 放开 Origin 与 `Sec-Fetch-Site` 两道（`core/gateway/admission.ts` 的 `oauthCallbackPath`）。跳回片段的 `oauth=`：

| `oauth=`   | 意思                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `bound`    | 绑到了发起者名下（已绑在本人名下也是它）                                                       |
| `signedIn` | 已绑定的 principal 登录，会话 Cookie 已下发；审计 `identity.login`（`detail.method: "oauth"`） |
| `signedUp` | 建了一个 `member`（无授予，owner 再共享）并登录                                                |
| `mfa`      | 这个人登记过 TOTP：带 `challengeId`，页面接 §18.3 的 `POST mfa/verify`；不发会话               |
| `error`    | 带 `code`（下表）；不发会话、不改绑定                                                          |

**原生 App**（R-56）：`start?native=1` 发起的记录不认浏览器绑定，认 `nativeState`。回调对这种记录**不取走**、不认 Cookie，只 302 到 `armadra://oauth?state=<state>&code=<授权码>`（提供方拒绝时是 `&error=<原样，至多 64 字符>`），由 App 带着 `nativeState` 调 `POST oauth/{id}/native` 收尾——那一次才取出即删；`nativeState` 不对、提供方或来源与发起时不同、浏览器发起的记录走 `native`，都答 `oauth_state_invalid`。授权码在深链里被别的 App 截走也换不到会话：收尾要 `nativeState`（只在发起它的 App 本机）与 PKCE verifier（只在 core）。提供方那边仍只登记 `<公网来源>/api/identity/oauth/{id}/callback`。App 里没有会话时收尾答 `mfa`：App 不写 `#oauth=` 片段，在入口整页接着做第二步（同一个登录组件，`POST mfa/verify { challengeId, code }`，会话照原生传输的规矩进钥匙串），中间票不进地址栏；已有会话时仍写片段交给「安全」页。

`signedIn` / `signedUp` 时，`identity.mfa.requireFor` 覆盖这个人而他还没登记 TOTP，片段再带 `mfaEnrollmentRequired=true`：照常发会话，页面带去登记（与口令登录答案里的 `mfaEnrollmentRequired` 同一条，§18.3；R-17）。

**挂起的 `state`** 按来源地址分桶（安全审查 L4）：每个地址（IPv6 按 /64，IPv4 映射地址按 IPv4）同时至多 50 条，满了挤它自己最老的；全部合计至多 1000 条，满了挤挂得最多的那个地址最老的一条。从多个地址撒 `start` 挤不掉别人半途的登录。

决定：配了 `allowedDomains` 时三条路都要求 `email_verified = true` 且邮箱域名精确命中（大小写不计，子域不算）；`bind` 绑到发起者；`login` 已绑则登录（principal 停用了按「没绑」答），没绑且 `allowSignup` **并且** `allowedDomains` 非空才建号（这就是 SSO；不设域名的建号等于「有这家账号的任何人都能进来」），否则 `oauth_not_bound`。

| `code`                     | HTTP | 意思                                                                        |
| -------------------------- | ---- | --------------------------------------------------------------------------- |
| `oauth_not_configured`     | 404  | 没有公网来源、不是从公网来源发起、提供方不存在或停用、GitHub 没有 secret    |
| `oauth_browser_required`   | 400  | Gateway 的 Bearer 模式（原生 App）发起而没带 `native=1`（旧版 App）         |
| `oauth_state_invalid`      | 400  | `state` 不认识、过期、用过，或浏览器绑定 Cookie 不对                        |
| `oauth_denied`             | 403  | 用户在提供方取消（`error=access_denied`）                                   |
| `oauth_provider_error`     | 502  | 发现文档、JWKS、令牌交换或用户信息失败；发现文档 `issuer` 不符；不支持 S256 |
| `oauth_token_invalid`      | 401  | `id_token` 签名、算法、`iss` / `aud` / `azp`、时效或 `nonce` 不过           |
| `oauth_email_unverified`   | 403  | 提供方说邮箱没验证                                                          |
| `oauth_domain_not_allowed` | 403  | 邮箱域名不在 `allowedDomains`                                               |
| `oauth_not_bound`          | 401  | 这个第三方身份没有绑定账号（且不允许建号）                                  |
| `oauth_already_bound`      | 409  | 这个第三方身份已经绑在别的账号上                                            |

审计：`identity.oauth.bind`、`identity.oauth.unbind`、`identity.oauth.signup`、`identity.oauth.failed`（`detail.code`）、`identity.oauth.secret.set` / `.clear`。`credentials/oauth/*` 的旧 501 占位路径已退役（404）。

### 18.6 审计查询

查的是 `audit_log`（迁移 `accounts`），写入点见各节的「审计」一行与 `core/identity/audit.ts` 的 `SECURITY_AUDIT_ACTIONS`。实现在 `accounts-http.ts` 的审计一段，形状的 zod 在 `identity-security.ts` 的 §18.6 小节。两条都只读；谁能调与原来一样：带 `workspaceId` 要那块画布的 `workspace:share`，不带要 `identity:manage`（owner）。

筛选参数（查询串，都可选，彼此 AND）：

| 参数                 | 意思                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `principalId`        | 动作的发起者                                                                                            |
| `workspaceId`        | 动作所在的工作空间                                                                                      |
| `action`（可重复）   | 动作或动作族：`identity.login` 命中它自己与 `identity.login.*`（不命中 `identity.loginx`）；多个之间 OR |
| `sinceMs`、`untilMs` | 时间窗，`sinceMs <= atMs < untilMs`，毫秒                                                               |
| `beforeId`           | 翻页游标：只要 `id < beforeId` 的                                                                       |
| `limit`              | 一页几行，1–500，缺省或越界取 100（只对 `GET audit`）                                                   |

数字参数写错（非整数、负数、`beforeId` 为 0）答 400 `INVALID_ARGUMENT`，不悄悄当成「不筛」；`action` 超过 20 个或单个超过 128 字符同样 400。

| 方法与路径         | 答案                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET audit`        | `{ entries: [{ id, atMs, principalId, deviceId, action, target, workspaceId, detail }], nextBeforeId }`，从新到旧；`nextBeforeId` 是下一页的 `beforeId`，0 表示没有更早的了   |
| `GET audit/export` | `text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="armadra-audit.csv"`；同样的筛选、不分页，从新到旧最多 10000 行；错误照旧是 JSON 的 `{ code, message }` |

CSV 按 RFC 4180：`\r\n` 换行，首行表头 `id,time,principalId,deviceId,action,target,workspaceId,detail`；`time` 是 ISO 8601（UTC），`detail` 是 JSON 文本（没有时空）；含逗号、引号或换行的单元格加引号、引号双写；以 `=`、`+`、`-`、`@`、制表或回车开头的单元格前面补一个 `'`（表格软件的公式注入）。页面的「结果」由动作名推出：`.failed`、`identity.lockout` 记为失败，其余为成功。

## 19. 推送：`/api/push/devices*`

> 自协议 1.14 起这些路由同时是 `push.*` procedure（§43.4），旧路径与 procedure 调同一份实现。

设计见[补全架构](../design/completion-architecture.md) §10 与[外部服务](../design/external-services.md) §5.2。代码在 `core/push/`，共享层 `api/push.ts`。表 `push_devices` / `push_outbox`（迁移 `*_push.sql`）。

`/api/push/*` 不经路由门（`http/route-scopes.ts` 的 `SELF_GUARDED`），推送域自己认请求身份，**只碰请求主体自己的设备**：服务器壳的匿名主体答 401 `unauthenticated`；桌面壳的本机请求没有请求身份（主体是本机 owner、没有设备），看配置与列表可以，登记与测试答 409 `device_required`——桌面有系统通知，不用推送。错误一律 `{ code, message }`。

### 19.1 `GET /api/push/config`

```json
{
  "webpush": {
    "enabled": true,
    "publicKey": "BJ…（P-256 未压缩点，base64url）"
  },
  "native": { "transport": "direct", "status": "ready", "platforms": ["ios"] }
}
```

- `webpush.publicKey`：VAPID 公钥，页面订阅时作 `applicationServerKey`。密钥对首次用到时生成在 `<数据目录>/push/vapid.json`（0600）；文件损坏不重新生成（浏览器订阅绑在旧公钥上），此时为 `null`。设置 `push.webpush.enabled = false` 时也是 `null`。
- `native.transport`：原生 App 走哪条路，`log` / `direct` / `relay`（设置 `push.transport`，环境变量 `ARMADRA_PUSH_TRANSPORT` 优先；设置停在 `log` 而服务器壳给了 `ARMADRA_PUSH_RELAY_URL` 就是 `relay`，给了 APNs / FCM 文件就是 `direct`）。`status` 为 `notConfigured` 时接口照常答 `queued`，通知只写 debug 日志。`platforms` 是现在发得出去的原生平台。App 按 `transport` 决定登记平台令牌（`direct`）还是先向中继换中继令牌（`relay`）。

### 19.2 `PUT /api/push/devices`

登记这次请求所属的那台身份设备（请求体里没有设备 id）。覆盖式：同一台设备重新订阅就是替换这一行、清掉撤销状态。

浏览器：

```json
{
  "platform": "web",
  "transport": "webpush",
  "locale": "zh-CN",
  "subscription": {
    "endpoint": "https://…",
    "keys": { "p256dh": "…", "auth": "…" }
  }
}
```

原生 App：

```json
{
  "platform": "ios",
  "transport": "direct",
  "token": "<APNs / FCM 令牌，或中继令牌>",
  "publicKey": "<设备 X25519 公钥，32 字节 base64url>",
  "appVersion": "1.0.0",
  "locale": "en"
}
```

- `web` 只能配 `webpush`，`ios` / `android` 只能配 `direct` / `relay`。Android 还可带 UnifiedPush 端点（§27.2）。`endpoint` 必须是 https（回环上的 http 只给测试）；`p256dh` 是 65 字节 P-256 点，`auth` 是 16 字节。
- `relay` 必须带 `publicKey`：经中继的载荷一律端到端加密。`direct` 带了也加密，不带时 APNs 发明文提示、FCM 发明文数据。
- `locale` 只认 `zh-CN` / `en`，其余当作没给（按中文渲染）。
- 答 200 `{ "device": <§19.3 的设备> }`；身份设备已撤销答 403 `forbidden`；形状不对答 400 `bad_request`。

### 19.3 列表、撤销、测试

- `GET /api/push/devices` → `{ "devices": [ … ] }`，只列请求主体名下还有效的登记（桌面本机 owner 列全部）。一项是 `{ deviceId, platform, transport, appVersion, locale, encrypted, createdAt, current }`——**没有令牌、没有公钥本身**；`encrypted` 说厂商看到的是不是密文，`current` 说是不是发请求的这台。
- `DELETE /api/push/devices/{deviceId}` → `{ "revoked": true }`（已经撤销过是 `false`）。只能撤自己名下的，owner 例外；别人的与不存在的同样答 404 `not_found`。
- `POST /api/push/test` → 202 `{ "queued": true, "id": "<队列行 id>" }`，给发请求的这台设备发一条 `kind: "test"`。这台设备没登记或已撤销答 409 `device_required`。

### 19.4 载荷

一条通知就是这些键，**没有别的**（共享层 `pushPayloadSchema` 是 `strict`）：

```json
{
  "v": 1,
  "kind": "approval",
  "title": "支付服务",
  "body": "Claude Code 等待审批",
  "url": "armadra://w/<workspaceId>/n/<nodeId>",
  "tag": "approval:<pendingId>"
}
```

- `kind`：`approval`、`agentDone`、`agentError`、`deliveryFailed`、`schedule`、`resources`、`comment`、`workflowGate`、`test`。
- `title` 是工作空间名（≤ 64 字），`body` 是按 `kind` 与设备语言写死的一句（≤ 120 字，只会出现 Agent 注册表里的名字），`url` 是深链（与画布无关的通知是 `armadra://`），`tag` 相同的新通知替换旧的（≤ 128 字）。
- 不含终端原文、文件内容、命令、提示词、评论正文、拒收码。载荷因此可以落库（`push_outbox.payload_blob`）。

### 19.5 三条传输的线上形状

- **Web Push**：`POST <endpoint>`，`Authorization: vapid t=<ES256 JWT>, k=<VAPID 公钥>`（`aud` = 端点来源，12 小时有效，`sub` = 设置 `push.webpush.subject` / `ARMADRA_PUSH_VAPID_SUBJECT`，缺省取 https 公网来源，再缺省 `mailto:push@armadra.invalid`），`Content-Encoding: aes128gcm`（RFC 8291，单记录 4096），`TTL: 3600`，`Urgency`（审批 `high`），`Topic` = tag 的摘要。正文是 §19.4 的 JSON。
- **direct**：APNs HTTP/2 `POST /3/device/<token>`，provider token ES256（`kid` / `iss` / `iat`，50 分钟换新），`apns-topic` = bundle id，`apns-push-type: alert`，`apns-collapse-id` = tag 的摘要；有设备公钥时正文是 `{ "aps": { "alert": { "title-loc-key": "ARMADRA_PUSH_TITLE", "loc-key": "ARMADRA_PUSH_BODY" }, "mutable-content": 1, … }, "enc": <信封> }`。FCM v1 `POST /v1/projects/<id>/messages:send`，access token 由服务账号断言（RS256）换取；`message.data.enc` 是信封的 JSON 字符串，`android.priority: HIGH`。密钥只从文件读：`ARMADRA_PUSH_APNS_KEY_FILE` / `_KEY_ID` / `_TEAM_ID` / `_BUNDLE_ID` / `_PRODUCTION`、`ARMADRA_PUSH_FCM_CREDENTIALS_FILE` / `_PROJECT_ID`，或设置 `push.apns.*` / `push.fcm.*`（两个文件路径是本机设置）。`ARMADRA_PUSH_APNS_ENDPOINT` / `ARMADRA_PUSH_FCM_ENDPOINT` 只给测试。
- **relay**：`POST <relayUrl>/v1/push` `{ relayToken, envelope, collapseId, urgent }`，中继的完整接口见 [`apps/push-relay/README.md`](../../apps/push-relay/README.md)。
- **信封**：`{ "v": 1, "alg": "x25519-hkdf-sha256-a256gcm", "epk", "salt", "iv", "ct" }`，全部 base64url。`epk` 是一次性 X25519 公钥；钥 = HKDF-SHA256(ECDH(epk, 设备公钥), salt, `"armadra-push-v1" ‖ 0x00 ‖ epk ‖ 设备公钥`, 32)；`ct` = AES-256-GCM(钥, iv, §19.4 的 JSON) ‖ 16 字节标签。

### 19.6 触发、收件人与重试

- 推送订阅工作空间事件：`agent.approval`（新请求；`request.resolved` 的答复不推）、`agent.status`（**进入** `done` 推 `agentDone`，进入出错推 `agentError`；`restored` 行不推）、`agent.delivery`（`outcome` 为 `refused` / `failed` / `expired` / `cancelled`（回执），深链指向发送方节点）、`schedule.*`、`resources.threshold`、`board.comment`（只推给 `mentions` 里的 principal，没有提及不推）、`workflow.gate`。后四种事件由各自的域发布，推送只按 `type` 与其中的 `nodeId` / `automationId` / `metric` / `comment.{id,anchorKind,anchorId,mentions}` / `runId` / `stepId` 认。`schedule.*` 只认 §27.3 的三种、按 `planId` 认；`resources.threshold` 的形状见 §27.4。
- 收件人：登记有效、身份设备未撤销、principal 未停用，且该 principal 对事件所在工作空间有 `canvas:read`（owner 恒有）。设备设了种类偏好的，只收它选的种类（§27.1）。
- 先入队（`push_outbox`）再发；总共最多 3 次尝试（失败后 5 秒、30 秒各再试一次），只有网络错误、429 与 5xx 再试。平台说令牌作废（Web Push 404 / 410，APNs 410 / `BadDeviceToken` / `Unregistered`，FCM `UNREGISTERED`，中继 410 / `badToken`）立即停、设备登记撤销（`revoked_reason = 'gone'`）。终态行保留 7 天。App 按旧配置登记的（例如登记时是 `direct`，现在改成 `relay`）只记日志，等 App 按新配置重新登记。

## 20. 节点凭据：`/api/credentials*`

> 自协议 1.14 起 §20.2 的四条路由同时是 `credentials.*` procedure（§43.6），旧路径与 procedure 调同一份实现。

设计见 [补全架构](../design/completion-architecture.md) §9.1 与 [CLI 协作](../design/cli-collaboration.md) §7.3。一个节点可以绑定一条具名凭据，起终端时由 core 校验、CLI 启动时由画布启动器现取并只设给 CLI 进程。代码在 `core/agent/credentials/`，共享层 `packages/shared/src/api/credentials.ts`。

**值的去向**：只在执行主机的 SecretStore（条目名 `armadra-credential-<ref>`）。库表 `agent_credentials` 只记 `ref`、`providerId`、`kind`、`label`、`createdAt`、`lastUsedAt`。值不进节点 shell 的环境、启动行、shell 历史、画布持久化、日志，也不进任何 `/api/*` 答复；**唯一带值的是 §20.4 那条本机回环的 hook 答复**，答给启动器，带 `Cache-Control: no-store`，不记日志。

### 20.1 `kind` 表

`kind` 只能从下表选，变量名由 core 写死（`core/agent/credentials/inject.ts::CREDENTIAL_KINDS`），不上线、不让用户填。`enabled: false` 的行列在表里，新建与启动都拒绝，等 CLI 协作 §7.4 用真实账号测过再开。

| `providerId` | `kind`              | 变量                      | `enabled`   |
| ------------ | ------------------- | ------------------------- | ----------- |
| `claude`     | `oauth-token`       | `CLAUDE_CODE_OAUTH_TOKEN` | 是          |
| `claude`     | `api-key`           | `ANTHROPIC_API_KEY`       | 否（T1）    |
| `copilot`    | `github-token`      | `COPILOT_GITHUB_TOKEN`    | 是          |
| `codex`      | `api-key`           | `CODEX_API_KEY`           | 否（T4）    |
| `pi` / `omp` | `api-key:anthropic` | `ANTHROPIC_API_KEY`       | 否（T5/T6） |
| `pi` / `omp` | `api-key:openai`    | `OPENAI_API_KEY`          | 否（T5/T6） |
| `pi` / `omp` | `api-key:moonshot`  | `MOONSHOT_API_KEY`        | 否（T5/T6） |
| `opencode`   | `api-key:anthropic` | `ANTHROPIC_API_KEY`       | 否（T7）    |
| `opencode`   | `api-key:openai`    | `OPENAI_API_KEY`          | 否（T7）    |

`providerId` 是基础 CLI 的 id；`custom:` 条目按它的 `baseAgent` 匹配。

### 20.2 条目路由

只有 owner（路由门按全局 `settings:read` / `settings:write`，成员一律 `403 forbidden`）。

- `GET /api/credentials` →

  ```json
  {
    "backend": "keychain",
    "available": true,
    "kinds": [
      { "providerId": "claude", "kind": "oauth-token", "enabled": true }
    ],
    "entries": [
      {
        "ref": "3f9c2a1b7d4e8f60",
        "providerId": "claude",
        "kind": "oauth-token",
        "label": "Work",
        "isSet": true,
        "lastUsedAt": 1790000000000
      }
    ]
  }
  ```

  `backend` 是密钥后端自报的种类（`keychain` / `dpapi` / `libsecret` / `file-encrypted` / `file`）。`available: false` 时多一个 `reason`：`credential_backend_insecure`（后端是 `file`）或 `credential_unsupported_here`（Windows 上没有画布启动器 `armadra-launch.exe`：开发树没在 Windows 上 build、或打包时没有 `csc`；这时节点终端起的是裸行，凭据不会生效）。`isSet` 是值在不在（后端打不开也答 `false`）；`lastUsedAt` 从没被取用过时缺席。

- `POST /api/credentials`，体 `{ providerId, kind, label, value }` → `201` 条目。`ref` 由 core 生成（16 位小写十六进制）。`value` 单行、去首尾空白、最长 8192。
- `PATCH /api/credentials/{ref}`，体 `{ label?, value? }`（至少一个）→ `200` 条目。`providerId` 与 `kind` 不可改：换种类就是另一条凭据。
- `DELETE /api/credentials/{ref}` → `204`。先删值后删行。绑定着它的节点下次起终端时被拒（`credential_mismatch`）。

### 20.3 `POST /api/terminals` 的 `credentialRef`

`agent` 段多一个可选的 `credentialRef`（条目名，1–200 字符）。页面从节点数据 `agent.account.credentialRef` 取（`apps/web/src/agent/launch.ts::agentSessionRequest`）。core 在起任何进程之前校验，不满足时整个请求被拒、不建会话行：

| 状态 | `code`                        | 何时                                                                            |
| ---- | ----------------------------- | ------------------------------------------------------------------------------- |
| 400  | `bad_request`                 | `credentialRef` 不是非空字符串或超长                                            |
| 400  | `credential_mismatch`         | 条目不存在，或它的 `providerId` 不是节点的基础 CLI                              |
| 400  | `credential_kind_disabled`    | 条目的 `kind` 在 §20.1 里是 `enabled: false`                                    |
| 400  | `credential_unsupported_here` | SSH 节点（凭据在控制端，不经 SSH 下发），或 Windows 上没有 `armadra-launch.exe` |
| 409  | `credential_backend_insecure` | 这台主机的密钥后端自报 `file`                                                   |
| 403  | `credential_forbidden`        | 请求者没有全局 `credential:use`（服务器壳上的成员）                             |

`credential_forbidden` 不只看请求体：没给 `credentialRef` 而节点数据里绑着一条时（ACP 会话、依赖编排在这次请求里替节点起终端），成员同样被拒。凭据是 owner 的账号，共享角色里没有 `credential:use`；本机壳与 core 自己的动作没有请求身份，按 owner 判。

通过后节点终端的环境里只多一个变量 `ARMADRA_CREDENTIAL_REF=<ref>`（名字，不是值）。依赖编排、冷启动与节能唤醒没有请求体，读节点数据里的绑定照样带上这个变量；那里不预先校验，绑定失效时由 §20.4 拒绝、启动器拒绝起 CLI，而不是悄悄用默认登录。

条目路由的其余错误码：`credential_not_found`（404，`PATCH` / `DELETE` 一个不存在的 `ref`）、`credential_unavailable`（503，密钥后端这一刻打不开）。

### 20.4 启动器兑换：hook 面的 `POST /credential`

只在本机 hook 服务（Unix socket / 回环端口，契约 §5.2）上，不在主监听器、Gateway 或执行主机上。

- 调用方：画布启动器 `run/<cli>`（POSIX）与 `run\<cli>.exe`（Windows，`.launch` 里的 `credential=<客户端>` 与 `credential-var=<名字>` 行）在 `ARMADRA_NODE_ID` 与 `ARMADRA_CREDENTIAL_REF` 都在时执行 `armadra-hook credential`，后者发这一条。
- 请求：头 `X-Armadra-Hook-Token`（应用 bearer）与 `X-Armadra-Node-Token`（必须验过，`legacy` 不行）；体 `{ "nodeId", "ref" }`。
- 只答这个节点此刻绑定的那一条：起终端时记下的绑定，core 重启后改读节点数据 `agent.account.credentialRef` 与 `agent.id`；每次都重新做 §20.3 的校验。
- 成功 `200 { "variable": "CLAUDE_CODE_OAUTH_TOKEN", "value": "…" }`，并更新 `lastUsedAt`；日志只记 `nodeId` 与 `ref`。失败：`403 forbidden`（token 不对、或节点没绑这一条）、§20.3 的各码、`409 credential_unset`（值不在）、`503 credential_unavailable`。
- 客户端把 `NAME=value` 打到 stdout，启动器用命令替换接住（Windows 读客户端子进程的标准输出），只认这家 CLI 在 §20.1 里的变量名（字面的 `case` 分支，没有 `eval`；Windows 是 `.launch` 里的名单），在自己的进程里设好后起 CLI。客户端失败或名字不认识时启动器打一行原因、退出码非零（客户端的退出码原样透传），不起 CLI。Windows 上的值只进 CLI 进程的环境，不经 `cmd.exe` 再读：程序是批处理包装、注入词被跳过时照样兑换。

**威胁模型**：这防的是误泄露（shell 的 `env` 输出、回滚缓冲区、shell 历史、日志、磁盘），不是同一用户的主动读取——持有节点 token 的进程本来就能兑换。CLI 起的子进程（bash 工具、MCP 服务器）会继承这个变量；设置页的脚注写明这一点，并建议用权限最窄的凭据（`setup-token`、只开 Copilot Requests 的细粒度 PAT）。

## 21. 跨主机交接与 Worker 舰队

### 21.1 跨执行主机交接：`POST /api/workspaces/{workspaceId}/handoffs`

请求形状不变。来源 Agent 跑在 SSH 终端里、而那台主机不是工作空间所在的机器时，不再一律 501：

- 文件引用与 Git 指纹照旧在工作空间所在的机器上读（路径相对工作空间根）。
- 要读转录（`includeTranscript: true`，且来源的状态是已验证、当前代次的）时，转录尾巴到来源那台主机上读：控制端经那台主机 Worker 的 `handoff.capture`（参数加 `transcriptOnly: true`，`paths` 为空）读，与本机同一个读法、同一组历史适配器归一化。那台主机必须在执行主机登记里、配了 Worker、Worker 连得上并提供 `remote.handoff.v1`；任何一条不满足答 **501 `handoff_host_offline`**，不回退到读控制端磁盘上同名的路径。不读转录时不连那台主机。
- 目标在哪台主机都接受：材料是文本与相对路径。`bundle.target.executionHost` 照实写目标的主机。
- 冻结的材料多一个可选字段 `capturedOn: string`：来源转录在哪台执行主机上读的（主机 id）。来源与工作空间在同一台执行主机上、或在另一台执行主机上读到时都有；在控制端本机读、或没有读转录时不出现。旧行没有这个字段，读回照常。

| 情况                                                | 答复                                   |
| --------------------------------------------------- | -------------------------------------- |
| 来源主机已登记、有 Worker、连得上                   | 200，`bundle.capturedOn` 为那台主机 id |
| 来源主机不在登记里，或登记了但没配 Worker           | 501 `handoff_host_offline`             |
| Worker 连不上、握手失败、缺 `remote.handoff.v1`     | 501 `handoff_host_offline`             |
| 不读转录（`includeTranscript: false` 或来源未验证） | 200，不连来源主机，无 `capturedOn`     |

### 21.2 Worker 舰队

控制连接每次握手成功，控制端按主机记下 Worker 的 `runtimeVersion` 与能力集合；连接断了只把 `connected` 置假。「过旧」是：版本比这个控制端旧（点分数字比，预发布低于同号正式版，构建元数据不比），或缺这个控制端的 Worker 会声明的任何一个能力。比控制端新的不算过旧；版本读不出来时只按能力判。

- `GET /api/execution-hosts` 与新增的 `GET /api/execution-hosts/{id}`（`""` 是本机；不存在 404 `not_found`）：SSH 行在握过手之后多一个 `worker`：

  ```json
  {
    "version": "0.1.0",
    "capabilities": ["remote.execution.v1", "remote.handoff.v1"],
    "outdated": false,
    "connected": true,
    "checkedAt": "2026-10-03T08:00:00.000Z"
  }
  ```

  没握过手的主机没有 `worker`；本机行永远没有。

- `POST /api/execution-hosts/{id}/resync`：丢掉这台主机的控制连接，重新握手（刚升级的 Worker 在这里报新版本），再把画布注入重新同步一次（开过画布 SSH 终端的主机立刻同步并重开中继；没开过的只清掉「待升级」记号）。答复与 `GET …/{id}` 同形。不存在 404 `not_found`；没配 Worker 501 `unsupported`；连不上或握手失败按远端的错误码答（如 503 `unavailable`）。权限与其余执行主机写路由相同（`settings:write`）。
- `GET /api/agents/{id}/integration` 多一个 `outdatedHosts: [{ hostId, name?, version? }]`：舰队判为过旧的主机，加上注入同步时 Worker 只有 `remote.integration.v1` 的主机（§13.4），按主机 id 去重排序。每个 CLI 的集成状态给的是同一份表；没有远端域的 core 不给这个字段。`GET /api/agents` 的行**不**带它。

### 21.3 健康探测历史

`GET /api/execution-hosts`、`GET …/{id}` 与 `POST …/resync` 的 SSH 行多一个可选的 `health`：这次运行里这台主机最近 20 条健康记录，旧的在前；一条都没有时不出现，本机行永远没有。只在内存里，core 重启从空开始。

```json
[
  {
    "at": "2026-10-03T08:00:00.000Z",
    "event": "handshake",
    "ok": true,
    "version": "0.1.0"
  },
  { "at": "2026-10-03T08:05:00.000Z", "event": "disconnected", "ok": false },
  {
    "at": "2026-10-03T08:06:00.000Z",
    "event": "failed",
    "ok": false,
    "code": "unreachable"
  }
]
```

| `event`        | 何时记                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `handshake`    | 控制连接握手成功（含验证与重新同步触发的握手）；`version` 是对方报的 `runtimeVersion`，没报时不出现                     |
| `disconnected` | 控制连接从在线变为断开                                                                                                  |
| `failed`       | `POST …/validate` 没过（`code` 是答复的 `reason`；`noWorkerConfigured` 不记）或 `POST …/resync` 失败（`code` 是错误码） |

## 22. 投递画面门补充

画面门（[投递设计](../design/agent-delivery.md) §4.3「画面门」）的判据在 `core/agent/screen-gate.ts`，「取画面 → 判定 → 退回理由」在 `core/collab/screen.ts::checkScreen`；`send`（§12）与计划投递共用这一份。线上没有新路由，变化只在理由码与判据。

**计划投递**（`core/schedule/dispatch.ts`）：Agent 目标的探测在状态、半截输入、冷启动之后再过画面门；停在对话框上、或首投时看不见提示符，探测答 `busy` 并带 `reason: "TARGET_NOT_AT_PROMPT"`。运行进 `WAITING_TARGET`，`reasonCode` 记探测给的理由（没有理由仍是 `TARGET_NOT_IDLE`，理由变了跟着改写），下一拍再探；写入前的复核退回时收据是 `NOT_DISPATCHED` + `TARGET_NOT_AT_PROMPT`（其余仍是 `TARGET_NOT_READY`）。「首投」= 没有一条晚于冷启动、来自 `hook` / `extension` / `acp` 的回合结束上报（`idle` / `done` / `error`）。

**判据**：

- 只看最后 60 行，按位置判：对话框特征或选择菜单出现在最后一处提示符**之后**才拦；一行同时像提示符和对话框按对话框算。
- 选择菜单（通用，id `<cli>.unrecognized-menu`）：高亮的编号选项（`❯ 1.` / `› 2.` / `> 1.`），或页脚 `Enter to confirm` / `Esc to cancel` / `enter continue · esc …` / `Press Enter to continue` / `[y/N]`。只对有画面特征的 CLI 生效。
- 对话框特征不论 `verified` 都用；提示符特征只用 `verified: true` 的（没核实的提示符不要求，以免永远投不进去）。没有对话框、也没有核实过的提示符的 CLI 不取画面。

**对话框 id**（`verified` 为真 = 对过本机安装包字符串或实际画面）：

| id                                  | verified | 出处                                       |
| ----------------------------------- | -------- | ------------------------------------------ |
| `claude.workspace-trust`            | 是       | Claude Code 2.1.286 安装包字符串           |
| `claude.bypass-permissions-warning` | 是       | 同上                                       |
| `claude.auto-mode-default`          | 是       | 同上与本机画面                             |
| `codex.folder-trust`                | 是       | Codex 0.159.3 画面、0.160.0 安装包字符串   |
| `codex.update`                      | 是       | 两种形态：0.155.1 画面、0.160.0 「✨」横幅 |
| `codex.hooks-review`                | 是       | Codex 0.160.0 安装包字符串                 |
| `codex.model-migration`             | 是       | 同上                                       |
| `codex.sign-in`                     | 是       | 同上                                       |
| `codex.rate-limit-switch`           | 是       | 同上                                       |
| `codex.full-access-warning`         | 是       | 同上                                       |
| `codex.mcp-install`                 | 是       | 同上                                       |
| `codex.database-rebuilt`            | 是       | 同上                                       |
| `copilot.folder-trust`              | 否       | GitHub 官方文档，本机未安装                |
| `pi.project-trust`                  | 是       | Pi 1.0.0 安装包字符串                      |
| `omp.project-trust`                 | 否       | 按同源的 Pi 推断，本机未安装               |

提示符：Claude（单独一个 `❯`、`? for shortcuts`、`(shift+tab to cycle)`）与 Codex（`›` 后面不是编号，也不是 `Waiting for startup` / `Resuming session` / `Forking session`）已核实；Copilot、Pi、OMP、OpenCode 不登记。OpenCode 官方文档没有启动对话框，整条门不跑。

## 23. 权限补充：自己创建的终端与工作流关卡

补全架构 §8.2 的角色决定。判定只有一处：`core/identity/route-access.ts`（路由门），触发者的记法在 `core/identity/creators.ts`。不做节点级的「驱动者名单」。

### 23.1 角色阶梯

| 角色     | 画布 | 起 Agent | 驱动 / 审批自己起的 | 驱动 / 审批别人起的 | 工作流关卡 |
| -------- | ---- | -------- | ------------------- | ------------------- | ---------- |
| viewer   | 看   | 否       | —                   | 否                  | 否         |
| editor   | 改   | 否       | —                   | 否                  | 否         |
| operator | 改   | 是       | 是                  | 否                  | 是         |
| driver   | 改   | 是       | 是                  | 是                  | 是         |

「自己起的」= `terminal_sessions.creator_principal_id` 等于请求主体。下列路由对「自己的」要 `terminal:create@workspace`（operator），对「别人的」要括号里的那条（driver）：

| 路由                                               | 「自己的」按什么判                                       | 别人的要          |
| -------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| `/api/terminals/{id}/…` 的写（含 `…/ws`）          | 会话行                                                   | `terminal:drive`  |
| `POST /api/acp/sessions/{id}/prompt\|cancel\|mode` | 会话行                                                   | `terminal:drive`  |
| `POST /api/acp/nodes/{nodeId}/driver`              | 节点最近的会话行；还没起过时是节点记下的触发者           | `terminal:drive`  |
| `POST /api/approvals/{pendingId}/answer`           | 审批行的 `session_id` 那一行；旧行没有时按节点最近的会话 | `approval:answer` |
| `POST /api/control/confirm/{requestId}`            | 不判（只在内存里，查不到终端）                           | `approval:answer` |

### 23.2 创建者 = 触发者

| 终端怎么起来的                                                | 创建者                                              |
| ------------------------------------------------------------- | --------------------------------------------------- |
| 人从页面起（`POST /api/terminals`、`POST /api/acp/sessions`） | 本人；节点记过触发者时是那个触发者                  |
| 控制动词 `open-agent` / `open-terminal` / `team` 建的节点     | 调用方节点终端的创建者                              |
| ama 的 runner 建的节点                                        | 同上（经 `open-agent`）                             |
| 工作流的角色节点（`POST /api/workflows/runs`）                | 起跑的人                                            |
| 定时冷启动                                                    | 自动化的创建者；自动化只有 owner 能建，所以是 owner |
| 依赖编排、休眠接回、切换驱动、重启接回                        | 节点记下的触发者；接回同一行时沿用那一行的          |
| 桌面壳、没有请求主体                                          | owner（空串）                                       |

节点的触发者在建节点、存盘之前写进 `node_creators`（迁移 0035），只由 core 写，不在画布文档里。库里的触发器让任何一条起终端的路插入的会话行都继承它；没有记录的节点仍按 0028 的判法（起它的那个人）。`POST /api/acp/sessions` 答的是已经活着的会话、或原地接回的同一行时，创建者不被这次请求改写。

终端会话的 JSON（`GET /api/terminals/{id}`）多一个可选字段 `creatorPrincipalId`（空串是 owner）；页面据它决定对 operator 摆不摆「自己起的」审批按钮（`apps/web/src/app/use-access.ts::useCanAnswer`），判定仍在 core。

一处可接受的隐式提权：editor 能改节点里的启动命令（节点数据），operator 起这个节点时执行它——与「editor 改便签、Agent 读便签」同一信任层级。Agent 之间的驱动仍由连线编译（投递设计 §3.2），与人无关。

### 23.3 工作流

`/api/workflows/*` 路径里没有工作空间，服务器壳的路由门按对象查画布再判（§15）：

| 路由                                          | 画布从哪来               | 要                                |
| --------------------------------------------- | ------------------------ | --------------------------------- |
| `GET drafts?boardId=`、`GET runs?boardId=`    | 查询串的画板；不带是 403 | `canvas:read`                     |
| `GET drafts/{id}`、`GET runs/{id}`            | 草案 / 运行行            | `canvas:read`                     |
| `POST drafts/{id}/confirm\|discard`           | 草案行                   | `agent:launch`                    |
| `POST runs` `{ boardId }`                     | 请求体的画板             | `agent:launch`                    |
| `POST runs/{id}/cancel`                       | 运行行                   | `agent:launch`                    |
| `POST runs/{id}/gates/{stepId}`               | 运行行                   | `agent:launch`（operator）        |
| `GET templates`、`GET templates/{id}`         | 模板是本机共用的一份库   | 在任意一块画布上有 `agent:launch` |
| `POST templates`、`PUT/DELETE templates/{id}` | —                        | 只有 owner                        |

关卡答复是放行或拦下一次运行，与起跑同一档，不是替 Agent 代答，所以要 operator 而不是 `approval:answer`。声明在 `http/route-scopes.ts` 单列一行，常量 `core/workflow/routes.ts::GATE_SCOPE`。

## 24. Gateway 配对短码：`/api/gateway/pairing-code/*`

二维码与配对链接之外的第三条路：手机上手输 8 位配对码，换出与 `#pair=` 同一张票（§17.3），再照常 `POST /api/identity/pair`。实现在 `core/gateway/pairing-code.ts`。

### 24.1 签发：`POST /api/gateway/pairing` 多一个 `code`

§17.3 的回答多一个键：

```json
{ "…": "§17.3 的其余键", "code": "3F7K-9Q2M" }
```

- 字母表 `[A-Z2-9]`（34 个字符，没有 `0` / `1`），8 位，显示成 `XXXX-XXXX`。与票同生同灭：过期时刻就是票的 `expiresAt`（两分钟）；一次性；票先被扫码兑掉，配对码跟着作废；Gateway 关掉、重开或换档时全部作废。只在 core 内存里，不落库、不进日志与审计（审计 `gateway.pairing.issue` 只多一个布尔 `code`）。
- **档位**：配了对外来源（`publicOrigin`、ACME）一律不签；否则 `loopback` / `private` 档签，`all` 档只在绑定地址本身是回环或私网字面量时签（服务器壳绑在 `192.168.x.x` 上）。不签时 `code` 为 `null`。旧 core 不带这个键。

### 24.2 `POST /api/gateway/pairing-code/exchange`

请求体只认 `{ "code": string }`（大小写、连字符与空白都不算；不认识的键 400）。**匿名**：手机还没有身份，配对码就是凭据——路由门不判（`route-scopes.ts` 的 `SELF_GUARDED`），Gateway 准入把它当匿名面（`admission.ts::anonymousPath`，Cookie 模式与 Bearer 模式都是），Origin 那道照旧。回答与 §17.3 同形（没有 `code` 键）：

```json
{
  "origin": "https://192.168.1.20:8443",
  "ticket": "0123…ef.AbC…",
  "fingerprint": "5f1c…",
  "expiresAt": "2026-10-03T08:02:00.000Z",
  "webUrl": "https://192.168.1.20:8443/#pair=0123…ef.AbC…&fp=5f1c…",
  "deepLink": "armadra://pair?host=192.168.1.20%3A8443&ticket=0123…&fp=5f1c…"
}
```

| 状态 | `code`                  | 何时                                                                                                                    |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 400  | `bad_request`           | 请求体不是 `{ code: string }`                                                                                           |
| 403  | `pairing_code_disabled` | 这个 Gateway 不签配对码（24.1 的档位）                                                                                  |
| 404  | `pairing_code_invalid`  | 码不对、过期、用过，或票已被兑掉——一律同一个答案                                                                        |
| 409  | `gateway_not_running`   | 没在运行                                                                                                                |
| 409  | `origin_mismatch`       | 码对了，但请求的 Origin（Bearer 模式是会话来源 `https://<Host>`）不是票绑定的来源；码**不作废**，换到配对卡上的地址再输 |
| 429  | `rate_limited`          | 试错太多；带 `Retry-After`（秒）                                                                                        |

- **限流**：按来源地址的令牌桶（与登录同一种，`identity/throttle.ts::IpBuckets`，每分钟 20 次），另有一只全局桶（每分钟 200 次）挡分散来源的撒网；只有 404 才扣，桶空时连对的码也不看。来源地址是 socket 对端，不读 `X-Forwarded-For`。
- 兑换成功与失败进审计：`gateway.pairing.code.exchange`（`origin`、`remoteIp`）、`gateway.pairing.code.reject`（`remoteIp`）；码与票都不记。
- **页面**：设置页配对卡在倒计时旁显示配对码（过期即收起）。手机浏览器经 Gateway 打开、窄屏、没带 `#pair=` 也没有会话时，连接页先给 8 位 `InputOTP`（两组四位），输满自动兑换并配对；页上另有「账号登录」直接进页面。原生 App 只在已经记下（并钉过信任锚）一个 Gateway 来源时给「输入配对码」入口——App 不装 CA，没钉过的 Gateway 连不上；换出的 `fingerprint` 照样再钉一次，锚变了就失败，不自动信任新证书。

## 25. 口令重置链接：`/api/identity/…/password-reset`

设计见 [G5 剩余事项计划](../design/g5-remaining-plan.md) §0。邮箱是可选的，所以没有「输入邮箱自助重置」。做法是 owner（或组 admin 对本组成员）替某人签发一枚一次性、24 小时有效的令牌，链接 `<来源>/#reset=<令牌>` 由签发人亲手交给对方。代码在 `core/identity/password-reset.ts`（令牌原语），判定与事务在 `accounts.ts`，路由在 `accounts-http.ts`，表 `identity_password_resets`（迁移 `0036_password_resets.sql`），共享层 `identity-security.ts` 的 §25 小节。与 §10 / §18 同一个前缀、同一套认证；整段 `/api/identity/` 不经路由门，判定在身份域里。

| 方法与路径                                       | 谁能调                                                                                                       | 答案                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `POST principals/{id}/password-reset` `{}`（写） | owner 与 `identity:manage` 对任何成员；组 `admin` 只对自己所管的组里角色是 `member` 的人；owner 只有自己能签 | 201 `{ token, expiresAtMs }`：明文只在这一次出现；同一个人手里还没用的旧令牌随之作废                                       |
| `GET password-reset/{token}`                     | 匿名                                                                                                         | `{ displayName, expiresAtMs }`                                                                                             |
| `POST password-reset/{token}` `{ password }`     | 匿名                                                                                                         | `{ principalId, revokedSessions }`（泄露检查 `warn` 命中时多 `passwordBreached: true`）；之后拿 `principalId` 与新口令登录 |

- **令牌**与邀请同形（`<32 位十六进制>.<43 位 base64url>`）。库里只存 `sha256("armadra/identity/v1/reset\0<令牌>")`，用途 `reset` 与会话、配对票的哈希分开。
- **签发**：目标不存在 404；停用了的人与服务账号 400 `INVALID_ARGUMENT`；没有权限 403 `PERMISSION_DENIED`；没登录 401。审计 `identity.password.reset.issue`（`target` 是那个人，`detail.expiresAtMs`）。
- **打开与使用**：认不出的令牌（不存在、用过、作废、过期、那个人停用了）一律 404 `password_reset_invalid`，不分是哪一种。两条都走配对与刷新那只「失败才扣」的 IP 桶（§18.1）：桶空了 429 `rate_limited` 带 `Retry-After`，认不出的令牌扣一次，好令牌不扣。
- **设新口令**先过口令策略与泄露检查（§18.1，`names` 是那个人的显示名与 principalId）。不合格答规则名（400），令牌不作废。过了之后同一笔事务里令牌作废、换口令凭据、撤掉这个人的**全部**会话（`revokedSessions` 是撤掉的数目），并清掉这个人的登录锁定。审计 `identity.password.reset.use`，`target` 是那个人，`detail` 是 `{ credentialId, issuedBy, revokedSessions }`。
- 令牌明文与哈希都不进审计、日志与其它答案。MFA 不受影响：设了 TOTP 的人用新口令登录仍要第二因素（丢了手机走 §18.3 的 `mfa/reset`）。

## 26. ACP 补充：elicitation、模型、凭据、SSH

补 §14 的五件事。代码在 `core/acp/{client,host,session,elicitation,models,adapters,index,routes}.ts` 与 `agent/approvals.ts`，共享层 `api/acp.ts`。

**客户端能力**：协议栈仍是 `@armadra/agent/acp` 的 `AcpClient`。elicitation 与模型要它自报 `AcpClient.features.elicitation` / `features.configOptions`（构造参数 `onElicitation(params, signal)`、方法 `setConfigOption(sessionId, configId, value)`，并在 `initialize` 声明 `clientCapabilities.elicitation`）。core 按 `features` 判断：没有时线路与 §14 逐字节相同——不声明能力、Agent 发来的 `elicitation/create` 由客户端答 method not found，`models` 恒为 `null`。0.6.7 两样都没有，0.6.8 起两样都有。

### 26.1 elicitation

- Agent 发 `elicitation/create { sessionId?, message, mode?, requestedSchema?, url? }` → 一条审批，`pendingId` 与 §14.4 同形，`request_json` 为 `{ "protocol": "acp", "elicitation": { "message", "mode": "form" | "url", "requestedSchema"?, "url"? } }`；`agent.approval` 的 `request.request.elicitation` 就是它。节点状态 `waiting`、带 `pendingId`（不置 `awaitingInput`：答复或取消一定回来）。`GET …/log` 的 `elicitations` 列挂起的，形状 `{ pendingId, protocol: "acp", elicitation }`。
- `requestedSchema` 只收规范允许的扁平字段：`string`（可带 `enum` / `enumNames` / `format` / `minLength` / `maxLength` / `default`）、`number` / `integer`（`minimum` / `maximum` / `default`）、`boolean`（`default`），`required` 只留表单里有的名字。认不出的字段（嵌套对象、数组）或超过 64 个字段时不存 `requestedSchema`，这条只能拒绝或取消。`message` 截到 4000 字符。
- 答复：`POST /api/approvals/{pendingId}/answer { elicitation: { action: "accept" | "decline" | "cancel", content? }, decision? }`。`content` 只随 `accept`，必须是表单里有的字段、类型与约束都对、`required` 都在；URL 模式的 `accept` 不带内容。`decision` 可省，由 action 推出（`accept` → `allow`，`decline` / `cancel` → `deny`），给了且对不上答 `400`。节点头的 `{ decision }` 也能答：`deny` = `decline`，`allow` = 空表单的 `accept`（有必填项时 `400`）。不合规的答复 `400 bad_request`，审计记 `elicitation_invalid`；`optionId` 不适用（`400`）。应答与解决事件多 `elicitation: { action }`。
- `content` 只交给 Agent：不进审批行、审计、日志、事件与答复。审批行 `answer` 记 `allow` / `deny`，CAS 与 §14.4 相同。
- 回合被取消、适配器退出、休眠：挂起的 elicitation 一律回 `{ action: "cancel" }`，审批行记 `cancelled` / `core`（与 §14.4 同一条路）。节点在 `waiting` 时切换驱动答 `409 awaiting_approval`。core 从不替人填表。

### 26.2 模型

- 目录来自开会话（`session/new|load|resume`）答的 `configOptions`，没有时看 `initialize` 答的；取 `category: "model"` 的那一项（没有分类时 id 为 `model` 的那一项），可选值的分组摊平，最多 500 个。之后 Agent 的 `config_option_update` 更新它。
- `PUT /api/acp/sessions/{id}/model { modelId }` → `session/set_config_option { sessionId, configId, value }` → `204`；以答复里的 `configOptions` 为准。目录里没有这个模型或没有目录答 `409 acp_model_unavailable`，客户端没有这个能力答 `409 acp_model_unsupported`，`modelId` 缺席 `400`。会话行已结束时与 `…/mode` 一样先接回。节点数据 `agent.model` 由页面写回。
- 起会话（含接回、唤醒、切换驱动）时节点数据记着 `agent.model` 且目录里有就落上；目录里没有、或 Agent 拒了不拦启动（模型不是安全边界，与只读模式不同）。

### 26.3 `pi-acp` 的映射文件

- 适配器表 `sessionId: "mapFile"` 的那一行（`pi`）写死映射文件 `~/.pi/acp/sessions.json`，形状 `{ "<ACP 会话 id>": { "sessionFile": "<Pi 会话文件绝对路径>" } }`（值也可以直接是路径）。会话文件名里的 uuid 是 Pi 的会话 id。读不到、过大（> 4 MiB）、不是这个形状、或路径不是绝对路径时退回 `opaque`。
- 会话开好时 `transcriptPath` 是映射到的 Pi 会话文件（存在时），否则是镜像。
- 接回 ACP：手里的 id 是映射里的 ACP 会话 id 就用它，是 Pi 的会话 id 或会话文件就反查成 ACP 会话 id，查不到原样交给 `session/load`（接不回就新开）。切回终端：ACP 会话 id 映射回 Pi 的会话 id（文件名认不出时用文件路径）敲恢复行；映射里没有就敲普通启动行，`resumed: false`。

### 26.4 节点凭据与 ama 模型密钥

- ACP 适配器不经画布启动器，兑换由 core 在起适配器之前做：节点环境里有 `ARMADRA_CREDENTIAL_REF`（§20.3 的校验与 `credential:use` 已在这一步之前做过，成员答 `403 credential_forbidden`）时按 §20.4 同一个兑换（同一绑定、重新校验、更新 `lastUsedAt`、日志只记节点与条目名）取值；节点的基础 CLI 是 ama 时取 §12.4 的已设模型密钥（`AMA_API_KEY_<供应商>`）。
- 值只设进适配器进程的环境：不进节点数据、镜像、日志、会话行或任何答复。兑换失败与启动器一样拒绝起会话，原样答 §20 的码（`credential_unset` 409、`credential_unavailable` 503、`credential_mismatch` / `credential_kind_disabled` 400 等），不悄悄用默认登录起；ama 密钥读不出时答 `503 secret_unavailable`。
- 只开本机：SSH 节点上的 ACP（§26 的 SSH 小节）仍按 §20 拒绝凭据。

### 26.5 SSH 节点

节点数据带 `ssh.hostId` 时，ACP 适配器起在那台执行主机上。代码在 `core/acp/ssh.ts`，Worker 侧在 `core/remote/{operations,node-probe}.ts`。

- **传输**：本机起一条不带 TTY 的 `ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 <askpass 与主机密钥选项> [-p] [-i] [extraArgs] -- <user@host> <远端命令>`。主机、密钥、askpass、主机密钥文件与 `ARMADRA_REMOTE_WORKER_LAUNCHER` 都和 Worker 用的是同一套。这条 `ssh` 的 stdin / stdout 就是 ACP 的 JSON-RPC。远端命令是 `env <K='v'…> /bin/sh -c 'cd "$0" || exit 1; exec "$@"' '<cwd>' '<程序>' '<参数>'…`。每个词都放在单引号里；值里有 `'`、`\`、`!` 或控制字符时，拒绝起会话（`502 acp_spawn_failed`），不去猜远端是哪种 shell。`cwd` 取节点数据的 `cwd`，没有就用工作空间根；远端进不去这个目录就退出（`acp_exited`），不会在家目录里悄悄起。本机的 `ssh` 子进程从数据目录起。
- **装没装**：起会话前问那台主机的 Worker：`agents.probe { programs: string[] }` → `{ platform, programs: { <程序>: <路径> | null } }`。只读，可以重放，能力位复用 `remote.integration.v1`。程序是裸名时按 Worker 自己的 `PATH` 找，是绝对路径（`custom:` 条目）时看它能不能执行；别的写法一律答 `null`；一次最多问 32 个。找不到答 `400 acp_not_installed`。
- **`acp_unsupported` 只剩这几种**（400）：主机没登记、主机没配 Worker、Worker 对 `agents.probe` 答 501（版本过旧）、执行主机不是 POSIX。Worker 连不上答 `502 acp_spawn_failed`。
- **画布工具**：适配器表 `injection.mcp` 为真时，`session/new|load|resume` 的 `mcpServers` 带执行主机上的 Hook 客户端：命令 `<注入根>/bin/armadra-hook`，参数 `["mcp"]`，环境是节点身份、会话代次、执行主机上的 `ARMADRA_ENDPOINT_FILE` 与 `ARMADRA_HOOK_TIMEOUT_MS`。它和远端画布注入走同一条 Worker 中继 socket（契约 §21、远端画布注入设计），准备步骤也相同：同步产物、写节点令牌、开中继。准备失败就不带这条服务器，会话照常可用。终端启动器的注入 argv / env、ama 的 profile 在远端都不带。
- **凭据**：远端不兑换（§20）。节点凭据与 ama 模型密钥都不设，条目名不随画布工具过去，远端命令行里也不带任何值。远端适配器只多 `custom:` 条目的 `env`。
- **转录**：CLI 的转录在执行主机上，`transcriptPath` 一律指向本机镜像。
- **驱动切换、休眠、接回**：和本机一样都在同一行上起下一代（§14.2）。切回终端时，下一代经 `ssh` 起在同一台主机上（`ReviveOptions.sshHostId`），敲的是只带程序名的启动行（POSIX 方言）；ACP 侧的接回、Eco 休眠的唤醒、依赖编排与定时冷启动，都按节点数据重新走一遍上面的传输。

## 27. 推送补充：设备偏好、UnifiedPush、调度与资源事件

补 §19：每台设备收哪些种类、没有 Google 服务的 Android 走用户自己的 UnifiedPush 分发器，以及两族一直被推送监听、却没有人发的事件。表 `push_devices` 多两列（迁移 `0037_push_preferences.sql`）：`kinds_json`（空串 = 全部）与 `unifiedpush_endpoint`（空串 = 没有）。代码在 `core/push/`（`transport-unifiedpush.ts`）、`core/schedule/engine.ts`、`core/resources/thresholds.ts`，共享层 `api/push.ts`。

### 27.1 设备偏好：`PATCH /api/push/devices/{deviceId}`

```json
{ "kinds": ["approval", "schedule"] }
```

- `kinds` 是这台设备**要收**的种类，取自 `approval`、`agentDone`、`agentError`、`deliveryFailed`、`schedule`、`resources`、`comment`、`workflowGate`（共享层 `PUSH_PREFERENCE_KINDS`）；去重、按这个顺序存。`test` 不在其中：测试通知恒收。空数组 = 只收测试。选满全部种类存成「全部」，以后新加的种类缺省也收。
- 只改请求主体自己名下、还有效的登记；owner 也不替别人改（别人的、已撤销的、不存在的同样答 404 `not_found`）。不认识的种类、不是数组答 400 `bad_request`。
- 答 200 `{ "device": <§19.3 的设备> }`。设备在接口上多两个键：`kinds`（要收的种类，没设过是全部）、`unifiedpush`（是否走 UnifiedPush；端点本身与令牌一样不出接口）。
- `PUT /api/push/devices` 的覆盖式登记**保留**偏好（App 每次启动都重新登记，那不是人改了主意）。
- 过滤在入队前：§19.6 的收件人里，设备不收这一种的不入队。

### 27.2 UnifiedPush

- Android 登记（§19.2）可多带 `"unifiedpush": { "endpoint": "<分发器给的端点>" }`，此时 `token` 可以不给（没有 FCM 令牌的手机）；必须带 `publicKey`。端点同 Web Push 的规矩：https，回环上的 http 只给测试，不带用户名口令与片段。`ios` / `web` 带它答 400。
- 有端点的设备一律走它，**不看** `push.transport`，也没有服务端配置项：`POST <endpoint>`，`Content-Type: application/json`，`TTL: 3600`，`Urgency`（审批 `high`），`Topic` = tag 的摘要，正文是 §19.5 的信封（对设备公钥封好；分发器只见密文），不跟随重定向。2xx 算收下；404 / 410 是端点已注销，设备登记撤销（`revoked_reason = 'gone'`）；429 与 5xx 按 §19.6 重试；413 等其余 4xx 不重试。
- 出站表把它登记为「用户配置的地址」（`core/net/outbound.ts` 的 `unifiedPush`）。dev-stack 的 `push-sink` 在 `/up/<topic>` 有替身（topic 以 `gone` 开头答 404、正文超 4096 字节答 413），`ntfy` profile 是真分发器（端点 `http://127.0.0.1:8093/<topic>?up=1`）。

### 27.3 调度事件

调度内核在**提交之后**发 `workspace.event`，只带标识与稳定码，不带命令、参数与输出：

- `schedule.fired { planId, runId, nodeId? }`：一个槽位物化成一次要投递的运行（按策略跳过的槽位不发）。
- `schedule.failed { planId, runId, nodeId?, reasonCode }`：一次运行没有跑成——执行方回报失败（`FAILED`），目标离线 / 不支持 / 换了代数而跳过（`TARGET_OFFLINE`、`TARGET_UNSUPPORTED`、`STALE_GENERATION`），或等到 TTL 都没等到目标（`WAITING_EXPIRED`）。并发上限、错过的槽位、暂停与改配置的取消是按设计不跑，不发。
- `schedule.attention { planId, nodeId?, reasonCode }`：计划的「需要处理」标记抬起的那一下（连续两次不可修复的拒绝），一次。
- `nodeId` 是目标节点（工作流目标没有）。推送把三者都算 `schedule` 种类，`tag` 都是 `schedule:<planId>`（新的替换旧的），正文分别是「定时任务到点了 / 没有跑成 / 需要处理」。

### 27.4 资源阈值事件

- `resources.threshold { sessionId, nodeId?, metric, value, threshold }`：一个会话的用量越过阈值的那一下发一次。`metric` 今天只有 `memory`（进程树 RSS 之和，字节），`threshold` 是设置 `resources.memoryWarnBytes`（缺省 2 GiB，夹在 128 MiB – 128 GiB；设置页「终端 → 内存阈值」同时写它与本机偏好）。
- 去重按 `sessionId:generation`：同一次运行里在线上抖动不重发，回落到阈值九成以下再越线才再发，换代是新的一次；测不出来（`null`）不算越线。
- 判定在 core：页面开着时随采样循环（`resource.sample`）判；没人看着、而库里有有效的推送设备时，core 每 30 秒自己采一轮。只是提醒，不终止、不休眠任何会话。推送 `tag` 是 `resources:<metric>:<nodeId 或 sessionId>`，正文不写数字。

## 28. 邮件通道：`/api/mail/*`

> 自协议 1.14 起这些路由同时是 `mail.*` procedure（§43.5），旧路径与 procedure 调同一份实现。

可选的 SMTP 通知通道：把邀请（§10）与口令重置（§25）链接发到一个邮箱。邀请与重置仍然设计成「管理员亲手把链接交给人」，邮件只是多一个出口。实现在 `core/mail/`。

### 28.1 配置

只有服务器壳配：`serve --smtp-url` / `ARMADRA_SMTP_URL`（`smtp(s)://用户:口令@主机:端口`）与 `--smtp-from` / `ARMADRA_SMTP_FROM`（缺省是用户名，不是邮箱地址时必须给）。口令位置可写 `secret://armadra-<名字>`，发信时从服务器壳的密钥后端现取（`armadra-server secrets set armadra-smtp` 经标准输入写入）。`smtp://` 走 STARTTLS，主机不是回环时强制升级（`?requireTLS=false` 放开）；`smtps://` 缺省端口 465、`smtp://` 缺省 587。地址写错，服务器壳拒绝启动。桌面壳没有设置键，永远是未配置。出站登记在 `core/net/outbound.ts` 的 `smtp`。

### 28.2 `GET /api/mail/status`

已登录即可（匿名 401 `unauthenticated`）：

```json
{ "configured": true, "from": "noreply@example.com" }
```

未配置时 `{ "configured": false, "from": null }`。不认识这条路由的旧 core 答 404，页面同样按未配置处理。

### 28.3 `POST /api/mail/invitation`、`POST /api/mail/password-reset`

```json
{ "invitationId": "<32 位十六进制>", "token": "<签发时拿到的令牌>", "to": "someone@example.com", "locale": "zh" }
{ "principalId": "<32 位十六进制>", "token": "<签发时拿到的令牌>", "to": "someone@example.com", "locale": "en" }
```

- **令牌由调用方交回**：库里只有哈希，链接只能由刚签出它的那个页面连同 id 一起交过来。core 核对令牌属于这张邀请 / 这个人、没用过、没过期，再按链接自己的规则判调用方：邀请与签发、作废同一套（工作空间邀请要 `workspace:share`，组邀请要能管那个组，两者都无要 `identity:manage`）；重置与签发同一套（§25），先判调用方（403 / 404）再认令牌，令牌认不出、用过、作废、过期或不是这个人的，一律 409 `link_invalid`。
- 正文只有链接与过期时间（UTC），链接是 Gateway 对外来源加 `#invite=<令牌>` / `#reset=<令牌>`；纯文本，没有签发人、角色或工作空间名。主题与正文按 `locale`（`zh` / `en`）选，没给时按 `Accept-Language`，都认不出用英文。
- 每个来源地址每分钟至多 5 封（socket 对端，不读 `X-Forwarded-For`），核对通过之后才计数，发送失败也计。
- 审计 `mail.invitation.send` / `mail.password-reset.send`：`target` 是邀请 id / 被重置的人，`detail` 只有 `{ toHash, delivered }`；`toHash` 是 `sha256("armadra/mail/v1\0" + 小写地址)` 的前 32 位十六进制。地址与令牌不进审计与日志。
- 成功答 `200 { "sent": true }`（SMTP 服务器已收下）。

| 状态 | `code`                | 何时                                                                        |
| ---- | --------------------- | --------------------------------------------------------------------------- |
| 400  | `bad_request`         | 请求体不对：id 或令牌形状不对、邀请令牌的前缀不是这个 id、`to` 不是邮箱地址 |
| 401  | `unauthenticated`     | 匿名                                                                        |
| 403  | `forbidden`           | 不能签发这条链接的人                                                        |
| 404  | `not_found`           | 没有这张邀请 / 这个人                                                       |
| 409  | `mail_not_configured` | 没配 SMTP                                                                   |
| 409  | `link_invalid`        | 令牌不对、已用过（含作废）或已过期                                          |
| 429  | `rate_limited`        | 这个来源这一分钟已发 5 封；带 `Retry-After`（秒）                           |
| 502  | `mail_send_failed`    | SMTP 没收下（连不上、认证失败、拒收），不带服务器原话                       |

写方法照常经 Gateway 准入：Cookie 会话要 `X-Armadra-CSRF`。

## 29. 托管平台（forge）：`/api/forge/*`

把 §5 的 GitHub 面推广到自托管平台：Gitea / Forgejo（两者同一套 `/api/v1`，记作 `gitea`）与 GitLab（§29.6）。实现在 `core/forge/`（`Forge` 接口 + `github.ts` / `gitea.ts` / `gitlab.ts`），页面一侧的 zod 在共享层 `api/forge.ts`。自协议 1.11 起每条路由也是 `forge.*` procedure（§41.2，旧路径保留）。`/api/github/*`（§5）不变；GitHub 远端在这一面经同一个客户端、同一份凭据。

权限与 §5 同一档：读 `github:read`，写 `github:write`（`http/route-scopes.ts`）；`POST /api/forge/resolve` 只是读，登记时声明 `github:read`。写方法照常经 Gateway 准入：Cookie 会话要 `X-Armadra-CSRF`。错误一律 `{ code, message }`，`message` 是固定文案，远端原话（含错误消息里的 HTML）不往外传。

### 29.1 识别

仓库由 git 远端地址的主机名（小写、不含端口）与最后两段 `owner/name` 定（GitLab 多级子组的 owner 可以更长，见 §29.6）。按序：

1. `github.com`、`www.github.com`、`ssh.github.com` → `github`；GitHub 凭据（§5）配的企业版根的主机 → `github`。这两条不查配置表，GitHub 主机不能在 §29.3 另配。
2. 配置表里写到这个仓库的一行 `<host>/<owner>/<name>`。
3. 配置表里只写主机的一行 `<host>`。
4. 都没有：`forge: null`，页面不显示「托管」区。

配置在迁移 `0038_forge.sql` 的 `forge_config(repo_key, forge, api_base, credential_ref, account_login, revision, …)`；同一迁移给 `github_references` 加了 `forge` 列（缺省 `github`）。

### 29.2 `GET /api/forge/repos/{host}/{owner}/{name}`、`POST /api/forge/resolve`

`resolve` 的请求体 `{ "remoteUrl": "<git 远端地址>" }`（https / http / ssh / git 与 scp 写法；地址可能带凭据，所以不放查询串，答复里也没有它）。两者答同一个形状：

```json
{
  "repository": { "host": "git.example.com", "owner": "acme", "name": "app" },
  "forge": "gitea",
  "source": "config",
  "configKey": "git.example.com",
  "apiBase": "https://git.example.com/api/v1",
  "webUrl": "https://git.example.com/acme/app",
  "credential": true,
  "accountLogin": "bot"
}
```

`forge` 是 `github` | `gitea` | `gitlab` | `null`；`source` 是 `github` | `config` | `null`；`credential` 只看存着没有、不花远端配额（GitHub 远端：§5 配了凭据且凭据的根就是这个远端的根）。不认识的仓库其余字段都是 `null`、`credential: false`。

### 29.3 配置：`/api/forge/configs*`

| 方法与路径                                     | 答复                                |
| ---------------------------------------------- | ----------------------------------- |
| `GET /api/forge/configs`                       | `{ configs: [配置行…] }`，按键排序  |
| `PUT /api/forge/configs/{host}`                | 配置行（整台主机）                  |
| `PUT /api/forge/configs/{host}/{owner}/{name}` | 配置行（这个仓库，优先于主机那行）  |
| `DELETE …同上…?expectedRevision=<n>`           | `{ removed: true }`；令牌条目一起删 |

`PUT` 请求体 `{ forge: "gitea" | "gitlab", apiBase, token?, expectedRevision? }`（`gitlab` 的差异见 §29.6）：

- `apiBase` 给站点根或 `…/api/v1` 都行，存成 `…/api/v1`。只收 HTTPS；回环主机（`localhost`、`127.0.0.1`、`[::1]`）也收明文 HTTP。不收带凭据、查询或片段的地址。
- `token` 不给 = 保留已存的令牌，但 `apiBase` 变了就丢掉它（旧令牌不能发到新地址）；`""` = 删掉令牌；非空 = 先用它调一次 `GET /user` 核验，远端认了才存，`accountLogin` 是它答的登录名。
- 令牌只进 SecretStore，条目名 `armadra-forge-<16 位十六进制>`，库里只有条目名；令牌不进响应、审计与日志。
- `expectedRevision` 是 CAS：新建是 0（缺省），否则必须等于读到的 `revision`。

配置行：`{ repoKey, forge, apiBase, credential, accountLogin, revision, createdAtMs, updatedAtMs }`（`credential` 是布尔，没有令牌时 `accountLogin` 为 `null`）。

### 29.4 issue 与 PR：`/api/forge/repos/{host}/{owner}/{name}/…`

| 方法与路径                         | 请求                                                               | 答复                                                                  |
| ---------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `GET issues`                       | 查询 `state=open\|closed\|all`（缺省 open）、`cursor`、`limit≤100` | `{ items: [issue…], nextCursor }`，列表里 `body` 为空                 |
| `GET issues/{number}`              |                                                                    | issue                                                                 |
| `PATCH issues/{number}`            | `{ state: "open" \| "closed" }`                                    | issue                                                                 |
| `GET pulls`                        | 同 issues（`closed` 含已合并）                                     | `{ items: [pull…], nextCursor }`                                      |
| `POST pulls`                       | `{ title, body?, head, base, draft? }`                             | `201` pull                                                            |
| `GET pulls/{number}`               |                                                                    | pull                                                                  |
| `GET pulls/{number}/files`         |                                                                    | `{ files: [file…] }`（至多 300 个）                                   |
| `GET pulls/{number}/checks`        |                                                                    | checks                                                                |
| `POST pulls/{number}/merge`        | `{ method?: "merge"\|"squash"\|"rebase", headSha }`                | `{ merged: true, sha }`                                               |
| `GET merge-options`                |                                                                    | `{ methods: ("merge"\|"squash"\|"rebase")[], autoMerge, mergeTrain }` |
| `POST pulls/{number}/auto-merge`   | `{ method?, headSha }`                                             | `{ merged, sha, train }`                                              |
| `DELETE pulls/{number}/auto-merge` |                                                                    | `{ cancelled: true }`                                                 |
| `DELETE pulls/{number}/branch`     | 查询 `headSha`（必填）                                             | `{ deleted, reasonCode }`                                             |

- issue：`{ number, title, body, state: "open"|"closed", author, labels: string[], commentCount, url, createdAtMs, updatedAtMs, closedAtMs }`。同一编号空间里的 PR 不算 issue（读、改都答 404）。
- pull：`{ number, title, body, state: "open"|"closed"|"merged", draft, author, baseRef, headRef, headSha, mergeable: "mergeable"|"conflicting"|"unknown", url, createdAtMs, updatedAtMs, mergedAtMs, autoMerge }`。`autoMerge` 是「已排进流水线通过后合并」（§29.6），GitHub 与 Gitea 恒为 `false`。`fromFork`：head 分支在别的仓库里（GitHub 照 §5；Gitea 看 `head.repo_id` 与 `base.repo_id`；GitLab 看 `source_project_id` 与 `target_project_id`；缺字段按同仓库）。
- file：`{ path, previousPath, status: "added"|"modified"|"removed"|"renamed"|"other", additions, deletions, patch }`；`patch` 从第一个 `@@` 起，二进制为 `null`。Gitea 的补丁从 `pulls/{n}.diff` 按文件切出来。
- checks：`{ headSha, rollup: "pending"|"success"|"failure"|"neutral"|"none", checks: [{ name, state, url }] }`。Gitea 用 commit statuses（同一个 context 只留最新的；`error` 记 failure，`warning` 记 neutral），GitHub 用 check runs + commit status（§5 同源）。`url` 只收 http(s)。
- `cursor` 是页码串（2–1000），从不是远端 URL。
- 合并：`headSha` 必须是完整对象名；远端 head 不是它就 409，不会合进评审者没看到的东西。Gitea 草稿按标题前缀 `WIP:` 认，`draft: true` 建 PR 时加这个前缀。
- 合并后删源分支（Gitea / GitLab；GitHub 仍走 §5 的 `delete-branch`，这里答 `400 bad_request`）：PR 已合并、不是 fork、分支还指着 `headSha`、没受保护（GitLab 的 `protected` / `default`，Gitea 的 `protected`；head 与 base 同名也不删）才发 `DELETE`；否则答 `200 { deleted: false, reasonCode }`，`reasonCode` 是 `NOT_MERGED` / `FORK_BRANCH` / `BRANCH_MOVED` / `BRANCH_PROTECTED` / `ALREADY_DELETED`（分支已不在，例如项目设了合并后删源分支）。分支名进路径：Gitea 逐段编码、斜杠留着，GitLab 整条编码。删了答 `{ deleted: true, reasonCode: "" }`。
- 写永远不重试；读在远端 5xx / 断连时重试一次。重定向一律当错误。

### 29.5 错误

| 状态 | `code`                      | 何时                                                                                        |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------- |
| 400  | `bad_request`               | 参数不对：主机 / owner / 名字、编号、状态、游标、分支名、SHA、地址、令牌形状、GitHub 主机   |
| 403  | `forge_forbidden`           | 远端说这个令牌没有这项权限（不是路由门的 `forbidden`）                                      |
| 403  | `forge_scope`               | 远端明说令牌缺范围（GitLab 的 `insufficient_scope` / `insufficient_granular_scope`，§29.6） |
| 404  | `not_found`                 | 没有这个仓库 / issue / PR / 配置行                                                          |
| 409  | `forge_not_configured`      | 没识别出平台，或识别出了却没有令牌；不发匿名请求                                            |
| 409  | `conflict`                  | `expectedRevision` 对不上；head 变了、已合并、不可合并                                      |
| 429  | `rate_limited`              | 远端限流                                                                                    |
| 502  | `forge_credential_rejected` | 远端不认令牌（远端 401；不答 401，免得页面以为自己的会话过期）                              |
| 502  | `forge_unavailable`         | 连不上、远端 5xx、答复坏了                                                                  |
| 504  | `unknown_outcome`           | 写已发出、结果没读到：重新读再决定，不要直接重试                                            |
| 409  | `rebase_started`            | GitLab 的 `rebase` 先发出了变基（§29.6）：没有合并，head 会变，读到新 head 核对后再合       |

出站登记在 `core/net/outbound.ts` 的 `forgeApi`（地址是用户配的，不配置即不联网）。

### 29.6 GitLab

GitLab（自托管与 gitlab.com 同一套 `/api/v4`）记作 `gitlab`，经 §29.3 按主机或仓库配置，路由与形状同 §29.4；与 Gitea 的差异：

- **地址与认证**：`apiBase` 给站点根或 `…/api/v4` 都行，存成 `…/api/v4`。令牌放在 `PRIVATE-TOKEN` 头里；读要 `read_api`，写要 `api`。配置时用它调一次 `GET /user`，`accountLogin` 是答复的 `username`。
- **寻址**：项目按 URL 编码的完整路径寻址（`owner%2Fname`；多级子组是 `group%2Fsub%2Fname`）。
- **多级子组**：`repository.owner` 可以是 `group/sub/…`（每段都是合格的名字，至多 20 段）；路由里整条 owner 编码成一段（`/api/forge/repos/{host}/group%2Fsub/{name}`），配置键是 `<host>/group/sub/<name>`（路径同样 `/api/forge/configs/{host}/group%2Fsub/{name}`）。`resolve` 认子组的顺序：配置表里写到这个仓库的 `gitlab` 行，从最长的 owner 往短里找；主机那一行是 `gitlab` 时，远端路径（http(s) 远端先去掉站点根的路径前缀，GitLab 装在子路径下的情形）除最后一段都是 owner；其余仍是最后两段。多段 owner 只认 GitLab：GitHub 主机与 Gitea 配置答 `forge: null`，给 Gitea 配多段的仓库键答 `400 bad_request`。外部连接（§5.2）起初不收多段 owner，G5-30 起收（见本节「外部连接」）。
- **merge request ↔ pull request**：`number` 是 MR 的 `iid`；`opened` / `locked` → `open`，`closed` → `closed`，`merged` → `merged`；`source_branch` / `target_branch` → `headRef` / `baseRef`，`sha` → `headSha`；`draft` 看 `draft`（旧版本 `work_in_progress`），`draft: true` 建 MR 时加标题前缀 `Draft: `。`mergeable`：`has_conflicts`、`detailed_merge_status` 为 `conflict` / `broken_status`、或 `merge_status` 为 `cannot_be_merged` → `conflicting`；`detailed_merge_status` 为 `mergeable`（老版本只有 `merge_status: can_be_merged`）→ `mergeable`；其余（流水线、审批、检查中）→ `unknown`。
- **issue**：编号是 issue 的 `iid`，与 MR 是两套编号；`description` → `body`，`user_notes_count` → `commentCount`；开关用 `state_event: close | reopen`。
- **列表的 `closed`**：GitLab 的 MR `state=closed` 不含已合并，core 按 `all` 取再滤掉开着的，所以一页可能不满；`nextCursor` 仍是远端的下一页。
- **文件**：来自 `merge_requests/{iid}/diffs`（GitLab 15.7 起），按页取到 300 个；`additions` / `deletions` 从补丁里数；没有 `@@` 的（二进制、过大被折叠、纯改名）`patch` 为 `null`。
- **检查**：MR 的 `head_pipeline` 跑在当前 head 上时，排在最前加一条 `pipeline #<id>`（整条流水线的结论与链接；旧 head 的流水线不算）；其余是 commit statuses（流水线作业也在这里），同名只留 id 最大的；`success` → success，`failed` → failure（`allow_failure` 的 → neutral），`canceled` → failure，`skipped` / `manual` → neutral，其余 → pending。
- **合并**：`PUT …/merge` 带 `sha: headSha`（远端 head 变了答 409 → `conflict`），`method: "squash"` 对应 `squash: true`。
- **合并方式**：`GET merge-options` 读项目的 `merge_method` / `squash_option`：`merge`（合并提交）→ `merge`；`rebase_merge`（半线性）→ `merge`、`rebase`；`ff`（只快进）→ `rebase`；再按 `squash_option` 加上 `squash`（`never` 不加，`always` 只剩 `squash`）。Gitea 与 GitHub 不细分，三种都给、不发请求。`method: "rebase"` 只在项目有这一种时收（否则 `bad_request`）：MR 的 `detailed_merge_status` 是 `need_rebase` 时先发 `PUT …/rebase`（异步）并答 `409 rebase_started`——变基会换 head，评审者读到新 head 核对后再合；不落后就照常 `PUT …/merge`（不带 `squash`），由项目设置快进或带合并提交。远端 405 / 422（草稿、流水线未过、冲突）→ `conflict`。答复里的 MR 还没到 `merged`（排进了合并队列）时答 `unknown_outcome`：重新读再决定。
- **流水线通过后合并**：`merge-options` 的 `autoMerge` 恒为 `true`，`mergeTrain` 是项目的 `merge_trains_enabled`（Premium）。`POST pulls/{number}/auto-merge` 与合并一样先核 head、方式必须在 `methods` 里、不重试：没开合并列车时 `PUT …/merge` 带 `merge_when_pipeline_succeeds: true` 与 `auto_merge: true`（17.11 起的新名，老版本忽略它），答复的 MR 已 `merged` 就答 `{ merged: true, sha, train: false }`（流水线已过、当场合并），`merge_when_pipeline_succeeds` 为真答 `{ merged: false, sha: null, train: false }`，两样都不是答 `unknown_outcome`；开了合并列车时改为 `POST /merge_trains/merge_requests/{iid}`（`sha`、`squash`、`auto_merge: true`；201 已上车、202 等流水线过了再上），答 `{ merged: false, sha: null, train: true }`。`DELETE pulls/{number}/auto-merge` 只对 `autoMerge` 为真的 MR 发 `POST …/cancel_merge_when_pipeline_succeeds`，否则 `409 conflict`。Gitea 与 GitHub 的 `autoMerge` / `mergeTrain` 为 `false`，这两条路由答 `400 bad_request`。
- **范围不足**：403 的答复里 `error` 是 `insufficient_scope`（经典令牌）或 `insufficient_granular_scope`（细粒度令牌）时答 `403 forge_scope`；别的 403 仍是 `forge_forbidden`。远端的说明文字不往外传。
- **外部连接**：`GithubExternalReference.forge` 为 `gitea` / `gitlab` 时（§5.2），仓库必须正是这台机器对它识别出的那个平台，`apiBase` 取自配置（请求里给了别的根就拒绝）；GitHub 的 issue / PR 详情只列 `forge: github` 的连接。
- **外部连接的多级子组**（G5-30 追加）：`forge: gitlab` 的连接收多段 owner；`repository.owner` 存完整的命名空间路径（`group/sub`），`name` 是最后一段，现有列照存，没有新迁移；连接标识的材料里仓库仍是 `owner/name`（`name` 不含 `/`，不会与两段的仓库撞）。`forge: gitea` 与 GitHub 的连接仍拒绝多段 owner（`invalid`）。
- **fork 的 PR / MR 检出**（G5-30 追加）：仓库操作 `createWorktree`（`POST /api/workspaces/{id}/git/repository/operations`）可带 `pullHead: { remote, forge: "gitea" | "gitlab", number, headOid }`，只能与 `createBranch: true`、`startPoint: null` 同用。core 在操作执行时（不是排队时）从 `remote` fetch 平台发布的引用——GitLab `refs/merge-requests/<iid>/head`，Gitea / Forgejo `refs/pull/<n>/head`，引用由 core 按 `forge` 与 `number` 拼、不收调用方给的 refspec——到临时引用 `refs/armadra/checkout/<操作 id>`，用完即删；取到的提交与 `headOid` 不符时操作 `failed`（「head moved since it was reviewed」），不建分支也不留检出。GitHub 的检出不带这一项，行为不变。

## 30. 页面错误上报：`/api/diagnostics/client-error`

> 自协议 1.14 起这两条路由同时是 `diagnostics.*` procedure（§43.8），旧路径与 procedure 调同一份实现。

可选崩溃上报（外部服务 §11.2）的页面一侧：页面自己的 JS 错误（`window` 的 `error` 与 `unhandledrejection`）经同一个 DSN 发出。实现在 `core/diagnostics/{client-report,routes}.ts`、`main/diagnostics.ts`、`apps/web/src/diagnostics/`。

### 30.1 开关

设置键 `diagnostics.reportPageErrors`（布尔，缺省 `false`）。**收**的条件是它为真、且壳的崩溃上报此刻在发：服务器壳按自己的 `active()` 答（DSN 可能来自 `ARMADRA_CRASH_REPORT_DSN`），桌面壳的 core 按设置里的 `diagnostics.crashReportDsn` 合不合格答。页面在通用页诊断区、DSN 已保存时多一个「包含页面错误」开关。

### 30.2 `GET /api/diagnostics/client-error`

```json
{ "enabled": false }
```

页面据此决定收不收，答案缓存一分钟；设置页改了开关时丢掉缓存。关着的时候页面一条错误也不留。

### 30.3 `POST /api/diagnostics/client-error`

请求体只认四个键（不认识的键 400）：

```json
{
  "kind": "error",
  "name": "TypeError",
  "message": "Cannot read properties of undefined (reading 'x')",
  "stack": "TypeError: …\n    at render (index-abc123.js:12:34)"
}
```

- `kind`：`error` | `rejection`。`name` ≤ 128、`message` ≤ 2000、`stack` ≤ 8000 字符，超了 400（不截）。被 reject 的不是 `Error` 的值只发 `{ name: "NonError", message: "non-error <类型>" }`，不发内容。
- 回答：收下 `202 { "accepted": true }`；关着 `200 { "accepted": false }`（不看请求体）。

| 状态 | `code`            | 何时                                                                          |
| ---- | ----------------- | ----------------------------------------------------------------------------- |
| 400  | `bad_request`     | 请求体不是 JSON、多了键、类型或长度不对                                       |
| 401  | `unauthenticated` | 服务器壳的匿名主体（没有会话）                                                |
| 429  | `rate_limited`    | 这台设备每分钟超过 5 条，或整台 core 每分钟超过 60 条；带 `Retry-After`（秒） |

- **身份**：登录即可，路由门不判（`route-scopes.ts` 的 `SELF_GUARDED`）；桌面壳的本机请求算本机 owner。限流按设备（没有设备按 principal），形状不对的请求不扣桶。
- **剥离**：两道。页面先剥（`crash-scrub.ts`：路径里的用户名、令牌形状、Armadra 会话密钥 `<32 位十六进制>.<43 位 base64url>`、地址里的账号 / 查询串 / 片段，栈帧里的地址与路径只留文件名，消息截到 300 字）；收件一侧（core 或桌面主进程）按本机的家目录与环境变量再剥一遍同一套规则，再交 `platform.reportError`（来源 `page`）。事件发出前壳的 `beforeSend` 还有第三道（§11.2 的整段删键）。终端输出、文件正文、凭据、请求数据不进事件；core 不记这条错误的正文。
- **桌面壳**：页面不走这个路由，经 IPC `diagnostics:report`（`window` 档）交给主进程；主进程读同一份设置再判、同样每分钟 5 条、再剥离，交 `@sentry/electron`，标签 `process: renderer`、`source: page`。`ipcMode` 仍为 0：SDK 不给渲染进程开任何通道，浏览器节点的 guest 没有 preload，也就没有这条路。IPC 答 `{ accepted }`，从不拒绝。

## 31. 云登录与登记：`/api/identity/cloud/*`

> 状态：实施契约（A2-3，迁移 `0040_cloud_identity`，实现 `core/identity/cloud/`；规格见平台实现规格 core 包 §2（docs/design/platform/core-packages.md））。下面的形状表由 `tools/contract/generate.mjs` 从 `packages/shared/src/contract/cloud.ts` 生成；出入参就是协议包 `@armadra/platform-protocol/core-api` 的 schema 对象（`cloudLoginInputSchema`、`cloudLoginOutputSchema`、`cloudRegisterInputSchema`、`cloudRegisterOutputSchema`、`cloudStatusOutputSchema`、`tunnelStatusSchema` 等），cloud 仓与这里同一份。远程服务一侧的接口见 [cloud-api.md](https://github.com/Owlbay/armadra-cloud/blob/main/docs/contracts/cloud-api.md) §4、§10，这里不另抄。

范围：本机 core 登记到远程服务（目前只有个人中转；SaaS 只留形状），并用远程服务签发的源访问断言换本机会话。每条都有 procedure（`POST /api/rpc/identity/cloud/<动词>`，§34.1）与下表「原路径」那条旧路径，两者是同一份实现；`identity.cloud.login` 是匿名面，只经旧路径，RPC 上答 501 `not_implemented`。整段 `/api/identity/cloud` 由身份域自己认会话（与 `/api/identity/*` 同一档），权限按下表的 scope 判：登记、撤销、可信来源要 `settings:write`，读状态要 `settings:read`（服务器壳上的成员都没有，一律 403 且不触发外呼），绑定只要登录（`identity:read`）。

### 31.1 形状

<!-- rpc:begin contract=§31.1 -->

| procedure                       | kind     | input                                                           | output                                                                                                                                                                                                                                                                                                                                    | errors                                                                                                                                                                                                                                                                                                                                                                  | scope            | 自  | 原路径                                             |
| ------------------------------- | -------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --- | -------------------------------------------------- |
| `identity.cloud.login`          | mutation | `{ assertion: string, invitationToken?: string }`               | `{ session: { hostId: string, device: {…}, scopes?: {…}[], expiresAtUnixMs?: number, csrfToken?: string, native?: {…} }, principal: { principalId: string, kind: "owner" \| "member", displayName: string }, created: boolean }`                                                                                                          | `cloud_not_registered`、`cloud_assertion_invalid`、`cloud_assertion_replayed`、`bad_request`、`forbidden`、`cloud_account_unlinked`、`invitation_invalid`、`rate_limited`                                                                                                                                                                                               | 匿名             | 1.3 | `POST /api/identity/cloud/login`                   |
| `identity.cloud.register`       | mutation | `{ issuer: string, registrationToken: string, label?: string }` | `{ issuer: string, sourceId: string, relayOrigins: string[], trustedOrigins: string[], tunnel: { state: "disabled" \| "connecting" \| "authenticating" \| "ready" \| "draining" \| "backoff", node: string \| null, since: number \| null, streams: number, lastError: {…} \| null } }`                                                   | `unauthenticated`、`forbidden`、`bad_request`、`cloud_already_registered`、`cloud_issuer_mismatch`、`registration_token_invalid`、`address_invalid`、`address_https_only`、`address_plaintext_loopback_only`、`address_has_credentials`、`fingerprint_invalid`、`source_unreachable`、`fingerprint_mismatch`、`protocol_unsupported`、`rate_limited`、`not_implemented` | `settings:write` | 1.3 | `POST /api/identity/cloud/register`                |
| `identity.cloud.revoke`         | mutation | `{ issuer: string }`                                            | `{}`                                                                                                                                                                                                                                                                                                                                      | `unauthenticated`、`forbidden`、`not_found`                                                                                                                                                                                                                                                                                                                             | `settings:write` | 1.3 | `DELETE /api/identity/cloud/register`              |
| `identity.cloud.status`         | query    | 可省 `{}`                                                       | `{ registrations: ({ issuer: string, mode: "saas" \| "personal", label?: string, jwksFetchedAtMs: integer \| null, trustedOrigins: string[], relayOrigins: string[], registeredAtMs: integer, tunnel: {…} })[], sourcePublicKey: { kty: "OKP", crv: "Ed25519", x: string, kid?: string, alg?: "EdDSA", use?: "sig" }, sourceId: string }` | `unauthenticated`、`forbidden`                                                                                                                                                                                                                                                                                                                                          | `settings:read`  | 1.3 | `GET /api/identity/cloud`                          |
| `identity.cloud.bind`           | mutation | `{ assertion: string }`                                         | `{ bound: true }`                                                                                                                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`cloud_not_registered`、`cloud_assertion_invalid`、`cloud_assertion_replayed`、`bad_request`、`conflict`、`rate_limited`                                                                                                                                                                                                                | `identity:read`  | 1.3 | `POST /api/identity/cloud/bind`                    |
| `identity.cloud.trustedOrigins` | mutation | `{ issuer: string, origins: string[] }`                         | `{ origins: string[] }`                                                                                                                                                                                                                                                                                                                   | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                                                                                                                                                                                                                                                                                                              | `settings:write` | 1.3 | `PUT /api/identity/cloud/{issuer}/trusted-origins` |

<!-- rpc:end -->

### 31.2 登记

- **登记**（`register`）：入参 `{ issuer, registrationToken, label? }`。`issuer` 取规范拼法（`https:`，回环另收 `http:`）；同一个 issuer 已有有效登记答 `409 cloud_already_registered`。随后：
  1. `GET <issuer>/.well-known/armadra-platform`：`protocol.major` 不等于协议包 `PROTOCOL_VERSION.major` 答 `426 protocol_unsupported`；自报的 `issuer` 与填的不同答 `400 cloud_issuer_mismatch`；`mode` 是 `saas` 时答 `501 not_implemented`（SaaS 服务端就绪前，总计划 §12.2）。
  2. 源密钥：SecretStore `armadra-cloud-source-key` 没有就生成一把 Ed25519（PKCS8），所有 issuer 共用；`sourceId` 就是本机 `hostId`，公钥 JWK 的 `kid` 也是它。
  3. `POST <issuer>/v1/sources/register { registrationToken, sourceId, publicKey, name, kind, coreVersion, capabilities, protocol }`（`name` 缺省为主机名，`kind` 按壳是 `desktop` / `server`）。远程服务的拒绝换成本节的码：`registration_token_invalid` 401、`protocol_unsupported` 426、`source_taken` → `409 cloud_already_registered`、`rate_limited` 429；连不上或答案不完整 `502 source_unreachable`；证书与钉的指纹对不上 `400 fingerprint_mismatch`。登记答案里的 `issuer` 与 `jwksUrl` 的来源都必须是这个 issuer，否则 `400 cloud_issuer_mismatch`。
  4. `GET <jwksUrl>` 取公钥集，与可信来源、中继来源、远程服务账号一起写进 `cloud_registrations`；之后起隧道（§32，不等），审计 `cloud.register`，答 `{ issuer, sourceId, relayOrigins, trustedOrigins, tunnel }`。任何一步失败都不留行。
- 对远程服务的请求按「远程服务」表（§33.2）里同一个 issuer 的 CA 指纹钉扎；表里没有就用系统信任。
  - 只有旧路径 `POST /api/identity/cloud/register` 另收可选的 `fingerprint`（64 位十六进制，也收带冒号或大写的写法；procedure 的入参不含它）：用注册令牌登记自签证书的个人中转没有口令可走 `sources.remoteAdd`，服务器壳 CLI（`cloud register --fingerprint`）靠它先把信任锚钉进「远程服务」表（只带指纹、无凭据的一行），登记与隧道都按它验证；同一 issuer 已有行且指纹不同答 `400 fingerprint_mismatch`，登记失败时新建的那一行一并撤掉。
- **撤销**（`revoke`，`{ issuer }`，也收查询串 `?issuer=`）：停隧道、行记 `revoked_at_ms`，之后这个 issuer 签的断言一律 `cloud_not_registered`；没有有效登记答 `404 not_found`。已映射的账号与授予不动（owner 在账号页逐个撤）。撤销过的 issuer 可以再登记。审计 `cloud.revoke`。
- **状态**（`status`）：`{ registrations: [{ issuer, mode, label?, jwksFetchedAtMs, trustedOrigins, relayOrigins, registeredAtMs, tunnel }], sourcePublicKey, sourceId }`；`tunnel` 是 `tunnelStatusSchema`，没装隧道时恒为 `{ state: "disabled", node: null, since: null, streams: 0, lastError: null }`。源公钥第一次读状态时也会生成私钥。
- **可信来源**（`trustedOrigins`，`PUT /api/identity/cloud/{issuer}/trusted-origins`，路径里的 issuer 按 URL 编码）：整份替换；每条取规范来源拼法（只收 `https:`，回环另收 `http:`），去重，最多 32 条；不合法 400，没有有效登记 404。隧道的准入（§32）按它判来源。
- §33 的 `RemoteService.registered` 读这张表；`sources.remoteRemove` 删一个本机已登记到的远程服务之前先撤销登记（连同中继侧的源记录，§31.4）。

### 31.3 断言换会话

- **验断言**（`login` 与 `bind` 同一套）：compact JWS，`alg` 只认 `EdDSA`，头 `typ` 必须是 `armadra-assertion`；按载荷的 `iss` 找有效登记，没有答 `401 cloud_not_registered`；按头的 `kid` 在缓存的 JWKS 里找钥——找不到才取一次 `jwks_url`（同一个 issuer 最多每 10 分钟一次，取到的写回缓存），远程服务离线时缓存里的钥照样验（离线验签）。验签、声明 schema（协议包 `assertionClaimsSchema`）、`aud` 等于本机 `hostId`、`iss` 等于登记的 issuer、时间（5 分钟偏差）、寿命不超过重放窗口（10 分钟），任何一条不过都答 `401 cloud_assertion_invalid`；全部通过后才按 `(iss, jti)` 记重放表，同一张第二次答 `401 cloud_assertion_replayed`。
- **映射**：外部身份 → principal 走 OAuth 那一种凭据（`identity_credentials`，`kind = 'oauth'`，`provider = "cloud:" + sha256(iss) 的前 16 位十六进制`，`subject = sub`），一个远程服务账号只对应一个 principal。
- **`login`**：入参 `{ assertion, invitationToken? }`。有映射 → 那个人（停用了答 `403 forbidden`）；没有映射且带邀请令牌 → 一笔事务里建成员、写映射、兑换邀请（`created: true`），邀请不对答 `401 invitation_invalid`；断言带 `link` 声明时邀请令牌必须就是 `link.invitationId` 那一张；没有映射也没有邀请答 `401 cloud_account_unlinked`。新建的人断言带 `org` 声明、且设置了组织默认角色（`cloud.orgDefaultRole`，§32.5，缺省不授予）时，对每块画布逐条授予那个角色。随后建设备（名字取断言的 `device.name`）与会话，`identity.login` 的 `method` 是 `cloud`。答 `{ session, principal: { principalId, kind, displayName }, created }`：原生传输（回环明文 + 壳的来源、Gateway 或隧道标过的 Bearer 模式）在 `session.native` 里给 `{ accessToken, refreshToken }`，不发 Cookie；浏览器来源发 `HttpOnly` 会话 Cookie，体里只有 `csrfToken`。
- **`bind`**：已登录的人把断言的 `sub` 映射到自己（`{ bound: true }`）；已经映射给自己是幂等的，映射给了别人答 `409 conflict`。
- **限流**：`login` 按来源地址的令牌桶（与配对同一档，只有失败扣，`429 rate_limited` 带 `Retry-After`），另按 `(iss, sub)` 每分钟 5 次（`login` 与 `bind` 共用）。
- **审计**：`cloud.login { iss, sub, principalId, created, link? }`、`cloud.bind { iss, sub }`、`cloud.register { issuer, mode }`、`cloud.revoke { issuer }`、经链接建号另记 `invitation.accept.link { iss, linkId }`。凭据（刷新令牌、源私钥、注册令牌、断言原文）不出现在任何响应、日志与审计详情里——`login` 答的原生会话是这一条的用途本身。
- 错误码沿用 `{ code, message }`（RPC 路径另带 `requestId`），与协议包 `errors` 注册表同拼法、同状态，登记在 `packages/shared/src/contract/errors.ts`：`cloud_not_registered` 401、`cloud_assertion_invalid` 401、`cloud_assertion_replayed` 401、`cloud_already_registered` 409、`cloud_issuer_mismatch` 400、`cloud_account_unlinked` 401、`invitation_invalid` 401、`registration_token_invalid` 401、`protocol_unsupported` 426。
- 外呼登记（`net/outbound.ts`）：`cloudApi`（登记）、`cloudJwks`（公钥集）。装配不联网、不读 SecretStore；没有登记行时这一域不发任何请求。

### 31.4 追加：撤销时删中继侧的源记录

<!-- rpc:begin contract=§31.4 -->

| procedure                     | kind     | input                | output                                                                  | errors                                      | scope            | 自  | 原路径                                   |
| ----------------------------- | -------- | -------------------- | ----------------------------------------------------------------------- | ------------------------------------------- | ---------------- | --- | ---------------------------------------- |
| `identity.cloud.relayPending` | query    | 可省 `{}`            | `{ pending: { issuer: string, revokedAtMs: integer, code: string }[] }` | `unauthenticated`、`forbidden`              | `settings:read`  | 1.3 | `GET /api/identity/cloud/relay-pending`  |
| `identity.cloud.relayCleanup` | mutation | `{ issuer: string }` | `{ pending: boolean, code: string \| null }`                            | `unauthenticated`、`forbidden`、`not_found` | `settings:write` | 1.3 | `POST /api/identity/cloud/relay-cleanup` |

<!-- rpc:end -->

- **撤销**（§31.2）在本机完成之后（停隧道、记 `revoked_at_ms`），再尽力删中继侧的源记录：本机有这个 issuer 的远程服务行（§33.2）且有保存的登录时，用它的会话调远程服务的 `sources.revoke`（`DELETE <issuer>/v1/sources/{sourceId}`，cloud-api §4，要 owner；`sourceId` 是本机 `hostId`）。删掉了、或中继上本来就没有（`not_found`），算清理完成。
- 没删成时本机撤销照样算数（`revoke` 仍答 `{}`），行上记下当时的错误码，即「中继侧待清理」（迁移 `0041_cloud_relay_cleanup`，列 `relay_cleanup`）：没有远程服务行、没有保存的登录、会话失效或不是 owner `source_unauthorized`；连不上 `source_unreachable`；其余照远程服务的码收拢（§33）。页面按码取文案。
- `relayPending`：`{ pending: [{ issuer, revokedAtMs, code }] }`，按撤销先后。`relayCleanup { issuer }`：重试一条，答 `{ pending: false, code: null }` 或 `{ pending: true, code }`；不欠的答 `404 not_found`。同一个 issuer 再登记时清掉。
- 隧道收到中继的 `source_revoked`（§32）而撤销本机登记时，中继侧已经撤了，不再去删、不记待清理。
- `sources.remoteRemove`（§33.2）删一个本机已登记到的远程服务时，先按本节撤销（用的正是这一行的会话），再登出、删凭据、删行。
- 审计 `cloud.revoke` 的详情加 `relayCleanup: "done" | "pending"`。服务器壳 CLI `cloud revoke` 撤销后读 `relayPending`，没删掉时如实输出「中继侧待清理」与码（JSON 输出的 `relayPending`）。

## 32. 隧道面：core 作为出站隧道客户端

> 状态：实施契约（A3-2，实现 `core/relay/`；规格见平台实现规格 core 包 §4（docs/design/platform/core-packages.md））。中继一侧的线上行为见 [cloud-api.md](https://github.com/Owlbay/armadra-cloud/blob/main/docs/contracts/cloud-api.md) §7、§8，这里不另抄。

范围：core 经中继节点建立出站隧道，让登记过的远程服务（§31）的客户端经中继访问本机 core。隧道本身没有 HTTP 路径可调用，这一节记的是它的行为边界与可观察面。

### 32.1 连接与握手

- 每个有效登记（§31.2）一条隧道。节点与隧道令牌：`GET <issuer>/v1/sources/me/relay`，`Authorization: Source <jws>`（源私钥签，`aud` = issuer），答 `{ tunnelToken, expiresAtMs, nodes, limits }`；令牌缓存 50 分钟，被中继以 `tunnel_token_*` 拒绝就丢掉重取。节点按设置 `cloud.relay.preferredNode`（节点地址或区域名）排最前，其余按权重；一个节点连不上换下一个。对远程服务与节点的连接都按「远程服务」表（§33）里同一 issuer 的 CA 指纹钉扎，没有那一行用系统信任。
- 节点地址必须是 `wss://`；`ws://` 只在 `ARMADRA_RELAY_ALLOW_INSECURE=1`（探针）时放行。WebSocket `maxPayload = maxFrameBytes + 16`，不压缩，握手 10 秒。
- 握手与帧表以协议包 `@armadra/platform-protocol/tunnel`（隧道协议 `t/v1`）为准，本文不复制格式：`hello`（`sourceId` 即本机 `hostId`，带隧道令牌与 16 字节 nonce）→ `challenge` → `auth`（源私钥对 `sourceId\nnonce\nnonce2\nrelayNode` 的 Ed25519 签名）→ `ready` / `reject`。`ready.limits` 是两级窗口的初始信用，`ready.heartbeatMs` 是心跳间隔。
- 拒绝码：`protocol_unsupported` 停下、不再重连（直到 core 重启、重新登记或把开关关了再开）；`source_revoked`（握手拒绝，或取令牌答 `410`）→ 本机撤销这条登记（§31.2 的撤销，审计 `cloud.revoke`）；其余（`tunnel_token_*`、`signature_invalid`、`rate_limited`）退避重来。

### 32.2 流、窗口与心跳

- 只有中继发 `OPEN`；每条流在 core 里是一个 `Duplex`，交给一个只给隧道用的监听，由 Node 自己解析里面的 HTTP/1.1 与 WebSocket 升级。HTTP 流一流一个请求（中继给 `connection: close`）。流数超过 `limits.maxStreams` 答 `RST refused`。
- 流控：`DATA` 按 64 KiB 切块，同时扣流信用与隧道信用，任一不足就等 `WINDOW`；交给上层的字节累计到窗口一半时补回。对端超发 → `RST 5` 并以 `4400` 关隧道。没发出去的字节留在流的写缓冲里，WebSocket 的 `bufferedAmount` 含这一段，五条长连接的发送队列（§3.4）照常据此判拥塞、暂停生产者。
- 心跳：收到 `PING` 立即回 `PONG`；core 自己每 `heartbeatMs` 发一次 `PING`，连续两次没有 `PONG` 断开重连。另有静默超时：就绪后连续 `heartbeatMisses × heartbeatMs`（缺省 40 秒）没收到中继的任何帧，同样以 `heartbeat_timeout` 断开、退避重连——中继被冻住或 NAT 表项悄悄失效时 TCP 不报错，只等 `PONG` 要到第三拍才发现。长连接上 core 自己的 ws 心跳（§3.4）照旧经隧道走。
- `GOAWAY`：不退避，立即换节点再连一条；旧隧道不再接新流，流自然结束（或 `graceMs` 到了）后关闭。
- 退避：`min(60 s, 1 s × 2^n) × (0.5 + 随机)`，就绪过一次 `n` 归零。
- 隧道断开时这条隧道上的流以 `RST sourceGone` 结束，经它进来的 HTTP 与 WebSocket 随之结束；终端、Agent、画布不依赖连接存活。

### 32.3 准入

隧道来的请求按 Bearer 模式准入，与 Gateway 的原生 App 那一条等价，不享受回环的匿名，也不认 Cookie：

1. 路径落在 `loopbackOnlyPath`（`/hook/`、`/control/`、`/context-link/`、`/browser/`、`/verify`）一律 `403 forbidden`。
2. 来源以 `OPEN.clientOrigin` 为准；请求头的 `Origin` 与它不一致 `403`。来源必须在这条登记的可信来源（§31.2 `trustedOrigins`）或原生 App 的两个来源（`capacitor://localhost`、`https://localhost`）之内，否则 `403`。没有来源（非浏览器）的请求只放行 `/health` 与 `/api/identity/*` 的匿名面，其余 `403`，升级一律 `403`；例外是中继托管的页面（来源就是中继）发的同源 `GET` / `HEAD`：浏览器不带 `Origin`，带 `Sec-Fetch-Site: same-origin` 时按会话来源（`relayOrigins[0]`）认，照样要绑在它上面的 Bearer。
3. 匿名面（`/health`、身份域自己的登录面，含 `POST /api/identity/cloud/login`）放行，以一个没有任何授权的成员身份跑；预检只答 CORS。
4. `POST /api/identity/ws-ticket` 由隧道自己签票（30 秒、一次性，绑在会话来源上）；WebSocket 升级只认 `Sec-WebSocket-Protocol` 里的 `armadra-ticket.<票>`，票不对、用过或来源不符 `401`。
5. 其余要 `Authorization: Bearer <访问密钥>`；没有或认不出 `401 unauthenticated`（JSON 形状同 §3）。

会话绑在这个远程服务的中继来源上（`relayOrigins[0]`，缺省就是 issuer）：放行前请求头的 `Origin` 换成它、请求标成 Bearer 传输，于是 `cloud/login`（§31.3）经隧道答 `session.native`、不发 Cookie，换来的会话只在隧道上有效；回环与 Gateway 签的会话也进不了隧道。CORS 只回客户端自己的来源。认出来的人进这次请求的身份，路由门、事件订阅与长连接的 `4401` / `4403` 复核与回环、Gateway 走同一条路。

### 32.4 关闭码

- 隧道上的（core ↔ 中继）：`4400`（帧格式或流控违规）、`4409`（协议不兼容）、`4429`（握手限流）、`4490`（隧道认证失败）、`4491`（被同源新隧道替换）、`4492`（中继关闭或撤销）；core 主动停（撤销、关开关、退出）以 `1000` 关。
- 经中继的客户端长连接：沿用 `4401` / `4403` 复核；源离线（隧道断开、撤销）时中继以 `4404` 结束。

### 32.5 状态、设置与外呼

- 状态面：`GET /api/identity/cloud` 的 `registrations[].tunnel` 是协议包 `tunnelStatusSchema`：`{ state: disabled | connecting | authenticating | ready | draining | backoff, node, since, streams, lastError: { code, message } | null }`。`lastError.code` 是 `relay_unreachable`、`fingerprint_mismatch`、`insecure_node`、`handshake_timeout`、`heartbeat_timeout`、`tunnel_protocol_error`、`relay_closed`、`source_unauthenticated`、`source_key_unavailable` 或中继的拒绝码。
- 事件：工作空间事件流（§5）上的 `cloud.tunnel { issuer, state }`，状态变了发给每块正被人看着的画布（`events:read`），不进 outbox。
- 设置键：`cloud.relay.enabled`（缺省 `true`，关掉即全部停止、打开即按登记全部起，当场生效）、`cloud.relay.preferredNode`（缺省空串），两者存在本机那一半；`cloud.orgDefaultRole`（`viewer` / `editor` / `operator` / `driver` / `null`，缺省 `null` = 不授予，§31.3 读它）。
- 旁路保证：装配不联网；隧道在回环监听开始之后才起，而且不等；隧道的建立、失败与重连只进它自己的状态，不阻塞也不影响 core 的启动与回环 API。
- 外呼登记（`net/outbound.ts`）：`relayTunnel`（开关 `cloud.relay.enabled`）、`cloudApi`（隧道令牌）、`cloudJwks`。

## 33. 客户端源表与远程服务：`/api/sources/*`

> 状态：实施契约（A1-3，迁移 `0039_client_sources`，实现 `core/sources/`；规格见平台实现规格 core 包 §1（docs/design/platform/core-packages.md））。下面两张形状表由 `tools/contract/generate.mjs` 从 `packages/shared/src/contract/sources.ts` 生成；出入参就是协议包 `@armadra/platform-protocol/core-api` 的 schema 对象，cloud 仓与这里同一份。

范围：这台 core 作为「客户端宿主」记住的别的源（`client_sources`）以及它登记过或能登录的远程服务（`remote_services`），并代页面完成配对、登录、换票与选路。全部为 owner 专用：读取需要 `settings:read`，写入需要 `settings:write`（`route-scopes.ts` 的 `/api/sources` 一行；服务器壳上的成员没有这两项，一律 403，且不触发任何外呼）。手机不经本机 core，`/api/sources/*` 只在桌面与服务器壳的页面上使用。每条都有 procedure（`POST /api/rpc/sources/<动词>`，§34.1）与下表「原路径」两种调法，同一份实现。

### 33.1 源表

<!-- rpc:begin contract=§33.1 -->

| procedure           | kind     | input                                                                                                | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | errors                                                                                                                                                                                                                                                       | scope            | 自  | 原路径                                 |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --- | -------------------------------------- |
| `sources.list`      | query    | 可省 `{}`                                                                                            | `{ sources: ({ sourceId: string, kind: "local" \| "direct" \| "relayed" \| "hosted", label: string, baseUrl: string, relayOrigin: string, fingerprint: string, cloudIssuer: string, principalHint: string, addedAtMs: integer, lastOkAtMs: integer, orderIndex: integer, hasCredentials: boolean })[], remotes: ({ serviceId: string, kind: "personal" \| "saas", issuer: string, label: string, accountHint: string, fingerprint: string, addedAtMs: integer, lastOkAtMs: integer, registered: boolean, hasCredentials: boolean })[] }` | `unauthenticated`、`forbidden`                                                                                                                                                                                                                               | `settings:read`  | 1.3 | `GET /api/sources`                     |
| `sources.addDirect` | mutation | `{ pairLink?: string, origin?: string, code?: string, fingerprint?: string, label?: string }`        | `{ sourceId: string, kind: "local" \| "direct" \| "relayed" \| "hosted", label: string, baseUrl: string, relayOrigin: string, fingerprint: string, cloudIssuer: string, principalHint: string, addedAtMs: integer, lastOkAtMs: integer, orderIndex: integer, hasCredentials: boolean }`                                                                                                                                                                                                                                                  | `unauthenticated`、`forbidden`、`bad_request`、`address_invalid`、`address_https_only`、`address_plaintext_loopback_only`、`address_has_credentials`、`fingerprint_invalid`、`conflict`、`source_unreachable`、`source_unauthorized`、`fingerprint_mismatch` | `settings:write` | 1.3 | `POST /api/sources/direct`             |
| `sources.update`    | mutation | `{ sourceId: string, label?: string, orderIndex?: integer, baseUrl?: string, relayOrigin?: string }` | `{ sourceId: string, kind: "local" \| "direct" \| "relayed" \| "hosted", label: string, baseUrl: string, relayOrigin: string, fingerprint: string, cloudIssuer: string, principalHint: string, addedAtMs: integer, lastOkAtMs: integer, orderIndex: integer, hasCredentials: boolean }`                                                                                                                                                                                                                                                  | `unauthenticated`、`forbidden`、`bad_request`、`address_invalid`、`address_https_only`、`address_plaintext_loopback_only`、`address_has_credentials`、`not_found`                                                                                            | `settings:write` | 1.3 | `PUT /api/sources/{sourceId}`          |
| `sources.remove`    | mutation | `{ sourceId: string }`                                                                               | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`not_found`、`conflict`                                                                                                                                                                                                      | `settings:write` | 1.3 | `DELETE /api/sources/{sourceId}`       |
| `sources.forget`    | mutation | `{ sourceId: string }`                                                                               | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`not_found`、`conflict`                                                                                                                                                                                                      | `settings:write` | 1.3 | `POST /api/sources/{sourceId}/forget`  |
| `sources.session`   | mutation | `{ sourceId: string, via?: "direct" \| "relayed" }`                                                  | `{ accessToken: string, accessExpiresAtMs: integer, httpBase: string, wsBase: string, via: "direct" \| "relayed", relayToken?: string, relayTokenExpiresAtMs?: integer }`                                                                                                                                                                                                                                                                                                                                                                | `unauthenticated`、`forbidden`、`not_found`、`conflict`、`source_unauthorized`、`source_unreachable`                                                                                                                                                         | `settings:write` | 1.3 | `POST /api/sources/{sourceId}/session` |

<!-- rpc:end -->

### 33.2 远程服务

<!-- rpc:begin contract=§33.2 -->

| procedure                  | kind     | input                                                                                                                                                               | output                                                                                                                                                                                                                                                                                  | errors                                                                                                                                                                                                                                                                                                | scope            | 自  | 原路径                                          |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --- | ----------------------------------------------- |
| `sources.remoteAdd`        | mutation | `{ kind: "personal", issuer: string, account: string, password: string, label?: string, fingerprint?: string } \| { kind: "saas", issuer: string, label?: string }` | `{ remote: { serviceId: string, kind: "personal" \| "saas", issuer: string, label: string, accountHint: string, fingerprint: string, addedAtMs: integer, lastOkAtMs: integer, registered: boolean, hasCredentials: boolean }, next: "ready" \| { deviceCode: {…} } }`                   | `unauthenticated`、`forbidden`、`bad_request`、`address_invalid`、`address_https_only`、`address_plaintext_loopback_only`、`address_has_credentials`、`fingerprint_invalid`、`credentials_invalid`、`account_locked`、`rate_limited`、`fingerprint_mismatch`、`source_unreachable`、`not_implemented` | `settings:write` | 1.3 | `POST /api/sources/remotes`                     |
| `sources.remoteDevicePoll` | mutation | `{ serviceId: string }`                                                                                                                                             | `{ status: "pending" \| "ready" \| "denied" \| "expired" }`                                                                                                                                                                                                                             | `unauthenticated`、`forbidden`、`not_found`、`not_implemented`                                                                                                                                                                                                                                        | `settings:write` | 1.3 | `POST /api/sources/remotes/{serviceId}/poll`    |
| `sources.remoteRemove`     | mutation | `{ serviceId: string }`                                                                                                                                             | `{}`                                                                                                                                                                                                                                                                                    | `unauthenticated`、`forbidden`、`not_found`                                                                                                                                                                                                                                                           | `settings:write` | 1.3 | `DELETE /api/sources/remotes/{serviceId}`       |
| `sources.remoteSources`    | query    | `{ serviceId: string }`                                                                                                                                             | `{ sources: ({ sourceId: string, name: string, kind: "desktop" \| "server" \| "hosted", online: boolean, lastSeenAtMs: integer \| null, owner: boolean, via: "owner" \| "link" \| "org", relayOrigin: string, coreVersion: string, mounted: boolean })[] }`                             | `unauthenticated`、`forbidden`、`not_found`、`source_unauthorized`、`source_unreachable`、`not_implemented`                                                                                                                                                                                           | `settings:read`  | 1.3 | `GET /api/sources/remotes/{serviceId}/sources`  |
| `sources.mount`            | mutation | `{ serviceId: string, sourceId: string, label?: string }`                                                                                                           | `{ sourceId: string, kind: "local" \| "direct" \| "relayed" \| "hosted", label: string, baseUrl: string, relayOrigin: string, fingerprint: string, cloudIssuer: string, principalHint: string, addedAtMs: integer, lastOkAtMs: integer, orderIndex: integer, hasCredentials: boolean }` | `unauthenticated`、`forbidden`、`not_found`、`conflict`、`source_offline`、`source_unauthorized`、`source_unreachable`、`cloud_account_unlinked`、`not_implemented`                                                                                                                                   | `settings:write` | 1.3 | `POST /api/sources/remotes/{serviceId}/mount`   |
| `sources.remoteSession`    | mutation | `{ serviceId: string }`                                                                                                                                             | `{ accessToken: string, accessExpiresAtMs: integer, issuer: string, capabilities: string[] }`                                                                                                                                                                                           | `unauthenticated`、`forbidden`、`not_found`、`source_unauthorized`、`source_unreachable`、`not_implemented`                                                                                                                                                                                           | `settings:write` | 1.3 | `POST /api/sources/remotes/{serviceId}/session` |

<!-- rpc:end -->

### 33.3 形状

```json
{
  "sourceId": "…32 位十六进制…",
  "kind": "direct",
  "label": "laptop",
  "baseUrl": "https://192.168.1.20:8443",
  "relayOrigin": "",
  "fingerprint": "…64 位十六进制…",
  "cloudIssuer": "",
  "principalHint": "owner",
  "addedAtMs": 1791273600000,
  "lastOkAtMs": 1791273600000,
  "orderIndex": 1,
  "hasCredentials": true
}
```

- `ClientSource.kind` 取 `local` / `direct` / `relayed` / `hosted`。`local` 一行由 core 启动时 upsert（`sourceId` = 本机 `hostId`，`label` = 主机名），不可删、不可 `forget`、不换票，`hasCredentials` 恒为 `true`；列表里它永远排第一，其余按 `orderIndex`、再按加入先后。
- `RemoteService` 为 `{ serviceId, kind: "personal" | "saas", issuer, label, accountHint, fingerprint, addedAtMs, lastOkAtMs, registered, hasCredentials }`。`registered`（本机是否登记到它）读 §31 的登记表。
- `RemoteSourceSummary` 是远程服务 `me.sources` 的一行加 `mounted`（本机源表里有没有这个 `sourceId`）。
- 指纹一律是信任锚 DER 的 SHA-256，64 位小写十六进制（入参也收带冒号或大写的写法，存的是规范拼法）。地址只收 `https:`，回环主机另收 `http:`；不带账号、不带路径。

### 33.4 凭据与 SecretStore

- `armadra-source-<sourceId>`：`{ "byOrigin": { "<来源>": { "refreshToken", "deviceId" } } }`——直连按 Gateway 来源、经中继按中继来源各存一份。
- `armadra-remote-<serviceId>`：`{ "refreshToken", "deviceId" }`。
- 后端是 core 的 SecretStore（macOS 钥匙串、桌面壳 `safeStorage`、服务器壳数据目录里的加密文件，外部服务 §12.1），不是 SQLite：两张表里没有一个令牌。
- 访问令牌不落盘（远程服务的那一把只缓存在内存，到期前一分钟换新）；口令只经过一次 `auth.login` 请求，不存、不记日志。
- 刷新令牌每次换票都旋转并写回；同一把一次只换一次（并发的两次换票会让对端按「旧令牌再出现」撤销整台设备）。对端答刷新令牌失效时，那一份凭据随即删除。
- 响应里只有 `hasCredentials`；`refreshToken`、`password` 不出现在任何答案、日志与错误详情里；入参校验失败的 `details.issues` 只给字段路径，不回显值（§34.1）。`sources.session` 与 `sources.remoteSession` 答的访问令牌是这两条的用途本身。

### 33.5 行为

- **对端的身份**：core 对别的 core 自称原生 App（`Origin: https://localhost`，Bearer 模式，§17.4），密钥在响应体的 `native` 里；经中继时加 `Armadra-Relay-Token` 头（armadra-cloud 契约 §7）。
- **钉扎**：给了指纹的地址，先从对端发来的链里找指纹相符的那张，链里没有就取 `GET /ca.crt` 比对；再以那一张作为唯一信任锚照常验证链与主机名。对不上、或拿公开的 CA 配别的叶证书，都答 `fingerprint_mismatch`。不给指纹就用系统信任。经中继时，中继就是远程服务本身（个人中转）才沿用它的指纹。
- **`addDirect`**：`pairLink` 认 `https://<来源>/#pair=<票>&fp=<指纹>` 与 `armadra://pair?host=…&ticket=…&fp=…`；也可以给 `origin` + `code`（8 位配对码，先 `POST /api/gateway/pairing-code/exchange` 换票，§24）。随后 `GET /api/identity/hello` 取 `hostId`（就是 `sourceId`；是本机则 `conflict`），`POST /api/identity/pair` 换会话，存刷新令牌。已有同一 `sourceId` 的行时合并（经中继挂上的行保留 `relayed`）。
- **`remoteAdd`**：`personal` 先读 `/.well-known/armadra-platform`（`mode` 不是 `personal` 答 `bad_request`），再 `POST /v1/auth/login { account, password, device }`；同一个 `issuer` 再加是重新登录，不多一行。`saas` 与 `remoteDevicePoll` 在 SaaS 服务端就绪前答 `501 not_implemented`（总计划 §12.2）。
- **`mount`**：用远程服务会话取断言（`POST /v1/sources/{sourceId}/assertion`），`online: false` 答 `source_offline`；经 `relayBaseUrl` `POST /api/identity/cloud/login`（§31），存刷新令牌，建或合并 `relayed` 行（`cloudIssuer` = 远程服务，`relayOrigin` = 中继来源；`label` 缺省取远程服务目录里的名字）。源的拒绝（如 `cloud_account_unlinked`）透传。
- **`session` 选路（D27）**：`via` 省略时并行问直连的 `GET <baseUrl>/api/identity/hello`（1.5 秒）与远程服务的断言；直连成功且 `hostId === sourceId` 就用直连的刷新令牌换票，否则走中继；都不行答 `source_unreachable`（某一路是明确的拒绝时答那一路的码，如 `source_unauthorized`）。经中继时先用存着的刷新令牌，对端答 401 就用断言重新 `cloud/login` 并写回；远程服务的会话也失效答 `source_unauthorized`（页面提示重新登录远程服务）。每次成功换票更新 `lastOkAtMs`。
- **`remoteRemove`**：尽力登出（远程服务不可达不拦），删行与凭据；已挂载的源行保留。本机已登记到它时先撤销登记（§31.2）。
- **旁路保证**：core 启动只 upsert 本机那一行（纯 SQLite），不联网、不读凭据；每次外呼都由一次调用触发、带超时（直连探测 1.5 秒，其余 10 秒），失败只落在那一次调用上——列表、本机行与其余域照常。域有意答的 5xx（`source_unreachable` 502、`source_offline` 503）是答案，不记错误、不进崩溃上报。
- 外呼登记（`net/outbound.ts`）：`cloudApi`（远程服务 `/v1/*`）、`sourceGateway`（别的 core 的 Gateway 或中继面）。
- 错误码 `source_unreachable`（502）、`source_unauthorized`（401）、`source_offline`（503）、`fingerprint_mismatch`（400）、`credentials_invalid`（401）、`account_locked`（429，`details.retryAfterMs`）、`cloud_account_unlinked`（401）与协议包 `errors` 注册表同拼法、同状态，登记在 `packages/shared/src/contract/errors.ts`。
- 以后新增的 procedure 追加在本节末尾，不改已有条目（按链接挂载 `mountByLink` 见 §33.7）。

### 33.6 追加：登出与首次指纹

> A1-4（「远程服务」设置页）追加。

<!-- rpc:begin contract=§33.6 -->

| procedure              | kind     | input                   | output | errors                                      | scope            | 自  | 原路径                                         |
| ---------------------- | -------- | ----------------------- | ------ | ------------------------------------------- | ---------------- | --- | ---------------------------------------------- |
| `sources.remoteLogout` | mutation | `{ serviceId: string }` | `{}`   | `unauthenticated`、`forbidden`、`not_found` | `settings:write` | 1.3 | `POST /api/sources/remotes/{serviceId}/logout` |

<!-- rpc:end -->

- **`remoteLogout`**：尽力 `auth.logout`（远程服务不可达不拦），删 `armadra-remote-<serviceId>` 与内存里的访问令牌，**保留行**（`hasCredentials` 变 `false`）；重新登录就是同一个 `issuer` 再 `remoteAdd` 一次。本机对它的登记（§31.2）不动。
- **首次指纹**：`remoteAdd` 与 `addDirect`（地址 + 配对码那一种）没给 `fingerprint`、系统又不信任对端证书时，答 `400 fingerprint_mismatch`，`details.fingerprint` 是对端信任锚（链里最末那张；只发叶证书时取 `/ca.crt` 里签了它的那张）的指纹。页面请人核对后带着它重调；系统信任的对端（ACME / 公网证书）不要指纹，照常成功。

### 33.7 追加：按分享链接挂载

> A4-3p（个人中转的链接加入）追加。

<!-- rpc:begin contract=§33.7 -->

| procedure             | kind     | input                                                   | output                                                                                                                                                                                                                                                                                  | errors                                                                                                                                                                                                                                                                                                                                                                                                                                   | scope            | 自  | 原路径                   |
| --------------------- | -------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --- | ------------------------ |
| `sources.mountByLink` | mutation | `{ url: string, fingerprint?: string, label?: string }` | `{ sourceId: string, kind: "local" \| "direct" \| "relayed" \| "hosted", label: string, baseUrl: string, relayOrigin: string, fingerprint: string, cloudIssuer: string, principalHint: string, addedAtMs: integer, lastOkAtMs: integer, orderIndex: integer, hasCredentials: boolean }` | `unauthenticated`、`forbidden`、`bad_request`、`address_invalid`、`address_https_only`、`address_plaintext_loopback_only`、`address_has_credentials`、`fingerprint_invalid`、`conflict`、`fingerprint_mismatch`、`link_invalid`、`link_expired`、`link_exhausted`、`link_secret_invalid`、`invitation_invalid`、`rate_limited`、`source_offline`、`source_unauthorized`、`source_unreachable`、`cloud_not_registered`、`not_implemented` | `settings:write` | 1.3 | `POST /api/sources/join` |

<!-- rpc:end -->

- **`mountByLink`**：`url` 收分享链接的两种写法——网页链接 `<issuer>/j/<linkId>#<秘密>.<core 邀请令牌>` 与深链 `armadra://join?link=<linkId>&issuer=<issuer>&s=<秘密>.<core 邀请令牌>`（片段按第一个 `.` 切）。认不出答 `bad_request`；只收个人中转（`/.well-known/armadra-platform` 的 `mode` 不是 `personal` 答 `501 not_implemented`）。
- **指纹**：签发方在「远程服务」表里已有一行就沿用它的指纹（给的 `fingerprint` 与之不同答 `fingerprint_mismatch`）；没有这一行又没给指纹、系统不信任对端证书时，与 §33.6 的首次指纹同一种答法（`details.fingerprint`），页面请人核对后带着它重调。
- **流程**：`POST <issuer>/v1/links/{linkId}/accept { secret, device }`（匿名，armadra-cloud cloud-api §5）→ 访客会话、断言、中继令牌 → 经 `relayBaseUrl` `POST /api/identity/cloud/login { assertion, invitationToken }`（§31.3）→ 原生会话，存刷新令牌，建或合并 `relayed` 行（`cloudIssuer` = 签发方，`label` 缺省取远程服务目录里的名字）。`sourceId` 是本机答 `conflict`。
- **远程服务行**：签发方还没有一行（或那一行没有登录）时建 / 补一行访客的：`accountHint` 为空串，凭据是访客的刷新令牌（之后换票用它取断言）。已经用账号登录着的不动它的凭据，访客会话尽力登出。
- **错误**：远程服务的拒绝原样透传 `link_invalid`（不存在或已撤销）、`link_expired`、`link_exhausted`、`link_secret_invalid`、`rate_limited`；源的拒绝透传 `invitation_invalid`、`cloud_not_registered`、`source_offline`。`link_expired` / `link_exhausted`（410）、`link_secret_invalid`（403）与协议包同拼法同状态；`link_invalid` 沿用注册表里已有的 409（协议包为 404），页面只按码取文案。
- 链接的秘密与邀请令牌只在这一次调用里，不存、不进日志与答案。

### 33.8 追加：地址与指纹的写法错误码

core 校验远程服务地址与指纹的写法时用具名码（状态均 400），代替通用的 `bad_request`：`address_invalid`（不是合法 URL）、`address_https_only`（协议不是 http / https）、`address_plaintext_loopback_only`（明文 `http:` 只许回环地址）、`address_has_credentials`（地址里带账号或口令）、`fingerprint_invalid`（不是 64 位十六进制）。`sources.addDirect`、`sources.update`（只有地址类）、`sources.remoteAdd`、`sources.mountByLink` 与 `identity.cloud.register` 都可能答这些码；页面按码取文案，另在提交前对 `http://` 的非回环地址自行拒绝，地址没写协议时按 `https://` 提交。

### 33.9 追加：分享链接管理

> 远程服务页的分享区追加。协议 minor 16。

<!-- rpc:begin contract=§33.9 -->

| procedure                 | kind     | input                                                                                                        | output                                                                                                                                                                                                                                                                                        | errors                                                                                                                                                             | scope            | 自   | 原路径                                                     |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---- | ---------------------------------------------------------- |
| `sources.shareLinks`      | query    | `{ serviceId: string }`                                                                                      | `{ links: ({ linkId: string, label: string, role: string, workspaceId: string, createdAtMs: integer, expiresAtMs: integer, uses: integer, maxUses: integer \| null, revokedAtMs: integer \| null, state: "active" \| "expired" \| "exhausted" \| "revoked", copyable: boolean })[] }`         | `unauthenticated`、`forbidden`、`not_found`、`source_unauthorized`、`source_unreachable`、`not_implemented`                                                        | `settings:read`  | 1.16 | `GET /api/sources/remotes/{serviceId}/links`               |
| `sources.shareLinkCreate` | mutation | `{ serviceId: string, workspaceId: string, role: string, ttlMs: integer, maxUses: integer, label?: string }` | `{ link: { linkId: string, label: string, role: string, workspaceId: string, createdAtMs: integer, expiresAtMs: integer, uses: integer, maxUses: integer \| null, revokedAtMs: integer \| null, state: "active" \| "expired" \| "exhausted" \| "revoked", copyable: boolean }, url: string }` | `unauthenticated`、`forbidden`、`bad_request`、`not_found`、`cloud_not_registered`、`source_unauthorized`、`source_unreachable`、`rate_limited`、`not_implemented` | `settings:write` | 1.16 | `POST /api/sources/remotes/{serviceId}/links`              |
| `sources.shareLinkUrl`    | mutation | `{ serviceId: string, linkId: string }`                                                                      | `{ url: string }`                                                                                                                                                                                                                                                                             | `unauthenticated`、`forbidden`、`not_found`                                                                                                                        | `settings:write` | 1.16 | `POST /api/sources/remotes/{serviceId}/links/{linkId}/url` |
| `sources.shareLinkRevoke` | mutation | `{ serviceId: string, linkId: string }`                                                                      | `{}`                                                                                                                                                                                                                                                                                          | `unauthenticated`、`forbidden`、`not_found`、`source_unauthorized`、`source_unreachable`、`not_implemented`                                                        | `settings:write` | 1.16 | `DELETE /api/sources/remotes/{serviceId}/links/{linkId}`   |

<!-- rpc:end -->

- **一条链接是两半**：本机一张多次可用的邀请（§42.3 `accounts.invitations.issue`，`maxUses` 1–1000，以当前请求的主体签发，权限与它相同）和远程服务上一条指向它的 `source_invite` 链接（armadra-cloud cloud-api §5 `links.create`，带同样的 `maxUses` 与到期时刻）。分享出去的整条链接是 `<issuer>/j/<linkId>#<秘密>.<邀请令牌>`（§33.7 认的那种写法）。
- **`shareLinkCreate`**：本机没登记到这个远程服务（§31）答 `cloud_not_registered`；`ttlMs` 超过 30 天按 30 天减一分钟签（远程服务的上限是 30 天）；`label` 是备注（缺省空串，落地页与访客的源名用它）。远程服务没建成时刚签的邀请随即作废。答案里有整条链接 `url` 与这条链接的摘要。
- **存下来再复制**：秘密与邀请令牌只在创建时出现，所以整条链接存进 SecretStore 的 `armadra-share-links-<serviceId>`（`{ links: { [linkId]: { url, invitationId, workspaceId } } }`），不进 SQLite、日志与列表。`shareLinkUrl` 再取一次整条链接；本机没存着（别处建的、已失效的）答 `not_found`。
- **`shareLinks`**：远程服务 `links.list?sourceId=<本机>` 的全部 `source_invite`，含历史；`state` 按 撤销 > 过期（`expiresAtMs <= 现在`）> 用尽（`uses >= maxUses`）> 生效 判；`copyable` 是本机还存着整条链接；`workspaceId` 来自本机存着的那份，没有时为空串；按创建时间倒序。不再生效、或远程服务上已经没有的，顺手删掉存着的整条链接；远程服务那边撤销的，本机那张邀请一并作废。本机没登记到它时答空表并清掉存着的。
- **`shareLinkRevoke`**：远程服务撤链接（连同它名下的访客设备与经中继的连接）；远程服务上已经没有它照样成功。随后作废本机那张邀请、删存着的整条链接。
- **删远程服务**（`remoteRemove`）时连同 `armadra-share-links-<serviceId>` 一起删。远程服务不提供改备注，没有对应的 procedure。

## 34. RPC 内核：`/api/rpc/{procedure}`

> 状态：实施契约（E1，工程规范化 §2）。本节的形状表由 `tools/contract/generate.mjs` 从 `packages/shared/src/contract/` 生成，改形状改契约，不手改表；`pnpm check` 里的 `contract:check` 比对它们。机器可读的同一份在 [core-openapi.json](core-openapi.json)。

### 34.1 传输与错误

- **路径**：`POST /api/rpc/<域>/<动词>`（`workspaces.list` → `/api/rpc/workspaces/list`）。只收 `POST`：别的方法答 `405 method_not_allowed`——一个能被 `GET` 触发的写，在 Cookie 会话上就绕开了 CSRF。不在契约里的路径答 `404 not_found`；契约里有、这个构建没实现的答 `501 not_implemented`。
- **体**：请求与成功响应都是上游 RPC 编码，`{ "json": <值>, "meta"?: […] }`；下面各表的 input / output 是 `json` 那一格的形状。编码规则仍是 §2：camelCase、`int64` 写十进制字符串，不用 RPC 编码对 `bigint` / `Date` 的原生扩展。
- **失败**：一律 `{ "code", "message", "requestId", "details"? }`，状态按错误码注册表（`packages/shared/src/contract/errors.ts`）。入参校验失败是 `400 bad_request`，`details.issues` 是 `{ path: string[], message }[]`，不回显入参的值；实现里没人接住的异常与出参校验失败是 `500 internal`，原话不外泄（只进日志与崩溃上报）。
- **鉴权**：准入（回环会话、Gateway、CSRF）与迁移前一样在 `core/http/server.ts` 里先判；`/api/rpc/` 在路由门里是自己判的那一档（`route-scopes.ts` 的 `SELF_GUARDED`），门面按每条的 `scope` 与 `workspaceKey` 走同一道路由门。带旧路径的 procedure 拿旧路径去问，服务器壳上成员看到的工作空间列表照旧只剩他有 `canvas:read` 的那几块。
- **旧路径**：表里「原路径」那一列在迁移期照旧可用，由同一份实现经旧的方法与路径回答；失败是 `{ code, message }`（有细节时加 `details`），不带 `requestId`，与迁移前同形。不在契约里的路径与方法照旧由路由表回答。旧路径在下一个 minor 删除（E4）。
- **出参校验**：`ARMADRA_RPC_VALIDATE_OUTPUT=1` / `0` 开关；缺省开发与测试开、打包的生产构建关。`ARMADRA_RPC_TRACE=1` 记每条调用的耗时。
- **版本**：协议 `minor` 自 3 起有本节（`GET /api/identity/hello` 的 `protocol` 同步为 `1.3`）。`since` 是一条 procedure 首次出现的协议版本；页面按 `system.hello` 的 `procedures` 判断这台 core 有没有某条。

### 34.2 `system.hello`

这台 core 是谁、实现了哪些 procedure、控制面心跳间隔与这次会话的到期时刻。`GET /api/identity/hello` 照旧是配对之前的匿名面；这一条要会话。

<!-- rpc:begin contract=§34.2 -->

| procedure      | kind | input                 | output                                                                                                                                                                                                                                     | errors                         | scope           | 自  | 原路径 |
| -------------- | ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------- | --- | ------ |
| `system.hello` | call | `{ trace?: boolean }` | `{ protocol: { major: integer, minor: integer }, procedures: string[], capabilities: string[], heartbeatMs: integer, maxFrameBytes: integer, sessionExpiresAtMs: integer \| null, instanceId: string, sourceId: string, version: string }` | `unauthenticated`、`forbidden` | `identity:read` | 1.3 | —      |

<!-- rpc:end -->

### 34.3 `system.ping`

往返一次，答页面给的 `ts` 与 core 的时钟。

<!-- rpc:begin contract=§34.3 -->

| procedure     | kind | input            | output                             | errors                         | scope           | 自  | 原路径 |
| ------------- | ---- | ---------------- | ---------------------------------- | ------------------------------ | --------------- | --- | ------ |
| `system.ping` | call | `{ ts: number }` | `{ ts: number, serverTs: number }` | `unauthenticated`、`forbidden` | `identity:read` | 1.3 | —      |

<!-- rpc:end -->

### 34.4 `workspaces.*`

工作空间的列出、新建、打开目录、打开远端、改名改色改授权、删除与打开。多部分上传的导入（`POST /api/workspaces/import`）与执行主机改绑（`PATCH /api/workspaces/{workspaceId}/execution-host`，409 带结构化拒绝）留在 REST。本地工作空间不带 `executionHostId`。

<!-- rpc:begin contract=§34.4 -->

| procedure                  | kind     | input                                                                                                                                                      | output                                                                                                                                                                                                                                                                                | errors                                              | scope             | 自  | 原路径                                    |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------- | --- | ----------------------------------------- |
| `workspaces.list`          | query    | 可省 `{}`                                                                                                                                                  | `{ id: string, name: string, rootPath: string, color: string, permissions: { read: boolean, write: boolean, execute: boolean }, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string, boards: { id: string, name: string, nodeCount: integer }[] }[]` | `unauthenticated`、`forbidden`                      | `canvas:read`     | 1.3 | `GET /api/workspaces`                     |
| `workspaces.create`        | mutation | `{ name: string, rootPath: string, color?: string, permissions?: { read: boolean, write: boolean, execute: boolean } \| null, createDirectory?: boolean }` | `{ id: string, name: string, rootPath: string, color: string, permissions: { read: boolean, write: boolean, execute: boolean }, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string }`                                                               | `bad_request`、`forbidden`、`not_found`、`conflict` | `canvas:write`    | 1.3 | `POST /api/workspaces`                    |
| `workspaces.openDirectory` | mutation | `{ name: string, rootPath: string, color?: string, permissions?: { read: boolean, write: boolean, execute: boolean } \| null }`                            | `{ id: string, name: string, rootPath: string, color: string, permissions: { read: boolean, write: boolean, execute: boolean }, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string }`                                                               | `bad_request`、`forbidden`、`not_found`             | `workspace:share` | 1.3 | `POST /api/workspaces/open-directory`     |
| `workspaces.openRemote`    | mutation | `{ name: string, executionHostId?: string, rootPath: string, permissions?: { read: boolean, write: boolean, execute: boolean } \| null }`                  | `{ id: string, name: string, rootPath: string, color: string, permissions: { read: boolean, write: boolean, execute: boolean }, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string }`                                                               | `bad_request`、`forbidden`、`not_found`、`conflict` | `workspace:share` | 1.3 | `POST /api/workspaces/remote`             |
| `workspaces.update`        | mutation | `{ workspaceId: string, name?: string, color?: string, permissions?: { read: boolean, write: boolean, execute: boolean } \| null }`                        | `{ id: string, name: string, rootPath: string, color: string, permissions: { read: boolean, write: boolean, execute: boolean }, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string }`                                                               | `bad_request`、`forbidden`、`not_found`             | `workspace:share` | 1.3 | `PATCH /api/workspaces/{workspaceId}`     |
| `workspaces.delete`        | mutation | `{ workspaceId: string }`                                                                                                                                  | 无                                                                                                                                                                                                                                                                                    | `forbidden`、`not_found`                            | `workspace:share` | 1.3 | `DELETE /api/workspaces/{workspaceId}`    |
| `workspaces.open`          | mutation | `{ workspaceId: string }`                                                                                                                                  | `{ id: string, name: string, rootPath: string, color: string, permissions: { read: boolean, write: boolean, execute: boolean }, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string }`                                                               | `forbidden`、`not_found`                            | `canvas:read`     | 1.3 | `POST /api/workspaces/{workspaceId}/open` |

<!-- rpc:end -->

### 34.5 `settings.*`

设置文档的读、按段合并与本机键清单。文档是「已知键归一 + 未知键透传」的任意 JSON；终端后端与日志保留天数两个封闭选项被拒时答 `bad_request`。

<!-- rpc:begin contract=§34.5 -->

| procedure         | kind     | input                  | output                              | errors                         | scope            | 自  | 原路径                    |
| ----------------- | -------- | ---------------------- | ----------------------------------- | ------------------------------ | ---------------- | --- | ------------------------- |
| `settings.get`    | query    | 可省 `{}`              | `Record<string, JSON>`              | `unauthenticated`、`forbidden` | `settings:read`  | 1.3 | `GET /api/settings`       |
| `settings.update` | mutation | `Record<string, JSON>` | `Record<string, JSON>`              | `bad_request`、`forbidden`     | `settings:write` | 1.3 | `PATCH /api/settings`     |
| `settings.local`  | query    | 可省 `{}`              | `{ paths: string[], file: string }` | `unauthenticated`、`forbidden` | `settings:read`  | 1.3 | `GET /api/settings/local` |

<!-- rpc:end -->

## 35. 控制面 WebSocket：`/api/ws`

> 状态：实施契约（E2，工程规范化 §3）。一个源一条控制面连接，调用与订阅多路复用在上面；终端、实时协同、语言会话、浏览器画面仍是各自的数据面连接（§3.4、§16、§26 等）。订阅的形状表同 §34 由 `tools/contract/generate.mjs` 生成。

### 35.1 升级层与子协议

- **升级**：`GET /api/ws`，`Sec-WebSocket-Protocol` 报 `armadra-rpc.v1`；Bearer 来源（桌面壳页面、原生 App）同时报一次性票 `armadra-ticket.<票>`（§3.2，`POST /api/identity/ws-ticket` 换来，每次重连都换），Cookie 来源（服务器壳托管的页面）不报票。服务端回选 `armadra-rpc.v1`，票不被回选。准入（票、Cookie、来源）在升级前判，失败答 HTTP 状态（`401` / `403`），不建 socket；路由门要 `identity:read`（登录即可，成员也有）。没报 `armadra-rpc.v1` 的升级照样完成，随即以 `4409` 关。
- **帧**：只有上游 RPC 的 peer 文本帧，每次调用一个 `i`，请求、响应、订阅的事件与结束都带它：请求 `{ i, p: { u: "/<域>/<动词>", b: { json: 入参 }, h? } }`；响应 `{ i, p: { s?, h?, b: { json } } }`；订阅的响应头 `content-type: text/event-stream`，之后每项 `{ i, t: 3, p: { e: "message" | "error" | "done", d: { json }, m?: { id } } }`；客户端取消 `{ i, t: 4 }`。本仓库不往这条连接上塞别的帧。帧上限是 `system.hello` 的 `maxFrameBytes`。
- **身份**：升级时认好的那个人。每一帧调用前按会话复核一次（页面刷新过访问令牌照旧；会话没了以 `4403` 关）；每条 procedure 再按自己的 `scope` / `workspaceKey` 走路由门，拒绝是这次调用的 `forbidden`，连接不断。
- **错误**：调用失败是上游的错误形状 `{ defined, code, status, message, data? }`（订阅中途失败是一项 `e: "error"`），`code` 与 `status` 按错误码注册表、与 §34.1 同一套码，`data` 即 §34.1 的 `details`；内部错误的原话不外泄。
- **订阅只经控制面**：契约里写了背压策略的 procedure 是订阅；经 `POST /api/rpc/…` 调答 `405 method_not_allowed`。
- **版本**：协议 `minor` 自 4 起有本节（`GET /api/identity/hello` 与 `system.hello` 的 `protocol` 为 `1.4`）。

### 35.2 关闭码

| 码     | 含义                                     | 客户端                                     |
| ------ | ---------------------------------------- | ------------------------------------------ |
| `1000` | 正常关闭                                 | —                                          |
| `1001` | core 停机（中继重启同样表现为它）        | 按退避重连，订阅带 `lastEventId` 续订      |
| `4400` | 坏帧（二进制帧、不是 peer 消息的文本帧） | 按退避重连                                 |
| `4401` | 访问令牌到期                             | 续凭据后换票立即重连一次，不退避           |
| `4403` | 授权收回（会话失效、撤销设备、停用账号） | 停，页面按授权收回处理                     |
| `4409` | 子协议缺失或版本不兼容                   | 停，提示更新应用                           |
| `4413` | 帧超过 `maxFrameBytes`                   | 按退避重连                                 |
| `4429` | 一条连接上的订阅超过 256 个              | 停，提示；超出的那次调用答 `limit_reached` |

页面文案在 `apps/web/src/i18n/connection.ts`（中英）。

### 35.3 心跳与重连

- 服务端每 `heartbeatMs`（25 秒，`system.hello` 报）发 `ws` 层 ping，连续两次没有 pong 就断开（§3.4 的五条流同一套）。
- 客户端在页面可见时每 30 秒调一次 `system.ping`，3 秒没回音视为断线、立刻重连；回到前台立刻探一次，没连着就跳过退避直接连；`online` 同理。
- 重连退避 `min(cap, 500 ms × 2^n)` 全抖动，前台封顶 10 秒、后台 30 秒，连上过就归零。重连由页面自己做（要换票），不用上游内建的重连；订阅的续订由上游客户端带 `lastEventId` 重订。

### 35.4 `workspaces.events`

工作空间事件流（§5.4）的控制面形式；旧路由 `WS /api/workspaces/{workspaceId}/events` 保留到 E4。

- 每项是一个工作空间事件，事件 `id` 是 outbox 序号（单调；不进 outbox 的 `canvas.presence` 不带 `id`）。
- 起点：重订时上游交回的 `lastEventId` 优先，其次入参 `cursor`（与旧 `?cursor=` 同义），都没有是 `now`（不补历史）。有位置时先补发这个位置之后、订阅那一刻水位之前的这块工作空间的事件，再接实时，中间不漏不重。
- 每次（重新）订上、补发完之后先发一项位置帧 `{ type: "cursor", cursor, floor, watermark }`，`id` 是这时的位置：还没收到任何事件就断开的订阅也有可续的 `lastEventId`；页面把它当作「订上了」。它不是工作空间事件。
- 拒绝在订阅开始之前：工作空间不存在 `not_found`；位置掉出保留下限 `snapshot_required`；位置比这台 core 的水位还新（换了库）`cursor_ahead`——后两者都要先整份重读，再从 `now` 订。授权收回时订阅以 `forbidden` 结束。

<!-- rpc:begin contract=§35.4 -->

| procedure           | kind         | input                                                | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | errors                                                                                     | scope         | 自  | 原路径 |
| ------------------- | ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- | --- | ------ |
| `workspaces.events` | subscription | `{ workspaceId: string, cursor?: "now" \| integer }` | 迭代：`agent.context`、`agent.status`、`agent.subagent`、`agent.approval`、`agent.delivery`、`acp.update`、`acp.turn`、`acp.driver`、`terminal.exit`、`terminal.lease`、`terminal.hibernation`、`board.changed`、`canvas.presence`、`board.comment`、`node.created`、`ssh.prompt`、`workspace.updated`、`control.confirm`、`resource.sample`、`browser.session`、`browser.download`、`browser.lease`、`browser.tabs`、`browser.dialog`、`browser.fileChooser`、`browser.activity`、`language.session`、`language.server`、`file.changed`、`workflow.draft`、`workflow.run`、`workflow.gate`、`schedule.fired`、`schedule.failed`、`schedule.attention`、`cloud.tunnel`、`resources.threshold`、`cursor` | `forbidden`、`not_found`、`snapshot_required`、`cursor_ahead`、`overflow`、`limit_reached` | `events:read` | 1.4 | —      |

<!-- rpc:end -->

### 35.5 背压

- 每个订阅在 core 里有一个有界队列（1024 项），连接的发送缓冲超过 1 MiB 时排队，按契约里的 `backpressure`：`drop-oldest` 丢最旧；`coalesce` 同一个键只留最新；`resubscribe` 停止从实现里取（补发因此停在原处），实时的一段攒在实现自己的有界缓冲里，满了就把已攒的发完、以 `overflow` 结束订阅，客户端带 `lastEventId` 重订，缺口由 outbox 补发。
- `workspaces.events` 是 `resubscribe`。
- 数据面不在这条连接上：终端照旧 64 KiB 合帧，发送缓冲超过 4 MiB 时暂停读 PTY（§3.4）。

### 35.6 数据面例外：语言会话

工程规范化 E3-9 评估后定为**不并入**控制面：语言会话仍走自己的 WebSocket，与终端、实时协同、浏览器画面同属数据面（§3.4）。依据是 `tools/probes/language-load.mjs` 的实测（数据与理由见[补全进度](../status/completion-progress.md) E3-9 一节）。

- **连接**：`GET /api/workspaces/{workspaceId}/language/sessions/{sessionId}/stream`，先 `POST …/language/sessions` 开会话再升级；一条连接一个会话，连接的生命周期就是会话的生命周期（断开即关会话，重连要重开会话，不续订）。准入、票、Cookie、4401 / 4403 复核与 25 秒心跳是 §3.4 给每条流的那一套，不报 `armadra-rpc.v1` 子协议。
- **帧**：一条文本帧是一条 JSON-RPC 2.0 消息，双向；core 只改写 URI、按权限拦方法、给请求编号，不解析也不记录正文。二进制帧丢弃。客户端发来的单帧上限 4 MiB，单条 JSON-RPC 消息超过 960 KiB 由会话以 JSON-RPC 错误回答。
- **升级前的拒绝**：工作空间读不到 `403` / `404`；会话不存在 `404`；会话已经接过连接 `409`。
- **关闭码**：`1008` 这个会话已经有一条连接；`1011` 会话不存在；`1013` 对端不读、发送队列满（§3.4 的 `pause` 策略：发送缓冲过 2 MiB 暂停读语言服务器的 stdout，队列上限 256 帧）；其余同 §35.2 的通用部分（`1001` 停机、`4401`、`4403`）。
- **经中继**：每个会话一条隧道流，用自己的流信用，不与控制面那条流共用。
- **为什么不并入**：语言会话是双向、不能丢也不能重放的流，控制面的三种背压（丢旧、合并、重订）对它都不成立，只能暂停语言服务器——而暂停按服务器算、同一服务器的会话一起等，控制面的发送缓冲又是整条连接的，合并后两边会互相拖住；补全答案单帧可达数百 KiB，同一条连接上排在它后面的事件要等它整帧送完。
- **什么时候重新评估**：上游 RPC 的 peer 帧支持按调用的流控（暂停单个迭代器而不是整条连接），或语言流改成可重放（带序号、能续订）时。

## 36. 画布：`boards.*`

> 状态：实施契约（E3-1，工程规范化包 §3）。画布列表、文档的读与存、在线设备与编辑租约、实时状态迁到契约上；形状表由 `tools/contract/generate.mjs` 生成。旧路径（表里「原路径」列）与 `POST /api/rpc/boards/<动词>` 由同一份实现回答，失败的码与原话一致（旧路径 `{ code, message }`，procedure 多一个 `requestId`）；只有入参形状不对时，契约的 schema 先于域拒绝，码与状态相同，原话是字段路径。旧路径在下一个 minor 删除（E4）。协议 `minor` 自 7 起有本节。

留在 REST / 数据面的：实时协同的同步流 `WS …/boards/{boardId}/sync`（§16.1，Yjs 连接不动）、评论 `…/comments`（§16.3）、节点的上下文连线 `PUT …/context-links/{nodeId}`、整板导出与资源上传。

### 36.1 列表与板记录

`list`、`create`、`update`、`delete`。名字去空白后 1–120 个字符；`sortOrder` 为 `null` 与缺席同义；工作空间里最后一块板删不掉（`409 conflict`）。

<!-- rpc:begin contract=§36.1 -->

| procedure       | kind     | input                                                                                 | output                                                                                                                                                                                | errors                                      | scope          | 自  | 原路径                                                  |
| --------------- | -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------- | --- | ------------------------------------------------------- |
| `boards.list`   | query    | `{ workspaceId: string }`                                                             | `{ id: string, workspaceId: string, name: string, sortOrder: integer, viewport: { x: number, y: number, zoom: number }, whiteboard: string, createdAt: string, updatedAt: string }[]` | `unauthenticated`、`forbidden`、`not_found` | `canvas:read`  | 1.7 | `GET /api/workspaces/{workspaceId}/boards`              |
| `boards.create` | mutation | `{ workspaceId: string, name: string }`                                               | `{ id: string, workspaceId: string, name: string, sortOrder: integer, viewport: { x: number, y: number, zoom: number }, whiteboard: string, createdAt: string, updatedAt: string }`   | `bad_request`、`forbidden`、`not_found`     | `canvas:write` | 1.7 | `POST /api/workspaces/{workspaceId}/boards`             |
| `boards.update` | mutation | `{ workspaceId: string, boardId: string, name?: string, sortOrder?: number \| null }` | `{ id: string, workspaceId: string, name: string, sortOrder: integer, viewport: { x: number, y: number, zoom: number }, whiteboard: string, createdAt: string, updatedAt: string }`   | `bad_request`、`forbidden`、`not_found`     | `canvas:write` | 1.7 | `PATCH /api/workspaces/{workspaceId}/boards/{boardId}`  |
| `boards.delete` | mutation | `{ workspaceId: string, boardId: string }`                                            | 无                                                                                                                                                                                    | `forbidden`、`not_found`、`conflict`        | `canvas:write` | 1.7 | `DELETE /api/workspaces/{workspaceId}/boards/{boardId}` |

<!-- rpc:end -->

### 36.2 文档的读与存

形状见 §3.1 的文档与 §6.1 的白板快照。`save` 的入参是「已知字段 + 透传」：节点、连线、视口的语义检查（节点类型与数据种类一致、连线两端存在、白板快照大小）仍在域里，已退役的 `kanban` 字段走到域里被拒（`400 bad_request`）。顺序：租约（§9.3，别人持有答 `423 canvas_lease_held`）先于 CAS（`expectedUpdatedAt` 旧了答 `409 conflict`）；实时板上带 `clientId` 的保存答 `409 realtime_active`（§16.2）。

<!-- rpc:begin contract=§36.2 -->

| procedure     | kind     | input                                                                                                                                                                                                                       | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | errors                                                                                      | scope          | 自  | 原路径                                                        |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- | --- | ------------------------------------------------------------- |
| `boards.load` | query    | `{ workspaceId: string, boardId: string }`                                                                                                                                                                                  | `{ board: { id: string, workspaceId: string, name: string, sortOrder: integer, viewport: {…}, whiteboard: string, createdAt: string, updatedAt: string }, nodes: { id: string, boardId: string, type: string, title: string, color: string, position: {…}, size?: {…}, collapsed?: boolean, expandedHeight?: number, parentId?: string, labels: string[], note: string, data: JSON, createdAt: string, updatedAt: string }[], edges: { id: string, boardId: string, source: string, target: string, kind: string, role?: string, createdAt: string, updatedAt: string }[] }` | `forbidden`、`not_found`                                                                    | `canvas:read`  | 1.7 | `GET /api/workspaces/{workspaceId}/boards/{boardId}/document` |
| `boards.save` | mutation | `{ workspaceId: string, boardId: string, expectedUpdatedAt: string, nodes: Record<string, JSON>[], edges: Record<string, JSON>[], viewport: Record<string, JSON>, whiteboard?: string \| null, clientId?: string \| null }` | `{ board: { id: string, workspaceId: string, name: string, sortOrder: integer, viewport: {…}, whiteboard: string, createdAt: string, updatedAt: string }, nodes: { id: string, boardId: string, type: string, title: string, color: string, position: {…}, size?: {…}, collapsed?: boolean, expandedHeight?: number, parentId?: string, labels: string[], note: string, data: JSON, createdAt: string, updatedAt: string }[], edges: { id: string, boardId: string, source: string, target: string, kind: string, role?: string, createdAt: string, updatedAt: string }[] }` | `bad_request`、`forbidden`、`not_found`、`conflict`、`canvas_lease_held`、`realtime_active` | `canvas:write` | 1.7 | `PUT /api/workspaces/{workspaceId}/boards/{boardId}/document` |

<!-- rpc:end -->

### 36.3 实时状态

`realtime` 答这块板走不走实时协同（§16.2）；页面据此选 `…/sync` 还是租约 + CAS。这个域没装时答 `501 not_implemented`。

<!-- rpc:begin contract=§36.3 -->

| procedure         | kind  | input                                      | output                                                               | errors                                      | scope         | 自  | 原路径                                                        |
| ----------------- | ----- | ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------- | ------------- | --- | ------------------------------------------------------------- |
| `boards.realtime` | query | `{ workspaceId: string, boardId: string }` | `{ realtime: boolean, materializedSeq: integer, enabled?: boolean }` | `forbidden`、`not_found`、`not_implemented` | `canvas:read` | 1.7 | `GET /api/workspaces/{workspaceId}/boards/{boardId}/realtime` |

<!-- rpc:end -->

### 36.4 在线设备、租约与 `boards.presence`

在线表与租约的规则同 §9，只换了线：

- `heartbeat`、`leave`、`acquireLease` 是 §9.1–§9.2 的 procedure 形式，回答的快照形状同 §9.4（`writable` 与 `deviceKey` 因人而异，只在回答里）。
- **`boards.presence` 是订阅**，只经控制面 `/api/ws`（§35）：订上就是登记（同一次心跳），连接着的时候 core 每 10 秒替页面续期（续期不带 `active`，所以开着没人动的窗口不会一直占着租约；「刚被操作过」仍由页面经 `heartbeat` 报），订阅结束（取消、断线）就是离开，不必等 30 秒的心跳过期；同一个 `clientId` 开着多条订阅时，最后一条走了才算离开。
- 每一项是**这个客户端看到的**在线表：先发订上时的那份，之后这块板的在线表或租约变了（有人来、有人走、租约换手、授权变化的复判）就发一项；只有 `lastSeenAt` 变了的续期不发。`writable` 与 `deviceKey` 因人而异，所以订阅的每一项都带（`canvas.presence` 事件里没有）。
- 背压 `drop-oldest`：每一项是整份快照，丢旧的留新的。订阅断了由页面按退避重订，重订就是一次新的登记。
- 订阅开始之前判先决条件（没有这块板 `not_found`、`clientId` 不合字符集 `bad_request`），拒绝是这次调用的错误。授权被收回（撤销共享、停用账号）时订阅以 `forbidden` 结束，也不会再替一个被收权的人续期。

<!-- rpc:begin contract=§36.4 -->

| procedure             | kind         | input                                                                                                 | output                                                                                                                                                                                                                                                         | errors                                                               | scope          | 自  | 原路径                                                                      |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------- | --- | --------------------------------------------------------------------------- |
| `boards.heartbeat`    | mutation     | `{ workspaceId: string, boardId: string, clientId: string, deviceName?: string, active?: boolean }`   | `{ boardId: string, clients: { clientId: string, deviceName: string, deviceKey: string, lastSeenAt: string }[], lease: { clientId: string, deviceName: string, deviceKey: string, acquiredAt: string } \| null, writable?: boolean, deviceKey?: string }`      | `bad_request`、`forbidden`、`not_found`                              | `canvas:read`  | 1.7 | `POST /api/workspaces/{workspaceId}/boards/{boardId}/presence`              |
| `boards.leave`        | mutation     | `{ workspaceId: string, boardId: string, clientId: string }`                                          | `{ boardId: string, clients: { clientId: string, deviceName: string, deviceKey: string, lastSeenAt: string }[], lease: { clientId: string, deviceName: string, deviceKey: string, acquiredAt: string } \| null, writable?: boolean, deviceKey?: string }`      | `bad_request`、`forbidden`、`not_found`                              | `canvas:read`  | 1.7 | `DELETE /api/workspaces/{workspaceId}/boards/{boardId}/presence/{clientId}` |
| `boards.acquireLease` | mutation     | `{ workspaceId: string, boardId: string, clientId: string, deviceName?: string, takeover?: boolean }` | `{ boardId: string, clients: { clientId: string, deviceName: string, deviceKey: string, lastSeenAt: string }[], lease: { clientId: string, deviceName: string, deviceKey: string, acquiredAt: string } \| null, writable?: boolean, deviceKey?: string }`      | `bad_request`、`forbidden`、`not_found`、`canvas_lease_held`         | `canvas:write` | 1.7 | `POST /api/workspaces/{workspaceId}/boards/{boardId}/lease`                 |
| `boards.presence`     | subscription | `{ workspaceId: string, boardId: string, clientId: string, deviceName?: string }`                     | 迭代 `{ boardId: string, clients: { clientId: string, deviceName: string, deviceKey: string, lastSeenAt: string }[], lease: { clientId: string, deviceName: string, deviceKey: string, acquiredAt: string } \| null, writable?: boolean, deviceKey?: string }` | `bad_request`、`forbidden`、`not_found`、`overflow`、`limit_reached` | `canvas:read`  | 1.7 | —                                                                           |

<!-- rpc:end -->

## 37. `files`：工作空间文件的 JSON 面

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-2）。实现在 `core/files/routes.ts`（浏览、读写、条目、回收站、索引、搜索、监听、版本）、`core/files/reveal.ts`（在文件管理器里显示）与 `core/imports/routes.ts`（按本机路径导入）；契约在 `packages/shared/src/contract/files.ts`。旧 REST 路径与 procedure 调同一份操作实现，拒绝的码、状态与原话相同；失败的形状与 §34.1 一致。协议 `minor` 自 5 起有本节。

### 37.1 procedure

所有 procedure 都带 `workspaceId`，授权绑在那块工作空间上。旧路径是查询串的（`GET`），入参里 `path` 缺省或为空串都是工作空间根（`.`）；`index` 的 `limit` 经旧路径以字符串到达，按非负整数核对，过 RPC 是数字，核对一样。出参复用页面解析用的 schema（`packages/shared/src/api/files.ts`、`search.ts`）。

- 权限与旧路由表一致：读是 `files:read`，其余（包括搜索与监听的 `POST`）是 `files:write`；`reveal` 拉起外部程序，与开终端同一档 `terminal:create`。
- 入参只校形状，不带长度与范围约束：路径是否越界、能不能写、内容 SHA 对不对由域判断，旧路径与 procedure 的拒绝因此一样。
- `write`：已有文件必须带读到的 `expectedSha256`，缺省只许新建；只带旧版 `expectedSize` 而不带 SHA 答 `bad_request`；SHA 对不上答 `conflict`。
- `search`：调用方断开连接，core 就停下还在跑的扫描，答 `499 cancelled`（没人读得到，所以注册表不登记这个码）。
- `watch` / `unwatch`：`watch` 在没有读权限的工作空间上答 `forbidden` 并释放这块工作空间的全部监听；`unwatch` 对没登记过的是空操作。`unwatch` 没有旧路径条目：旧的 `DELETE …/file-watch?path=&nodeId=` 带查询串，而契约层的 `DELETE` 只读体，所以这条旧路径继续由路由表的原 handler 答 `204`，权限仍是 `files:write`。
- `reveal` 只对本机工作空间有意义：远端工作空间答 `501 unsupported`；拉不起系统打开器答 `500 reveal_failed`。
- 文件正文只在 `read` 与 `write` 的出入参里过：不进日志（门面只记 procedure 名、耗时与错误消息）、不进事件、不进任何持久化。

<!-- rpc:begin contract=§37.1 -->

| procedure           | kind     | input                                                                                                                                                                                                                                                                    | output                                                                                                                                                                                                             | errors                                                 | scope             | 自  | 原路径                                                    |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------- | --- | --------------------------------------------------------- |
| `files.list`        | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                 | `{ path: string, entries: ({ name: string, path: string, kind: "file" \| "directory", size: integer, readonly: boolean })[], truncated: boolean }`                                                                 | `bad_request`、`forbidden`、`not_found`                | `files:read`      | 1.5 | `GET /api/workspaces/{workspaceId}/files`                 |
| `files.info`        | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                 | `{ path: string, name: string, size: integer, mimeType: string, preview: "text" \| "image" \| "video" \| "audio" \| "pdf" \| "download" }`                                                                         | `bad_request`、`forbidden`、`not_found`                | `files:read`      | 1.5 | `GET /api/workspaces/{workspaceId}/file-info`             |
| `files.read`        | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                 | `{ path: string, mimeType: string, content: string, size: integer, sha256?: string, encoding?: "utf-8" \| "unknown", bom?: boolean, eol?: "lf" \| "crlf" \| "mixed" \| "none", readonly?: boolean }`               | `bad_request`、`forbidden`、`not_found`                | `files:read`      | 1.5 | `GET /api/workspaces/{workspaceId}/file`                  |
| `files.write`       | mutation | `{ workspaceId: string, path: string, content: string, expectedSize?: number \| null, expectedSha256?: string \| null, bom?: boolean }`                                                                                                                                  | `{ path: string, size: integer, sha256: string }`                                                                                                                                                                  | `bad_request`、`forbidden`、`not_found`、`conflict`    | `files:write`     | 1.5 | `PUT /api/workspaces/{workspaceId}/file`                  |
| `files.create`      | mutation | `{ workspaceId: string, path: string, kind: "file" \| "directory" }`                                                                                                                                                                                                     | `{ path: string, kind: "file" \| "directory" }`                                                                                                                                                                    | `bad_request`、`forbidden`、`not_found`、`conflict`    | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/file-entries`         |
| `files.rename`      | mutation | `{ workspaceId: string, from: string, to: string }`                                                                                                                                                                                                                      | `{ path: string, kind: "file" \| "directory" }`                                                                                                                                                                    | `bad_request`、`forbidden`、`not_found`、`conflict`    | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/file-entries/rename`  |
| `files.trash`       | mutation | `{ workspaceId: string, path: string }`                                                                                                                                                                                                                                  | `{ id: string, originalPath: string, name: string, kind: "file" \| "directory", deletedAt: string }`                                                                                                               | `bad_request`、`forbidden`、`not_found`                | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/file-entries/trash`   |
| `files.trashList`   | query    | `{ workspaceId: string }`                                                                                                                                                                                                                                                | `({ id: string, originalPath: string, name: string, kind: "file" \| "directory", deletedAt: string })[]`                                                                                                           | `forbidden`、`not_found`                               | `files:read`      | 1.5 | `GET /api/workspaces/{workspaceId}/file-entries/trash`    |
| `files.restore`     | mutation | `{ workspaceId: string, id: string }`                                                                                                                                                                                                                                    | `{ path: string, kind: "file" \| "directory" }`                                                                                                                                                                    | `bad_request`、`forbidden`、`not_found`、`conflict`    | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/file-entries/restore` |
| `files.index`       | query    | `{ workspaceId: string, query?: string, limit?: number }`                                                                                                                                                                                                                | `{ entries: { path: string, name: string, size: integer }[], truncated: boolean, scanned: integer }`                                                                                                               | `bad_request`、`forbidden`、`not_found`                | `files:read`      | 1.5 | `GET /api/workspaces/{workspaceId}/file-index`            |
| `files.search`      | mutation | `{ workspaceId: string, query: string, regex?: boolean \| null, caseSensitive?: boolean \| null, wholeWord?: boolean \| null, include?: string \| null, exclude?: string \| null, maxMatchesPerFile?: number \| null, limit?: number \| null, offset?: number \| null }` | `{ files: { path: string, matches: {…}[], truncated: boolean }[], totalMatches: integer, truncated: boolean, timedOut: boolean, skipped: integer, scanned: integer, nextOffset?: integer \| null }`                | `bad_request`、`forbidden`、`not_found`                | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/file-search`          |
| `files.watch`       | mutation | `{ workspaceId: string, path: string, nodeId: string }`                                                                                                                                                                                                                  | `{ status: "watching" \| "unsupported", reason?: string \| null, mode?: "events" \| "poll", version: { path: string, exists: boolean, sha256?: string \| null, size?: integer \| null, mtime?: string \| null } }` | `bad_request`、`forbidden`、`not_found`                | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/file-watch`           |
| `files.unwatch`     | call     | `{ workspaceId: string, path?: string, nodeId?: string }`                                                                                                                                                                                                                | 无                                                                                                                                                                                                                 | `forbidden`、`not_found`                               | `files:write`     | 1.5 | —                                                         |
| `files.version`     | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                 | `{ path: string, exists: boolean, sha256?: string \| null, size?: integer \| null, mtime?: string \| null }`                                                                                                       | `bad_request`、`forbidden`、`not_found`                | `files:read`      | 1.5 | `GET /api/workspaces/{workspaceId}/file-version`          |
| `files.reveal`      | mutation | `{ workspaceId: string, path: string }`                                                                                                                                                                                                                                  | `{ ok: boolean }`                                                                                                                                                                                                  | `bad_request`、`forbidden`、`not_found`、`unsupported` | `terminal:create` | 1.5 | `POST /api/workspaces/{workspaceId}/reveal`               |
| `files.importLocal` | mutation | `{ workspaceId: string, paths: string[] }`                                                                                                                                                                                                                               | `{ path: string, files: ({ path: string, name: string, size: integer, mimeType: string, preview: "text" \| "image" \| "video" \| "audio" \| "pdf" \| "download" })[] }`                                            | `bad_request`、`forbidden`、`not_found`、`conflict`    | `files:write`     | 1.5 | `POST /api/workspaces/{workspaceId}/imports/local`        |

<!-- rpc:end -->

### 37.2 留在 REST 的字节流

下面这些不是 JSON，不经 `/api/rpc/`，也不会迁：

| 路径                                          | 方法   | 为什么留着                                                                                                 |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `/api/workspaces/{workspaceId}/imports`       | POST   | 多部分上传，最多 256 个文件、64 MiB；体是字节流，请求体上限单独设（`MAX_IMPORT_BODY_BYTES`）               |
| `/api/workspaces/{workspaceId}/file-download` | GET    | 答 `application/octet-stream` 附件（`attachment`、`nosniff`），远端文件分块取回；页面只拿它的 URL 当链接用 |
| `/api/workspaces/{workspaceId}/file-watch`    | DELETE | 见 §37.1 的 `unwatch`：旧路径带查询串，契约层的 `DELETE` 不读查询串；procedure 是 `files.unwatch`          |
| `/api/workspaces/import`                      | POST   | 多部分上传整个工作空间，属于 `workspaces` 域（§34.4）                                                      |

`Range`、`<img src>`、`<a href download>` 这类由浏览器直接取字节的用法只能走上面的 `GET` 路由：RPC 的 `POST` + JSON 编码既带不了 `Range`，也不是 `src` 能指的地址。下载的 URL 由页面按当前源拼出（`api/files.ts` 的 `fileDownloadUrl`），凭据照旧由 Cookie 或页面代取。

## 38. `terminals`：终端会话的 HTTP 面

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-3）。实现在 `core/terminal/install.ts`：一份 `operations`，路由表里的旧 handler 与 procedure 都调它，拒绝的码与原话因此一样；每次回答都等启动对账（`ready`）完成。终端的错误（`TerminalError`）是 `CoreFailure` 的子类，procedure 抛出来的就是它。

### 38.1 procedure

- 权限与旧路由表一致：开会话（`create`）是 `terminal:create`，读（`backend`、`get`、`capture`、`sessions`）是 `terminal:read`，往已有会话里动手（`paste`、`scroll`、`terminate`、`recycle`、`wake`、`drive`）是 `terminal:write`。向别人开的会话里写还要 `terminal:drive`，那一条在终端输入路径上判（§23），不在路由上。`create` 与 `sessions` 带 `workspaceId`，授权绑在那块工作空间上。
- 出参复用页面已有的 schema，并补上 core 一直在答的字段：会话行的 `kind` 与 `ownerNodeId`，`backend` 的 `platform`（`unix` 或 `windows`）。
- 入参只校形状，不带长度与范围约束：节点 id 是否合法、粘贴是否过大（20 万字符）、滚动距离是否过大（1 万行）、`cwd` 与工作空间的关系由域判断，旧路径与 procedure 的拒绝因此一样。只有**形状**错（缺字段、类型不对、`action` 不是 `takeover` / `release`）由契约的入参校验先答 `bad_request`（带 `details.issues`），旧路径上同样如此，与迁移前那句原话不同。
- `capture`：`lines` 缺省 200、上限 10000，不是非负整数按缺省；`escapes` 为真保留 SGR（给快照），否则是给 Agent 读的纯文本。旧路径是查询串，`lines` 以字符串到达、`escapes` 以 `"true"` / `"false"` 到达。
- `paste`：算人在驱动，与键盘上来的字节同一条语义；答会话行。
- `scroll`：旧路径答 `204`；procedure 的成功恒为 `200`、无体。
- `terminate`：`mode` 缺省 `process`；已经结束的会话不是错误，答它现在的样子。
- `wake`：不属于任何节点的会话答 `409 not_hibernated`；唤醒失败答 `wake_failed`。这两个码只有终端域会答，注册表里没有，界面按原话显示。
- `drive`：租约的变化另由广播的 `terminal.lease` 事件到达每台设备，徽标读事件，不读这里的出参。
- 终端的原始输出只在 `capture` 的出参里过；粘贴的文字只在入参里过。两者都不进日志（门面只记 procedure 名、耗时与错误消息）、不进事件、不进任何持久化。

<!-- rpc:begin contract=§38.1 -->

| procedure             | kind     | input                                                                                                                                                                                                                                                                 | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | errors                                              | scope             | 自  | 原路径                                       |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------- | --- | -------------------------------------------- |
| `terminals.create`    | mutation | `{ workspaceId: string, cwd: string, shell?: string, command?: string, args?: string[], nodeId?: string, agent?: { id: string, accountId?: string, permissionMode?: string, model?: string, sessionId?: string, credentialRef?: string }, ssh?: { hostId: string } }` | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:create` | 1.6 | `POST /api/terminals`                        |
| `terminals.backend`   | query    | 可省 `{}`                                                                                                                                                                                                                                                             | `{ effective: "direct" \| "tmux" \| "sessionHost" \| "acp", configured: "auto" \| "tmux" \| "direct" \| "sessionHost", tmuxVersion: string \| null, tmuxSocket: string \| null, reason: string \| null, platform: "unix" \| "windows" }`                                                                                                                                                                                                                                                                                                                                      | `forbidden`                                         | `terminal:read`   | 1.6 | `GET /api/terminals/backend`                 |
| `terminals.get`       | query    | `{ sessionId: string }`                                                                                                                                                                                                                                               | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `forbidden`、`not_found`                            | `terminal:read`   | 1.6 | `GET /api/terminals/{sessionId}`             |
| `terminals.capture`   | query    | `{ sessionId: string, lines?: number, escapes?: boolean \| "true" \| "false" }`                                                                                                                                                                                       | `{ generation: integer, lines: integer, data: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `forbidden`、`not_found`                            | `terminal:read`   | 1.6 | `GET /api/terminals/{sessionId}/capture`     |
| `terminals.sessions`  | query    | `{ workspaceId: string }`                                                                                                                                                                                                                                             | `({ nodeId: string, boardId: string, sessionId: string, kind: "terminal", title: string, cwd: string, agentId?: string, state?: "working" \| "waiting" \| "blocked" \| "done", stateSource?: "hook" \| "extension" \| "observed" \| "acp", unread?: boolean, pendingId?: string, updatedAt: string, alive: boolean, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp" })[]`                                                                                                                                                                                              | `forbidden`、`not_found`                            | `terminal:read`   | 1.6 | `GET /api/workspaces/{workspaceId}/sessions` |
| `terminals.paste`     | mutation | `{ sessionId: string, text: string, enter?: boolean }`                                                                                                                                                                                                                | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:write`  | 1.6 | `POST /api/terminals/{sessionId}/paste`      |
| `terminals.scroll`    | mutation | `{ sessionId: string, lines: number }`                                                                                                                                                                                                                                | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`             | `terminal:write`  | 1.6 | `POST /api/terminals/{sessionId}/scroll`     |
| `terminals.terminate` | mutation | `{ sessionId: string, mode?: "interrupt" \| "process" \| "session" }`                                                                                                                                                                                                 | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `forbidden`、`not_found`、`conflict`                | `terminal:write`  | 1.6 | `POST /api/terminals/{sessionId}/terminate`  |
| `terminals.recycle`   | mutation | `{ sessionId: string }`                                                                                                                                                                                                                                               | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `forbidden`、`not_found`、`conflict`                | `terminal:write`  | 1.6 | `POST /api/terminals/{sessionId}/recycle`    |
| `terminals.wake`      | mutation | `{ sessionId: string }`                                                                                                                                                                                                                                               | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `forbidden`、`not_found`、`conflict`                | `terminal:write`  | 1.6 | `POST /api/terminals/{sessionId}/wake`       |
| `terminals.drive`     | mutation | `{ sessionId: string, action: "takeover" \| "release" }`                                                                                                                                                                                                              | `{ state: "free" \| "human" \| "humanTakeover" \| "agent", generation: integer, expiresAt?: string, holder?: { kind: "human" \| "agent", id: string, displayName?: string } }`                                                                                                                                                                                                                                                                                                                                                                                                | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:write`  | 1.6 | `POST /api/terminals/{sessionId}/drive`      |

<!-- rpc:end -->

### 38.2 不在契约里的

- `WS /api/terminals/{sessionId}/ws`：终端的输入输出与帧（§14）。字节流与握手前的拒绝（404、409 `acp_session`、400）都不动，也不进控制面 `/api/ws`。
- `POST /api/terminals/{sessionId}/node-token/refresh`：凭据域，随 E3-8。
- `DELETE /api/terminals/{sessionId}`：路由表里没有，关终端节点是 `terminate` 加 `mode: "session"`。

## 39. `agents`：Agent 目录、人的答复、投递与上下文

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-4）。实现分在拥有这些对象的几个域里，各自用 `registerProcedures(server, "agents", …)` 登记自己那几条：`core/agent/routes.ts`（目录、节点状态、审批、关闭确认、投递、「谁读过我」）、`core/agent/ama-credentials.ts`（ama 密钥）、`core/hook/routes.ts`（集成）、`core/models/index.ts`（模型菜单）、`core/canvas/routes.ts`（连线）、`core/dependencies/index.ts`（依赖等待）。每处都是一份操作实现，路由表里的旧 handler 与 procedure 都调它，拒绝的码与原话一样。`since` 为 1.9，协议 minor 8 → 9。

通则：

- 权限与旧路由表（`core/http/route-scopes.ts`）给旧路径的一致：目录、模型、集成与 ama 密钥是本机管理（`settings:read` / `settings:write`；目录与模型菜单对至少被共享了一块画布的成员是无害的全局读）；标已读与转录是 `canvas:read`，改名建议是 `canvas:write`；投递、连线、依赖读是 `canvas:read`、写是 `canvas:write`，并带 `workspaceKey: "workspaceId"`。
- 服务器壳上，procedure 与旧路径过同一道路由门（`identity/route-access.ts`）：门面按 `meta.legacy` 把入参还原成旧路径去问，节点、审批、关闭确认按对象所在的画布判。
- 出参写线上形状：标识与时刻只校是字符串；页面 schema 是「已知字段 + 透传」的（目录行、集成状态、审批答复、节点状态），契约同样是已知字段加原样透传，出参校验不会剥掉 core 多答的字段。出参没有缺省值。
- 入参只校形状。决定的取值、elicitation、`expectedRevision`、密钥的格式、连线的条数与长度、依赖的节点归属都在域里判。**形状**错（缺字段、类型不对）由契约先答 `bad_request`（带 `details.issues`），旧路径上同样如此，与迁移前那句原话不同；码与状态不变。
- 旧路径是查询串的数字与布尔（`limit`、`maxBytes`、`all`）以字符串到达，入参两种都收，按旧的 `parseInt` / `=== "true"` 规则读。

### 39.1 目录、模型菜单、集成与 ama 密钥

- `models` 对不认识的 Agent 答 404；`integration*` 的拒绝是集成域自己的 `InstallError`（码与状态它带），其余失败是 500。
- 集成只写数据目录（画布内注入）；`repairIntegration` 动 CLI 自己的配置目录里旧产品名留下的条目，先备份再改。
- ama 的密钥只进不出：三条都答「哪家设了、存在哪个后端」。密钥后端不可用时答 503，码是后端自己的（`secret_unavailable`），原话不带后端给的理由。

<!-- rpc:begin contract=§39.1 -->

| procedure                     | kind     | input                                  | output                                                                                                                                                                                                                                                                                                                                                                                                                                 | errors                                  | scope            | 自  | 原路径                                             |
| ----------------------------- | -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------- | --- | -------------------------------------------------- |
| `agents.list`                 | query    | 可省 `{}`                              | `({ id: string, label: string, color: string, launchCmd: string, promptMode: string, capabilities?: string[], args?: string[], baseAgent?: string, resolvedPath?: string \| null, installed: boolean, launchTarget?: Record<string, JSON>, clientRevision?: number \| null, skillsRevision?: number \| null, probe?: Record<string, JSON> \| null, launcher?: string, history?: Record<string, JSON>, acp?: Record<string, JSON> })[]` | `forbidden`                             | `settings:read`  | 1.9 | `GET /api/agents`                                  |
| `agents.models`               | query    | `{ agentId: string }`                  | `{ id: string, label: string, source: string, releaseDate?: string }[]`                                                                                                                                                                                                                                                                                                                                                                | `forbidden`、`not_found`                | `settings:read`  | 1.9 | `GET /api/agents/{agentId}/models`                 |
| `agents.integration`          | query    | `{ agentId: string }`                  | `{ agentId: string, mode: string, hook: { installed: boolean, path?: string, revision?: number }, skill: { installed: boolean, path?: string, revision?: number }, legacy: { found?: {…}[] }, revision: number, installedRevision?: number, stale?: boolean, launchArgs?: string[], launchEnv?: string[], globalWrites?: string[] }`                                                                                                   | `bad_request`、`forbidden`、`not_found` | `settings:read`  | 1.9 | `GET /api/agents/{agentId}/integration`            |
| `agents.installIntegration`   | mutation | `{ agentId: string }`                  | `{ agentId: string, mode: string, hook: { installed: boolean, path?: string, revision?: number }, skill: { installed: boolean, path?: string, revision?: number }, legacy: { found?: {…}[] }, revision: number, installedRevision?: number, stale?: boolean, launchArgs?: string[], launchEnv?: string[], globalWrites?: string[] }`                                                                                                   | `bad_request`、`forbidden`、`not_found` | `settings:write` | 1.9 | `POST /api/agents/{agentId}/integration/install`   |
| `agents.uninstallIntegration` | mutation | `{ agentId: string }`                  | `{ agentId: string, mode: string, hook: { installed: boolean, path?: string, revision?: number }, skill: { installed: boolean, path?: string, revision?: number }, legacy: { found?: {…}[] }, revision: number, installedRevision?: number, stale?: boolean, launchArgs?: string[], launchEnv?: string[], globalWrites?: string[] }`                                                                                                   | `bad_request`、`forbidden`、`not_found` | `settings:write` | 1.9 | `POST /api/agents/{agentId}/integration/uninstall` |
| `agents.repairIntegration`    | mutation | `{ agentId: string }`                  | `{ agentId: string, found: { kind: string, path: string, detail: string }[], removed: string[], kept: string[], backup?: string, backups: string[] }`                                                                                                                                                                                                                                                                                  | `bad_request`、`forbidden`、`not_found` | `settings:write` | 1.9 | `POST /api/agents/{agentId}/integration/repair`    |
| `agents.amaCredentials`       | query    | 可省 `{}`                              | `{ backend: string, providers: { id: string, isSet: boolean }[] }`                                                                                                                                                                                                                                                                                                                                                                     | `forbidden`                             | `settings:read`  | 1.9 | `GET /api/agents/ama/credentials`                  |
| `agents.setAmaCredential`     | mutation | `{ provider: string, apiKey: string }` | `{ backend: string, providers: { id: string, isSet: boolean }[] }`                                                                                                                                                                                                                                                                                                                                                                     | `bad_request`、`forbidden`              | `settings:write` | 1.9 | `PUT /api/agents/ama/credentials/{provider}`       |
| `agents.clearAmaCredential`   | mutation | `{ provider: string }`                 | `{ backend: string, providers: { id: string, isSet: boolean }[] }`                                                                                                                                                                                                                                                                                                                                                                     | `bad_request`、`forbidden`              | `settings:write` | 1.9 | `DELETE /api/agents/ama/credentials/{provider}`    |

<!-- rpc:end -->

### 39.2 节点状态

- `markRead` 真的清掉了未读才广播 `agent.status`；从没报过的节点 404。
- `transcript` 没有可读转录的 CLI 答 501 `unsupported`，不答空正文；`maxBytes` 夹在 1 到上限之间，不是数按缺省。
- `suggestTitle` 不调模型：转录首条用户消息 → 终端最后一条命令 → Agent 名称。

<!-- rpc:begin contract=§39.2 -->

| procedure             | kind     | input                                             | output                                                                                          | errors                                  | scope          | 自  | 原路径                                          |
| --------------------- | -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------- | -------------- | --- | ----------------------------------------------- |
| `agents.markRead`     | mutation | `{ nodeId: string }`                              | `{ nodeId: string, workspaceId: string, agentId: string, unread?: boolean, updatedAt: string }` | `forbidden`、`not_found`                | `canvas:read`  | 1.9 | `POST /api/agent-status/{nodeId}/read`          |
| `agents.suggestTitle` | mutation | `{ nodeId: string }`                              | `{ title: string, source: "transcript" \| "terminal" \| "agent" }`                              | `forbidden`、`not_found`                | `canvas:write` | 1.9 | `POST /api/agent-status/{nodeId}/suggest-title` |
| `agents.transcript`   | query    | `{ nodeId: string, maxBytes?: number \| string }` | `{ nodeId: string, text: string, truncated: boolean }`                                          | `forbidden`、`not_found`、`unsupported` | `canvas:read`  | 1.9 | `GET /api/agent-status/{nodeId}/transcript`     |

<!-- rpc:end -->

### 39.3 人的答复：审批与关闭确认

- 两条都是人替 Agent 回答权限提示与对话框，要 `approval:answer`：审批按那条请求所在的画布判，自己终端上的 operator 就够、别人的要 driver（§23）；关闭确认只在内存里、查不到画布，成员一律 403，只有 owner 答得了。这一面只给人用，Agent 在 hook 面上没有对应的动词。
- `answerApproval` 答过的再答是 409，不认识的决定是 400；每次答复（含被拒的）都进审批审计，elicitation 的内容只交给 Agent，不进审计与日志。
- `confirmControl` 那边已经等超时了答 `accepted: false`，不是错误。

<!-- rpc:begin contract=§39.3 -->

| procedure               | kind     | input                                                                                                                                                     | output                                                                                                                                                                 | errors                                              | scope             | 自  | 原路径                                   |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------- | --- | ---------------------------------------- |
| `agents.answerApproval` | mutation | `{ pendingId: string, decision?: string, optionId?: string, answeredBy?: string, expectedRevision?: number \| null, elicitation?: Record<string, JSON> }` | `{ id: string, nodeId: string, answer: string, answeredAt: string, revision: number, route: "file" \| "keys" \| "none" \| "acp", elicitation?: Record<string, JSON> }` | `bad_request`、`forbidden`、`not_found`、`conflict` | `approval:answer` | 1.9 | `POST /api/approvals/{pendingId}/answer` |
| `agents.confirmControl` | mutation | `{ requestId: string, approve: boolean }`                                                                                                                 | `{ requestId: string, approve: boolean, accepted: boolean }`                                                                                                           | `bad_request`、`forbidden`                          | `approval:answer` | 1.9 | `POST /api/control/confirm/{requestId}`  |

<!-- rpc:end -->

### 39.4 投递、「谁读过我」与连线

- `deliveries` 是同一条旧路径的两个切片：不带 `node` 答投递记录（`limit` 缺省 200），带上它答那个目标还排着的队。两种都只有元数据（长度），不带正文；工作空间不存在答 404。
- `cancelDelivery` 已经在投的那条收不回来，答 `cancelled: false`；别的工作空间的 id 删不掉（404）。
- `contextReads` 答 `{ total, bytes, reads }`（`limit` 缺省 20、上限 200），只有元数据。
- `putContextLinks` 写一个节点的连线文档——协作上下文按连线读取的那份授权。至多 64 条；工作空间不存在 404，节点 id 不合法 400。

<!-- rpc:begin contract=§39.4 -->

| procedure                | kind     | input                                                                                                                                            | output                                                                                                                                                                                                                                                                                                                                          | errors                                  | scope          | 自  | 原路径                                                         |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------- | --- | -------------------------------------------------------------- |
| `agents.deliveries`      | query    | `{ workspaceId: string, limit?: number \| string, node?: string }`                                                                               | `({ traceId: string, workspaceId: string, sourceNodeId: string, targetNodeId: string, outcome: string, targetState?: string, receipt?: string \| null, bodyChars?: number, createdAt: string })[] \| { id: string, workspaceId: string, sourceNodeId: string, targetNodeId: string, position?: number, bodyChars?: number, reason?: string }[]` | `forbidden`、`not_found`                | `canvas:read`  | 1.9 | `GET /api/workspaces/{workspaceId}/deliveries`                 |
| `agents.cancelDelivery`  | mutation | `{ workspaceId: string, deliveryId: string }`                                                                                                    | `{ cancelled: boolean }`                                                                                                                                                                                                                                                                                                                        | `forbidden`、`not_found`                | `canvas:write` | 1.9 | `DELETE /api/workspaces/{workspaceId}/deliveries/{deliveryId}` |
| `agents.contextReads`    | query    | `{ nodeId: string, limit?: number \| string }`                                                                                                   | `{ total: number, bytes: number, reads: { id: string, readerNodeId: string, readerHandle?: string, readerTitle?: string, verb: string, bytes: number, atMs: number }[] }`                                                                                                                                                                       | `forbidden`                             | `canvas:read`  | 1.9 | `GET /api/nodes/{nodeId}/context-reads`                        |
| `agents.putContextLinks` | mutation | `{ workspaceId: string, nodeId: string, links?: ({ id: string, title: string, kind: string, role?: string, content?: {…} \| null })[] \| null }` | `{ nodeId: string, links: { id: string, title: string, kind: string, role?: string, content?: Record<string, JSON> }[], updatedAt: string }`                                                                                                                                                                                                    | `bad_request`、`forbidden`、`not_found` | `canvas:write` | 1.9 | `PUT /api/workspaces/{workspaceId}/context-links/{nodeId}`     |

<!-- rpc:end -->

### 39.5 依赖等待

- `dependencies` 答还没了结的等待，按下游分组；`all` 连已了结的一起答。
- `importLegacyDependencies` 只收旧节点数据里的 `pendingLaunch`，条件固定是 `current`；重复调用答已有的那一份。节点不在这个工作空间 404，不是 Agent 节点 400。
- `cancelDependency` 没有这条依赖 404；其余的边都已满足时，下游在这一次取消里启动。

<!-- rpc:begin contract=§39.5 -->

| procedure                         | kind     | input                                                                          | output                                                                                                                                                                                                                                                                                                                       | errors                                  | scope          | 自  | 原路径                                                             |
| --------------------------------- | -------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------- | --- | ------------------------------------------------------------------ |
| `agents.dependencies`             | query    | `{ workspaceId: string, nodeId?: string, all?: boolean \| "true" \| "false" }` | `{ launches: ({ nodeId: string, workspaceId: string, boardId: string, state: string, reason: string \| null, attempts: number, hasTask: boolean, sessionId: string \| null, createdAt: string \| null, launchedAt: string \| null, dependencies: {…}[] })[] }`                                                               | `forbidden`                             | `canvas:read`  | 1.9 | `GET /api/workspaces/{workspaceId}/dependencies`                   |
| `agents.importLegacyDependencies` | mutation | `{ workspaceId: string, nodeId: string, after: string[] }`                     | `{ launch: { nodeId: string, workspaceId: string, boardId: string, state: string, reason: string \| null, attempts: number, hasTask: boolean, sessionId: string \| null, createdAt: string \| null, launchedAt: string \| null, dependencies: {…}[] } }`                                                                     | `bad_request`、`forbidden`、`not_found` | `canvas:write` | 1.9 | `POST /api/workspaces/{workspaceId}/dependencies`                  |
| `agents.cancelDependency`         | mutation | `{ workspaceId: string, dependencyId: string }`                                | `{ dependency: { id: string, workspaceId: string, downstreamNodeId: string, upstreamNodeId: string, upstreamTitle: string \| null, condition: string, state: string, reason: string \| null, baseline: {…}, createdAt: string \| null, updatedAt: string \| null, expiresAt: string \| null, resolvedAt: string \| null } }` | `forbidden`、`not_found`                | `canvas:write` | 1.9 | `DELETE /api/workspaces/{workspaceId}/dependencies/{dependencyId}` |

<!-- rpc:end -->

### 39.6 不在契约里的

- `POST /api/workspaces/{workspaceId}/exports/{exportId}/png`（白板导出）、`POST /api/workspaces/{workspaceId}/assets`（资源上传，原始字节或 data URL）、`POST /api/workspaces/{workspaceId}/assets/import`（按路径导入）与资源的 `GET`：字节流与大体积 data URL，走各自的体积上限，留在 REST，页面仍从 `api/agents.ts` 调。
- `/api/workspaces/{workspaceId}/handoffs*`（对话交接，`api/handoff.ts`）：不在本节，随后续包。
- hook 面（`/hook/*`、`/control/*`、`/context-link/*`）：有自己的凭据与监听，不走契约。

### 39.7 ACP 适配器的安装

自协议 1.15 起。实现在 `core/agent/adapter-install.ts`，只经 procedure，没有旧路径。

- 只装 `ACP_ADAPTER_PACKAGES`（`@armadra/shared`）里的三家：`claude` → `@agentclientprotocol/claude-agent-acp`、`codex` → `@agentclientprotocol/codex-acp`、`pi` → `pi-acp`。命令固定是 `npm install --global <包>`，入参只有 `agentId` 与 `reinstall`；表外的 id（含 `custom:` 条目与 ACP 入口就是 CLI 本身的那几家）答 400 `adapter_not_installable`，不起进程。页面给 `custom:` 条目时传它的 `baseAgent`。
- 只有 owner：scope 是 `settings:write` / `settings:read`（不在任何共享角色里，高于 `agent:launch`），域里再按主体判一次，成员答 403。
- npm 先用这家 CLI 所在 bin 目录里的那个（同一个 Node 安装），没有再用补齐过的 PATH 上的；子进程 PATH 以那个目录开头。都找不到答 409 `npm_not_found`。没带 `reinstall` 而适配器已在 PATH 上答 409 `adapter_already_installed`。同一家已在装时答那一个任务，不起第二个。
- 任务只在内存里（每家最近一个），`adapterInstall` 读进度：`state` 是 `idle | running | succeeded | failed`，带 `startedAt`、`endedAt`、`exitCode`、`output`（最后 40 行，去掉控制字符并脱敏，每行至多 300 字符）、`installed`（结束后重新探测）与 `failure: { code, message }`。失败码：`adapter_install_failed`（非零退出或起不来）、`adapter_install_timeout`（10 分钟）、`adapter_install_missing`（npm 成功但 PATH 上仍找不到适配器程序）。页面按 `code` 取文案。
- 结束后忘掉这家记着的 ACP 版本（`acp.version`），`GET /api/agents` 的 `acp.installed` 下次读即是新值。不写 CLI 的配置；npm 读用户自己的 `.npmrc`。开始与结束各写一条审计（`agent.adapter.install`、`agent.adapter.install.finish`），只有包名、状态与退出码，不含输出。

<!-- rpc:begin contract=§39.7 -->

| procedure               | kind | input                                      | output                                                                                                                                                                                                                                                                  | errors                                                                                              | scope            | 自   | 原路径 |
| ----------------------- | ---- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------- | ---- | ------ |
| `agents.installAdapter` | call | `{ agentId: string, reinstall?: boolean }` | `{ agentId: string, state: "idle" \| "running" \| "succeeded" \| "failed", package: string, reinstall?: boolean, startedAt?: string, endedAt?: string, exitCode?: number \| null, output: string[], installed?: boolean, failure?: { code: string, message: string } }` | `bad_request`、`forbidden`、`adapter_not_installable`、`adapter_already_installed`、`npm_not_found` | `settings:write` | 1.15 | —      |
| `agents.adapterInstall` | call | `{ agentId: string }`                      | `{ agentId: string, state: "idle" \| "running" \| "succeeded" \| "failed", package: string, reinstall?: boolean, startedAt?: string, endedAt?: string, exitCode?: number \| null, output: string[], installed?: boolean, failure?: { code: string, message: string } }` | `bad_request`、`forbidden`、`adapter_not_installable`                                               | `settings:read`  | 1.15 | —      |

<!-- rpc:end -->

## 40. `git` 与 `gitRepository`：Git 面

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-5）。分两次迁：§40.1 是一个检出的工作区与索引（`git.*`，第一部分），§40.2 是仓库级的读与操作队列（`gitRepository.*`，第二部分）。两部分合起来覆盖路由表里全部 Git 路径（`/api/workspaces/{workspaceId}/git/…` 与 `/api/git/clone`）。

### 40.1 `git.*`：工作区、索引与克隆

实现在 `core/git/routes.ts`：一份 `operations`，路由表里的旧 handler 与 procedure 都调它，拒绝的码与原话因此一样。命令在工作空间所在的机器上跑（`remote/execute`），远端工作空间由那台主机的 Worker 执行。

- 切分边界：本节收 `api/git.ts` 的 17 个调用——`status`、`diff`、`head-commit`、`init`、`stage`、`unstage`、`resolve`、`revert`、`commit`、`hunks`（读与写）、`message/providers|source|generate` 与 `/api/git/clone`（起、读、取消）。`repositories`、`log`、`refs`、`identity` 与 `repository/*`（`api/git-repository.ts` 的 23 个调用）属于 §40.2。
- 权限与旧路由表一致：`GET` 是 `git:read`，其余方法是 `git:write`（`message.generate` 只读仓库，旧路径是 `POST`，同样是 `git:write`）。除 `clone.*` 外都带 `workspaceId`，授权绑在那块工作空间上。之后还有工作空间自己的授权，在域里判：读要 `read`；写要 `read` 与 `write`；要跑仓库过滤器、钩子或传输助手的读写还要 `execute`，没有时答 `403 git_execution_required`（暂存侧的 `diff` 只读元数据，不要执行授权）。
- 入参只校形状：`scope`（`worktree` / `staged`）、`source`（`index` / `head`）、`action`（`stage` / `unstage` / `revert`）、`language`（`en` / `zh`）在契约里是字符串，取值由域判断，不认识的值答 `bad_request`，旧路径与 procedure 的原话一样。只有**形状**错（缺字段、类型不对）由契约的入参校验先答 `bad_request`（带 `details.issues`），旧路径上同样如此，与迁移前那句原话不同。
- 旧路径的读是查询串：`paths` 以逗号拼成一个字符串到达，`ignoreWhitespace` 以 `"true"` 到达；契约两种拼法都收，procedure 用数组与布尔。`status` 收下 `paths` 但不按它过滤。
- `path` 是工作空间内的相对目录，缺省 `.`：一次请求只对一个检出，没有跨仓库的提交。
- `commit`：给 `paths` 时先暂存再只提交这些；`amend` 必须带页面看到的 `expectedHead`，已推送的还要 `allowPublished: true`，HEAD 变了答 `409`。
- `hunks` / `applyHunk`：写回要带读到的 `diffDigest` 与块 id，磁盘变了答 `409`，页面重读。
- `message.*`：`source` 只答文件清单、摘要与是否截断、脱敏，不含暂存正文；`generate` 的模型在 core 这边跑（凭据在这边），源在仓库那边采集与复核。
- `clone.*` 是长操作，保留原来的任务模型：`start` 只起任务、答 `{ jobId }`；页面按 `status` 轮询（克隆时还没有工作空间，不走工作空间事件流），`lines` 是进度的最后至多 20 行，完成时 core 已把目标目录登记成工作空间并带在 `workspace` 里；`cancel` 旧路径答 `204`，procedure 的成功恒为 `200`、无体，取消已结束的任务不是错误。`parent` 在已有工作空间里时，每个祖先工作空间都要允许读、写与执行。
- 自协议 1.8（minor 8）起。

<!-- rpc:begin contract=§40.1 -->

| procedure               | kind     | input                                                                                                                                                   | output                                                                                                                                                                                                                                                              | errors                                                                        | scope       | 自  | 原路径                                                    |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------- | --- | --------------------------------------------------------- |
| `git.status`            | query    | `{ workspaceId: string, path?: string, paths?: string[] \| string }`                                                                                    | `{ repository: boolean, branch: string \| null, changedCount: integer, ahead?: integer \| null, behind?: integer \| null, files?: ({ path: string, status: "M" \| "A" \| "D" \| "R" \| "?", staged: boolean, unstaged: boolean, originPath?: string \| null })[] }` | `bad_request`、`forbidden`、`not_found`、`git_execution_required`             | `git:read`  | 1.8 | `GET /api/workspaces/{workspaceId}/git/status`            |
| `git.diff`              | query    | `{ workspaceId: string, path?: string, scope?: string, paths?: string[] \| string, ignoreWhitespace?: boolean \| string }`                              | `{ repository: boolean, clean: boolean, files: ({ path: string, status: "M" \| "A" \| "D" \| "R" \| "?", additions: integer, deletions: integer, patch: string, previewable?: boolean, staged?: boolean })[] }`                                                     | `bad_request`、`forbidden`、`not_found`、`git_execution_required`             | `git:read`  | 1.8 | `GET /api/workspaces/{workspaceId}/git/diff`              |
| `git.headCommit`        | query    | `{ workspaceId: string, path?: string }`                                                                                                                | `{ oid: string, subject: string, message: string, truncated: boolean, published: boolean } \| null`                                                                                                                                                                 | `bad_request`、`forbidden`、`not_found`、`git_execution_required`             | `git:read`  | 1.8 | `GET /api/workspaces/{workspaceId}/git/head-commit`       |
| `git.init`              | mutation | `{ workspaceId: string }`                                                                                                                               | `{ repository: true, branch: string \| null, path: string }`                                                                                                                                                                                                        | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/init`             |
| `git.stage`             | mutation | `{ workspaceId: string, path?: string, paths: string[] }`                                                                                               | `{ staged: string[] }`                                                                                                                                                                                                                                              | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/stage`            |
| `git.unstage`           | mutation | `{ workspaceId: string, path?: string, paths: string[] }`                                                                                               | `{ unstaged: string[] }`                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/unstage`          |
| `git.resolve`           | mutation | `{ workspaceId: string, path?: string, paths: string[] }`                                                                                               | `{ resolved: string[] }`                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/resolve`          |
| `git.revert`            | mutation | `{ workspaceId: string, path?: string, paths: string[], source?: string }`                                                                              | `{ reverted: string[] }`                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/revert`           |
| `git.commit`            | mutation | `{ workspaceId: string, path?: string, message: string, paths?: string[] \| null, amend?: { expectedHead: string, allowPublished?: boolean } \| null }` | `{ commit: string, committed?: string[], summary?: string }`                                                                                                                                                                                                        | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/commit`           |
| `git.hunks`             | query    | `{ workspaceId: string, path?: string, file: string, scope?: string }`                                                                                  | `{ file: string, scope: "worktree" \| "staged", diffDigest: string, supported: boolean, unsupportedReason: string \| null, hunks: { id: string, header: string, content: string, oldStart: integer, oldLines: integer, newStart: integer, newLines: integer }[] }`  | `bad_request`、`forbidden`、`not_found`、`git_execution_required`             | `git:read`  | 1.8 | `GET /api/workspaces/{workspaceId}/git/hunks`             |
| `git.applyHunk`         | mutation | `{ workspaceId: string, path?: string, file: string, scope?: string, diffDigest: string, hunkId: string, action: string }`                              | `{ applied: true, file: string, scope: "worktree" \| "staged", action: "stage" \| "unstage" \| "revert", hunkId: string }`                                                                                                                                          | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/hunks`            |
| `git.message.providers` | query    | `{ workspaceId: string }`                                                                                                                               | `({ id: string, label: string, available: boolean, reason: string \| null })[]`                                                                                                                                                                                     | `forbidden`、`not_found`                                                      | `git:read`  | 1.8 | `GET /api/workspaces/{workspaceId}/git/message/providers` |
| `git.message.source`    | query    | `{ workspaceId: string }`                                                                                                                               | `{ expectedHead: string \| null, indexDigest: string, sourceDigest: string, includedFiles: string[], excludedFiles: string[], truncated: boolean, redacted: boolean }`                                                                                              | `bad_request`、`forbidden`、`not_found`、`git_execution_required`             | `git:read`  | 1.8 | `GET /api/workspaces/{workspaceId}/git/message/source`    |
| `git.message.generate`  | mutation | `{ workspaceId: string, provider: string, expectedHead?: string \| null, indexDigest: string, language?: string, conventional?: boolean }`              | `{ expectedHead: string \| null, indexDigest: string, sourceDigest: string, includedFiles: string[], excludedFiles: string[], truncated: boolean, redacted: boolean, message: string, provider: "claude-bare", language?: "zh" \| "en", conventional?: boolean }`   | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required` | `git:write` | 1.8 | `POST /api/workspaces/{workspaceId}/git/message/generate` |
| `git.clone.start`       | mutation | `{ url: string, parent: string, name?: string \| null }`                                                                                                | `{ jobId: string }`                                                                                                                                                                                                                                                 | `bad_request`、`forbidden`、`not_found`、`git_execution_required`             | `git:write` | 1.8 | `POST /api/git/clone`                                     |
| `git.clone.status`      | query    | `{ jobId: string }`                                                                                                                                     | `{ state: "running" \| "done" \| "error", lines: string[], error?: string, workspace?: { id: string, name: string, rootPath: string, color: string, permissions: {…}, executionHostId?: string, lastOpenedAt: string, createdAt: string, updatedAt: string } }`     | `bad_request`、`forbidden`、`not_found`                                       | `git:read`  | 1.8 | `GET /api/git/clone/{jobId}`                              |
| `git.clone.cancel`      | mutation | `{ jobId: string }`                                                                                                                                     | 无                                                                                                                                                                                                                                                                  | `forbidden`、`not_found`                                                      | `git:write` | 1.8 | `DELETE /api/git/clone/{jobId}`                           |

<!-- rpc:end -->

### 40.2 `gitRepository.*`：仓库级的读与操作队列

实现在 `core/git/routes.ts`：与 §40.1 同一个做法，一份实现（`repository`），路由表里的旧 handler 与 procedure 都调它，拒绝的码与原话因此一样。读在工作空间所在的机器上跑（`remote/execute`）；操作排在执行主机的队列里，操作归哪个工作空间的表在控制端。

- 切分边界：本节收 `api/git-repository.ts` 的 23 个调用——`repositories`、`log`、`refs`、`identity` 与 `repository/*`（分支、标签、远端、worktree、储藏与储藏详情、历史、reflog、提交详情与单个文件、cherry-pick 预览、rebase 待办预览、多检出状态、worktree 绑定核对、整合状态，以及操作队列的列、起、读、取消）。与 §40.1 合起来，路由表里的 Git 路径都在契约上（对偶测试 `parity-git-repository.test.ts` 核对）。
- 权限与旧路由表一致：`GET` 是 `git:read`，其余方法是 `git:write`。`log`、`statusBatch`、`worktreeBinding` 只读，但旧路径是 `POST`（筛选条件或路径表是体），同样是 `git:write`。全部带 `workspaceId`，授权绑在那块工作空间上。之后是工作空间自己的授权，在域里判：读要 `read`；`operations.start` / `operations.cancel` 还要 `write`；要跑仓库过滤器、钩子或传输助手的（`statusBatch`、`operations.start`、按执行授权降级的读）没有 `execute` 时答 `403 git_execution_required`，或在答案里把需要执行的字段置 `null`（如 `repositories` 的 `dirtyCount`）。
- 入参只校形状：引用、oid、路径是否合法，`log` 的 `refs.kind`（`head` / `all` / `named`），以及操作（`action`）是哪一种、字段对不对，由域判断，不认识或不合法答 `bad_request`，旧路径与 procedure 的原话一样。所以 `action` 在契约里只要求是带 `kind` 字符串的对象，其余字段原样交给域。只有**形状**错（缺字段、类型不对）由契约的入参校验先答 `bad_request`（带 `details.issues`），旧路径上同样如此。
- 旧路径的读是查询串：`limit`、`maxDepth`、`mainline` 以数字串到达，`refresh` 以 `"true"` 到达，`history` 的 `paths` 以逗号拼成一个字符串到达；契约两种拼法都收，procedure 用数字、布尔与数组。数字必须是非负整数，否则答 `bad_request`。
- 分页：`history` 与 `reflog` 缺省 `reference: "HEAD"`、`limit: 50`；`log` 缺省 `limit: 100`。游标是不透明字符串，属于取它时的引用或那组筛选条件，对不上答 `409 invalid_cursor`，页面丢掉游标重读第一页。
- `commitDetail` / `commitFile` 的 `base` 缺省对第一父提交比较；`integration` 里不是这个工作空间发起的整合会话，`sessionId`、能否继续 / 跳过、`mainline` 与 `originalHead` 一律抹掉。
- 操作队列是长操作，保留原来的模型：`operations.start` 只把操作排进队列、答它的快照（带 `id`，此时多为 `queued`）；页面按 `operations.get` 轮询进度（`progress`、`state`），rebase 这类停下等人处理冲突的操作同样经队列，结束于 `awaitingResolution`，再由带 `sessionId` 的继续 / 中止 / 跳过操作接着走。`expected` 是页面看到的 HEAD 与分支（CAS），开跑时对不上就失败。操作只对发起它的工作空间可见：别的工作空间读或取消答 `404`。取消已结束的操作原样答它的快照。
- 自协议 1.10（minor 10）起。

<!-- rpc:begin contract=§40.2 -->

| procedure                         | kind     | input                                                                                                                                                                                                                                                                                                                 | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | errors                                                                                          | scope       | 自   | 原路径                                                                              |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------- | ---- | ----------------------------------------------------------------------------------- |
| `gitRepository.repositories`      | query    | `{ workspaceId: string, refresh?: boolean \| string, maxDepth?: number \| string }`                                                                                                                                                                                                                                   | `{ workspaceRoot: string, maxDepth: integer, repositories: ({ repositoryId: string, repositoryPath: string, name: string, kind: "root" \| "nested" \| "submodule" \| "worktree", parentRepositoryId: string \| null, headBranch: string \| null, dirtyCount: integer \| null })[], truncated: boolean, observedAt: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repositories`                                |
| `gitRepository.log`               | mutation | `{ workspaceId: string, repositories?: string[] \| null, refs?: { kind?: string, names?: string[] } \| null, authors?: string[], since?: string \| null, until?: string \| null, paths?: string[], text?: { query: string, regex?: boolean, matchCase?: boolean } \| null, cursor?: string \| null, limit?: number }` | `{ commits: { oid: string, parents: string[], subject: string, authorName: string, authorEmail: string, authorTime: string, committerTime: string, refs: string[], repositoryPath: string }[], nextCursor: string \| null, repositories: { path: string, color: integer }[], truncated: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `bad_request`、`forbidden`、`not_found`、`conflict`、`invalid_cursor`、`git_execution_required` | `git:write` | 1.10 | `POST /api/workspaces/{workspaceId}/git/log`                                        |
| `gitRepository.refs`              | query    | `{ workspaceId: string }`                                                                                                                                                                                                                                                                                             | `({ repositoryPath: string, repositoryId: string, kind: "root" \| "nested" \| "submodule" \| "worktree", name: string, head: { oid: string \| null, branch: string \| null }, branches: ({ name: string, oid: string, upstream: string \| null, ahead: integer \| null, behind: integer \| null, current: boolean })[], remotes: { name: string, branches: {…}[] }[], tags: { name: string, oid: string, annotated: boolean }[], worktrees: ({ path: string, branch: string \| null, oid: string \| null, locked: boolean })[], stashCount: integer, stashes: { index: integer, oid: string, message: string, createdAt: string }[] })[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/refs`                                        |
| `gitRepository.identity`          | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `{ name: string \| null, email: string \| null }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/identity`                                    |
| `gitRepository.branches`          | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `{ repositoryId: string, repositoryPath: string, head: { headOid: string \| null, branch: string \| null }, branches: ({ name: string, fullRef: string, oid: string, remote: boolean, current: boolean, upstream: string \| null, ahead: integer \| null, behind: integer \| null, upstreamMissing: boolean, symbolicTarget: string \| null })[], remotes: string[], observedAt: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/branches`                         |
| `gitRepository.tags`              | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `{ repositoryId: string, repositoryPath: string, head: { headOid: string \| null, branch: string \| null }, tags: ({ name: string, fullRef: string, oid: string, targetOid: string, annotated: boolean, subject: string \| null, taggerName: string \| null, taggerTime: string \| null })[], observedAt: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/tags`                             |
| `gitRepository.remotes`           | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `{ name: string, fetchUrl: string, pushUrl: string, redacted: boolean }[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/remotes`                          |
| `gitRepository.worktrees`         | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `({ path: string, headOid: string \| null, branch: string \| null, detached: boolean, bare: boolean, isMain: boolean, locked: boolean, lockReason: string \| null, prunable: boolean, pruneReason: string \| null, accessible: boolean, dirty: boolean \| null })[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/worktrees`                        |
| `gitRepository.stashes`           | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `{ repositoryId: string, repositoryPath: string, head: { headOid: string \| null, branch: string \| null }, stateToken: string, dirty: boolean, hasConflicts: boolean, stashes: { oid: string, selector: string, subject: string, authorName: string, authorTime: string }[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/stashes`                          |
| `gitRepository.stashDetail`       | query    | `{ workspaceId: string, path?: string, oid: string }`                                                                                                                                                                                                                                                                 | `{ oid: string, parents: string[], patch: string, stagedPatch: string, untrackedPatch: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/stash-detail`                     |
| `gitRepository.history`           | query    | `{ workspaceId: string, path?: string, reference?: string, limit?: number \| string, cursor?: string \| null, paths?: string[] \| string }`                                                                                                                                                                           | `{ reference: string, anchorOid: string \| null, commits: { oid: string, parents: string[], subject: string, authorName: string, authorEmail: string, authorTime: string, committerTime: string, refs: string[] }[], nextCursor: string \| null, shallow: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `bad_request`、`forbidden`、`not_found`、`conflict`、`invalid_cursor`、`git_execution_required` | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/history`                          |
| `gitRepository.reflog`            | query    | `{ workspaceId: string, path?: string, reference?: string, limit?: number \| string, cursor?: string \| null }`                                                                                                                                                                                                       | `{ reference: string, entries: ({ index: integer, selector: string, oid: string, previousOid: string \| null, action: string, message: string, committerName: string, committerEmail: string, loggedAt: string })[], nextCursor: string \| null }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `bad_request`、`forbidden`、`not_found`、`conflict`、`invalid_cursor`、`git_execution_required` | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/reflog`                           |
| `gitRepository.commitDetail`      | query    | `{ workspaceId: string, path?: string, oid: string, base?: string }`                                                                                                                                                                                                                                                  | `{ oid: string, baseOid: string \| null, commit: { oid: string, parents: string[], subject: string, authorName: string, authorEmail: string, authorTime: string, committerTime: string, refs: string[] }, files: ({ status: string, path: string, additions: integer \| null, deletions: integer \| null })[], truncated: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/commit`                           |
| `gitRepository.commitFile`        | query    | `{ workspaceId: string, path?: string, oid: string, base?: string, file: string }`                                                                                                                                                                                                                                    | `{ oid: string, baseOid: string \| null, path: string, patch: string, truncated: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/commit-file`                      |
| `gitRepository.cherryPickPreview` | query    | `{ workspaceId: string, path?: string, oid: string, mainline?: number \| string }`                                                                                                                                                                                                                                    | `{ targetOid: string, parents: string[], subject: string, authorName: string, authorEmail: string, authorTime: string, mainline: integer \| null, patch: string \| null }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/cherry-pick-preview`              |
| `gitRepository.rebaseTodo`        | query    | `{ workspaceId: string, path?: string, onto: string }`                                                                                                                                                                                                                                                                | `{ onto: string, base: string, head: { headOid: string \| null, branch: string \| null }, commits: { oid: string, parents: string[], subject: string, authorName: string, authorEmail: string, authorTime: string, committerTime: string, refs: string[] }[], hasMerges: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/rebase-todo`                      |
| `gitRepository.statusBatch`       | mutation | `{ workspaceId: string, paths: string[], pathspecs?: string[] }`                                                                                                                                                                                                                                                      | `{ repositories: { path: string, status?: {…}, error?: {…} }[], observedAt: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:write` | 1.10 | `POST /api/workspaces/{workspaceId}/git/repository/status-batch`                    |
| `gitRepository.worktreeBinding`   | mutation | `{ workspaceId: string, worktreePath: string, branch?: string \| null, repositoryId?: string \| null }`                                                                                                                                                                                                               | `{ valid: boolean, code: "ok" \| "pathMissing" \| "notAWorktree" \| "repositoryMismatch" \| "branchChanged", worktreePath: string, absolutePath: string, repositoryId: string, branch: string \| null, headOid: string \| null, isMain: boolean, locked: boolean, prunable: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:write` | 1.10 | `POST /api/workspaces/{workspaceId}/git/repository/worktree-binding`                |
| `gitRepository.integration`       | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `{ repositoryId: string, repositoryPath: string, head: { headOid: string \| null, branch: string \| null }, stateToken: string, kind: "none" \| "merge" \| "rebase" \| "cherryPick" \| "revert" \| "bisect" \| "unknown", owned: boolean, sessionId: string \| null, originalHead: string \| null, originalBranch: string \| null, targetOid: string \| null, message: string \| null, dirty: boolean, canContinue: boolean, mainline: integer \| null, empty: boolean, canSkip: boolean, conflicts: ({ path: string, base: {…} \| null, ours: {…} \| null, theirs: {…} \| null })[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/integration`                      |
| `gitRepository.operations.list`   | query    | `{ workspaceId: string, path?: string }`                                                                                                                                                                                                                                                                              | `({ id: string, repositoryId: string, workspaceRoot: string, repositoryPath: string, action: { kind: "startCherryPick", targetOid: string, mainline: integer \| null, recordOrigin: boolean, expectedStateToken: string } \| { kind: "revert", targetOid: string, mainline: integer \| null, expectedStateToken: string } \| { kind: "checkoutCommit", targetOid: string } \| { kind: "reset", mode: "soft" \| "mixed" \| "hard", targetOid: string, expectedStateToken: string, discardChanges: boolean } \| { kind: "skipIntegration", sessionId: string, expectedStateToken: string } \| { kind: "startMerge", targetOid: string, message: string, expectedStateToken: string } \| { kind: "startRebase", onto: string, expectedStateToken: string } \| { kind: "startInteractiveRebase", onto: string, todo: {…}[], expectedStateToken: string } \| { kind: "continueIntegration", sessionId: string, expectedStateToken: string } \| { kind: "abortIntegration", sessionId: string, expectedStateToken: string } \| { kind: "createStash", message: string, includeUntracked: boolean, expectedStateToken: string } \| { kind: "applyStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "popStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "dropStash", oid: string, expectedStateToken: string } \| { kind: "createBranch", name: string, startPoint: string \| null, switch: boolean } \| { kind: "switchBranch", name: string, expectedOid: string } \| { kind: "deleteBranch", name: string, expectedOid: string } \| { kind: "renameBranch", name: string, newName: string, expectedOid: string } \| { kind: "fetch", remote: string, prune: boolean } \| { kind: "pull", remote: string, branch: string } \| { kind: "push", remote: string, branch: string, setUpstream: boolean, forceWithLease: {…} \| null } \| { kind: "sync", remote: string, branch: string, expectedRemoteOid: string \| null } \| { kind: "createTag", name: string, targetOid: string, message: string \| null } \| { kind: "deleteTag", name: string, expectedOid: string } \| { kind: "pushTag", remote: string, name: string, expectedOid: string } \| { kind: "addRemote", name: string, url: string } \| { kind: "renameRemote", name: string, newName: string } \| { kind: "setRemoteUrl", name: string, url: string } \| { kind: "removeRemote", name: string } \| { kind: "createWorktree", expectedOid: string \| null, path: string, branch: string, createBranch: boolean, startPoint: string \| null, pullHead?: {…} \| null } \| { kind: "removeWorktree", path: string, expectedOid: string, allowUnpublished: boolean }, state: "queued" \| "running" \| "succeeded" \| "failed" \| "cancelled" \| "unknownOutcome" \| "awaitingResolution", cancellationRequested: boolean, progress?: integer, createdAt: string, finishedAt: string \| null, message: string \| null })[]` | `bad_request`、`forbidden`、`not_found`、`git_execution_required`                               | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/operations`                       |
| `gitRepository.operations.start`  | mutation | `{ workspaceId: string, path?: string, action: { kind: string }, expected: { headOid?: string \| null, branch?: string \| null } }`                                                                                                                                                                                   | `{ id: string, repositoryId: string, workspaceRoot: string, repositoryPath: string, action: { kind: "startCherryPick", targetOid: string, mainline: integer \| null, recordOrigin: boolean, expectedStateToken: string } \| { kind: "revert", targetOid: string, mainline: integer \| null, expectedStateToken: string } \| { kind: "checkoutCommit", targetOid: string } \| { kind: "reset", mode: "soft" \| "mixed" \| "hard", targetOid: string, expectedStateToken: string, discardChanges: boolean } \| { kind: "skipIntegration", sessionId: string, expectedStateToken: string } \| { kind: "startMerge", targetOid: string, message: string, expectedStateToken: string } \| { kind: "startRebase", onto: string, expectedStateToken: string } \| { kind: "startInteractiveRebase", onto: string, todo: {…}[], expectedStateToken: string } \| { kind: "continueIntegration", sessionId: string, expectedStateToken: string } \| { kind: "abortIntegration", sessionId: string, expectedStateToken: string } \| { kind: "createStash", message: string, includeUntracked: boolean, expectedStateToken: string } \| { kind: "applyStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "popStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "dropStash", oid: string, expectedStateToken: string } \| { kind: "createBranch", name: string, startPoint: string \| null, switch: boolean } \| { kind: "switchBranch", name: string, expectedOid: string } \| { kind: "deleteBranch", name: string, expectedOid: string } \| { kind: "renameBranch", name: string, newName: string, expectedOid: string } \| { kind: "fetch", remote: string, prune: boolean } \| { kind: "pull", remote: string, branch: string } \| { kind: "push", remote: string, branch: string, setUpstream: boolean, forceWithLease: {…} \| null } \| { kind: "sync", remote: string, branch: string, expectedRemoteOid: string \| null } \| { kind: "createTag", name: string, targetOid: string, message: string \| null } \| { kind: "deleteTag", name: string, expectedOid: string } \| { kind: "pushTag", remote: string, name: string, expectedOid: string } \| { kind: "addRemote", name: string, url: string } \| { kind: "renameRemote", name: string, newName: string } \| { kind: "setRemoteUrl", name: string, url: string } \| { kind: "removeRemote", name: string } \| { kind: "createWorktree", expectedOid: string \| null, path: string, branch: string, createBranch: boolean, startPoint: string \| null, pullHead?: {…} \| null } \| { kind: "removeWorktree", path: string, expectedOid: string, allowUnpublished: boolean }, state: "queued" \| "running" \| "succeeded" \| "failed" \| "cancelled" \| "unknownOutcome" \| "awaitingResolution", cancellationRequested: boolean, progress?: integer, createdAt: string, finishedAt: string \| null, message: string \| null }`     | `bad_request`、`forbidden`、`not_found`、`conflict`、`git_execution_required`                   | `git:write` | 1.10 | `POST /api/workspaces/{workspaceId}/git/repository/operations`                      |
| `gitRepository.operations.get`    | query    | `{ workspaceId: string, operationId: string }`                                                                                                                                                                                                                                                                        | `{ id: string, repositoryId: string, workspaceRoot: string, repositoryPath: string, action: { kind: "startCherryPick", targetOid: string, mainline: integer \| null, recordOrigin: boolean, expectedStateToken: string } \| { kind: "revert", targetOid: string, mainline: integer \| null, expectedStateToken: string } \| { kind: "checkoutCommit", targetOid: string } \| { kind: "reset", mode: "soft" \| "mixed" \| "hard", targetOid: string, expectedStateToken: string, discardChanges: boolean } \| { kind: "skipIntegration", sessionId: string, expectedStateToken: string } \| { kind: "startMerge", targetOid: string, message: string, expectedStateToken: string } \| { kind: "startRebase", onto: string, expectedStateToken: string } \| { kind: "startInteractiveRebase", onto: string, todo: {…}[], expectedStateToken: string } \| { kind: "continueIntegration", sessionId: string, expectedStateToken: string } \| { kind: "abortIntegration", sessionId: string, expectedStateToken: string } \| { kind: "createStash", message: string, includeUntracked: boolean, expectedStateToken: string } \| { kind: "applyStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "popStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "dropStash", oid: string, expectedStateToken: string } \| { kind: "createBranch", name: string, startPoint: string \| null, switch: boolean } \| { kind: "switchBranch", name: string, expectedOid: string } \| { kind: "deleteBranch", name: string, expectedOid: string } \| { kind: "renameBranch", name: string, newName: string, expectedOid: string } \| { kind: "fetch", remote: string, prune: boolean } \| { kind: "pull", remote: string, branch: string } \| { kind: "push", remote: string, branch: string, setUpstream: boolean, forceWithLease: {…} \| null } \| { kind: "sync", remote: string, branch: string, expectedRemoteOid: string \| null } \| { kind: "createTag", name: string, targetOid: string, message: string \| null } \| { kind: "deleteTag", name: string, expectedOid: string } \| { kind: "pushTag", remote: string, name: string, expectedOid: string } \| { kind: "addRemote", name: string, url: string } \| { kind: "renameRemote", name: string, newName: string } \| { kind: "setRemoteUrl", name: string, url: string } \| { kind: "removeRemote", name: string } \| { kind: "createWorktree", expectedOid: string \| null, path: string, branch: string, createBranch: boolean, startPoint: string \| null, pullHead?: {…} \| null } \| { kind: "removeWorktree", path: string, expectedOid: string, allowUnpublished: boolean }, state: "queued" \| "running" \| "succeeded" \| "failed" \| "cancelled" \| "unknownOutcome" \| "awaitingResolution", cancellationRequested: boolean, progress?: integer, createdAt: string, finishedAt: string \| null, message: string \| null }`     | `bad_request`、`forbidden`、`not_found`                                                         | `git:read`  | 1.10 | `GET /api/workspaces/{workspaceId}/git/repository/operations/{operationId}`         |
| `gitRepository.operations.cancel` | mutation | `{ workspaceId: string, operationId: string }`                                                                                                                                                                                                                                                                        | `{ id: string, repositoryId: string, workspaceRoot: string, repositoryPath: string, action: { kind: "startCherryPick", targetOid: string, mainline: integer \| null, recordOrigin: boolean, expectedStateToken: string } \| { kind: "revert", targetOid: string, mainline: integer \| null, expectedStateToken: string } \| { kind: "checkoutCommit", targetOid: string } \| { kind: "reset", mode: "soft" \| "mixed" \| "hard", targetOid: string, expectedStateToken: string, discardChanges: boolean } \| { kind: "skipIntegration", sessionId: string, expectedStateToken: string } \| { kind: "startMerge", targetOid: string, message: string, expectedStateToken: string } \| { kind: "startRebase", onto: string, expectedStateToken: string } \| { kind: "startInteractiveRebase", onto: string, todo: {…}[], expectedStateToken: string } \| { kind: "continueIntegration", sessionId: string, expectedStateToken: string } \| { kind: "abortIntegration", sessionId: string, expectedStateToken: string } \| { kind: "createStash", message: string, includeUntracked: boolean, expectedStateToken: string } \| { kind: "applyStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "popStash", oid: string, reinstateIndex: boolean, expectedStateToken: string } \| { kind: "dropStash", oid: string, expectedStateToken: string } \| { kind: "createBranch", name: string, startPoint: string \| null, switch: boolean } \| { kind: "switchBranch", name: string, expectedOid: string } \| { kind: "deleteBranch", name: string, expectedOid: string } \| { kind: "renameBranch", name: string, newName: string, expectedOid: string } \| { kind: "fetch", remote: string, prune: boolean } \| { kind: "pull", remote: string, branch: string } \| { kind: "push", remote: string, branch: string, setUpstream: boolean, forceWithLease: {…} \| null } \| { kind: "sync", remote: string, branch: string, expectedRemoteOid: string \| null } \| { kind: "createTag", name: string, targetOid: string, message: string \| null } \| { kind: "deleteTag", name: string, expectedOid: string } \| { kind: "pushTag", remote: string, name: string, expectedOid: string } \| { kind: "addRemote", name: string, url: string } \| { kind: "renameRemote", name: string, newName: string } \| { kind: "setRemoteUrl", name: string, url: string } \| { kind: "removeRemote", name: string } \| { kind: "createWorktree", expectedOid: string \| null, path: string, branch: string, createBranch: boolean, startPoint: string \| null, pullHead?: {…} \| null } \| { kind: "removeWorktree", path: string, expectedOid: string, allowUnpublished: boolean }, state: "queued" \| "running" \| "succeeded" \| "failed" \| "cancelled" \| "unknownOutcome" \| "awaitingResolution", cancellationRequested: boolean, progress?: integer, createdAt: string, finishedAt: string \| null, message: string \| null }`     | `bad_request`、`forbidden`、`not_found`、`conflict`                                             | `git:write` | 1.10 | `POST /api/workspaces/{workspaceId}/git/repository/operations/{operationId}/cancel` |

<!-- rpc:end -->

## 41. `forge` 与 `github`：托管平台与 GitHub 的面板调用

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-6）。两个域各一节：§41.1 是 GitHub（`github.*`，24 个动词，§5 的形状），§41.2 是 Gitea / Forgejo / GitLab（`forge.*`，§29 的形状）。自协议 1.11（minor 11）起。错误码一律 snake_case（§3.3）。

### 41.1 `github.*`：GitHub 面板

实现在 `core/github/http.ts`：同一个 `invoke` 与同一张字段表（`core/github/schema.ts`），旧的 `POST /api/github/<动词>` 与 `github.*` procedure 调同一份，拒绝的码与固定的英文原话一样。

- **旧路径不挂契约的旧路径**：`/api/github/` 是整段自己认证的原样路由（来源 `Origin`、Cookie 会话的 CSRF、会话与工作空间级权限都在域自己的 HTTP 面上判，工作空间在查询串 `?workspaceId=`），不在路由表的逐条模式里，所以 `github.*` 没有 `meta.legacy`；两条路的对偶由 `core/contract/parity-github.test.ts` 逐字节核对。procedure 的 `workspaceId` 在入参里，授权绑在它上面（`workspaceKey`）。
- **调用方**：procedure 的调用方来自准入门核验过的请求身份（来源、Bearer、CSRF 已在那里判过；门面再按 `meta.scope` 与 `workspaceId` 判工作空间级权限），`GithubService.authorize` 照旧再核一次，从不把空的或全局的请求放宽。没有请求身份只剩一种合法情形：显式打开了回环匿名主人（`ARMADRA_LOOPBACK_OWNER=1` 的裸 core）；其余一律 401 `unauthenticated`。
- **线上的形状**：`int64` / `uint64` 是十进制**字符串**，枚举是枚举值名，零值照写，缺席的嵌套记录不出现（§2）。出参 schema 是 `packages/shared/src/api/github.ts` 里「线上的形状」那一份（没有变换，多出来的字段原样放行）；页面再按「读回的形状」那一份（`bigint`）解析。同一张字段表实例化两次，33 个记录 schema 因此只有一份定义。
- **入参**只校到顶层字段的类型：嵌套的记录（`repository`、`filter`、`patch`、`mapping`、`reference`、评审意见）与枚举取值由域按字段表解码，解不开答 `400 bad_request`（原话固定为 `Invalid GitHub request`），所以更新过的页面多带的字段不是拒绝的理由。
- 列表里不带正文（`listIssues`、`listPulls`）：详情把整份拿回来。写按页面显示过的 `expectedUpdatedAtUnixMs` / `expectedHeadSha` / `expectedRevision` 核对，变了答 `409 conflict`，一个字节都不写出去；写出去而结果没读到答 `504 unknown_outcome`，调用方重新读，永远不要重试。
- 令牌只在 `configureCredential` 的入参里出去一次，答案是一份状态而不是一次回声；远端散文（Issue 正文、评论、错误消息）不进错误体，也不进日志。
- 权限：读是 `github:read`，写是 `github:write`，都绑在工作空间上（`scope(permission, workspaceId, hostId)`）。

<!-- rpc:begin contract=§41.1 -->

| procedure                    | kind | input                                                                                                                                                                                                                     | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | errors                                                                                                                   | scope          | 自   | 原路径 |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------- | ---- | ------ |
| `github.getCredential`       | call | `{ workspaceId: string }`                                                                                                                                                                                                 | `{ source: string, store: string, available: boolean, apiBase: string, enterprise: boolean, accountLogin: string, tokenScopes: string[], checkedAtUnixMs: string \| number, reasonCode: string, revision: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`unauthenticated`、`forbidden`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome`              | `github:read`  | 1.11 | —      |
| `github.configureCredential` | call | `{ workspaceId: string, source?: string, token?: string, apiBase?: string, expectedRevision?: string \| number }`                                                                                                         | `{ source: string, store: string, available: boolean, apiBase: string, enterprise: boolean, accountLogin: string, tokenScopes: string[], checkedAtUnixMs: string \| number, reasonCode: string, revision: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`unauthenticated`、`forbidden`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome`              | `github:write` | 1.11 | —      |
| `github.revokeCredential`    | call | `{ workspaceId: string, expectedRevision?: string \| number }`                                                                                                                                                            | `{ source: string, store: string, available: boolean, apiBase: string, enterprise: boolean, accountLogin: string, tokenScopes: string[], checkedAtUnixMs: string \| number, reasonCode: string, revision: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`unauthenticated`、`forbidden`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome`              | `github:write` | 1.11 | —      |
| `github.resolveRepository`   | call | `{ workspaceId: string, remoteUrl?: string }`                                                                                                                                                                             | `{ repository?: { ref?: {…}, id: string \| number, defaultBranch: string, private: boolean, fork: boolean, hasIssues: boolean, allowedMergeMethods: string[], permission: string, observedAtUnixMs: string \| number }, hostMismatch: boolean, reasonCode: string, rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.listIssues`          | call | `{ workspaceId: string, repository?: Record<string, JSON>, filter?: Record<string, JSON>, afterCursor?: string, limit?: string \| number }`                                                                               | `{ issues: ({ repository?: {…}, number: string \| number, id: string \| number, title: string, body: string, state: string, stateReason: string, author?: {…}, assignees: {…}[], labels: {…}[], milestone?: {…}, commentCount: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, statusGroupId: string, statusConflict: boolean, observedAtUnixMs: string \| number })[], nextCursor: string, hasMore: boolean, rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number }, fromCache: boolean, observedAtUnixMs: string \| number, pollIntervalMs: string \| number, statusGroupsPartial: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.getIssue`            | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number }`                                                                                                                                   | `{ issue?: { repository?: {…}, number: string \| number, id: string \| number, title: string, body: string, state: string, stateReason: string, author?: {…}, assignees: {…}[], labels: {…}[], milestone?: {…}, commentCount: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, statusGroupId: string, statusConflict: boolean, observedAtUnixMs: string \| number }, comments: ({ id: string \| number, author?: {…}, body: string, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, htmlUrl: string })[], references: ({ referenceId: string, workspaceId: string, forge: string, repository?: {…}, kind: string, number: string \| number, targetKind: string, targetId: string, title: string, revision: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number })[], rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number }, pollIntervalMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.createIssue`         | call | `{ workspaceId: string, repository?: Record<string, JSON>, title?: string, body?: string, labels?: string[], assignees?: string[], milestoneNumber?: string \| number }`                                                  | `{ repository?: { owner: string, name: string, apiBase: string, host: string }, number: string \| number, id: string \| number, title: string, body: string, state: string, stateReason: string, author?: { login: string, id: string \| number }, assignees: ({ login: string, id: string \| number })[], labels: { name: string, color: string }[], milestone?: { number: string \| number, title: string }, commentCount: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, statusGroupId: string, statusConflict: boolean, observedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.updateIssue`         | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, patch?: Record<string, JSON>, expectedUpdatedAtUnixMs?: string \| number }`                                                         | `{ repository?: { owner: string, name: string, apiBase: string, host: string }, number: string \| number, id: string \| number, title: string, body: string, state: string, stateReason: string, author?: { login: string, id: string \| number }, assignees: ({ login: string, id: string \| number })[], labels: { name: string, color: string }[], milestone?: { number: string \| number, title: string }, commentCount: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, statusGroupId: string, statusConflict: boolean, observedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.setIssueState`       | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, state?: string, reason?: string, expectedUpdatedAtUnixMs?: string \| number }`                                                      | `{ repository?: { owner: string, name: string, apiBase: string, host: string }, number: string \| number, id: string \| number, title: string, body: string, state: string, stateReason: string, author?: { login: string, id: string \| number }, assignees: ({ login: string, id: string \| number })[], labels: { name: string, color: string }[], milestone?: { number: string \| number, title: string }, commentCount: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, statusGroupId: string, statusConflict: boolean, observedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.commentIssue`        | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, body?: string }`                                                                                                                    | `{ id: string \| number, author?: { login: string, id: string \| number }, body: string, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, htmlUrl: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.getStatusMapping`    | call | `{ workspaceId: string, repository?: Record<string, JSON> }`                                                                                                                                                              | `{ repository?: { owner: string, name: string, apiBase: string, host: string }, source: string, projectId: string, projectFieldId: string, groups: { id: string, title: string, label: string, projectOptionId: string, couplesIssueState: string }[], stateGroups: { state: string, groupId: string }[], revision: string \| number, updatedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.putStatusMapping`    | call | `{ workspaceId: string, mapping?: Record<string, JSON>, expectedRevision?: string \| number }`                                                                                                                            | `{ repository?: { owner: string, name: string, apiBase: string, host: string }, source: string, projectId: string, projectFieldId: string, groups: { id: string, title: string, label: string, projectOptionId: string, couplesIssueState: string }[], stateGroups: { state: string, groupId: string }[], revision: string \| number, updatedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.moveIssue`           | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, toGroupId?: string, fromGroupId?: string, expectedUpdatedAtUnixMs?: string \| number, expectedMappingRevision?: string \| number }` | `{ issue?: { repository?: {…}, number: string \| number, id: string \| number, title: string, body: string, state: string, stateReason: string, author?: {…}, assignees: {…}[], labels: {…}[], milestone?: {…}, commentCount: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, statusGroupId: string, statusConflict: boolean, observedAtUnixMs: string \| number }, outcomes: { actionId: string, target: string, state: string, reasonCode: string, previousValue: string, requestedValue: string }[], rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.listPulls`           | call | `{ workspaceId: string, repository?: Record<string, JSON>, filter?: Record<string, JSON>, afterCursor?: string, limit?: string \| number }`                                                                               | `{ pulls: ({ repository?: {…}, number: string \| number, id: string \| number, title: string, body: string, state: string, draft: boolean, author?: {…}, baseRef: string, headRef: string, headSha: string, headRepoFullName: string, fromFork: boolean, mergeable: string, allowedMergeMethods: string[], additions: string \| number, deletions: string \| number, changedFiles: string \| number, commits: string \| number, requestedReviewers: {…}[], labels: {…}[], createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, mergedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, observedAtUnixMs: string \| number })[], nextCursor: string, hasMore: boolean, rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number }, fromCache: boolean, observedAtUnixMs: string \| number, pollIntervalMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.getPull`             | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number }`                                                                                                                                   | `{ pull?: { repository?: {…}, number: string \| number, id: string \| number, title: string, body: string, state: string, draft: boolean, author?: {…}, baseRef: string, headRef: string, headSha: string, headRepoFullName: string, fromFork: boolean, mergeable: string, allowedMergeMethods: string[], additions: string \| number, deletions: string \| number, changedFiles: string \| number, commits: string \| number, requestedReviewers: {…}[], labels: {…}[], createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, mergedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, observedAtUnixMs: string \| number }, files: ({ path: string, previousPath: string, status: string, additions: string \| number, deletions: string \| number, binary: boolean, patch: string })[], reviews: ({ id: string \| number, author?: {…}, state: string, body: string, commitSha: string, submittedAtUnixMs: string \| number })[], reviewComments: ({ id: string \| number, author?: {…}, body: string, path: string, commitSha: string, line: string \| number, side: string, outdated: boolean, createdAtUnixMs: string \| number })[], comments: ({ id: string \| number, author?: {…}, body: string, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, htmlUrl: string })[], checks?: { headSha: string, runs: {…}[], rollup: string, observedAtUnixMs: string \| number }, references: ({ referenceId: string, workspaceId: string, forge: string, repository?: {…}, kind: string, number: string \| number, targetKind: string, targetId: string, title: string, revision: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number })[], rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number }, pollIntervalMs: string \| number }` | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.createPull`          | call | `{ workspaceId: string, repository?: Record<string, JSON>, baseRef?: string, headRef?: string, title?: string, body?: string, draft?: boolean, linkedIssueNumber?: string \| number, expectedHeadSha?: string }`          | `{ repository?: { owner: string, name: string, apiBase: string, host: string }, number: string \| number, id: string \| number, title: string, body: string, state: string, draft: boolean, author?: { login: string, id: string \| number }, baseRef: string, headRef: string, headSha: string, headRepoFullName: string, fromFork: boolean, mergeable: string, allowedMergeMethods: string[], additions: string \| number, deletions: string \| number, changedFiles: string \| number, commits: string \| number, requestedReviewers: ({ login: string, id: string \| number })[], labels: { name: string, color: string }[], createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, mergedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, observedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.submitReview`        | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, commitSha?: string, state?: string, body?: string, comments?: Record<string, JSON>[] }`                                             | `{ id: string \| number, author?: { login: string, id: string \| number }, state: string, body: string, commitSha: string, submittedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.getChecks`           | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number }`                                                                                                                                   | `{ headSha: string, runs: ({ name: string, app: string, conclusion: string, detailsUrl: string, startedAtUnixMs: string \| number, completedAtUnixMs: string \| number, rerunnable: boolean, workflowRunId: string \| number })[], rollup: string, observedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |
| `github.rerunChecks`         | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, expectedHeadSha?: string, checkName?: string, failedOnly?: boolean }`                                                               | `{ outcomes: { actionId: string, target: string, state: string, reasonCode: string, previousValue: string, requestedValue: string }[], reasonCode: string, checks?: { headSha: string, runs: {…}[], rollup: string, observedAtUnixMs: string \| number }, rateLimit?: { limit: string \| number, remaining: string \| number, resetsAtUnixMs: string \| number, throttled: boolean, retryAfterUnixMs: string \| number } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.mergePull`           | call | `{ workspaceId: string, repository?: Record<string, JSON>, number?: string \| number, expectedHeadSha?: string, method?: string, commitTitle?: string, commitMessage?: string, expectedCheckRollup?: string }`            | `{ merged: boolean, mergeSha: string, reasonCode: string, pull?: { repository?: {…}, number: string \| number, id: string \| number, title: string, body: string, state: string, draft: boolean, author?: {…}, baseRef: string, headRef: string, headSha: string, headRepoFullName: string, fromFork: boolean, mergeable: string, allowedMergeMethods: string[], additions: string \| number, deletions: string \| number, changedFiles: string \| number, commits: string \| number, requestedReviewers: {…}[], labels: {…}[], createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number, mergedAtUnixMs: string \| number, closedAtUnixMs: string \| number, htmlUrl: string, observedAtUnixMs: string \| number }, checks?: { headSha: string, runs: {…}[], rollup: string, observedAtUnixMs: string \| number } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.deleteBranch`        | call | `{ workspaceId: string, repository?: Record<string, JSON>, branch?: string, expectedSha?: string }`                                                                                                                       | `{ deleted: boolean, reasonCode: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.linkReference`       | call | `{ workspaceId: string, reference?: Record<string, JSON>, expectedRevision?: string \| number }`                                                                                                                          | `{ referenceId: string, workspaceId: string, forge: string, repository?: { owner: string, name: string, apiBase: string, host: string }, kind: string, number: string \| number, targetKind: string, targetId: string, title: string, revision: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.unlinkReference`     | call | `{ workspaceId: string, referenceId?: string, expectedRevision?: string \| number }`                                                                                                                                      | `{ referenceId: string, unlinked: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`rate_limited`、`unsupported`、`unknown_outcome` | `github:write` | 1.11 | —      |
| `github.listReferences`      | call | `{ workspaceId: string, targetId?: string, afterId?: string, limit?: string \| number }`                                                                                                                                  | `{ references: ({ referenceId: string, workspaceId: string, forge: string, repository?: {…}, kind: string, number: string \| number, targetKind: string, targetId: string, title: string, revision: string \| number, createdAtUnixMs: string \| number, updatedAtUnixMs: string \| number })[], nextId: string, hasMore: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`rate_limited`、`unsupported`                                | `github:read`  | 1.11 | —      |

<!-- rpc:end -->

### 41.2 `forge.*`：Gitea / Forgejo / GitLab

实现在 `core/forge/routes.ts`：一份 `operations`，路由表里的旧 handler 与 procedure 都调它，拒绝的码与原话因此一样。旧路径（§29）全部保留，各挂在对应 procedure 的 `meta.legacy` 上。

- 入参是路径段、查询串与体并成的一张表，procedure 的入参就是它：`number`、`limit`、`expectedRevision` 在旧路径上是字符串，procedure 里是数字，两种拼法都收；GitLab 多级子组的 `owner`（`group/sub`）整条编码成一段。配置有两个路径形（只有主机、主机加仓库），各是一对 procedure（`putHostConfig` / `removeHostConfig`、`putRepoConfig` / `removeRepoConfig`）。
- 入参只校形状（字段的类型）：缺没缺、编号是否合法、`state` / `method` 是不是认识的值、字符串多长在域里判，不认识的值答 `bad_request`，旧路径与 procedure 的原话一样。只有**形状**错（类型不对）由契约的入参校验先答 `bad_request`（带 `details.issues`，只有字段路径与那句话，不带值）。
- 旧路径上带查询串的 `DELETE`（`?expectedRevision=`、`?headSha=`）：门面把空体的 `DELETE` 的查询串当作体交给上游路由（上游只读 `GET` 的查询串）。
- `createPull` 的旧路径答 `201`；procedure 的成功恒为 `200`，体相同。
- `resolve` 虽是 `POST`（地址在体里：远端地址可能带着凭据，不放查询串），只是读，权限 `github:read`（路由规则表里 `/api/forge/resolve` 单列一条）。
- 令牌只在 `putHostConfig` / `putRepoConfig` 的入参里出去一次，只进 SecretStore；答案、日志与错误细节都不带它，解析出来的入参表上的令牌用完就清。
- 失败的 `500` 码是 `internal`（从前是 `internal_error`，两个拼法是同一类失败），原话不外传。
- 权限与路由表给旧路径的一致：读是 `github:read`，写是 `github:write`。

<!-- rpc:begin contract=§41.2 -->

| procedure                | kind     | input                                                                                                                         | output                                                                                                                                                                                                                                                                                                                                                                                                               | errors                                                                                                                                                                                                  | scope          | 自   | 原路径                                                                    |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---- | ------------------------------------------------------------------------- |
| `forge.configs`          | query    | `{}`                                                                                                                          | `{ configs: ({ repoKey: string, forge: "github" \| "gitea" \| "gitlab", apiBase: string, credential: boolean, accountLogin: string \| null, revision: integer, createdAtMs: integer, updatedAtMs: integer })[] }`                                                                                                                                                                                                    | —                                                                                                                                                                                                       | `github:read`  | 1.11 | `GET /api/forge/configs`                                                  |
| `forge.putHostConfig`    | mutation | `{ forge?: string, apiBase?: string, token?: string, expectedRevision?: integer, host: string }`                              | `{ repoKey: string, forge: "github" \| "gitea" \| "gitlab", apiBase: string, credential: boolean, accountLogin: string \| null, revision: integer, createdAtMs: integer, updatedAtMs: integer }`                                                                                                                                                                                                                     | `bad_request`、`not_found`、`conflict`                                                                                                                                                                  | `github:write` | 1.11 | `PUT /api/forge/configs/{host}`                                           |
| `forge.removeHostConfig` | mutation | `{ host: string, expectedRevision?: number \| string }`                                                                       | `{ removed: boolean }`                                                                                                                                                                                                                                                                                                                                                                                               | `bad_request`、`not_found`、`conflict`                                                                                                                                                                  | `github:write` | 1.11 | `DELETE /api/forge/configs/{host}`                                        |
| `forge.putRepoConfig`    | mutation | `{ forge?: string, apiBase?: string, token?: string, expectedRevision?: integer, host: string, owner: string, name: string }` | `{ repoKey: string, forge: "github" \| "gitea" \| "gitlab", apiBase: string, credential: boolean, accountLogin: string \| null, revision: integer, createdAtMs: integer, updatedAtMs: integer }`                                                                                                                                                                                                                     | `bad_request`、`not_found`、`conflict`                                                                                                                                                                  | `github:write` | 1.11 | `PUT /api/forge/configs/{host}/{owner}/{name}`                            |
| `forge.removeRepoConfig` | mutation | `{ host: string, owner: string, name: string, expectedRevision: number \| string }`                                           | `{ removed: boolean }`                                                                                                                                                                                                                                                                                                                                                                                               | `bad_request`、`not_found`、`conflict`                                                                                                                                                                  | `github:write` | 1.11 | `DELETE /api/forge/configs/{host}/{owner}/{name}`                         |
| `forge.resolve`          | mutation | `{ remoteUrl?: string }`                                                                                                      | `{ repository: { host: string, owner: string, name: string }, forge: "github" \| "gitea" \| "gitlab" \| null, source: "github" \| "config" \| null, configKey: string \| null, apiBase: string \| null, webUrl: string \| null, credential: boolean, accountLogin: string \| null }`                                                                                                                                 | `bad_request`                                                                                                                                                                                           | `github:read`  | 1.11 | `POST /api/forge/resolve`                                                 |
| `forge.detect`           | query    | `{ host: string, owner: string, name: string }`                                                                               | `{ repository: { host: string, owner: string, name: string }, forge: "github" \| "gitea" \| "gitlab" \| null, source: "github" \| "config" \| null, configKey: string \| null, apiBase: string \| null, webUrl: string \| null, credential: boolean, accountLogin: string \| null }`                                                                                                                                 | `bad_request`                                                                                                                                                                                           | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}`                              |
| `forge.issues`           | query    | `{ host: string, owner: string, name: string, state?: string, cursor?: string, limit?: number \| string }`                    | `{ items: ({ number: integer, title: string, body: string, state: "open" \| "closed", author: string \| null, labels: string[], commentCount: integer, url: string, createdAtMs: integer, updatedAtMs: integer, closedAtMs: integer \| null })[], nextCursor: string \| null }`                                                                                                                                      | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/issues`                       |
| `forge.issue`            | query    | `{ host: string, owner: string, name: string, number: number \| string }`                                                     | `{ number: integer, title: string, body: string, state: "open" \| "closed", author: string \| null, labels: string[], commentCount: integer, url: string, createdAtMs: integer, updatedAtMs: integer, closedAtMs: integer \| null }`                                                                                                                                                                                 | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/issues/{number}`              |
| `forge.setIssueState`    | mutation | `{ host: string, owner: string, name: string, number: number \| string, state?: string }`                                     | `{ number: integer, title: string, body: string, state: "open" \| "closed", author: string \| null, labels: string[], commentCount: integer, url: string, createdAtMs: integer, updatedAtMs: integer, closedAtMs: integer \| null }`                                                                                                                                                                                 | `bad_request`、`not_found`、`conflict`、`rebase_started`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`unknown_outcome`、`forge_unavailable` | `github:write` | 1.11 | `PATCH /api/forge/repos/{host}/{owner}/{name}/issues/{number}`            |
| `forge.pulls`            | query    | `{ host: string, owner: string, name: string, state?: string, cursor?: string, limit?: number \| string }`                    | `{ items: ({ number: integer, title: string, body: string, state: "open" \| "closed" \| "merged", draft: boolean, author: string \| null, baseRef: string, headRef: string, headSha: string, mergeable: "mergeable" \| "conflicting" \| "unknown", url: string, createdAtMs: integer, updatedAtMs: integer, mergedAtMs: integer \| null, autoMerge?: boolean, fromFork?: boolean })[], nextCursor: string \| null }` | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/pulls`                        |
| `forge.createPull`       | mutation | `{ host: string, owner: string, name: string, title?: string, body?: string, head?: string, base?: string, draft?: boolean }` | `{ number: integer, title: string, body: string, state: "open" \| "closed" \| "merged", draft: boolean, author: string \| null, baseRef: string, headRef: string, headSha: string, mergeable: "mergeable" \| "conflicting" \| "unknown", url: string, createdAtMs: integer, updatedAtMs: integer, mergedAtMs: integer \| null, autoMerge?: boolean, fromFork?: boolean }`                                            | `bad_request`、`not_found`、`conflict`、`rebase_started`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`unknown_outcome`、`forge_unavailable` | `github:write` | 1.11 | `POST /api/forge/repos/{host}/{owner}/{name}/pulls`                       |
| `forge.pull`             | query    | `{ host: string, owner: string, name: string, number: number \| string }`                                                     | `{ number: integer, title: string, body: string, state: "open" \| "closed" \| "merged", draft: boolean, author: string \| null, baseRef: string, headRef: string, headSha: string, mergeable: "mergeable" \| "conflicting" \| "unknown", url: string, createdAtMs: integer, updatedAtMs: integer, mergedAtMs: integer \| null, autoMerge?: boolean, fromFork?: boolean }`                                            | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/pulls/{number}`               |
| `forge.pullFiles`        | query    | `{ host: string, owner: string, name: string, number: number \| string }`                                                     | `{ files: ({ path: string, previousPath: string \| null, status: "added" \| "modified" \| "removed" \| "renamed" \| "other", additions: integer, deletions: integer, patch: string \| null })[] }`                                                                                                                                                                                                                   | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/pulls/{number}/files`         |
| `forge.pullChecks`       | query    | `{ host: string, owner: string, name: string, number: number \| string }`                                                     | `{ headSha: string, rollup: "pending" \| "success" \| "failure" \| "neutral" \| "none", checks: ({ name: string, state: "pending" \| "success" \| "failure" \| "neutral", url: string \| null })[] }`                                                                                                                                                                                                                | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/pulls/{number}/checks`        |
| `forge.mergeOptions`     | query    | `{ host: string, owner: string, name: string }`                                                                               | `{ methods: ("merge" \| "squash" \| "rebase")[], autoMerge?: boolean, mergeTrain?: boolean }`                                                                                                                                                                                                                                                                                                                        | `bad_request`、`not_found`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`forge_unavailable`                                                  | `github:read`  | 1.11 | `GET /api/forge/repos/{host}/{owner}/{name}/merge-options`                |
| `forge.merge`            | mutation | `{ host: string, owner: string, name: string, number: number \| string, method?: string, headSha?: string }`                  | `{ merged: true, sha: string \| null }`                                                                                                                                                                                                                                                                                                                                                                              | `bad_request`、`not_found`、`conflict`、`rebase_started`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`unknown_outcome`、`forge_unavailable` | `github:write` | 1.11 | `POST /api/forge/repos/{host}/{owner}/{name}/pulls/{number}/merge`        |
| `forge.autoMerge`        | mutation | `{ host: string, owner: string, name: string, number: number \| string, method?: string, headSha?: string }`                  | `{ merged: boolean, sha: string \| null, train: boolean }`                                                                                                                                                                                                                                                                                                                                                           | `bad_request`、`not_found`、`conflict`、`rebase_started`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`unknown_outcome`、`forge_unavailable` | `github:write` | 1.11 | `POST /api/forge/repos/{host}/{owner}/{name}/pulls/{number}/auto-merge`   |
| `forge.cancelAutoMerge`  | mutation | `{ host: string, owner: string, name: string, number: number \| string }`                                                     | `{ cancelled: boolean }`                                                                                                                                                                                                                                                                                                                                                                                             | `bad_request`、`not_found`、`conflict`、`rebase_started`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`unknown_outcome`、`forge_unavailable` | `github:write` | 1.11 | `DELETE /api/forge/repos/{host}/{owner}/{name}/pulls/{number}/auto-merge` |
| `forge.deleteBranch`     | mutation | `{ host: string, owner: string, name: string, number: number \| string, headSha?: string }`                                   | `{ deleted: boolean, reasonCode: string }`                                                                                                                                                                                                                                                                                                                                                                           | `bad_request`、`not_found`、`conflict`、`rebase_started`、`forge_not_configured`、`forge_credential_rejected`、`forge_forbidden`、`forge_scope`、`rate_limited`、`unknown_outcome`、`forge_unavailable` | `github:write` | 1.11 | `DELETE /api/forge/repos/{host}/{owner}/{name}/pulls/{number}/branch`     |

<!-- rpc:end -->

## 42. `identity`、`security` 与 `accounts`：身份三域的会话内动作

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-7）。三个域各一节：§42.1 会话与设备（`identity.*`，与 §31 的 `identity.cloud.*` 同一个域），§42.2 加固（`security.*`，§18 的形状），§42.3 账号、凭据、邀请、组与共享（`accounts.*`，§10、§25 的形状）。§42.4 登记留在 REST 的匿名面与已经是契约的 §31–§33。自协议 1.13（minor 13）起。

通则：

- **一份实现**：会话内的每个动作是一个操作——`core/identity/accounts-http.ts` 的 `accountOperations` / `securityOperations`、`identity/http.ts` 的 `identityOperations`、OAuth 的提供方表、密钥与绑定（`identity/oauth/http.ts`）。旧路径（`/api/identity/` 是身份域的原样路由，先于契约的旧路径挂法）与 procedure（`identity/procedures.ts`）都调它。操作的入参是取值函数：旧路径照旧在认人之后才解析体，迁移前的判定顺序与答案逐字节不变（`core/contract/parity-identity.test.ts`）。
- **认人**：procedure 经的那道门（回环 §3.2、Gateway §17.4、中继 §32.3）已经认过这次请求的会话，请求身份里带着这条会话；操作按它再认一次——会话被撤、设备被撤、账号停用，下一次调用就 `401`，与旧路径每次认令牌是同一个效果。控制面 `/api/ws`（§35）上同样能调，连接的访问期到了而没续仍以 `4401` 关。没有门的只有显式打开了回环匿名主人的裸 core（`ARMADRA_LOOPBACK_OWNER=1`），那里按请求里的凭据认，与旧路径一样。
- **CSRF 只对 Cookie 会话**：`/api/rpc/` 只收 `POST`，Cookie 会话在门上对每一条核 `X-Armadra-CSRF`（读也要）；Bearer（桌面壳、原生 App、中继托管的页面）与控制面不核。旧路径照旧：Cookie 会话的写要、读不要。
- **权限**：`scope` 一列是路由表（`core/http/route-scopes.ts`）给旧路径的那一档。`/api/identity/` 是身份域自己判的那一段（`SELF_GUARDED`），门面按旧路径去问路由门，对成员放行，判定在身份域、按请求主体：本人的东西（设备列表、passkey、两步验证、会话、OAuth 绑定、兑换邀请）登录即可；「管别人的」要 `identity:manage`；组 `admin` 管自己的组（加减成员、指向本组的邀请、给本组成员签重置链接）；共享看那块画布上的 `workspace:share`。成员越权一律 `403 forbidden`；别人的会话、passkey 与 OAuth 绑定答 `404`，不说它在不在。撤设备要 `identity:manage`，成员撤不了自己的设备（与旧路径相同）。
- **错误**：身份域的大写码换成注册表的码——`UNAUTHENTICATED` → `unauthenticated`、`PERMISSION_DENIED` → `forbidden`、`INVALID_ARGUMENT` → `bad_request`、`CONFLICT` → `conflict`、`NOT_FOUND` → `not_found`、`NOT_IMPLEMENTED` → `not_implemented`，原话不变；§18 的具名码（口令策略 `password_*`、`passkey_*`、`mfa_*`、`oauth_*`）码与状态都不变。限流与锁定答 `429`（`rate_limited` / `account_locked`），等待的秒数在 `details.retryAfterSeconds`（旧路径是 `Retry-After` 头；自协议 1.14 起 procedure 的 HTTP 响应也带这个头，见 §43.5）。入参**形状**错由契约先答 `bad_request`（`details.issues` 只有字段路径与那句话，不带值）。旧路径的码不变：仍是大写码，已装机的原生 App 认的就是它们。
- **凭据不外泄**：口令、OAuth client secret、邀请令牌只在入参里；签发的明文（邀请令牌、重置令牌、TOTP 密钥、恢复码）只在签发那一次的答案里，库里只有哈希或在 SecretStore。门面的日志只记 procedure 名与错误消息，不记入参与出参；审计记动作与对象，不记口令与令牌。
- 旧路径答 `201` 的那几条（建账号、设口令、签邀请、建组、签重置链接、登记 passkey），procedure 的成功恒为 `200`，体相同。
- 设备撤销的 `expectedRevision` 是读到那一行时的 `epoch`，对不上答 `409 conflict`。审计的筛选与旧路径的查询串同名（`action` 可重复）；写错的数字答 `400`，`limit` 缺省、不是整数或越界都取 100。

### 42.1 `identity.*`：会话与设备

<!-- rpc:begin contract=§42.1 -->

| procedure                 | kind     | input                                            | output                                                                                                                                                                                                                                                                                             | errors                                                                 | scope             | 自   | 原路径                              |
| ------------------------- | -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- | ---- | ----------------------------------- |
| `identity.session`        | query    | 可省 `{}`                                        | `{ hostId: string, device: { deviceId: string, principalId: string, displayName: string, role: string, createdAtUnixMs: number, revision: number }, scopes: { permission: string, workspaceId: string, executionHostId: string }[], expiresAtUnixMs: number }`                                     | `unauthenticated`、`forbidden`                                         | `identity:read`   | 1.13 | `GET /api/identity/session`         |
| `identity.devices.list`   | query    | 可省 `{ afterId?: string, limit?: number }`      | `{ devices: ({ deviceId: string, principalId: string, name: string, role: string, epoch: number, createdAtMs: number, revokedAtMs: number, platform?: "macos" \| "windows" \| "linux" \| "ios" \| "android" \| "web" \| "unknown", lastSeenAtMs?: number })[], nextId: string, hasMore: boolean }` | `unauthenticated`、`forbidden`、`bad_request`                          | `identity:read`   | 1.13 | `GET /api/identity/devices`         |
| `identity.devices.revoke` | mutation | `{ deviceId: string, expectedRevision: number }` | `{ deviceId: string, revoked: true }`                                                                                                                                                                                                                                                              | `unauthenticated`、`forbidden`、`bad_request`、`not_found`、`conflict` | `identity:manage` | 1.13 | `POST /api/identity/devices/revoke` |

<!-- rpc:end -->

### 42.2 `security.*`：passkey、两步验证、会话、锁定、OAuth 与审计

- `oauth.providers` 要会话：有 `identity:manage` 的人看到回调地址、有没有密钥等，其余只看到能用的那几个的 `id` 与 `kind`。登录页还没有会话，匿名读留在旧路径（§42.4）。
- `mfa.disable` 与 `mfa.regenerateRecoveryCodes` 要一个当前有效的码，码不对计入锁定；锁着时答 `429 account_locked`。页面的 Bearer 传输对具名的 `401`（`mfa_invalid_code`）不续期重发，只有会话失效（`unauthenticated`）才换一枚访问密钥再发一次。

<!-- rpc:begin contract=§42.2 -->

| procedure                              | kind     | input                                                                                                                                           | output                                                                                                                                                                                                                                                            | errors                                                                          | scope             | 自   | 原路径                                                     |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------- | ---- | ---------------------------------------------------------- |
| `security.passkeys.list`               | query    | 可省 `{}`                                                                                                                                       | `{ available: boolean, rpId: string, reason: string, passkeys: { credentialId: string, label: string, aaguid: string, transports: string[], createdAtMs: integer }[] }`                                                                                           | `unauthenticated`、`forbidden`                                                  | `identity:read`   | 1.13 | `GET /api/identity/passkey`                                |
| `security.passkeys.registerOptions`    | mutation | 可省 `{ label?: string }`                                                                                                                       | `{ challengeId: string, options: Record<string, JSON> }`                                                                                                                                                                                                          | `unauthenticated`、`forbidden`、`bad_request`                                   | `identity:manage` | 1.13 | `POST /api/identity/passkey/register/options`              |
| `security.passkeys.registerVerify`     | mutation | `{ challengeId: string, response: Record<string, JSON>, label?: string }`                                                                       | `{ credentialId: string, label: string, aaguid: string, transports: string[], createdAtMs: integer }`                                                                                                                                                             | `unauthenticated`、`forbidden`、`bad_request`、`conflict`                       | `identity:manage` | 1.13 | `POST /api/identity/passkey/register/verify`               |
| `security.passkeys.rename`             | mutation | `{ credentialId: string, label: string }`                                                                                                       | `{ credentialId: string, label: string }`                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                      | `identity:manage` | 1.13 | `PATCH /api/identity/passkey/{credentialId}`               |
| `security.passkeys.remove`             | mutation | `{ credentialId: string }`                                                                                                                      | `{ credentialId: string, removed: true }`                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                      | `identity:manage` | 1.13 | `DELETE /api/identity/passkey/{credentialId}`              |
| `security.mfa.status`                  | query    | 可省 `{}`                                                                                                                                       | `{ enrolled: boolean, pending: boolean, enrolledAtMs: integer, verifiedAtMs: integer, recoveryCodesRemaining: integer, requireFor: "none" \| "members" \| "all", required: boolean }`                                                                             | `unauthenticated`、`forbidden`                                                  | `identity:read`   | 1.13 | `GET /api/identity/mfa`                                    |
| `security.mfa.enroll`                  | mutation | 可省 `{}`                                                                                                                                       | `{ secret: string, otpauthUri: string }`                                                                                                                                                                                                                          | `unauthenticated`、`forbidden`、`conflict`                                      | `identity:manage` | 1.13 | `POST /api/identity/mfa/totp/enroll`                       |
| `security.mfa.confirm`                 | mutation | `{ code: string }`                                                                                                                              | `{ recoveryCodes: string[] }`                                                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`bad_request`、`conflict`                       | `identity:manage` | 1.13 | `POST /api/identity/mfa/totp/confirm`                      |
| `security.mfa.disable`                 | mutation | `{ code: string }`                                                                                                                              | `{ disabled: true }`                                                                                                                                                                                                                                              | `unauthenticated`、`forbidden`、`rate_limited`、`account_locked`、`bad_request` | `identity:manage` | 1.13 | `POST /api/identity/mfa/disable`                           |
| `security.mfa.regenerateRecoveryCodes` | mutation | `{ code: string }`                                                                                                                              | `{ recoveryCodes: string[] }`                                                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`rate_limited`、`account_locked`、`bad_request` | `identity:manage` | 1.13 | `POST /api/identity/mfa/recovery-codes`                    |
| `security.mfa.reset`                   | mutation | `{ principalId: string }`                                                                                                                       | `{ principalId: string, reset: boolean }`                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`bad_request`                                   | `identity:manage` | 1.13 | `POST /api/identity/mfa/reset`                             |
| `security.sessions.list`               | query    | 可省 `{ all?: boolean }`                                                                                                                        | `{ sessions: { sessionId: string, principalId: string, deviceId: string, deviceName: string, createdAtMs: number, lastSeenAtMs: number, expiresAtMs: number, remoteIp: string, userAgent: string, current: boolean }[] }`                                         | `unauthenticated`、`forbidden`                                                  | `identity:read`   | 1.13 | `GET /api/identity/sessions`                               |
| `security.sessions.revoke`             | mutation | `{ sessionId: string }`                                                                                                                         | `{ sessionId: string, revoked: true }`                                                                                                                                                                                                                            | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                      | `identity:manage` | 1.13 | `DELETE /api/identity/sessions/{sessionId}`                |
| `security.sessions.revokeOthers`       | mutation | 可省 `{}`                                                                                                                                       | `{ revoked: number }`                                                                                                                                                                                                                                             | `unauthenticated`、`forbidden`                                                  | `identity:manage` | 1.13 | `POST /api/identity/sessions/revoke-others`                |
| `security.lockouts.list`               | query    | 可省 `{}`                                                                                                                                       | `{ lockouts: { key: string, principalId: string, failures: integer, lockedUntilMs: integer }[] }`                                                                                                                                                                 | `unauthenticated`、`forbidden`                                                  | `identity:manage` | 1.13 | `GET /api/identity/lockouts`                               |
| `security.lockouts.clear`              | mutation | `{ principalId: string }`                                                                                                                       | `{ principalId: string, unlocked: boolean }`                                                                                                                                                                                                                      | `unauthenticated`、`forbidden`、`bad_request`                                   | `identity:manage` | 1.13 | `DELETE /api/identity/lockouts/{principalId}`              |
| `security.oauth.providers`             | query    | 可省 `{}`                                                                                                                                       | `{ configured: boolean, providers: ({ id: string, kind: "github" \| "oidc", issuer?: string, clientId?: string, enabled?: boolean, allowSignup?: boolean, allowedDomains?: string[], hasClientSecret?: boolean, usable?: boolean, callbackUrls?: string[] })[] }` | `unauthenticated`、`forbidden`                                                  | `identity:read`   | 1.13 | `GET /api/identity/oauth/providers`                        |
| `security.oauth.setSecret`             | mutation | `{ providerId: string, clientSecret: string }`                                                                                                  | `{ id: string, hasClientSecret: boolean }`                                                                                                                                                                                                                        | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                      | `identity:manage` | 1.13 | `PUT /api/identity/oauth/providers/{providerId}/secret`    |
| `security.oauth.clearSecret`           | mutation | `{ providerId: string }`                                                                                                                        | `{ id: string, hasClientSecret: boolean }`                                                                                                                                                                                                                        | `unauthenticated`、`forbidden`、`not_found`                                     | `identity:manage` | 1.13 | `DELETE /api/identity/oauth/providers/{providerId}/secret` |
| `security.oauth.bindings`              | query    | 可省 `{}`                                                                                                                                       | `{ bindings: ({ credentialId: string, providerId: string, kind: "github" \| "oidc", createdAtMs: integer })[] }`                                                                                                                                                  | `unauthenticated`、`forbidden`                                                  | `identity:read`   | 1.13 | `GET /api/identity/oauth/bindings`                         |
| `security.oauth.unbind`                | mutation | `{ credentialId: string }`                                                                                                                      | `{ credentialId: string, revoked: true }`                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`not_found`                                     | `identity:manage` | 1.13 | `DELETE /api/identity/oauth/bindings/{credentialId}`       |
| `security.audit.list`                  | query    | 可省 `{ principalId?: string, workspaceId?: string, action?: string[], sinceMs?: number, untilMs?: number, beforeId?: number, limit?: number }` | `{ entries: { id: number, atMs: number, principalId: string, deviceId: string, action: string, target: string, workspaceId: string, detail: JSON }[], nextBeforeId: number }`                                                                                     | `unauthenticated`、`forbidden`、`bad_request`                                   | `identity:read`   | 1.13 | `GET /api/identity/audit`                                  |

<!-- rpc:end -->

### 42.3 `accounts.*`：账号、凭据、邀请、组与共享

- `credentials.setPassword` 先过口令策略与泄露检查（§18.1），换了口令撤掉这个人的其它会话（本人换时留下当前这个）；`kind` 只认 `password`，别的答 `501 not_implemented`。
- `invitations.accept` 是已登录的人兑换；新来的人持邀请注册（建账号、兑换、登录）发的是会话，在旧路径上（§42.4）。

<!-- rpc:begin contract=§42.3 -->

| procedure                                | kind     | input                                                                                                                            | output                                                                                                                                                                                                                                                       | errors                                                                        | scope             | 自   | 原路径                                                        |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------- | ---- | ------------------------------------------------------------- |
| `accounts.principals.list`               | query    | 可省 `{}`                                                                                                                        | `{ principals: ({ principalId: string, kind: "owner" \| "member" \| "service", displayName: string, createdAtMs: number, disabledAtMs: number, hasPassword: boolean })[] }`                                                                                  | `unauthenticated`、`forbidden`                                                | `identity:read`   | 1.13 | `GET /api/identity/principals`                                |
| `accounts.principals.create`             | mutation | `{ displayName: string, kind?: string }`                                                                                         | `{ principalId: string, kind: "owner" \| "member" \| "service", displayName: string, createdAtMs: number, disabledAtMs: number, hasPassword: boolean }`                                                                                                      | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:manage` | 1.13 | `POST /api/identity/principals`                               |
| `accounts.principals.disable`            | mutation | `{ principalId: string }`                                                                                                        | `{ disabled: true }`                                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `identity:manage` | 1.13 | `POST /api/identity/principals/{principalId}/disable`         |
| `accounts.principals.issuePasswordReset` | mutation | `{ principalId: string }`                                                                                                        | `{ token: string, expiresAtMs: number }`                                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `identity:manage` | 1.13 | `POST /api/identity/principals/{principalId}/password-reset`  |
| `accounts.credentials.list`              | query    | `{ principalId: string }`                                                                                                        | `{ credentials: { credentialId: string, principalId: string, kind: string, provider: string, createdAtMs: number, revokedAtMs: number }[] }`                                                                                                                 | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:read`   | 1.13 | `GET /api/identity/credentials`                               |
| `accounts.credentials.setPassword`       | mutation | `{ principalId: string, password: string, kind?: string }`                                                                       | `{ credentialId: string, revokedSessions: number, passwordBreached?: true }`                                                                                                                                                                                 | `unauthenticated`、`forbidden`、`bad_request`、`not_found`、`not_implemented` | `identity:manage` | 1.13 | `POST /api/identity/credentials`                              |
| `accounts.credentials.revoke`            | mutation | `{ credentialId: string }`                                                                                                       | `{ revoked: true }`                                                                                                                                                                                                                                          | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `identity:manage` | 1.13 | `DELETE /api/identity/credentials/{credentialId}`             |
| `accounts.invitations.list`              | query    | 可省 `{}`                                                                                                                        | `{ invitations: ({ invitationId: string, issuedBy: string, role: string, targetGroupId: string, targetWorkspaceId: string, createdAtMs: number, expiresAtMs: number, consumedBy: string, consumedAtMs: number, maxUses: number \| null, uses: number })[] }` | `unauthenticated`、`forbidden`                                                | `identity:read`   | 1.13 | `GET /api/identity/invitations`                               |
| `accounts.invitations.issue`             | mutation | `{ role: string, targetGroupId?: string \| null, targetWorkspaceId?: string \| null, ttlMs?: number, maxUses?: number \| null }` | `{ invitationId: string, token: string, expiresAtMs: number, role: string, targetGroupId: string, targetWorkspaceId: string, maxUses: number \| null }`                                                                                                      | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `identity:manage` | 1.13 | `POST /api/identity/invitations`                              |
| `accounts.invitations.revoke`            | mutation | `{ invitationId: string }`                                                                                                       | `{ revoked: true }`                                                                                                                                                                                                                                          | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `identity:manage` | 1.13 | `DELETE /api/identity/invitations/{invitationId}`             |
| `accounts.invitations.accept`            | mutation | `{ invitationId: string, token: string }`                                                                                        | `{ role: string, groupId: string, workspaceId: string }`                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:read`   | 1.13 | `POST /api/identity/invitations/{invitationId}/accept`        |
| `accounts.groups.list`                   | query    | 可省 `{}`                                                                                                                        | `{ groups: { groupId: string, name: string, ownerPrincipalId: string, createdAtMs: number, members: {…}[] }[] }`                                                                                                                                             | `unauthenticated`、`forbidden`                                                | `identity:read`   | 1.13 | `GET /api/identity/groups`                                    |
| `accounts.groups.create`                 | mutation | `{ name: string }`                                                                                                               | `{ groupId: string, name: string, createdAtMs: number }`                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:manage` | 1.13 | `POST /api/identity/groups`                                   |
| `accounts.groups.rename`                 | mutation | `{ groupId: string, name: string }`                                                                                              | `{ groupId: string, renamed: true }`                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:manage` | 1.13 | `PATCH /api/identity/groups/{groupId}`                        |
| `accounts.groups.remove`                 | mutation | `{ groupId: string }`                                                                                                            | `{ groupId: string, deleted: true }`                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:manage` | 1.13 | `DELETE /api/identity/groups/{groupId}`                       |
| `accounts.groups.putMember`              | mutation | `{ groupId: string, principalId: string, role?: string }`                                                                        | `{ groupId: string, principalId: string }`                                                                                                                                                                                                                   | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `identity:manage` | 1.13 | `PUT /api/identity/groups/{groupId}/members/{principalId}`    |
| `accounts.groups.removeMember`           | mutation | `{ groupId: string, principalId: string }`                                                                                       | `{ groupId: string, principalId: string, removed: true }`                                                                                                                                                                                                    | `unauthenticated`、`forbidden`、`bad_request`                                 | `identity:manage` | 1.13 | `DELETE /api/identity/groups/{groupId}/members/{principalId}` |
| `accounts.grants.list`                   | query    | `{ workspaceId: string }`                                                                                                        | `{ workspaceId: string, grants: ({ grantId: string, subjectKind: "principal" \| "group", subjectId: string, workspaceId: string, role: string, grantedBy: string, createdAtMs: number, permissions: string[] })[], roles: string[] }`                        | `unauthenticated`、`forbidden`、`bad_request`                                 | `workspace:share` | 1.13 | `GET /api/identity/grants`                                    |
| `accounts.grants.put`                    | mutation | `{ workspaceId: string, subjectKind: string, subjectId: string, role: string }`                                                  | `{ grantId: string, subjectKind: "principal" \| "group", subjectId: string, workspaceId: string, role: string, grantedBy: string, createdAtMs: number, permissions: string[] }`                                                                              | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `workspace:share` | 1.13 | `PUT /api/identity/grants`                                    |
| `accounts.grants.revoke`                 | mutation | `{ workspaceId: string, subjectKind: string, subjectId: string }`                                                                | `{ revoked: true }`                                                                                                                                                                                                                                          | `unauthenticated`、`forbidden`、`bad_request`、`not_found`                    | `workspace:share` | 1.13 | `DELETE /api/identity/grants`                                 |

<!-- rpc:end -->

### 42.4 留在 REST 的匿名面与已有契约

下面这些先于会话存在、要发或清 Cookie，或者是字节流，不在契约里，旧路径照旧（凭据换会话的那几条各自认自己的凭据，配对、刷新、换 CSRF、登出走「只有失败才扣」的来源地址桶，登录类走每次扣的那一档）：

| 路径                                                                                              | 为什么留在 REST                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/identity/hello`                                                                         | 配对之前就要知道「这台 core 是谁」（§3）；会话内的同一份是 `system.hello`（§34.2）                 |
| `POST /api/identity/pair`                                                                         | 票换会话（§3.2）                                                                                   |
| `POST /api/identity/ws-ticket`                                                                    | 浏览器的升级带不了头：Bearer 传输拿访问密钥换一张 30 秒的一次性票（§3.2）                          |
| `POST /api/identity/session/refresh`、`…/session/csrf`、`…/session/logout`                        | 拿刷新令牌换新令牌、换 CSRF、结束会话，发或清 Cookie                                               |
| `GET /api/identity/session`                                                                       | `identity.session` 是同一份；页面开张时判「有没有会话」仍读旧路径——那时 Cookie 会话手里还没有 CSRF |
| `POST /api/identity/login`、`…/mfa/verify`、`…/passkey/login/options`、`…/passkey/login/verify`   | 登录与两步登录（§18.1–§18.3）                                                                      |
| `POST /api/identity/register`                                                                     | 持邀请注册（§10）；不带邀请的开放注册答 `501`                                                      |
| `GET /api/identity/oauth/providers`（匿名）                                                       | 登录页的提供方按钮                                                                                 |
| `POST /api/identity/oauth/{providerId}/start`、`GET …/callback`、`POST …/native`、`POST …/logout` | OAuth 发起、回调与原生收尾（§18.5）：浏览器绑定 Cookie 与一次性 `state`                            |
| `GET` / `POST /api/identity/password-reset/{token}`                                               | 重置链接（§25）：令牌本身就是凭据                                                                  |
| `GET /api/identity/audit/export`                                                                  | 审计导出是 CSV 字节流（§18.6）                                                                     |
| `POST /api/identity/cloud/login`                                                                  | 远程服务的断言换本机会话（§31.3）                                                                  |

已经是契约的（平台设计直接按契约写，这里只登记）：§31 `identity.cloud.*`（云登录与登记，`login` 是唯一的匿名 procedure、只经旧路径），§32 隧道面（core 作为出站隧道客户端，不是 procedure），§33 `sources.*`（客户端源表与远程服务）。

`system.hello` / `system.ping`（§34.2–§34.3）与控制面的升级（§35.1）要 `identity:read`，没有旧路径：路由门对全局的 `identity:read` 按主体判（`identity/route-access.ts`），每个登录主体的会话快照里都有它，成员也过得去。§42 的 procedure 都挂在 `/api/identity/` 的旧路径上，不经这一条。

## 43. `acp`、`workflows`、`coordinator`、`push`、`mail`、`credentials`、`gateway` 与 `diagnostics`

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-8）。第一部分三个域各一节：§43.1 是 ACP 会话（`acp.*`，§14 的形状），§43.2 是工作流的草案、模板、运行与关卡（`workflows.*`，§15 的形状），§43.3 是分派抽屉的任务读与重试（`coordinator.*`，§15.7 的形状）。自协议 1.12（minor 12）起。E3-8 的第二部分是 §43.4 `push.*`（§19、§27 的形状）、§43.5 `mail.*`（§28）、§43.6 `credentials.*`（§20.2）、§43.7 `gateway.*`（§17、§24）、§43.8 `diagnostics.*`（§30），自协议 1.14（minor 14）起；它们的通则在 §43.4 之前的「通则」之后单列一段，各节只写与旧路径不同的地方。

通则：

- 旧路径（§14.2、§15）全部保留，各挂在对应 procedure 的 `meta.legacy` 上；旧 handler 与 procedure 调同一份操作实现，拒绝的码、状态与原话一样（procedure 多一个 `requestId`）。形状错（缺字段除外，类型不对）由契约的入参校验先答 `400 bad_request`（带 `details.issues`），与迁移前域里那句原话不同，码与状态不变。
- 入参只校形状。缺没缺字段、取值认不认识、草案与模板的长度与引用，仍在域里判（`core/workflow/draft.ts` 的手写校验，拒绝码 `invalid_draft` 等），所以草案与模板的正文在契约里是一份 JSON 对象，不用页面那份带交叉校验的 `workflowDraftSchema`；页面读回时再解析一遍。
- 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致，`meta.scope` 逐条等于它：ACP 读镜像是 `terminal:read`，开会话与写会话是 `terminal:create`；工作流与任务的读是 `canvas:read`，写是 `agent:launch`。服务器壳上 procedure 与旧路径过同一道路由门（`identity/route-access.ts`）：门面按 `meta.legacy` 把入参还原成旧路径去问（旧路径上读与删的入参在查询串里，门面还原时一并放进查询串，路由门里按查询串取 `boardId` 的规则因此对两条路一样）。
- **投递与审批语义不变**：提示照旧是人类驾驶者写进会话（与终端里敲键同一条租约语义）；`acp.*` 里没有答审批与 elicitation 的动词，人替 Agent 回答走 `agents.answerApproval`（§39.3，`approval:answer`）；工作流关卡的答复是 `agent:launch`（operator），不是替 Agent 代答；协调者任务的重试仍经协作域的投递门。
- 旧路径整段在 `server.raw` 上的工作流（原来由 `/api/workflows/` 前缀接管）改进路由表，每条各有路径模式；意外的内部错误现在由门面统一答 `500 internal` 并上报，不再是旧 handler 自己吞掉后答的 `internal_error`。

### 43.1 `acp.*`：ACP 会话

实现在 `core/acp/routes.ts`：一份操作，路由表里的旧 handler 与 `registerProcedures(server, "acp", …)` 调同一份；ACP 自己的错误（`AcpError`）换成同码同状态的拒绝。

- 会话是 `terminal_sessions` 的一行，起会话的答案就是那一行；同一个节点已有活着的 ACP 会话时答那一行，结束了的在同一行上起下一代并接回；有活着的**终端**会话时 `409 conflict`（先切换驱动）。
- ACP 自己的拒绝码（`acp_unsupported`、`acp_not_installed`、`acp_mode_unsupported` 为 400，`acp_mode_unavailable`、`acp_model_unavailable`、`acp_model_unsupported`、`acp_auth_required`、`acp_session`、`awaiting_approval` 为 409，其余 502）原样透出，状态沿用。
- `cancel`、`setMode`、`setModel` 旧路径答 `204`，procedure 成功恒为 `200`、无体。`log` 的 `after` 在旧路径上是查询串里的字符串，procedure 里数字与字符串都收。
- 服务器壳上：开会话与开终端同一档（并记下创建者；拿别的画布上的节点来起是跨工作空间，被拒）；读镜像是看终端；往不是自己开的会话里写（提示、打断、切模式与模型）与切换别人节点的驱动要 `terminal:drive`。被拒时会话里什么都没写。
- 镜像读只给规范化后的转录条目与此刻挂着的模式、模型、审批与 elicitation 卡片，不含凭据；原始输出不进日志与事件。

<!-- rpc:begin contract=§43.1 -->

| procedure           | kind     | input                                                                                                                                                  | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | errors                                              | scope             | 自   | 原路径                                      |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------- | ---- | ------------------------------------------- |
| `acp.createSession` | mutation | `{ workspaceId?: string, nodeId?: string, cwd?: string, agentId?: string, permissionMode?: string, model?: string, resume?: string, prompt?: string }` | `{ id: string, workspaceId: string, cwd: string, shell: string, agentId?: string \| null, command: string \| null, status: "running" \| "exited" \| "failed" \| "terminated", exitCode: integer \| null, pid?: integer \| null, createdAt: string, endedAt: string \| null, sessionKey?: string, backend?: "direct" \| "tmux" \| "sessionHost" \| "acp", generation?: integer, attachState?: "detached" \| "live" \| "exited", lastOutputAt?: string \| null, hibernation?: "hibernated" \| null, creatorPrincipalId?: string, kind?: string, ownerNodeId?: string \| null }` | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:create` | 1.12 | `POST /api/acp/sessions`                    |
| `acp.prompt`        | mutation | `{ sessionId: string, text?: string }`                                                                                                                 | `{ turnId: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:create` | 1.12 | `POST /api/acp/sessions/{sessionId}/prompt` |
| `acp.cancel`        | mutation | `{ sessionId: string }`                                                                                                                                | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `forbidden`、`not_found`、`conflict`                | `terminal:create` | 1.12 | `POST /api/acp/sessions/{sessionId}/cancel` |
| `acp.setMode`       | mutation | `{ sessionId: string, modeId?: string }`                                                                                                               | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:create` | 1.12 | `POST /api/acp/sessions/{sessionId}/mode`   |
| `acp.setModel`      | mutation | `{ sessionId: string, modelId?: string }`                                                                                                              | 无                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:create` | 1.12 | `PUT /api/acp/sessions/{sessionId}/model`   |
| `acp.log`           | query    | `{ sessionId: string, after?: number \| string }`                                                                                                      | `{ entries: { role: string, blocks: Record<string, JSON>[], endOffset: integer, at?: string }[], endOffset: integer, modes?: Record<string, JSON> \| null, models?: Record<string, JSON> \| null, pending?: Record<string, JSON>[], elicitations?: Record<string, JSON>[] }`                                                                                                                                                                                                                                                                                                  | `forbidden`、`not_found`                            | `terminal:read`   | 1.12 | `GET /api/acp/sessions/{sessionId}/log`     |
| `acp.switchDriver`  | mutation | `{ nodeId: string, driver?: string }`                                                                                                                  | `{ sessionId: string, resumed: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `bad_request`、`forbidden`、`not_found`、`conflict` | `terminal:create` | 1.12 | `POST /api/acp/nodes/{nodeId}/driver`       |

<!-- rpc:end -->

### 43.2 `workflows.*`：草案、模板、运行与关卡

实现在 `core/workflow/routes.ts`（`workflowOperations`）：旧路径的 handler 先把路径参数、查询串与体读出来再调它，`registerProcedures(server, "workflows", …)` 登记同一份。

- 路径里没有工作空间：草案与运行按 `boardId` 过滤（服务器壳上必须带，按它查出画布），模板是本机共用的一份库——在任意一块画布上能起 Agent 的成员能读，**改模板（新建、修改、删除、升级计划）只有 owner**。
- 旧路径 `POST /api/workflows/templates` 与 `POST /api/workflows/runs` 答 `201`，procedure 成功恒为 `200`，体相同；`deleteTemplate` 答 `204` / `200` 无体。
- `upgradeSchedules` 的工作空间在 `workspaceId`；旧路径把它放在查询串里（`?workspaceId=`），两种拼法都送到自动化域的桥上。没有自动化域时答 `501 unsupported`（从前是 409，随错误码注册表里 `unsupported` 的状态统一）。
- 关卡答复与取消运行是 `agent:launch`，要运行所在画布上的 operator；放行或拦下一次运行，不是替 Agent 代答，所以不是 `approval:answer`（§23）。

<!-- rpc:begin contract=§43.2 -->

| procedure                    | kind     | input                                                                      | output                                                                                                                                                                                                                                                                                                                                                                                                              | errors                                              | scope          | 自   | 原路径                                                         |
| ---------------------------- | -------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- | ---- | -------------------------------------------------------------- |
| `workflows.drafts`           | query    | `{ boardId?: string, status?: string }`                                    | `{ drafts: ({ id: string, workspaceId: string, boardId: string, proposerNodeId: string \| null, status: "pending" \| "confirmed" \| "discarded", templateId: string \| null, draft: Record<string, JSON>, createdAt: string, updatedAt: string })[] }`                                                                                                                                                              | `forbidden`                                         | `canvas:read`  | 1.12 | `GET /api/workflows/drafts`                                    |
| `workflows.draft`            | query    | `{ draftId: string }`                                                      | `{ draft: { id: string, workspaceId: string, boardId: string, proposerNodeId: string \| null, status: "pending" \| "confirmed" \| "discarded", templateId: string \| null, draft: Record<string, JSON>, createdAt: string, updatedAt: string } }`                                                                                                                                                                   | `forbidden`、`not_found`                            | `canvas:read`  | 1.12 | `GET /api/workflows/drafts/{draftId}`                          |
| `workflows.confirmDraft`     | mutation | `{ draftId: string, name?: string, draft?: Record<string, JSON> }`         | `{ draft: { id: string, workspaceId: string, boardId: string, proposerNodeId: string \| null, status: "pending" \| "confirmed" \| "discarded", templateId: string \| null, draft: Record<string, JSON>, createdAt: string, updatedAt: string }, template: { id: string, name: string, version: integer, createdFromDraft: string \| null, template: Record<string, JSON>, createdAt: string, updatedAt: string } }` | `bad_request`、`forbidden`、`not_found`、`conflict` | `agent:launch` | 1.12 | `POST /api/workflows/drafts/{draftId}/confirm`                 |
| `workflows.discardDraft`     | mutation | `{ draftId: string }`                                                      | `{ draft: { id: string, workspaceId: string, boardId: string, proposerNodeId: string \| null, status: "pending" \| "confirmed" \| "discarded", templateId: string \| null, draft: Record<string, JSON>, createdAt: string, updatedAt: string } }`                                                                                                                                                                   | `forbidden`、`not_found`、`conflict`                | `agent:launch` | 1.12 | `POST /api/workflows/drafts/{draftId}/discard`                 |
| `workflows.templates`        | query    | 可省 `{}`                                                                  | `{ templates: ({ id: string, name: string, version: integer, createdFromDraft: string \| null, template: Record<string, JSON>, createdAt: string, updatedAt: string })[] }`                                                                                                                                                                                                                                         | `forbidden`                                         | `canvas:read`  | 1.12 | `GET /api/workflows/templates`                                 |
| `workflows.createTemplate`   | mutation | `{ name?: string, template?: Record<string, JSON> }`                       | `{ template: { id: string, name: string, version: integer, createdFromDraft: string \| null, template: Record<string, JSON>, createdAt: string, updatedAt: string } }`                                                                                                                                                                                                                                              | `bad_request`、`forbidden`                          | `agent:launch` | 1.12 | `POST /api/workflows/templates`                                |
| `workflows.template`         | query    | `{ templateId: string }`                                                   | `{ template: { id: string, name: string, version: integer, createdFromDraft: string \| null, template: Record<string, JSON>, createdAt: string, updatedAt: string } }`                                                                                                                                                                                                                                              | `forbidden`、`not_found`                            | `canvas:read`  | 1.12 | `GET /api/workflows/templates/{templateId}`                    |
| `workflows.updateTemplate`   | mutation | `{ templateId: string, name?: string, template?: Record<string, JSON> }`   | `{ template: { id: string, name: string, version: integer, createdFromDraft: string \| null, template: Record<string, JSON>, createdAt: string, updatedAt: string }, frozenSchedules: ({ scheduleId: string, workspaceId: string, templateVersion: integer, reason: "compatible" \| "missing_params" \| "param_mismatch", missingParams: string[], unknownParams: string[] })[] }`                                  | `bad_request`、`forbidden`、`not_found`、`conflict` | `agent:launch` | 1.12 | `PUT /api/workflows/templates/{templateId}`                    |
| `workflows.upgradeSchedules` | mutation | `{ templateId: string, workspaceId?: string, scheduleIds?: string[] }`     | `{ upgraded: { scheduleId: string, revision: integer }[], frozen: ({ scheduleId: string, reason: "compatible" \| "missing_params" \| "param_mismatch" \| "not_found" \| "forbidden" \| "conflict" \| "failed", missingParams: string[], unknownParams: string[] })[] }`                                                                                                                                             | `bad_request`、`forbidden`、`not_found`、`conflict` | `agent:launch` | 1.12 | `POST /api/workflows/templates/{templateId}/upgrade-schedules` |
| `workflows.deleteTemplate`   | mutation | `{ templateId: string }`                                                   | 无                                                                                                                                                                                                                                                                                                                                                                                                                  | `forbidden`、`not_found`                            | `agent:launch` | 1.12 | `DELETE /api/workflows/templates/{templateId}`                 |
| `workflows.runs`             | query    | `{ templateId?: string, boardId?: string, limit?: number \| string }`      | `{ runs: ({ id: string, templateId: string, templateVersion: integer, title: string, workspaceId: string, boardId: string, frameId: string \| null, params: Record<string, string>, status: "running" \| "waiting" \| "succeeded" \| "failed" \| "cancelled", reason: string \| null, roles: Record<string, string>, startedAt: string, endedAt: string \| null, steps: {…}[] })[] }`                               | `forbidden`                                         | `canvas:read`  | 1.12 | `GET /api/workflows/runs`                                      |
| `workflows.startRun`         | mutation | `{ templateId?: string, params?: Record<string, JSON>, boardId?: string }` | `{ run: { id: string, templateId: string, templateVersion: integer, title: string, workspaceId: string, boardId: string, frameId: string \| null, params: Record<string, string>, status: "running" \| "waiting" \| "succeeded" \| "failed" \| "cancelled", reason: string \| null, roles: Record<string, string>, startedAt: string, endedAt: string \| null, steps: {…}[] } }`                                    | `bad_request`、`forbidden`、`not_found`、`conflict` | `agent:launch` | 1.12 | `POST /api/workflows/runs`                                     |
| `workflows.run`              | query    | `{ runId: string }`                                                        | `{ run: { id: string, templateId: string, templateVersion: integer, title: string, workspaceId: string, boardId: string, frameId: string \| null, params: Record<string, string>, status: "running" \| "waiting" \| "succeeded" \| "failed" \| "cancelled", reason: string \| null, roles: Record<string, string>, startedAt: string, endedAt: string \| null, steps: {…}[] } }`                                    | `forbidden`、`not_found`                            | `canvas:read`  | 1.12 | `GET /api/workflows/runs/{runId}`                              |
| `workflows.cancelRun`        | mutation | `{ runId: string }`                                                        | `{ run: { id: string, templateId: string, templateVersion: integer, title: string, workspaceId: string, boardId: string, frameId: string \| null, params: Record<string, string>, status: "running" \| "waiting" \| "succeeded" \| "failed" \| "cancelled", reason: string \| null, roles: Record<string, string>, startedAt: string, endedAt: string \| null, steps: {…}[] } }`                                    | `forbidden`、`not_found`、`conflict`                | `agent:launch` | 1.12 | `POST /api/workflows/runs/{runId}/cancel`                      |
| `workflows.answerGate`       | mutation | `{ runId: string, stepId: string, decision?: string, note?: string }`      | `{ run: { id: string, templateId: string, templateVersion: integer, title: string, workspaceId: string, boardId: string, frameId: string \| null, params: Record<string, string>, status: "running" \| "waiting" \| "succeeded" \| "failed" \| "cancelled", reason: string \| null, roles: Record<string, string>, startedAt: string, endedAt: string \| null, steps: {…}[] } }`                                    | `bad_request`、`forbidden`、`not_found`、`conflict` | `agent:launch` | 1.12 | `POST /api/workflows/runs/{runId}/gates/{stepId}`              |

<!-- rpc:end -->

### 43.3 `coordinator.*`：分派抽屉

实现与 `workflows.*` 同在 `core/workflow/routes.ts`。一行只带状态、时刻、失败原因与「能不能重试」，不带任务提示词与成员的结果正文（正文留在库里）；重试是再投一次任务提示词，经协作域的投递门，投递不成功（队列满）答 `409 queue_full`，协作域没装好答 `501 unsupported`（从前是 409，同上）。读按 `boardId` 查出画布（服务器壳上必须带），重试按任务查出画布，要 `agent:launch`。

<!-- rpc:begin contract=§43.3 -->

| procedure           | kind     | input                  | output                                                                                                                                                                                                                                         | errors                               | scope          | 自   | 原路径                                     |
| ------------------- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------- | ---- | ------------------------------------------ |
| `coordinator.tasks` | query    | `{ boardId?: string }` | `{ tasks: ({ taskId: string, coordinatorNodeId: string, runnerId: string, nodeId: string, status: "running" \| "done" \| "failed" \| "stopped", startedAt: string, endedAt: string \| null, reason: string \| null, retryable: boolean })[] }` | `forbidden`                          | `canvas:read`  | 1.12 | `GET /api/workflows/tasks`                 |
| `coordinator.retry` | mutation | `{ taskId: string }`   | `{ task: { taskId: string, coordinatorNodeId: string, runnerId: string, nodeId: string, status: "running" \| "done" \| "failed" \| "stopped", startedAt: string, endedAt: string \| null, reason: string \| null, retryable: boolean } }`      | `forbidden`、`not_found`、`conflict` | `agent:launch` | 1.12 | `POST /api/workflows/tasks/{taskId}/retry` |

<!-- rpc:end -->

### 43.4 `push.*`：推送配置与设备

实现在 `core/push/routes.ts`：六个动作收成一份操作（`operations`），路由表里的旧 handler 与 `registerProcedures(server, "push", …)` 调同一份；身份都经 `requestIdentity()` 认，拒绝都是 `CoreFailure`。形状见 §19、§27。

- **路由门不判这一段**（`SELF_GUARDED`）：推送域只碰请求主体自己的设备，自己认请求身份。`meta.scope` 声明的 `canvas:read` 与旧路径的清单一致，门面把它交给同一道路由门，门对这一段放行，判定仍在域里：服务器壳的匿名主体 `401 unauthenticated`；别人的设备与不存在的设备同答 `404 not_found`（不让成员借此探测设备 id；owner 能撤任何一台，但改偏好只有设备的主人）；桌面壳的本机请求没有设备，登记与测试通知答 `409 device_required`；设备已被撤销再登记 `403 forbidden`。
- 登记（`push.register`）的入参是一个 JSON 对象，取值与互斥条件（传输与平台的搭配、令牌与公钥、UnifiedPush 端点）仍在域里判（`core/push/devices.ts`），错答 `400 bad_request`，原话与旧路径一样。登记体里的令牌与订阅密钥只出去一次，**答案里没有令牌、没有公钥本身**，只说有没有（`encrypted`、`unifiedpush`）；日志与审计也没有。
- 旧路径 `POST /api/push/test` 答 `202`，procedure 成功恒为 `200`，体相同。

<!-- rpc:begin contract=§43.4 -->

| procedure       | kind     | input                                    | output                                                                                                                                                                                                                                                                                                                                                                                 | errors                                                           | scope         | 自   | 原路径                                |
| --------------- | -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- | ---- | ------------------------------------- |
| `push.config`   | query    | 可省 `{}`                                | `{ webpush: { enabled: boolean, publicKey: string \| null }, native: { transport: "direct" \| "relay" \| "log", status: "ready" \| "notConfigured", platforms: ("ios" \| "android")[] } }`                                                                                                                                                                                             | `unauthenticated`、`forbidden`                                   | `canvas:read` | 1.14 | `GET /api/push/config`                |
| `push.devices`  | query    | 可省 `{}`                                | `{ devices: ({ deviceId: string, platform: "web" \| "ios" \| "android", transport: "webpush" \| "direct" \| "relay", appVersion: string, locale: string, encrypted: boolean, kinds?: ("approval" \| "agentDone" \| "agentError" \| "deliveryFailed" \| "schedule" \| "resources" \| "comment" \| "workflowGate")[], unifiedpush?: boolean, createdAt: string, current: boolean })[] }` | `unauthenticated`、`forbidden`                                   | `canvas:read` | 1.14 | `GET /api/push/devices`               |
| `push.register` | mutation | `Record<string, JSON>`                   | `{ device: { deviceId: string, platform: "web" \| "ios" \| "android", transport: "webpush" \| "direct" \| "relay", appVersion: string, locale: string, encrypted: boolean, kinds?: ("approval" \| "agentDone" \| "agentError" \| "deliveryFailed" \| "schedule" \| "resources" \| "comment" \| "workflowGate")[], unifiedpush?: boolean, createdAt: string, current: boolean } }`      | `unauthenticated`、`forbidden`、`bad_request`、`device_required` | `canvas:read` | 1.14 | `PUT /api/push/devices`               |
| `push.setKinds` | mutation | `{ deviceId: string, kinds?: string[] }` | `{ device: { deviceId: string, platform: "web" \| "ios" \| "android", transport: "webpush" \| "direct" \| "relay", appVersion: string, locale: string, encrypted: boolean, kinds?: ("approval" \| "agentDone" \| "agentError" \| "deliveryFailed" \| "schedule" \| "resources" \| "comment" \| "workflowGate")[], unifiedpush?: boolean, createdAt: string, current: boolean } }`      | `unauthenticated`、`forbidden`、`bad_request`、`not_found`       | `canvas:read` | 1.14 | `PATCH /api/push/devices/{deviceId}`  |
| `push.revoke`   | mutation | `{ deviceId: string }`                   | `{ revoked: boolean }`                                                                                                                                                                                                                                                                                                                                                                 | `unauthenticated`、`forbidden`、`not_found`                      | `canvas:read` | 1.14 | `DELETE /api/push/devices/{deviceId}` |
| `push.test`     | mutation | 可省 `{}`                                | `{ queued: true, id: string }`                                                                                                                                                                                                                                                                                                                                                         | `unauthenticated`、`forbidden`、`device_required`                | `canvas:read` | 1.14 | `POST /api/push/test`                 |

<!-- rpc:end -->

### 43.5 `mail.*`：邀请与口令重置链接的邮件通道

实现在 `core/mail/routes.ts`：状态与两种发送收成一份操作，旧 handler 与 `registerProcedures(server, "mail", …)` 调同一份。形状见 §28。

- 路由门不判这一段（`SELF_GUARDED`）：「能签发那条链接的人才能发」是身份域的判定（owner、`identity:manage`、组 admin 对本组成员），全局 scope 说不出「本组」。声明的 scope 与旧路径的清单一致：发送与签发同一档（`identity:manage`），`status` 是 `identity:read`。匿名主体 `401`；不能签这条链接的人 `403`；令牌不对、用过或过期 `409 link_invalid`；没有这条记录 `404`；这台服务器没有口令重置链接 `404`；没配 SMTP `409 mail_not_configured`；SMTP 不收 `502 mail_send_failed`。被拒时信箱里一封都没有多。
- 限流（每来源每分钟 5 封）的 `429 rate_limited` 带 `details.retryAfterSeconds`，HTTP 上同时给 `Retry-After` 头——**旧路径的体因此也多了这个 `details`**（从前只有头）。
- 令牌（`token`）与收件地址只在入参里出去一次：答案只有 `{ sent: true }`，审计只记地址的指纹，日志里也没有。入参只校形状，id 与令牌的拼法、邮箱地址仍在域里判（`400 bad_request`）。

<!-- rpc:begin contract=§43.5 -->

| procedure                | kind     | input                                                                  | output                                          | errors                                                                                                                                | scope             | 自   | 原路径                          |
| ------------------------ | -------- | ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---- | ------------------------------- |
| `mail.status`            | query    | 可省 `{}`                                                              | `{ configured: boolean, from: string \| null }` | `unauthenticated`                                                                                                                     | `identity:read`   | 1.14 | `GET /api/mail/status`          |
| `mail.sendInvitation`    | mutation | `{ invitationId: string, token: string, to: string, locale?: string }` | `{ sent: boolean }`                             | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`link_invalid`、`rate_limited`、`mail_not_configured`、`mail_send_failed` | `identity:manage` | 1.14 | `POST /api/mail/invitation`     |
| `mail.sendPasswordReset` | mutation | `{ principalId: string, token: string, to: string, locale?: string }`  | `{ sent: boolean }`                             | `bad_request`、`unauthenticated`、`forbidden`、`not_found`、`link_invalid`、`rate_limited`、`mail_not_configured`、`mail_send_failed` | `identity:manage` | 1.14 | `POST /api/mail/password-reset` |

<!-- rpc:end -->

### 43.6 `credentials.*`：节点凭据

实现在 `core/agent/credentials/routes.ts`：四个动作收成一份操作，旧 handler 与 `registerProcedures(server, "credentials", …)` 调同一份。形状见 §20.2。

- **值只进不出**：`create` 与 `update` 的入参带 `value`，任何答案、错误细节、日志与审计都只有 `isSet`，没有值本身；出参的每个字段都列在下表，条目里没有任何能装下值的位置（不放透传）。入参只校形状，长度、种类表、「值是不是单行」仍在域里判。
- 只有 owner（全局 `settings:*`），成员一律 `403`，被拒时条目与密钥后端里的值原样没动。
- `CredentialError` 并入 `CoreFailure`（同码同状态）；操作里抛出的别的错误（密钥后端的失败）先换成**不带原因**的固定拒绝再往外走：认得的 `secret_unavailable` 是 `503 credential_unavailable`，其余是 `500 internal`，异常消息（可能带路径，门面又会把异常消息写进日志）不出去。`internal` 的原话从英文句子换成门面统一的那一句。
- 旧路径新建答 `201`、删除答 `204`，procedure 成功恒为 `200`（删除无体）。新登记进错误码注册表的码：`credential_not_found`、`credential_mismatch`、`credential_kind_disabled`、`credential_unsupported_here`、`credential_backend_insecure`、`credential_unset`、`credential_unavailable`（与 §20 一致）。

<!-- rpc:begin contract=§43.6 -->

| procedure            | kind     | input                                                                | output                                                                                                                                                                                                                                         | errors                                                                                                                                                            | scope            | 自   | 原路径                          |
| -------------------- | -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- | ------------------------------- |
| `credentials.list`   | query    | 可省 `{}`                                                            | `{ backend: string, available: boolean, reason?: string, kinds: { providerId: string, kind: string, enabled: boolean }[], entries: { ref: string, providerId: string, kind: string, label: string, isSet: boolean, lastUsedAt?: integer }[] }` | `unauthenticated`、`forbidden`                                                                                                                                    | `settings:read`  | 1.14 | `GET /api/credentials`          |
| `credentials.create` | mutation | `{ providerId: string, kind: string, label: string, value: string }` | `{ ref: string, providerId: string, kind: string, label: string, isSet: boolean, lastUsedAt?: integer }`                                                                                                                                       | `unauthenticated`、`forbidden`、`bad_request`、`credential_kind_disabled`、`credential_backend_insecure`、`credential_unsupported_here`、`credential_unavailable` | `settings:write` | 1.14 | `POST /api/credentials`         |
| `credentials.update` | mutation | `{ ref: string, label?: string, value?: string }`                    | `{ ref: string, providerId: string, kind: string, label: string, isSet: boolean, lastUsedAt?: integer }`                                                                                                                                       | `unauthenticated`、`forbidden`、`bad_request`、`credential_not_found`、`credential_backend_insecure`、`credential_unsupported_here`、`credential_unavailable`     | `settings:write` | 1.14 | `PATCH /api/credentials/{ref}`  |
| `credentials.remove` | mutation | `{ ref: string }`                                                    | 无                                                                                                                                                                                                                                             | `unauthenticated`、`forbidden`、`credential_not_found`                                                                                                            | `settings:write` | 1.14 | `DELETE /api/credentials/{ref}` |

<!-- rpc:end -->

### 43.7 `gateway.*`：对外 HTTPS 服务的状态、配置与配对票

实现在 `core/gateway/routes.ts`（`gatewayOperations`）与 `core/gateway/index.ts`：状态、改配置、铸票收成一份操作，旧 handler 与 `registerProcedures(server, "gateway", …)` 调同一份。形状见 §17、§24。

- 读与写只有 owner（全局 `settings:*`），成员一律 `403`。入参只校形状（字段类型与多余的键），取值（`listen` 的选项、端口范围、`publicOrigin` 必须是 https 来源、证书来源）仍在域里判，原话与旧路径一样；服务器壳托管时改配置 `409 gateway_managed_by_shell`，Gateway 没在运行时铸票 `409 gateway_not_running`，来源不是本 Gateway 的 `400 invalid_origin`（新登记进注册表）。
- 配对票（`gateway.pair` 的答案）是两分钟内能换出一台 owner 设备的凭据：只答给调用方，不进审计与日志；私网档附带 8 位短码（`code`，公网 `all` 档与配了对外来源时为 `null`）。证书与私钥的文件路径不进审计。
- **匿名面不经 RPC**：配对短码换票（§24.2）发生在手机还没有任何身份的时候，短码本身就是凭据，所以只经旧路径 `POST /api/gateway/pairing-code/exchange`（Gateway 的准入里放行、路由门不判；限流与档位在 Gateway 域里判）。它在契约里登记了形状、错误与权限（`gateway.exchangePairingCode`，`scope: null`，与 `identity.cloud.login` 同一种做法），**RPC 路径不实现**：答 `501 not_implemented`，不在 `system.hello` 的 procedure 表里，门面也不接管它的旧路径（仍由路由表里那条 handler 答）。`GET /ca.crt` 等 Gateway 上的其余匿名面（§17.4）不是 core 的 JSON 面，不在契约里。

<!-- rpc:begin contract=§43.7 -->

| procedure                     | kind     | input                                                                                                                                                              | output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | errors                                                                                                                   | scope            | 自   | 原路径                                    |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---- | ----------------------------------------- |
| `gateway.status`              | query    | 可省 `{}`                                                                                                                                                          | `{ enabled: boolean, running: boolean, managedBy: "settings" \| "shell", listen: "loopback" \| "private" \| "all", port: integer, publicOrigin: string, address: { host: string, port: integer } \| null, origin: string \| null, origins: string[], tls: { source: "localCa" \| "file" \| "acme" \| "selfSigned", certFile: string, keyFile: string, acmeEmail: string, fingerprint: string \| null, subject: string \| null, names: string[], notAfter: string \| null, caAvailable: boolean, acme?: {…} \| null }, error: { code: string, message: string } \| null }` | `unauthenticated`、`forbidden`                                                                                           | `settings:read`  | 1.14 | `GET /api/gateway`                        |
| `gateway.configure`           | mutation | `{ enabled?: boolean, listen?: string, port?: number, publicOrigin?: string, tls?: { source?: string, certFile?: string, keyFile?: string, acmeEmail?: string } }` | `{ enabled: boolean, running: boolean, managedBy: "settings" \| "shell", listen: "loopback" \| "private" \| "all", port: integer, publicOrigin: string, address: { host: string, port: integer } \| null, origin: string \| null, origins: string[], tls: { source: "localCa" \| "file" \| "acme" \| "selfSigned", certFile: string, keyFile: string, acmeEmail: string, fingerprint: string \| null, subject: string \| null, names: string[], notAfter: string \| null, caAvailable: boolean, acme?: {…} \| null }, error: { code: string, message: string } \| null }` | `unauthenticated`、`forbidden`、`bad_request`、`gateway_managed_by_shell`、`settings_unavailable`                        | `settings:write` | 1.14 | `PUT /api/gateway`                        |
| `gateway.pair`                | mutation | `{ origin?: string, deviceName?: string }`                                                                                                                         | `{ origin: string, ticket: string, fingerprint: string, expiresAt: string, webUrl: string, deepLink: string, code?: string \| null }`                                                                                                                                                                                                                                                                                                                                                                                                                                     | `unauthenticated`、`forbidden`、`bad_request`、`gateway_not_running`、`invalid_origin`                                   | `settings:write` | 1.14 | `POST /api/gateway/pairing`               |
| `gateway.exchangePairingCode` | mutation | `{ code: string }`                                                                                                                                                 | `{ origin: string, ticket: string, fingerprint: string, expiresAt: string, webUrl: string, deepLink: string, code?: string \| null }`                                                                                                                                                                                                                                                                                                                                                                                                                                     | `bad_request`、`gateway_not_running`、`pairing_code_disabled`、`pairing_code_invalid`、`origin_mismatch`、`rate_limited` | 匿名             | 1.14 | `POST /api/gateway/pairing-code/exchange` |

<!-- rpc:end -->

### 43.8 `diagnostics.*`：页面错误上报

实现在 `core/diagnostics/routes.ts`：两个动作收成一份操作，旧 handler 与 `registerProcedures(server, "diagnostics", …)` 调同一份。形状见 §30。

- 路由门不判这一段（`SELF_GUARDED`）：登录即可，域自己认会话并按设备（其次 principal）限流；声明的 `canvas:read` 与旧路径的清单一致。匿名主体 `401`。默认关：关着时 `report` 答 `{ accepted: false }`、不看请求体。
- 收下的错误先剥离再交出：栈里的地址与路径只留文件名，家目录、环境里的密钥与会话令牌被替换；终端原始输出与文件正文不进上报，请求体原文不进日志。入参是一个 JSON 对象，`kind`、`name`、`message`、`stack` 的取值与长度仍在域里判（`400 bad_request`，原话与旧路径一样）。
- 限流的 `429 rate_limited` 带 `details.retryAfterSeconds`，HTTP 上同时给 `Retry-After` 头（旧路径的体因此也多了这个 `details`；头名统一为小写 `retry-after`）。
- 旧路径 `POST` 经契约登记的成功状态一律答 `202`（`{ accepted: false }` 也是，从前是 `200`）；procedure 成功恒为 `200`。

<!-- rpc:begin contract=§43.8 -->

| procedure                       | kind     | input                  | output                  | errors                                           | scope         | 自   | 原路径                               |
| ------------------------------- | -------- | ---------------------- | ----------------------- | ------------------------------------------------ | ------------- | ---- | ------------------------------------ |
| `diagnostics.clientErrorStatus` | query    | 可省 `{}`              | `{ enabled: boolean }`  | `unauthenticated`                                | `canvas:read` | 1.14 | `GET /api/diagnostics/client-error`  |
| `diagnostics.reportClientError` | mutation | `Record<string, JSON>` | `{ accepted: boolean }` | `bad_request`、`unauthenticated`、`rate_limited` | `canvas:read` | 1.14 | `POST /api/diagnostics/client-error` |

<!-- rpc:end -->
