# CLI 接入、通信与共享上下文（后续规划第一部分）

> 状态：已实施（2026-10-02）——H0、H1、H2、H3、R1、M1、E1 已合入 main（PR #9）；场景 10 首跑踩中的启动对话框问题由投递画面门修掉（[投递设计](agent-delivery.md) §4.3「画面门」，进度 §62.3）；E1 本机实跑 Claude / Codex / Pi 通过（OpenCode / OMP / Copilot 未安装，记 skipped，待装机补跑）；X1（多账号调研）结论见 §7；第二阶段已实施（补全 G1-1，契约 §20：只开 Claude `oauth-token` 与 Copilot `github-token`，Windows 未开放），§7.4 的 T1–T9 真账号实测待用户提供。跨执行主机交接（§6）已由补全 G1-2 放开。对应[后续规划](product-roadmap.md)第一部分。现状以[功能预期总表](../status/feature-roadmap.md)与源码为准。
> 范围：`apps/desktop/src/core/{history,conversations,usage,collab,handoff,hook,agent}`、`apps/web/src/{agent,nodes,settings,usage}`、`packages/shared/src`、`tools/probes/agent-e2e`。
> 前置：[Agent 协作](../guides/agent-collaboration.md)（现状）、[Agent 推式投递](agent-delivery.md)（`send` 与投递队列）、[Agent 协作通道](agent-collaboration-channels.md)（各 CLI 的 Hook 通道）、[远端画布注入](remote-canvas-injection.md)。

## §0 结论

规划里列了六条。逐条对过源码以后，有一半已经交付，真正的缺口集中在一处：Claude 和 Codex 以外的四种 CLI（OpenCode、Pi、OMP、Copilot），它们留在本机的会话记录 **core 解析不了**：

- Pi、OMP、Copilot 的转录文件其实**定位得到**。Pi 和 OMP 的扩展已经上报 `transcriptPath`（`hook/install/extension-template.ts` 的 `armadraPayload`），`collab/transcript.ts` 的 `locate()` 对任何 CLI 上报的路径都会放行。问题出在解析：`transcript.ts` 的 `renderEntry` 和 `transcript-summary.ts` 的 `readEntry` 只认 Claude、Codex 和 OpenAI 三种格式。Pi 的记录是 `{type:"message", message:{role}}`，Copilot 是 `{type:"user.message", data}`，一条都渲染不出来：读转录报「没有可读的对话」，读摘要得到空内容。
- OpenCode 的记录在 SQLite 库里，没有文件可以定位。
- 会话索引（`conversations/index.ts` 的 `PROVIDERS`）和成本（`usage/cost-sources.ts`）只注册了 Claude 和 Codex。

| #   | 决定                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 新增**本地历史适配器**（`core/history/`），每种 CLI 一个，负责定位、列出会话、读出**归一化记录**（`TranscriptEntry`）和采集用量                             |
| D2  | 会话索引、成本、转录与摘要都改为经适配器读取；三处原有的缓存、预算、游标和线上形状保持不变，只新增「吃归一化记录」的入口                                    |
| D3  | 投递补上**终态回执**：排队项因过期、目标侧拒收或出队时门链拒绝而结束时，往发送方的收件箱写一条回执；回执不计入唤醒，也不占收件箱容量                        |
| D4  | 能力解析已经存在（`packages/shared/src/agent-capabilities.ts`、`CapabilityInheritance.tsx`），不重做。只在 `/api/agents` 的行上补「本机有没有历史数据」三项 |
| D5  | 「SSH 终端里的 Agent 限同一执行主机」本部分不放开（§6）                                                                                                     |
| D6  | 多账号（`credentialRef`）只出调研结论（§7）                                                                                                                 |
| D7  | 验收门槛：`agent-e2e` 新增场景 10，六种 CLI 跑通「启动 → 互读上下文 → 投递 → 拒收回执 → 交接」                                                              |

## §1 规划条目与现状对照

| 规划条目      | 现状（源码）                                                                                                                                                                      | 本部分要做        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 接入对齐      | 启动、resume、权限模式、模型选择已交付（进度 §19）；能力位有 `supported/unsupported/unknown` 三态和来源，已在 AgentPage 上显示                                                    | §5 补历史数据三项 |
| 会话索引      | `PROVIDERS = ["claude", "codex"]`；共享层 `packages/shared/src/api/conversations.ts` 的 `CONVERSATION_PROVIDERS` 也是这两个                                                       | §3                |
| 成本          | 只有两个来源，其余四家显示 `source: "none"`                                                                                                                                       | §3                |
| 多账号        | 只有 schema 和只读徽标                                                                                                                                                            | §7 调研           |
| 投递回执      | 发送当下的回执、队列、排队徽标、投递记录面板、`attempts` 计数、重新入队都已存在。终态不通知发送方；`expired` 和 `cancelled` 也不写进 `agent_deliveries`，所以投递记录里看不到终态 | §4                |
| 放开 SSH 限制 | `handoff/store.ts` 返回 501                                                                                                                                                       | §6 后续批次       |
| 共享上下文    | 转录、摘要、终端画面、文件 / 网页（`content` 动词）、白板对象都能按连线读，读取有预算和记录。另外四家的转录与摘要读不出内容（见 §0）                                              | §2、§3            |
| 真 CLI e2e    | 九个场景；场景 6 用非交互模式，只验证注入                                                                                                                                         | §8                |

## §2 本地历史适配器

### §2.1 类型

