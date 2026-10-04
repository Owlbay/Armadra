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
- 写操作要 `X-Armadra-CSRF`（至多一个）；
- 一份会话凭据——原生传输（明文 + 回环来源）读 `Authorization: Bearer`，浏览器会话读 Cookie。

**明文回环上没带凭据的一次调用按本机主人处理**（`core/identity/service.ts` 的 `localOwner`）。桌面壳的会话是原生的，密钥在壳里，既不发 Cookie 也到不了 `apps/web/src/api/request.ts` 的那个 `fetch`；而那台壳就在同一台机器上。TLS 的服务器壳上这条路不存在，凭据仍然是必须的。主人必须是一台**没被撤销的真设备**——自动化的授权记录要拿它的 epoch 复核，一个编出来的设备标识会让计划在第一次投递时被自己的复核拒掉。

### 3.3 稳定的 `code`

GitHub 那一面的 `code` 是 UPPER_SNAKE 拼法——这是延续自历史上 `/rpc/` 兼容面（R7 已删除）的拼法，不是新起的一套：

| HTTP | `code`               | 意思                                         |
| ---- | -------------------- | -------------------------------------------- |
| 400  | `INVALID_ARGUMENT`   | 请求本身不合法                               |
| 401  | `UNAUTHENTICATED`    | 设备会话无效或过期                           |
| 403  | `PERMISSION_DENIED`  | 授权位不够，或 CSRF 没过                     |
| 404  | `NOT_FOUND`          | 仓库 / Issue / PR / 连接不存在，或动词不存在 |
| 409  | `CONFLICT`           | 远端或存下来的修订号变了，重新读             |
| 429  | `RESOURCE_EXHAUSTED` | 触到 GitHub 的限流，等它重置                 |
| 501  | `UNSUPPORTED`        | 这台 core 没有可用的 GitHub 凭据             |
| 504  | `UNKNOWN_OUTCOME`    | 写出去了而结果没读到——**重新读，不要重试**   |

自动化那一面的 `code` 是 snake_case，和其余 `/api/` 一致：`bad_request`、`unauthenticated`、`forbidden`、`not_found`、`conflict`、`unsupported`、`internal_error`。**两面不同拼法是已知的、历史遗留的**：GitHub 那一面延续了 R7 之前 `/rpc/` 兼容面的拼法（该面已在 R7 删除，拼法留了下来），自动化那一面从一开始就是 `/api/` 的拼法。

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

工作空间同样跟着 `?workspaceId=` 走。

### 5.1 动词

24 个动词各一条 `POST /api/github/<verb>`，`<verb>` 是 RPC 方法名的 kebab-case：

`get-credential`、`configure-credential`、`revoke-credential`、`resolve-repository`、`list-issues`、`get-issue`、`create-issue`、`update-issue`、`set-issue-state`、`comment-issue`、`get-status-mapping`、`put-status-mapping`、`move-issue`、`list-pulls`、`get-pull`、`create-pull`、`submit-review`、`get-checks`、`rerun-checks`、`merge-pull`、`delete-branch`、`link-reference`、`unlink-reference`、`list-references`。

请求体是那个动词自己的参数（不含 `meta`：工作空间在查询串上，身份只来自会话），响应是它的返回消息，两者都按 §2 编码。

> **为什么全是 POST 而不是 REST 的 GET/PUT/DELETE。** 这 24 个动词里有 11 个是读，但它们的参数是一份结构化的过滤器（`GithubIssueFilter` 有六个字段，其中一个是自由文本查询），塞进查询串要么被截断要么要一层自定义编码。统一成「一个动词一条 POST，参数在身体里」让这一面只有一种读法。这是一处与 R7a 任务措辞的偏离，记在[实施进度](../status/typescript-core-status.md) §15.4。

### 5.2 两条不随动词变的规矩

- **列表不带正文。** `list-issues` / `list-pulls` 的每条记录 `body` 都是 `""`：一百条正文装不进一次合理的响应，而一个被截断的正文比一个缺席的更糟——详情请求会把整份拿回来。
- **令牌从不外传。** `configure-credential` 的 `token` 是这一面上唯一会外发的值，而且只是入站；`get-credential` 答的是一份状态（哪种来源、能不能用、账号名），永远不是一次回声。

