# 补全进度

> 状态：已验证进度。逐包记录 [补全执行计划](../design/completion-plan.md) §2 的工作包；框架与决定见 [补全架构](../design/completion-architecture.md)。
> 规矩：每节由对应工作包合入时填写「做了什么 / 实测 / 没做」，只改自己那一节；节标题与顺序由 G0-1 预建，不改。实测写命令与结果（通过数、产物路径、PR）；没做写原因与归宿（需用户提供、后续包、外部条件）。

<!-- G0 基线 -->

## G0-1 文档修正与进度载体

未开始。

## G0-2 共享层与页面骨架

未开始。

## G0-3 core 骨架与契约节占位

未开始。

## G0-4 CI 端到端分档

未开始。

## G0-5 hook-client 抽取与动词表生成

未开始。

## G0-6 设计系统 token 与基础件（WP-D1）

未开始。

## G0-7 本地 dev-stack（W-DEVSTACK）

未开始。

## G0-8 密钥后端按平台补齐（W-SECRETS）

未开始。

<!-- G1 各域 core 与第一部分遗留 -->

## G1-1 节点凭据（多账号第二阶段）

**做了什么**（契约 §20）

- core `agent/credentials/`：`kind → 变量名` 封闭表（第一版只开 Claude `oauth-token`、Copilot `github-token`，其余入表 `enabled: false`）；条目表 `agent_credentials`（新迁移，按协调改用 main 最大号 +1），值在 SecretStore `armadra-credential-<ref>`；`/api/credentials` 增删改查，答复只有 `isSet`。
- 起终端：`POST /api/terminals` 的 `agent.credentialRef` 在起进程前校验（`credential_mismatch` / `credential_kind_disabled` / `credential_unsupported_here` / `credential_backend_insecure`）；节点 shell 环境里只有条目名 `ARMADRA_CREDENTIAL_REF`。唤醒、依赖编排、冷启动读节点数据里的绑定。
- 值的通道：POSIX 启动器 `run/<cli>` 在门内调 `armadra-hook credential`，经本机 hook 面 `POST /credential`（节点 token 必须验过）现取，只认这家 CLI 的变量名，在启动器进程里 `export` 后 `exec`；失败或名字不认识时拒绝起 CLI，不退回默认登录。
- 页面：设置 → Agent 的「节点凭据」区块（列表只显示名字与 `Agent · kind`，新建对话框里未启用的种类灰掉标「待实测」，`file` 后端时只显示原因）；节点头 `AccountBindingBadge` 可选可切（默认登录 + 本 CLI 的条目），写进 `agent.account.credentialRef`；`agentSessionRequest` 上行 `credentialRef`；文案在 `i18n/credentials.ts`。
- 密钥后端多一个 `ARMADRA_SECRET_BACKEND=file-encrypted`（探针用，不碰钥匙串）。

**实测**

- `credentials.test.ts`（17）：映射表封闭、路由只回 `isSet`、库里无值、`file` 后端 / Windows 拒绝、启动前各拒绝码、兑换只认绑定（含 core 重启后读节点数据）、日志无值、hook 面 token 校验、POSIX 启动器的凭据段（设值、无门不问、客户端失败或变量名不认识时拒绝）。
- 页面：`AccountBindingBadge.test`（5）、`AgentCredentials.test`（3）、`launch.test` 的上行用例。
- A 档 `node tools/probes/credentials-e2e.mjs`：15 步全过（CLI 看到的长度正确、节点 shell `env` 里计数为 0、值不在画面 / 日志 / 答复、不匹配被拒、删条目后重跑启动器拒绝）。

**没做 / 需用户提供**