```ts
// core/history/types.ts
export interface SessionHint {
  agentId: string;
  transcriptPath?: string;
  sessionId?: string;
  cwd?: string;
  startedAtMs?: number;
}
/** key 是文件路径或 "opencode:<sessionId>"；没有文件的来源 path 为空。 */
export interface Located {
  key: string;
  path?: string;
  origin: string;
}
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; id?: string; input?: unknown }
  | { type: "tool_result"; id?: string; content?: unknown };
export interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  blocks: readonly Block[];
  endOffset: number;
  at?: string;
}
export interface EntryRange {
  entries: readonly TranscriptEntry[];
  startOffset: number;
  endOffset: number;
}
/** JSONL 行式沿用 AgentCostSource；快照式给没有逐行文件的来源（OpenCode）。 */
export type CostCollector =
  | { kind: "jsonl"; source: AgentCostSource }
  | {
      kind: "snapshot";
      collect(sinceMs: number, ctx: AbsorbContext): readonly CostSample[];
    };
export interface HistoryAdapter {
  readonly agentId: AgentId;
  roots(env?: NodeJS.ProcessEnv): readonly string[];
  locate(hint: SessionHint): Located | undefined;
  list(root: string): readonly Candidate[]; // 复用 conversations/scan.ts
  parse(candidate: Candidate): Parsed | undefined;
  readEntries(
    located: Located,
    fromOffset: number,
    maxBytes: number,
  ): EntryRange;
  readonly cost?: CostCollector;
}
```

规矩：

- 只读别人的文件，不往任何 CLI 的配置目录写东西。读不了就返回空结果并给一条 warning，不影响启动。
- 根目录一律复用 `hook/install/shared.ts` 的 `configHomeWith`：Pi 认 `PI_CODING_AGENT_DIR`；OMP 认 `PI_CONFIG_DIR` / `OMP_PROFILE` / `PI_PROFILE`，并与 Pi 共用 `PI_CODING_AGENT_DIR`；Copilot 认 `COPILOT_HOME`。OpenCode 的**数据库**在 `XDG_DATA_HOME/opencode`（缺省 `~/.local/share/opencode`），和它的配置目录不是同一条规则，要单独处理。
- `collab/transcript.ts` 的 `home()` / `codexHome()`、`conversations/claude.ts` 的 `claudeHome()`、`usage/providers.ts` 的 `homeDir()` 合并成 `history/home.ts` 一份。

### §2.2 四种 CLI 的数据来源（2026-10-02 本机核实）

| CLI      | 位置                                                       | 定位                                                                                                                                                              | 记录映射                                                                                                                       | 用量                                                                                                                                                            |
| -------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi / OMP | `<configHome>/sessions/<编码 cwd>/<ISO 时间>_<uuid>.jsonl` | 扩展已上报 `sessionId` 和 `transcriptPath`。兜底先按 sessionId 匹配文件名，再按首行 `type:"session"` 里的 `cwd` 加启动时间，取之后 mtime 最新的文件；不解码目录名 | `type:"message"` 的 `message.role` 和 `message.content`（字符串或块数组，含 `toolCall` / `toolResult`）                        | `message.usage` 的 input / output / cacheRead / cacheWrite；模型取 `message.model`；按 `message.responseId` 去重                                                |
| OpenCode | `opencode.db`（SQLite，WAL）                               | Hook 已带 `sessionId` → `Located{ key: "opencode:<id>" }`                                                                                                         | `message` 关联 `part`：`text` 映射为文本，`tool` 映射为工具调用（结果取自 `state`），其余跳过                                  | 逐条读 `message.data` 中 assistant 的 `modelID`、`tokens{input,output,reasoning,cache{read,write}}`、`time`；`session` 表的汇总列没有时间和模型维度，只用于索引 |
| Copilot  | `<configHome>/session-state/<uuid>/events.jsonl`           | Hook 已带 `sessionId`；目录名就是会话 id；cwd 读同目录 `workspace.yaml` 里的 `cwd:` 那一行                                                                        | `user.message` 映射为 user，`assistant.message` 映射为 assistant（`toolRequests` 映射为工具调用）；`hook.*`、`thinking` 等跳过 | `session.usage_checkpoint.data.totalPremiumRequests` 是**会话累计值**，取最后一条，不逐行累加                                                                   |

OpenCode 库的读法：每次扫描用 `new DatabaseSync(path, { readOnly: true })` 打开，`finally` 里关闭，不长期持有连接（本机对运行中的库实测可以打开）。版本探测用 `PRAGMA table_info(session)` 看有没有 `tokens_input` 和 `cost` 两列；`user_version` 是 0，不能当版本号用。列不齐，或者目录不可写导致建不出 `-shm` 时，整家跳过，状态记为 `not-found` 并给 warning。`parent_id` 非空的是子会话，不进索引。旧版 `storage/` 目录不读。

读取游标表 `context_read_cursors` 的 `(transcript_path, byte_offset)` 对 OpenCode 当作不透明键（`opencode:<id>`）和消息游标使用，在 `context-reads.ts` 的注释里写明即可，不需要迁移。消息游标是 `time_created × 1000 + 同一毫秒里按 id 排的序号`，同一毫秒的多条消息不漏不重；`context transcript` 的提示按来源说明单位（OpenCode 显示消息时间，不写「字节」）。

## §3 会话索引、成本与转录