`list-issues` 的分组来自 Projects v2 字段时，core 按 cursor 把 project 的条目翻完，最多 50 页（5000 条）；翻到上界还有下一页，响应的 `statusGroupsPartial` 为 `true`——没读到的 Issue 落在「未分组」，但它们其实可能有 Status。

### 5.3 枚举名

页面按名字分支，所以这些字符串是契约：

- `GithubIssueState`：`GITHUB_ISSUE_STATE_{UNSPECIFIED,OPEN,CLOSED}`
- `GithubPullState`：`GITHUB_PULL_STATE_{UNSPECIFIED,OPEN,CLOSED,MERGED}`
- `GithubStatusSource`：`GITHUB_STATUS_SOURCE_{UNSPECIFIED,NONE,LABEL,PROJECT_FIELD}`
- `GithubWriteState`：`GITHUB_WRITE_STATE_{UNSPECIFIED,APPLIED,PENDING,FAILED,CONFLICTED,SKIPPED}`
- `GithubCheckConclusion`：`GITHUB_CHECK_CONCLUSION_{UNSPECIFIED,PENDING,SUCCESS,FAILURE,NEUTRAL,CANCELLED,SKIPPED,TIMED_OUT,ACTION_REQUIRED,STALE}`
- 其余（`GithubCredentialSource`、`GithubSecretStore`、`GithubIssueStateReason`、`GithubMergeMethod`、`GithubMergeableState`、`GithubReviewState`、`GithubReferenceKind`、`GithubReferenceTargetKind`）同样是 `<ENUM_NAME>_<VALUE>` 的全大写拼法，逐条列在 `apps/web/src/api/github.ts`。

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

- 页面每 10 秒心跳一次；**30 秒**没有心跳算断开，从表里摘掉。
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
- **驱动切换**（ACP 设计 §4.2）：节点在 `blocked` / `waiting` 时 `409 awaiting_approval`；SSH 节点切到 ACP 答 `400 acp_unsupported`。否则结束当前驱动（终端先敲 CLI 的退出命令等它自己退，再结束；ACP 回合里先 cancel 再收掉进程），行以 `termination_intent = 'switch'` 结束；再在**同一行**上以另一种驱动起下一代（代次 +1，行 id 不变）：ACP 侧以 `agent_status.session_id` 接回（适配器表 `resume: "none"` 的新开），终端侧起 shell 并敲 CLI 的恢复行（不能续接时敲普通启动行）。`resumed` 如实说接上了没有。已经是目标驱动且活着时什么都不动，答 `resumed: true`。切换期间节点算「睡着」，`send` 排队。节点数据里的 `agent.driver` 由页面写回（不进撤销栈）。
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

### 14.5 输出到画板：`POST /api/workspaces/{workspaceId}/exports/{exportId}/text`

会话视图把 Agent 回复里的代码块落成编辑器节点（[ACP 会话视图](../design/acp-session-view.md) §7）时先把代码写成文件。`exportId` 是来源 Agent 节点的 uuid；文件落在工作区根下 `.armadra/exports/acp/<exportId>/<name>`，`.armadra` 带自忽略的 `.gitignore`，不进 `git status`。通用文件路由不允许在 `.armadra` 里建目录，所以这是单独一条路由，与 PNG 导出（`…/exports/{exportId}/png`）同一张权限表（`assets:read`）。

```json
{ "name": "msg-3-1.ts", "content": "export const a = 1;\n" }
```

答复与 PNG 导出同形：`{ "path": "<绝对路径>", "relativePath": ".armadra/exports/acp/<exportId>/msg-3-1.ts", "bytes": 20 }`。同名覆盖。

- `name` 是单个文件名：`[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}`，不含 `..`；`exportId` 不是 uuid、`name` 不合规、缺 `name` / `content`、正文超过 1 MiB 一律 400 `bad_request`。
- 只读打开的工作空间 403 `forbidden`；远端工作空间 501 `unsupported`（Worker 没有对应操作，不在本机落一份对方看不到的文件）。
- 页面只把它用于输出到画板；共享层 `exportTextRequestSchema`。

## 15. 工作流与 runners：`/api/workflows/*`

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

### 15.5 `wait` 动词、`open-agent --task-id` 与 `workflow_task_runs`

协调者 `ama` 的 `task(agent=<id>)` 经宿主适配器的 runner 落成画布节点（设计 `design/completion-architecture.md` §5.3）。两处 hook 面控制动词（`/control/<verb>`，调用方是协调者节点，要节点令牌）：