- T1–T9（CLI 协作 §7.4，计划 §5 U1、U5）需要真实账号，按下面的清单做：
  1. T1：两个 Claude 订阅（A 已 `/login`，B 用 `claude setup-token`）。设置 → Agent 加 B 的 `oauth-token`，在 Claude 节点头选它、重启终端；`/status` 应显示 B；前后对 `~/.claude.json` 与凭据文件做字节指纹，应不变。
  2. T2：可丢弃的 Claude 测试账号，验刷新令牌是否轮换（不影响本包开关）。
  3. T3：两个带 Copilot 的 GitHub 账号与 B 的细粒度 PAT（Copilot Requests）。加 `github-token`、Copilot 节点选它；`/user show` 应是 B，`config.json` 的 `lastLoggedInUser` 不变。
  4. T4–T7：Codex / Pi / OMP / OpenCode 的 API key 与已登录状态，按 §7.4 验优先级；通过一项就把 `inject.ts::CREDENTIAL_KINDS` 里对应行改 `enabled: true` 并同步契约 §20.1。
  5. T8：任一凭据，在节点里让模型执行 `env | grep -c <变量名>`，记录计数（预期 1：CLI 的子进程继承，设置页脚注已说明）。
  6. T9：Windows 机器。当前 Windows 一律 `credential_unsupported_here`：C# 启动器 `armadra-launch.exe` 还没有兑换段，要补上并在真机验证后才能开放（与计划「Windows 开放」不同，见下）。
- 偏离计划：Windows 未开放（启动器缺兑换段，本机无法编译验证 C#）；计划写「Windows 与 Linux 都开放」，Linux 已开放（`libsecret` 后端）。
- 设计展示页样本：展示页由 G1-14 建，凭据区块与账号标记的样本待其分区就位后补。

## G1-2 跨主机交接与 Worker 舰队

未开始。

## G1-3 画面门补齐与计划投递接门

做了什么：

- `agent/screen-gate.ts`：特征表改为 `SCREEN_SIGNATURES`，每条带 `verified` 与 `source`；对话框不论核实与否都用，提示符只用核实过的。Codex 新增升级提示第二形态（0.160.0「✨ Update available!」）、Hook 审查、模型迁移、登录、限额换模型、完全访问警告、装 MCP、重建本地库，提示符排除启动 / 接回中的占位；Copilot 目录信任补文档里的选项文字（未核实）；Pi 1.0.0 的「Trust project folder?」（安装包字符串）、OMP 同形（推断，未核实）；OpenCode 文档无启动对话框，不跑门。
- 通用选择菜单判据：最后一处提示符之后的高亮编号选项或菜单页脚按 `<cli>.unrecognized-menu` 拦；同一行既像提示符又像对话框按对话框算。
- `collab/screen.ts::checkScreen` 抽出「取画面 → 判定 → 退回理由」，`send.ts` 改为调它。
- `schedule/dispatch.ts` 探测在写入前过画面门，退回答 `busy` + `reason: TARGET_NOT_AT_PROMPT`；`TargetStatus.reason` 由内核记进运行 `reasonCode`（缺席仍是 `TARGET_NOT_IDLE`）；写入前复核退回的收据带同一理由。契约 §22。
- `packaged-smoke.mjs` 的 Codex 信任断言已在 main（`2d55207a`）改为「没有写回」，本包只改了一条检查项的说明文字。

实测：只用自编画面；特征文字取自本机已装的 Codex 0.160.0、Pi 1.0.0 安装包字符串（`strings`，没有运行 CLI）与官方文档。没有跑真 CLI。

没做：Copilot / OMP / OpenCode 未装机，`verified: false` 的特征与它们的提示符待装机核实（需用户提供真实画面）；Claude 新版本的对话框没有重新扫。

## G1-4 ACP 传输与适配器表（A1）

做了什么：

- `core/acp/types.ts` 只再导出 `@armadra/agent/acp`（0.6.2）的协议类型；`client.ts` 的 `AcpProcess` 包装 `AcpClient`：不经 shell 起进程、unix 自成进程组（Windows `taskkill /T`）、stderr 64 KiB 尾巴脱敏、退出对账（`exited.requested` 区分自己要它退的）、`request_permission` 挂起表（`answerPermission` 只认 Agent 的 `optionId`，`cancel` / 断开 / 退出一律回 `cancelled`）。
- `adapters.ts` 七行表（claude / codex / opencode / pi / omp / copilot / ama）与 `acpLaunchPlan`（权限模式 → `modeId` / argv，没有落点答 `acp_mode_unsupported`）。
- `host.ts`：`startAcp` / `startAdapter`（`initialize` 带截止时间、按表偏好与声明能力选 `load` / `resume`、接不上如实新开、`session/load` 回放标 `replay`、`set_mode`，`plan` 找不到模式拒绝启动）、`probeAcp`、`rememberedAcpVersion`。
- `GET /api/agents` 行加 `acp`（契约 §14.1）；状态来源加 `acp`（`registry.ts`、`target-state.ts`、`hook/store.ts`）；`tools/release/compatibility.json` 加 `acp` 键（不进围栏）。