- **会话索引**：`PROVIDERS` 和共享层的 `CONVERSATION_PROVIDERS` 改为从适配器注册表派生；后者是 zod 枚举，不放宽的话页面会拒掉新增的行。标题沿用「首条用户消息」，只有 OpenCode 直接用 `session.title`；OpenCode 的标题是自动生成的，命令面板里会出现两种风格，这一点可以接受。`agent/routes.ts` 的 `transcriptTitle` 现在把所有非 Codex 的记录都按 Claude 解析，要改为经适配器。
- **resume**：`apps/web/src/meta/conversations.ts` 的 `resumeLaunchCommand` 已经按注册表通用，不用改。
- **成本**：`AgentCost` 增加 `unit: "tokens" | "premiumRequests"` 和 `requests`；共享层 `costAgentSchema` 跟着改（给缺省值），`UsagePanel.tsx` 对 `premiumRequests` 显示请求数。汇总 `totals` 只合并 token。形状见契约 §12.1。
- **转录与摘要**：`transcript.ts` 新增 `renderEntries(entries)`，`renderRecords(text)` 改为先把文本转成 entries 再渲染；`transcript-summary.ts` 新增 `digestEntries(entries)`，`digestTranscript(text)` 改为包装它。现有的预算、游标、脱敏和 `contextShare` 都不动。

## §4 投递终态回执

**终态分类**：队列表加一列 `settled_by`。

| 值       | 谁定的                                                                                                    | 写回执 |
| -------- | --------------------------------------------------------------------------------------------------------- | ------ |
| `source` | 发送方自己取消（`cancelOwn`）                                                                             | 否     |
| `target` | 目标那一侧的人拒收（`deliveries.ts` 的 `cancelQueued`）                                                   | 是     |
| `gate`   | 出队时门链硬拒绝（`control/send.ts` 里的 `settle(…, "cancelled", code)`，现在被 `SendPump.drain` 吞掉了） | 是     |
| `sweep`  | 过期清扫                                                                                                  | 是     |

**回执写法**：

- 写进 `agent_mailbox`。`source_node_id` 受外键约束，所以填**目标节点 id**，`target_node_id` 填发送方，`message_key = receipt:<queueId>`；和 `notified_at` 一起保证只写一次。
- 正文写明目标、原因（`last_reason`）、尝试次数和正文字数，不带原消息正文。对 `gate` 类，`attempts` 要加 1 才是实际尝试次数。
- 回执不计入 `unreadDigest`，也不计入 `pendingCount`（`MAX_PENDING = 64`），否则 `inboxWake` 的缺省档 `notify` 会在发送方下次空闲时把提示敲进它的终端。
- 发送方节点已经不在画布上时不写回执，但仍然记一条投递记录。
- 终态同时写进 `agent_deliveries`（outcome 为 `expired` 或 `cancelled`），并发出 `agent.delivery` 事件，这样「我发出的」才有数据。
- `expireQueue` 拆成三步：标记终态 → 写回执 → 删除。删除只删已经写过回执的行，以及 `settled_by` 为空或 `source` 的行。
- `attempts` 不设上限，是否过期仍然只看 TTL。

**界面**：`DeliveryQueueBadge` 的浮层增加「我发出的」一段，取投递记录里 `sourceNodeId` 是本节点、且不是 `queued` 的最近几条；`delivery-store.ts` 收到 `expired` / `cancelled` 时同样刷新发送方。

## §5 历史数据可用性

在 `/api/agents` 的每一行上加 `history: { index, cost, transcript }`，每项取值 `available | not-found | unsupported | disabled`，由 `history/availability.ts` 计算：

- 没有适配器：`unsupported`。
- 自定义条目关掉了 `contextLink`：`transcript` 记为 `disabled`。
- 根目录全都不存在：`not-found`。

集成页在现有徽标行旁边加三个 Badge，文案复用 `capability.state.*`。`not-found` 和 `unsupported` 显示为状态词，不显示成 0。不新开端点，也不重做能力解析。形状见契约 §12.2。

## §6 后续批次：跨执行主机交接

本部分不实施。方向：交接材料由 SSH 终端所在主机上的 Worker 采集，前提是那台主机已经注册为执行主机、并且 Worker 在线；做不到时继续返回 501。改动集中在 `handoff/store.ts` 和 `remote/`，落地前另写一节设计。

> 2026-10-03 已由补全计划 G1-2 实施：来源转录经那台主机 Worker 的 `handoff.capture`（`transcriptOnly`）读，`capturedOn` 记主机；读不了答 501 `handoff_host_offline`。形状见契约 [§21.1](../contracts/core-json-api.md)。

## §7 多账号调研（只出结论）

2026-10-02 在本机只读调研。版本：Claude Code 2.1.286、Codex 0.159.3、Copilot CLI 1.0.89、Pi 0.99.2、OMP 18.4.4、OpenCode 1.18.33（本机 npm 包没跑 postinstall、缺原生二进制，所以这一行只依据官方文档和本机数据目录）。证据有四类：本仓源码与注释；各 CLI 的 `--help`、安装包里的文档和字符串；本机配置目录的**文件名与键名**（没有读任何值）；官方文档。来源标注：**源**＝CLI 安装包里的源码或字符串，**仓**＝本仓源码，**文**＝官方文档，**推**＝推断，**测**＝要用真实账号实测（列在 §7.4）。

### §7.1 六家对照