**`open-agent` 的两个参数**

- `task-id`：幂等键，1–100 个字母、数字或 `.` `_` `:` `-`（runner 用 `<ama 会话 id>:<ama 任务 id>`）。同一个协调者再用同一个 `task-id` 起：节点还在就答回那个节点（`result.reused: true`，不建、不投、不起）；节点已删就新建，任务行换绑过去。被别的协调者用过回 `409 task_conflict`。带它时 core 记一行 `workflow_task_runs`（`runner_id` = `agent`），并把节点交给依赖编排的启动路径起终端、敲启动行（与工作流角色节点同一条，页面开不开都一样）；`result` 多 `taskRunId` 与 `reused`。
- `name`：节点标题，与 `title` 同义（两者都给时取 `title`）。
- 权限模式这个 CLI 没有：`400 permission_mode_unsupported`，附 `supported: [...]`（与 §15.3 同码；`team` 同此）。

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
- 结束（`done` / `failed`）时 core 写 `workflow_task_runs` 的 `status`、`ended_at` 与 `result_json`（`{ text }` 或 `{ reason }`，只写第一次），并把那条结果 `post` 标成已收——runner 已替协调者取走它，收件箱唤醒不再提示一遍。

**`help`** 的 `result` 多一个 `agents`：这台机器上 `open-agent --agent` 认的 id（内置的与设置里的 `custom:*`）。ama 的适配器为其中每个内置 CLI（`ama` 除外：ama 把名为 `ama` 的 runner 当成它自己的子会话）与每个 `custom:*` 注册一个 runner。

**审批**：`ama` 节点也注入 `ARMADRA_PERM_WAIT_SECS`（与 Claude 同一个开关 `hooks.replyApprovals`，ACP 会话不注入）。适配器的审批回答者按 §5.5 写 `<pending>/<id>.json`、带 `pendingId` 报 `tool_approval_requested`，轮询 `<id>.answer`；请求文件与上报只有工具名与原因，不带工具输入。等不到就让给 ama 自己在终端里的对话框。

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

| 字段                | 规则                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `anchor`            | 三选一：`{kind:"node", id}`、`{kind:"item", id}`（白板 item id）、`{kind:"point", x, y}`（画布坐标，有限数）；id 1–200 字符          |
| `body`              | 去掉首尾空白后 1–10 000 字符。提及写成 `@[显示名](principal:<id>)`                                                                   |
| `authorPrincipalId` | 写入时取请求的 principal（本机壳的 owner 为 `""`），客户端不能指定                                                                   |
| `parentId`          | 回复指向一条**顶层**评论（只有一层）；回复的锚点随父评论，请求里的 `anchor` 被忽略                                                   |
| `resolvedAtMs`      | 只有顶层评论能解决；回复随父评论                                                                                                     |
| `mentions`          | core 认出来的提及：正文里的 principal 存在、没停用、对这个工作空间有 `canvas:read`；认不出的记号照原文留着，不叫任何人。最多认 20 个 |

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

**对 Agent 可读**：Agent 经上下文连线读一个节点（`context summary | transcript | terminal`）时，回答末尾附上锚在该节点上、未解决的评论线程（提及换成 `@显示名`，至多 8 KiB），与正文一起脱敏、计入这条连线的读取预算。白板对象与已解决的线程不附。

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

| 字段          | 规则                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `principalId` | core 一律改写成这条连接的 principal（本机壳的 owner 为 `""`），客户端填什么都不算                                           |
| `deviceId`    | 必填，1–128 字符：页面的 `clientId`（同一个人的两个窗口各一个）                                                             |
| `name`        | 必填，≤ 80 字符，只用于显示                                                                                                 |
| `color`       | 必填，整数 `1..8`：成员色序号（设计系统 §2.5）。页面加入时取在场者没用的最小一个（从 2 起），各观看者看到的同一个人颜色相同 |
| `cursor`      | 可选，画布坐标（有限数）；指针离开画布时省略                                                                                |
| `selection`   | 可选，≤ 256 个 id（每个 1–128 字符）；白板对象带 `wb:` 前缀                                                                 |
| `focusNodeId` | 可选，正在看的节点 id                                                                                                       |