实测：`client.test`（8）、`host.test`（18）、`adapters.test`（9）、`list.test`（+2）、`hook/store.test`（2）对 `fakeAcpAgentPath()` 真子进程含 `--minimal`；`pnpm libs:build && pnpm -r --if-present test` 全绿（desktop 3558 通过），`pnpm check`、`pnpm release:test`（79）通过。

没做：会话、桥、归一化、镜像、路由与 `install` 装配（G2-1）；`mcpServers` 注入——`AcpClient.newSession/loadSession/resumeSession` 固定发 `mcpServers: []`，G1-5 / G2-1 要在 `@armadra/agent` 加参数或另想办法；各家真适配器的版本区间与 Copilot 旗标、Claude / Codex 的 `sessionId: same` 待真跑（G3-7）。

## G1-5 `armadra-hook mcp`（A3）

未开始。

## G1-6 ACP 会话视图页面（W1）

做了什么：

- 共享层 `api/acp.ts` 按 ACP 设计 §9.2 填 §14.2–§14.4 的 zod：起会话 / prompt / mode / 驱动切换的请求与答复、`GET …/log`（`entries` 是归一化 `TranscriptEntry`，另带可选 `modes` 与 `pending`，重载能画出模式选择与待答卡）、`acp.update` / `acp.turn`（可带 `error`）/ `acp.driver` 三个事件（并进 `workspaceEventSchema`）、`agent.approval` 里的 ACP 载荷；`answerApprovalRequestSchema.optionId`、答复 `route: "acp"`、会话列表行的 `backend`。线上对象一律 `looseObject`，未知的工具 kind / status 落为缺省。
- 页面 `apps/web/src/acp/`：`store`（纯函数归约：分块按回合合并、工具调用按 id 原地更新、回合边界、回显去重、镜像重建）、`SessionView`（没有会话就 `POST /api/acp/sessions` 并把 id 写回节点数据、先订阅再读镜像、读回之前到的分块丢弃、空 / 加载 / 错误 / 离线四态、单张待答卡固定在输入框上方）、`MessageList`、`ToolCallRow`、`DiffBlock`（复用 `PatchBody` 与 `unifiedLineDiff`，工作区内文件可「打开」）、`PermissionCard`（allow / reject 两组，先收起再答）、`PromptBox`（Enter / Shift+Enter、组字不发、聚焦拿人类租约、失焦与提交交还、回合中变停止、Esc 停止）、`driver.ts`。
- `TerminalNode` 按 `data.agent.driver === "acp"` 选节点体（`SessionView` 按需加载，换驱动 120ms 淡入）；头部 `⋯` 与右键菜单加「会话视图 / 终端视图」，当前项打钩，没有 ACP 入口的 Agent 不出现；侧栏会话行 `backend: "acp"` 徽标；`i18n/acp.ts` 中英同步。`StateSourceBadge` 的 `acp` 已由 G1-4 加好，未改。

实测：`store.test`（10）、`SessionView.test`（9）、`PermissionCard.test`（3）、`PromptBox.test`（8）、`DiffBlock.test`（3）、`TerminalNode.test`（4）、`terminal-menu.test`（+2）、`SessionsSection.test`（+1）、shared `api-acp.test`（5）；`pnpm libs:build && pnpm -r --if-present test` 全绿（web 2946、desktop 3558、server 89、shared 303），web / desktop / server typecheck 与 `pnpm check` 通过。

没做：core 的 `/api/acp/*` 路由、事件与镜像（G2-1，形状照本包的 zod）；契约 §14.2–§14.4 正文（G2-1 写，会话列表 `backend` 一并写）；`agent.driver` 缺省时页面按终端画，不读 `agents.defaultDriver`（core 起会话时写明驱动，G2-2 的向导同）；设计展示页（G1-14）未建，没有加展示段；没有用 msw，假 core 是 `vi.mock("./api")`。