| CLI      | 凭据位置                                                                                                                                                                                                                                                                                                                     | 单次启动切换方式                                                                                                                                                                                                                                                                                                                                                  | 对画布外的影响                                                                                                                                                                                                                                                               | 来源                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | macOS 存登录钥匙串，service 名 `Claude Code-credentials`，account 是 `$USER`；钥匙串写不进时退到 `<配置目录>/.credentials.json`（0600，键 `claudeAiOauth`，本机两处都有）。Linux 和 Windows 只用这个文件。账号资料存在 `~/.claude.json` 的 `oauthAccount`；设了 `CLAUDE_CONFIG_DIR` 时换成 `$CLAUDE_CONFIG_DIR/.claude.json` | 有两种办法。一是 `CLAUDE_CONFIG_DIR`，换掉**整个配置目录**，钥匙串条目名会追加 `-<sha256(目录)前 8 位>`，所以每个目录对应一个独立条目。二是只换凭据：`CLAUDE_CODE_OAUTH_TOKEN`（由 `claude setup-token` 生成，有效一年，只能调模型）或 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`，它们都优先于 `/login`                                                        | 走环境变量不写文件。例外是交互模式第一次用 `ANTHROPIC_API_KEY` 时要确认一次，确认结果会写进全局配置的 `customApiKeyResponses`（本机有这个键）。单独的配置目录不会碰 `~/.claude`。刷新令牌是否轮换，官方没写：测                                                              | 源 `QN()`（拼条目名）、`Wt()`（`.claude.json` 路径）；文 [authentication](https://code.claude.com/docs/en/authentication)（多账号、凭据存放位置、优先级）、[env-vars](https://code.claude.com/docs/en/env-vars)；仓 `agent-e2e/scenario-5-canvas-only.mjs`（钥匙串登录只认真实配置目录） |
| Codex    | `$CODEX_HOME/auth.json`（默认 `~/.codex`，键有 `auth_mode`、`OPENAI_API_KEY`、`tokens.{access_token,refresh_token,id_token,account_id}`、`last_refresh`）。`cli_auth_credentials_store` 可以设成 `file`、`keyring`（系统凭据库，service 名 `Codex Auth`）、`auto` 或 `ephemeral`                                             | 一是 `CODEX_HOME`，换掉**整个目录**（`config.toml`、`sessions/`、sqlite、`auth.json` 一起换）。二是只换凭据：二进制认 `OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN` 三个环境变量（会提示 "auth is provided by environment"），但官方文档只写了 `--with-api-key` 从 stdin 登录。ChatGPT 订阅登录没有文档化的环境变量                                     | **刷新令牌只能用一次**：二进制里有 "refresh token was already used" 报错。所以同一份登录复制进两个目录后，先刷新的那份会让另一份失效；本仓探针因此只复制 7 天内刷新过的 `auth.json`。新目录首次启动时，如果两个进程并发，sqlite 迁移会撞车；升级提示的默认选项会改掉全局安装 | 源（`AuthCredentialsStoreMode`、环境变量名、刷新报错）；文 [auth](https://learn.chatgpt.com/docs/auth)；仓 `agent-e2e/lib.mjs:221-279`；环境变量和 `auth.json` 谁优先：测                                                                                                                |
| OpenCode | `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`，每个提供商一条，类型是 `api` 或 `oauth`。`opencode.db` 里还有 `account` 和 `account_state.active_account_id`（OpenCode 自家账号，可以存多个，同一时间一个生效），以及 `credential(label, active)`；本机这几张表都是空的                                               | 一是 `XDG_DATA_HOME`，换掉**整个数据目录**，库、会话、快照都跟着换；`OPENCODE_CONFIG_DIR` 和 `OPENCODE_CONFIG` 只换配置、不换凭据。二是只换凭据：内置提供商会读各自的 API key 环境变量，自定义提供商在配置里写 `{env:VAR}`。`auth.json` 和环境变量谁优先没有文档                                                                                                  | 走环境变量不写文件。改 `XDG_DATA_HOME` 会把 Armadra 读历史用的库（`history/opencode.ts`）一起移走。OAuth 条目刷新时会改写 `auth.json`，复制出去的副本会不会失效：测                                                                                                          | 文 [providers](https://opencode.ai/docs/providers/)、[config](https://opencode.ai/docs/config/)；本机库的表结构；仓 `hook/install/inject.ts`（画布注入已经占用 `OPENCODE_CONFIG_DIR`）；优先级：测                                                                                       |
| Pi       | `$PI_CODING_AGENT_DIR/auth.json`（默认 `~/.pi/agent`），每个提供商一条，类型是 `api_key` 或 `oauth`；读写时用 `proper-lockfile` 加锁；`key` 可以写成 `!命令`，从钥匙串等地方取                                                                                                                                               | 一是 `PI_CODING_AGENT_DIR`，换掉**整个 agent 目录**（设置、扩展、技能、会话、凭据）；会话可以用 `PI_CODING_AGENT_SESSION_DIR` 或 `--session-dir` 留在原处。二是只换凭据：用各提供商的环境变量（`ANTHROPIC_API_KEY`、`MOONSHOT_API_KEY` 等，另有 `ANTHROPIC_OAUTH_TOKEN`）。`--api-key` 会出现在命令行上，不采用                                                   | OAuth 条目刷新时会轮换，复制出去的副本会让原件失效；本仓探针因此只复制 API key 条目。同一个目录被多个进程共用时有锁保护                                                                                                                                                      | 文 安装包里的 `docs/environment-variables.md`、`providers.md`、`configuration.md`；源 `dist/core/auth-storage.js`；仓 `agent-e2e/scenario-6-other-clis.mjs:17-29`；环境变量能不能压过 `auth.json` 里的同一家：测                                                                         |
| OMP      | `<agent 目录>/agent.db` 的 `auth_credentials` 表。**同一家可以存多条**，自带选择、轮换、限流冷却（`auth_credential_blocks`），还有跨进程的刷新租约（`auth_credential_refresh_leases`）                                                                                                                                       | 一是 `OMP_PROFILE` 或 `--profile <名>`（官方说法是 isolated agent state），用 `~/.omp/profiles/<名>/agent`，换掉**整个 agent 目录**，凭据库也在里面；`PI_CODING_AGENT_DIR` 效果相同。二是只换凭据：用各提供商的环境变量；`models.yml` 的 `apiKey` 可以写环境变量名                                                                                                | profile 和画布外用的默认目录完全隔离。默认目录的凭据池在库里自己协调刷新，多个进程共用是安全的。复制出去的副本会不会失效：测                                                                                                                                                 | 源 `src/cli/help-extra.ts`、`pi-utils/src/dirs.ts`、`pi-ai/src/auth/`；本机库的表结构；仓 `hook/install/shared.ts::configHomeWith`（已经认 `OMP_PROFILE`）                                                                                                                               |
| Copilot  | 系统凭据库：macOS 钥匙串、Windows 凭据管理器、Linux libsecret。凭据库不可用时，用户同意后以明文存进 `$COPILOT_HOME/config.json`（对应设置 `storeTokenPlaintext`）。`config.json` 记录账号列表和 `lastLoggedInUser{host,login}`。钥匙串条目前缀是 `copilot-cli/`，完整名字没核实                                              | 一是 `COPILOT_HOME`，换掉**整个配置和状态目录**。但钥匙串是全机共享的，新目录里没有账号列表，效果等于没登录（探针实测确认）。二是只换凭据：`COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`，官方说它们优先于已存的登录；令牌可以是带 Copilot Requests 权限的细粒度 PAT，或 OAuth 令牌，不支持 classic `ghp_`。三是 CLI 自带的 `/user list` 和 `/user switch` | 走环境变量不写文件。`/user switch` 会改 `lastLoggedInUser`，影响画布外下次启动用哪个账号，所以不能当作按节点切换的手段。`~/Library/Caches/copilot/` 不跟着 `COPILOT_HOME` 走                                                                                                 | 文 `copilot help environment`、`copilot login --help`、[authenticate-copilot-cli](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)；源 包缓存里的 `app.js`、`runtime.node`；仓 `scenario-6-other-clis.mjs:28-29`                      |

归纳：

- **六家都有官方支持的整目录切换**：Claude、Codex、Copilot、Pi 有专门的变量，OMP 用 profile，OpenCode 借用 XDG 变量。**六家也都能只靠环境变量换凭据**，但能换的形态不同：Claude 能换订阅（`setup-token`），Copilot 能换 PAT 或 OAuth 令牌，Codex、Pi、OMP、OpenCode 只能换 API key。Codex 的 ChatGPT 订阅没有文档化的环境变量。
- **OAuth 凭据不能复制**。Codex 的刷新令牌已证实只能用一次，Pi 的会轮换，其余几家待测。订阅账号想隔离，只能在隔离目录里重新登录。
- 整目录切换在每一家都会把会话记录一起带走。

### §7.2 Armadra 侧的约束（仓）

1. **会话记录、成本和转录都只认一个目录**。`history/home.ts` 用 core 进程自己的环境调用 `configHomeWith`，会话索引、`usage/cost-sources.ts`、转录定位都沿用这个结果。节点改了 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`COPILOT_HOME`、`PI_CODING_AGENT_DIR`、`OMP_PROFILE` 或 `XDG_DATA_HOME` 后，它的会话就不在索引里了：互读、交接、成本、改名建议全部读不到。
2. **画布注入只有 Codex 和配置目录绑定**。Claude、Pi、OMP、Copilot 的注入走启动参数，指向 `<data>/integration/<cli>/`；OpenCode 用的是 `OPENCODE_CONFIG_DIR`，跟凭据所在的 `XDG_DATA_HOME` 无关。Codex 只执行它信任的 Hook，信任记录写在 `$CODEX_HOME/config.toml`（`trustCodexSessionHooks`，是「不写 CLI 配置」规则里唯一的例外）。每多一个隔离的 `CODEX_HOME`，就要多写一处全局配置。
3. **只有 macOS 用了系统凭据库**。`usage/secret-store.ts` 在 macOS 上写登录钥匙串；其他平台退到数据目录里的 0600 文件，并标为降级。Windows 上 `chmod` 基本不起作用，文件只是继承用户目录的 ACL。
4. **启动环境每次现算，不落库**。`terminal/install.ts::ownedEnvironment` 每次起终端（包括唤醒）都会重算，会话行里不存环境。所以可以在这里按 `credentialRef` 从 SecretStore 现取凭据，不会进 SQLite。
5. **`credentialRef` 目前不上行**。`apps/web/src/agent/launch.ts::agentSessionRequest` 只带 `accountId`，core 拒绝非 `default` 的账号。

### §7.3 第二阶段建议：做，只做「凭据环境变量」这一档

**结论**：`credentialRef` 第二阶段**做**，范围是按节点注入凭据环境变量；「每个 `credentialRef` 一个隔离配置目录」这一档**不做**。

**做法**

- `credentialRef` 是 SecretStore 里一个条目的名字（service 为 `armadra-credential-<ref>`），条目内容是 `{ providerId, kind, value }`。`kind` 只能从下表选，变量名由 core 写死，不让用户自己填，免得被拿来注入任意环境变量：

  | providerId | kind                      | 注入的变量                                                       |
  | ---------- | ------------------------- | ---------------------------------------------------------------- |
  | claude     | `oauth-token` / `api-key` | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`                  |
  | codex      | `api-key`                 | `CODEX_API_KEY`（交互 TUI 不认的话，改用 `OPENAI_API_KEY`）      |
  | copilot    | `github-token`            | `COPILOT_GITHUB_TOKEN`                                           |
  | pi / omp   | `api-key:<提供商>`        | 该提供商的官方变量（`ANTHROPIC_API_KEY`、`MOONSHOT_API_KEY` 等） |
  | opencode   | `api-key:<提供商>`        | 同上，只支持内置提供商                                           |