- core 只留上表里的键；形状不对或序列化后超过 16 KiB 的状态**整条丢弃**（不转发、不断流），`null`（离开）照常转发。
- 一条连接只能写自己登记过的 clientID：别的连接已经登记的 clientID 在它发来的帧里被丢掉。
- 页面按共享层 `awarenessStateSchema` 再校验一次，认不出的不进在线表、不画光标。
- 共享层 `AWARENESS_LIMITS` 与 core `realtime/awareness.ts` 的上限逐条一致（`awareness.test.ts` 守）。

## 17. Gateway：`/api/gateway*`

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
    "profile": null,
    "names": ["armadra.example.com"],
    "notAfter": "2026-12-30T08:00:00.000Z",
    "renewAt": "2026-11-30T08:00:00.000Z",
    "failures": 0,
    "lastError": null
  }
  ```

  `profile` 是 `shortlived` / `classic` / `null`（CA 缺省）；`renewAt` 是下一次续期，失败后是下一次重试；`failures` 是连续失败次数，到 3 次时 core 记一条错误日志通知运维，期间**继续用旧证书**直到它过期；`lastError` 是 `{ code, message }`。证书是公共 CA 签的，没有信任锚可发，`caAvailable` 为 `false`，`fingerprint` 是叶证书的、每次续期都会变。

- `error`：最近一次没能开启的原因，开着或关着时为 `null`。`code` 取值：`acme_misconfigured`（缺邮箱、缺对外来源、对外来源是回环地址或 `ARMADRA_ACME_*` 取值不对）、`acme_port_unavailable`（`http-01` 挑战端口开不了）、`acme_failed`（CA 拒绝或连不上，`message` 是原因）、`tls_files_missing`、`port_in_use`、`port_forbidden`、`identity_unavailable`（库没过统一库迁移）、`gateway_failed`（其余，`message` 是原因）。

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
- 来源是 `capacitor://localhost` 或 `https://localhost`（且不在 `origins` 里）的请求走 **Bearer 模式**：会话绑定的来源是 App 连上的 Gateway 来源 `https://<Host>`（必须在 `origins` 里，否则 403）；凭据只认 `Authorization: Bearer <访问密钥>`，Cookie 不看、没有 CSRF；`POST /api/identity/pair`、`/session/refresh` 与登录把密钥放在响应体的 `native` 里、不发 Cookie（与桌面壳的原生传输同一形状，§3）；CORS 只回 App 自己的来源，预检放行 `authorization, content-type, x-armadra-csrf`。
- **响应头**（`core/gateway/csp.ts`）：经 Gateway 的每个答案都带 `Strict-Transport-Security: max-age=31536000`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；`/api/**` 与 `/health` 再带 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox`、`X-Frame-Options: DENY`，以及缺省的 `Cache-Control: no-store`（答案自己写了缓存策略时以它为准，如资产）。静态产物用页面的 CSP（`serverContentSecurityPolicy`）。画布资产（`GET …/assets/{assetId}`）无论经不经 Gateway 都带 `default-src 'none'; …; sandbox`：直接导航到一张 SVG 时它是一份沙箱里的文档，脚本不跑。
- **原生 App 包里页面的 CSP**（`nativeAppContentSecurityPolicy()`）：桌面那一份摘掉回环授权，`connect-src` 加 `https: wss:`、`img-src` / `media-src` 加 `https:`（Gateway 地址配对前未知，证书由原生层钉扎）；其余逐字继承。
- **长连接复核**：经 Gateway 升级的流（事件、实时同步、终端、语言服务、浏览器画面）在授权变化（撤销设备或会话、登出、停用账号、收回共享）时按同一道路由门、用复核后的主体再判一次，不过即以 **4403** 关流（`core/http/server.ts`）。
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
| `POST oauth/{id}/logout` `{ returnTo? }`                                       | 匿名                              | `{ endSessionUrl }`：OIDC 发现文档有 `end_session_endpoint` 时是 RP 发起登出的地址（`client_id` + `post_logout_redirect_uri`），否则 `null`；本机会话仍由 `POST session/logout` 结束                                                                                               |

**回调**是从提供方跳回的顶层导航（没有 `Origin`、`Sec-Fetch-Site: cross-site`、`SameSite=Strict` 的会话 Cookie 带不上），所以它不认会话：`state` 内存里 10 分钟、**取出即删**（重放、过期、浏览器绑定 Cookie 不对都是 `oauth_state_invalid`），`bind` 的发起者在 `start` 时就记进状态。Gateway 的门只对 `GET /api/identity/oauth/{id}/callback` 放开 Origin 与 `Sec-Fetch-Site` 两道（`core/gateway/admission.ts` 的 `oauthCallbackPath`）。跳回片段的 `oauth=`：

| `oauth=`   | 意思                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `bound`    | 绑到了发起者名下（已绑在本人名下也是它）                                                       |
| `signedIn` | 已绑定的 principal 登录，会话 Cookie 已下发；审计 `identity.login`（`detail.method: "oauth"`） |
| `signedUp` | 建了一个 `member`（无授予，owner 再共享）并登录                                                |
| `mfa`      | 这个人登记过 TOTP：带 `challengeId`，页面接 §18.3 的 `POST mfa/verify`；不发会话               |
| `error`    | 带 `code`（下表）；不发会话、不改绑定                                                          |

决定：配了 `allowedDomains` 时三条路都要求 `email_verified = true` 且邮箱域名精确命中（大小写不计，子域不算）；`bind` 绑到发起者；`login` 已绑则登录（principal 停用了按「没绑」答），没绑且 `allowSignup` **并且** `allowedDomains` 非空才建号（这就是 SSO；不设域名的建号等于「有这家账号的任何人都能进来」），否则 `oauth_not_bound`。

| `code`                     | HTTP | 意思                                                                        |
| -------------------------- | ---- | --------------------------------------------------------------------------- |
| `oauth_not_configured`     | 404  | 没有公网来源、不是从公网来源发起、提供方不存在或停用、GitHub 没有 secret    |
| `oauth_browser_required`   | 400  | Gateway 的 Bearer 模式（原生 App）发起；授权要在浏览器会话里走              |
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

- `web` 只能配 `webpush`，`ios` / `android` 只能配 `direct` / `relay`。`endpoint` 必须是 https（回环上的 http 只给测试）；`p256dh` 是 65 字节 P-256 点，`auth` 是 16 字节。
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

- 推送订阅工作空间事件：`agent.approval`（新请求；`request.resolved` 的答复不推）、`agent.status`（**进入** `done` 推 `agentDone`，进入出错推 `agentError`；`restored` 行不推）、`agent.delivery`（`outcome` 为 `refused` / `failed` / `expired` / `cancelled`（回执），深链指向发送方节点）、`schedule.*`、`resources.threshold`、`board.comment`（只推给 `mentions` 里的 principal，没有提及不推）、`workflow.gate`。后四种事件由各自的域发布，推送只按 `type` 与其中的 `nodeId` / `automationId` / `metric` / `comment.{id,anchorKind,anchorId,mentions}` / `runId` / `stepId` 认。
- 收件人：登记有效、身份设备未撤销、principal 未停用，且该 principal 对事件所在工作空间有 `canvas:read`（owner 恒有）。
- 先入队（`push_outbox`）再发；总共最多 3 次尝试（失败后 5 秒、30 秒各再试一次），只有网络错误、429 与 5xx 再试。平台说令牌作废（Web Push 404 / 410，APNs 410 / `BadDeviceToken` / `Unregistered`，FCM `UNREGISTERED`，中继 410 / `badToken`）立即停、设备登记撤销（`revoked_reason = 'gone'`）。终态行保留 7 天。App 按旧配置登记的（例如登记时是 `direct`，现在改成 `relay`）只记日志，等 App 按新配置重新登记。

## 20. 节点凭据：`/api/credentials*`

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

预留，由 G5-02 填写。

## 26. ACP 补充：elicitation、模型、凭据、SSH

预留，由 G5-04 填写（SSH 小节由 G5-06 追加）。

## 27. 推送补充：设备偏好、UnifiedPush、调度与资源事件

预留，由 G5-10 填写。事件形状 G5-00 已在 `core/bus.ts` 与 `packages/shared/src/api/events.ts` 定义：`schedule.fired { planId, runId, nodeId? }`、`schedule.failed { planId, runId, nodeId?, reasonCode }`、`schedule.attention { planId, nodeId?, reasonCode }`、`resources.threshold { sessionId, nodeId?, metric, value, threshold }`；不带命令、参数与输出。

## 28. 邮件通道：`/api/mail/*`

预留，由 G5-13 填写。

## 29. 托管平台（forge）：`/api/forge/*`

预留，由 G5-14 填写（GitLab 小节由 G5-15 追加）。

## 30. 页面错误上报：`/api/diagnostics/client-error`

预留，由 G5-19 填写。