## G1-7 `ama` 第七个内置 Agent 与宿主适配器（C1）

未开始。

## G1-8 工作流引擎（C2）

未开始。

## G1-9 实时协同 core（R0）

做了什么：

- `core/realtime/`：`doc.ts`（`Y.Doc` 结构、投影、三方 diff 写入、便签正文 `Y.Text`、白板按 item 拆分）、`store.ts`（更新流、快照、`realtime` / `materialized_seq`）、`hub.ts`（加载 = 快照 + 重放、首个实时客户端切换、逐条落库与转发、1 秒去抖物化、每 500 条快照截断、最后一个客户端离开时物化 + 快照、空闲 60 秒卸载、设置关掉后退回租约模式）、`sync.ts`（`y-protocols` 帧、只读者写帧 4403、坏帧 4400）、`intercept.ts`（core 写者在实时板上经文档写入）、`materialize.ts`（物化前清理文档里表放不下的东西）、`comments-store.ts`（`board_comments` 存取，路由留给 G2-6）、`index.ts`（`WS …/sync` 与 guard、`GET …/realtime`、Hello 能力 `canvas.realtime.v1`、授权变化复核）。
- 迁移 `realtime`（分支上编号 0030，合入时按 main 最大号 +1 改号）；`canvas/documents.ts` 暴露 `materializeBoard`（物化入口）与实时挂点，实时板直写 409 `realtime_active`；`canvas/presence.ts` 实时板不拦写、不显示租约；`main.ts` 退出时物化；共享层 `api/realtime.ts`；契约 §16.1–§16.2。

实测：`core/realtime` 54 例（含 24 个种子的随机并发收敛 + 物化等价属性测试、真 core 上的 WebSocket 两客户端与重启重放）；`documents.test` 加「实时板上直写被拒」、`presence.test` 加实时板一例。

没做：页面侧（绑定、`Y.UndoManager`、光标层，G2-5）；评论路由与 `@`（G2-6）；awareness 状态形状校验（§16.4，G2-5）。设计里写在 `events/stream.ts` 的「hello 能力位」实际放在身份域 Hello 的能力表里（事件流没有 hello 帧）。

## G1-10 Gateway core 下沉（G0）

做了什么：

- `apps/server/src/{auth,tls,csp,web-root,der}.ts` 连同测试搬进 `apps/desktop/src/core/gateway/`（`auth.ts` 改名 `admission.ts`），`serve.ts` 的 TLS 装配抽成 `listener.ts` 的 `openGateway(core, options)`；服务器壳的 `serve` 变成「解析参数 → `openGateway` → `adopt`」，行为不变（原有用例全过）。页面 CSP 的本体从 `shell-core/csp.ts` 移进 `core/gateway/csp.ts`，壳原样再导出。
- 本地 CA（用户选定，架构 §14 Q3）：`<数据目录>/tls/ca.{crt,key}`（私钥 0600、十年、pathLen 0）签叶证书（397 天、SAN = 主机名 + 当前私网地址 + 回环）；地址多出一个或剩 30 天就重签叶证书，CA 不变；CA 与私钥对不上时拒绝而不是悄悄换。三种来源：本地 CA / 指定文件 / 服务器壳的自签名；ACME 报 `acme_unavailable`（G3-5）。
- 设置驱动：`gateway.*` 整段进 `LOCAL_PATHS`；`install` 时按设置开启，`GET/PUT /api/gateway`、`POST /api/gateway/pairing`（契约 §17）；端口 0 开启后写回；`private` 档绑 `0.0.0.0` 按连接本地地址只收回环与私网，30 秒复查地址；关掉即断开经它进来的连接（含升级过的流）。服务器壳上 `/api/gateway` 报 `managedBy: "shell"`，`PUT` 409。
- 准入：Cookie 模式照旧；新增原生 App 的 Bearer 模式（`capacitor://localhost` / `https://localhost`，会话绑 Gateway 来源，密钥走响应体、不发 Cookie，CORS 只回 App 来源）与 `POST /api/identity/ws-ticket`（30 秒一次性，`Sec-WebSocket-Protocol: armadra-ticket.<票>`）。`GET /ca.crt` 匿名。
- 配对载荷：`webUrl = …/#pair=<票>&fp=<指纹>`、`deepLink = armadra://pair?host=…&ticket=…&fp=…`，`fp` 是信任锚指纹（本地 CA 时是 CA）；页面的 `#pair=` 解析认带 `&fp=` 的形式。`packages/shared/src/api/gateway.ts` 填了 zod。