- 注入点放在 `ownedEnvironment` 里、和 `canvasEnvironment` 同一处，只进终端环境，**不进启动行**：启动行是敲进 shell 的，会留在回滚缓冲区和 shell 历史里。
- `agentSessionRequest` 上行 `credentialRef`。core 校验条目存在、`providerId` 和节点的基础 CLI 一致，不满足就拒绝启动，返回 `{ code, message }`。`AccountBindingBadge` 从只读改成可选，条目在设置页增删；界面只显示名字和 `kind`，不回显值。
- SSH 节点拒绝。凭据在控制端，经 SSH 下发就违背了「`credentialRef` 是执行主机凭据库里的名字」这个前提，处理方式和 D5 一致。

**最小可行范围**：Claude（`oauth-token`）和 Copilot（`github-token`）。这两家都是官方文档化的变量，优先于已存的登录，覆盖的又是订阅账号这种最常见的多账号需求，而且都不写文件、不会让画布外的登录失效。其余几家等 §7.4 的优先级测试过了再加。

**不做隔离目录的理由**：它直接撞上 §7.2 的第 1、2 条，会话索引要改成多根，Codex 每个目录都要写信任记录。此外，订阅账号要在每个目录里交互登录一次；新目录还有首启提示、升级提示和 sqlite 迁移并发的问题，探针都遇到过。只有当用户需要同一台机器上跑两个 ChatGPT 订阅，或者要分开 Pi/OMP 的 OAuth 订阅时，才值得做。到时优先用 OMP 的 profile，以及 Pi 的 `PI_CODING_AGENT_SESSION_DIR`（会话留在原目录），同时把 `history/home.ts` 改成按 `credentialRef` 扫描多个根目录。

**风险**

- CLI 起的子进程（bash 工具、MCP 服务器、`armadra-hook`）会继承这个变量，模型执行 `env` 就能读到。设置页要说明这一点，并建议用权限窄的凭据：`setup-token` 只能调模型，细粒度 PAT 只开 Copilot Requests。
- tmux 后端会把环境交给 tmux 服务器，同一用户用 `tmux show-environment` 就能看到。这和在终端里 `export` 一个变量是同一个信任边界，写进文档即可。
- Windows 的 SecretStore 只是文件（§7.2 第 3 条）。补上凭据管理器或 DPAPI 后端之前，Windows 上不开放这项功能。
- 优先级可能反过来：Claude 交互模式下 `ANTHROPIC_API_KEY` 要确认一次，确认结果写进全局配置，所以 `api-key` 不进最小范围。Pi 和 OpenCode 如果是 `auth.json` 里的同一家优先，注入会被用户已有的登录悄悄盖掉。

### §7.4 待实测

| #   | 需要的账号 / 凭据                                                       | 验证什么                                                                                                         | 怎么验证                                                                                                                         |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| T1  | 两个 Claude 订阅（A 已经 `/login`，B 用 `claude setup-token` 生成令牌） | 交互 TUI 里 `CLAUDE_CODE_OAUTH_TOKEN` 能压过 A 的钥匙串登录，并且不写 `~/.claude.json` 和凭据文件                | `CLAUDE_CODE_OAUTH_TOKEN=<B> claude` 起来后用 `/status` 看当前账号；前后用 `agent-e2e/lib.mjs::fingerprint` 对两个文件做字节指纹 |
| T2  | 一个可以丢弃的 Claude 测试账号                                          | 刷新令牌会不会轮换：把凭据复制进另一个 `CLAUDE_CONFIG_DIR` 并刷新后，原目录还能不能用                            | 原目录再启动一次，看会不会报 `Login expired`                                                                                     |
| T3  | 两个有 Copilot 的 GitHub 账号，加 B 的细粒度 PAT（Copilot Requests）    | `COPILOT_GITHUB_TOKEN` 能压过钥匙串里的 A，`lastLoggedInUser` 不变                                               | `COPILOT_GITHUB_TOKEN=<B> copilot` 起来后用 `/user show` 看账号；前后对 `config.json` 做指纹                                     |
| T4  | 一把 OpenAI API key，加一个用 ChatGPT 登录过的 `CODEX_HOME`             | 交互 TUI 认不认 `CODEX_API_KEY` / `OPENAI_API_KEY`，和 `auth.json` 谁优先；`CODEX_ACCESS_TOKEN` 从哪来、多久过期 | 用 `/status` 看当前认证方式；前后对 `auth.json` 做指纹                                                                           |
| T5  | Pi 支持的某家 API key，`auth.json` 里已经有同一家                       | 环境变量和 `auth.json` 谁优先                                                                                    | 环境变量里故意放一把无效 key，看 `pi -p` 成功还是报错                                                                            |
| T6  | 同 T5，换成 OMP                                                         | 环境变量和 `agent.db` 凭据池谁优先；用 `--profile` 首次登录时是否完全不动默认 `agent.db`                         | 同 T5；默认库只比较 `auth_credentials` 的行数和 `updated_at`                                                                     |
| T7  | OpenCode 某家内置提供商的 API key，`auth.json` 里已经有同一家           | 环境变量和 `auth.json` 谁优先；OAuth 条目复制出去后会不会轮换                                                    | 用 `opencode run` 加一把无效 key 来区分                                                                                          |
| T8  | 任意一家的凭据                                                          | bash 工具和 MCP 子进程能不能看到注入的变量                                                                       | 在节点里让模型执行 `env \| grep -c <变量名>`，只看计数                                                                           |
| T9  | 一台 Windows 机器，加 T1、T3 的凭据                                     | Claude 的凭据文件是否按 `CLAUDE_CONFIG_DIR` 分开；Copilot 是否进凭据管理器；SecretStore 文件后端的 ACL 是什么    | 和功能预期总表 §4 的 Windows 真机一项一起做                                                                                      |

## §8 端到端验收：场景 10「六家互读」