实测（2026-10-03，macOS）：

- `core/gateway/*.test.ts` 全过，其中 `gateway.integration.test.ts` 真起 core 走完：PUT 打开 → 只信 `/ca.crt` 的客户端完整验证链 → 配对成 owner → 成员读共享画布、改 Gateway 403 → Bearer 配对/调用/预检 → ws-ticket 升级与重放 401 → 指定文件来源 → 关掉即断流、重开 CA 与端口不变。`apps/server` 全部用例不改断言通过。
- `node tools/probes/gateway-e2e.mjs`（A 档，需 `pnpm --filter @armadra/desktop build`）通过；`ARMADRA_DEV_STACK=1` 且 dev-stack 的 step-ca 在跑时，「指定文件」一段用 step-ca 中间 CA 签的链验证 `fp` 是叶证书指纹、`/ca.crt` 发链里最后一张、只信 step-ca 根的客户端验得过。

没做：

- 设置页与二维码（G2-7）；ACME（G3-5）。
- 只在回环上实测过监听；`private` / `all` 两档的绑定与筛选只有单元用例（用例不许监听非回环接口）。真手机装 CA、iOS `wss` 与原生 App 的钉证书要真机（U6 / G2-10）。
- 打包后的桌面壳里 Gateway 按 `../renderer` 找页面产物，没在打包产物里验证过（asar 内的路径）；找不到时只服务 API。
- `tools/ci/e2e.json` 还没合入（G0-4），`gateway-e2e` 一行等它合入后追加。

## G1-11 身份加固一：口令策略、限流锁定、passkey、TOTP（I1）

未开始。

## G1-12 OAuth / OIDC / SSO（I2）

未开始。

## G1-13 推送 core（PU）

未开始。

## G1-14 设计展示页与截图探针（WP-D2）

- 做了什么：`apps/web/showcase.html` + `src/showcase/`（`main.tsx` 第一行 DEV 守卫、`ShowcaseApp.tsx` 一次登记 14 个分区、`harness.tsx` 暴露 `window.__showcaseContrast()`、`force-state.css`、`fixtures/`）；`tokens` / `components` / `canvas` / `states` 四个分区做实，`mobile` 在桌面宽度下用 390 宽 iframe，其余九个功能分区是骨架占位，由各实现包换掉自己的 `sections/<id>.tsx`；`vite.config.ts` 的生产入口显式只列 `index.html`；`i18n/showcase.ts`；探针 `tools/probes/design-showcase.mjs` 进 A 档。
- 实测：本机探针 84 张图 + 两张额外图，`status: ok`；对比度深色 84 对最低 3.25、浅色 85 对最低 3.07，全过；`components` 分区 Tab 74/74 可达且都有焦点环；减少动效下画布静止；强制颜色下焦点轮廓 2px solid；控制台无 error。`src/showcase/production.test.ts` 真跑一次生产构建，`dist/` 里没有展示页文件与代码（把 `showcase.html` 加进 `input` 时该用例失败，已验证）。
- 没做：九个功能分区的样本（归各实现包）；分区数是 14 不是设计文档写的 13（表里列了 14 个 id，全部登记），矩阵相应是 84 张；`i18n/showcase.ts` 的文案随消息表进生产包（约 70 个键，i18n 守卫要求每个模块都挂进 `MESSAGE_MODULES`）；shadcn 生成的 `TabsContent` 可聚焦但没有焦点环（探针查出，样本里未放该组件，生成文件未改）。

## G1-15 更新链路修正与通道（W-UPD）

做了什么：