`tools/probes/agent-e2e/lib.mjs` 先补三个工具：

- `canvasAs(nodeId, …)`：以指定节点身份执行。现在的 `canvas()` 只能以固定的 `source` 节点执行。
- `inboxOf(nodeId)`：查某个节点的收件箱。
- `conversationsRows()`：查会话索引表。

另外把场景 6 搭四家临时 HOME 的代码抽成可复用的函数。

场景 10 的步骤：

1. 六种 CLI 各起一个交互式 TUI 节点，连成一个环。
2. 每个节点完成一轮短任务后，下游节点用 `context summary` 和 `context transcript` 读上游节点。断言读得到内容，且来源路径落在那家 CLI 的 `configHomeWith` 根下。
3. 沿环 `send` 一轮，断言六条投递都是 `delivered`。
4. 用 `DELETE /api/workspaces/{id}/deliveries/{queueId}` 拒收一条，断言发送方的收件箱出现 `receipt:` 行。
5. 选一对节点走一次交接 prepare → accept。
6. 会话索引里出现六条会话；`GET /api/usage/cost` 里四家不再是 `source: "none"`。

花费控制在每家两三轮「回复 OK」的量级；凭据只复制进临时 HOME。

## §9 批次细化

统一验证：`pnpm libs:build` 后跑 `pnpm --filter @armadra/desktop test`；改到页面的再跑 `pnpm --filter @armadra/web test` 与 `pnpm --filter @armadra/web typecheck`；新增文件、迁移或契约节以后跑 `pnpm check`（新迁移的 sha256 记进 `migrations.lock`）。单测夹具用自编或脱敏的小样本，不提交真实会话内容。

### H0：建 `core/history/`，搬迁 Claude 和 Codex（行为不变）

- 新建 `types.ts`、`registry.ts`（`HISTORY_ADAPTERS`、`historyAdapter()`）、`home.ts`，以及 `entries.ts`：把 `renderEntry` / `readEntry` 里「JSON → role / blocks」的部分抽成 `entriesFromJson`，覆盖 Claude、Codex、OpenAI 三种格式。
- 新建 `claude.ts`、`codex.ts`，把 `conversations/` 的候选与解析、`cost-sources.ts` 的两个来源、`transcript.ts` 的 Codex 查找搬进去。
- 调用点改为经适配器：`conversations/index.ts`（`PROVIDERS`、根目录、扫描、`transcriptTitle`）、`usage/cost-sources.ts`、`collab/transcript.ts` 的 `locate()`、`collab/context-link.ts`、`agent/routes.ts` 的 `GET /api/agent-status/{id}/transcript`、`handoff/capture.ts`；共享层 `CONVERSATION_PROVIDERS` 改为 `AGENT_IDS`。
- 测试：新增 `history/history.test.ts`，覆盖派生出的 PROVIDERS 与旧值相同、`entriesFromJson` 渲染结果和旧实现逐字一致。`conversations.test.ts`、`cost-sources.test.ts`、`transcript.test.ts`、`transcript-summary.test.ts`、`context-link.test.ts` 不改一行，必须全部通过。

### H1：Pi / OMP

- `history/pi.ts`，按 `agentId` 参数化，OMP 复用同一份代码。映射见 §2.2。
- 扩展模板不改。验收：真机起 Pi 和 OMP 节点以后，`agent_status.transcript_path` 非空。如果 OMP 为空，再在 `armadraPayload` 里补 `getSessionDir()` 作兜底。
- 测试 `history/pi.test.ts`：首行的 cwd 与 id、标题、按 sessionId 定位、cwd 加时间兜底、三类记录、四个用量桶与去重。

### H2：OpenCode（只读 SQLite）

- `history/opencode.ts`：每个会话对应一个候选，`path` 为 `opencode:<id>`；`readEntries` 以 `message.time_created` 作游标。
- `usage/cost.ts` 的 `ScanState` 增加快照式分支：`FileState` 以 `located.key` 为键；游标是每家一个「已交出的最大 `time_created`」，作为下一趟的 `sinceMs`，适配器按含等于取、靠扫描状态里跨趟保留的去重集合按消息 id 去重，遇到还没写完的 assistant 消息就停。价格表认不出的模型用 OpenCode 自己记的 `cost` 兜底（契约 §12.1）。`conversations/index.ts` 的 `forgetMissing` 对根是文件（库）的情况按存在处理。
- 交接、转录面板、改名建议与连线读取经注册表定位，`SessionHint` 补上节点终端的 cwd 与启动时间（`collab/nodes.ts::historyHint`），Pi / OMP 的兜底定位因此生效；没有文件的来源交接时把归一化记录写回 JSONL 文本。
- 测试 `history/opencode.test.ts`：测试里自己建最小 schema 的库，覆盖缺列时整家跳过、子会话不进索引、增量读取、只读句柄不阻塞另一个连接写入。

### H3：Copilot 与成本 `unit`

- `history/copilot.ts`，映射见 §2.2；`FileState` 增加 `requests`，存会话累计值的最后一个。
- 成本形状：`AgentCost` 与 `CostPoint.agents` 增加 `unit` 和 `requests`；共享层 `costAgentSchema` 跟着改（缺省 `"tokens"` 和 0）；`UsagePanel` 的取值和 i18n 跟着改。
- 测试：`history/copilot.test.ts`（取最后一条而不是累加；`workspace.yaml` 缺失时 cwd 为空）；`cost.test.ts` 覆盖混合单位时 totals 只合并 token；`UsagePanel.test.tsx` 覆盖 Copilot 显示请求数。

### R1：终态回执（迁移 0029）

```sql
-- 0029_send_queue_receipts.sql
-- 终态是谁定的：'' 旧行 | 'source' 发送方取消 | 'target' 目标侧拒收 | 'gate' 出队时门链拒绝 | 'sweep' 过期清扫
ALTER TABLE agent_send_queue ADD COLUMN settled_by TEXT NOT NULL DEFAULT '';
-- 回执写进发送方收件箱的时刻；NULL 表示还没写。只有 target / gate / sweep 会写。
ALTER TABLE agent_send_queue ADD COLUMN notified_at INTEGER;
```

- `send-queue.ts`：`settle()` 增加 `settledBy` 参数，`cancelOwn` 写 `source`；新增 `settledUnnotified()`；`expireQueue` 按 §4 拆成三步。
- `deliveries.ts` 的 `cancelQueued` 写 `target`；`control/send.ts` 五处 `settle(…, "cancelled", …)` 写 `gate`。
- 新建 `collab/receipts.ts`，提供 `writeReceipts(context, now)` 与 `receiptBody(item, targetName)`。调用时机：`SendPump.sweep()` 清扫之后、`drain` 的 catch 分支里、拒收路由之后；后两处是为了不必等 60 秒的清扫。
- `mailbox.ts`：`unreadDigest` 和 `pendingCount` 排除 `receipt:%`；`inbox()` 返回的行加 `kind: "receipt" | "message"`。`agent.delivery` 事件的 `outcome` 放宽，加上 `expired | cancelled`。
- 前端：「我发出的」浮层见 §4；文案放在 `delivery.queue.*` 所在的 i18n 模块。
- 测试 `collab/receipts.test.ts`：过期写回执且不计入 digest；拒收的回执带上原因；发送方自己取消不写；发送方节点删除后不写回执但有投递记录；重复清扫只写一次。`DeliveryQueueBadge.test.tsx` 覆盖「我发出的」。

### M1：历史数据可用性

- 新建 `history/availability.ts`；`agent/list.ts` 的行加 `history` 字段，共享层 `agentInfoSchema` 加可选的 `history`；修改 `IntegrationPage.tsx`。
- 可以在 H0 之后先做：先只有 Claude 和 Codex 有值，其余显示 `unsupported`；H1–H3 合入后值自动变化，不用再改代码。
- 测试：`agent/list.test.ts` 覆盖三种状态；`IntegrationPage.test.tsx` 断言三个徽标。

### E1：场景 10

按 §8 实施。等其余批次全部合入后再做。

已实施（2026-10-02，`tools/probes/agent-e2e/scenario-10-six-way-context.mjs`，说明见 `tools/probes/README.md`）。与 §8 的差别：「来源」按那家 CLI 实际写历史的根判断——探针的 Claude 用真实配置目录，core 的 `CLAUDE_CONFIG_DIR` 是临时的，所以 Claude 的来源在 `~/.claude` 下，索引与成本靠把这一次的转录硬链接进 core 的根；成本除了 `source` 不是 none，还要求 24 小时窗口里确实记到用量。真跑发现并修掉两处：交接对 Pi / OMP / Copilot 直接交原文，`render()` 不认它们的行形状，转录摘录为空（`handoff/capture.ts` 改为经适配器归一化）；Pi 与 OMP 的根重合时同一个会话在索引里各出现一次（`history/pi.ts` 按文件头的标题记录分家）。OMP 的 `transcript_path` 是否上报仍待装了 OMP 的机器上验证。

### X1：多账号调研

按 §7，只改文档，不写代码。

### 依赖与冲突

| 共享文件                                                                                             | 涉及批次                                | 处理                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `collab/transcript.ts`、`transcript-summary.ts`、`conversations/index.ts`、`usage/cost-sources.ts`   | H0                                      | H1–H3 只新增 `history/*.ts` 并在注册表里加一行，基线必须取 H0 合入之后 |
| `usage/cost.ts`、`cost-buckets.ts`、`packages/shared/src/api/usage.ts`                               | H2（快照式分支）、H3（unit / requests） | H3 先合入，或由同一个人连着做                                          |
| `agent/routes.ts`                                                                                    | H0、R1                                  | 改的位置不同，rebase 可以解决                                          |
| `send-queue.ts`、`send-pump.ts`、`deliveries.ts`、`control/send.ts`、`mailbox.ts`、`migrations.lock` | R1                                      | R1 独占；迁移 0029 已预留                                              |
| `docs/contracts/core-json-api.md` §12                                                                | H3（§12.1）、M1（§12.2）、R1（§12.3）   | 按子节分开写                                                           |
| `tools/probes/agent-e2e/lib.mjs`                                                                     | E1                                      | 等全部合入                                                             |

先后顺序：H0、R1、X1 可以同时开始；H0 合入后 H1、H2、H3、M1 并行（H2 和 H3 注意上表的冲突）；最后做 E1。

### 契约 §12 草案

§12.1 成本行：

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

§12.2 `/api/agents` 行：

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

§12.3 收件箱里的回执：

```json
{
  "sequence": 12,
  "from": "<目标节点 id>",
  "fromTitle": "审查",
  "kind": "receipt",
  "key": "receipt:<queueId>",
  "body": "投往「审查」的消息已过期（TARGET_BUSY，尝试 3 次，正文 412 字）。",
  "createdAt": 1790000000
}
```

## §10 已定事项（2026-10-02 用户确认）

1. **Copilot 成本按请求数单列，不折算成金额。** 单价取决于套餐，本机拿不到套餐信息，折算一定会错；这也符合现有价格表的规矩：没有价格就只显示用量。
2. **回执只写进收件箱，不推进发送方终端，并且不计入唤醒和容量。** 人从 `agent.delivery` 事件和「我发出的」看到结果，Agent 在下一次 `inbox` 时看到。