- 发布侧：`stage-desktop.mjs` 把 electron-builder 的 `latest*.yml` 改写成每个目标一份 `latest-<target>….yml`（文件名 = electron-updater 对通道 `latest-<target>` 自己算出的名字，`artifacts.mjs::updaterFeedFile`），只留本目标的更新包，`url` / `path` 换成发布名，sha512 用 base64，按字节对上打包器的条目；`--require-updater` 下缺清单失败。按目标命名是因为两台 macOS / 两台 Windows runner 的 `latest-mac.yml` / `latest.yml` 合并时会互相覆盖，且 macOS 的 arm64 选包规则认 URL 里的 `arm64`。
- `assemble.mjs::verifyFeeds`：清单在、版本对、`files[].url` 已发布、sha512 与 `SHA256SUMS` 的 sha256 指向同一份字节；`latest.json` 每个平台带 `feed: { url, sha256 }`，可选 `rollout: { percent, seed }`（`--rollout`，seed 缺省版本号，不写 `stagingPercentage`）。
- `mock-release-server.mjs` 支持 `ETag` / `If-None-Match`（304）；`dry-run.mjs` 产出含清单，并走一遍「检查（带 ETag 再查得 304）→ 取 `SHA256SUMS` / `latest.json` 验签 → 每个目标取清单与包核对 sha512 / sha256 / 索引 digest / minisign」，`--against <source> --pubkey <file>` 对着别人托管的发布跑；dev-stack 发布夹具同步带清单并签 `latest.json` 与 `SHA256SUMS`。
- 桌面壳：`offer.ts` 的 `MANIFEST_NAMES` = `latest.json` + 六个目标清单名，`latest.json` 条目必须点名本目标清单且与索引摘要一致；`releaseVerdict`（草稿跳过、`stable` 不收预发布）、`rolloutAccepts`（安装 id 与 seed 的 sha256 落桶）、`channelFrom` / `allowPrerelease`、`releaseSourceFor`；`coordinate.ts` 的 6 小时 + 30 分钟抖动 + 启动后 1 分钟、按发布源与通道分开的 ETag 缓存、`updates/install-id`；`UpdatesController.checkRelease` / `startSchedule`，下载前核对清单再设 `autoUpdater.channel`、关回 `allowDowngrade`；`updates:check` 不带答复即「现在检查」；壳读 `settings.json` 取 `updates.*`。

实测：`release:test` 99 过；`feed.test.ts` 用钉住的 electron-updater 6.8.9 的 `GenericProvider` / `MacUpdater.filterFilesForArch` / `findFile` 对回环假发布逐目标取清单并下载、sha512 对上；对 dev-stack `release`（127.0.0.1:8090，开发 minisign 公钥）跑 `release:dry-run --against` 六个目标全过，另用真 electron-updater 对它取 `darwin-aarch64` 清单并下载核对通过；`pnpm libs:build && pnpm -r --if-present test` 全绿（desktop 3643 过），`pnpm check` 通过。

没做：页面的「检查」仍不调壳（`use-update-state.ts` 报 `noReleaseSource`，壳侧定时检查已在跑，页面接线留给后续包）；发布说明里兼容性围栏的检查壳侧未做；清单的 Ed25519 签名（electron-builder 27）与 Windows `publisherName` / `signatureState`（G3-3）；没有真实发布与真签名密钥。

## G1-16 出站地址表与用量端点政策（W-OUTBOUND）

未开始。

<!-- G2 页面与语义闭环 -->

## G2-1 ACP 会话语义（A2）

未开始。

## G2-2 输出到画板与普通用户入口（W2 + W3）

做了什么：

- 输出到画板：`acp/export-to-board.ts` 四条路（便签 + `link` 边、白板文字 + 引用、代码块写文件后建编辑器节点 + 边、Mermaid flowchart 落成白板对象并套一个 Frame、引用指向 Frame，别的图种渲染成图片资产 + 引用），每条路的画布改动包在一个合并会话里，一次撤销全回；失败 sonner 一行 + 重试。`acp/ExportMenu.tsx`：助手消息悬停 `⋯` 与右键（有选区时只输出选中段），不可用项灰掉。白板对象加可选 `meta.source`（`whiteboard/model.ts`）。
- 来源显示：`acp/SourceBadge.tsx`「来自 · 节点名」，点击 `gotoNode` 跳回；便签画在底栏、编辑器画在头部 chips。
- core：`POST /api/workspaces/{id}/exports/{exportId}/text`（契约 §14.5，`assets/exports.ts::writeTextExport`），文件落在 `.armadra/exports/acp/<nodeId>/`，自忽略不进 git；远端工作空间答 501。
- 普通用户入口：`acp/NewAgentWizard.tsx` 三步向导（只列有 ACP 入口的 Agent，没装的灰掉并给复制命令；目录 = 工作区根 + 画布用过的 cwd；模板 chip 预填），创建先 `POST /api/acp/sessions` 带首条 prompt、成功再建节点写好 `sessionId`；失败停在第三步。新建菜单第一项「新建 Agent…」（`add.newAgent`，懒加载挂在 `ToolLayer`）。`acp/templates.ts` 五条模板。
- 缺省驱动：Agent 页「缺省视图」Select 写 `agents.defaultDriver`；新建菜单的 Agent 项写明 `driver`（设置 `acp` 且适配器装了才 `acp`，否则这一家 `terminal`）。
- 简洁模式：`acp/simple-mode.ts` 本机偏好 `armadra.ui.simpleMode` + 隐藏清单；节点菜单、终端头部徽标、侧栏 Agent 面板初值、新建菜单四处按清单收起；Agent 页一个开关。

实测：`export-to-board.test`（8）、`NewAgentWizard.test`（6）、`simple-mode.test`（5）、`SourceBadge.test`（2）、`add-menu.test` 新增驱动用例、core `exports.test` 新增两条；设计展示页 `acp` / `wizard` 两个分区换成真组件，探针截图 12 张、对比度与控制台通过。

没做：真 core 的 `POST /api/acp/sessions` 由 G2-1 实现，向导与 ACP 节点在它合入前起不了会话；代码块文件写在工作区根而不是 Agent 的 cwd 下；远端工作空间不支持代码块导出（501）；落成后的一次 `unread` 光晕没做（只平移相机）；白板对象上的来源只记在 `meta.source`，画布上不显示徽标（引用边已表达来源）；向导第二步没有「选择文件夹…」（没有通用的目录选择器）；`omp` 没有可确认的安装命令，灰掉但不给复制按钮。

## G2-3 工作流页面、再运行与定时（C3）

未开始。

## G2-4 `HostApi.runners` 与 `wait` 动词（C4）

未开始。

## G2-5 实时协同页面绑定与在线光标（R1）

未开始。

## G2-6 评论（R2）

未开始。

## G2-7 桌面 Gateway 设置页与配对（G1）

未开始。

## G2-8 安全页面：会话 / 设备、MFA / passkey 管理、审计（I3）

未开始。

## G2-9 Agent 权限角色（RB）

未开始。

## G2-10 移动网页：连接页与手机细节（M1）

未开始。

## G2-11 存量界面套用一：按钮、空态、手机对话框（WP-D3a）

未开始。

<!-- G3 平台线 -->

## G3-1 Capacitor 移动壳

未开始。

## G3-2 Windows 真机验收包

未开始。

## G3-3 签名、公证与自动更新端到端

未开始。

## G3-4 Linux 打包验证与夜间冒烟

未开始。

## G3-5 服务器部署：镜像、公网部署指南、备份升级

未开始。

## G3-6 服务端性能基线与多主机管理页面

未开始。

## G3-7 真 CLI 端到端：场景 11 / 12 与三家 TUI

未开始。

## G3-8 安全收尾：泄露检查、公网加固、安全审查

未开始。

## G3-9 分发渠道与许可证声明（W-DIST + W-NOTICES）

未开始。

## G3-10 可选崩溃上报（W-CRASH）

未开始。

## G3-11 存量界面套用二：对话框与其余页面（WP-D3b）

未开始。

<!-- G4 收口 -->

## G4-1 文档收口

未开始。

## G4-2 启动兼容退役

未开始。

## G4-3 发布演练 0.2.0

未开始。
