# 补全进度

> 总结（2026-10-05）：G0–G4 与 G5-00…G5-30 全部合并，代码侧没有挂着的工作包；剩下要用户提供账号、证书、设备或域名的事项见[用户待办清单](user-action-checklist.md)。
> 状态：已验证进度。逐包记录 [补全执行计划](../design/completion-plan.md) §2 的工作包；框架与决定见 [补全架构](../design/completion-architecture.md)。
> 规矩：每节由对应工作包合入时填写「做了什么 / 实测 / 没做」，只改自己那一节；节标题与顺序由 G0-1 预建，不改。G5 各节（[G5 剩余事项计划](../design/g5-remaining-plan.md) §3）由 G5-00 预建，规矩相同。实测写命令与结果（通过数、产物路径、PR）；没做写原因与归宿（需用户提供、后续包、外部条件）。

<!-- G0 基线 -->

## G0-1 文档修正与进度载体

> 本节由 G4-1 按 PR #21 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `tools/probes/README.md`：打包冒烟两处「信任记录写进临时 HOME」改为启动器方案（零写入、`--dangerously-bypass-hook-trust`、迁移清掉上一版的会话级信任记录）；新增「分档」一节，按补全架构 §12 列 A / B / C 三档。
- `docs/status/typescript-core-status.md` §60.5：自定义 Agent 拿不到画布审批标「已修（9ba14061）」。
- `docs/design/updates-and-service-install.md`、`docs/status/platform-implementation-status.md` 开头改为「现状入口」，正文保留作历史；`README.md` 改为手机经服务器壳访问、桌面 Gateway 在计划中；`acp-session-view.md`、`coordinator-agent.md` 首部加修订注，`product-roadmap.md` 第三部分第一条同步。
- 新建本文档：49 个工作包各一节，登记进 `docs/README.md`。

**实测**：`pnpm check` 通过。

**没做 / 偏离**：计划正文写「39 个」空节，实际 §2 有 49 个包，按 49 建，并把 `completion-plan.md` 里的数字改成 49。

## G0-2 共享层与页面骨架

> 本节由 G4-1 按 PR #23 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `packages/shared`：`AGENT_IDS` 加 `ama` 与注册表条目；`AMA_HOOK_EVENTS`，`HOOK_CLIENT_REVISION` 4 → 5；`agentIdSchema` 引用 `AGENT_IDS`、`terminalAgentSchema.driver`（`AGENT_DRIVERS`）、`contentSourceSchema` 与便签 / 编辑器的可选 `source`；`AGENT_STATE_SOURCES`、`TERMINAL_BACKENDS` 加 `acp`；`agentInfoSchema` 加可选 `acp` 与 `outdatedHosts`（集成状态也加，留给 G1-2 选用）；骨架 `api/{acp,workflows,realtime,gateway,identity-security,push,credentials}.ts`。
- `apps/web`：`i18n/index.ts` 预登记八个模块；设置导航加 `security` 分区与占位页，`host` 分区标题改「后台服务与对外服务」。
- 依赖（精确版本）：`@armadra/agent 0.6.2`（dev）、`yjs`、`y-protocols`、`lib0`、`@simplewebauthn/server 14.0.3`、`otplib 13.5.0`、`acme-client 5.4.0`。
- 计划外的最小改动：`SettingsDialog.tsx` 挂占位页、`StateSourceBadge.tsx` 与 `i18n/agent.ts` 的 `acp` 来源、`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。

**实测**：`pnpm libs:build && pnpm -r --if-present test` 全绿（shared 295、server 85、desktop 3457、web 2834）；web typecheck 与 `pnpm check` 通过；新增 `completion-skeleton.test.ts`，`agents.test.ts` 改为七个并加 ama 用例。

**没做**：core 侧未动（`registry.ts`、`custom-agents.ts`、`hook/install/events.ts` 仍为 4、`usage.ts`、`hook/store.ts`），由 G1 的 ama 与 ACP 包同步；设置页「安全」为空页（G2-8）；其他模块里「设置 → 连接 → 后台服务」的提示句未随标题改名。

## G0-3 core 骨架与契约节占位

> 本节由 G4-1 按 PR #27 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- 新域空骨架 `core/{acp,workflow,realtime,push,gateway}/index.ts`（只有 `install(context)`），`DOMAINS` 顺序里 gateway 最后；`core/identity/oauth/index.ts` 空的 `installOAuth`。
- `core/http/route-scopes.ts`：新面按前缀先声明 scope；`SELF_GUARDED` / `selfGuarded()`（健康检查、`/api/identity/`、`/api/push/`）。
- 设置键一次加齐（都有缺省，坏值退回缺省）：`gateway.*`、`push.*`、`updates.channel`、`identity.*`、`agents.defaultDriver`、`collab.realtime`、`usage.{claudeUsage,copilotUsage,statusBadges}`、`models.catalog.autoRefresh`、`diagnostics.crashReportDsn`；选项表 `completion-settings.ts` core 与 shared 两份逐字节相同。
- 契约追加 §14–§23 标题与「预留」。

**实测**：`completion-settings.test.ts`（字节一致、缺省、坏值、`statusPage` 沿用、OAuth 提供方过滤）、`routes.test.ts`、`main.test.ts`、`route-scopes.test.ts`、`route-access.test.ts`、shared `api-settings.test.ts`；`pnpm libs:build && pnpm -r --if-present test` 全绿（shared 291、server 85、desktop 3473、web 2834），`pnpm check` 通过。

**没做 / 偏离**：`gateway.*` 与 `push.apns/fcm` 的文件路径没加进 `LOCAL_PATHS`（留给 G1-10 / G1-13）；归一放在 `settings/schema.ts` 而非计划写的 `settings/index.ts`；`agents.defaultDriver` 缺席时由 `completionSettings` 给缺省 `acp`；`usage.statusBadges` 与旧键 `usage.statusPage` 并存，读者由 G1-15 迁移；ACP、工作流路径成员一律 403，等 G2-1 / G1-8 补按对象查画布。

## G0-4 CI 端到端分档

> 本节由 G4-1 按 PR #26 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `tools/ci/e2e.mjs`：`--tier a|b [--only] [--out] [--list]`，逐条跑清单 `tools/ci/e2e.json`，每条输出进 `<out>/<id>/`，汇总 `result.json`；失败或超时非零退出、其余照跑，超时按进程组杀；`ARMADRA_DEV_STACK=1` 且 Docker 可用时先 `dev-stack up`，否则 `devStack` 条目记 `skipped`。
- `ci.yml` 新增 `e2e` 作业（ubuntu，tmux、xvfb、Chrome，`--tier a`，产物上传）；`nightly.yml` 骨架（只 `--tier b --list`）；`validate-workflows.mjs` 加 `checkE2eTiers`。
- 探针修复：`ui-features/presence.mjs` 按同一台设备断言（main 上原本就红）；让 A 档在 Linux 上成立的若干处（node-pty 编译、`remote-e2e` 资源卡、快捷键与编辑器场景、搜索取消、替身 `claude`）。

**实测**：`node --test tools/ci/*.test.mjs` 22 条（新增 `e2e.test.mjs` 7 条）；`pnpm ci:workflows`；本机 `--tier a` 5 条全过；`pnpm check`、`pnpm -r --if-present test`、`pnpm release:test` 通过；PR CI 的 e2e 与三平台 check 全绿（第一轮 macOS / Windows 的既有不稳定用例重跑即绿）。

**没做**：A 档只在 Linux 上跑；`nightly.yml` 只列清单（B 档由 G3-4 填）；浅色主题图片棋盘格两色几乎看不出，探针改用深色主题量，产品侧未改。

## G0-5 hook-client 抽取与动词表生成

> 本节由 G4-1 按 PR #22 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `cli/armadra-hook/{endpoint,http,session,json}.ts` 及两份测试搬到 `apps/desktop/src/hook-client/`，调用方改 import；`HOOK_CLIENT_REVISION` 移进 `hook-client/session.ts`（值不变 "4"），`usage.ts` 再导出。
- 新建 `hook-client/verbs.ts`：画布 / 上下文 / 浏览器动词的工具表（`VERB_TOOLS`、`toolByName`、`toWireArgs`，`binding: "session"`、`long: true`）。
- `electron.vite.config.ts` 只补注释；架构指南进程图加 `src/hook-client` 一行。

**实测**：`hook-client/verbs.test.ts`（画布段与 core `VERBS` 及 `canvas help` 一致、上下文 / 浏览器段与 `--help` 及路由白名单一致、枚举同值、名字唯一、`toWireArgs` 转换与拒绝、依赖方向）；`pnpm libs:build && pnpm -r --if-present test` 全绿（desktop 3475，含对真实 bundle 的 `wire.test.ts`），desktop typecheck / build 与 `pnpm check` 通过。

**没做**：画布与上下文动词的描述与参数 schema 是手写的，参数是否齐全靠评审；`armadra-hook canvas --help` 仍报「expected a canvas verb」，CLI 行为未改。

## G0-6 设计系统 token 与基础件（WP-D1）

> 本节由 G4-1 按 PR #24 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `tokens.css` 只加不改：`--agent-ama`、七个 `--agent-*-text`、`--on-agent`、`--member-1..8`、`--warn-text / --success-text / --working-text`、字号、`--dur-page`、`--r-pill`、三个 z 层；`app.css` 的 `@theme` 映射。浅色 AA 修正（`--success`、`--caution`、`--warn`、`--danger-text`、`--chart-2/3`、浅色 Agent 压暗值）。
- `src/lib/contrast.ts` 与 `tokens-contrast.test.ts`；`agentTextColorVar`；`MobileFocusPage` 与 sonner 用新 z 层，`MotionConfig` 曲线与时长。
- shadcn CLI 加 16 个组件；`ui/agent-avatar.tsx`、`ui/member-dot.tsx`；`ui.test.tsx` 补冒烟与状态矩阵。

**实测**：`pnpm libs:build && pnpm -r --if-present test` 全绿（web 2905）；`pnpm check`、`pnpm --filter @armadra/web build` 通过。

**没做 / 偏离**：浅色 Agent 压暗值比设计表再暗约 5%（侧栏底色上才够 4.5）；`tokens.test` 的「Agent 色只在深色块声明」改为「深色保持原值、浅色另给压暗值」；深色 `--working-text` 叠在 18% 衬底上约 4.1，守卫里跳过并注明；生成组件 import `cn` 包未改；`Spinner` 默认英文 `aria-label`；只在 jsdom 与构建产物上验证，没有截图对比（留给 G1-14）。

## G0-7 本地 dev-stack（W-DEVSTACK）

> 本节由 G4-1 按 PR #28 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `tools/dev-stack/docker-compose.yml`：release、pebble、step-ca、dex、keycloak、mailpit、gitea、glitchtip（+ postgres + redis）、push-sink、hibp、armadra-server，可选 profile `headscale`、`ntfy`；镜像全部钉版本，端口只绑 127.0.0.1。
- `pnpm dev-stack up|down|logs|ps|health`（`dev-stack.mjs`），端口与健康检查唯一来源 `services.mjs`；没有 Docker 时说明原因并退出 0。
- 自写替身：`push-sink.mjs`（假 APNs h2c、FCM v1、Web Push VAPID 验签、`/relay/*`）、`hibp-fixture.mjs`（range API，支持 Add-Padding）、`release-entry.mjs`（每次启动现生成 minisign 密钥并签一份 99.0.0 发布）。`mock-release-server.mjs` 只加监听地址可配。开发密钥首次 `up` 时随机生成到已忽略的 `.data/dev.env`。

**实测**：`node --test tools/dev-stack/*.test.mjs` 18 条（并进 `pnpm release:test`）；本机 OrbStack 真起全栈，11 个默认服务与两个可选服务健康检查通过，手动验证 dex / Keycloak 授权码 + PKCE、Gitea 登录、step-ca `roots.pem`、push-sink h2c；`pnpm libs:build && pnpm -r --if-present test` 全绿，`pnpm check` 通过。

**没做 / 限制**：pebble 默认不回连验证挑战；dex 的 issuer 用宿主机地址，容器间按服务名互访时对不上；`armadra-server` 是占位 `Dockerfile.dev`（等 G3-5），构建上下文改为仓库根；首次 `up` 要几分钟构建；CI 里起全栈属 G0-4。

## G0-8 密钥后端按平台补齐（W-SECRETS）

> 本节由 G4-1 按 PR #25 的正文补记（该包合入早于进度载体启用）。

**做了什么**

- `core/secrets/`：`SecretBackend { kind, get, set, delete }`；实现 `keychain`（macOS `security(1)`）、`dpapi` / `libsecret`（壳封存的信封）、`file-encrypted`（master key AES-256-GCM，支持轮换与中断恢复）、`file`（0600 明文）。挑法按 `ARMADRA_SECRET_BACKEND` → 服务器壳注入 → 桌面壳 `ipc:<kind>` → macOS 钥匙串 → 文件；壳要求 `safeStorage` 而通道不在时拒绝、不降级。
- 桌面壳 `main/secrets.ts` 经 fork 的 IPC 封 / 解（Windows `dpapi`；Linux 只在 libsecret / kwallet 时 `libsecret`，`basic_text` / `unknown` 退回 `file`）；服务器壳 `<数据目录>/secrets/master.key`。
- 名字统一 `armadra-*`（Copilot、GitHub），旧条目第一次读写时一次性迁移，记在 `secrets/migrated.json`；设置页 Copilot 一行按种类说存在哪儿。

**实测**：`core/secrets/secrets.test.ts`（四种后端、名字校验、信封跨后端、master key 生成 / 篡改 / 轮换、IPC 往返 / 超时 / 断开、迁移；`runIf(win32)` 用真 DPAPI）、`main/secrets.test.ts`、`server/secrets.test.ts`、`github/credentials.test.ts`、`usage/routes.test.ts`、`AccountPage.test.tsx`；测试默认 `ARMADRA_SECRET_BACKEND=file`，不碰真钥匙串；`pnpm libs:build && pnpm -r --if-present test` 全绿，web typecheck 与 `pnpm check` 通过。

**没做 / 限制**：`safeStorage` 本身跑不进 vitest，libsecret 没有 CI 行能跑真钥匙环；GitHub 线上枚举仍是两档，契约未改；`rotateMasterKey` 未接 CLI；被别的壳接管的 core 在桌面壳退出后读不到 `dpapi` / `libsecret` 条目。

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

做了什么：

- 跨执行主机交接（契约 §21.1）：`handoff/store.ts` 不再对「SSH 主机 ≠ 工作空间主机」一律 501；来源转录经 `handoff/remote-capture.ts` 到来源主机上读（Worker 操作 `handoff.capture` 加 `transcriptOnly`，实现搬到 `remote/handoff-worker.ts`），`bundle.capturedOn` 记主机 id；主机未登记 / 没配 Worker / 连不上一律 501 `handoff_host_offline`；不读转录时不连那台主机；目标在任何主机都接受。执行主机登记由远端域装配时经 `setCaptureHosts` 接上。
- Worker 舰队（契约 §21.2）：`remote/fleet.ts` 汇总控制连接每次握手的版本与能力（`RemoteWorker` 新增 `onHandshake`），过旧 = 版本更旧或缺本构建 Worker 的任一能力；`GET /api/execution-hosts` 与新增 `GET /api/execution-hosts/{id}` 的 SSH 行带 `worker`；`POST /api/execution-hosts/{id}/resync` 重连、重新握手并调 `RemoteIntegration.resync()` 重新同步注入；`GET /api/agents/{id}/integration` 带 `outdatedHosts`（舰队过旧 ∪ `outdatedWorkers()`）。`outdatedHosts` 只放集成状态，共享层 `agentInfoSchema` 去掉了这个可选字段。
- 能力常量搬到无依赖的 `remote/capabilities.ts`（`operations.ts` / `server.ts` 再导出），免得舰队把整张操作表与语言服务拉进设置域、Hook 域的依赖图（打包后的初始化顺序会坏）。
- 页面：集成页页首一组「Worker 待升级」+「重新同步」，执行主机页每台握过手的主机一个 Worker 徽标（版本或「Worker 待升级」）+「重新同步」；文案进 `i18n/integration.ts` / `execution-hosts.ts`，中英同步。

实测：

- `pnpm --filter @armadra/desktop exec vitest run src/core/handoff src/core/remote src/core/settings src/core/hook src/core/http`：全过（新增 `handoff/remote-capture.test.ts` 7 条：在线 / 离线 / 非执行主机 / 不读转录 / 本机来源 / Worker 侧 `transcriptOnly` / 答复形状；`remote/fleet.test.ts` 7 条：版本比较、过旧判定、舰队汇总、`outdatedHosts` 合并、真 Worker 握手进执行主机行、resync 的 200 / 404 / 501 / 503；`integration.test` 加 resync）。
- 页面：`IntegrationPage.test`、`ExecutionHostsPage.test` 各加 2 条。
- A 档 `node tools/probes/remote-e2e.mjs`（假 ssh，无 sshd）新增第 9 步：本机工作空间里假远端 SSH 终端的 Agent → 本机 Agent 交接，`capturedOn = fake-remote`、转录来自执行主机、文件引用在本机读；执行主机行带 Worker 0.1.0 未过旧；页面点「重新同步」后重新握手。全部 `ok`。

没做：

- 真 sshd 主机上的传输、主机密钥与交接经远端采集（`remote-e2e.mjs --real <host>`）：需用户提供（计划 §5 U4）。
- 设计展示页的样本：本包计划未列，归后续界面套用包。
- Worker 的升级本身（往执行主机上装新 Worker）不在范围：「重新同步」只重连并重新同步注入。

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

做了什么：

- `cli/armadra-hook/mcp.ts`：`armadra-hook mcp` 在 stdio 上讲 MCP（逐行 JSON-RPC，手写，不引 SDK）。`initialize` 回 `tools` 能力、`serverInfo` 与 `instructions`（`collab/skill.ts::mcpInstructions`：画布规则按工具名写，信任规则逐字相同）；`tools/list` 就是 `hook-client/verbs.ts::VERB_TOOLS`；`tools/call` = 一次 `POST <tool.path>`，请求由 `loadSession` / `headersFor` / `controlBody` / `send` 组成，与 `armadra-hook canvas|context|browser` 逐字节相同；`binding: "session"` 的工具从环境补 `sessionId` / `generation`，`handoff-read` 无绑定时与 CLI 同样拒绝；浏览器工具用长预算。另答 `ping`，通知一律不回。错误分两类：非 JSON-RPC、未知方法、未知工具是 JSON-RPC 错误（-32700 / -32600 / -32601 / -32602）；参数不对、没有端点、运行时 4xx 是 `isError: true` 的工具结果。`main.ts` 加子命令、`usage.ts` 加一行用法。
- `core/acp/mcp.ts`：`canvasMcpServer`（命令 = `hookClient()`，参数 `["mcp"]`，环境 = `agentEnvironment` 同一份地址，不带令牌，有会话绑定就加）、`acpMcpServers(adapter, input)`（按适配器表 `injection.mcp`，ama 不加；本机没有客户端时为空）、`clientAcceptsMcpServers`（读 `AcpClient.features.mcpServers`）、`sessionOpener`。`host.ts` 的 `startAcp` 收 `mcpServers`，开会话（new / load / resume）经 opener 带上，结果多一个 `mcpInjected`（只在要求带时出现）；`startAdapter` 收 `canvasMcp`。客户端不支持时调用与原来一模一样。
- `@armadra/agent` 侧：Owlbay/armadra-agent PR #97 给 `AcpClient` 开会话加可选的 `{ mcpServers }` 与 `AcpClient.features`，随 0.6.5 发布；本仓库已升到 0.6.5，`mcpInjected` 为 true（`core/acp/mcp.test.ts` 对假 ACP Agent 实测）。

实测：`cli/armadra-hook/mcp.test.ts`（14：三个方法的线路、工具表与三份 `VERBS` 一致、`tools/call` 与 `armadra-hook canvas` 请求逐字节相同、会话绑定、错误形状、流式乱序与 EOF 排空）、`core/acp/mcp.test.ts`（10：服务器形状、适配器表、特性检测两路、对假 ACP Agent 起会话）；打包后的 `armadra-hook.js mcp` 手动跑通 `initialize` / `tools/list` / `tools/call`。

没做：会话层调用 `startAdapter({ canvasMcp })`（G2-1 装配时传）；Windows 上 `hookClient()` 若落到 `.cmd` 兜底，部分 Agent 不经 shell 起不了它。

## G1-6 ACP 会话视图页面（W1）

做了什么：

- 共享层 `api/acp.ts` 按 ACP 设计 §9.2 填 §14.2–§14.4 的 zod：起会话 / prompt / mode / 驱动切换的请求与答复、`GET …/log`（`entries` 是归一化 `TranscriptEntry`，另带可选 `modes` 与 `pending`，重载能画出模式选择与待答卡）、`acp.update` / `acp.turn`（可带 `error`）/ `acp.driver` 三个事件（并进 `workspaceEventSchema`）、`agent.approval` 里的 ACP 载荷；`answerApprovalRequestSchema.optionId`、答复 `route: "acp"`、会话列表行的 `backend`。线上对象一律 `looseObject`，未知的工具 kind / status 落为缺省。
- 页面 `apps/web/src/acp/`：`store`（纯函数归约：分块按回合合并、工具调用按 id 原地更新、回合边界、回显去重、镜像重建）、`SessionView`（没有会话就 `POST /api/acp/sessions` 并把 id 写回节点数据、先订阅再读镜像、读回之前到的分块丢弃、空 / 加载 / 错误 / 离线四态、单张待答卡固定在输入框上方）、`MessageList`、`ToolCallRow`、`DiffBlock`（复用 `PatchBody` 与 `unifiedLineDiff`，工作区内文件可「打开」）、`PermissionCard`（allow / reject 两组，先收起再答）、`PromptBox`（Enter / Shift+Enter、组字不发、聚焦拿人类租约、失焦与提交交还、回合中变停止、Esc 停止）、`driver.ts`。
- `TerminalNode` 按 `data.agent.driver === "acp"` 选节点体（`SessionView` 按需加载，换驱动 120ms 淡入）；头部 `⋯` 与右键菜单加「会话视图 / 终端视图」，当前项打钩，没有 ACP 入口的 Agent 不出现；侧栏会话行 `backend: "acp"` 徽标；`i18n/acp.ts` 中英同步。`StateSourceBadge` 的 `acp` 已由 G1-4 加好，未改。

实测：`store.test`（10）、`SessionView.test`（9）、`PermissionCard.test`（3）、`PromptBox.test`（8）、`DiffBlock.test`（3）、`TerminalNode.test`（4）、`terminal-menu.test`（+2）、`SessionsSection.test`（+1）、shared `api-acp.test`（5）；`pnpm libs:build && pnpm -r --if-present test` 全绿（web 2946、desktop 3558、server 89、shared 303），web / desktop / server typecheck 与 `pnpm check` 通过。

没做：core 的 `/api/acp/*` 路由、事件与镜像（G2-1，形状照本包的 zod）；契约 §14.2–§14.4 正文（G2-1 写，会话列表 `backend` 一并写）；`agent.driver` 缺省时页面按终端画，不读 `agents.defaultDriver`（core 起会话时写明驱动，G2-2 的向导同）；设计展示页（G1-14）未建，没有加展示段；没有用 msw，假 core 是 `vi.mock("./api")`。

## G1-7 `ama` 第七个内置 Agent 与宿主适配器（C1）

做了什么：

- core 七处一致：`agent/registry.ts` 的 ama 条目与 `expectedProcess`（各家与共享层相同；`expectedProcesses()` 改读它，`.cjs` 后缀也认）、`stateSourceFor("ama") = extension`（`registry.ts` 与 `hook/store.ts` 两份）、`normalize/index.ts` 的 ama 走 Pi 的分支、`launch.ts` 四种权限模式都有 `--permission-mode` 旗标；自定义 Agent、画布校验、Hook 能力表、启动时准备的列表都加 ama；`HOOK_CLIENT_REVISION` core 与 hook-client 对齐为 5。
- 注入：`<数据目录>/integration/ama/{profile.json,config.json,instructions.md,skills/armadra/SKILL.md}`，启动器只追加 `--profile <路径>`；profile 只有路径、没有 key 文件、不信任项目目录，适配器换了位置会重写。执行主机（SSH）与全局迁移跳过 ama。
- 模型密钥：`/api/agents/ama/credentials`（契约 §12.4），按供应商存进密钥后端，不落任何文件；复用 G1-1 的兑换通道（本分支合入了 `feat/g1-1-node-credentials`，合入顺序 #30 在 #35 之前）：`run/ama` 调 `armadra-hook credential --ama`，凭验过的节点 token 经 hook 通道 `POST /credential/ama` 换回 `AMA_API_KEY_<供应商>`，只设给 ama 进程，失败拒绝启动；设置 → Agent 加「Armadra Agent 的模型密钥」一组。
- 启动器按名字参数化（`launcher.ts`、`windows-launcher.cs` 报错前缀随自身文件名）；`<数据目录>/bin/ama` 与 `armadra-hook` 同形；检测 CLI 先找 `<数据目录>/bin`。
- 适配器 `apps/desktop/src/agent-host/ama/{main,client,events,tools,instructions}.ts`：无 `ARMADRA_NODE_ID` 不激活；工具表从 `hook-client/verbs.ts` 生成（读 / 写 / 执行归类，参数按 ama 接受的 Schema 子集），事件按 Pi 词汇上报 `/hook/ama`；信任规则挪到 `hook-client/trust-rule.ts` 与 core 共用。
- 打包：electron-vite 复制钉住的 `ama.cjs`、`ama-sandbox.cjs`，打 `agent-host/ama-armadra.cjs`；after-pack 放进 `resources/`、不进 asar；服务器壳构建同样两件事。`compatibility.json` 记 `agent { package, version: 0.6.2, hostApi: 1 }`，`release:check` 校验它与桌面壳 devDependency、lockfile 一致；`host-api.test.ts` 断言 `HOST_API_VERSION`。

实测：

- `node tools/probes/agent-e2e.mjs <输出> --only 11`：15 项全过（脚本化模型服务、随包 ama、`canvas_team` 建两个成员与两条边、收件箱唤醒后 `inbox → ack → sticky`、`agent_status` 来源 `extension`、key 经兑换到达模型服务的请求头而不在节点 shell 环境、数据目录文件与 core 日志里、画布外同一 profile 无画布工具）。
- 单测：registry / launch / normalize / inject / shared / ama-credentials / routes / agent-host / hook.test / after-pack / version 全过；完整验证见 PR。

没做：

- `HostApi.runners` 与 `workflow_propose`：归 G1-8（契约 §15）；在那之前 ama 的 `task` 保持原样，画布规则要它用 `canvas_team` / `canvas_open_agent`。
- Windows 不另编 `agent/ama.exe`：`<数据目录>/bin/ama.exe` 是 `cli/armadra-hook.exe` 的拷贝（按自身文件名读 `.launch`），签名随原文件。
- 审批画布直答（`approvals.setBroker`）：G2；第一版在节点终端里答。
- Windows 启动器与 SSH 执行主机不兑换 ama 的密钥（与 G1-1 的节点凭据同一限制）：那里的 ama 用它自己的 `auth.json` 与环境变量。

## G1-8 工作流引擎（C2）

- 做了什么：`core/workflow/{types,draft,store,dispatch,engine,service,routes,registry,task-runs,index}.ts`；迁移 `0034_workflow.sql`（草案、模板、运行、步骤、runner 任务五张表）；控制动词 `workflow-propose`（工具 `canvas_workflow_propose`）；bus 事件 `workflow.draft` / `workflow.run` / `workflow.gate`（core 与共享层同步）；`packages/shared/src/api/workflows.ts` 的 zod；契约 §15.1–§15.4。运行建 Frame + 起点便签 + 角色节点，节点经依赖编排的启动路径起、提示词经投递队列投，完成判定复用 `dependencies/evaluate.ts`。
- 实测：`core/workflow/*.test.ts`（草案校验、引擎三种步骤、关卡、取消、无页面推进、重启续跑、重投、路由与动词）；`node tools/probes/workflow-e2e.mjs`（真 core + 假 CLI `custom:wfecho` 走通 prompt → collect 两步模板）本机通过。
- 没做：页面（草案卡、模板库、运行记录，G2 的包）；`wait` 动词与 runner 适配（G2-4，`task-runs.ts` 只有存取）；自动化目标（G2-3）；成员访问 `/api/workflows/*` 仍一律 403（按运行查画布的收窄留给 G2-9）；`workflow-e2e` 等 G0-4 的 `tools/ci/e2e.json` 合入后登记进 A 档。

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

**做了什么**

- 迁移 `identity_hardening`（分支上编号取 main 当时最大号 +1，合入时按协调者的顺序改号）：`identity_credentials` 加 `sign_count / aaguid / transports_json / label` 与「一把 passkey 只属于一个人」的唯一索引；新表 `identity_mfa`（多一列 `last_time_step` 做重放防护）、`identity_recovery_codes`（同批共用盐）、`identity_lockouts`；`identity_sessions` 加 `last_seen_at_ms / remote_ip / user_agent`。`db/absorb-host.ts` 改成只搬新旧两边都有的列。
- `identity/policy.ts`：长度（10–64 可配，缺省 12）、不含账号名、随包常见口令表 `common-passwords.txt`（1 万条，按常见词根 × 前后缀 × 键盘序列规则生成，只收长度 ≥ 10 的）；泄露检查调用点 `checkBreach` 恒为 `skipped`，G3-8 填。表以 `?raw` 内联，服务器壳的 esbuild 加了同名插件。
- `identity/throttle.ts`：按来源 IP 的内存令牌桶 20 次 / 分钟；按 principal 5 次失败起锁 1 分钟、翻倍封顶 15 分钟，不看账号是否存在。
- `identity/passkey.ts`：`@simplewebauthn/server` 14.0.3 做全部校验；RP ID 选取（覆盖 / 公网来源公共后缀 / 请求来源，IP 主机答 `passkey_unavailable_on_ip_host`）、内存挑战 2 分钟一次性、可发现凭据登录与 `userHandle` 核对。
- `identity/mfa/`：TOTP（`otplib` 13.5.0，密钥在 SecretStore `armadra-totp-<id>`）、恢复码（scrypt）、两步登录中间票。
- 路由（`accounts-http.ts`）：`passkey/*` 四条做实加列表与删除，`login` 两步与 `mfa/*`，`sessions*`，`lockouts*`；审计动作表 `SECURITY_AUDIT_ACTIONS`。共享层 zod 与契约 §18.1–§18.4。
- 依赖：`pnpm-workspace.yaml` 加 `overrides` 把 `@peculiar/asn1-schema` 统一到 2.10.0——两份并存时 ES256 断言一律校验失败（`ECDSASigValue` 登记在另一份实例里）。

**实测**

- 软件认证器（`soft-authenticator.fixture.ts`）与真 Chromium 的 CDP 虚拟认证器（`passkey-cdp.live.integration.test.ts`，跑在 `vitest.live.config.mts`）注册 → 登录都过；`origin` / `challenge` / RP ID 不对、计数器回退、挑战重放即拒。
- RFC 6238 SHA-1 向量、重放拒绝；`security-http.test.ts` 走真 HTTP 覆盖策略、锁定、两步登录、恢复码、passkey、会话列表；`accounts.integration.test.ts` 在整个 core 上跑两步登录。
- 服务器壳 esbuild 产物与桌面 electron-vite 产物里都内联了口令表，CJS 打包后 passkey 与 TOTP 照常工作。

**没做**

- 泄露检查（HIBP）：G3-8。安全页、登录页的两步与 passkey 按钮：G2-8。OAuth：G1-12。
- 策略要求 MFA 而本人未登记时不拦登录，只在会话里带 `mfaEnrollmentRequired: true`，由 G2-8 的页面把人带去登记。
- 需用户提供：稳定域名（passkey 的 RP ID，外部服务 §7.2）；没有时以 IP 访问如实不可用，`https://localhost` 与虚拟认证器可完整验证。

## G1-12 OAuth / OIDC / SSO（I2）

**做了什么**

- `core/identity/oauth/`：`providers.ts`（通用 OIDC：发现文档与 issuer 逐字节核对、JWKS 验签只收 RS256 / ES256、`iss` / `aud` / `azp` / 时效 / `nonce`、缺邮箱补 userinfo；GitHub 特例：`/user` 与 `/user/emails`）、`flow.ts`（`state` 内存 10 分钟取出即删、PKCE S256、浏览器绑定 Cookie 防登录 CSRF；绑定 / 登录 / 建号的决定；登记过 TOTP 的人跳回 `#oauth=mfa&challengeId=` 接 §18.3 的第二步）、`http.ts`（`providers`、`providers/{id}/secret`、`{id}/start`、`{id}/callback`、`bindings`、`{id}/logout`）、`index.ts`（挂原样前缀 `/api/identity/oauth/`；公网来源 = `gateway.publicOrigin` + 壳注入的 HTTPS 域名来源）。测试专用：`fake-issuer.ts`（进程内 OIDC + GitHub 假端点，可注入签名 / nonce / aud / 过期 / `alg: none` / issuer 错误）、`harness.fixture.ts`。
- 绑定键按 issuer 派生（`oidc:<sha256 前缀>`、`github`），不用设置里的 `id`；`clientSecret` 在 SecretStore `armadra-oidc-<id>`；不加迁移。
- 共享层 `identity-security.ts` 的 §18.5 小节（拒绝码表 `OAUTH_CODES`、提供方列表、start、绑定、登出）；契约 §18.5。
- 对共享文件的最小改动：`service.ts` 的 `LoginMethod` 加 `"oauth"`；`audit.ts` 的 `SECURITY_AUDIT_ACTIONS` 追加 `identity.oauth.*`；`accounts-store.ts` 加 `liveOAuth(provider, subject)`；`identity/http.ts` 导出 `isSecure` / `sessionCookies`；`identity/index.ts` 把加固实例交给 OAuth；`accounts-http.ts` 退役 `credentials/oauth/*` 的 501；`gateway/admission.ts` 对 `GET /api/identity/oauth/{id}/callback` 放开 Origin 与 `Sec-Fetch-Site`（`oauthCallbackPath`）。分支叠在 G1-11（PR #34）之上，依赖它的 `openSession` 与 MFA。

**实测**

- `oauth.test.ts`（32 条，对进程内假 issuer）：绑定 → 登录同一 principal、未绑定拒绝、`allowSignup` + 白名单建 member（只有 `identity:read`）、GitHub 特例与错误 secret、已绑在别人名下、解绑、TOTP 用户走第二步；`state` 重放（不再换令牌）、绑定 Cookie 伪造、未知 state、`email_verified = false`、域名不在白名单（含子域）、五种 `id_token` 故障、ES256、发现文档 issuer 不符、用户取消、`returnTo` 越界、授权地址参数、SSO 登出地址；源码里的每个拒绝码都在共享层表里。
- `oauth.devstack.integration.test.ts`（`ARMADRA_DEV_STACK=1`，对 `pnpm dev-stack up dex keycloak`，3 条全过）：dex 回环公开客户端 PKCE → 绑定 → 登录、重放拒绝、发现文档无 `end_session_endpoint`；Keycloak `armadra-dev`：建号、`unverified` 用户 `oauth_email_unverified`、SSO 仍在时 authorize 直接跳回、`end_session_endpoint` 登出后再 authorize 出登录页。
- `accounts.integration.test.ts` 起真 core：`oauth/providers` 答 `configured: false`，`oauth/github/start` 答 `oauth_not_configured`；`admission.test.ts` 两条回调放行用例。

**没做**

- 设置页的提供方编辑与绑定区块：G2-8（接口与 zod 已备）。
- dev-stack 用例不在 CI 的默认 vitest 里跑（门控 skipped）；没有加进 `tools/ci/e2e.json`。
- 原生 App（Gateway Bearer 模式）发起答 `oauth_browser_required`：授权页开在系统浏览器里，没有发起时的绑定 Cookie。
- OAuth 登录不受 `identity.mfa.requireFor`「未登记也提示」那条影响；登记过 TOTP 的人照样要第二因素。
- 需用户提供（外部服务 §7.1）：
  - [ ] 稳定的公网来源（`gateway.publicOrigin` 或服务器壳 `--public-origin`），HTTPS 域名。
  - [ ] GitHub：Settings → Developer settings → OAuth Apps 新建，回调填 `<公网来源>/api/identity/oauth/github/callback`，scope 只要 `read:user user:email`；把 client id 填进 `identity.oauth.providers[]`，client secret 经 `PUT /api/identity/oauth/providers/github/secret` 存入。
  - [ ] Google / Microsoft Entra / Keycloak 等：各建一个 OIDC 客户端（授权码 + PKCE），回调同上（`…/oauth/<id>/callback`），scope `openid email profile`；Google 填 issuer `https://accounts.google.com`，Entra 填 `https://login.microsoftonline.com/<tenant>/v2.0`；机密客户端的 secret 同样经 `PUT …/secret` 存入。
  - [ ] 要开放 SSO 建号时：`allowSignup: true` 并填 `allowedDomains`（公司邮箱域名）。

## G1-13 推送 core（PU）

**做了什么**

- `core/push/`：设备登记（挂在身份设备上，覆盖式；原生 App 上交 X25519 公钥）、发送队列（先入队再发，总共最多 3 次尝试，令牌作废即撤销设备，终态留 7 天）、触发规则（`agent.approval` / `agent.status` 进入完成或出错 / `agent.delivery` 失败与回执 / `schedule.*` / `resources.threshold` / `board.comment` 提及 / `workflow.gate`，收件人按 `canvas:read` 过滤，正文按种类与设备语言写死、不读事件内容）、三条传输（Web Push：VAPID 密钥对生成到 `<数据目录>/push/vapid.json` 0600、RFC 8291；`direct`：APNs HTTP/2 ES256、FCM v1 RS256 换令牌；`relay`：只发端到端信封）与未配置时的 `log`。配置由设置 `push.*` 与 `ARMADRA_PUSH_*` 环境变量合成，密钥只给文件路径，两个路径进本机设置（`LOCAL_PATHS`）。
- `/api/push/{config,devices,devices/{deviceId},test}`，契约 §19；共享层 `api/push.ts` 的 zod；`apps/web/src/push/service-worker.ts`（订阅与 worker 处理）。
- `apps/push-relay`（`@armadra/push-relay`）：无状态中继，中继令牌即用中继的钥封起来的平台令牌，只收信封，复用 core 的 APNs / FCM 客户端。**按 §14 Q6 只写完、不部署。**
- 迁移 `0033_push.sql`（合入时按 main 最大号 +1 改号）。

**实测**

- 单测：`core/push/*.test.ts` 5 个文件 44 条（`crypto` 设备私钥能解 / 别的钥与改字节解不开；`triggers` 每种事件一条、无 `canvas:read` 收不到、明文无终端原文；`transport-direct` 对进程内 push-sink 验 APNs ES256 签名、FCM RS256 断言、作废撤销、网络失败重试封顶 3 次；`transport-relay`；`routes`）；`apps/push-relay` 9 条（core → 中继 → 假 APNs / FCM 整条线）；`apps/web/src/push` 6 条。
- `pnpm libs:build && pnpm -r --if-present test` 全绿（desktop 3563、web 2912、server 89、shared 298、push-relay 9）；`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。
- A 档探针 `node tools/probes/push-e2e.mjs`：服务器壳 → push-sink 走 iOS 直连（权限请求与 Stop 各一条，ES256 验签、信封可解、明文与线上都没有夹带的终端原文）、Android 直连、Web Push（VAPID 由 sink 验签）、中继四条线，已进 A 档清单 `tools/ci/e2e.json`；进程内 sink 与 `pnpm dev-stack up push-sink` 的容器各跑一次均通过（容器里 APNs 签名记 `unchecked`，见探针说明）。

**没做**

- 中继不部署、不运营（用户决定）；真 APNs / FCM、真机收推送要发布方的 `.p8`、Firebase 服务账号与运行中继的主机（计划 §5 U8–U10）。
- `schedule.*`、`resources.threshold`、`board.comment`、`workflow.gate` 四种事件今天没有域在发：规则已按契约 §19.6 的字段写好、用例用合成事件覆盖，由调度 / 资源 / G1-9 / G1-8 各自发布时接上。「用户关注的节点」这一层过滤没有数据来源，现在发给全部有 `canvas:read` 的人。
- worker 产物挂到站点根、权限提示与入口归 G2-10；推送设置页区块（「后台服务 → 推送」）的界面归设置页的包，本包只用 G0-3 已建的键。UnifiedPush（ntfy）未做。

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

做了什么：

- `core/net/outbound.ts`：core 自己联网的地址、用途、频率、关闭开关与是否有公开文档；用量、状态页、模型目录、Copilot 设备流的地址都改从表里取。`outbound.test.ts` 扫 core 源码，指向真实主机的 `https://` 字面量没登记就失败（保留域名与模板地址不算）。
- Claude `api/oauth/usage` 与 Copilot `copilot_internal/user`（连同 `github.com` 设备流）按 `usage.claudeUsage` / `usage.copilotUsage` 默认关，和 `usage.providers.<id>` 是「且」。关着时不读凭据、不发请求；本机在用的那家（Claude 看配置目录在不在，Copilot 看自己的密钥存储里有没有令牌）在快照里报 `unavailable` + `reason: "policy_off"`，`POST /api/usage/copilot/login|poll` 答 409 `copilot_usage_disabled`，登出照常。
- Codex 端点照旧默认开、页面标「非官方端点」；答 HTML（标了 `text/html`，或没标但正文以 `<` 开头）报 `unavailable` + `reason: "unsupported"`，不算错误。
- 状态页 Anthropic 一家改用 `status.claude.com`，`fetch` 显式 `redirect: "follow"`，测试钉住「旧地址 302 → 新地址」；`GET /api/usage/status` 改读 `usage.statusBadges`（只有旧键的文档由归一化沿用旧值）。
- `models.catalog.autoRefresh` 接到目录服务的后台刷新上；关掉后后台不抓，手动刷新照常。
- 账号与用量页：Claude / Copilot 开关同时管 provider 与政策两个键、默认关、脚注写条款风险；状态徽标写 `statusBadges`；新增「自动更新模型目录」开关；政策关着时 Copilot 不能开始登录；卡片对 `policy_off` / `unsupported` 说原因而不是「未找到凭据」。升级后第一次在快照里看到 `policy_off` 时弹一次提示，按钮直达「账号与用量」（`localStorage` 记已提示）。

实测：

- `pnpm libs:build && pnpm -r --if-present test` 全绿；`pnpm check` 通过。
- `usage/policy.test.ts`：缺省设置下假端点计数为 0、在用的两家报 `policy_off`；打开 `copilotUsage` 后请求地址与 `authorization: token …` 头；Codex 缺省照常请求、HTML 两种形态判 `unsupported`、坏 JSON 仍是 `parse`。Claude 打开后的请求形状用例在 macOS 上跳过（凭据先查登录钥匙串，测试不碰真钥匙串），Linux / Windows CI 上跑。
- `routes.test.ts`：设备流 409 且假 GitHub 没收到请求；徽标关着时不发请求。

没做：

- 出站表只登记 core 今天真的会连的地址；外部服务 §12.3 里的更新检查（在桌面壳，不在 core）、HIBP（G3-8）、ACME / APNs / FCM / SMTP / GlitchTip 等由各自的包接入时登记，扫描测试会逼它们登记。
- §12.3 表里 Codex 的开关名 `usage.codexUsage` 没有新建，沿用已有的 `usage.providers.codex`（设置选项表按约定不再改）。
- Claude 额度关掉后的替代（按本地 JSONL 统计额度窗口）没做，额度窗口照旧显示不可用；本地成本统计不受影响。

<!-- G2 页面与语义闭环 -->

## G2-1 ACP 会话语义（A2）

做了什么：

- ACP 是终端管理器的一个后端（`core/acp/bridge.ts::AcpBackend`，`BackendKind` 加 `acp`）：会话是 `terminal_sessions` 的 `acp` 行，行、代次、人类租约、输入围栏、退出通知、Eco 休眠只有一份实现。`writeSubmit`（括号粘贴 + 回车）→ `session/prompt`，单个 `ESC` → `session/cancel`，其余字节 `acp_no_raw_write`，`capture` 读镜像，`attach` 409。`manager.spawn` 可点名后端，`manager.revive` 支持在结束了的行上以另一种后端起下一代（驱动切换与 ACP 接回）。
- `core/acp/session.ts`：一个节点一个适配器进程；回合排队、一次一个；先写镜像再发 `acp.update`，我方提示也发一帧；回放只在镜像空着时写进去、从不发给页面；审批进 `agent_approvals`（`request_json = { protocol: "acp", toolCall, options }`），取消 / 退出 / 切换 / 休眠一律回 `cancelled` 并记 `answered_by = core`。
- `core/acp/normalize.ts` + `hook/normalize/index.ts` 的 `case "acp"`：§5.4 全表，经 `hook/ingest.ts::apply` 进同一个 reducer，来源 `acp`。
- `agent/approvals.ts`：`ApprovalRoute` 加 `acp`、`optionId`（必须是 Agent 的选项且与决定同类）、`cancelOpenApproval`；core 启动时把上一进程留下的未答 ACP 审批记成 `cancelled`。
- `core/acp/routes.ts`：`/api/acp/sessions`（节点不必已落盘，带 `prompt`）、`…/prompt`（结束了的行先原地接回）、`…/cancel`、`…/mode`、`…/log`、`/api/acp/nodes/{id}/driver`（同一行上切换，`resumed` 如实答）；路由门按会话行 / 节点查画布（`identity/route-access.ts`）。
- 镜像 `core/acp/mirror.ts` + `history/acp-mirror.ts`（`readHistoryEntries` 先认 `.acp.jsonl`）；`agent/canvas-launch.ts::acpInjection` 按适配器表裁剪注入；ACP 节点的环境不带启动器 `PATH` 与 Hook 等答复变量（一个节点一个状态来源）。
- 休眠：`stateSource = acp` 算上报，`resume: none`（Copilot）记 `noResume`，ACP 会话不敲退出命令、接回不敲恢复行（`hibernator.ts` 的 ACP 分支）；依赖编排与定时冷启动对 `driver: acp` 的节点起适配器、不敲启动行。
- 前台门：ACP 会话的前台是适配器，它下面列这家 CLI 的进程名，`send` / `interrupt` 的门链不改。
- `custom:` 条目的基础 CLI 自己是 ACP 入口（OpenCode、OMP、Copilot、ama）时，条目的启动程序顶替表里的程序（`adapters.ts::adapterFor`，`GET /api/agents` 同一条规则）。
- 页面两处修正（G1-6 的文件）：会话视图写回会话 id 后骨架屏不退（`SessionView.tsx`）；切换驱动后节点头仍写「已退出」（`TerminalNode.tsx`、`driver.ts`）。
- 契约 §14.2–§14.4；架构指南 ACP 一段；A 档 `acp-e2e`。

实测：

- 单测：`acp/{normalize,session,bridge,mirror,routes,driver-switch}.test.ts`、`terminal/hibernate.test.ts` 的 ACP 用例、`agent/approvals.test.ts`、`identity/route-access.test.ts`、`agent/canvas-launch.test.ts`，对 `@armadra/agent/acp` 的假 Agent（真子进程）。
- `node tools/probes/acp-e2e.mjs`（本机 macOS，真 core + Vite + 无头 Chrome）：页面挂载起会话 → 一轮回复 → 审批卡点「拒绝」（`deny`、审计 `route = acp`）→ `armadra-hook canvas send` 投给另一个 ACP 节点（`delivered`）→ 节点菜单切到终端视图（PTY 起来、敲了恢复行）再切回（同一行、代次 1→2→3、CLI 会话 id 不变、之前的对话还在）→ Eco 秒级阈值休眠、页面发一句唤醒（适配器 pid 换了、会话 id 不变）→ 无控制台错误。

没做：

- `elicitation/create`（`@armadra/agent` 0.6.2 的客户端不交出这个请求）、模型经 `session/set_config_option`（起会话时不带模型）。
- `pi-acp` 的 `mapFile`：按 `opaque` 处理（不读映射文件）。
- ACP 驱动下的节点凭据兑换与 ama 的模型密钥（它们经画布启动器，ACP 直接起适配器）；SSH 节点不能切到 ACP（答 `acp_unsupported`）。
- 画布工具注入：会话照常带 `canvasMcp`，`mcpInjected` 要等 `@armadra/agent` 支持传入 `mcpServers` 后才为真。
- 真适配器（六家）的端到端在 G3-7。

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

做了什么：

- core：自动化目标 `WORKFLOW_RUN`（`schedule/types.ts` 的 `workflowRun`、`plan.ts` 归一化与闸门按模板、`workflow-target.ts` 定义时核模板 / 版本 / 画布 / 参数、到点经 `WorkflowEngine.startRun` 起跑，运行 id 由投递的操作标识推出，收据随运行状态 `RUNNING` → `SUCCEEDED` / `FAILED` / `CANCELLED`）；`workflow.gate` 帧带运行 Frame 的 `nodeId`，推送规则只在 `waiting` 时叫人；契约 §15.6、§15.4 补一句。
- 页面：`apps/web/src/workflow/`（草案卡常驻层、工作面板「工作流」页：模板库 / 起跑参数 / 模板编辑器 / 运行记录 / 两次对比 / 关卡答复）；自动化表单新增「运行工作流」目标（模板库「定时运行」预填）；画布「新建」菜单加「工作流」；`StatusPill` 新增 `done` 色调；展示页 `workflow` 分区换成真组件。

实测：

- `workflow-e2e`（登记进 A 档）新增「定时触发一次」：一次性计划到点起跑，第二次运行带计划参数且 `succeeded`，自动化运行 `SUCCEEDED` / `WORKFLOW_SUCCEEDED`，只起一次。
- 浏览器（Vite + 裸 core）：草案卡保存入库 → 模板库 → 填参数运行 → 运行记录展开、关卡「答复」通过 → 运行 `succeeded`。服务器壳 + 无头 Chrome：模板库「定时运行」→ 自动化表单预填 → 保存出一条「运行工作流」计划。

没做：运行中节点头部「第 n 步」徽标与完成节点的绿边（设计系统 §4，在画布节点头部，不在本包文件内）；模板编辑器不增删步骤 / 角色，只改已有步骤、名称与参数缺省值；模板改版后已有定时计划按版本冻结跳过，要人重新保存。

## G2-4 `HostApi.runners` 与 `wait` 动词（C4）

做了什么：

- core：控制动词 `wait`（`collab/control/wait.ts`，契约 §15.5）：`--task [--node] [--since] [--timeout 0–60]` 长轮询，答 `{ status, since, events[] }`，`status` 五值；`done` 认成员 `post` 的 `task:<id>:result`（或 `:result:<轮次>`），没有时认投递之后这一轮干净地结束（依赖编排同一份判定）；`blocked` 带 `approvalId`，只报告；游标是 `<post 序号>-<状态>`；结束时写 `workflow_task_runs` 并把结果 post 标成已收。只有起任务的协调者能等。
- `open-agent` 认 `--task-id`（幂等：同一协调者、节点还在就答回原节点；节点删了就新建并换绑；别人用过回 `409 task_conflict`）与 `--name`（标题）；带任务 id 时记 `workflow_task_runs` 并经 `workflow/dispatch.ts::launchRoleNode` 由 core 起终端。权限模式不支持改回 `400 permission_mode_unsupported`（附 `supported`）。`help` 的结果多 `agents`（内置 + `custom:*`）。
- ama 适配器：`agent-host/ama/runners.ts` 为六家内置 CLI、`ama` 自己（`@armadra/agent` 0.6.7 起调宿主注入的 `ama` runner，场景 11 第 5 步实测 ama → ama）与每个 `custom:*` 注册 runner（`start` = `open-agent --task-id <会话:任务>`，提示词末尾附回报键；`wait()` 循环 `wait`；`blocked` / `needsInput` 只改状态栏；`send` 走队列、键换到下一轮；`stop` 与中止只 `interrupt`）；`agent-host/ama/approvals.ts` 审批回答者按契约 §5.5 写 pending 目录、带 `pendingId` 上报、轮询答复文件，等不到就让给终端对话框。core 给 ama 节点也注入 `ARMADRA_PERM_WAIT_SECS`（同一个 `hooks.replyApprovals`）。
- 成员技能加「任务末尾有 `task:<id>:result` 键就用它回报」一句，`SKILLS_REVISION` 16 → 17；ama 的 profile 配置加 `tools.default: ["+task"]`（`task` 不在 ama 缺省预设里，codemode 又只在 Node ≥ 25 开）；适配器的工具说明加一段 `task` 的用法。

实测：`wait.test`（9）、`runners.test`（10）、`approvals.test`（适配器 4、core 3）；`agent-e2e --only 11` 全部通过，新增的派任务一段：成员 post「派任务」→ 唤醒 → 模型调 `task(agent="custom:taskecho")` → core 起假 CLI 成员并投任务 → runner `wait` → 假 CLI 按键 post → `task` 结果回到模型 → 便签写出结果，`workflow_task_runs` 一行 done。

没做：`--cwd` 与 `--resume` 不支持（`open-agent` 没有这两个参数，runner 忽略 `resume` 并记日志）；提示词连回报说明受投递上限 2000 字约束；成员节点的 `creator_principal_id` 继承协调者创建者（§8.2）没做；e2e 没覆盖 `blocked`（单测覆盖）。

## G2-5 实时协同页面绑定与在线光标（R1）

做了什么：

- 页面 `apps/web/src/realtime/`：`doc.ts`（契约 §16.1 文档结构在页面这一侧的读写：按对象身份只写改过的实体与字段、便签正文按改动的那一段落到 `Y.Text`、读回逐条 zod 校验并沿用内容相同的本地对象与顺序）、`client.ts`（`…/sync` 帧、step1 / step2、退避重连、4403 转 forbidden、断线期间保留别人的 awareness、重连同步完清掉走了的）、`binding.ts`（本地动作 → 本地 origin 事务；非本地 origin → `applyRealtimeState` 灌入；手势中延后；同步完成前不读不写；本地编辑的 `dirty` 当场改回 `saved`）、`undo.ts`（`Y.UndoManager` 管五个根、只追踪本地来源、`captureTimeout: 0` 一个动作一条、合并会话期间放开）、`awareness.ts`（`awarenessStateSchema` 校验别人、按加入顺序取成员色、撞色 clientID 大的换、光标 50ms 节流）、`session.ts`（开板 `GET …/realtime`，`realtime || enabled` 就连；4403 换新文档只读重连；连不上两次复核，设置关着且不是实时板就退回租约）、`CursorLayer`、`OfflineBanner`、`RealtimeSetting`。
- store 两个入口：`applyRealtimeState`（远端灌入，视口 / 选区留本地，不动历史、待存登记与保存态）、`setHistoryDelegate`（实时板上本地历史栈停用、撤销转给 `Y.UndoManager`）；`presence.ts` 加 `realtime` 链接，实时板的只读看同步层、不看租约。`use-board-sync` 在实时板上不再按 `board.changed` 重取、不往回合 HTTP 文档；自动保存对实时板不 PUT（视口也不存）。
- `PresenceBar` 实时板上列 awareness：头像堆叠（自己在前、最多四个 + N）、点头像跟随光标、断线置灰写「已断开」、只读徽标；租约模式原样保留。`CursorLayer` 挂在 `ViewportPortal`：成员色箭头 + 名字标签、120ms 插值、离开 5 秒淡出，选区 1.5px 虚线一圈套一圈。顶部通知条堆栈加「离线编辑」。白板设置页加「实时协同」开关（`collab.realtime`，缺省开，成员不显示）。便签提交时按开始编辑那一刻的正文变基（`rebaseText`），同时输入两个人的字都留下。
- core：`realtime/awareness.ts` 校验 awareness（契约 §16.4）：只留认识的键、形状不对或超过 16 KiB 的整条丢弃、`principalId` 按连接改写、别的连接登记过的 clientID 不能写；共享层 `awarenessStateSchema` / `AWARENESS_LIMITS`，两边上限逐条比对。契约 §16.4。
- 展示页 `collab` 分区：在线条 1 / 3 / 6 人、跟随中、只读、断开，光标与选区，离线编辑（评论与角色留给 G2-6 / G2-9 加在后面）。
- A 档探针 `realtime-e2e`（进 `tools/ci/e2e.json`）；租约语义的 `ui-features` presence 场景与 `server-e2e` 开头先关 `collab.realtime`。

实测：web `realtime/` 8 个文件 51 例（含 `binding.test`、`undo.test`、`CursorLayer.test`、实时版 `two-windows.test`）、`PresenceBar.test` +4、`StickyNode.test` +1；core `awareness.test` 7 例、`sync.test` +2；shared `api-realtime.test` 3 例。`realtime-e2e` 本机通过（两上下文同时拖、光标与选区、同一便签同时输入收敛为「B 写的·中间·A 写的」、断网离线编辑与重连补齐、控制台无错）；`ui-features-e2e --only=presence,layout` 与 `server-e2e` 本机通过；`design-showcase --only=collab` 通过。`pnpm libs:build && pnpm -r --if-present test` 全绿，typecheck 与 `pnpm check` 通过。

没做：实时板的视口不进文档、不再保存（刷新后回到上次租约模式时存下的视口）；白板对象的他人选区外框只画节点，`wb:` 项不画；跟随是跟光标而不是跟对方的视口；评论（G2-6）；拆出 G2-5b 的必要没有出现，光标层与本包一起做完。

## G2-6 评论（R2）

做了什么：

- core `realtime/comments-routes.ts`：`GET/POST …/boards/{boardId}/comments`、`PATCH/DELETE …/comments/{id}`、`POST …/comments/{id}/resolve`（契约 §16.3）；读 `canvas:read`、写 `canvas:write`（路由门之外域内再判一次）；改正文只有作者，删除作者或 owner（记审计 `canvas.comment.delete`）；`resolved=false` 连已解决线程的回复一起去掉。提及记号 `@[显示名](principal:<id>)`（`realtime/comment-text.ts`），只认存在、没停用、对该工作空间有 `canvas:read` 的人；列表带 `people`（可提及的人）。
- 事件 `board.comment`（`bus.ts` 与共享层 `workspaceEventSchema`）：`{boardId, action, comment:{id,parentId,anchorKind,anchorId?}, mentions}`，不带正文；`mentions` 是这一次新叫到的人、不含作者。推送域（G1-13）的规则读的正是 `comment.anchorKind/anchorId` 与 `mentions`，`comments-routes.test` 用真规则核对：叫被提及的人、深链到锚定节点。
- `collab/context-link.ts`：Agent 经连线读节点时，回答末尾附该节点上未解决的评论线程（提及换成 `@显示名`、8 KiB 上限），与正文一起脱敏并计入读取预算；`readableAs` 对可读节点注明「附未解决的评论」。
- 页面 `realtime/comments/`：`CommentLayer`（`ViewportPortal` 里的评论钉，坐标用 `nodeBox` / 白板 item / 点，按 `1/zoom` 反缩放，缩放 < 0.5 只画点，同锚点聚成一枚钉）、Dock「评论」开关（评论模式点画布放钉：节点 → item → 坐标；右侧非模态抽屉，只看未解决、已解决收进 `Accordion`、空态）、`CommentThread`（Popover 线程、回复、解决 / 重开、作者编辑、作者或 owner 删除；只读隐藏输入）、`CommentComposer`（Textarea，`@` 弹 `Command` 选人，离线禁发留草稿，⌘/Ctrl+Enter 发送）；收到同板 `board.comment` 重拉。文案进 `i18n/realtime.ts`（`comments.*`，中英同步）。
- 展示页 `collab` 分区加评论样本：钉四种样子、线程可写 / 只读 / 离线、输入框、抽屉空态与有已解决折叠。A 档 `realtime-e2e` 加第 7 步：A 开评论模式在便签上放钉并发送，B 经事件看到钉，core 列表里锚点是该节点。

实测：core `comments-routes.test` 5 例（只读 / 外人权限、作者改与作者或 owner 删、解决与回复锚点与过滤、`@` 解析与事件形状、记号纯文本），`context-link.test` +3（附评论、预算计入、上限截断、`readableAs`）；web `comments.test` 11 例。`realtime-e2e` 本机通过（含评论一步）；`design-showcase --only=collab` 通过（对比度最低 3.07，控制台无错）。

没做：评论里的 Markdown（正文按纯文本显示，保留换行）；白板对象上的评论不随连线读给 Agent（白板引用不走节点读取路径）；钉的聚合只按同一锚点，没有按屏幕距离聚成「+N」。

## G2-7 桌面 Gateway 设置页与配对（G1）

做了什么：

- 设置 → 后台服务与对外服务加「对外服务」区块（`panels/settings/pages/gateway/`）：开关、监听地址；「更多选项」里是端口（0 显示「自动」，开启后读回写回的端口）、公网来源、证书来源（本地 CA / 指定文件 / ACME 与各自的输入）；运行时出配对卡（二维码 200px 白底黑码、来源多于一个时可选、复制链接、新配对码、两分钟倒计时、指纹按冒号分组、下载 CA）；启动中 `Alert` + Spinner；没能开启按 `error.code` 给本地化文案，不打印 core 的原文；服务器壳托管时控件只读、配对照常；`/api/gateway` 403（成员）时整块不出现。
- 已配对设备表（名称 · 添加时间 · 权限 Badge · 撤销，撤销中 Spinner、失败 sonner）读 `GET /api/identity/devices`，没有身份会话时不出现；与开关无关，关掉后照样列出。
- 经 Gateway 打开的页面（HTTPS、页面与 core 同源、`HEAD /ca.crt` 答 200）在后台服务页顶上给 CA 安装引导（iOS / Android 两页步骤 + 下载），带 `#pair=` 打开时默认展开。
- `host/qr.ts` 换成 `lean-qr@2.7.4`（MIT、无依赖；旧的自写编码器只到版本 6、装不下带票与指纹的链接），加 `pairingQrText` / `parsePairingQr`（认网页链接与 `armadra://pair?…` 两种）。
- 桌面托盘加「对外服务」勾选项（只在 `managedBy: settings` 时出现，点一下 `PUT /api/gateway`，画 core 答回来的状态）；IPC 一条 `app:gateway-refresh`（页面改完让托盘立即重读），preload 暴露 `window.armadra.gateway.refresh()`。
- 展示页 `gateway` 分区换成真组件样本（关闭 / 启动中 / 没能开启 / 过期 / 运行中含设备表 / 手机配对页 CA 引导）。
- `gateway-e2e` 加「从页面开关」，并登记进 `tools/ci/e2e.json`（A 档，要 Chrome）。

实测：

- 本机 dev core（回环 `127.0.0.1`、临时数据目录与 HOME）+ Vite 页面：开关打开后 Gateway 只监听 `127.0.0.1`，端口写回设置；页面二维码用 Chrome 的 `BarcodeDetector` 解码与 `webUrl` 逐字相同（174 字节）；关掉后端口不再监听。
- `gateway-e2e`：无头 Chrome 打开网页配对链接即配对成 owner，配对页出 CA 引导、对外服务开着、二维码是这个 Gateway 的链接、设备表里有这台；在页面上点开关经 Gateway 自己的 `PUT` 关掉，回环读到已关。
- `design-showcase --only=gateway`：三种视口两种主题无控制台错误，对比度通过。

没做：

- 设计系统 §5.12 的 8 位配对码与手机端 `InputOTP` 输入：core 只发两分钟的票（契约 §17.3），没有短码，要 core 先加；本包只做二维码 / 链接配对与倒计时。
- 设备表没有「平台」「最近访问」两列：`/api/identity/devices` 不给这两个字段。
- 桌面窗口里设备表要先有身份会话（「设备登录」里检查连接后才有）；没有自动换票，免得每次打开设置都多配出一台设备。
- 与「设备登录」区块自带的设备列表在同一页会同时出现（那块在检查连接后才有）；合并留给 G3-11。
- 计划列的 `session/gateway.ts` 是终端会话域的网关，与 Gateway 无关，没改。

## G2-8 安全页面：会话 / 设备、MFA / passkey 管理、审计（I3）

**做了什么**

- core：`GET /api/identity/audit` 加筛选（`principalId`、`workspaceId`、可重复的动作族 `action`、`sinceMs` / `untilMs`、游标 `beforeId`、`limit`）与 `nextBeforeId`；新增 `GET audit/export`（CSV，RFC 4180，公式开头的单元格补撇号，最多一万行）；契约 §18.6。
- 页面：`panels/settings/pages/security/`（`SecurityPage`、`PasskeyList`、`MfaSetup`、`OAuthBindings` + owner 的 `OAuthProviders`、`SessionList` + `LockoutList`、`AuditLog`）替换占位页；登录 `session/SignIn.tsx` 两步（账号 → 口令 → 六位码 / 恢复码）、通行密钥、第三方账号按钮、锁定倒计时、离线 Alert，「账号与共享」与「安全」两处共用；`#oauth=` 回调由 `use-link-fragments` 打开到安全页（`signedIn/signedUp` 换会话、`mfa` 进第二步、`bound` 提示、`error` 写原因）；`mfaEnrollmentRequired` 把人带到安全页，页面上策略要求时两步验证排第一并给 Alert。
- 客户端 `api/security.ts`；身份传输 `identityRequest` / `identityText` 支持 PUT/DELETE、文本答案与 `Retry-After`；`session/webauthn.ts` 在没有 `parse…FromJSON` 的浏览器上手工转 base64url。
- 展示页 `auth` 分区换成真组件样本（`fixtures/auth.ts`）。

**实测**

- `gateway-e2e.mjs` 加第 5 步：公网来源设为 `https://localhost:<端口>`，无头 Chrome 独立上下文兑换邀请成为成员，CDP 虚拟认证器，安全页「添加通行密钥」→ 清 Cookie →「使用通行密钥」登录回同一成员；RP ID 为 `localhost`；审计按动作族查到 `identity.passkey.add` 与 `method: "passkey"` 的登录；页面无控制台错误。
- 服务器壳（回环）上手工走一遍：owner 开两步验证（扫码页、恢复码）、审计按「两步验证」筛选并展开详情、清 Cookie 后口令 + TOTP 两步登录、CSV 导出表头与行数正确。
- 展示页 `--only=auth` 六张截图，两主题对比度通过，控制台无错误。

**没做**

- 提供方本身（issuer、clientId、域名、开关）仍在设置 `identity.oauth.providers` 里编辑；安全页只管密钥与看状态 / 回调地址。
- 通行密钥重命名（core 没有接口）、owner 替别人重置 MFA（`POST mfa/reset` 有接口，页面未接）、「忘记口令」（无流程）。
- 设计 §5.9 的整页登录（无侧栏）：登录仍挂在设置对话框的「账号与共享」与「安全」里，组件本身已是整页布局，换入口归改 `App.tsx` 的包。
- OAuth 绑定区块的 dex 集成用例：G1-12 的 dev-stack 用例已覆盖回调；页面这一侧用单测与片段解析覆盖。

## G2-9 Agent 权限角色（RB）

做了什么：

- 角色阶梯（契约 §23.1）：`identity/route-access.ts` 对终端写入、ACP 发提示 / 取消 / 换模式、ACP 驱动切换、审批答复统一按「自己的要 `terminal:create`（operator），别人的要 `terminal:drive` / `approval:answer`（driver）」判；审批的「自己的」按审批行的 `session_id`，旧行按节点最近的会话。关闭确认只在内存里，仍只有 driver。
- 创建者 = 触发者（契约 §23.2）：新增迁移 `node_creators`（分支上 0035）与 `identity/creators.ts`。控制动词 `open-agent` / `open-terminal` / `team` 在存盘前记下调用方节点终端的创建者（ama runner 经 `open-agent` 同样落在这里），工作流 `layoutRun` 记起跑的人，库里的触发器让之后任何一条路起的会话行都继承；冷启动起完后按自动化的创建者（owner）改写（`schedule/cold-start.ts::stampColdStartCreator`）。路由门对记过触发者的节点不再把「恰好起它的人」写成创建者；`POST /api/acp/sessions` 答已有的或原地接回的同一行时不改写创建者（原先 operator 对着 driver 的节点调一次就能把会话变成自己的）。
- ACP 与工作流的成员访问（契约 §23.3）：`/api/workflows/*` 按草案 / 运行 / 画板（查询串或请求体）查画布；列表不带 `boardId` 对成员 403（raw 路由过滤不到答案）；起跑、取消、确认 / 丢弃草案、关卡答复要 `agent:launch`（关卡在 `route-scopes.ts` 单列，常量 `workflow/routes.ts::GATE_SCOPE`）；模板对「在任意画布上能起 Agent」的成员只读，改模板只有 owner。ACP 的查找 G2-1 已补，本包加了驱动切换的「自己的」与开会话的改写保护。
- 终端会话 JSON 加可选 `creatorPrincipalId`（读行时带）；页面 `use-access.ts::useCanAnswer` / `canAnswerFor`：driver 照旧，operator 对自己起的终端也摆审批按钮（终端节点头与 ACP 权限卡）；答不了的人在 ACP 权限卡上看到「等待接管」徽标（设计系统 §5.8）。
- 展示页 `collab` 分区加角色样本：成员表（可改 / 只读）、审批卡三种看法。契约 §23、服务器账号设计 §6 两行。

实测：core `route-access.test` 78 例（全局权限表加审批四行：operator 答自己起的 / 别人起的、自动化起的、ama 起的，另有 ACP、工作流各行），`identity/creators.test` 7 例（真库：触发器继承、冷启动改写、审批 / 驱动切换 / 工作流查找），`collab/creators.test` 3 例，`workflow/routes.test` +2；服务器壳 `roles.integration.test` 5 例（owner + 两个 operator + driver + editor + viewer + 局外人，真 HTTPS）；web `use-access.test` +3、`PermissionCard.test` 改 1。`design-showcase --only=collab` 通过、控制台无错。`pnpm libs:build && pnpm -r --if-present test` 全绿，typecheck 与 `pnpm check` 通过。

没做：终端节点头（非 ACP）的审批在答不了时仍是不显示按钮，没有「等待接管」徽标（头部组件归别的包）；成员能建自动化之前，冷启动的创建者恒为 owner（`creators.ts::AUTOMATION_CREATOR`）；runners（G2-4）若不经 `open-agent` 建节点，要自己调 `recordNodeCreator`。

## G2-10 移动网页：连接页与手机细节（M1）

**做了什么**

- 入口分支（`main.tsx` → `mobile/entry.ts` + `MobileRoot.tsx`）：原生 App（Capacitor，页面来源 `capacitor://localhost` / `https://localhost` 且 `Capacitor.isNativePlatform()`）没有记下的 Gateway 或钥匙串里没有它的会话 → 连接页；手机浏览器经 Gateway 打开、窄屏、带 `#pair=` → 连接页（票留到点「连接」才取走，CA 引导的「回到这一页刷新」之后仍可配对）；其余（桌面窗口、宽屏、普通网页）直接是画布，不发请求。
- `mobile/ConnectScreen.tsx`：BrandMark + 标题 + 一个动作；原生贴配对链接（网页链接或 `armadra://pair` 深链，复用 `host/qr.ts::parsePairingQr`）或扫码；网页只差「连接」并带 `PageCaGuide`。错误在字段下 / 一条 Alert。`mobile/connect.ts`：原生先钉指纹、再配对（`pairWithGateway`）、记下来源、重载。
- `mobile/native-bridge.ts`：插件 `Capacitor.Plugins.ArmadraNative`（`getSession/setSession/clearSession/pin/scan/pushRegistration`，形状写在文件头）；不在 App 里是空实现。`installNativeTransport` 包 `fetch`（发往 Gateway 的补 Bearer、401 轮转一次重发）与 `WebSocket`（升级前换 `ws-ticket`，`Sec-WebSocket-Protocol: armadra-ticket.<票>`），调用点不改。
- `api/runtime-url.ts`：`savedRuntimeOrigin / saveRuntimeOrigin / forgetRuntimeOrigin / isNativeAppPage / gatewayOrigin`，只有原生 App 的页面认记下的来源。`api/identity.ts`：原生 App 与桌面壳同走 Bearer，密钥另存钥匙串；`pairWithGateway`、`restoreNativeCredentials`、`fetchWsTicket`、`currentAccessToken`；刷新也被拒时清钥匙串回连接页。
- 推送：`mobile/PushPermission.tsx`（手机布局或 App 里、登录后问一次，浮在底部导航上，焦点页打开时让开；浏览器走 `subscribeToPush("/sw.js")`，App 走插件令牌 + `PUT /api/push/devices`）；`mobile/sw.ts` 由 `vite.config.ts` 的插件单独打成 IIFE 挂在站点根 `/sw.js`（约 138 KB，开发服务器按请求现打）；`mobile/push-open.ts`：SW 消息、`#push=<深链>`（SW 新开窗口与原生 App 都走它）→ 打开工作空间并进节点焦点页。
- 焦点页：ACP 驱动的终端节点不出 PTY 按键条；会话视图输入 16px；`mobile/keyboard.ts` 在 iOS 软键盘盖住页面时按可视视口摆整页。顺手修了 `acp/SessionView.tsx`：同一节点同时挂两份会话视图（焦点页 + 画布）时每个分块被拼两遍，现按事件对象去重。
- 展示页 `mobile` 分区换成六块 390×844 的真组件样本（原生未连接、网页扫码打开 + CA 引导、配对失败、推送提示、焦点页会话视图、焦点页终端按键条）；`i18n/mobile-connect.ts` 中英。

**实测**

- A 档 `ui-features-e2e --only=mobile`（新场景，经 Gateway 本地 CA、回环、托管 `apps/web/dist`，Chrome 经 CDP 只对自己忽略证书错误）：390×844 扫码链接 → 连接页（含 CA 下载）→ 点「连接」配对成 owner、票被抹掉 → `#push=armadra://w/…/n/…` 打开焦点页会话视图（无按键条、输入 16px）→ 发一句假 ACP Agent 回复流入 → 768×1024 回到画布；控制台无错误。
- 展示页探针 `--only=mobile` 六张图，对比度与控制台通过。

**没做**

- 8 位配对码（core 只有两分钟票，同 G2-7）；PromptBox 的模式 Select 在手机上收进「⋯」（`acp/PromptBox.tsx` 不归本包）；评论在焦点页的布局等 G2-6 合入。
- 原生侧全部未验证（插件由 G3-1 实现）；`<img src>` 直连 core 的资源在 App 里不带 Bearer。
- 推送订阅没有在真浏览器里跑通：无头 Chrome 忽略证书错误时不给注册 service worker，要装好 CA 的真机（U6）。

## G2-11 存量界面套用一：按钮、空态、手机对话框（WP-D3a）

- 做了什么：本包文件集合里的手写 `<button>` 全部换成 `Button` / `Toggle`（`SettingsRow` 标签钮、三个节点徽标、手机底部导航、工具簇用量环、用量图例与热力格、Git 的 Reflog / 储藏 / 提交日志 / 分支树 / 提交详情），一文件一提交；文件树、资源抽屉、项目搜索、Agent 查看对话框的加载 / 错误 / 空态换 `Skeleton` / `Alert` / `Empty`（文案键不变，加载文字留给读屏）；新建 `panels/ResponsiveDialog.tsx`（≤767 换 `Sheet side=bottom`：顶部圆角 14、拖柄、最高 `100dvh-48px`、让出安全区），克隆仓库、新建文件夹 / 文件、Agent 查看、Git 储藏与日志菜单、工作树对话框接上；`TabsContent` 焦点环由调用方加 `panels/tabs-focus.ts` 的 `TABS_CONTENT_FOCUS`（生成文件不改）；状态胶囊的字改用 `-text` token、衬底 15% → 10%；展示页 `components` 补 TabsContent、ResponsiveDialog / AlertDialog / Sheet、Popover / HoverCard / BrandMark、ScrollArea，`states` 补列表与树里的行内形态。
- 实测：守卫 `panels/no-raw-button.test.ts`（名单文件与 `panels/usage`、`panels/git`、`sidebar` 目录无 `<button`）；`ResponsiveDialog.test`（桌面 Dialog / 手机底部 Sheet / Esc）；`ui/status-pill-contrast.test.ts` 逐 tone 逐主题算三档阅读表面，深色 working 字在卡片衬底上约 4.6（原来拿图形色写字约 3.6，把衬底改回 15% 时该用例失败）；改动文件的既有用例未改断言。展示页探针 `components,states,mobile` 前后对照：控制台无 error，`components` Tab 可达 80/80 且都有焦点环（新增的 TabsContent 也有），对比度两主题全过。
- 没做：`command` 样本没放进展示页（`CommandInput` 外层 `InputGroup` 的 `shadow-none!` 压掉了焦点环，生成文件不改，归 G3-11）；`resizable`、`chart`、`sonner`、`context-menu` 的样本未补；`QuickOpen` 与 `SidebarSearch` 用的是 `CommandEmpty`，保持不变；`NodeNameBadge`、`WebviewTabs`、`MobileFocusPage`、`SettingsDialog`、`IntegrationPage`、`references` / `resources` / `problems` / `github` 面板与 `HandoffBadge`、`LanguageStatus` 里的手写按钮不在本包文件集合，留给 G3-11；计划写的 `patterns` 分区不存在，样本补在 `states` 分区。

<!-- G3 平台线 -->

## G3-1 Capacitor 移动壳

**做了什么**

- `apps/mobile`（`@armadra/mobile`，Capacitor 8.5.2 精确版本）：`capacitor.config.ts` 不配 `server.url`，`scripts/prepare-web.mjs` 把 `apps/web/dist` 拷进 `www/` 并把插件桥（`src/bridge.ts`，`registerPlugin("ArmadraNative")` 打成 IIFE）插在页面模块脚本之前；页面仍不依赖 `@capacitor/core`。
- iOS：`ArmadraBridgeViewController` 装插件；`ArmadraNativePlugin.swift` 钥匙串存会话（首次启动清残留）、挂 WKWebView 认证挑战按信任锚指纹钉扎（配对时取 `/ca.crt` 按指纹核对后才存锚）、AVFoundation 扫码、APNs 令牌 + 设备 X25519 公钥（`ARMADRA_MOBILE_RELAY_URL` 时先换中继令牌）、`armadra://` 深链；Notification Service Extension 解密信封；纯逻辑在 SPM 包 `ios/ArmadraNativeKit`；`AppUITests`（XCUITest）。
- Android：`SecureStore`（Keystore AES-GCM）、`PinningWebViewClient`（`onReceivedSslError` 只放行验得到钉住锚的叶证书）、`AnchorFetch`（两步取锚，不用信任一切的 TrustManager）、Google 代码扫描器、`ArmadraMessagingService`（FCM 数据消息解密）、深链；纯逻辑在纯 JVM 模块 `android/armadra-native-core`（BC 1.86）；插桩 `ConnectFlowTest`。
- 页面：`mobile/entry.ts` 认 `#link=`（原生收到配对深链后写入）进连接页并预填；修了 G2-10 的会话密钥形状（`native-bridge.ts` 原先只认 43 位半段，App 重启后读回的会话一律作废）。
- 发布与 CI：`tools/release/artifacts.mjs::mobileAssets`（`armadra-mobile_<v>_android-debug.apk`、`armadra-mobile_<v>_ios-simulator.app.zip`）；`apps/mobile/package.json` 进版本清单；`nightly.yml` 的 `mobile-ios` / `mobile-android`；探针 `tools/probes/mobile-shell-e2e.mjs`；`repo.rules.json` 加 `apps/*` 包名规则；客户端平台指南加原生一节与真机 / 商店清单。

**实测**

- `swift test`（ArmadraNativeKit）14 例、`armadra-native-core` 12 例 JUnit（本机 JDK 25 + BC 与 CI 上 Gradle 都过）、`@armadra/mobile` vitest 9 例；`pnpm libs:build && pnpm -r --if-present test` 本机全绿；`pnpm check` 通过。
- 本机：`xcodebuild build-for-testing`（iphonesimulator，App + NotificationService + AppUITests）通过；core 起在回环、Gateway 本地 CA、铸出带 `fp` 的原生深链（探针前半段）通过。
- CI `nightly`（分支上 workflow_dispatch，run 37132390772）两条都绿：`mobile-ios`——`swift test`、本地签名的模拟器构建、iPhone 17 Pro 上 XCUITest「没有 Gateway 是连接页」与「深链 → 钉扎 → 配对 → 画布 → 重开仍在画布」，产出 `armadra-mobile_0.1.0_ios-simulator.app.zip`（9.4 MB）；`mobile-android`——`armadra-native-core:test`、API 34 模拟器里同一条流程（logcat：取到 2 张证书、TLS 放行），产出 `armadra-mobile_0.1.0_android-debug.apk`（14 MB）。
- 实跑中修掉的三处：会话密钥形状（见上）、模拟器包关掉签名时钥匙串不可用（改「Sign to Run Locally」）、配对票两分钟被 macOS 上的编译耗尽（探针先编完再铸票）；另外关掉了 Capacitor 的插件调用日志（会把会话密钥写进设备日志）。

**没做**

- 真机、签名、TestFlight / Play 上传、APNs / FCM 生产密钥：需用户提供（计划 §5 的 U8–U10，清单在[客户端平台](../guides/client-platforms.md)）；真机推送与 NSE 解密只有单测。
- 本机 Xcode 27 的 CoreSimulator 过旧且没装 iOS 运行时，模拟器只在 CI 上跑；本机没有 Android SDK。
- Android 上系统已信任的证书（ACME / 反代真证书）由系统校验，指纹不参与（WebView 无钩子）；FCM 令牌轮换不主动重登记；通用链接（`apple-app-site-association` / `assetlinks.json`）等域名（外部服务 §5.3）。
- 探针要模拟器，不进 `tools/ci/e2e.d/` 的清单，由夜间作业直接跑。

## G3-2 Windows 真机验收包

做了什么：

- 验收探针 `tools/probes/windows-acceptance.mjs`（纯函数与 CDP 在 `windows-acceptance-lib.mjs`，临时 HOME 用 `probe-home.mjs`）：`--installer` 静默装 NSIS 包到临时目录、`--app` 对着已装的跑、`--dry-run` 只验脚本；22 项检查（安装与包内布局、Authenticode、更新器状态、sessionHost 后端、cmd / pwsh 7 / 5.1 三个终端的回显与 capture、会话宿主进程与命名管道、三种 shell 里 `armadra-launch.exe` 的参数 / 注入 / 门 / 凭据兑换、DPAPI 凭据状态、回环 Gateway 的 TLS 与关闭、文件监听、保活与资源采样、杀主进程后接回、ConPTY 关闭证明、日志、静默卸载、真实用户配置前后快照），写 `result.json`（形状与回传方式见开发指南「Windows 真机验收」）。干跑进 `pnpm release:test`（三平台）；`nightly.yml` 新增 `windows-acceptance` 作业在 windows runner 上打包并完整跑一遍（保活两分钟），失败进 report 作业的 issue 表。
- 会话宿主后端的 capture 接 `replay-screen.ts`（状态 §60.5 第三条）：字节排成当前一屏，多帧回放只在首帧重来、多条附着只由最新的一条喂屏幕。
- Windows 启动器兑换节点凭据与 ama 密钥：`.launch` 多 `credential=` / `credential-var=` / `ama-keys=` / `ama-var=`，`armadra-launch.exe` 起 `armadra-hook credential [--ama]` 读标准输出，名字不在名单、客户端失败或缺席都拒绝启动；core 在有 `armadra-launch.exe` 时对 Windows 开放节点凭据（没有时仍 `credential_unsupported_here`）。契约 §20.2–§20.4、§12.4 与文案同步。
- 探针在 runner 上跑出来、随包修掉的 Windows 问题（之前打包版 Windows 实际不可用）：桌面壳让 core 听 `unix:C:\…\runtime.sock`，core 拒绝、窗口弹「后台未就绪」——改为命名管道（`main/runtime-process.ts`）；会话宿主取 SID 的裸 `whoami` 在 PATH 有 Git usr\bin 时是 GNU 版——改系统 `whoami.exe` 绝对路径；包外的 `session-host/host.cjs` 找不到 `node-pty`——从 `app.asar.unpacked` 加载；页面一松开终端，会话宿主后端把关连接当成会话退出、行被记 `exited`——主动松开不再报退出；会话宿主建会话只带注入的变量、终端环境继承表按大小写精确匹配，Windows 的 `SystemRoot` / `ComSpec` / `TEMP` 全丢、PowerShell 5.1 起不来（8009001d）——补基础环境并在 Windows 上不分大小写、补系统变量（不含 `PSModulePath`）。

实测：

- windows runner（Windows Server 2025 Datacenter 10.0.26100，pwsh 7.6.6，PowerShell 5.1）上的未签名本地包，`nightly` 运行 37141727509 的 `windows-acceptance` 产物：`status: passed`，20 项过、`install.signature` warn（未签名）、`agent.codex` skip（runner 无 Codex），全程 218 秒；保活两分钟内会话宿主 83→67 MB、句柄 267 不变，杀主进程后三个 shell 同 pid 接回并应答，终止后会话宿主名下的控制台宿主 3→0，卸载后安装目录、注册表卸载项与两个快捷方式都不在，真实用户配置 16 处未变。
- CI 的 Windows 作业：`windows-launch.test.ts` 新增三例（凭据兑换、拒绝、ama 多行）真编 `armadra-launch.exe` 跑过；`session-host/capture.test.ts`（命名管道 + 假控制台）与 `runtime-process.test.ts` 的管道占用用例在 Windows 上跑。
- 本机：`pnpm libs:build && pnpm -r --if-present test` 全绿；`pnpm check` 通过。

没做：

- 真机（用户的 Windows 10 / 11、真 CLI、30 分钟保活、用户自己的 shell 配置）没有跑：需用户按开发指南跑一次 `--installer`（有 Codex 时加 `--with-codex`）并回传 `result.json`。
- 会话宿主空闲三十分钟才退：应用退出后马上卸载或升级时，宿主仍占着 `Armadra.exe`。electron-builder 的 NSIS 会按安装目录结束进程，但一次 runner 运行里卸载后仍留下了 `armadra.exe`（删除与进程退出赛跑）；探针收尾时先结束它再卸载，并把结束掉的进程记进 detail。是否让宿主在没有会话且没有 core 连着时提早退出，留给后续。
- `agent.codex` 只验「启动行是 `run\codex.exe`、画面出现 Codex」，不验对话；Claude / Copilot 等其他 CLI 与 SSH 节点未覆盖。

## G3-3 签名、公证与自动更新端到端

做了什么：

- macOS（W-SIGN-MAC）：`signing-electron.mjs` 的公证凭据改为「App Store Connect API key 三件套（`APPLE_API_KEY` 为 .p8 路径 / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER`）**或** Apple ID 三件套，任一完整即可」，两套都在时 API key 胜出并把另一套从环境里拿掉（`unsetEnv`，app-builder-lib 见 `APPLE_ID` 就走 Apple ID 分支）；`.p8` 路径不存在、证书缺口令、某一套给一半都在构建前拒绝。`ARMADRA_MAC_ADHOC_SIGN=1` 是本地演练（ad-hoc 身份 `-`、不公证，发布与真证书在场时拒绝）。`release.yml` 预检把 `APPLE_API_KEY_P8_BASE64` 解到 `$RUNNER_TEMP/AuthKey.p8` 并 `notarytool store-credentials --key … --validate`，只把选中的一套写进 `GITHUB_ENV`；签过名的包上传前 `signing-electron.mjs verify-mac`（`codesign --verify --deep --strict`）。
- Windows（W-SIGN-WIN）：签名计划按平台分，Windows 三条路三选一——Azure Artifact Signing（凭据 + 端点 / 账户 / 证书配置 + `ARMADRA_WIN_PUBLISHER_NAME` 齐全才合并 `win.azureSignOptions`，显式 `timestampRfc3161` 与 SHA256）、证书文件（`CSC_LINK`，钉了名字就加 `win.signtoolOptions.publisherName`）、自托管 runner 证书库（`ARMADRA_WIN_CERT_SHA1`）；给一半或配了两条都拒绝。工作流读 `.pfx` 主体 CN 与 `publisherName` 逐字核对（`check-publisher`），签过名的安装包与 `armadra.exe` 必须 `Get-AuthenticodeSignature` 为 `Valid`（`verify-windows`）。`nsis.artifactName` 改成无空格的 `Armadra-Setup-${version}-${arch}.${ext}`，暂存仍认旧名。`environment.ts::signatureState` 的 Windows 分支真实现：`Get-AuthenticodeSignature` 子进程（每进程一次），`Valid` 才 `signed`、`NotSigned` 为 `unsigned`、其余（含自签证书的 `UnknownError`）为 `unknown`。
- Linux（W-SIGN-LINUX）：新建 `tools/release/sign-gpg.mjs`——`ARMADRA_LINUX_GPG_KEY` / `_PASSPHRASE` 导进一次性 `GNUPGHOME`，rpm 先 `rpmsign --addsign`，再给 AppImage / deb / rpm 各出 `.asc`，导出公钥 `armadra-linux.gpg` 作 Release 资产；仓库里有 `apps/web/public/armadra-linux.gpg` 时指纹必须一致；`verify`（`gpg --verify` + `rpmkeys --checksig`）；`keygen` 出一天期演练密钥。`release.yml` 的 `assemble` 作业在 `assemble.mjs` 之前签与验；`assemble.mjs` 名字检查放行 `.asc` 与公钥；缺 GPG 密钥时说明顶部列「Linux (GPG)」。
- 更新器：发布包此前一律带本地构建的停更标记（`dist.mjs` 只有 `local = true` 一条路，发布包永远报 `localBuild`），现在 `ARMADRA_DIST_RELEASE=1`（`release.yml` 设）才是发布包；`ARMADRA_DIST_VERSION` 按另一版本号打包（探针造「下一版」用）。未签名的打包版在 `ARMADRA_UPDATES_DEV=1` 下能走完检查、下载、校验、暂存，但「重启安装」答新原因 `notSigned`（`availability.ts::installRefusal`，不停后台、不写待重启记录），暂存通知与托盘公告改说「已校验、未签名、不自动安装」（`notify.ts`，页面文案 `updates.shellReason.notSigned` 中英）；打包版在同一开关下可读回环 http 发布源。macOS 上 `quitAndInstall` 之后 Squirrel.Mac 异步拒绝（换了签名者）的 `error` 事件现在落到 `failed / signatureMismatch`，之前页面会一直停在「安装中」。
- 探针 `tools/probes/update-e2e.mjs`（B 档 `update-e2e`）与 `docs/guides/ci-release.md` §2.6 / §2.6.1 / §2.6.2 / §3 / §4、`tools/probes/README.md`。

实测：

- 本机（macOS arm64）`ARMADRA_DIST_RELEASE=1 pnpm --filter @armadra/desktop dist` 出未签名发布包，`update-e2e` 两段都过：dev-stack `release`（127.0.0.1:8090，开发 minisign 公钥）检查 + ETag 304 + `SHA256SUMS` / `latest.json` / `darwin-aarch64` 清单与包全验；打包版 idle → check 得 0.1.1 → download → 暂存文件（临时 HOME 的 `Library/Caches/…-updater/pending/Armadra_0.1.1_darwin-aarch64.zip`）与发布字节同 sha256 → install 答 `notSigned`、无待重启记录、应用仍在跑。
- ad-hoc 演练包（`ARMADRA_MAC_ADHOC_SIGN=1`）：`codesign -dv` 为 `adhoc,runtime`、`Sealed Resources` 214 个文件，`verify-mac` 通过（未签名包 `verify-mac` 失败，退出 1），带 hardened runtime 能启动并走到「暂存」。再打一个 `ARMADRA_DIST_VERSION=0.1.1` 的 ad-hoc 包走 `--install --next`：下载、暂存、交给 Squirrel.Mac 后应用两分钟内没有退出——ad-hoc 签名过不了 Squirrel.Mac 对更新包签名者的校验，这一段只有 Developer ID 能走通（上面的 `error` 事件修正是据此加的，单测覆盖）。
- GPG：Docker（node 22 bookworm + gnupg 2.2.40 + rpm 4.18）里 `sign-gpg.test.mjs` 5/5 过，含真 `rpmbuild` 出的 rpm 经 `rpmsign --addsign` 与 `rpmkeys --checksig`、改一个字节后 `.asc` 验不过、换一把密钥签被已发布公钥拦下；CLI 的 skip / refuse / sign / verify 四条与 `keygen` 都跑过，容器里没有留下 `~/.gnupg`。
- 工作流：`validate-workflows` 通过；`release.yml` 的 bash 步骤 `bash -n` 全过，「选 Windows 签名路径」与「预检公证凭据」两步用假环境逐组合跑过（全缺告警、给一半失败、Azure / 证书文件 / 证书库 / API key / Apple ID 各自只写自己那套进 `GITHUB_ENV`）。
- `environment.test.ts` 的 Windows 真分支（`New-SelfSignedCertificate` 签 `.ps1` 得 `unknown`、无签名得 `unsigned`）只在 Windows runner 上跑，见 PR 的 CI。

没做：

- 签名包的「安装 → 重启 → 版本号变」没有走通：本机没有 Developer ID 证书，ad-hoc 过不了 Squirrel.Mac；Windows 自签证书过不了 electron-updater 的发布者校验；Linux AppImage 的安装段要 Linux 桌面环境（夜间 B 档由 G3-4 接 `xvfb` 与打包后再跑）。探针的 `--install` 分支写了但未实跑成功。
- 没用自签的 macOS codesign 身份演练：那要往用户钥匙串的搜索列表里加钥匙串，属于改本机安全设置，改用 ad-hoc。
- Azure Artifact Signing、`notarytool --validate`、CA 云签名（`WINDOWS_CLOUD_SIGN_*`）没有本地等价物，只有合并逻辑与工作流分支的测试；CA 云签名的自定义 sign hook 未写（等选定供应商）。
- `apps/web/public/armadra-linux.gpg` 没有提交：没有真密钥，不放占位公钥；用户提供密钥后把 `sign-gpg.mjs sign` 导出的公钥提交进去。
- `signatureState` 在 macOS 仍只看 `_CodeSignature`（ad-hoc 包也算 signed）；靠发布前的 `codesign --verify` 与安装时 Squirrel.Mac 的校验兜底。
- electron-updater 的缓存目录名是 `@armadradesktop-updater`（由包名推出），未改。

需用户提供（P0 / P1，[外部服务](../design/external-services.md) §13）：

- [ ] **P0** Apple Developer Program 会员；**Developer ID Application（G2 链）** 证书导出为 `.p12` → secrets `APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`（可选 `APPLE_SIGNING_IDENTITY`）、`APPLE_TEAM_ID`。
- [ ] **P0** App Store Connect API key（Developer 角色，`.p8` 只能下载一次）→ secrets `APPLE_API_KEY_P8_BASE64`（base64 的 .p8）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER_ID`；Apple ID 回退可选：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`。
- [ ] **P0** minisign 发布密钥：`node tools/release/sign.mjs keygen` → secret `ARMADRA_RELEASE_SIGNING_KEY`，公钥提交进仓库。
- [ ] **P1** Windows 签名三选一：Azure Artifact Signing（secrets `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`，变量 `AZURE_SIGNING_ENDPOINT` / `AZURE_SIGNING_ACCOUNT` / `AZURE_SIGNING_PROFILE`）；或 OV 证书文件（secrets `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD`）；或自托管 Windows runner + USB 令牌（变量 `ARMADRA_WIN_CERT_SHA1`，Windows 两行 `runs-on` 改 `[self-hosted, windows, signing]`）。都要配变量 `ARMADRA_WIN_PUBLISHER_NAME` = 证书主体 CN。
- [ ] **P1** GPG 签名专用密钥 → secrets `ARMADRA_LINUX_GPG_KEY`（armored 私钥）、`ARMADRA_LINUX_GPG_PASSPHRASE`；首个签名发布后把 `armadra-linux.gpg` 提交到 `apps/web/public/`。
- [ ] **P1** 自家 tap / bucket 仓库 + 细粒度 PAT（`HOMEBREW_TAP_TOKEN`、`SCOOP_BUCKET_TOKEN`、`WINGET_TOKEN`）——Homebrew cask 自 2026-09-01 起要求签名且公证，归 W-DIST，本包未用。

## G3-4 Linux 打包验证与夜间冒烟

做了什么：

- 清单拆成一条一个文件：`tools/ci/e2e.json` → `tools/ci/e2e.d/<id>.json`（文件名即 `id`，按档再按 `id` 排序，隐藏文件忽略，旧单文件被合并带回即报错）；条目加 `platforms`，`requires` 认 `docker`；`e2e.mjs` 在 `GITHUB_OUTPUT` 写失败条目。
- `nightly.yml`：`linux`（ubuntu-22.04：`dist`、glibc 基线、`xvfb-run` 下 B 档）、`macos`（macos-14：`dist`、B 档）、`report`（失败且在 main 上时用默认 `GITHUB_TOKEN` 开「夜间 B 档失败」issue 或追加评论）。`validate-workflows` 断言各系统有作业、有开 issue 的作业、不读 secret。
- B 档条目：`packaged-smoke --no-real-cli`（darwin、linux）、`deb-install`（linux，`ubuntu:22.04` 容器 apt 安装、`ldd`、`--version`）。
- 修出来的 Linux 问题：tmux 3.2（22.04 的 3.2a）不认 `allow-passthrough`，每个新会话停在配置报错页吞键 → `set -gq`；deb 依赖缺 `libgbm1`、`libasound2`；`desktopName` + `syncDesktopName`（窗口与 `armadra.desktop` 对上）；新增 `armadra --version`。

实测（本机 Docker，ubuntu:22.04 arm64 容器）：`dist` 出 AppImage / deb / rpm；glibc 基线 12 个二进制通过；`xvfb-run` 下 `packaged-smoke --no-real-cli` 对 AppImage 全部 20 项通过（迁移、PDF、H.264 视频、tmux 终端回显、无控制台错误）；`linux-arm64-unpacked/armadra --version` 无显示器答出 `Armadra 0.1.0`；deb 的依赖闭包对照 `ldd` 补齐后无缺口。

没做 / 限制：

- 分支上手动触发的 nightly（run 37122980815）：linux 作业 `deb-install`（amd64，干净 ubuntu:22.04）与 `packaged-smoke` 通过，macos 作业 `packaged-smoke` 通过；`report` 因不在 main 跳过，issue 上报未实跑。
- arm64 AppImage 的运行时要 `libz.so`（开发包里的无版本名），干净系统上 `APPIMAGE_EXTRACT_AND_RUN` 会报缺库；x64 runner 有 `zlib1g-dev`，未改打包。
- `update-e2e`、`server-perf`、`server-container-e2e` 不设单独作业：条目写 `platforms: ["linux"]`，在 `linux` 作业里打包后执行（作业设 `ARMADRA_DEV_STACK=1`、装 Chrome）；原 `server-image` 作业由 `server-container-e2e` 条目取代。
- macOS 作业与 issue 上报只在 GitHub 上首跑时验证；deb 容器验证没有复用 dev-stack 的 compose（直接 `docker run`）。

## G3-5 服务器部署：镜像、公网部署指南、备份升级

做了什么：

- ACME 内建（W-ACME）：`core/gateway/acme.ts`——`acme-client` 走 RFC 8555（账户、带 `profile` 的订单、`http-01`、定稿），CSR 用本目录的 DER 写入器自签；挑战监听 `ARMADRA_ACME_HTTP_PORT`（缺省 80，其余请求 308 到对外来源）；证书、私钥、账户密钥、`state.json` 在 `<数据目录>/tls/acme/`（0700 / 0600）；寿命过三分之二续，失败按 1、2、4…小时退避（≤ 12 小时、≤ 剩余寿命一半），连续 3 次记错误并 `onAlert`，一直用旧证书；续好 `gateway.refresh()` 热换。`tls.ts` 加 `acme` 来源，`index.ts` 的 `open()` 接 `acme` 分支（桌面设置 `gateway.tls.source = "acme"` 与服务器壳共用 `startAcme`），`GET /api/gateway` 的 `tls.acme` 报续期状态（契约 §17.1 同步，共享层 `gatewayAcmeStatusSchema`）。错误码 `acme_misconfigured` / `acme_port_unavailable` / `acme_failed`（替换 `acme_unavailable`）。出站表登记 Let's Encrypt 目录。
- 服务器壳：`serve --acme <邮箱>` / `ARMADRA_ACME_EMAIL`，与 `--tls-cert/--tls-key` 互斥、要求对外来源；`status` 报「ACME，有效期至…，续期已连续失败 N 次」。
- 镜像 `apps/server/docker/`：两段构建、uid 10001、`/data` 卷、tini、tmux / git / bash；入口脚本没有 `ARMADRA_PUBLIC_ORIGIN` 退出 64；健康检查、`backup.mjs`（不停服 `VACUUM INTO`）、compose 示例；hook 客户端打进 `/app/cli/`，迁移目录 `/app/migrations`。dev-stack 的 `armadra-server` 改用它（删掉占位 `Dockerfile.dev`）。
- `server-e2e.mjs` 加容器模式（`--container=<镜像> [--build]`），B 档条目 `server-container-e2e`；`nightly.yml` 加 `server-image` 作业（构建 + 容器端到端，不推送）；`server-image.yml` 只在 `v*` 标签上用 `GITHUB_TOKEN` 推 GHCR（amd64 + arm64），PR 不触发。
- 新指南 [服务器部署](../guides/server-deployment.md)。

实测（2026-10-03，macOS + OrbStack）：

- dev-stack Pebble：`acme.pebble.test.ts`（`ARMADRA_DEV_STACK=1`）签 shortlived 证书、链验到 Pebble 本次的根、续期换证书；目录地址错时 `acme_failed`。
- 另起一个开着验证的 Pebble（`PEBBLE_VA_ALWAYS_VALID` 关），服务器壳 `--acme` 经 `host.docker.internal` 真走了 `http-01` 回连并签发，`status` 报 ACME，`tls/acme/` 全是 0600。
- 镜像本机构建（436 MB），`server-e2e --container` 全过（配对、邀请、只读 / 可写 / 撤销共享、同机两窗口接管），浏览器节点一步 skipped；容器里对 dev-stack Pebble 跑 `--acme` 签发成功；`backup.mjs` 备份、停服替换、再启动健康；Nginx 反代（上游只信 `/ca.crt`）后配对兑换 200。

没做：

- `tls-alpn-01`（要在握手里按 ALPN 换证书；80 端口在容器与反代部署里都现成）。
- step-ca 的 ACME 签发：它真回连挑战地址，CI 的 Linux 上容器到宿主回环不通；只用 Pebble 验了两条路（不回连 / 回连）。
- 指南里的 Caddy 配置没有在本机跑过（Nginx 跑过）；镜像不带 Chrome，服务器壳容器里没有浏览器节点（指南未展开 `ARMADRA_BROWSER_PATH`）。
- 真域名与 Let's Encrypt 生产签发需用户提供域名（指南第 3 节照做）。

## G3-6 服务端性能基线与多主机管理页面

**做了什么**

- 性能探针 `tools/probes/server-perf.mjs`：对真的服务器壳加 30 个终端、6 个事件流、一块 2000 对象的实时板，量建会话、`board.changed` 扇出、终端吞吐、实时板批量 / 冷同步 / 物化 / 单字段更新、同时关掉全部终端时其余请求被堵多久，以及服务器壳与 tmux 的 RSS / CPU；`--cpu-prof` 找热点；按平台基线（`server-perf-baseline.json`）比对，差 20% 以上且超过绝对容差即失败。进 `e2e.json` B 档；纯函数用例进 `release:test`。结果与解读：[服务端性能基线](server-performance-baseline.md)。
- 热点修复（按 profile）：关终端走同步 `ps`、每次接终端流同步 `tmux -V`、每次建终端同步 `infocmp`，三处都堵事件循环。改成异步 `readProcessTable()`、可用后缓存探测、`infocmp` 每进程一次。
- 舰队健康记录：`remote/fleet.ts` 每台主机留最近 20 条握手 / 断开 / 验证或重新同步失败，执行主机行带可选 `health`（契约 §21.3），共享层 `executionHostHealthSchema`。
- 执行主机页的舰队视图 `execution-hosts/FleetGroup.tsx`：在线 / 离线、Worker 版本或待升级、健康记录（点开明细表）、逐台与全部重新同步；页面 15 秒刷新。展示页 `integration` 分区放它的真样本。

**实测**（Apple M1 Max，本机负载 12–14，三次中位数）：扇出 p50 1.3 ms / p95 2.2 ms；终端吞吐 24.4 MiB/s；实时板 2000 对象到在线客户端 170 ms、冷同步 67 ms、物化 58 ms、单字段更新 p95 1.6 ms；稳态 RSS 183 MiB。同时关 30 个终端时其余请求最慢从 0.8–1.3 s 降到 0.08–0.17 s。

**没做**：基线只有 `darwin-arm64`；ubuntu 的 B 档第一次跑出结果后再补录 `linux-x64`（之前只报告不判）。夜间作业的构建步骤归 G3-4。休眠判据 `hibernator.ts::processesUnder` 仍是同步 `ps`（它本身是同步接口，未在本次负载里出现）。展示页 `integration` 分区里 CLI 分组（启动器 / ACP）的样本归集成设置页的实现包。

## G3-7 真 CLI 端到端：场景 11 / 12 与三家 TUI

**做了什么**

- C 档开关：`agent-e2e` 起真 CLI / 真模型的场景（1–8、10、11 `--real-model`、12）没设 `ARMADRA_E2E_REAL=1` 就在起任何进程之前退出；`--self-test` 把场景 11 / 12 换成脚本化模型、假 ACP Agent 与假 TUI，其余装配与断言同一份代码。新增 A 档 `tools/ci/e2e.d/agent-e2e-self-test.json`（`--only 11,12 --self-test`），探针本身不会烂掉。
- 场景 12「六家 ACP」（`agent-e2e/scenario-12-acp.mjs`，设计 acp-session-view §11）：预检、六家各两轮、Claude 审批经页面拒绝、倒着沿环 send（避开三跳上限）与 `context summary`、经页面菜单切终端视图再切回（Claude `resumed: true`、进程带 `--resume <id> --permission-mode acceptEdits`；Copilot `resumed: false`）、OpenCode 休眠与 `/wake`、用量 < 5 万、控制台无错。隔离：core 用 `probe-home.mjs` 的临时 HOME，PATH 最前面是每家的隔离包装（临时 HOME / 配置目录、只复制凭据），其余真 CLI 名字是替身（调用即记、以 97 退出，收尾断言没有调用）。Claude 只能用真实配置目录（钥匙串）：包装换回真实 HOME、去掉 `CLAUDE_CONFIG_DIR`、关自动更新、缺省 `haiku`；终端视图的信任对话框按「Yes」的编号答，认不出的画面不答、先结束终端再切回（切回时 core 敲 `/exit`+回车，敲进对话框就是替人答）。`--record-compat` 把全部通过的那几家的 `initialize` 版本并进 `compatibility.json`。
- 场景 11 `--real-model`：真供应商（`ARMADRA_E2E_AMA_PROVIDER` / `_MODEL` / `_KEY`），用户的话写成明确指令、成员一律用假 CLI，断言放宽到画布结果（成员与边、两条 ack、汇总便签、`task` 一行 done、第 5 步 `task(agent="ama")` 起的第二个 ama 用同一个真模型回报非空结果、key 不落盘不进日志不进节点 shell）；这套 core 的 PATH 同样挂真 CLI 替身。
- 守门：`~/.claude/settings.local.json`、`.credentials.json` 进字节指纹；`~/.claude.json` 比顶层键摘要（计数 / 缓存类键与 `projects` 只记不判，其余任何变化判失败，报告只留结论不留内容）；只跑假 CLI 时收尾不再起 `claude` / `codex --version`。
- 场景 10 把每家 TUI 起来时（或起不来时）的画面存进 `<输出目录>/screens/`，供核对画面门里 `verified: false` 的特征。
- 修了 `lib.mjs::setup()` 返回里引用未定义的 `injected`（真跑场景 1–8、10 会在装配末尾抛 ReferenceError）；`lib.mjs` 超 1500 行上限，拆出 `safety.mjs`（配置守门）、`cli-homes.mjs`（四家临时 HOME）、`isolated.mjs`（自起 core、`hookIn` / `canvasAsIn` / `contextAsIn`、`acpAdapterInstalled`、`promptViaApi`、`watchWorkspaceEvents`、`blockRealClis`、`startPageStack`），`lib.mjs` 全部再导出。
- 运行手册：`tools/probes/README.md`「C 档运行手册」（备份与还原命令、每家要装 / 要登录的、命令、花费、每步断言）。

**实测**（本机，未起任何真 CLI、未用真账号）：`--only 11`（脚本化模型，含 ama → ama 第 5 步）30 项全过；`--only 11 --real-model --self-test` 23 项全过；`--only 12 --self-test` 六家 40 项全过，约 164 秒；没设开关时 `--only 12` / `--only 2` / `--only 11 --real-model` 都在起进程前退出。

**补丁（真跑反馈）**：共用装配的 Claude / Codex 前提改为可选（`preflight.mjs`；没有 `~/.codex/auth.json` 的机器 Codex 记 skipped、依赖它的场景跳过，其余照跑），`--preflight` / `--setup-only`，场景 10 加 `ARMADRA_E2E_TUI_ONLY`（没选的家连凭据都不读），只选了两家时跳过沿环 send（两家成不了不回头的环，core 判成环拒收，还会挡住下一步的排队回执；实跑 claude、pi 撞上）；场景 12 终端视图的信任对话框改为等到「<编号>. Yes」画出来再答；真跑抓到的画面表明 Claude Code 2.1.287 是没编号的箭头菜单（「❯ No, exit / Yes, I trust this folder / Enter to confirm」），于是抽出 `trust-dialog.mjs` 供场景 1–10 的 `waitAgentUp` 与场景 12 共用：编号菜单按编号；箭头菜单两个选项与「Enter to confirm」都在才认，下移一次、重取画面核对 ❯ 在「Yes」上才回车；其余一律不答，超时带画面失败；场景 11 真模型的「便签里是成员回报的结果」接受转述（主体与结论都在）。自检：`preflight.test.mjs` 6 条、`trust-dialog.test.mjs` 3 条（进 `release:test`），场景 12 的假 TUI 改成箭头菜单（选项晚一秒、缺省光标在「No」、光标不在「Yes」时回车即退出）；临时 HOME 无 auth.json、PATH 全是假 CLI 时 `--preflight` 与 `--setup-only` 跳过场景 1、只建 claude 节点、没起任何真 CLI；场景 11 两种、场景 12 自检全过。

**真跑记录**（2026-10-04，macOS，经用户直接授权的会话按手册跑；本包的代理没有起真 CLI）：Claude Code 2.1.287、Pi 1.0.0、claude-agent-acp 0.85.1、pi-acp 0.0.34、ama 0.6.7（经 packy 中转，模型 kimi-k2.5）；Codex 记 skipped（没有 `~/.codex/auth.json`），OpenCode / OMP / Copilot 未装。

- 场景 12（`ARMADRA_E2E_ACP_ONLY=claude,pi`）：Pi 全过，`compatibility.json` 记 pi-acp `verified.min = 0.0.34`；Claude 除 `switchToTerminal` 外全过——那一步碰上没编号的信任菜单，没答、超时失败（fail-closed），本 PR 已能识别。修复后重跑：Claude 与 Pi 全过（含经箭头菜单切终端视图），`compatibility.json` 记 claude-agent-acp `verified.min = 0.85.1`。
- 场景 11 `--real-model`：全过（含 ama → ama），只有「便签里是成员回报的结果」因真模型转述而失败——断言过严，本 PR 已改。
- 场景 10（`ARMADRA_E2E_TUI_ONLY=claude,pi`）：22 项通过，1 项失败——两家时的沿环 send 被 core 判成环，本 PR 改为少于三家时跳过。修复后重跑 24 项通过，2 项失败：两家的「成本」读到 0。原因在探针：整场只有约 50 秒，`POST /api/usage/cost/refresh` 还在 30 秒冷却里，答的是转录写完之前扫的旧汇总；用 core 的成本扫描器直接扫这次 Claude 的真实转录，读出 2 万多 token（缓存读 12063、缓存写 8116），说明读取适配器没问题。探针改为按 `scannedAt` 认，冷却里就等到 `refreshAvailableAt` 再刷（最多三次）。2026-10-04 再跑一次：26 项全部通过，成本读到 Claude 21737 token、Pi 2109 token，跑后配置哈希不变。
- 每次跑完配置哈希比对都干净。两次跑之间，cc-switch 切换供应商改过 `~/.codex/config.toml`，不是探针造成的，没有还原。

**没做**：场景 10 成本那一步在修复后的重跑；Codex（ChatGPT 登录）与 OpenCode / OMP / Copilot 的真跑与画面门特征核实；codex-acp 的 `verified` 仍为 null。Copilot 三条权限旗标在 `--acp` 下是否生效、OMP `acp` 是否接受 `--model=`、Pi 的 `settings.json` 键名未经实跑核实，真跑结果出来后按装机结果修。

## G3-8 安全收尾：泄露检查、公网加固、安全审查

**做了什么**

- 泄露检查：`identity/policy.ts::checkBreach` 走 HIBP k-匿名范围接口（只发 SHA-1 前 5 位、`Add-Padding`、填充行不算命中、4 秒超时）；`identity.breachCheck` 的 `auto` 在服务器壳与开了 Gateway 的桌面上按 `warn`；`warn` 命中照设并在答案里带 `passwordBreached: true`，`block` 答 400 `password_breached`，查不成只记审计不阻止。出站表加 `hibpRange`，`ARMADRA_HIBP_BASE` 指向 fixture。契约 §18.1。
- 安全审查：[安全审查 2026-10](security-review-2026-10.md)。中危及以上 9 条全部修复并有测试：跨画布节点（H1）、成员起终端带 owner 的节点凭据（H2，新码 `credential_forbidden`，契约 §20.3）、资产 SVG 同源导航执行（H3）、账号写路由的 CSRF（M1）、Bearer 上的 CSRF 规则统一为「只在 Cookie 会话上核对」（M2）、已升级的流在授权变化后复核并以 4403 关（M3）、配对 / 刷新 / 换 CSRF / 登出按失败限流（M4）、Gateway 开关与配对票、节点凭据、ama 密钥进审计（M5）、Gateway 响应头与原生 App 的 CSP 放行表（M6）。低危 10 条与一条设计约束只列出。
- 路由 scope 覆盖率补上整段接管的前缀（`main.test.ts`）；`docs/guides/architecture.md` §7 按架构 §8.1 写信任边界；契约 §10、§17.4、§18、§18.1、§20.3。

**实测**

- 单测与集成：`policy.test`（对进程内 hibp fixture 的三档、离线 / 超时 / 非 200 / 认不出）、`security-http.test`（三档经 HTTP、离线只记审计、限流只扣失败）、`gateway.integration.test`（Cookie 会话上的账号写要 CSRF、App 的 Bearer 写不要、响应头、审计）、`server-revoke.test`、`route-access.test`、`credentials.test`、`ama-credentials.test`、`assets/routes.test`、`csp.test`、`server-report.test`。
- dev-stack：`pnpm dev-stack up hibp` 后 `ARMADRA_DEV_STACK=1` 跑 `policy.devstack.integration.test.ts` 通过。

**没做**

- 页面上口令策略拒绝码与 `warn` 档的提示（安全审查 L7）；GitHub / 自动化两面对 Bearer 写仍要 CSRF（L8）；其余低危见审查 §3。
- 原生 App 的 CSP 只给出策略（`nativeAppContentSecurityPolicy()`，契约 §17.4），写进 `apps/mobile` 包里页面归 G3-1。

## G3-9 分发渠道与许可证声明（W-DIST + W-NOTICES）

做了什么：

- 第三方声明：`tools/notices.mjs` 由 `pnpm licenses list --prod --json` 生成根 `THIRD_PARTY_NOTICES.md`（逐包带 LICENSE / NOTICE 原文，单列 Electron / Chromium 与 ama 的随包声明），`pnpm check` 的 `notices:check` 防漂移；`after-pack.mjs` 把它与 ama 的 `LICENSE` / `THIRD_PARTY_NOTICES.md` 放进 `resources/`，Electron 的 `LICENSE.electron.txt` / `LICENSES.chromium.html` 在 macOS 放回 `Contents/Resources/`（`node_modules/electron` 没解包时先跑它的 `install.js`）；设置 → 关于 → 开源许可显示全文。
- 渠道：`tools/release/templates/`（cask、Scoop、winget 三件套、AUR `armadra-bin` 的 PKGBUILD）+ `publish-channels.mjs`（`render` 从 `SHA256SUMS` 渲染，`push` 提交进 tap / bucket）。`release.yml` 的 `channels` / `channels-macos` / `channels-windows` 渲染并试装、不推送；新 `distribute.yml` 在 Release 转正后推 tap / bucket / winget，各缺 secret 就跳过。GHCR 镜像沿用 G3-5 的 `server-image.yml`。Flathub / Snap / apt-rpm 只写结论（[CI 与发布](../guides/ci-release.md) §3.1）。

实测（2026-10-03，macOS）：

- 本地 tap 上 `brew style`、`brew audit --cask --strict` 通过；从本地 HTTP 服务器 `brew install --cask --appdir=<临时>` 装假 dmg 成功并卸载。`brew audit --new` 因仓库私有 GitHub API 404。
- PKGBUILD：archlinux 容器 `makepkg --printsrcinfo` 通过，`namcap` 只有 x86_64 字面量与 Maintainer 告警。winget 三件套对官方 1.10.0 JSON schema、Scoop manifest 对 Scoop `schema.json` 校验通过（ajv）。
- `pnpm check`、`pnpm release:test`、`pnpm -r --if-present test` 全绿。

没做：

- 真推送（需用户建 tap / bucket 仓库、winget-pkgs fork 与三个 PAT）；`distribute.yml` 要合入后才能手动触发验证。
- 被 electron-vite 打进 `out/` 的桌面 devDependencies 不在 `--prod` 列表里，未单独列声明。

## G3-10 可选崩溃上报（W-CRASH）

做了什么：

- 剥离规则 `core/diagnostics/crash.ts`（纯函数，不依赖 SDK）：删 `user` / `request` / `extra` / `server_name` / `modules` / `threads` 与任何层级的环境变量、命令行、工作目录、请求头、局部变量、源码行；面包屑只留类别 / 级别 / 时间 / 一句话，控制台与网络类整条丢；每个字符串去 ANSI 与控制字符、替换环境变量的值、家目录、路径里的用户名、令牌形状、地址里的账号与查询串，再截断。
- `CorePlatform.reportError`（可选）与 `reportError(platform, error, {source})`：缺省只写本地日志；core 在请求 500 与 `uncaughtExceptionMonitor` 两处调用。桌面 core 子进程经 fork 的 IPC（`ARMADRA_CRASH_REPORT_IPC=1` 时）把剥离后的错误交给主进程。
- 桌面壳 `main/diagnostics.ts`（`@sentry/electron` 7.20.0）与服务器壳 `apps/server/src/diagnostics.ts`（`@sentry/node` 10.75.0）：只有 DSN 合格时才加载 SDK；`defaultIntegrations: false`，不开 minidump、会话、OTel、网络 / 控制台集成，`ipcMode: 0`；设置文档每 5 秒看一次，关掉立即停发、打开不用重启。服务器壳 `ARMADRA_CRASH_REPORT_DSN` 优先。
- 设置 → 通用 → 诊断：开关 + DSN 输入（合格才存，关掉即清空）；出站表登记 `crashReport`。

实测：

- dev-stack GlitchTip：`node tools/probes/crash-report-e2e.mjs` 通过（真 `@sentry/node` 经 core 500 路径发出，取回的事件里没有环境变量、家目录、令牌、终端输出、用户与 extra；没配 DSN 不发）。
- 桌面路径（临时 Electron 脚本，未入库）：fork 的子进程经 `nodePlatform.reportError` → IPC → 主进程 `@sentry/electron` → GlitchTip 收到，标签 `process: core`，栈路径 `~/…`；主进程错误同样收到。
- 打包后的服务器壳 `out/main.js serve` 带 DSN 启动日志「崩溃上报已打开」（只写主机）。

没做：

- 页面（渲染进程）的 JS 错误不上报：页面不装 SDK，`ipcMode: 0` 也不开渲染进程通道。
- core 子进程因未接住异常退出时，IPC 消息是同步写管道的尽力而为；服务器壳会等最多 2 秒送出再以 1 退出。

## G3-11 存量界面套用二：对话框与其余页面（WP-D3b）

**做了什么**

- 对话框接 `ResponsiveDialog`（≤767 走底部 Sheet）：Overlays 里的起名、Agent 设置、SSH 口令、交接，编辑器的另存为 / 迁移，Agent 凭据、主机密钥、关于、账号与共享、快捷键、节点标注、GitHub 状态映射、Mermaid 导入，新建 Agent 向导（原来手写的 Sheet 分支删掉）。`AlertDialog`（确认类）保持居中。
- 空态 / 加载 / 错误换 `Empty / Skeleton / Alert`：自动化抽屉与运行记录、计划表单的提示框、工作流面板的错误与无权限、后台服务页的连接状态、身份面的错误、编辑器节点（慢读延时 Skeleton、失败 Alert +「重试」）、安全页通行密钥与会话列表的首次加载、Agent 设置页自定义 Agent 空态、更新页（下载中 `Progress`、失败 `Alert destructive`）。
- 后台服务页两份设备表并成一份：身份面只报会话（`onSession`），对外服务的设备表（`GatewayDevices`）标「当前」、按管理权给撤销、分页「加载更多」；成员（读不到 `/api/gateway`）也能看到自己的设备；撤销了本机就让身份面重新取会话。
- 对外服务显示 ACME 续期失败（`tls.acme.failures > 0`）：`Alert destructive` + 下次重试时间。
- 终端节点头部：运行中工作流步骤的「第 n 步」（`workflow/node-steps.tsx`，运行列表每块画板只取一次，挂在 `DraftLayer`）；答不了审批的人看到「等待接管」。
- `CommandInput` 调用处补焦点环（`COMMAND_INPUT_FOCUS`，守卫测试）；手机上 sonner 改从顶部出；浅色主题图片棋盘格改为卡片底与掺 10% 前景色两档；删除旧别名 `--accent-text / --accent-soft`（`tokens.test` 断言不再出现）。
- 剩下的手写 `<button>` 全部换 `Button`，`no-raw-button` 守卫改为扫整个 `src/`（`ui/` 与测试除外）。
- 展示页：协调者（ama 分派三成员、第 n 步、草案卡）与更新（十一种状态，抽出 `UpdateStatusRows` / `UpdateStatusNotes` 复用）换成真样本；对外服务加续期失败与「当前」设备；组件分区补 `command`；通用五态加「等待接管」；占位组件删除。

**实测**

- `design-showcase.mjs --diff`（与开工前基线比）：84 张全部生成，`status: ok`，控制台无错误；对比度深色 84 对最低 3.25、浅色 85 对最低 3.07；`components` Tab 可达 81/81 且每处都有焦点环；减少动效静止、强制颜色焦点可见。36 张有变化，集中在 coordinator / updates / gateway（新样本）、states、components、mobile（按键条换 `Button`），canvas 的 2–5% 是流光动画帧。
- 代表截图：[协调者](assets/g3-11/coordinator-dark-1440.png)、[更新十一态](assets/g3-11/updates-dark-1440.png)、[对外服务](assets/g3-11/gateway-light-1440.png)、[组件](assets/g3-11/components-light-1024.png)、[通用五态（手机）](assets/g3-11/states-dark-390.png)、[手机](assets/g3-11/mobile-dark-390.png)。

**没做**

- `AlertDialog` 没有手机底部形态（`ResponsiveDialog` 只对应 `Dialog`）；命令面板、设置对话框、合并 / 编辑预览这类整屏对话框保持原样。
- 设备表仍没有「平台」「最近访问」两列（接口不给）；协调者的右侧分派抽屉（设计系统 §5.4）没有实现组件，展示页用画布上的真节点表达。

<!-- G4 收口 -->

## G4-1 文档收口

**做了什么**

- [架构](../guides/architecture.md)：§2 的 core 方框加新域与 runners，附「补全新增的域」表（目录、职责、契约节）；§4 补自动化运行工作流与协调者 runners；§5 把实时板与评论写进持久化、加 0030–0035 迁移表；§7 补身份加固与角色阶梯；§8 按各包的「没做」重写。
- [Agent 协作](../guides/agent-collaboration.md)：ama 一行；「没有主动投递」一节已与代码不符（`send` 与投递队列在用），改写为「推式投递与打断」；新增「ACP 模式（会话视图）」与「协调者与 runners」两节；会话索引一句改为六家。
- [客户端平台](../guides/client-platforms.md)：删掉 Go Host 时代的「经 Host 访问（H02）」，换成「经 Gateway 访问」；Runtime 字样改 core。
- [功能预期总表](feature-roadmap.md)：§2 加 ama 宿主适配器、手机壳、推送中继三行；§3.1–§3.13 逐行按本文各节更新（新增实时协同、评论、ACP、工作流、runners、Gateway、身份、推送、原生 App、签名、分发、声明、崩溃上报等行，多账号由 ⬜ 改 🔶，交接去掉「限同一执行主机」）；§4 重写为「现状 / 缺的条件 / 拿到后怎么验」。
- [后续规划](../design/product-roadmap.md)：按包勾选，没勾的写明剩余。专项设计首行状态：ACP 会话视图、补全架构、补全执行计划、外部服务改「部分实施」并列缺口；协调 Agent、设计系统、设计展示页改「已实施」并列出入；服务器账号、画布启动器、CLI 协作补记已补上的部分。
- README 能力一览、支持的 Agent、设计图与路线图按现状改写，项目结构加 `apps/mobile`、`apps/push-relay`；[文档索引](../README.md)的描述与契约节清单校对。

**实测**：`pnpm check` 通过（格式、类型、仓库规则含文档登记与相对链接）。文中每条「已实施 / 没做」按本文各包一节与源码核对（如 `use-update-state.ts` 仍报 `noReleaseSource`、`policy.ts::checkBreach` 仍恒 `skipped`、开放注册仍 501）。

**没做**

- G0-1 至 G0-8 各节由本包按各自 PR 正文补记（经协调者授权；这些包合入早于进度载体启用）。
- G3-2、G3-7、G3-8 在本节写作中陆续合入，各文档已按它们的节更新。

### 需用户提供（汇总，按优先级）

> 本节是 G4-1 时的快照；合并 G5 之后的现行清单见[用户待办清单](user-action-checklist.md)。

每一项都有 mock 路径（多数对着 `tools/dev-stack/`），实施不等它；括号里是来源包与[执行计划](../design/completion-plan.md) §5 的编号。

**P0：能发出可安装的正式版**

- [ ] Apple Developer Program 会员与 **Developer ID Application（G2 链）** 证书（`.p12`）→ secrets `APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_TEAM_ID`（可选 `APPLE_SIGNING_IDENTITY`）。解锁：macOS 签名与公证、`update-e2e --install` 的「安装 → 重启 → 版本号变」、Homebrew cask（要求签名且公证）；同一账号也是 iOS 分发与 APNs 的前提。（G3-3、G3-1；U8）
- [ ] App Store Connect API key（Developer 角色）→ `APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER_ID`（Apple ID 回退可选）。解锁：公证、TestFlight 上传。（G3-3；U8）
- [ ] minisign 发布密钥：`node tools/release/sign.mjs keygen` → secret `ARMADRA_RELEASE_SIGNING_KEY`，公钥提交进仓库。解锁：`latest.json` / `SHA256SUMS` 签名，桌面更新器对真实发布源检查。（G1-15、G3-3；U8）

**P1：三平台与真实环境验收**

- [ ] Windows 代码签名三选一（Azure Artifact Signing / OV 证书文件 / 自托管 runner + USB 令牌）与变量 `ARMADRA_WIN_PUBLISHER_NAME`。解锁：签名安装包、`Get-AuthenticodeSignature` 为 `Valid`、Windows 自动更新安装。（G3-3；U13）
- [ ] 一台 Windows 10 / 11 机器。解锁：按开发指南「Windows 真机验收」跑 `windows-acceptance.mjs --installer`（有 Codex 加 `--with-codex`）并回传 `result.json`；节点凭据 T9。（G3-2、G1-1；U5）
- [ ] GPG 签名专用密钥 → `ARMADRA_LINUX_GPG_KEY`、`ARMADRA_LINUX_GPG_PASSPHRASE`；首个签名发布后把 `armadra-linux.gpg` 提交到 `apps/web/public/`。解锁：Linux `.asc` 与 rpm 签名。（G3-3）
- [ ] 稳定域名与一台公网可达主机（或反向代理）。解锁：passkey 的 RP ID 与真手机注册登录、手机网页不装 CA 直接访问、Let's Encrypt 生产签发（[服务器部署](../guides/server-deployment.md)第 3 节）、OAuth 回调地址、通用链接、商店审核演示服务器、对公网部署跑 `server-e2e` 与性能探针。（G1-10、G1-11、G1-12、G3-5、G3-1、G3-6；U6、U11）
- [ ] 测试账号：两个 Claude 订阅（一个 `/login`、一个 `setup-token`）、两个带 Copilot 的 GitHub 账号与 B 的细粒度 PAT；Codex / Pi / OMP / OpenCode 的 API key。解锁：CLI 协作 §7.4 的 T1–T8，通过一项就打开 `CREDENTIAL_KINDS` 里对应种类；能在隔离 HOME 下登录的 Claude 凭据还解锁打包版冒烟带真 Claude。（G1-1；U1）
- [ ] 装好并登录 OpenCode / OMP / Copilot 的机器、用 ChatGPT 登录的 Codex（`~/.codex/auth.json`），以及 `npm i -g @agentclientprotocol/codex-acp`（Claude 与 Pi 的适配器 2026-10-04 已在本机实跑，pi-acp 0.0.34 已记入）。解锁：按 `tools/probes/README.md`「C 档运行手册」跑 `ARMADRA_E2E_REAL=1 agent-e2e --only 10,12 --record-compat`、画面门里 `verified: false` 的特征翻真、`compatibility.json` 记实跑版本、Copilot 在 `--acp` 下的权限旗标核实。（G1-3、G1-4、G2-1、G3-7；U2、U3）
- [x] ama 的真模型供应商 key：2026-10-04 场景 11 `--real-model` 已实跑（kimi-k2.5 经中转），断言修正后待一次复跑确认。（G3-7）

**P2：手机、分发与远端**

- [ ] iOS：App ID `dev.armadra.mobile` 与 `….NotificationService`（Push、Keychain Sharing）、分发证书与两份 provisioning profile → `IOS_DISTRIBUTION_P12_BASE64`、`IOS_DISTRIBUTION_PASSWORD`、`IOS_PROVISIONING_PROFILE_BASE64`；APNs `.p8` + Key ID。解锁：真机安装、TestFlight、真 APNs 推送与 NSE 解密。（G3-1、G1-13；U8）
- [ ] Android：Play 开发者账号、上传密钥（`ANDROID_UPLOAD_KEYSTORE*`）、Play 服务账号；Firebase 项目的 `google-services.json` 与服务账号 JSON。解锁：签名 APK / AAB、Play 封闭测试、真 FCM 推送。（G3-1、G1-13；U9）
- [ ] 一台公网主机运行 `apps/push-relay`（商店版推送；是否运营由发布方定）。解锁：`push.transport = "relay"` 与商店版 App 的端到端加密推送。（G1-13、G3-1；U10）
- [ ] 商店审核材料：演示服务器与审核账号、隐私说明、出口合规问卷。（G3-1）
- [ ] tap / bucket 仓库、winget-pkgs fork 与细粒度 PAT（`HOMEBREW_TAP_TOKEN`、`SCOOP_BUCKET_TOKEN`、`WINGET_TOKEN`）。解锁：`distribute.yml` 在 Release 转正后真推。（G3-9；U12）
- [ ] 一台真实 sshd 主机（注册为执行主机）。解锁：`remote-e2e.mjs --real <host>`：传输、主机密钥、askpass、跨主机交接经远端采集。（G1-2；U4）

**P3：可选**

- [ ] OAuth 应用：GitHub OAuth App（回调 `<公网来源>/api/identity/oauth/github/callback`，scope `read:user user:email`）与一个 OIDC 提供方（Google / Entra / Keycloak）的 client id / secret；开放 SSO 建号时填 `allowedDomains`。解锁：真提供方上的绑定、登录与建号。依赖上面的域名。（G1-12；U7）
- [ ] GlitchTip 实例的 DSN。解锁：可选崩溃上报的真实收件。（G3-10；U13）
- [ ] 之后的包才用到：SMTP 账号（W-MAIL）、域名 + Cloudflare R2（W-MIRROR 更新镜像）。

## G4-2 启动兼容退役

> 后续：已并入 G5（G5-17 执行），见下文 G5-17 一节。

推迟。条件是「上一个发布版（含启动器）已发出、本版是其后的第一个版本」（补全计划 G4-2）。现有的 v0.1.0 只是 Draft、不含画布启动器（启动器在 #14–#19 合入），含启动器的第一个版本是 0.2.0，还没有发出。0.2.0 发出之后，下一个版本再执行 G4-2。在那之前，`launchWords` / `launchArgs` 与页面的旧 core 退路保留。

## G4-3 发布演练 0.2.0

只做本机演练（用户决定）：没有推标签，没有建 GitHub Release 或草稿，也没有跑 `release.yml`。

做了什么：

- 版本：`node tools/release/version.mjs set 0.2.0`，改了根、`apps/desktop`、`apps/server`、`apps/mobile` 四处 `package.json`。演练中发现 core 的 `VERSION`（`core/instance.ts`）与 armadra-hook 的 `CLIENT_VERSION`（`cli/armadra-hook/usage.ts`）是手写常量，`set` 不会改它们，结果 `instance.test` / `hook.test` 红了。现在把这两处加进 `VERSION_SITES`，`set` 会一起改，`release:check` 也会一起看；`version.test` 加了一条用例覆盖。iOS 工程的 `MARKETING_VERSION` 缺省值同步改为 0.2.0（CI 打包时仍由命令行覆盖）；Android 的版本名与版本号从 `apps/mobile/package.json` 推出（200）。`apps/web`、`packages/shared` 是不发布的私有包，不在 `VERSION_SITES` 里，保持不变。
- 兼容表 `tools/release/compatibility.json`：
  - `minimumInstalled` 保持 0.1.0。v0.1.0 的 13 个迁移与现在 `core/db/migrations/` 的 0001–0013 逐字节相同，之后只新增到 0035，0.1.0 的库能直接迁上来。
  - `agent` 为 `@armadra/agent` 0.6.7、`hostApi` 1，与桌面壳的 devDependency、lockfile 一致（`release:check` 校验通过）。
  - `acp` 记上 2026-10-04 实跑通过的 `claude` → claude-agent-acp `min 0.85.1`、`pi` → pi-acp `min 0.0.34`。改动与 #77 的两个提交逐字相同，两边合并时不会冲突。其余五家仍为 null。
- 新增 `CHANGELOG.md`（中文），内容是 0.1.0 以来的变化，按 PR 编号归类到 #77 为止。`repo.rules.json` 根目录白名单与[仓库结构](../design/repository-structure.md)的目录树已登记它。

实测（macOS arm64，2026-10-04）：

- `pnpm release:check`：版本 0.2.0，六处一致；agent 钉住的版本与安装的一致。
- `pnpm release:test`：139 项，138 过、1 跳过（dev-stack 条目在没有设 `ARMADRA_DEV_STACK=1` 时按设计跳过），0 失败。
- `pnpm release:dry-run --keep`：0.2.0 全矩阵通过，22 个文件进 `SHA256SUMS`，6 个更新平台。产物矩阵逐项核对过：
  - darwin-aarch64 / x86_64：`.dmg`、`.zip`
  - linux-aarch64 / x86_64：`.AppImage`、`.deb`、`.rpm`
  - windows-aarch64 / x86_64：`-setup.exe`、`-portable.zip`
  - 另有 `armadra-web_0.2.0.tar.gz`
  - 每个文件都有 minisign `.sig`
  - 6 份清单：`latest-darwin-{aarch64,x86_64}-mac.yml`、`latest-linux-x86_64-linux.yml`、`latest-linux-aarch64-linux-arm64.yml`、`latest-windows-{aarch64,x86_64}.yml`，`version` 都是 0.2.0，`sha512` / `size` 与包相符
  - `latest.json` 的 `version` 为 0.2.0，6 个平台都有 `url`、`signature`（可信注释带 `version:0.2.0`）与 `feed.sha256`
  - 发布说明围栏为 `{"minimumInstalled":"0.1.0"}`
  - 本机没有装 `minisign` 二进制，签名只用 Node 实现验过
- 对着 dev-stack `release`（`pnpm dev-stack up release`，127.0.0.1:8090，开发公钥 `tools/dev-stack/.data/release/minisign.pub`）跑 `release:dry-run --against`：全平台一次，加上 6 个 `--target` 各一次，都通过（ETag 304、`SHA256SUMS` / `latest.json` 验签、各平台清单与包）。这个服务固定发 99.0.0 夹具，所以又在宿主机上用同一个入口起了 0.2.0（`RELEASE_VERSION=0.2.0 MOCK_RELEASE_PORT=8093 node tools/dev-stack/release-entry.mjs`）。还用 `mock-release-server.mjs` 把上面演练出的 0.2.0 目录按 `v0.2.0` 托管出来。这两份 0.2.0 都以客户端视角 `--against` 验过，6 个平台都通过。用完 `pnpm dev-stack down`。

没做 / 需用户提供：

- 真签名与公证：Apple、Windows、GPG 证书与 minisign 发布密钥都没有，见上面「需用户提供」P0 / P1。拿到之前，正式发布按「未签名」处理，说明顶部会列出未签名的平台。
- `release.yml` 的发布说明目前取 GitHub 的 `generate-notes`，不读 `CHANGELOG.md`。发版时需要手工把 0.2.0 一节贴进草稿，或者另开一个包让 `assemble.mjs --notes-from` 读这一节。
- 打包版的「检查 → 下载 → 暂存」这次没有对 0.2.0 重跑。G3-3 已用 `update-e2e` 对 dev-stack 走通过，这次没有改壳侧代码。

<!-- G5 剩余事项（g5-remaining-plan.md §3；节由 G5-00 预建，各包只填自己那一节） -->

## G5-00 骨架与编号

**做了什么**

- 路由 scope（`core/http/route-scopes.ts`）：`/api/identity/password-reset/` 不要求权限（令牌即凭据），`/api/identity/principals/{id}/password-reset` 归 `identity:manage`；`/api/gateway/pairing-code/exchange` 不要求权限并进 `SELF_GUARDED`（其余 `/api/gateway/pairing-code*` 仍是 owner 那一档）；`/api/forge/` 与 GitHub 同档（`github:read` / `github:write`）；`/api/mail/`（清单 `identity:read` / `identity:manage`）与 `/api/diagnostics/client-error`（清单 `canvas:read`）进 `SELF_GUARDED`，由域自己认身份。
- 装配（`core/main.ts`）：`core/forge/`、`core/mail/`、`core/diagnostics/index.ts` 三个空骨架域。forge 在 GitHub 与 Git 之后；邮件与页面错误上报在推送之后、hook 服务之前。G5-13 / G5-14 / G5-19 只填各自的 `install`，不再改 `main.ts`。
- 事件（`core/bus.ts`、共享层 `api/events.ts`）：`schedule.fired { planId, runId, nodeId? }`、`schedule.failed { planId, runId, nodeId?, reasonCode }`、`schedule.attention { planId, nodeId?, reasonCode }`、`resources.threshold { sessionId, nodeId?, metric, value, threshold }`。这里只定义形状，不发事件；四个都已进 `WORKSPACE_EVENT_TYPES`（共 32 个）。
- 设置键：`diagnostics.reportPageErrors`（缺省 false）、`usage.claudeLocalWindow`（缺省 true）。两份 `completion-settings.ts` 仍逐字节相同；core 归一、共享层 zod、页面 `api/settings.ts` 的类型同步更新，坏值退回缺省。
- i18n：预登记 `coordinator`、`forge`、`mail`、`diagnostics`、`password-reset` 五个空模块。展示页模块改为只在 `import.meta.env.DEV` 下挂进 `MESSAGE_MODULES`（R-72 的一项）。`i18n.test` 的全集断言改为开发态断言；`production.test` 改在 `NODE_ENV=production` 下真构建，断言 `dist/` 里没有 showcase 的键。原先 Vitest 的 `NODE_ENV=test` 让构建里 `DEV` 为真，即使有泄漏也查不出。桌面壳 tsconfig 也会检查 `i18n/index.ts`，所以文件头加了 `vite/client` 类型引用。
- 契约 §24–§30 节标题，内容为「预留」；§27 先记下上面四个事件的形状。架构文档的域表加了 `core/mail/`、`core/forge/` 两行，`core/diagnostics/` 一行补上页面错误上报。本文件预建 G5-00 到 G5-27 共 28 节。

**实测**（macOS arm64）

- `pnpm libs:build && pnpm -r --if-present test`：desktop 4238 过 / 46 跳过，脚本 65 过；web 3239 过；shared 320 过；server 79 过 / 2 跳过；mobile 9 过；push-relay 9 过；0 失败。
- `pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。
- 反证：把 showcase 改回无条件挂载后，`production.test` 报出 `showcase.title` 进了 `assets/preferences-store-*.js`，测试按预期失败。

**没做**：这里不写任何路由与事件的发送，各由对应包实现。迁移号 0036–0038 也不由本包占用。

## G5-01 Gateway 配对短码与手机输入（R-01）

**做了什么**

- core `gateway/pairing-code.ts`：8 位配对码，字母表 `[A-Z2-9]`，显示为 `XXXX-XXXX`。码随配对票一起签，过期时刻与票相同，一次性使用；票先被扫码兑掉时码随之作废，查的是 `identity_tickets.consumed_at_ms`。码只存在内存里，同时最多 32 枚；Gateway 关闭、重开或换档时全部作废。限流按来源地址用 `IpBuckets`（每分钟 20 次），另设一只全局桶（每分钟 200 次），只在猜错时扣令牌。开放范围：`loopback` / `private` 档开放；`all` 档只在绑定地址是回环或私网字面量时开放；配了对外来源一律关闭。
- `POST /api/gateway/pairing` 的回答多一个 `code`，不签码时为 `null`。新增 `POST /api/gateway/pairing-code/exchange { code }`，回答与 §17.3 同形。在 Gateway 准入里它是匿名路径（`admission.ts::anonymousPath`），Cookie 模式和 Bearer 模式都适用；路由表加了一行。请求的 Origin 与票绑定的来源不一致时答 409 `origin_mismatch`，码不作废。审计新增 `gateway.pairing.code.exchange` / `.reject`，码与票都不记。`Gateway` 接口多出 `mode`、`publicOrigins` 两个字段。
- 共享层 `api/gateway.ts`：载荷加可选 `code`，新增换码请求体的 schema。
- 页面：配对卡按设计系统 §5.12 显示「配对码 `Kbd` 倒计时」，过期后收起。手机浏览器经 Gateway 打开、窄屏、没带 `#pair=` 且没有会话时（`entry.ts` 先 `resumeIdentity` 判断），连接页先显示 8 位 `InputOTP`（两组四位），输满后自动兑换并配对；同一页另有「账号登录」，点了直接进页面。原生 App 只在已经记下 Gateway 来源时出现第三个入口「输入配对码」，兑换出的指纹会再钉一次。i18n 的 `gateway`、`mobile-connect` 中英文同步。
- 展示页：`gateway` 的运行中样本带上配对码，`mobile` 加一屏「输入配对码」。`gateway-e2e` 加一段 4b：配对卡上有配对码；在独立上下文、390 宽视口下输入短码，配对成功并进入画布；同一枚码再兑答 404。
- 契约 §24 已填写，§17.3 追加一句；架构文档「Gateway / 手机」一条已更新。

**实测**（macOS arm64）

- 新增与改动的用例：`pairing-code.test`（字母表、规范化、一次性、过期、票作废、来源不一致、来源桶与全局桶、上限、撞码重抽、开放档位）、`routes.test`（请求体，以及域内 `all` 档答 403、`code: null`）、`admission.test`、`gateway.integration.test`（换码 → 配对 → 码与票都失效；扫码先兑后码作废；来源不一致答 409 且码保留；Bearer 模式；未知来源 403），以及 web 的 `ConnectScreen` / `connect` / `entry` / `PairingCard` 测试。
- `node tools/probes/gateway-e2e.mjs`：全部通过，包括 4b。`node tools/probes/design-showcase.mjs --only=gateway,mobile`：12 张截图，控制台无 error。
- 全量验证结果见 PR。

**没做 / 限制**

- 原生 App 首次连接（还没钉过信任锚）不能用配对码：App 不装 CA，连不上未钉扎的 Gateway，仍需扫码或贴链接。
- 设计系统首行状态里「8 位配对码没有做」一句没改，留给汇总时一起更新，以免与并行包冲突。

## G5-02 身份 core：重置链接、passkey 改名、设备两列（R-02 核心、R-03、R-05、R-08、R-09）

**做了什么**

- 迁移 `0036_password_resets.sql`：表 `identity_password_resets(token_hash, principal_id, issued_by, created_at_ms, expires_at_ms, used_at_ms)`，另加按人的索引。比计划多一列 `created_at_ms`，用来写 `expires_at_ms > created_at_ms` 的约束。`migrations.lock` 已同步。
- 口令重置链接（契约 §25，R-05）。令牌原语在 `core/identity/password-reset.ts`：与邀请同形，库里只存 `digest("reset", …)`，`tokens.ts` 多了用途 `reset`。判定与事务在 `accounts.ts`：`issuePasswordReset` / `inspectPasswordReset` / `completePasswordReset`。路由在 `accounts-http.ts`：
  - `POST principals/{id}/password-reset` 答 `{ token, expiresAtMs }`，有效期 24 小时。owner 与 `identity:manage` 对任何成员都能签；组 admin 只能对自己所管组里角色是 `member` 的人签。owner 只有 owner 自己能签。停用了的人与服务账号答 400。签新令牌会作废同一个人的旧令牌。
  - `GET password-reset/{token}` 答 `{ displayName, expiresAtMs }`。
  - `POST password-reset/{token} { password }` 答 `{ principalId, revokedSessions }`。
  - 匿名的两条都走「失败才扣」的 IP 桶。认不出的令牌一律答 404 `password_reset_invalid`。设新口令先过口令策略与泄露检查；过了之后在同一笔事务里作废令牌、换口令、撤掉这个人的全部会话，并清掉他的登录锁定。
  - 审计 `identity.password.reset.issue` / `.use`，令牌明文与哈希都不进审计。
- L2（R-08）：`setPassword` 成功后撤掉这个人的其它会话，本人换口令时留下当前会话。答复与审计都多一个 `revokedSessions`，这个人手里没用的重置令牌一并作废。
- L3（R-09）：邀请 `ttlMs` 最长夹到 30 天，不是正整数时答 400（`invitationTtl`）。
- passkey 改名（R-03 core）：`PATCH passkey/{id} { label }`，只有本人能改，1–64 个字符，审计 `identity.passkey.rename`。
- 设备两列（R-02 core）：`GET devices` 每行可选带 `platform` 与 `lastSeenAtMs`（`service.ts::devicePlatform`、`store.ts::deviceActivity`）。`platform` 由最近那个会话的 UA 归类得出，UA 原文不出 core；`lastSeenAtMs` 取该设备所有会话里的最大值。
- 共享层 `identity-security.ts` 加了 §25 的 zod、`passkeyRename*`、`DEVICE_PLATFORMS`、`passwordSetSchema`。页面客户端（只改 `api/`，不改页面）加了：`api/security.ts` 的 `renamePasskey`、`issuePasswordReset`、`openPasswordReset`、`completePasswordReset`、`passwordResetLink`、`hasPasswordResetFragment`、`takePasswordResetToken`；`api/identity.ts` 的设备 schema 两列与 `PATCH` 方法；`api/accounts.ts::setPassword` 改为答 `revokedSessions`。
- 契约 §25 正文；§10、§18.2、§18.4 各追加一段，没有改动既有文字。

**实测**（macOS arm64）

- 新增 `password-reset.test`（8 条）：覆盖签发权限矩阵、一次性、签新作废旧、过期、停用、口令策略、清锁定、审计不含令牌、IP 桶 429，以及与共享层常量对齐。`security-http.test` 加了 passkey 改名与 L2 / L3（+4 条）。`accounts.integration.test` 在真 core 上验设备两列与重置全流程（+1 条）。`service.test` 加了 UA 归类表，`route-access.test` 加了四条路径。页面 `api/security.test` 加了 4 条。
- `pnpm libs:build && pnpm -r --if-present test` 的结果：desktop 4251 过 / 46 跳过，live 4 过，脚本 65 过；web 3243 过；shared 320 过；server 79 过 / 2 跳过；mobile 9 过；push-relay 9 过。全量那一轮里 `cli/armadra-hook/wire.test.ts` 的「waits for an answer file」失败 1 次，这个用例与本包无关，单独重跑 14 条全过。
- `pnpm --filter @armadra/web typecheck`、`pnpm check`（含 `repo:check` 的迁移锁校验）通过。

**没做**

- 页面（重置页、签发按钮、设备表两列、passkey 改名入口、`#reset=` 片段接入 `App.tsx`）归 G5-03。「发邮件」按钮归 G5-13。
- `docs/status/security-review-2026-10.md` 里 L2 / L3 的状态没有改，那是审查记录。

## G5-03 身份页面：整页登录、忘记口令、重置页、passkey 改名、MFA 重置、L7（R-02 页面、R-03 页面、R-04、R-05 页面、R-06、R-13）

**做了什么**

- 整页入口（R-06）：新 `app/IdentityGate.tsx` 包在 `App.tsx` 的壳外面。服务器壳 / Gateway 来源（HTTPS 页面）没有会话时渲染整页 `SignIn`（无侧栏、360 列、BrandMark 居中）；地址栏带 `#reset=<令牌>` 时渲染整页「设置新口令」，同一标签页里贴进链接（只改片段）也接得住；带 `#invite=` / `#pair=` / `#oauth=` 时照旧进壳由设置页接手；问不到会话（离线、旧 core）照旧进壳。登出、换会话广播后重问会话。策略要求 MFA 而未登记时登录后直接打开「安全」。桌面窗口与原生 App 不经过它。
- 重置页（R-05 页面）：`session/ResetPassword.tsx`，先 `GET` 显示是谁的、几点前有效；认不出一律「链接已失效 · 请联系管理员重新签发」；两次输入核对；设好后「去登录」落在整页登录的口令步，账号已填成那个人的 principalId。
- 忘记口令：登录口令步一个 link，点开只给一句「请联系管理员为你签发重置链接」（邮箱可选，没有自助重置）。
- 签发重置链接：`panels/settings/pages/ResetLinkDialog.tsx`，打开即签，链接 + 二维码（复用配对卡的 `QrImage`）+ 复制 + 过期时间；服务器配了邮件（`GET /api/mail/status.configured`，404 当未配置）时多一行「发送邮件」。账号与共享页成员行改成「…」菜单：签发重置链接 · 重置两步验证 · 停用；owner 那一行只有 owner 自己看得到「签发重置链接」。组管理员在组对话框里对角色是 member 的人有同一个按钮。邀请对话框生成链接后同样有「发送邮件」（`MailLinkForm`）。新 `api/mail.ts`。
- owner 重置 MFA（R-04）：成员行菜单「重置两步验证」→ `AlertDialog` 确认 → `POST /api/identity/mfa/reset`（`api/security.ts::resetMfa`），toast 区分「已重置」与「本来就没开」。
- passkey 改名（R-03 页面）：安全页通行密钥行多一个铅笔按钮，名称格内联成 `Field` + `Input`，Enter / 保存提交，Esc 取消，1–64 字符。
- 设备两列（R-02 页面）：`GatewayDevices.tsx` 加「平台」「最近访问」，没有值画「—」。
- L7（R-13）：`password_too_short / password_too_long / password_contains_name / password_too_common / password_breached` 各有中英文案（`security.error.*`，`sign-in-errors.ts::passwordFailure`）。重置页、设口令、添加成员、兑换邀请的对话框把它显示在输入框下面，对话框不关；`warn` 档命中时重置页给 `Alert`，账号与共享页页顶给 `Alert`「这个口令出现在已知泄露里」。`api/accounts.ts::setPassword` 改为答 `{ revokedSessions, passwordBreached }`，`createMember` 答 `{ principal, passwordBreached }`，`redeemInvitation` 多带 `passwordBreached`。
- core 小接线（G5-13 留下的）：`AccountsService.requirePasswordResetRights`（`requireResetRights` 的公开包装，不签不写）；`mail/index.ts::linkChecks()` 加 `passwordReset`：先按签发规则认调用方（403 / 404），再 `inspectPasswordReset` 认令牌并核对属于这个人，不对一律 409 `link_invalid`。契约 §28 删掉「还没有口令重置」的 404 说明并补了这条顺序。
- 展示页 `auth` 分区：整页登录、设新口令、链接失效、泄露提示、忘记口令；通行密钥样本带改名入口。i18n：`password-reset`、`mail` 两个空模块填上，`security` / `sharing` / `host-identity` 追加，中英同步。架构文档 §7 身份一段加一句整页入口。

**实测**（macOS arm64）

- 新增 / 扩充用例：`IdentityGate.test`（6）、`ResetPassword.test`（9）、`SignIn.test`（+2）、`PasskeyList.test`（+2）、`GatewayDevices.test`（2）、`AccountsSharingPage.test`（+5：成员菜单签链接与发邮件、没配邮件不出现、MFA 重置先确认、策略错误内联与 warn 提示、组管理员签链接）；core `mail.test` 把旧的 404 用例换成 3 条真身份域用例（发信、令牌不是这个人 / 被作废 / 伪造 409、路人 403 与无此人 404）。
- `gateway-e2e` 加第 4c 段：owner 签重置令牌 → 新上下文打开 `#reset=`、整页设新口令 → 成员原会话 401、令牌再用 404 → 「去登录」口令步新口令登录回同一成员，页面无控制台错误；passkey 段改为在整页登录上点「使用通行密钥」。本机整条探针全过。
- 真浏览器（无头 Chrome，桌面 core + Gateway，假 HIBP 接 `ARMADRA_HIBP_BASE`）走过：成员菜单、MFA 重置确认与结果（成员 `mfa.enrolled` 变 false）、重置链接对话框、整页登录、忘记口令、重置页、弱口令拒绝、`warn` 命中提示、新口令登录、passkey 内联改名（core 里标签已变）、设口令策略错误内联与页顶泄露提示。
- `design-showcase --only=auth` 6 张图，深浅对比度与控制台通过。
- 全量验证结果见 PR。

**没做 / 限制**

- 「重置两步验证」放在账号与共享页的成员行菜单，而不是安全页：安全页只管自己，没有「看别人」的视图；成员表本来就在账号与共享页。
- 「发送邮件」只在桌面 Gateway 未配 SMTP（按钮隐藏）与单测里的假客户端上验过；真 SMTP 由用户提供。
- 计划写的 `password_common` 实际规则名是 `password_too_common`，另补了 `password_too_long`。

## G5-04 ACP core 补充（R-26 core、R-27 core、R-28、R-29）

**做了什么**（契约 §26.1–§26.4，§14.2 / §14.4 各追加一句）

- 客户端能力：`client.ts::acpClientFeatures()` 读 `AcpClient.features` 的 `elicitation` / `configOptions`。有 `elicitation` 时构造参数多传 `onElicitation`，挂起表与权限请求同一套规矩：取消、断开、退出一律回 `{ action: "cancel" }`。有 `configOptions` 时 `setConfigOption(sessionId, configId, value)` 才发。两样都没有时线路与之前逐字节相同。
- elicitation（R-26 core）：`elicitation/create` 进 `agent_approvals`，`request_json = { protocol: "acp", elicitation }`，存进去的表单按规范子集收过（`elicitation.ts`）。节点状态 `waiting` 带 `pendingId`，不再置 `awaitingInput`，否则答完之后的 `done` 会被改写成 `waiting`；`normalize.test` 的断言随之改了。答复 `POST /api/approvals/{id}/answer { elicitation: { action, content? } }` 先按请求自己的 schema 校验，再走同一个 CAS；`content` 只交给 Agent，不进审批行、审计、事件与答复。节点头的 allow / deny 也能答。`GET …/log` 多 `elicitations`。
- 模型（R-27 core）：目录取自开会话答的 `configOptions`（`category: "model"`，没有时看 `initialize` 答的；分组摊平），`config_option_update` 跟着更新。新路由 `PUT /api/acp/sessions/{id}/model { modelId }`；`GET …/log` 多 `models`。起会话时节点数据 `agent.model` 在目录里就落上，落不上也不拦启动。
- `pi-acp` 映射（R-28）：适配器表 `pi` 行写死 `~/.pi/acp/sessions.json`（`{ "<ACP id>": { "sessionFile" } }`）。会话开好时 `transcriptPath` 指向 Pi 会话文件；接回 ACP 时把 Pi id 反查成 ACP id，切回终端时把 ACP id 映射回 Pi id。读不到时退回 `opaque` 的做法。
- 凭据（R-29）：适配器不经画布启动器，`AcpRuntime.open` 起适配器之前做兑换。节点凭据走 `CredentialsDomain.redeem`，与 §20.4 同一绑定、同一套校验；`credential:use` 已在 `ownedEnvironment` 拦过。基础 CLI 是 ama 时取 §12.4 的模型密钥。值只设进适配器进程的环境；兑换失败拒绝起会话，原样答 §20 的码。

**实测**（macOS arm64）

- `pnpm libs:build && pnpm -r --if-present test`：desktop 4257 过 / 46 跳过，1 条失败是 `agent/probe.test.ts`「真起一个假 CLI」在满载下 8 s 超时，单跑通过，与本包无关；live 4 过，脚本 65 过 / 2 跳过；web 3239 过；shared 320 过；server 79 过 / 2 跳过；mobile 9 过；push-relay 9 过。`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。
- 新用例：`acp/features.test.ts`（把 `AcpClient` 换成补出两个能力的子类，配一个会发 elicitation、答 `configOptions` 的假 Agent，真子进程）覆盖 elicitation 的接受、拒绝、取消与退出，模型目录与改模型，路由与审批答复的校验，内容不落库，以及等待时拒绝切换。`routes.test` 覆盖客户端没有能力时 `models: null`、`PUT …/model` 409。`adapters.test` 覆盖映射文件的正反查与退回。`credentials.test` 新增「ACP 驱动的节点」四条：值的摘要进了适配器环境、不在答复 / 会话行 / 节点数据 / 镜像 / 日志；值不在时 409；成员 403；ama 密钥。

**偏离**

- 计划写的是「模型目录来自 `initialize` 答的 `configOptions`」；规范里它在开会话的答复里，所以以开会话的为准，`initialize` 的只作后备。
- 计划没列 `core/http/routes.ts`，但新路由要进路由表，否则装配时就抛错，所以加了一行。
- elicitation 的状态不置 `awaitingInput`，理由见上。

**没做 / 需要上游**

- 上游已补：`@armadra/agent` 0.6.8 的 `AcpClient` 带 `features.elicitation` / `features.configOptions`（`onElicitation`、`clientCapabilities.elicitation`、`setConfigOption`、`configOptions` 类型），假 Agent 会发 elicitation（`[elicit]`）、`--config-options` 时答 `configOptions`。依赖已升到 0.6.8，`acp/feature-fixture.ts` 已删，`features.test` 与凭据用例改用上游的真客户端与假 Agent。
- `~/.pi/acp/sessions.json` 的路径与形状没有和真 `pi-acp` 核对过（B 档真跑）。
- ama 密钥与终端驱动一样，不要求 `credential:use`；L10（按节点只发用得到的那一家）没有做。
- 页面（`ElicitationCard`、模型 Select）归 G5-05，SSH 归 G5-06。

## G5-05 ACP 页面补充（R-26 页面、R-27 页面、R-31）

**做了什么**（按契约 §26.1 / §26.2 的页面一侧，接口形状未改）

- `ElicitationCard`（`apps/web/src/acp/ElicitationCard.tsx`）：与审批卡同一位置、同一外观——只有一张挂起项时钉在输入框上方，多张时随消息流。按 `requestedSchema` 画 Field：字符串 `Input`（`format` 映射 email / url / date）、枚举 `Select`（`enumNames` 作标签）、`number` / `integer` 数字输入、布尔 `Switch`；必填与约束在页面先判一遍，不合规时「提交」置灰。提交、拒绝、取消各一键，答复走 `POST /api/approvals/{id}/answer { elicitation }`，不带 `decision`。URL 模式只给链接与「继续」（只放行 http(s)）；core 没存 `requestedSchema` 时只剩拒绝与取消。先收起再发请求（与审批卡相同），答不上把卡放回并提示。没有答复权限的人看到同一张卡，按钮换成「等待接管」。
- store：每个会话多 `models`；挂起的 elicitation 按 nodeId 存，来源是 `GET …/log` 的 `elicitations` 与 `agent.approval`；`resolvePermission` 同时收两类；回合结束一起清。`config_option_update` 只在已有目录时跟（与 core 同一条规矩，`modelStateOf` 与 `core/acp/models.ts` 同一认法）。
- `PromptBox`：`models` 非空时多一个模型 `Select`；≤ 767（含手机焦点页，焦点页挂的是同一个会话视图）模式与模型收进一个「⋯」`DropdownMenu`（两组单选）。换模型先改本地、`PUT /api/acp/sessions/{id}/model`，成功后把 `agent.model` 写回节点数据（`history: "ignore"`，与会话 id 同理不进撤销栈），失败回退并提示。
- 展示页 `acp` 分区：模型 Select、窄屏「⋯」、elicitation 表单卡与链接卡。i18n `acp.prompt.{model,more,modelFailed}`、`acp.elicitation.*` 中英同步。
- `acp-e2e`：第三个节点 C（假 Agent 带 `--config-options`）发 `[elicit]` → 卡片出现、选 `blue` 填 `2` 提交 → Agent 回 `elicit: accept {"color":"blue","count":2}`、审批行 `allow` 且不存内容；有模型目录时换到 Large → `[model]` 答 `model large`、节点数据 `agent.model = large`。上游没有能力时（旧假 Agent 回声或新假 Agent 答 `unsupported`、`models` 为 `null`）记进 `report.skipped`，不算失败。

**实测**（macOS arm64）

- 新用例：`ElicitationCard.test`（内容组装与校验、各控件、提交 / 拒绝 / 取消、答不上放回、URL 模式、无权限）、`PromptBox.test`（模型 Select、窄屏「⋯」、无可选时不画菜单）、`store.test`（目录认法与 `config_option_update`、elicitation 的解析、hydrate、收起与回合结束）、`SessionView.test`（事件流里的 elicitation 答复、重载恢复、换模型写回、失败回退）。
- 真浏览器：`acp-e2e` 在上游 0.6.7 上 elicitation 与模型两步记为跳过，其余照常；另用一份只在本机的 core 拷贝（`AcpClient` 按 `acp/feature-fixture.ts` 的形状补出两个能力）加 fixture 的假 Agent 跑通整轮（截图 `10-elicitation-card`、`11-elicitation-answered`、`12-model-switched`）。`design-showcase --only=acp` 六张、两主题对比度通过、无控制台错误；390 宽下「⋯」菜单展开截图核对过两组单选。
- `acp-e2e` 第 5 步「切到终端视图：PTY 起来并敲了 CLI 的恢复行」在本机 main 上同样失败（不是本包引入）。

**偏离**

- 计划写「`PromptBox` 加模型 Select」；模型只有一个时也画（让人看得见在用哪个），模式仍是多于一个才画。
- `PromptBox` 多一个可选 `compact` 属性，只给展示页画窄屏那一版。

**没做 / 需要上游**

- 真机生效要等 `@armadra/agent` 发出带 `features.elicitation` / `features.configOptions` 的版本并升依赖；届时 `acp-e2e` 的那一轮自动从跳过变成真跑（上游假 Agent 的 `[elicit]`、`[model]`、`--config-options` 与本轮一致）。

## G5-06 SSH 节点的 ACP（R-30）

**做了什么**

- `core/acp/ssh.ts`（新）：节点数据带 `ssh.hostId` 时，ACP 适配器起在执行主机上。本机起的是不带 TTY 的 `ssh … -- <目的主机> <远端命令>`（`terminal/ssh/argv.ts::streamArgv`），askpass、主机密钥文件与 `ARMADRA_REMOTE_WORKER_LAUNCHER` 都和 Worker 共用一套；这条 `ssh` 的 stdio 就是 ACP 传输。远端命令把每个词放进单引号，值里有 `'`、`\`、`!` 或控制字符时拒绝。命令先 `cd` 进节点的 `cwd`（没有就用工作空间根），进不去就失败。
- `host.ts` 只多了 `transport` 参数（`AcpTransport`），以及可以直接传入的 `mcpServers`。协商、开会话、接回、模式与模型都没改。
- Worker 新增 `agents.probe { programs }` → `{ platform, programs }`（`remote/node-probe.ts::probeAgents`，登记在 `operations.ts`）。它只读，能力位复用 `remote.integration.v1`。程序没装答 `acp_not_installed`。`acp_unsupported` 只剩四种情况：主机没登记、没配 Worker、Worker 过旧（对这个动作答 501）、主机不是 POSIX。
- 画布工具：新增 `RemoteIntegration.canvas`，和远端画布注入走同一套准备和同一条中继 socket，答执行主机上 Hook 客户端的路径，作为 `mcpServers` 里的 `armadra-hook mcp`。
- 凭据在远端不兑换：节点凭据、ama 密钥都不设，条目名也不带过去。转录一律认本机镜像。
- `acp/routes.ts` 去掉了「SSH 节点不能切 ACP」的拒绝。起会话、接回、切换都按节点决定 `ssh`，工作目录不按本机规则解析。切回终端时，下一代经 `ssh` 起在同一台主机上：`ReviveOptions` 多了 `sshHostId` 与 `cwd`，敲的是只带程序名的启动行。依赖编排与定时冷启动对 SSH 的 ACP 节点也起适配器（`terminal/install.ts`）。
- 契约新增 §26.5，§14.2 里那一句改成指向它。

**实测**

- `acp/ssh.test.ts`：11 例，覆盖远端命令的引号与拒绝、`streamArgv`、`agents.probe`、各种错误码，以及用假 ssh 加真 fake ACP Agent 走完整条路由：一轮回复 → 切终端（行上 `sshHostId`）→ 切回 ACP 接回 → 再答一轮。
- `vitest src/core/{acp,remote,terminal}`：50 个文件，566 例全过。
- `remote-e2e` 新增 08b 步：远端工作空间里的 SSH 节点以 ACP 驱动，用真 Worker 和假 ssh，答一轮 → 切终端（tmux，第 2 代）→ 切回（`resumed: true`）→ 再答一轮。整个探针全绿。

**没做**

- 远端适配器不带终端启动器的注入 argv / env，也不带 ama 的 profile；ama 在执行主机上本来就不支持。
- 没有用真 sshd 和真 CLI 实跑（与 remote-e2e 一样，只验证假 ssh 这条传输）。

## G5-07 协调者 runners：`--cwd` / `--resume` 与 `blocked` 覆盖（R-33、R-34）

**做了什么**

- `open-agent --cwd <目录>`（`collab/control/nodes.ts`）：可以写工作区根下的相对路径，也可以写落在工作区里的绝对路径。按 core 所在机器的路径规则解析，并解开符号链接后再判断。出了工作区（经 `..`、符号链接，或字面上就在外面的不存在路径）回 `400 cwd_outside_workspace`。目录不存在、指向文件、与 `--worktree` 同给，都回 `400 bad_request`；远端执行主机上的工作区回 `400 cwd_unsupported`。成立时把解开后的绝对路径写进节点数据的 `cwd`。
- `open-agent --resume <会话 id>`：id 是 1–200 个字母、数字或 `. _ : -`。写进节点数据的 `agent.resume`，节点交给依赖编排的启动路径由 core 起（不带 `--task-id` 也一样，因为页面自己敲的是新开的启动行）。`dependencies/launch.ts::launchLine` 把它交给 `canvasLaunchLine`，走 `agent/launch.ts` 已有的 resume 行。这个 CLI 不能续接（含关掉 `resume` 能力的自定义条目）回 `400 resume_unsupported`。值是同一块画布上成员节点的 id 时（runner 的 `sessionRef.sessionId` 就是节点 id），取那个节点上报过的会话 id；跑的不是同一家或从没报过会话 id，同样回 `resume_unsupported`。共享层 `terminalAgentSchema` 加了可选的 `resume`，页面存盘时不会把它剥掉。
- ama runner（`agent-host/ama/runners.ts`）：把 `request.cwd` / `request.resume` 映射成 `--cwd` / `--resume`，不再忽略 `resume`。core 用 `cwd_outside_workspace` / `cwd_unsupported` / `resume_unsupported` / `permission_mode_unsupported` 拒绝时，去掉对应的那一项再起一次，并记一行日志（`plan` 模式仍不退回）；别的拒绝照旧抛出。
- 成员技能补了一句 `--cwd` / `--resume` 的用法，`SKILLS_REVISION` 从 17 升到 18；`armadra-hook` 的用法文本同步。
- 场景 11 新增第 6 步：派一个带「需要审批」的任务，假 CLI 经 `armadra-hook claude` 报 `PermissionRequest` 后挂着等答复。以协调者身份直接调 `/control/wait`，断言答 `blocked`、`approvalId` 就是成员挂着的那条审批，且任务行仍是 running。然后经 `POST /api/approvals/{id}/answer` 答「允许」（页面节点头走的也是这条），假 CLI 拿到 allow 后按键回报，任务行变成 done，便签里是审批之后的结果。第 4 步另加一条断言：runner 带过去的 cwd 就是成员终端的 cwd。
- 契约 §15.5 的 `open-agent` 参数下追加 `cwd`、`resume` 两句。

**实测**（macOS arm64，脚本化模型，无真密钥）

- `wait.test` 新增 6 例：`--cwd` 的相对 / 绝对 / 根 / 演练、越界与符号链接、不存在 / 文件 / 与 worktree 冲突，`--resume` 的启动行（Claude `--resume <id>`、Codex `resume <id>`）、节点 id 换会话 id、不能续接与格式错误，以及「长轮询中停到审批上 → blocked 带 id → 答复后跑完 → done」。`runners.test` 新增 3 例：透传、按码逐项退回、别的拒绝不退回。
- `node tools/probes/agent-e2e.mjs <out> --only 11`：全部通过，包括第 6 步的 6 条断言和 cwd 断言。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 4255 过 / 39 跳过，脚本 4 过；web 3239 过；shared 320 过；server 79 过 / 2 跳过；mobile 9 过；push-relay 9 过。`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。

**没做 / 限制**

- `workflow/dispatch.ts` 没改：启动行由依赖编排从节点数据拼，`launchRoleNode` 不需要额外透传参数；工作流角色也不需要 `cwd` / `resume`。
- 以 ACP 驱动的节点不读 `agent.resume`（ACP 的续接走它自己的 `session/load`）。
- `--cwd` 只支持本机工作区；`team` 没有加这两个参数。
- `agent.resume` 只在 core 第一次起这个节点时用。之后页面重开终端敲的是新开的行；休眠后的接回仍按 `agent_status` 的会话 id。

## G5-08 工作流编辑器与模板升级（R-36、R-37）

**做了什么**

- 编辑器（`web/workflow/TemplateEditor.tsx`，设计 §5.5）：左列步骤用 `Item` 列出，可以拖柄拖动排序，也可以用键盘（空格拿起、方向键移动、空格放下），排序用 `@dnd-kit/sortable`。「+」菜单可以加提示、汇总、关卡三种步骤。新步骤默认依赖上一步，汇总步骤也默认从上一步汇总，加完自动选中。每一步都能删，别的步骤对它的依赖和汇总来源会一起去掉；只剩一步时不能删。右侧表单的依赖复选框跟着步骤变化，会成环的选项不让勾；汇总步骤多一列「汇总来源」，勾上的来源会自动加进依赖。角色可以增删，可以改名称和 CLI（`Select`）；正被步骤使用的角色、或只剩一个角色时，删除按钮不可用。删角色时，连着它的协作连线一起删掉。提示词或关卡说明为空、汇总没有来源时，「保存」不可用。纯函数在 `workflow/model.ts`（`addStep / removeStep / moveStep / dependsOn / addRole / removeRole / updateRole / roleInUse / incompleteSteps / canSaveDraft`）。
- 模板升级 core（`core/schedule/workflow-target.ts`）：`paramCompatibility` 把冻结计划的参数和新模板比对，结果分三种：`compatible`、`missing_params`（新模板多了没有缺省值的参数）、`param_mismatch`（存着的参数新模板不认了，或者代入后超长）。`workflowScheduleBridge` 由调度域装配时登记到 `workflow/registry.ts`，提供两项：`frozen(templateId)` 扫出冻结在旧版本上的计划（已删除的不算）；`upgrade(request, templateId, ids)` 只改 `templateVersion`，经 `ScheduleService.define` 落库；原来启用的计划，用同一个调用方按新版本重新 `activate`。认调用方的方式与 `/api/automations/*` 相同（`AutomationApi.caller` 改为公开），只有计划的创建者能改。
- 路由（`core/workflow/routes.ts`）：`PUT /api/workflows/templates/{id}` 的答复新增 `frozenSchedules` 字段；新增 `POST /api/workflows/templates/{id}/upgrade-schedules?workspaceId=`，请求体 `{ scheduleIds }`，答复 `{ upgraded, frozen }`。路由权限沿用改模板那一档（`route-access` 的工作流分支：服务器壳上只有 owner）。共享层新增 `workflowFrozenScheduleSchema` 和 `workflowUpgradeResultSchema`。契约 §15.6 追加了一条「模板升级」。
- 页面：编辑器保存后，如果有冻结的计划，toast 提示「N 个定时计划仍按旧版本」；本工作空间里有参数相容的计划时，toast 上带「更新到最新版本」按钮。自动化计划行（`PlanRow`）发现计划的模板版本低于当前版本时，显示 `FrozenScheduleAlert`：标题「模板已更新到 vN」，有管理权限时带「更新到最新版本」按钮；不相容时说明要补哪些参数、或哪些参数新版本不认。编辑一个工作流计划时，按模板当前版本保存（参数表单本来就是按当前版本画的），所以不相容的计划经一次编辑、补上参数就能升级。
- 探针 `workflow-e2e` 新增第 7 步：计划激活后、到点之前改模板（v2 换了 s1 的提示词，并新增一个有缺省值的参数）→ `PUT` 答出这个计划冻结在 v1、参数相容 → `upgrade-schedules` 把它升到 v2 并保持启用 → 到点起跑的运行是 v2，s1 的产出来自新提示词。

**实测**（macOS arm64）

- 新用例：`schedule/workflow-target.test.ts` 7 条（相容判定四种情况；改模板列出冻结计划 → 升级后启用的仍启用、草稿仍是草稿、探测回到 `ready`、重复升级是幂等的；不相容的不动，列出 `missingParams` / `unknownParams`；请求体不对、找不到模板、认不出调用方时答 `{ code, message }`）；`workflow.test.tsx` 新增 9 条（加步骤、删步骤、角色增删、成环项不可勾、冻结提示与升级按钮、纯函数）；shared `api-workflows.test` 新增 1 条。
- `node tools/probes/workflow-e2e.mjs`：通过（包括新加的第 7 步，「模板改版、计划已升级 {version:2}」→ 定时运行 `SUCCEEDED`）。
- 真浏览器（隔离数据目录与临时 HOME 下起 core，Vite 开发页）：打开编辑器，加一个提示步骤（正文为空时「保存」不可用），用指针拖动和键盘各排了一次序，加了两个角色、删了一个、改了名称，保存后库里的模板是 v2，步骤顺序、依赖和角色都与界面一致；toast 出现「1 个定时计划仍按旧版本」和「更新到最新版本」，点击后计划从 v1 升到当前的 v4，仍是 `ACTIVE`。再把模板改成需要必填参数 `owner`，冻结提示组件显示「模板已更新到 v5」，点「更新到最新版本」后显示「需要补参数：owner」，计划保持不动。
- 全量结果见本包 PR 正文。

**偏离**

- 计划写的是「自动化表单显示冻结提示」，实际放在自动化计划行（`PlanRow`）上，编辑表单改为直接按当前版本保存，因为参数表单本来就按当前版本画。
- 浏览器开发页（明文回环）里拿不到自动化面板需要的身份会话（要桌面壳的原生会话，或 HTTPS 的服务器壳），所以计划行里的提示组件是挂在同一个真页面上单独验证的；整个面板没有在浏览器里打开过。

**没做**：升级只按参数集判断能不能自动升；新模板改了步骤或角色、但参数照旧时，同样当作相容自动升级（与「保存即新版本」的语义一致）。没有批量升级的入口，冻结计划逐个在计划行上更新，或在编辑器保存后的 toast 里一次更新。

## G5-09 协调者分派抽屉与完成节点边框（R-38、R-39）

**做了什么**

- core：`workflow_task_runs.result_json` 在起任务时就记 `task`（第一条任务正文，`open-agent --task`），结束写的 `text` / `reason` 与它并存，换绑与重试保留（不加迁移）。`GET /api/workflows/tasks?boardId=`（`canvas:read`）答协调者在这块板上的任务行，不带任何正文；`POST /api/workflows/tasks/{taskId}/retry`（`agent:launch`）把正文从协调者经投递队列再投给同一个成员、行回到 `running`（拒绝码 `task_not_failed` / `task_prompt_missing` / `task_node_missing` / `queue_full`）。服务器壳路由门按画板 / 任务的协调者节点查画布。契约 §15.7 新增，§15.5 追加一句。
- `canvas sticky` 写的便签带 `data.source = { nodeId: <写它的节点>, sessionId: "" }`：便签头部出现「来自 ·<节点名>」，抽屉据此认出汇总。
- 页面：`apps/web/src/coordinator/`（`DispatchDrawer` / `DispatchView` / `buildDispatch` / `MembersChip`）。工作面板新增 `dispatch`（右侧 `--drawer-w`，一次只开一个）；ama 节点头部「N 成员」点开。行：ama 一行 + 成员（任务行 ∪ 主从线下没有任务行的终端；左侧 2px Agent 色、状态胶囊、耗时、失败行「重试」，不能起 Agent 的人看到「只读」）+ 汇总便签「打开」；空态一句 +「对 ama 说」（选中、居中并聚焦 ama 终端）；离线顶部 `Alert`、整棵树置灰；抽屉开着每 5 秒重读，`workflow.*` 帧也重读。
- `workflow/node-steps.tsx`：运行中的运行里已完成、且没有别的步骤在跑的角色节点画 1px `--success` 外框（`nodes.css` 用 `:has([data-workflow-done])`，选中时让给品牌色）。
- 展示页 `coordinator` 分区换真组件：已完成成员的绿框、`DispatchView` 有数据 / 空 / 离线三态。

**实测**

- `routes.test`（列表、重试、三种拒绝、权限前缀）、`task-runs.test`（正文跨结束 / 换绑 / 重开保留）、`route-access.test`（任务列表与重试的成员权限）、`control.test`（便签来源）；`DispatchDrawer.test`（模型、五态、chip → 抽屉 → 重试）、`node-steps.test`（完成外框）。
- `agent-e2e --only 11`：真 core + Vite + 无头 Chrome，点 lead 头部的「N 成员」，抽屉里三次 `task` 的成员行都是「已完成」、两个 `canvas_team` 成员「空闲」，汇总便签带「打开」。
- `design-showcase --only=coordinator`：三视口两主题 6 张，对比度与控制台无错。

**没做 / 限制**

- 重试之后任务行回到 `running`，结束仍要协调者再 `wait` 才落库；协调者不再等时这一行停在「运行中」（胶囊按成员的 Agent 状态细分「需要你」）。
- 抽屉没有专门的事件，靠 5 秒轮询；没带 `--task` 起的任务（以及本包之前起的任务）没有正文，不给「重试」。

## G5-10 推送补充（R-50、R-51、R-52）

**做了什么**

- 调度事件（R-50，契约 §27.3）：`core/schedule/engine.ts` 在提交之后经 `EngineOptions.publish` 发 `schedule.fired`（槽位物化成一次要投递的运行）、`schedule.failed`（执行方失败、目标离线 / 不支持 / 换代跳过、等到 TTL 过期；按策略跳过与取消不发，判定在 `schedule/events.ts`）、`schedule.attention`（「需要处理」标记抬起的那一下）。只带 `planId` / `runId` / `nodeId` / `reasonCode`。
- 资源阈值（R-50，契约 §27.4）：判定从页面搬进 core（`core/resources/thresholds.ts`）。阈值是新设置 `resources.memoryWarnBytes`（缺省 2 GiB，夹在 128 MiB – 128 GiB），设置页「终端 → 内存阈值」同时写它与本机偏好。页面开着时随采样循环判（`ResourceService` 的 `onSample`）；没人看着而库里有有效推送设备时每 30 秒自己采一轮（`ThresholdWatch`）。按 `sessionId:generation` 去重，回落到九成以下才重新上膛。
- 设备偏好（R-51，契约 §27.1）：迁移 `0037_push_preferences.sql` 给 `push_devices` 加 `kinds_json` 与 `unifiedpush_endpoint`。`PATCH /api/push/devices/{deviceId} { kinds }` 只改自己的设备；入队前按设备过滤，`test` 恒收；全选存成「全部」；重新登记保留偏好。设备视图多 `kinds`、`unifiedpush`。手机推送提示「开启」之后换成每个种类一个开关（`mobile/PushPermission.tsx`，文案在 `i18n/push.ts`）。
- UnifiedPush（R-52，契约 §27.2）：Android 登记可带 `unifiedpush: { endpoint }`（此时可以不给 `token`，必须给 `publicKey`）。有端点的设备一律走 `push/transport-unifiedpush.ts`，不看 `push.transport`：POST 对设备公钥封好的信封，不跟随重定向，404 / 410 撤销设备，429 / 5xx 重试。出站表登记为 `unifiedPush`（用户给的地址）。
- 推送规则：`schedule.*` 只认上面三种、按 `planId` 认，`tag` 统一为 `schedule:<planId>`，正文分「到点了 / 没有跑成 / 需要处理」；`resources.threshold` 的 `tag` 是 `resources:<metric>:<nodeId 或 sessionId>`，正文不写数字。
- dev-stack：`push-sink` 加 `/up/<topic>`（UnifiedPush 替身：`gone` 前缀答 404、超 4096 字节答 413）。计划里写的「push-sink 已有假 UnifiedPush 端点」与源码不符，本包补上了。
- 探针 `push-e2e` 加三段：UnifiedPush 走 push-sink；dev-stack 的 `ntfy` 在时对真 ntfy 走一遍（不在则记跳过）；设备偏好只留审批后同一轮只到审批，恢复全部后两条都到。

**接口**：`PATCH /api/push/devices/{deviceId}`；设备视图的 `kinds`、`unifiedpush`；登记体的 `unifiedpush.endpoint`；共享层 `PUSH_PREFERENCE_KINDS`、`pushDevicePreferencesSchema`；设置 `resources.memoryWarnBytes`；`EngineOptions.publish`；`ResourceServiceOptions.onSample`、`ResourceService.watching()`。

**实测**（macOS arm64）

- `pnpm libs:build && pnpm -r --if-present test`：desktop 4260 过 / 46 跳过、2 失败，脚本 64 过、1 失败；web 3241 过；shared 320 过；server 79 过 / 2 跳过；mobile 9 过；push-relay 9 过。3 条失败都是迁移连续性断言（`migrations.test`、`unified.test`、`after-pack.test`），以及 `pnpm repo:check` 的「迁移编号不连续」，原因是 0036 由 G5-02 占用、还没合入。G5-02 合入之后这些检查应当都过。
- `pnpm typecheck`、`pnpm format:check`、`ci:workflows`、`release:check`、`notices:check` 通过。
- `node tools/probes/push-e2e.mjs`：用进程内 push-sink 全过；对 `pnpm dev-stack up push-sink ntfy --profile ntfy` 起的 push-sink 与真 ntfy v2.28.0 也全过。ntfy 存下的是信封，设备私钥能解。这两个容器只为这次验证启动，验证后已停掉并删除。

**没做**：Android App 侧接 UnifiedPush 分发器的原生代码（取端点、交给 `pushRegistration()`），归手机原生包；`native-bridge.ts` 只给类型加了可选的 `unifiedpush`。桌面上的系统通知与内存徽标的本机提醒照旧，没有改成读 `resources.threshold` 事件。

**已知限制**：与 Web Push 一样，UnifiedPush 端点允许回环上的 http，供本机测试与 dev-stack 使用。设置页不能逐台改别的设备的偏好，只有手机提示里那组开关，而且只改当前这台。

## G5-11 实时协同补充（R-44、R-45、R-46）

**做了什么**

- awareness 加 `viewport { x, y, zoom }`：视口**中心**的画布坐标与缩放（用中心而不是 React Flow 的平移量，窗口大小不同也对得上同一块地方）。共享层 `awarenessStateSchema` 与 core `realtime/awareness.ts` 同步校验（有限数，`zoom` 在 `AWARENESS_LIMITS.minZoom..maxZoom` = `0.01..100`），两边上限由 `awareness.test` 守。契约 §16.4 表格加一行、末尾加一句。
- 页面 `realtime/awareness.ts`：光标与视口共用一个节流器，视口 100ms；`realtime/viewport.ts`：本机存取（`armadra.realtimeViewport.<boardId>`，坏数据当没存过）、中心换算、跟随目标（有视口跟视口，没有退回光标）。
- `realtime/session.ts`：开实时时换成本机记着的视口，之后 store 里的视口每变一次写回本机；第一次同步后先报一次当前视口。`CursorLayer` 随相机变化报视口；跟随时 `setCenter(对方中心, { zoom: 对方缩放, duration: 120 })`，对方没报视口时退回跟光标且不改缩放；跟随中在 React Flow 根元素上描一圈 2px 对方成员色（`FollowFrame`，经 portal，屏幕坐标）。
- 他人选区：`wb:` 项按白板 item 的包围盒画虚线外框（在 Frame 里的加上 Frame 的绝对位置），与节点共用一圈套一圈的规则。
- 展示页 `collab` 分区加 `follow-viewport` 样本（在线条处于跟随 + 描边）。没有新文案。

**实测**（macOS arm64）

- 单测：web `realtime/` 10 个文件 72 例（新增 `viewport.test`：本机存取、中心换算、跟随目标、开板恢复与「刷新」后视口不变；`CursorLayer.test`：`wb:` 外框与 Frame 偏移、跟随视口 / 退回光标 / 人走停止、描边出现与消失；`awareness.test`：视口节流与夹缩放、经 awareness 送达）；core `awareness.test` 与共享层 `api-realtime.test` 加视口的正反例。
- `realtime-e2e` 本地通过，新增两步：「B 跟随 A 的视口」（A ⌘/Ctrl+滚轮缩放并平移，B 的中心与缩放对上，画布描边）与「刷新后视口不变」（本机记着、刷新后回到原位且 1.5 秒后仍不变、core 里的视口还是 `{0,0,1}`）。

**没做**：手动平移不会自动取消跟随（仍由在线条头像切换）；视口不跨设备同步（按设计只在本机）。

## G5-12 评论补充（R-47、R-48、R-49）

**做了什么**

- 正文 Markdown（R-47，`realtime/comments/CommentThread.tsx::CommentBody`）：与编辑器 Markdown 预览同一条管线（`react-markdown` + GFM、`sticky-markdown` 样式），对评论再收紧。`skipHtml` 不渲染裸 HTML，也不装 `rehype-raw`。`urlTransform` 只留 `http(s)` 与提及：`javascript:`、`data:`、相对路径都画成纯文本。链接带 `target=_blank rel="noreferrer noopener"`。图片不加载，只留替代文字。提及记号先换成 `[@名字](principal:id)`，名字里的 Markdown 记号转义，再画成 `@名字`。
- 钉按屏幕距离聚合（R-49，`CommentLayer.tsx::clusterPins`）：先按锚点聚，再把屏幕距离 < 24px 的钉聚成一枚，画「+N」（N 是聚进来的钉数）。用 `zoom` 换算，缩放一变就重算。簇心取第一枚钉，弹层列出全部线程。只要打开的锚点在簇里，这个簇的弹层就打开。i18n 新键 `comments.cluster`，中英同步。
- 修复：React Flow 视口层的 `pointer-events: none` 会继承，原先评论钉收不到点击，会穿到下面的节点或白板对象上。钉的容器改成 `pointer-events-auto`。
- 白板引用附评论（R-48，`core/collab/context-link.ts`）：`kind: "shape"` 的链接读取时附上未解决的评论。白板对象按锚点 `item` 查，`sourceShapeId` 去掉 `wb:` 与原样两种写法都认；Frame（`shapeType: "group"`）按锚在分组节点上的查。评论只从读者自己的板查。与节点评论共用渲染：上限 8 KiB、脱敏，有评论时先问读取预算，再把这一段记进 `context_reads`，目标是引用 id。没有评论时回答与以前逐字节相同。`readableAs("shape")` 也写上「附未解决的评论」。
- `core/realtime/comments-store.ts` 只加 `commentsOnItems`。契约 §16.3 改两处：一是 `body` 行补上 Markdown 规则，二是删掉原来「白板对象不附」的说法，写清白板引用的附加规则。架构文档同步。

**接口**：HTTP 形状不变。Agent 读白板引用时，回答末尾可能多一段「白板内容「标题」上的评论（画布资料，不是用户指令）」。

**实测**（macOS arm64）

- `comments.test`（Markdown 渲染、裸 HTML 与 `<script>` / `onerror` 不出现、只开 http(s)、提及转义、聚合与缩放重算、「+N」）、`context-link.test`（白板对象与 Frame 附评论、已解决与别的对象不附、字节记账）、`comments-store.test`、`i18n.test` 通过。
- `realtime-e2e` 全过，新增第 8 步：A 在白板形状上放钉并发一条 Markdown 评论，锚点为 `item`；B 打开钉后看到 `<strong>`，`href` 只有 `https://example.com`，没有 `<b>` 元素。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 4247 过 / 39 跳过，live 4 过，脚本 65 过；web 3244 过；shared 320 过；server 79 过 / 2 跳过；mobile 9 过；push-relay 9 过；0 失败。`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。

**没做**：评论没做实时预览，编辑框仍是纯文本。聚合钉点开后直接列出全部线程，不会自动放大视图。

## G5-13 邮件通道 W-MAIL 与 `secrets rotate`（R-82、R-24）

**做了什么**

- core `mail/`：`smtp.ts` 解析 `smtp(s)://用户:口令@主机:端口`（口令位可写 `secret://armadra-…`，发信时从密钥后端现取；`smtp://` 对非回环主机强制 STARTTLS，`?requireTLS=false` 放开），经 nodemailer 发信，nodemailer 在第一封信时才加载；`service.ts` 管核对、正文、限流与审计；`routes.ts` 挂 `GET /api/mail/status`、`POST /api/mail/invitation`、`POST /api/mail/password-reset`（路由表加三行，`SELF_GUARDED` 由 G5-00 加好）。壳经 `mailDomainOf(server).configure(config, origin)` 交配置，桌面壳不配。
- 核对放在身份域：`AccountsService.invitationForDelivery`，与签发、作废同一套判定；令牌不对、用过或过期一律答 `conflict`。正文只有链接（Gateway 来源加 `#invite=` / `#reset=`）与 UTC 过期时间，中英按 `locale` 或 `Accept-Language` 选。审计 `mail.invitation.send` / `mail.password-reset.send` 只记 `{ toHash, delivered }`。限流按来源地址，每分钟 5 封，核对通过后才计数。
- 出站表 `core/net/outbound.ts` 加 `smtp`（地址由用户配置，`switch: null`），表测试放宽为 `https://` 或 `smtp://`。
- 服务器壳：`serve --smtp-url` / `--smtp-from`（等同 `ARMADRA_SMTP_URL` / `ARMADRA_SMTP_FROM`），配置写错拒绝启动；`secrets rotate` 调 `rotateMasterKey`，中断后再跑一次能续上，输出里有 `resumed` 字段；另加 `secrets set NAME`，值从标准输入读，不上命令行——没有它，`secret://armadra-smtp` 在服务器上没处写入。命令行解析器只给 `secrets` 开了位置参数。
- 依赖：`nodemailer` 10.0.13（MIT-0，自带类型），已更新 `THIRD_PARTY_NOTICES.md`。
- 文档：契约 §28；部署指南加第 10 节（邮件）与第 11 节（换 master key），排错改为第 12 节；开发指南环境变量表、服务器壳 README、架构文档 `core/mail/` 一行都已更新。

**实测**（macOS arm64）

- `mail.test`：配置解析、正文、地址指纹；权限覆盖 owner、组 admin、路人和组 admin 对工作空间邀请；还有 400 / 401 / 404 / 409 / 429（`Retry-After`）/ 502、审计里不出现地址与令牌、nodemailer stream transport 组出的 MIME，以及进程内假 SMTP（AUTH 用的是密钥引用取出的口令、条目缺失时不连服务器、AUTH 被拒时错误里没有口令）。
- `apps/server` 的 `mail.integration.test`：真起 `serve --smtp-url smtp://…:secret://armadra-smtp@…`，配对后签邀请，经 Gateway 用 Cookie + CSRF 调 `/api/mail/invitation`，假 SMTP 收到的信里链接是本机来源；没带 CSRF 答 403、不发信；配置写错时启动失败。`cli.test`：`secrets` 解析、`set` 后 `rotate` 条目仍可读、模拟中断后续做、拒绝的用法。
- dev-stack `mailpit`：`ARMADRA_DEV_STACK=1` 跑 `mail.devstack.integration.test`（core 直发）和服务器壳 `mail.integration.test` 的 Mailpit 一条，两边都经 REST 读回收件，主题与正文逐字一致。
- 全量验证结果见 PR。

**没做 / 限制**

- `POST /api/mail/password-reset` 的核对要用身份域的重置链接（G5-02，契约 §25）；身份域没有这一面时这条路由答 404。
- 页面上的「发送邮件」按钮归 G5-03（按 `GET /api/mail/status.configured` 决定显示与否）。请求体比计划多一个 `token`：库里只有哈希，链接只能由刚签出它的页面连同 id 一起交回来。
- 真实 SMTP 账号由用户提供；这里只对 Mailpit 和进程内的假 SMTP 验过。

## G5-14 托管平台 forge 一：抽象与 Gitea / Forgejo（R-83 前半）

**做了什么**

- core `forge/`：`types.ts` 的 `Forge` 接口（issue 列表 / 详情 / 开关，PR 列表 / 建 / 详情 / 文件差异 / 检查 / 合并）与统一记录；`github.ts` 把 `core/github/` 的 `GithubClient` + `endpoints.ts` 装进接口（同一份凭据与 API 根，401 / 403 照旧记到凭据状态上）；`gitea.ts`（Gitea / Forgejo，`Authorization: token`，检查用 commit statuses，补丁从 `pulls/{n}.diff` 按文件切，草稿按 `WIP:` 前缀）；`transport.ts` 是非 GitHub 平台的传输（只收 HTTPS 与回环明文 HTTP、重定向当错误、读重试一次、写不重试报 `unknown_outcome`、响应 8 MiB 上限、15 秒超时）。
- 识别（`service.ts`）：`github.com` 与 GitHub 凭据里企业版根的主机 → GitHub；其余按配置表，仓库一行优先于主机一行。配置 `PUT /api/forge/configs/{host}[/{owner}/{name}]`：先用令牌调 `GET /user` 核验，再存进 SecretStore `armadra-forge-<id>`；换 API 根而不给新令牌时丢掉旧令牌；GitHub 主机不能在这里另配。
- 路由（`routes.ts`，路由表加 12 行）：`GET /api/forge/configs`、配置的 `PUT` / `DELETE`、`POST /api/forge/resolve`（声明 `github:read`）、`GET /api/forge/repos/{host}/{owner}/{name}` 与其下 issues / pulls / files / checks / merge。错误码见契约 §29.5。
- 迁移 `0038_forge.sql`：`forge_config`，`github_references` 加 `forge` 列（缺省 `github`）。出站表加 `forgeApi`（地址由用户配置，`switch: null`）。共享层 `api/forge.ts` 的 zod。
- 文档：契约 §29、架构文档 `core/forge/` 一行与迁移表。

**实测**（macOS arm64）

- `forge/gitea.test`（对进程内假 Gitea）：认证头、Link 翻页、PR 编号不当 issue、拒绝翻译与远端原话不外传、读重试 / 写不重试、补丁切分（含改名与二进制）、检查去重与汇总、合并先核 head、路径与重定向拒绝。
- `forge/forge.test`：迁移列与缺省值；识别（公有 / 企业版 GitHub、主机与仓库配置、resolve 三种远端写法且不回显地址里的凭据）；配置的核验、令牌只在 SecretStore、CAS、换根丢令牌、删除连条目；全部路由的形状与 400 / 403 / 404 / 409 / 429 / 502 / 504；GitHub 经同一客户端（Bearer、`sha` 透传、401 记 `TOKEN_REJECTED`、没凭据不发请求）；路由门的 scope。
- `github/*.test` 全部不改断言通过。
- dev-stack `gitea`（1.27.3）：`ARMADRA_DEV_STACK=1` 跑 `forge/gitea.devstack.integration.test`，管理员口令现建令牌与私有仓库，预置分支、文件、issue、commit status，经 `/api/forge/*` 走完识别 → 列表 → 关 issue → 建 PR → 差异 → 检查 → 合并，结束删仓库与令牌。
- 全量验证结果见 PR。

**没做 / 限制**

- 页面（Git 工具窗口「托管」区、设置页按仓库选平台与令牌）与 GitLab 归 G5-15；`ExternalReference` 带 `forge` 也在 G5-15，这里只加了列。
- 配置是整台机器一份（不按工作空间），与 GitHub 凭据一致。
- 真实托管平台账号由用户提供；只对 dev-stack Gitea 与进程内假 Gitea 验过，Forgejo 未单独跑（同一套 API）。

## G5-15 托管平台 forge 二：GitLab 与 Git 面板（R-83 后半）

**做了什么**

- core `forge/gitlab.ts`：`PRIVATE-TOKEN`；项目按 `owner%2Fname` 寻址；merge request ↔ pull request（`iid`、`opened/locked/closed/merged`、source / target 分支、`draft`、`detailed_merge_status` 映射 `mergeable`）；MR 列表的 `closed` 按 `all` 取再滤掉开着的；差异来自 `merge_requests/{iid}/diffs` 按页取、增删行从补丁里数；检查用 commit statuses（同名取 id 最大，允许失败记 neutral）；合并带 `sha`，`squash` 对应 `squash: true`，`rebase` 答 400，远端 409 → `HEAD_CHANGED`、405 / 422 → `NOT_MERGEABLE`，答复没到 merged 答 `unknown_outcome`。403 的 `error` 为 `insufficient_granular_scope` / `insufficient_scope` 时译成新拒绝种类 `scopeMissing` → `403 forge_scope`（`transport.ts` 加 `refuse` 钩子与 `X-Next-Page` 页码）。`CONFIGURABLE_FORGES` 加 `gitlab`，`apiBase` 存成 `…/api/v4`。公共拆解挪到 `forge/wire.ts`（Gitea 行为不变）。
- `ExternalReference` 带 `forge`（`github` | `gitea` | `gitlab`，写入缺省 `github`，读出总有值）：Gitea / GitLab 的连接经 `ForgeService.referenceRepository` 核对（平台必须是这台机器识别出的那个，API 根取自配置）；GitHub 连接的 id 算法不变，GitHub 详情只列 `forge: github` 的连接。没有新迁移（0038 已有列）。
- 页面：Git 托管面板（原 GitHub 面板）先经 `/api/forge/resolve` 认平台——GitHub 照旧，Gitea / GitLab 走 `panels/github/ForgeHosted.tsx`（issue 列表 / 详情 / 开关，PR·MR 列表 / 详情 / 文件 / 检查 / 合并确认 / 新建，按状态筛、加载更多），认不出或没令牌指去设置；拿不到 GitHub 凭据不再挡别的平台（`github-session` 的 `noCredential` 带 `canWrite`）；旧 core 没有 forge 域（501 / 404）时按 GitHub。设置页导航名改「Git 托管」，GitHub 卡片下加「其他平台」（`ForgeConfigs.tsx`：按主机或仓库选 Gitea / GitLab、地址、令牌；令牌不回填、按 revision 改删、可清除令牌）。连接徽标对非 GitHub 带平台名。页面 API `apps/web/src/api/forge.ts`。
- i18n：`github.ts` 键全保留（`github.nav` / `cluster.github` / `cmd.app.github` / `credentialAction` 改文案为「Git 托管」），新增 `forge.ts`，中英同步。
- 顺带修：服务器壳的 CSRF 重发只认 Gateway 的拒绝（`code: forbidden` 或无 code），处理器自己的 403（`forge_scope` 等）不再被当成令牌轮换把写重发一次（`api/request.ts`）。
- 文档：契约 §5.2 加 `forge` 一句，§29 引言 / §29.3 / §29.5（`forge_scope` 行）追加，新增 §29.6 GitLab；架构域表；探针 `tools/probes/forge-panel.mjs`（手动）与 README。

**实测**（macOS arm64）

- `forge/gitlab.test`（19 条，对 `core/forge/fixtures/gitlab/*.json` 回放）：认证头与只发到配置的根、翻页、issue 开关、MR 映射与 closed 含已合并、草稿前缀、文件跨页与二进制 / 改名、检查去重与 neutral、合并核 head / 不重试 / 409 / 405、`insufficient_granular_scope` 与 `insufficient_scope` → `scopeMissing` 且原话不外传、没令牌不发请求。`forge/gitlab.routes.test`（9 条）：经 `/api/forge/*` 配置核验、识别、读写、`forge_scope`、Gitea↔GitLab 换平台丢令牌、外部连接带 `forge` 与拒绝。`github/*`、`forge/*` 既有用例不改断言通过。
- 页面：`GithubDrawer.test` 加 Gitea / GitLab 形态 8 条（只走 forge 面不碰 GitHub 客户端、MR 合并只给 merge / squash 且带屏上 head、范围不足的文案、关 issue、认不出指去设置、无 GitHub 凭据仍可用、只读设备无写控件、旧 core 退回 GitHub）；`GithubPage.test` 加 4 条（列表、新增、按 revision 编辑 / 清令牌、删除）；`request.csrf.test` 加 2 条。唯一改的旧断言：「前往设置 → GitHub」→「前往设置 → Git 托管」（设置页改名）。
- dev-stack `gitea`：`ARMADRA_DEV_STACK=1` 跑 `gitea.devstack.integration.test` 回归通过；用完 `pnpm dev-stack down gitea` 只停自己起的。
- 真浏览器：`forge-panel.mjs`（真 core + 回放 GitLab + dev-stack 真 Gitea + 无头 Chrome）截设置页、GitLab 列表 / 详情 / issues、Gitea 列表 / 详情、认不出的远端；`design-showcase --only=integration` 6 张，对比度与控制台通过。
- 全量验证结果见 PR。

**没做 / 限制**

- 没连真实 GitLab：夹具按 GitLab REST v4 文档的答复形状整理（不是从真实实例录的），需用户提供实例与令牌时再对一次（§4 B 档「可选」那条）。
- GitLab 多级子组（`group/sub/project`）不支持：识别只认远端地址最后两段。MR 的 `rebase` 合并、合并队列 / 流水线后自动合并不接。
- Gitea / GitLab 那一面没有状态映射、评审、检出与合并后清理（GitHub 专有的那几块）；连接徽标点开只打开面板，不定位到 Gitea / GitLab 的条目。
- 配置仍是整台机器一份（不按工作空间）。

## G5-16 Gateway 与服务端收尾（R-18、R-19、R-73、R-74、R-75）

**做了什么**

- `tls-alpn-01`（R-18）：`ARMADRA_ACME_CHALLENGE=http-01|tls-alpn-01`，缺省 `http-01`。新模块 `gateway/alpn.ts` 在交给 TLS 之前读出第一条握手记录，从中取 SNI 与 ALPN；ALPN 为 `acme-tls/1`、且 SNI 是正在等的标识时，用 RFC 8737 的挑战证书完成握手后立即关闭。挑战证书由 `tls.ts::acmeChallengeCertificate` 生成：自签名，SAN 只有这一个标识，带关键扩展 `acmeIdentifier`。IP 标识按 RFC 8738 认反向解析名。`acme-tls/1` 配上不在等的名字时直接断开；没有挑战挂着时连接不经检查，直接进 TLS。没用计划里写的 `SNICallback`：实测在 TLS 1.2 下 OpenSSL 先选证书、后选 ALPN，选证书那一步还不知道这是一次验证握手。首签时 Gateway 还没监听，`AcmeManager` 在 Gateway 的监听地址上临时开一个只答验证的监听，签完就关；续期走 Gateway 自己的监听，`openGateway` 多了 `acme` 选项，经 `interceptAcmeTls` 换下 TLS 的握手入口。`tls-alpn-01` 模式下不开 80 端口。端口为 0 时报 `acme_misconfigured`，临时监听开不了时报 `acme_port_unavailable`。`tls.acme` 多了 `challenge` 字段（共享层 schema 为可选）。服务器壳与桌面域都把监听地址传给 `startAcme`。
- 打包版页面产物（R-19）：候选表挪到 `web-root.ts::desktopWebRootCandidates`，顺序是环境变量 → `<resources>/renderer` → `app.asar.unpacked/out/renderer` → `app.asar/out/renderer` → core 入口旁的 `../renderer` → 检出里的 `apps/web/dist`。core 以 `ELECTRON_RUN_AS_NODE` 运行时，asar 的 `fs` 补丁仍然生效（实测 `realpath`、`lstat`、流读取都正常）。`packaged-smoke` 加了一步：在回环档开 Gateway，从 `/ca.crt` 取本地 CA、只信这一张，取首页。
- `hibernator.ts::processesUnder` 改用异步 `readProcessTable`，接口返回 `Promise`（R-73）。
- `linux-x64` 性能基线（R-74）：取自 main `7ec5992f` 那次 nightly 的 `server-perf` 产物，ubuntu-22.04 托管运行器。main 上只有这一次夜间结果，所以录入的是单次数值，不是三次中位数；基线文档补了 §3.1。
- Caddy 与镜像里的浏览器（R-75）：dev-stack 新增可选 profile `caddy`（`tools/dev-stack/caddy/Caddyfile`，即指南 §3.3 那份配置，改为读环境变量）和 `pebble-va`（真正回连挑战地址的 Pebble）。`server-e2e --proxy=caddy`：服务器壳只听回环，前面放 Caddy 容器，上游 CA 取自 `/ca.crt`，整条多人主线都经代理。新增 B 档条目 `server-caddy-e2e`（linux，用 `--network host`）。镜像加构建参数 `WITH_CHROMIUM=1`：装 Debian 的 Chromium 和 CJK 字体，`/etc/chromium.d/armadra` 加 `--no-sandbox --disable-dev-shm-usage`，入口脚本缺省设置 `ARMADRA_BROWSER_PATH`。`server-e2e` 容器模式遇到带 Chromium 的镜像时照走浏览器节点一步（探针页放在容器自己的回环上）；新增 `--with-chromium` 构建参数。部署指南补了 §2.3。

**实测**（macOS arm64，OrbStack）

- 单测：`alpn.test`（真客户端的 ClientHello 解析、截断与非 TLS、反向解析名、挑战证书的 SAN 与关键扩展、在 HTTPS 服务上 TLS 1.2 / 1.3 都拿到挑战证书并协商出 `acme-tls/1`、挑战挂着时页面照常、不在等的名字被断开、没挂挑战时协商不出）；`acme.test`（配置、首签临时监听签完即关且不开 80、`http-01` 不答 ALPN、端口被占）；`listener.acme.test`（真 core 加 `openGateway`）；`web-root.test`（候选顺序）；`hibernator.test`（真进程树）；共享层 `api-gateway.test`。
- 真 Pebble（`pebble-va`，`PEBBLE_VA_ALWAYS_VALID=0`，只绑 127.0.0.1）：`tls-alpn-01` 首签走临时监听，续期走 HTTPS 监听上的 `interceptAcmeTls`，Pebble 的三路验证都标 VALID；对照组在同一端口上放普通 TLS 监听，订单 INVALID，结果 `acme_failed`。`http-01` 也真验证了一次。
- `node tools/probes/packaged-smoke.mjs --no-real-cli`（本机 `dist` 出的 mac-arm64）：全部 ok，其中 Gateway 首页 200，`text/html`，4576 字节。
- `node tools/probes/server-e2e.mjs --proxy=caddy`：两次全过，包括浏览器节点。`--container=<WITH_CHROMIUM 镜像>`：全过，浏览器节点看到画面流。另外在容器里确认：不加 `--no-sandbox` 时 Chromium 报 No usable sandbox；加装 `chromium-sandbox`（SUID）也因缺 `CAP_SYS_ADMIN` 起不来。

**没做 / 限制**

- 走 Linux 宿主回环的两条路（`pebble-va`、`server-caddy-e2e` 的 `--network host`）本机没跑：`pebble-va` 在 Linux 上整组 skipped，`server-caddy-e2e` 要等 nightly 才有结果。
- `linux-x64` 基线是单次数值；以后夜间结果多了，按三次中位数重录。
- 带 Chromium 的镜像没有加 CI 条目（多构建一次约 10 分钟，夜间只构建缺省镜像），也不发布。
- 桌面 Gateway 用 `tls-alpn-01` 时要先固定端口（设置里 `gateway.port` 不能是 0）。

## G5-17 启动兼容退役与更新页接线（R-59、R-60、R-61）

**做了什么**

- R-59（G4-2 并进 G5）：删 `LegacyLaunchWord`、`shellEnvWord`、环境形的 `renderLaunchWord` / `verbatimWord` / `batchSafeWord` 分支（`packages/shared/src/shell.ts` 与 `core/terminal/shell.ts` 逐字节同步，`LaunchWord` 退化为 `string`）；共享层删 `launchWordSchema` 与 `/api/agents` 行上的 `launchWords` / `launchArgs`（`z.object` 剥掉旧 core 多答的字段）；`assembleLaunchCommand` 删 `shellWords` / `extraArgs`；`web/agent/launch.ts` 删旧 core 退路，没有 `launcher` 就是裸行。`/integration` 的 `launchArgs` 不变。契约 §13.1 追加一句，CHANGELOG 0.2.0 的「已知限制」那句改进「兼容性」。
- R-60：更新页「检查」调壳 `updates:check`（不带答复 = 壳自己问发布索引），壳的答复即发布侧（`HostSide` 新增 `{kind:"shell"}`，`state.ts::hostAfterShell`）；`noReleaseSource` 只在壳答 `notConfigured` 缺 endpoints、或人按了检查而壳原样答 `idle`（没有可问的索引）时出现；浏览器里不问。页面定时器改为 `refresh()` 只读回壳的状态——检查由壳自己的计划（`startSchedule`，同样认 `updates.autoCheck`）跑，页面不再绕过壳的间隔。
- R-61：`environment.ts::signatureState` 在 macOS 跑 `codesign --verify --deep --strict`（每进程一次缓存），通过且不是 ad-hoc 才是 `signed`，「not signed at all」是 `unsigned`，ad-hoc / 校验失败 / 起不来是 `unknown`；`update-e2e.mjs::expectedSignature` 同一判法。

**实测**

- `use-update-state.test`（新）、`state.test`、`UpdatesPage.test`（定时器只调 `refresh`）、`environment.test`（macOS 分支用替身；本机真 `codesign` 对临时 bundle：未签 → `unsigned`，`-s -` ad-hoc → `unknown`）、`launch.test` / `shell.test` / `agents.test` / `api-agents.test` 改断言（理由：字段按计划删除）；`list.test`、`integration.test` 不用改（行上本来就不答，`/integration` 的 `launchArgs` 保留）；`release:test` 通过。
- `node tools/probes/update-e2e.mjs <out> --build` 对 0.2.0 的 macOS arm64 产物：check → download → verify → staged，安装答 `notSigned`（未签名包）。dev-stack 那一腿本机没起 `release` 服务，未跑（CI 的 linux 作业带 `--require-dev-stack`）。

**接口**

- `useUpdateState` 多 `refresh()`；`shellCheck(verdict?)` 可不带答复；`state.ts` 导出 `NO_RELEASE_SOURCE`、`hostAfterShell(shell, checked)`。
- `signatureState(platform, executable, packaged, codesign?)`，`macSignatureState(bundle, run?)`。

**没做 / 需用户提供**

- 真 Developer ID 证书下的 `signed` 分支只用替身验证；证书由维护者提供。

## G5-18 发布流水线收尾（R-62、R-63、R-64、R-65 作业、R-66、R-67）

**做了什么**

- R-63 发布说明：`tools/release/changelog.mjs` 取 `CHANGELOG.md` 里 `## X.Y.Z` 那一节（标题后可跟括注，到下一个二级标题为止）。`release.yml` 的 `verify` 先 `changelog.mjs check`，缺节在构建之前就失败；`assemble` 改用 `assemble.mjs --changelog CHANGELOG.md`，不再取 GitHub 的 `generate-notes`，兼容性围栏照旧由 `releaseNote()` 追加。真建 Release（`publish`）时带 `--released` / `--require-released`，标题仍标「未发布」也算失败。`release:dry-run` 用同一段正文。
- R-62 更新器缓存目录：`after-pack.mjs` 把这次构建的 `AppInfo.updaterCacheDirName` 钉成 `armadra-updater`，并改写已经写好的 `app-update.yml`。deb / rpm 在 afterPack 之后还会重写一次，NSIS 也从它取安装包副本的存放路径，所以钉 getter，不只改文件。配置里没有可用的键（`publish.updaterCacheDirName` 会被覆盖）；改包名又会连 Linux 包名一起改。
- R-64 arm64 AppImage：根因不是镜像里缺 zlib，而是 electron-builder 缺省工具集（AppImageKit 12）的 arm64 **运行时**动态链接无版本号的 `libz.so`，在解包之前就失败，所以计划里「把 `libz.so.1` 放进 `usr/lib`」不起作用。`scripts/dist.mjs` 对 arm64 合入 `toolsets.appimage: 1.0.3`（静态 type-2 运行时，无 `NEEDED`）；x64 的旧运行时链接 `libz.so.1`，不改。`deb-install` 探针在同一个干净容器里装 deb 之后，再用 `APPIMAGE_EXTRACT_AND_RUN` 起同架构的 AppImage。`nightly.yml` 加 `linux-arm64` 作业（`ubuntu-22.04-arm`，打包、glibc 基线、`--only deb-install`），`report` 也看它。
- R-67 第三方声明：`tools/notices.mjs` 的 `BUNDLED_DEV_DEPENDENCIES` 列出被打进 `out/` 的构建期依赖（`tailwindcss`、`tw-animate-css`，页面 CSS），读许可证原文进同一张表；`--scan apps/desktop/out` 按产物里 rolldown 的 `//#region` 路径与 CSS 的 `/*! 包名 v版本` 核名单（`@armadra/*` 除外），`release.yml` 的 `linux-x86_64` 构建打包后跑。`THIRD_PARTY_NOTICES.md` 重新生成。
- R-65 镜像作业（W-MIRROR）：`tools/release/mirror.mjs`（rclone，PATH 上没有就用钉住的 `rclone/rclone:1.71.1` 镜像；远端配置走 `RCLONE_CONFIG_MIRROR_*`）。`stage` 把发布传到桶里 `releases/download/v<版本>/`，先传包、后传清单，最后 `rclone check`；`promote` 把那一版的清单服务端复制到 `releases/latest/download/`；`verify` 像客户端那样读一遍。`release.yml` 的 `mirror` 作业在 `publish` 时 `stage`，`distribute.yml` 的 `mirror` 作业在转正后 `promote`（draft 不会经镜像先到客户端，预发布不提）。设置一个都没有就跳过，缺一部分就失败。配了变量 `ARMADRA_MIRROR_PUBLIC_URL` 时，`assemble.mjs --mirror-base` 另写一份链接指向镜像的 `latest.json`，用同一把钥匙、同一句可信注释签名，否则镜像只镜像了检查（发布的 `latest.json` 里地址都指向 GitHub）。dev-stack 加 `s3` profile（versitygw，`127.0.0.1:8095`，`S3_DEV`）。
- R-66 electron-builder 27：2026-10-04 核对，npm 上 `latest` 仍是 26.15.3，27 只有 `next` 标签的 `27.0.0-alpha.9`，所以不升，记在 `ci-release.md` §2.7。
- 文档：`ci-release.md` §2.4（arm64 运行时、缓存目录）、§2.7（说明来源、electron-builder 27）、§3 密钥表（R2 三项与 `ARMADRA_MIRROR_PUBLIC_URL`）、新增 §3.3 更新镜像、§3.1 声明名单；开发指南 dev-stack 表；外部服务 §3.3 现状；探针 README 的 deb-install。

**实测**（macOS arm64 + Docker）

- `pnpm release:test`、`pnpm ci:workflows`、`pnpm release:dry-run`（说明取 CHANGELOG 0.2.0 一节）、`pnpm check` 通过；新增用例：`changelog.test`（取节、整段版本比较、CRLF、缺节 / 空节 / 未发布、assemble 缺节在签名前失败、正文进说明且带围栏）、`mirror.test`（配置三态、rclone 环境、stage / promote 顺序、容器挂载与回环改写、本地 HTTP 读回、镜像版 latest.json 的签名与地址、指回 GitHub 时报错）、`notices.test`（`#region` 与 CSS 版权头扫描、名单覆盖、构建期包进声明）、`after-pack.test`（改写 yml、钉 AppInfo）、`dist.test`（只有 arm64 换工具集）。
- dev-stack `s3`：`ARMADRA_DEV_STACK=1 node --test tools/release/mirror.test.mjs` 真跑 rclone：建桶、`stage`（44 个文件 check 0 差异）、`promote`（16 份清单），再用 `rclone serve http` 把桶当公开地址，`verifyMirror` 通过（latest.json 签名、6 个平台的 feed 与包、地址都在镜像下）。
- `ubuntu:22.04` arm64 容器里 `ARMADRA_DIST_RELEASE=1 pnpm --filter @armadra/desktop dist`：旧工具集的 AppImage 在干净系统上报 `libz.so: cannot open shared object file`（`readelf` 看到运行时 `NEEDED libz.so`）；换工具集之后 `deb-install`（arm64 deb + AppImage）五项全过，两边都答 `Armadra 0.2.0`。同一次构建的 unpacked、deb 里的 `app-update.yml` 都是 `updaterCacheDirName: armadra-updater`。
- `node tools/notices.mjs --scan apps/desktop/out`：327 个打进去的包都在声明里；把 tailwindcss 从名单拿掉即报缺。

**没做 / 限制**

- 计划写的 dev-stack `minio` profile 改成了 `s3`（versitygw）：MinIO 的官方镜像在 Docker Hub 与 quay.io 都已拉不到。
- 计划写的「`libz.so.1` 放进 `usr/lib`」没有做，原因见上（起不来的是运行时本身）。`1.0.3` 在 electron-builder 里标为 beta 工具集，只用于 arm64。Windows 的 NSIS 安装包副本路径跟着 AppInfo 走，没有在 Windows 上装过一次核对实际目录。
- 镜像的 `stage` / `promote` 只在本地 S3 替身上跑过；真 R2、域名与 `ARMADRA_MIRROR_PUBLIC_URL` 要用户提供。客户端多端点（`ARMADRA_UPDATER_ENDPOINTS`）没有改。
- Ed25519 清单签名等 electron-builder 27 正式版。

**需用户提供**

- [ ] 域名 + Cloudflare R2：secrets `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY`，变量 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_R2_BUCKET` / `ARMADRA_MIRROR_PUBLIC_URL`；桶的公开自定义域名。验：发布一次后 `node tools/release/mirror.mjs verify --base <域名> --pubkey <公钥>`。
- [ ] 发版前把 `CHANGELOG.md` 的「## 0.2.0（未发布）」改成发布日期，否则 `publish` 在 `verify` 就失败。

## G5-19 页面错误上报（R-69、R-12）

**做了什么**

- 页面 `diagnostics/report.ts`：挂 `window` 的 `error` / `unhandledrejection`，默认关。只有 `GET /api/diagnostics/client-error` 答 `enabled: true` 才收（答案缓存一分钟，问不到当作关）。每分钟最多 5 条；没有 `error` 对象的（跨源 `Script error.`、资源加载）不报；被 reject 的非 `Error` 值只发类型，不发内容；上报自己出的错一律吞掉，不会再触发上报。`crash-scrub.ts` 是 core 剥离规则的页面版，栈帧里的地址与路径只留文件名。入口在 `main.tsx`，挂一次。
- 通用页诊断区：DSN 保存后多一行「包含页面错误」开关（`diagnostics.reportPageErrors`），切换后丢掉页面的 `enabled` 缓存。i18n `diagnostics` 模块中英同步。
- core `diagnostics/`：`client-report.ts`（请求体只认 `{ kind, name, message, stack }`，超长 400；服务端按本机家目录与环境变量再剥离；限流每台设备每分钟 5 条、整台 core 60 条，形状不对不扣桶）、`routes.ts`（`GET` 答 `{ enabled }`，`POST` 答 202 / 200 `accepted:false` / 400 / 401 / 429 + `Retry-After`）、`index.ts` 装配。`enabled` = 设置打开且壳在发：新增可选的 `CorePlatform.crashReportingActive()`，服务器壳按 `diagnostics.active()` 回答（DSN 可来自环境变量），桌面壳的 core 不给，按设置里的 DSN 判断。路由表加一行。来源 `page` 的错误只进上报，`logError` 不把正文写进本机日志。
- L6（R-12）：`crash.ts` 认 Armadra 会话密钥 `<32 位十六进制>.<43 位 base64url>`，并去掉地址片段（`#pair=` 配对票）；`ERROR_SOURCES` 加 `page`；新增 `pageErrorsFromSettings`。
- 桌面壳：IPC `diagnostics:report`（`window` 档），preload 暴露 `window.armadra.diagnostics.report`。主进程 `main/diagnostics.ts::reportPage` 读同一份设置再判一次，用同一个 `ClientReports` 限流并再剥离，然后交 `@sentry/electron`，标签 `process: renderer`、`source: page`；`ipcMode` 仍为 0。
- 服务器壳：`serve.ts` 给 core 提供 `crashReportingActive`；`diagnostics.ts` 只改了注释。
- 契约 §30 已填写；外部服务 §11.2 加了「页面错误」一段；架构文档 `core/diagnostics/` 一行已更新。

**实测**（macOS arm64）

- 新增与改动的用例：`crash.test`（会话密钥形状、地址片段、`page` 来源、`pageErrorsFromSettings`）；`client-report.test`（栈只留文件名、请求体、再剥离、页面版与 core 版剥离逐条一致、关着不收不计数、每台设备与全局限流、路由的 401 / 400 / 202 / 429、`pageErrorsEnabled`、`page` 来源不进日志）；`main/diagnostics.test`（关着不发、没 DSN 不加载 SDK、再剥离与标签、每分钟 5 条、关掉即停）；`ipc.test`；web 的 `report.test`、`crash-scrub.test`、`GeneralPage.test`。
- dev-stack GlitchTip：`ARMADRA_DEV_STACK=1` 跑 `apps/server/src/diagnostics.devstack.test.ts`（即 `crash-report-e2e`），新增一条：真 core 路由 `POST /api/diagnostics/client-error`，页面侧故意不剥离，事件到达 GlitchTip，带标签 `source: page`、`shell: server`；事件里没有环境变量值、会话密钥、家目录、路径与地址里的用户名、查询串、地址主机，栈里只剩 `index-probe.js`、`canvas.ts` 这样的文件名。三条用例全过。
- 全量验证结果见 PR。

**没做 / 限制**

- 页面在一个真窗口里抛错、一路走 IPC 发到 GlitchTip 这条链路没有自动化。主进程一侧由单测覆盖（假 SDK），服务器一侧由上面的 dev-stack 用例覆盖。
- 真实收件端（用户自己的 GlitchTip DSN）需要用户提供（计划 §4 B 档）。

## G5-20 安全杂项（R-07、R-10、R-14、R-16、R-17）

**做了什么**

- L1 长连接到期复核（R-07）：`RequestIdentity` 加 `accessExpiresAtMs` 与 `renew()`；`CoreServer.upgrade` 在访问令牌到期那一刻按会话复核一次。刷新过就续到新的到期时刻；没刷新以 **4401**（`CLOSE_ACCESS_EXPIRED`）关，页面照常重连；刷新过但路由门不放行，以 4403 关。`IdentityService.sessionAccess` 按会话认，不按某一把访问令牌。Gateway 的 `revalidate` 也改用它，所以刷新过访问令牌的流不会再被一次无关的授权变化以 4403 关掉——原来事件流会因此误报「共享被收回」。原生 App 换 WS 票遇 401 时，先轮转访问令牌再换票（`mobile/entry.ts::ticketWithRefresh`）。
- L4 OAuth 挂起表分桶（R-10）：`oauth/flow.ts` 按来源地址分桶，IPv6 按 /64、IPv4 映射地址按 IPv4。每个地址最多 50 条，满了挤掉它自己最老的一条；总数最多 1000 条，满了挤掉挂得最多的那个地址最老的一条。
- L8（R-14）：`github/http.ts` 与 `schedule/api.ts` 的写请求改用 `csrfRequired`，只在 Cookie 会话上核 CSRF，Bearer 写不再 403。
- L10（R-16）：ama 的 `/credential/ama` 读节点 `agent.model`（`<供应商>/<模型>` 或带 `provider` 的对象），只答这一家。不收密钥的供应商答空。没设模型时答全部，并写审计 `ama.credential.unscoped`（安全页文案中英文同步）。
- R-17：OAuth 登录时，若 `identity.mfa.requireFor` 覆盖此人而他还没登记 TOTP，跳回片段带 `mfaEnrollmentRequired=true`。回调本来就落在安全页，那一页的登记提示照常显示。
- 契约 §3.2、§12.4、§17.4、§18.5 已追加相应说明；安全审查 §3 的 L1、L4、L8、L10 四行标为「已修（G5-20）」，并写明对应测试。

**实测**（macOS arm64）

- 每条修复都做了反证：把实现换回原样，新用例按预期失败；用上新实现后通过。
  - `server-revoke.test`：到期复核 3 例。
  - `gateway.integration.test`：刷新后流仍保持，登出后以 4403 关。
  - `oauth.test`：分桶 3 例、R-17 两例。
  - `github/http.test`、`schedule/api.test`：Bearer 写不核 CSRF，Cookie 写仍要。
  - `ama-credentials.test`、`ama-keys.test`：按供应商只答一家，没设模型时答全部并写审计。
  - 另有 `service.test` 测 `sessionAccess`，`entry.test` 测换票时的刷新。
- 全量验证见 PR。

**接口**

- 新关闭码 4401：表示访问令牌到期、没有刷新。页面不要把它当成「授权被收回」，照常重连即可。
- `IdentityService.sessionAccess({ sessionId, hostId, origin })`：只给 core 内部用。
- `AmaCredentials.variables(only?)`、`amaKeyScope(model)`、`persistedAmaModel(db, nodeId)`：G5-04 的 ACP 驱动可以复用这一套按供应商兑换。

**没做 / 限制**

- 浏览器（Cookie 模式）页面的 HTTP 请求在访问令牌过期后不会自动刷新，这是原有的限制，本包没改。因此 Cookie 会话的流到期关掉后，要等页面做下一次 `resumeIdentity` / 刷新才连得回来。
- ama 运行中换到另一家的模型时拿不到那家的密钥，要在节点上改模型后重启。

## G5-21 Windows 会话宿主退出（R-68）

做了什么：

- 会话宿主（`session-host/server.ts`）：没有活会话**且**没有通过握手的连接（core 的控制连接）时 10 秒后退出（`DEFAULT_ORPHAN_EXIT_MS`）；core 连上或建会话即取消，有活会话时永不因此退出；会话都结束但 core 连着时仍按原来的 30 分钟空闲。退出原因记进宿主日志（`session host leaving: <原因>`）。
- 新请求 `shutdownIfIdle`（宿主协议，进程内部）：没有活会话答 `ok {leaving: true}`，应答写出后退出，之后的 `create` 答 `draining`；有会话答 `leaving: false`，会话不动。客户端 `core/terminal/session-host/shutdown.ts::requestShutdownIfIdle`：只读密钥不新建、全程有界不抛，结论 `absent / busy / left / leaving / failed`。
- 壳：Windows 上壳自己起的 core 停下后（关闭 / 托盘退出）发一次（3 秒上限，失败不挡退出）；`lifecycle.ts::runQuitSequence` 多一个可选 `afterStop`。
- 安装包：`apps/desktop/build/installer.nsh` 定义 `customCheckAppRunning`，先以 `ELECTRON_RUN_AS_NODE=1` 跑 `resources\session-host\shutdown-if-idle.cjs <数据目录>`（`ARMADRA_DATA_DIR`，否则 `%LOCALAPPDATA%\Armadra`；等宿主进程最多 5 秒），再走 electron-builder 原来的检查与结束进程；安装目录里没有这个文件（旧版）就跳过。`shutdown-if-idle.cjs` 是 electron-vite 的单独产物，after-pack 放进 `resources/session-host/`。
- 探针 `windows-acceptance`：新增 `sessionHost.leaves`（应用退出后宿主自己退出，断言）；`uninstall.silent` 卸载前自己起一个空闲宿主（`ARMADRA_SESSION_HOST_ORPHAN_EXIT_MS=600000`），断言日志里是 `shutdownIfIdle` 让它走的、卸载后没有残留 `Armadra.exe`；收尾时不再先结束宿主。

实测：

- 本分支手动触发的 `nightly` 运行 37190639392 的 `windows-acceptance`（windows runner，未签名本地包）：`status: passed`；`sessionHost.leaves` 宿主 pid 1020 在应用退出后 10 秒自己退出；`uninstall.silent` 卸载前起的宿主日志为 `client greeted …: armadra-installer` → `shutdownIfIdle … leaving` → `session host leaving: shutdownIfIdle`，卸载后 `Armadra.exe`、注册表卸载项、快捷方式与残留进程都没有；`install.layout` 见到 `shutdown-if-idle.cjs`。
- PR CI 的 Windows 作业：`session-host/server.test.ts`（真命名管道，43 例）、`windows.integration.test.ts`（真 ConPTY + 进程入口 `run()`，9 例）、`main.test.ts`、`lifecycle.test.ts` 都跑了。
- 本机：`pnpm libs:build && pnpm -r --if-present test` 全绿；`pnpm check`、`pnpm release:test` 通过。

没做：

- 有活会话时宿主不走，安装程序照旧按 electron-builder 流程结束进程（会话随之结束）——有意如此；真机上「带活会话升级」的体验要用户的 Windows 机器。
- 只在安装程序环境里没有 `ARMADRA_DATA_DIR`、而用户的 core 用了别的数据目录时，助手找不到那个宿主，退回结束进程。

## G5-22 手机原生补充（R-54、R-55、R-56）

**做了什么**

- 原生 OAuth（R-56）。core 的 `oauth/{id}/start?native=1` 只认原生传输：不发绑定 Cookie，答案多一个一次性的 `nativeState`。回调对原生记录不取走、不认 Cookie，只 302 到 `armadra://oauth?state=…&code=…`（或 `error=`）。新路由 `POST oauth/{id}/native { state, nativeState, code? | error? }` 收尾：与浏览器回调同一套决定，答 JSON，登录时会话密钥在 `session.native`。记录在这一步才取走；`nativeState`、提供方或来源对不上，浏览器发起的记录走这里，一律 `oauth_state_invalid`。提供方仍只登记原来那个 https 回调。
- 页面（`mobile/native-oauth.ts`）：App 里 `startOAuth` 改走这一路，`state` 与 `nativeState` 记在本机，授权页交给插件的 `openExternal`（插件旧时答 `oauth_browser_required`）。深链经原生写进 `#link=` 再重载；入口在挂载前收尾，结果写成 `#oauth=` 片段，`use-link-fragments` 在 App 里也打开「安全」页。`state` 不是本机记着的那条时，不碰记录也不发请求。
- 令牌轮换（R-54）：Android `onNewToken`、UnifiedPush 新端点，以及 iOS 启动时 APNs 给出与上次登记不同的令牌（`PushTokenLedger`），都会标「换过」并发 `pushTokenRotated`。页面（`mobile/push-rotation.ts`）对开过推送的设备在启动和收到事件时重新 `PUT /api/push/devices`，成功后 `ackPushRotation`。
- 图片带 Bearer（R-55）：`api/assets.ts::useAssetUrl` 在 App 里把指向 Gateway 的图片地址经带 Bearer 的 `fetch` 换成 `blob:`，同一地址共用一份，最后一处卸载时回收。白板图片与 Markdown 预览的图都走它；浏览器与桌面照旧直接用地址。
- G5-10 留下的 Android UnifiedPush 分发器接线：引入 `org.unifiedpush.android:connector` 3.3.5，Tink 换成 `tink-android`。装了分发器就向它要端点，登记成 `{ transport: "direct", publicKey, unifiedpush: { endpoint } }`，30 秒拿不到或分发器拒绝时退回 FCM。消息正文是 §19.5 的信封，与 FCM 共用 `PushDisplay` 解开后出通知。页面 `native-bridge.ts` 认这种登记：只限 Android，必须带公钥，端点须是 https 或回环 http，可以不带令牌。
- 原生两侧：插件加 `openExternal`（只开 https 与回环 http）、`pushRotated`、`ackPushRotation`。`armadra://oauth?…` 与配对链接一样走 `#link=` 加重载。Android 冷启动带来的深链等页面加载完再交，同一个 intent 只交一次。判定放在不依赖 UI 的模块：`DeepLink` 的 OAUTH 类、`ExternalUrl`、`PushTokenLedger`。
- `mobile-shell-e2e` 加两条：Android 断言资产直接 `<img>` 拿到 401、经带 Bearer 的 `fetch` 拿到 200 `image/png`；记一条挂起流程后用 `armadra://oauth` 深链冷启动，断言收尾请求已发出（记录被取走）、「安全」页打开。iOS 经深链打开后，断言「安全」页出现、仍在连接状态。

**接口**：契约 §18.5 加两行与一段（`start?native=1`、`POST oauth/{id}/native`、原生回调的深链）；`oauth_browser_required` 只剩旧版 App 不带 `native=1` 的情况。共享层新增 `oauthNativeCompleteRequestSchema`、`oauthNativeOutcomeSchema`，`oauthStartSchema.nativeState?`。原生桥新增 `openExternal`、`pushRotated`、`ackPushRotation`、`onPushRotated`，`NativePushRegistration.token` 改为可选、加 `unifiedpush`（与 G5-10 的类型改动同形）。

**实测**（macOS arm64）

- core `oauth.test` 共 42 例（新增原生一路 5 例：绑定 → 登录、`nativeState` 不对后记录作废、浏览器与原生不能互走收尾、提供方拒绝与提供方不一致、`native=1` 只认原生传输）。web 新增 `native-oauth`、`push-rotation`、`assets` 三个测试文件，`native-bridge`、`entry`、`use-link-fragments`、`PushPermission` 加了用例。
- ArmadraNativeKit `swift test` 18 例；armadra-native-core 用 javac + JUnit 本地跑 15 例（`DeepLinkTest`、`ExternalUrlTest` 新增）。本机 iOS 模拟器构建（不签名）通过。
- 对构建出的 core 经 Gateway 的 Bearer 模式实测：资产不带 Bearer 答 401，带了答 200 `image/png`；`POST oauth/e2e/native` 答 400 `oauth_state_invalid`。
- 夜间 `workflow_dispatch`（本分支，run 37200252911）：`mobile-ios` 与 `mobile-android` 都全过。Android 的三条插桩用例全过，logcat 里能看到冷启动深链交给了页面。中途修了两处：一是冷启动时 Capacitor 会漏掉 `onPageLoaded`，改为另按页面进度轮询；二是插桩框架按启动 intent 认活动，不能清掉 intent 的 data。有一次 b 用例报 `script timed out`，是模拟器偶发，重跑失败作业后通过。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 4418 过 / 43 跳过，live 4 过，脚本 65 过；web 3311 过；shared 321 过；server 86 过 / 4 跳过；mobile 9 过；push-relay 9 过；0 失败。`pnpm --filter @armadra/web typecheck` 与 `pnpm check` 通过。

**没做 / 限制**

- 真提供方走完整个系统浏览器流程没有在模拟器里跑：模拟器里的浏览器不信本地 CA，回调页打不开。core 一侧由 `oauth.test` 对假 issuer 走完，App 一侧由深链 e2e 覆盖。真机需要用户的提供方与证书（§4 B 档）。
- App 里没有会话时，OAuth 登录若走到第二因素（`mfa`），入口会回到连接页，第二步接不上。现在原生 App 都是先配对、带着会话再登录或绑定，暂不受影响。
- 编辑器里文件的「下载」链接仍是 `<a href>`，不带 Bearer。
- UnifiedPush 的 App 一侧没有在模拟器里对真分发器跑过（模拟器上没有装 ntfy App）；core 一侧由 G5-10 的 `push-e2e` 对 push-sink 与真 ntfy 验过，App 交的登记形状与它一致。
- iOS 不做 UnifiedPush。

## G5-23 零碎界面与 G2-2 遗留（R-43、R-71、R-72 其余）

做了什么：

- R-71：`panels/ResponsiveDialog.tsx` 加 `ResponsiveAlertDialog*`。根仍是 Radix AlertDialog（`role="alertdialog"`、点遮罩不关），≤767 贴底：拖柄、顶部圆角 14、限高、让出安全区，底栏按钮竖排全宽、主操作在上。22 个确认框改用它（`BoardRow`、`remove-workspace`、`ControlConfirmDialog`、`FileTree`、git / github / resources / automation / settings 各页、`PresenceBar`、`FlowWorkspace`、`SessionRow`、`TemplateLibrary`）；G5-03 名下的 `AccountsSharingPage`、`security/*`、`GatewayDevices` 没动，留给它合入后接。
- R-43：
  - 向导第二步「选择文件夹…」（`pickDirectory`）：只在桌面壳、本机工作空间出现；选中的目录进候选并成为会话 `cwd`、写进节点。
  - 代码块导出写到来源 Agent 的工作目录：core 按该节点最近的终端会话取 `cwd`，在工作区内就落 `<cwd>/.armadra/exports/acp/…`，否则退回根；`relativePath` 仍相对工作区根。请求体不带路径。
  - 远端工作空间不再 501：Worker 新操作 `assets.exportText`（正文超过帧内上限走分块传输）。
  - 建出的节点亮一次未读光晕（`canvas/node-flash.ts`，2 秒，不进文档）。
- R-72 其余：
  - `Spinner` 调用处原本都已传本地化 `aria-label` 或 `aria-hidden`；加了扫描用例 `panels/spinner-label.test.ts` 守住。
  - `armadra-hook canvas --help` / `-h` 离线打印动词表（`usage.ts::CANVAS_USAGE`，与 `USAGE` 里那一节同一份文本）。
  - `i18n/{automation,github}.ts` 改为「设置 → 连接 → 后台服务与对外服务」；英文分组名对齐为 Connections。
  - 展示页 `components` 补 `resizable`、`chart`、`sonner`、`context-menu` 样本，确认框样本换成响应式版本。
  - 展示页 `integration` 补 CLI 分组：集成页真的行组件、状态预放进 query 缓存，含正常、版本过旧（页首一台 Worker 待升级）、启动器异常、ACP 未装四种。
  - 为此集成行加两个徽标：`stale` 时显示「待重新生成」，有 ACP 入口而适配器没装时显示「ACP 未安装」。
- 契约 §14.5：改写「远端 501」一句，追加落点规则。

实测：

- 单测：
  - `ResponsiveDialog.test`：确认框两种形态，以及取消 / 确认行为。
  - `NewAgentWizard.test`：选择器选中、取消、无壳与远端不显示。
  - `exports.test`：cwd 落点、最新会话、工作区外 / 不存在 / 符号链接出界都退回、远端经 `assets.exportText` 写在执行主机且本机无文件。
  - `export-to-board.test`：光晕亮起后熄掉。
  - `hook.test`：`canvas --help`。
  - `IntegrationPage.test`：两个新徽标。
- 改前改后各跑一次 `design-showcase --only=components,integration`：对比度、Tab 可达 84/84、焦点环、强制颜色、控制台都通过，12 张图有变化（新样本）。
- 无头 Chrome 390 / 1440 实拍：390 宽的确认框贴底、两个按钮各 343px 全宽；1440 宽仍居中。另外拍了右键菜单、toast、resizable、chart、集成分区（深浅两套），见 PR。

没做：

- ~~G5-03 名下三处确认框还在用 `ui/alert-dialog`。~~ 后续 `fix/g5-23-identity-dialogs` 已接上（`AccountsSharingPage` 含成员菜单「重置两步验证」、`security/parts.tsx::ConfirmRemove`、`GatewayDevices`），并加扫描用例 `panels/no-raw-alert-dialog.test.ts`：除 `ResponsiveDialog.tsx` 外不得直接 import `ui/alert-dialog`。
- 旧版 Worker 没有 `assets.exportText`：对它的远端导出要先「重新同步」执行主机，否则报 Worker 的未知操作错误。

## G5-24 桌面回环收紧（R-15）

**做了什么**

- core 启动选项 `loopbackAnonymousOwner`（`core/main.ts` 的 `RunOptions`，缺省 `false`；不传时读 `ARMADRA_LOOPBACK_OWNER=1`）。判定集中在 `core/identity/http.ts::anonymousLoopbackOwner`：选项开着、明文回环来源、一个凭据都没带，且不是 Gateway 标过的 Bearer 请求，才按 `IdentityService.localOwner` 处理。`github/http.ts` 与 `schedule/api.ts` 改用它，关着时回环匿名照常落到认证、答 401。
- 桌面壳：`main/runtime-process.ts::coreEnvironment` 起 core 时去掉 `ARMADRA_LOOPBACK_OWNER`，从操作员 shell 或探针环境继承下来也开不了。服务器壳：`serve.ts` 显式传 `false`，环境变量不听。
- 页面：`api/request.ts` 打 `/api/github/`、`/api/automations/` 时在桌面壳里带票据换来的 `Authorization: Bearer`（`identity.ts::shellBearer`，还没会话先向壳要票配对）；401 时 `renewShellBearer` 走 `resumeIdentity`（复核 → 刷新 → 重新要票）换一枚重发一次，几个请求同时被拒只换一次。其余路由不带。
- 回环 CORS 的 `access-control-allow-headers` 加 `authorization`（`core/http/cors.ts`）。原来只放行 `content-type`：壳里的页面跨端口带 Bearer 的请求被预检拦下——实测旧构建里页面 `GET /api/identity/session` 带 Bearer 是 `Failed to fetch`，也就是说桌面壳里身份面第二次 `resumeIdentity`、设备列表、安全页这些 Bearer 调用原来就不通，这一条一并修好。
- 探针与开发命令显式打开：`tools/probes/probe-home.mjs` 导出 `LOOPBACK_OWNER_ENV` 并在 `isolatedEnv` 里统一设；不经 `isolatedEnv` 起裸 core、又会无凭据打这两面或开页面的 `workflow-e2e.mjs` 与 `ui-features/harness.mjs` 各加一行；`armadra.sh run web` 起 core 时带上。
- 文档：契约 §3.2 追加「自 0.3.0 起桌面壳不再按主人处理回环匿名请求」一段；安全审查 L9 标「已修（G5-24，§3.2 那条路）」并写明仍开着的部分；开发指南的「来源与凭据」与环境变量表各补一条。

**调用方核对**

| 调用方                                                                                                                           | 打哪里、带什么                                                                                              | 受不受影响                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `armadra-hook` 全部 canvas / context / browser 动词、`hook` 事件、`credential`、`credential --ama`、`doctor`（`/verify`）、`mcp` | hook 服务自己的监听（`core/hook/server.ts`），应用令牌 + 节点 token（`hook-client/session.ts::headersFor`） | 不经 core 主监听，不受影响                                         |
| `run/<cli>` 启动器、PATH 垫片、Windows 启动器                                                                                    | 只调 `armadra-hook credential` / `credential --ama`，同上                                                   | 不受影响                                                           |
| 桌面页面：GitHub 面板、Git 托管设置页、自动化抽屉、自动化节点、新建计划                                                          | 都经 `GithubApi` / `AutomationApi` → `api/request.ts`                                                       | 已补 Bearer；Electron 实测匿名 401、Bearer 200                     |
| 桌面页面：身份面（会话、设备、安全页）                                                                                           | `api/identity.ts::call`，原本就带 Bearer                                                                    | 原来被 CORS 预检拦下，现已放行                                     |
| 桌面页面：其余 `/api/` 与 WebSocket                                                                                              | 不带凭据                                                                                                    | 不走 §3.2 那条路，不受影响（见「没做」）                           |
| 托盘（`main/tray.ts`：`/api/gateway`、`/api/usage`、`/api/usage/cost`、`/api/settings`）、`runtime-process` 的 `/health`         | 路由表路由，不带 Origin                                                                                     | 不受影响                                                           |
| 服务器壳                                                                                                                         | 页面走 Cookie 会话；Caddy / Gateway 来的是 HTTPS 来源                                                       | 不受影响；回环监听上的匿名本机进程原来也能按主人打这两面，现在 401 |
| 原生 App                                                                                                                         | Gateway 的 Bearer 模式                                                                                      | 不受影响，且明确排除在回环匿名之外                                 |
| 探针                                                                                                                             | `isolatedEnv`、`workflow-e2e`、`ui-features/harness` 显式打开；经桌面壳起的 core 不开                       | A 档全过                                                           |

**实测**（macOS arm64，2026-10-05）

- 新增用例：`identity/http.test`「回环匿名」2 例、`route-access.test`「回环匿名：路由门不替两面认人，缺省 401」、`github/http.test`「回环匿名缺省是 401，显式打开才按本机主人」与预检放行 `authorization`、`schedule/api.test` 回环匿名 401 与显式打开 200、`main.test` 选项与环境变量的优先级加端到端 401、`cors.test`、`runtime-process.test`「不把回环匿名按主人的开关带给 core」、`serve.integration.test`（环境里有变量也不开）、页面 `request.bearer.test` 5 例（先配对再带 Bearer、只有两面带、401 换一枚重发、换不出不重发、不在壳里不带）。
- Electron 开发构建，探针环境（带 `ARMADRA_LOOPBACK_OWNER=1`）起壳，在真渲染页里：匿名打自动化与 GitHub 面都是 401（壳去掉了变量）；向壳要票、配对后带 Bearer：`/api/identity/session` 200、自动化 200、GitHub 200。把 `cors.ts` 换回原样重建，同一脚本在带 Bearer 的 `session` 上 `Failed to fetch`。
- 默认裸 core：任意回环来源无凭据打自动化面 401；`GET /api/settings` 仍 200（见「没做」）。
- 全量验证与 A 档探针、packaged-smoke 结果见 PR。

**接口**

- `RunOptions.loopbackAnonymousOwner?: boolean`；环境变量 `ARMADRA_LOOPBACK_OWNER=1`（只给裸 core）。
- `core/identity/http.ts`：`setLoopbackAnonymousOwner`、`loopbackAnonymousOwner`、`anonymousLoopbackOwner(request, token)`。
- 页面 `api/identity.ts`：`shellBearer()`、`renewShellBearer(rejected)`。
- 探针 `tools/probes/probe-home.mjs`：`LOOPBACK_OWNER_ENV`。新探针起裸 core、又要无凭据打 GitHub / 自动化时用 `isolatedEnv` 或叠上它。

**没做 / 限制**

- L9 只收紧了契约 §3.2 那条路。路由表里其余 `/api/` 路由与 WebSocket 在桌面壳上没有请求身份，路由门按本机 owner 放行（`identity/gate.ts`），本机回环端口上的网页仍能调它们。要收紧，得让页面全部请求带 Bearer、流换票、托盘跟进，范围比本包大，另立一包。
- 「自 0.3.0 起」按计划原文写；仓库当前版本号仍是未发布的 0.2.0，若这一改动随 0.2.0 发布，契约那句要跟着改。

## G5-25 Claude 本地额度窗口估算（R-70）

做了什么：

- `core/usage/local-window.ts`（新）：拿成本扫描器最近一趟的 Claude 日桶与小时桶（不再开文件）估两个窗口。5 小时窗口从上一个窗口之外第一条活动所在的本地整点起算、持续 5 小时，已结束则报从当前整点起、没有结束时刻的空窗口；7 天窗口是含今天的 7 个本地日。`used` = 输入 + 输出 + 缓存写（缓存读不计）。`limit` 只在调用方给了额度时才有。
- `CostService.scannedBuckets()` 交出最近一趟的两组桶；`UsageService` 在读快照（`snapshot()` / `refresh()`）时，对 `reason: "policy_off"` 的 Claude 行现算 `estimate: { source: "local", windows: [{ key, label, windowStartMs, resetsAtMs?, used, limit? }] }`。设置 `usage.claudeLocalWindow` 关、成本扫描关或还没扫过时不挂。可选 `claudeWindowLimits` 供给额度，装配时没有接（仓库里没有订阅档额度的目录），所以现在只报 token。
- 共享层 `usageEstimateSchema`；页面 `panels/usage/LocalEstimate.tsx`，用量卡、账号页明细（`shell/ProviderDetail.tsx`，`AccountPage` 本身没改）与用量环的无障碍名都标「本地估算 / Local estimate」；没有额度时只报 token 数、不画进度条，有额度才画百分比。契约 §12.1 追加一段。

实测（macOS arm64，2026-10-04）：

- `local-window.test`（夹具转录经 `ScanState` 扫临时目录：窗口起点、恰好 5 小时的边界、7 天首日边界、窗口已过期、无额度 / 有额度、缓存读不计）、`usage/routes.test`（夹具写在测试自己的 `CLAUDE_CONFIG_DIR`：`policy_off` 旁带估算，关掉设置后不带）、共享层 schema 用例、页面 `LocalEstimate.test`（卡片、账号页明细中英、用量环）。没有读过本机 `~/.claude`。

没做 / 限制：

- 没有订阅档额度来源：不读 Claude 凭据就不知道是哪一档，所以 `limit` 目前总是缺省，只报用量。
- 契约里的形状是 `estimate.windows[]`（两个窗口各带 `windowStartMs`），不是计划里写的单个窗口。
- 设置页没有 `usage.claudeLocalWindow` 的开关（计划要求 `AccountPage` 不改）；只能经设置接口改。
- 估算依赖成本扫描节奏（后台 5 分钟一趟），不比扫描更新。

## G5-26 依赖审计

做了什么：

- `ws` 8.18.3 → 8.21.0（与 Dependabot #4、手工 #13 同一改动；本包合入后由协调者关掉这两个 PR）。#13 里 `approvals.test` 阈值那一处归 G5-27，这里不带。
- `uuid`（GHSA-w5hq-g745-h8pq，警报 #51）：`overrides` `"uuid@<11.1.1": 11.1.1`。旧的 7.0.3 来自 `@capacitor/cli` 的 `xcode`（手机壳开发依赖，不是 electron-builder），只调 `uuid.v4()`。mermaid 原本用 uuid 14.0.2，现在也解析到 11.1.1（mermaid 的范围是 `^11.1.0 || … || ^14.0.0`），整棵树只剩这一份。
- `node-forge`（GHSA-86w9-cpqp-85rv，警报 #48，无修复版）：`acme-client` 最新仍是 5.4.0，仍依赖 `node-forge`。`acme.ts` 本来就自己拼 CSR，账户 JWS 走 `node:crypto`；`acme-client` 只在旧的 `forge` 导出里加载 `node-forge`。处理方式：`patches/acme-client@5.4.0.patch` 删掉 `forge` 导出、`src/crypto/forge.js` 与类型里那一行，再用 `"acme-client>node-forge": "-"` 去掉这个依赖。`node-forge` 不再安装，也不再出现在 `THIRD_PARTY_NOTICES.md` 里。
- `braces`（#49）、`http-cache-semantics`（#50）都没有修复版（`http-cache-semantics` 今天发了 4.3.0，对照过源码，没有改 max-stale 那段），都只在构建期使用。锁在 lockfile 里，登记在 [CI 与发布](../guides/ci-release.md) §3.2。
- `node tools/notices.mjs` 重新生成：少了 `node-forge`，`ws` / `uuid` 换了版本。

实测（macOS arm64，2026-10-04）：

- `require("acme-client")` 的导出只剩 `Client / directory / crypto / axios / setLogger`。`ARMADRA_DEV_STACK=1` 下 `acme.test` + `acme.pebble.test` 共 12 项全过，Pebble 真签发通过。
- `xcode@3.0.1` + `uuid@11.1.1`：对 `apps/mobile/ios/App/App.xcodeproj` 做 `parseSync`、`generateUuid`、`addPbxGroup`、`writeSync`，都正常。
- 全量验证见 PR。

需用户在 GitHub 上 dismiss：

- #49 `braces`、#50 `http-cache-semantics`：选「仅构建期 / 代码路径不可达」，理由见 ci-release §3.2。#48、#51 在本包合入后会随 lockfile 自动关闭，不用手动处理。

没做：

- 没有跑 `pnpm --filter @armadra/desktop dist`。`uuid` 不在桌面打包路径上；`acme-client` 由 `externalizeDepsPlugin` 外置，打包时从 `node_modules` 带上的是补丁后的版本。

## G5-27 不稳定用例（R-88、R-89、R-90）

做了什么：

- R-88 `approvals.test`「sweeps the files a killed client left behind」：CI 现场（run 37179985659）是 `sweepOrphans(dir, -1)` 得 0——Windows 上文件 mtime 比进程的 `Date.now()` 超前 ≥1 ms，`now - mtime > -1` 不成立。`core/agent/approvals.ts` 与 `core/hook/approvals.ts` 的 `sweepOrphans(directory, olderThanMs, now)` 改由调用方传时间（生产传 `Date.now()`）；用例用 `utimesSync` 钉住 mtime 并注入时钟，含「恰在阈值」「时钟落后于 mtime」两条。
- mailbox `beforeEach` 10 秒超时（run 37197020176）：在 Windows CI 上给夹具各阶段计时（临时提交，已删）。两次提交在默认 `synchronous` 下中位 35 ms、p99 696 ms、最长 1.09 s，关掉后都是 0 ms；迁移模板每个测试文件建一次，中位 187 ms、最长 3.2 s，正好落在文件的第一个 `beforeEach`。夹具连接改成 `PRAGMA synchronous = OFF`（只用于测试库，生产的 `db/open.ts` 不动）；模板由 `testing/db-template.global.ts`（vitest `globalSetup`）整轮只建一次，再 `provide` 给各文件，没提供时仍退回每个文件自己建。
- R-90 macOS 无头 `DOM.getDocument` 卡住：重新读 #78 的现场（job 111302997144），卡住的会话 `FEA8…` 在 `tabs` 里是**后台标签页**，不是 iframe 子会话。在它前面，`tabs new` 对同一个新目标发了两次 `Target.attachToTarget`：Chromium 先发 `targetCreated`、后答 `createTarget`，事件处理与 `openTab` 各附加了一次，同一页挂了两个调试会话。`headless/node.ts` 的 `attach` 改成按目标只附加一次，后来的调用方等待前一次。`diagnose()` 对每个标签页都问两件事：`Page.getFrameTree`（由浏览器进程回答）和 `DOM.getDocument`（由渲染进程回答）。原先只问前者，看不出渲染进程卡住。按计划，`cdp/session.ts` 给跨源 iframe 子会话单独设 5 秒超时（`CHILD_TIMEOUT_MS`）。超时的子会话标为静默：`childFrames()` 不再列出它，快照、文本查找、定位都跳过它；它只要再回答一条命令就恢复。快照仍用 `childTargetIds()` 排除静默子会话的框架，不经页面会话读它。整页截图和打印按有没有跨源 iframe 判断。
- Windows 上 `browser/headless/*.live` 同时超时（#109 run 37201663502）：三个 live 文件（两个浏览器、一个 passkey）一起失败，都卡在各自 Chromium 的**第一条**命令上（`Target.setDiscoverTargets` / `createTarget` 30 秒没答）。passing run 里 Windows 冷启动到首个标签页是 7–10 秒，三个文件是并行起三个 Chromium，`vitest.live.config.mts` 的注释写的却是「一个文件、一个 fork」。现在改为 `fileParallelism: false`，一次只跑一个文件；启动后的第一条命令单独给 `STARTUP_TIMEOUT_MS`（90 秒），这一段等的是浏览器进程起来，不是页面在应答，之后的命令仍是 30 秒上限。
- R-89 `server-container-e2e` 配对卡住：没有任何一次 CI 留下现场（ci / nightly 最近的失败 run 都翻过），本机容器模式连跑 15 次也都通过，所以**没能复现，修复是从代码推断的**。原来「后台服务」页只在挂载时看一次地址栏：自动检查失败一次，或者页面开着时片段换了，票就停在地址栏里，没有人去取。现在 `HostPage` 也监听 `hashchange`；带着票的检查失败后，隔 1 秒自动重试，最多两次。`HostIdentityPanel` 在可用状态下也监听 `hashchange`，取到票就配对。探针 `server-e2e.mjs` 每次没等到都留现场（`pairingFailures[]`，每次一张截图，票已抹掉），然后用 SIGUSR2 让服务器壳铸一张新票（容器里用 `docker kill --signal USR2`），先离开到 `about:blank` 再整页加载，最多三次。重试过就记一条「配对重试后完成」，偶发不会被悄悄吞掉。Windows 上的本机进程收不到 SIGUSR2，不重试。

实测（macOS arm64，2026-10-04）：

- `approvals.test` + `hook/approvals.test`、`collab/mailbox.test` + `db/fresh.fixture.test` 各连跑 20 次，全部通过（vitest 4.1 没有 `--repeat` 参数，用 shell 循环跑）。
- `verbs.live` 连跑 20 次通过，`core/browser` 的单元测试 273 项通过；新加的「标签页只附加一次」「子会话不答就跳过」用例去掉修复后都会失败。
- `server-e2e --container` 用本分支的镜像跑了 8 + 5 次，全部通过。故意让首张票作废时：修复前的镜像三次都配不上，修复后的镜像在第二次配对成功。

没做 / 残留：

- R-90 后台标签页的渲染进程为什么不回答，根因还没查明。修掉的是现场里紧挨在卡住前面的双重附加。下次再卡住时，`pages` 字段能区分是浏览器侧还是渲染侧不回答。
- R-89 的修复是推断的，CI 上要看夜间作业以后还会不会出现「配对重试后完成」。

## G5-28 回环全部收紧（L9 收尾）

**做了什么**

- core：回环监听上的门 `core/identity/loopback.ts`，经新的 `CoreServer.admission(gate)` 装上（`http/server.ts`，判在读请求体之前，升级在路由门之前）。回环匿名按主人关着时（两种壳都是）由身份域装：除 `/health`、`/api/health`、`/api/identity/*` 与配对短码换票外，每条 `/api/` 都要会话（回环明文读 Bearer，否则读 Cookie 并对写方法核 CSRF），每条流都要 `Sec-WebSocket-Protocol: armadra-ticket.<票>`。不报 Origin 的调用同样 401。认出的会话经 `runAs` 进请求身份，路由门、事件订阅、4401 / 4403 复核与 Gateway 一致。
- 与 Gateway 共用一份：`WsTickets`、`protocolTicket`、`anonymousPath`、`sessionIdentity` 搬到 `core/identity/transport.ts`（`gateway/admission.ts` 原样转出）；Gateway 的交接 listener 标 `admitted`，不过回环的门。`POST /api/identity/ws-ticket` 在回环上由身份域答（只给回环明文来源的原生传输），形状同 §17.4。
- Windows 取票：私有通道在 Windows 不开，壳经 fork 的 IPC 通道取票（`armadra:identity-ticket`，core `identity/control.ts::startTicketIpc` 与 `issueShellTicket`，壳 `main/core-ticket.ts`）。原来 Windows 的页面拿不到票，G5-24 之后 GitHub / 自动化两面在那里已是 401，这次一起修。
- 页面：`api/shell-transport.ts` 在桌面壳里给全局 `fetch` / `WebSocket` 装请求层，复用原生 App 的 `bearerFetch` / `ticketedWebSocket`（加了 `prepare`、`socketOrigin`、`refresh(rejected)`、`ws:` 的同源判断）：还没会话先向壳要票配对，401 时复核 → 刷新 → 重新要票只重发一次，流先换票；访问密钥到期前两分钟主动轮转（`identity.ts`），流不必因 4401 重连。`api/request.ts` 去掉 G5-24 的两面特判。`<img>` 资源在壳里也经 `fetch` 取 `blob:`（`needsBearerFetch`）。
- 编辑器「下载」（G5-22 遗留）：`api/assets.ts::downloadRuntimeFile` 经 `fetch` 取回再交给 `blob:` 链接，三种环境都带凭据（桌面与原生 App 的 Bearer、服务器壳同源 Cookie）；取不回提示「下载失败」。原来桌面里是用系统浏览器打开地址，会 401。
- 托盘：`shell-core/core-session.ts`，同一张票换自己的会话（来源是 core 自己的回环基址），401 先刷新、再重新配对。
- 探针：`tools/probes/probe-session.mjs`（经私有通道要票配对、陌生来源守门 `strangerRefused`）；`packaged-smoke` 改用它，并断言陌生回环来源打 `/api/settings` 与升级事件流都是 401。起裸 core 却没走 `isolatedEnv` 的 `acp-e2e`、`credentials-e2e`、`agent-e2e/lib`、`agent-e2e/isolated`、`scenario-9` 补上 `LOOPBACK_OWNER_ENV`。
- 文档：契约 §3.2 「自 0.3.0 起」改为「自 0.2.0 起」并追加一段；安全审查 L9 标全部修复；开发指南、架构、CHANGELOG 0.2.0 各补一条。

**调用方核对**

| 调用方                                                                            | 打哪里、带什么                                                                                                                         | 结论                                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `armadra-hook` 全部动词、`hook` 事件、`credential`（含 `--ama`）、`doctor`、`mcp` | hook 服务自己的监听，应用令牌 + 节点 token                                                                                             | 不经 core 主监听，不受影响                                |
| `run/<cli>` 启动器、PATH 垫片、Windows 启动器                                     | 只调 `armadra-hook credential`                                                                                                         | 不受影响                                                  |
| 桌面页面：全部 `/api/`、事件流、终端、realtime、语言服务、浏览器画面、图片、下载  | 全局请求层带 Bearer / 一次性票                                                                                                         | Electron 实测 200 / 升级成功                              |
| 桌面页面：身份面                                                                  | `/api/identity/*`，自己认凭据                                                                                                          | 不变                                                      |
| 托盘：`/api/usage`、`/api/usage/cost`、`/api/gateway`、`/api/settings`            | `CoreSession` 的 Bearer                                                                                                                | 实测库里有来源为 core 基址的会话                          |
| 壳的 `/health`                                                                    | 不要会话                                                                                                                               | 不受影响                                                  |
| 手机经 Gateway（网页 Cookie、原生 App Bearer + WS 票）                            | Gateway 的门，交接 listener 标 `admitted`                                                                                              | 不受影响，`gateway.integration`、`gateway-e2e` 通过       |
| 服务器壳                                                                          | 页面经 Gateway；回环监听现在也要会话                                                                                                   | 仓库里没有调用方打它的回环；`server-e2e`、`push-e2e` 通过 |
| 浏览器里经 Vite 开发                                                              | 连桌面壳起的 core 会 401                                                                                                               | 用 `armadra.sh run web`（带 `ARMADRA_LOOPBACK_OWNER=1`）  |
| 探针：裸 core                                                                     | `isolatedEnv` / `LOOPBACK_OWNER_ENV`                                                                                                   | A 档 12 项通过                                            |
| 探针：桌面壳起的 core                                                             | `packaged-smoke` 用 `probe-session.mjs`；`core-terminal-packaged`、`browser-agent-electron`、`windows-acceptance` 在页面里调，走请求层 | packaged-smoke 通过                                       |

**实测**（macOS arm64，2026-10-05）

- `pnpm libs:build && pnpm --filter @armadra/desktop test`：4587 通过 / 46 跳过，live 4 项、脚本测试通过；`pnpm --filter @armadra/web test` 3424 通过，`typecheck` 通过；`pnpm --filter @armadra/server test` 87 通过 / 4 跳过；`pnpm check` 通过。
- 新增用例：`main.test`「回环上没带会话的请求」6 例；`control.test` 的 IPC 签票 3 例；`core-ticket.test` 的 Windows IPC 2 例；`core-session.test` 4 例；页面 `shell-transport.test` 8 例、`assets.test`（壳里经 fetch、下载）3 例、`EditorNode.test` 的下载。`realtime/socket.integration`、`events/socket.integration`、`gateway.integration` 改成带会话与票。
- `node tools/ci/e2e.mjs --tier a`：12 项全过；`packaged-smoke`（打包版）通过，`回环匿名 {"settings":401,"upgrade":401}`，PDF、视频、终端回显都正常，控制台无错误。
- 真 Electron 开发构建（`ARMADRA_DATA_DIR` 与 HOME 都是临时的，环境里故意带 `ARMADRA_LOOPBACK_OWNER=1`）：页面 `fetch /api/settings` 200；陌生回环来源 `/api/settings` 与事件流升级 401，不报 Origin 401；页面事件流升级成功；终端回显；realtime 同步流收到第一帧、画板切成实时；重载后画布加载、未断开；设置页正常；托盘会话在库里；页面没有 401 与 error。

**接口**

- `CoreServer.admission(gate)`、`createListener({ admitted })`；`AdmissionVerdict` / `RequestAdmission`（`http/server.ts`）。
- `core/identity/loopback.ts`：`createLoopbackAdmission`、`loopbackSessionPath`；`core/identity/transport.ts`：`WsTickets`、`protocolTicket`、`anonymousPath`、`sessionIdentity`、`subjectOf`。
- `IdentityHttpOptions.wsTickets`；`POST /api/identity/ws-ticket` → `{ ticket, expiresAt }`。
- `core/identity/control.ts`：`issueShellTicket`、`startTicketIpc`、`TICKET_MESSAGE`；壳 `main/core-ticket.ts`：`attachTicketChannel`。
- 页面：`installShellTransport()`、`shellWsTicket()`、`downloadRuntimeFile(url, name)`；`NativeTransport` 多 `socketOrigin`、`prepare`、`refresh(rejected)`。
- 壳：`shell-core/core-session.ts::CoreSession`；`TrayOptions.request`。
- 测试：`core/testing/loopback-session.ts::loopbackSession`；探针 `tools/probes/probe-session.mjs`。

**没做 / 限制**

- Windows 的 IPC 取票只有单元测试，没在真 Windows 上跑。

**后续（fix/g5-28-local-device-reuse）**

- 本机设备复用：`consumeBootstrap` 对回环明文来源的票复用主人名下同名、未撤销、会话全来自回环明文来源的那台设备（`service.ts::reusableLocalDevice`，`store.ts::deviceSessionOrigins`），页面与托盘反复配对设备列表不再增长；经 Gateway 配对的设备不受影响。用例 `service.test`「本机设备复用」3 例、`main.test`「反复配对设备列表不增长」。
- Windows 接管 / 外接的 core：壳没有 IPC 通道时取票答 `channelUnavailable`（`shell-core/ticket.ts`、`shared/ipc.ts`），页面记下壳签不出票的原因（`identity.ts::shellSessionFailure`）并在顶部挂通知条，文案请人重开应用，「重连」再试一次；配上对即消失。用例 `core-ticket.test`、`Banners.session.test`。没有另开取票退路：hook 服务的应用令牌节点进程也拿得到，用它签主人票会把权限放大给 Agent。
- 下载把整个文件读进内存再存；很大的文件会占内存。
- 语言服务与浏览器画面两条流只经全局 `WebSocket` 覆盖，没有单独实测。

## G5-29 G5 残项：本地额度开关、手机 MFA、GitLab 子组 / 变基 / 自动合并、Gitea 与 GitLab 补齐

做了什么：

- G5-25 残项：设置 → 账号与用量的「本地成本统计」下面加了「Claude 本地额度估算」开关（shadcn `Switch` + `SettingsRow`），写 `usage.claudeLocalWindow`，默认开。成本扫描关着时开关禁用，保存后重新取用量。中英文案已同步。
- G5-22 残项：原生 App 没有会话、OAuth 登录走到第二因素时，入口（`mobile/entry.ts`）新增 `kind: "mfa"` 分支，不再退回连接页。整页 `mobile/NativeMfa.tsx` 复用登录组件 `SignIn` 的两步验证步骤和 `POST mfa/verify`，验证码对了就进画布；策略要求登记第二因素时打开「安全」页。页面上有「返回连接页」。中间票不写进地址栏。已有会话时仍写 `#oauth=` 片段交给「安全」页。契约 §18.5 追加了一句。
- GitLab 多级子组：owner 可以是 `group/sub/…`，每段都要合格，最多 20 段。项目路径整条 URL 编码。`resolve` 的认法：先按仓库一行找，从最长的 owner 往短找；再看主机那一行是不是 `gitlab`。http(s) 远端会先去掉 GitLab 子路径部署时的站点前缀。GitHub 和 Gitea 不接受多段 owner，给 Gitea 配多段键会答 400。页面上的配置键和仓库路径把多段 owner 编成一段，Git 面板显示完整路径。外部连接不支持多段 owner。
- GitLab 合并方式 rebase：新路由 `GET merge-options`，按项目的 `merge_method` / `squash_option` 给出可用方式；Gitea 和 GitHub 三种都给，不发请求。只有 `ff` / `rebase_merge` 项目接受 `rebase`。源分支落后（`need_rebase`）时先发 `PUT …/rebase`，并答 `409 rebase_started`：变基会换 head，要等新 head 出来、核对后再合。不落后就照常带 sha 合并。页面的合并方式取自 `merge-options`；变基已发出时给提示，不当失败处理。
- GitLab 合并队列：新路由 `POST / DELETE pulls/{n}/auto-merge`，也就是「流水线通过后合并」。会先核对 head，`PUT merge` 同时带 `merge_when_pipeline_succeeds` 和 `auto_merge`。流水线已经过了就当场合并；排上了答 `merged: false`。项目开了合并列车（`merge_trains_enabled`）时改走 `POST merge_trains/merge_requests/{iid}`，答 `train: true`。撤销只对已排上的 MR 发 `cancel_merge_when_pipeline_succeeds`。pull 新增 `autoMerge` 字段。页面有「流水线通过后合并 / 加入合并列车」（带确认）和「取消自动合并」。
- Gitea 与 GitLab 补上 GitHub 已有的三样：
  - CI 状态映射：详情头部加 CI 汇总徽标；GitLab 的检查列表最前面加当前 head 的 `pipeline #id`，旧 head 的流水线不算。
  - 检出：复用「检出到 worktree」。pull 新增 `fromFork`；fork 的 head 名不会沿用成本地分支名。
  - 合并后删分支：新路由 `DELETE pulls/{n}/branch?headSha=`。只有已合并、不是 fork、分支仍指着评审时的 head、且没受保护时才删，否则答 `reasonCode`（`NOT_MERGED` / `FORK_BRANCH` / `BRANCH_MOVED` / `BRANCH_PROTECTED` / `ALREADY_DELETED`）。页面的合并后清理抽成 `MergeCleanupView`，与 GitHub 共用，移除本地检出那一半也跟着有了。
- 路由表新增 3 行（`merge-options`、`auto-merge`、`branch`），共享层 zod 同步新增。契约 §29.1 / §29.4 / §29.5（`rebase_started`）/ §29.6 都是追加，没有改节号。回放夹具新增 `subgroups`、`merge-methods`、`auto-merge`、`cleanup`，按 GitLab REST v4 文档的形状整理，不是从真实实例录的。假 Gitea 加了 fork 与分支路由。`tools/probes/forge-panel.mjs` 多截几张图。

实测（macOS arm64，2026-10-05）：

- core 的 `forge/gitlab.test`、`gitlab.routes.test`、`forge.test` 新增：子组的寻址、识别和拒绝；合并方式表、变基已发出、不落后直接合、head 变了不发变基；自动合并的排上、当场合并、结果未知、合并列车、方式不符、撤销；fromFork、流水线检查、删分支的五种拒绝；Gitea 的删分支与 fork。其中有 3 条旧断言改了：`merge-options` 答复多了 `autoMerge` / `mergeTrain`，GitLab 的「rebase 不接」改成在 `merge_method: merge` 项目下不接。
- web：`AccountPage.test` 2 条，`NativeMfa.test` 2 条，`entry.test` 补了 mfa 分支，`api/forge.test`（新）覆盖路径编码，`GithubDrawer.test` 新增子组 1 条，`ForgeHosted.test`（新，原文件逼近 1500 行上限）6 条：项目合并方式与变基提示、自动合并、合并列车 / 撤销、CI 徽标与检出、删分支、fork。GitHub 清理的既有用例没改断言，照样通过。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`（4595 过 / 46 跳过，脚本全过）、web test（3431 过；首轮 `IdentityGate.test` 的 `#reset=` 一条在高负载下超时，单跑三次都过，本包没碰它）、shared 316、server 87 / 4 跳过、mobile 9，`pnpm --filter @armadra/web typecheck` 与 `pnpm check` 通过。
- 截图（真 core + 回放 GitLab + 无头 Chrome）：`forge-panel.mjs` 截了 `gitlab-detail`（CI 徽标、合并方式、流水线通过后合并、检出）、`gitlab-auto-merge`、`gitlab-merged`、`gitlab-subgroup`。设置页与手机 MFA 页用同一套临时入口截了中英两版。

没做 / 限制：

- 评审（review）不做：Gitea 和 GitLab 的评审模型与 GitHub 差得多（GitLab 是 approvals + discussions），不是低成本的部分。GitHub 那种「按标签 / Projects 字段分组 issue」的状态映射也不做，因为它要按工作空间存配置（新表）。这里做的「状态映射」是 CI 状态到徽标的映射。
- 合并列车只按文档对夹具验过：API 是 Premium 功能，没有真实实例。撤销用的是 `cancel_merge_when_pipeline_succeeds`，已上车的 MR 能不能这样撤下来没有验证。
- Gitea 的合并方式不读仓库的 `allow_*` 设置，三种都给；远端不收的方式由合并本身答 405 / 422。Gitea 的 `merge_when_checks_succeed` 没接。
- 多级子组的仓库不能作外部连接（GitHub 域的连接表按两段存）。
- fork 的 PR 检出不会自动取 `refs/merge-requests/<iid>/head` / `refs/pull/<n>/head`，起点要自己填。
- 都没有连真实的 GitLab / Gitea 实例。

## G5-30 G5 最后的小残项：验证码居中、fork 检出取平台引用、子组外部连接、passkey 用例导航

做了什么：

- 两步验证的六格验证码居中：竖排 `Field` 给每个子元素 `w-full`，`InputOTP` 的容器占满整行而格子组贴左。`SignIn` 的 MFA 步给容器加 `justify-center`，网页整页登录和手机原生 MFA 页（`NativeMfa` 复用 `SignIn`）都改过来了。设置 → 安全里登记 TOTP 的表单按设计系统左对齐，没动。
- fork 的 PR / MR 检出（G5-29 残项）：仓库操作 `createWorktree` 新增可选的 `pullHead { remote, forge, number, headOid }`。core 在操作执行时才 fetch 平台发布的引用（GitLab `refs/merge-requests/<iid>/head`，Gitea `refs/pull/<n>/head`），引用由 core 按平台和编号拼，不收调用方给的 refspec。取到临时引用 `refs/armadra/checkout/<操作 id>`，用完即删；取到的提交和屏上 head 不符时操作 `failed`，不建分支、不留检出。页面上 Gitea / GitLab 的 fork 请求「起点」只读显示这条引用，有多个远端时可选远端（缺省 `origin`）。GitHub 和同仓库的请求照旧。共享层 zod 同步。
- GitLab 多级子组的仓库能作外部连接（G5-29 残项）：`github_references` 的 `owner` 列原本就没有长度或格式的 CHECK，存完整命名空间路径（`group/sub`），`name` 是最后一段，不加迁移。连接标识的材料仍是 `owner/name`（`name` 不含 `/`，不会和两段仓库撞）。Gitea 和 GitHub 仍拒绝多段 owner。
- 偶发（flakes-seen 最后一条）：`core/identity/passkey-cdp.live.integration.test.ts` 改成先开 `about:blank`，挂上会话、打开 `Page` 生命周期事件后自己 `Page.navigate`，按这次导航的 `frameId` / `loaderId` 等目标文档的 `load`，再断言 `location.origin` 与 `readyState` 才 evaluate。旧写法轮询 10 秒、到点不论成败都往下走，Windows 上页面还停在 `about:blank` 就跑了相对 URL 的 fetch。
- 契约 §29.6 追加「外部连接的多级子组」与「fork 的 PR / MR 检出」两条；原来「外部连接不收多段 owner」一句改为注明 G5-30 起收。没有新迁移、没有改节号。

实测（macOS arm64，2026-10-05）：

- core `git/operations.test` 新增 4 条（本地裸仓库）：GitLab / Gitea 的引用只在检出时取、分支起点就是 fork 的提交、不留临时引用也不镜像平台引用；head 变了答 `failed` 且没有检出与分支；与 `startPoint` 混用、编号非法、未知远端在排队前就拒绝。`forge/gitlab.routes.test` 新增 2 条：子组连接入库与列出、与两段仓库区分、越级 / 空段拒绝；Gitea 两段能连、多段拒绝。共享层 `git-repository.test` 1 条。
- web：`ForgeHosted.test` 新增 3 条（GitLab / Gitea 的 fork 起点、提交前不发操作、提交带 `pullHead`；同仓库请求不带）；`SignIn.test` 补居中断言。
- passkey 真 Chromium 用例本机连跑 3 次通过；Windows 上的效果要看 CI。
- 截图（临时入口 + 无头 Chrome，入口已删）：`target/g5-30-shots/{before,after}-{native,page}-{390,1440}-{zh-CN,en}.png`。改前格子组中心在 144 / 660（视口中心 195 / 720），改后 195 / 720，与标题对齐。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`（4613 过 / 53 跳过，live 4 过，脚本 68 过）、web test（3441 过）、shared 318 过，`pnpm --filter @armadra/web typecheck` 与 `pnpm check` 通过。

没做 / 限制：

- fork 检出的远端按名字选（缺省 `origin`），不按地址判断哪个远端是基仓库；选错了远端会因为取不到引用而失败，不会检出错的提交。
- 子组连接的徽标点开仍只打开面板，不定位到具体 MR（同 G5-15）。
- 都没有连真实的 GitLab / Gitea 实例。

## E0-A 工程规范化：工具链（ESLint、knip、覆盖率、依赖审计、上游锁版规则）

设计：[工程规范化](../design/engineering-standardization.md) §4.3、§5、§6 的 E0-1 / E0-2 / E0-6，决策 F6–F9、F15。组件整改与扫描守卫（E0-3 / E0-4 / E0-5）是 E0-B，不在本节。

做了什么：

- **ESLint（E0-1）**：根目录 `eslint.config.js`（ESLint 9 flat config），覆盖 `apps/web`、`apps/desktop`、`apps/server`、`packages/shared`、`tools/`；手机壳与推送中继不在 E0 范围，显式忽略。`@eslint/js` 与 typescript-eslint 推荐规则、`react-hooks/exhaustive-deps`、`eslint-plugin-jsx-a11y` 推荐规则全部 warn；`eslint-config-prettier` 放最后，不和 Prettier 抢格式。error 只有四类：`react-hooks/rules-of-hooks`；core 与 session-host 不得 import `electron`、`../main/`、`../shell-core/`（shell-core 禁前两个）；`@orpc/*` 只能在 `packages/shared/src/contract/`、`apps/desktop/src/core/http/rpc.ts`、`apps/web/src/api/client.ts` 与 `tools/contract/` 出现（现在还没有 oRPC，规则先写好；`rpc.ts` 放开 `@orpc/*` 但仍守 core 边界）。§4.2 的禁止事项写成页面业务代码（`apps/web/src` 除 `ui/`、测试与 `showcase/fixtures/`）的 `no-restricted-syntax`，全部 warn：手写 `<button>` / `<input>`（`file`、`hidden` 除外）/ `<select>` / `<textarea>` / `<dialog>`、`role="dialog"`、直接 import `ui/dialog` / `ui/alert-dialog` / `ui/sheet`、`Loader2`、无 `aria-label` 的图标钮、`dark:`、`z-[N]`、字面色值。放行名单与 E0-B 的扫描守卫一致：`ui/dialog` / `ui/alert-dialog` 只许 `ResponsiveDialog`，`ui/sheet` 只许 `no-raw-dialog-sheet.test.ts` 登记的 15 个抽屉；字面色值放过 `palette.ts`、`appearance.ts`、`lib/contrast.ts`、`showcase/`、`canvas/test-support/` 与样例数据（同 `no-literal-color.test.ts`）。守卫里用 `ui-exempt:` 注释放行的位置 ESLint 读不到，仍报 warn、计入基线。类型感知规则 `no-floating-promises` / `no-misused-promises` 只开在 `core/http`、`web/src/api`、`shared/src`（warn）。
- `pnpm lint` 接进 `pnpm check`（format:check 之后、typecheck 之前），warn 不让它失败。规则自检 `tools/lint-config.test.mjs`（10 条，进 `pnpm repo:test`）：每条边界与禁止事项各一段必须拦下、一段必须放过的样例。
- 打开 rules-of-hooks 后扫出 2 处真问题并修了：`app/use-cost.ts`、`app/use-usage.ts` 把 `useAccess()` 写在 `wanted && …` 右侧，`wanted` 变化时 hook 顺序会变；改成先无条件取。
- **knip（E0-2）**：`knip.json` 登记各 workspace 入口——壳的七个构建目标（`electron.vite.config.ts` 的 main / preload / core / armadra-hook / session-host 两个 / ama）、页面与展示页、服务器壳、测试、脚本与探针；系统二进制（`openssl`、`infocmp`、`where.exe` …）与经 `../web/vite.config` 间接用到的插件不再误报。`pnpm knip` 只出报告（`--no-exit-code`），不进 check；夜间 `hygiene` 作业把报告传成产物（§5 第 1 步）。
- **覆盖率**：根装 `@vitest/coverage-v8`，web、desktop、server 三个 vitest 配置写好 `coverage`（v8、text-summary + lcov、只算 `src/`），平时关着，`ARMADRA_COVERAGE=1` 或 `pnpm test:coverage` 打开；不设门槛（F9 第 1 步）。CI 只在 Linux 那一行打开并上传 `coverage-lcov` 产物，三平台不重复。
- **依赖漏洞**：`nightly.yml` 新增 `hygiene` 作业，`pnpm audit --prod --audit-level=high` 失败时作业失败，`report` 照 B 档的规矩开 issue / 追加评论；不阻断 PR。
- **上游锁版（E0-6）**：`tools/repo-check.mjs` 新增规则 `pinned-versions`，`repo.rules.json` 的 `pinnedVersions` 登记 `@orpc/*`：各 `package.json` 里必须是精确版本、不得是预发布（beta / rc），清单与 `pnpm-lock.yaml` 的 `packages:` 段全树只允许一个版本；一个都没有时通过。`tools/repo-check.test.mjs` 新增 3 条：空集通过、精确同版本通过；`^` 范围、`2.0.0-beta.42`、锁文件里的 `1.15.3` 各被拦下；本仓库现状通过。规则说明补进 `docs/design/repository-structure.md` §3.6。
- 新增的开发依赖（全部精确版本）：`eslint` / `@eslint/js` 9.39.5、`typescript-eslint` 8.71.0（8.71.1 发布不满一天，会触发 `minimumReleaseAge` 例外，退一版）、`eslint-plugin-react-hooks` 7.1.1、`eslint-plugin-jsx-a11y` 6.10.2（尚不支持 ESLint 10，所以停在 9）、`eslint-config-prettier` 10.1.8、`globals` 17.13.0、`knip` 6.39.0、`@vitest/coverage-v8` 4.1.11（与 vitest 同版本）。都是开发依赖、不打进产物，`pnpm notices:check` 不变。根 `package.json` 加了 `"type": "module"`（`eslint.config.js` 是 ESM；根下没有别的 `.js` 依赖 CommonJS）。

基线（2026-10-06，本分支合入 E0-B #130 之后）：

- ESLint：**0 error、284 warn**。按规则：`@typescript-eslint/no-unused-vars` 66、`no-empty` 43、`jsx-a11y/no-autofocus` 38、`react-hooks/exhaustive-deps` 32、`no-control-regex` 26、`no-restricted-syntax` 24（字面色值 21，正是 `no-literal-color` 登记的存量；`InlineText` 的 `<textarea>`、`MobileFocusPage` 的 `role="dialog"`、`use-workspace-file-drag.ts` 的 `z-[9999]` 各 1）、`@typescript-eslint/no-explicit-any` 18、`prefer-const` 10、其余 jsx-a11y 与零星规则 27。按目录：web 152、desktop 74、tools/probes 55、shared 2、tools/ci 1。类型感知的两条在开着的三个目录里为 0。合入 E0-B 前是 339（其中 `no-restricted-syntax` 79），差的 55 条是 E0-B 换掉的原生表单元素、dialog / sheet 直连与按名单放行的抽屉。
- knip（符号级，`--reporter json`）：未用文件 1（`core/hook/install/index.ts`，无人引用的桶文件）、未用依赖 1（web 的 `@codemirror/autocomplete`）、未用开发依赖 1（desktop 的 `@types/js-yaml`）、未列出的依赖 10（`tools/probes` 借用各 app 的 `ws`、`yjs`、`electron`、`esbuild` 等 9 处，desktop 脚本的 `node-gyp` 1 处）、未用导出 1444（desktop 1020、web 408、server 16）、未用导出类型 434（desktop 299、web 133、server 2）、重复导出 8（web 7、desktop 1）。`--reporter compact` 按文件数是未用导出 559、类型 227，web 一侧与设计 §1.4 的一次性基线（198 / 82 / 7）一致。
- 覆盖率（本机，只报告）：web 行 81.3%（语句 79.1%）、desktop 行 84.5%（语句 81.9%）、server 行 86.6%。
- 依赖审计：现在 `pnpm audit --prod --audit-level=high` 有 1 条 high——mermaid 经 chevrotain 带进来的 `lodash-es` ≤ 4.17.23（GHSA-r5fr-rjxr-66jc），另有 1 条 moderate。改它要动生产依赖（`overrides` + 第三方声明），不在本包；第一次夜间运行会开 issue。

实测（macOS arm64，2026-10-06）：

- `pnpm check` 通过（含 lint：本机冷跑约 41 秒，整串 1 分 39 秒）；`pnpm repo:test` 23 条全过（repo-check 13、lint-config 10）；`pnpm release:test` 171 过；`pnpm ci:workflows` 5 个工作流通过。
- `pnpm --filter @armadra/web test` 3480 过（合入 E0-B 后）；`pnpm libs:build && pnpm --filter @armadra/desktop test` 4615 过 / 53 跳过，live 4 过，脚本 68 过；server 87 过 / 4 跳过，shared 318，push-relay 9，mobile 9。
- 带覆盖率：web 1 分 11 秒 → 1 分 21 秒；desktop 的 vitest 主套件约 1 分 38 秒。
- CI（run 37362058662，对比 run 37344131164）：linux 10 m 37 s → 13 m 12 s（`pnpm check` 1 m 39 s → 2 m 35 s，带覆盖率的 `pnpm -r test` 7 m 54 s → 9 m 26 s），macOS 12 m 09 s → 13 m 33 s（check 3 m 01 s），Windows 16 m 12 s → 19 m 01 s（check 3 m 04 s），e2e 16 m 12 s → 15 m 54 s；墙钟约 18 → 19 分钟。`coverage-lcov` 产物 0.68 MB。

没做 / 限制：

- `--max-warnings` 没设：按要求 warn 不让 check 失败；§5 的「只减不增」上限与按目录转 error 是 E5。
- knip 不进 check，`--max-issues` 阻断是 §5 第 2 步；覆盖率门槛（`core/http`、`shared/contract`、`api/` 80%）是 E5-2。
- lint 跟着 `pnpm check` 在三个平台各跑一遍；设计 §5 设想只并入 Linux 作业，要省这一份时间得把 lint 从 check 里拆出来单列一步。
- 手机壳、推送中继不在 lint 与 knip 的范围；`.claude/` 与 `docs/` 不 lint。
- `exhaustive-deps` 只报不修（修复可能改行为，按设计留给各域迁移时顺手做）。

## A3-0 五条流的发送队列、背压与心跳

做了什么（平台规格 core 包 §3；契约 §3.4 新增）：

- `core/http/stream-queue.ts`：`SendQueue`。拥塞按 `max(bufferedAmount, 已交给 send 而回调未回的字节)` 判，过 `highWaterBytes` 后排队，降到 `lowWaterBytes`（缺省一半）再写并解除；三种策略 `drop-oldest` / `coalesce` / `pause`。`push` 可以交一组帧（画面的头帧 + JPEG），`coalesce` 时同 key 只留最新一组。`pause` 拥塞时 `onPause`、排空后 `onResume`，队列满调 `onOverflow` 并拒收，不丢帧。`wsTarget(ws, { binary })` 把 `ws` 包成队列的对端。
- 接入：事件流 drop-oldest / 256 / 1 MiB（原队列删掉，丢帧计数照旧）；终端 pause / 64 / 4 MiB，`Attachment` 多了可选的 `pause` / `resume`：tmux 暂停这条连接自己的客户端 pty，会话宿主暂停这条宿主连接（宿主按 `writableLength` 自己暂停 ConPTY），direct 后端按附着计数暂停会话的 PTY，detach 或关流即释放；实时协同 pause / 256 / 2 MiB，暂停期间不向该连接广播更新与 awareness，恢复时补 step1、整份状态的 step2 与当前 awareness；语言会话 pause / 256 / 2 MiB，`Hub.pauseSession` / `resumeSession` 按会话计数暂停语言服务器 stdout，`closeSession` 释放，远程执行主机上的会话只排队；浏览器画面 coalesce / 4 / 2 MiB，`ViewerSocket.sendFrame(header, jpeg)`。`pause` 的队列满以 `1013` 关流。
- `core/http/server.ts`：ws 层心跳，一个定时器管全部连接，每 25 秒 ping，连续两次无 pong 就 `terminate()`（`CoreServerOptions.heartbeatMs`，`0` 关）。单帧上限按流声明（`stream(path, handler, guard, { maxPayload })`，按上限分 `WebSocketServer`）：缺省 1 MiB = `MAX_FRAME_BYTES`，终端 16 MiB，实时协同 16 MiB，语言会话 4 MiB。升级后统一给连接挂一个 `error` 监听。原来终端、语言、画面三条流没挂，超限帧或坏帧报的 `error` 会成为进程级未捕获异常。
- 帧格式没改，页面不用动。

实测（macOS arm64，Node 26.10.0，tmux 3.7c，2026-10-06，机器 load 8–10）：

- 新增用例：`http/stream-queue.test`（10 例，三种策略、水位滞回、close、非 OPEN、重复回调）、`http/server-heartbeat.test`（3 例：不回 pong 两次后 1006、回 pong 的连接不断、缺省上限 1009 与按流放宽）、`http/stream-queue.integration.test`（真 socket 慢客户端：客户端停读 400 ms 时 pause 流的生产者停下，core 侧 `bufferedAmount + 队列` 峰值不超过高水位 + 两帧，恢复后 1024 帧一帧不少、顺序不变；事件流 4 万帧丢旧，最后一帧送到，送达 + 丢弃 = 发布数，连接不断）、`terminal/backpressure.test`（2 例：卡在 5 MiB 时 `pause`、降到 2 MiB 以上不恢复、清空后 `resume` 且帧不丢不乱；对端不读满 64 帧以 1013 关流并释放暂停）、`terminal/direct.test` 真 PTY 暂停 / detach 释放 1 例、`realtime/sync.test` 暂停与恢复 2 例、`language/mux.test` 真子进程暂停 stdout 2 例、`browser/headless/node.test` 成组交帧 1 例；`events/stream.test` 的卡住客户端改为对 SendQueue 的委托断言。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：4645 过 / 46 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/server test` 87 过 / 4 跳过；`pnpm check` 通过。web 没改。
- A 档探针：`core-terminal-smoke`、`core-terminal-lifecycle`、`realtime-e2e`、`server-e2e`（含服务器壳上的浏览器画面流、经 Gateway 的终端与事件流 4403）、`remote-e2e`（远程语言会话诊断）全过。
- `tools/probes/server-perf.mjs`（30 终端 + 6 事件流 + 2000 对象实时板），main 与本分支同机交替各跑 3 次取中位数：

| 指标               |              main |            本分支 |
| ------------------ | ----------------: | ----------------: |
| 事件扇出 p95       |            2.8 ms |            2.0 ms |
| 终端吞吐           |        25.5 MiB/s |        25.5 MiB/s |
| 单会话完成 p95     |         1175.1 ms |         1175.5 ms |
| 建会话 p95         |           49.7 ms |           46.4 ms |
| 实时板批量         |          168.8 ms |          175.4 ms |
| 实时单字段更新 p95 |            0.7 ms |            0.7 ms |
| RSS 稳态 / 峰值    | 238.8 / 256.3 MiB | 222.8 / 246.9 MiB |

事件扇出 p95 单次在 1.7–5 ms 间跳，main 自己也有 5 ms 的一次。`rssSteadyMiB` 在这台机器上 main 与本分支都超出 `server-perf-baseline.json` 的 darwin-arm64 基线（录于 2026-10-03），不是这次引入的，基线没有重录。送到页面的终端字节数随 tmux 合并重绘在 4–8 MiB 间变，这次的打点里终端一次也没有触发暂停。

偏离规格之处：

- `maxPayload` 没有一律 1 MiB。实时协同的首个 step2 按契约 §16.1 可以到 16 MiB，终端 `input` 帧整段带着粘贴，一律 1 MiB 会把这两类合法帧以 1009 关掉，所以按流声明，缺省才是 1 MiB。
- 实时协同恢复时除了规格写的 step1，还补一帧整份状态的 step2。只发 step1 的话，客户端回答的是 core 缺什么，它自己漏掉的更新补不回来。
- `push` 多收一组帧（数组）。画面的头帧与 JPEG 是两条消息，合并时必须一起留或一起丢。
- 心跳不在规格 §3 里（任务要求加），按工程规范化 §3.3 的数：25 秒、两次。

没做 / 限制：

- direct 后端一个会话一个 PTY，任一附着者跟不上就让整个会话的输出等它（与慢终端同语义）。语言服务器同理，同一服务器的其它会话一起等。
- 远程执行主机上的语言会话无法暂停上游，只能排队，满了关流。
- 浏览器画面没有把 Chromium 的帧确认推迟到发出之后，跟不上时由 coalesce 丢旧帧，Chromium 照常编码。
- 心跳只是服务端 ping；客户端的 `system.ping` 与前后台感知属于 E2。

接口：

- `core/http/stream-queue.ts`：`SendQueue`、`SendQueueOptions`、`SendTarget`、`wsTarget`、`OPEN`、`DRAIN_POLL_MS`、`CLOSE_BACKPRESSURE`（1013）。
- `core/http/server.ts`：`CoreServer.stream(path, handler, guard?, { maxPayload })`、`StreamOptions`、`CoreServerOptions.heartbeatMs`、`HEARTBEAT_MS`、`HEARTBEAT_MISSES`、`DEFAULT_MAX_PAYLOAD_BYTES`。
- `terminal/backend.ts`：`Attachment.pause?()` / `resume?()`；`terminal/socket.ts`：`SEND_HIGH_WATER_BYTES`、`SEND_MAX_FRAMES`、`TERMINAL_MAX_PAYLOAD_BYTES`；`session-host/link.ts`：`Link.pause()` / `resume()`。
- `realtime`：`SyncConnection.pause()` / `resume()` / `sendAwareness()`，`SYNC_MAX_FRAMES`、`SYNC_HIGH_WATER_BYTES`。
- `language`：`Hub.pauseSession()` / `resumeSession()` / `outputPaused`，`ServerProcess.pause()` / `resume()`，`limits.ts` 的 `SESSION_MAX_FRAMES`、`SESSION_HIGH_WATER_BYTES`、`SESSION_MAX_PAYLOAD_BYTES`。
- `browser`：`ViewerSocket.sendFrame?()`，`VIEWER_MAX_FRAMES`、`VIEWER_HIGH_WATER_BYTES`。
- `events/stream.ts`：`EVENT_HIGH_WATER_BYTES`；`EventSink` 多了可选的 `bufferedAmount` / `readyState`。

## E1 工程规范化：契约内核（oRPC）

设计：[工程规范化](../design/engineering-standardization.md) §2，规格：[工程规范化包](../design/platform/engineering-packages.md) §1；契约 §34。

做了什么：

- **依赖**：精确锁 `@orpc/*` 1.15.4——shared `@orpc/contract`，desktop `@orpc/server`、`@orpc/openapi`，web `@orpc/client`，根（生成器）`@orpc/openapi`、`@orpc/zod`。desktop 新增依赖 `@armadra/shared`（core 要 `implement` 契约；core 与服务器壳的 bundle 都把它打进去）。第三方声明已重新生成。
- **契约**（`packages/shared/src/contract/`）：`meta.ts`（`oc` 带元数据类型、`meta({ scope, workspaceKey?, since, contract, legacy?, deprecated?, trace? })`、`SCOPES` 与 core 的 `PERMISSIONS` 同一份）、`errors.ts` 在 E0-B 的注册表上加 `errors.pick()`、`isDefinedCode()`、`errorStatus()`、`json.ts`（`jsonValueSchema`）、`system.ts`、`workspaces.ts`、`settings.ts`、`index.ts`（`contract`、`ContractClient`、`ProcedureInput` / `ProcedureResult`、`contractEntries()`）。`contract.test.ts` 9 条守卫。
- **core 门面**（`core/http/rpc.ts`）：`registerProcedures(server, 域, handlers)` + `installContract(server, options)`（`main` 在所有域装好后调）。`/api/rpc/` 整段接管、只收 POST；带 `meta.legacy` 的 procedure 经 `OpenAPIHandler` 挂回旧路径（`CoreServer.contractRoutes`，方法与模式都对得上才接，其余照旧走路由表）；路由门中间件按 `meta.scope` / `workspaceKey` 走 `routeGuard()`，带旧路径的拿旧路径与旧体去问（成员的工作空间列表过滤照旧）；错误改写成 `{ code, message, requestId, details? }`（旧路径不带 `requestId`）；入参校验失败 `details.issues` 只给路径与消息；没人接住的异常与出参校验失败答 500 `internal`、原话只进日志与崩溃上报；`ARMADRA_RPC_VALIDATE_OUTPUT`（缺省按是否打包）、`ARMADRA_RPC_TRACE`。`core/http/errors.ts` 加 `CoreFailure` 与 `fail(code, message, details?)`（状态查注册表），`workspaces/support.ts` 的 `DomainError` 改继承它。路由表加 `/api/rpc/{procedure}`，`route-scopes.ts` 把 `/api/rpc/` 记进 `SELF_GUARDED` 并登记清单行。
- **试点**：`workspaces`（list / create / openDirectory / openRemote / update / delete / open）与 `settings`（get / update / local）的旧 handler 与 procedure 改为调同一份实现（`workspaceOperations`、`applySettingsPatch`）；`system.hello` / `ping` 由身份域登记（hello 多出 `procedures`、`heartbeatMs` 25 s、`sessionExpiresAtMs`、`version`）。协议 minor 2 → 3。导入（多部分）与执行主机改绑（409 结构化拒绝）留 REST。
- **页面门面**（`apps/web/src/api/client.ts`）：`createClient(source)`（`RPCLink`、异步头在 Cookie 模式带 CSRF、`fetch` 走源的 `fetch`；envelope 直接变 `RuntimeRequestError`，CSRF 被拒换一枚只重发一次）、`localClient()`、`isDefinedError(e, code?)`，再导出 `Source` / `localSource`。`api/workspaces.ts`、`api/settings.ts` 改成由 `client.ts` 注入客户端的工厂（`workspacesApiFor` / `settingsApiFor`），`runtimeApi` 的方法签名不变。
- **本机源**（`apps/web/src/api/source.ts`）：`Source { sourceId, httpBase, wsBase, credentials, fetch, WebSocket }` 与 `localSource`；`shell-transport.ts` 改为 `installLocalTransport(...)` 给本机源装 Bearer 与换票，**不再改写全局 `fetch` / `WebSocket`**。绕开 `request()` 的点逐个改经本机源：`assets.ts`（`<img>` 的 `blob:` 取图与编辑器下载）、编辑器媒体预览、`identity.ts`、`accounts.ts`、`gateway.ts`、会话搜索与改标题、终端后端探测与滚动、Agent 已读、白板栅格化取图、拖入图片测尺寸；五条流（事件、终端、实时同步、语言服务、浏览器画面）用 `localSource.WebSocket`。原生 App 的全局补丁（`installNativeTransport`）不动，留给 A1-1。
- **生成器**（`tools/contract/generate.mjs`）：`OpenAPIGenerator` + `ZodToJsonSchemaConverter` 出 `docs/contracts/core-openapi.json`（路径 `/api/rpc/…`、失败统一 `CoreError`、`x-armadra` 元数据、版本取契约最新 `since`），按 `meta.contract` 渲染 `core-json-api.md` 的 `rpc:begin` 块；`--check` 作为 `pnpm contract:check` 接进 `pnpm check`（`libs:build` 之后），用例 `generate.test.mjs` 进 `pnpm repo:test`。契约 §34.1–§34.5 写好。
- 错误码扫描（`api/error-codes.test.ts`）认 `http/errors` 的 `fail("…")`。探针 `ui-features` 的两处窄屏设置点击改为等抽屉停稳（`harness.dialogSettled`；快捷键那一场在 main 上同样失败）。

实测（macOS arm64，2026-10-06，已合 E0-A #128、A3-0 #132、A0-5 #134、#135）：

- `pnpm check` 通过（lint 0 error、284 warn，与 E0-A 基线相同）；`pnpm repo:test` 28 过；`pnpm release:test` 171 过；`pnpm ci:workflows` 5 个工作流通过；`pnpm notices:check` 通过。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4677 过 / 46 跳过，live 4 过，脚本 68 过；shared 340 过；`pnpm --filter @armadra/web test` 3492 过，`typecheck` 通过；server 87 过 / 4 跳过（`pnpm --filter @armadra/server build` 通过）。
- 新用例：`contract.test.ts` 11、`core/http/rpc.test.ts` 20（含一台装配好的 core 上回环会话调 `system.hello` / `ping`、无会话 401）、`core/contract/parity.test.ts` 12（三种答法：路由表原 handler、旧路径经 HTTP、procedure，成功按 `canonicalJson` 相等，失败码 / 状态 / 原话相等；另验 `meta.scope` 与路由表对旧路径的要求一致、`SCOPES` 与 core 词表一致）、`client.rpc.test.ts` 8、`shell-transport.test.ts` 补 2、`generate.test.mjs` 5。
- A 档 e2e：`node tools/ci/e2e.mjs --tier a` 12 项全过。修探针之前 `ui-features-e2e` 的两处窄屏点击失败（抽屉动画中按坐标点空）；合 main 后的一轮里 `agent-e2e-self-test` 的 11-coordinator 偶发失败（模型服务请求时序），单独重跑通过。
- `@orpc/*` 只在 `packages/shared/src/contract/`、`core/http/rpc.ts`、`web/src/api/client.ts`、`tools/contract/`：grep 确认；在 web、core、shared 别处各放一个违规 import，ESLint 三处都报 error，门面放行。

接口（供 E2 / A1-1 / A1-3）：

- 契约：`import { contract, type ContractClient, type ProcedureInput, type ProcedureResult, contractEntries, errors, meta } from "@armadra/shared"`；新域加 `contract/<域>.ts`，`index.ts` 的 `contract` 里登记，`meta.contract` 用预分配的 §N。
- core：`registerProcedures(context.server, "<域>", { verb: (input, call) => … })`，`call` 有 `requestId`、`identity`、`signal`、`request`、`procedures`；拒绝 `throw fail("conflict", "…", details?)`。
- 页面：`createClient(source)` / `localClient()`；`Source.credentials` 为 `{ mode: "bearer" | "cookie" | "none", access(), renew(rejected), csrf(), renewCsrf(rejected) }`；`Source.fetch`、`Source.WebSocket` 是带凭据的发送点；`installLocalTransport(transport | null)` 给本机源装 Bearer 传输。

没做 / 偏离规格：

- shared 没装 `@orpc/zod`：契约用 zod 4 的 Standard Schema 直接给上游，`@orpc/zod` 只在生成器里用（它 peer 依赖 `@orpc/server`，放进 shared 会把服务端包拖进页面依赖树），装在根。
- `installContract(server, options)` 不收 `impl` 参数：各域 `install()` 里 `registerProcedures` 登记，`main` 只调一次 `installContract`，`DOMAINS` 的签名不变。没登记的 procedure 答 501 `not_implemented`。
- `Source.credentials.csrf()` 是异步的（Cookie 会话刷新后内存里没有令牌时要先取），另加 `renewCsrf()`；`Source` 多 `fetch` 与 `WebSocket` 两个成员。
- 旧路径的失败不带 `requestId`（与迁移前逐字节同形，旧用例与外部脚本不受影响）；procedure 的失败带。
- 契约的输出形状写线上原样：本地工作空间不带 `executionHostId`，标识与时刻只校字符串；`workspaces.delete` 的 procedure 答 200 空值，旧路径照旧 204。
- 入参形状不对时，旧路径的原话由域的那句换成了 `Input validation failed` + `details.issues`（码与状态不变，对偶测试单列这一条）。
- `system.*` 由身份域登记：没装身份域（未统一的库）时答 501。`scope` 是 `identity:read`，服务器壳上的共享成员没有这项全局授权，调不了——与规格一致，E2 用到时再定。
- 全局补丁只在桌面壳拆了；原生 App 的 `installNativeTransport` 仍改写全局，留给 A1-1。

## A1-3 客户端源表与远程服务（`core/sources/`，迁移 0039，契约 §33）

设计：[平台实现规格 core 包](../design/platform/core-packages.md) §1；契约 §33。

做了什么：

- **迁移** `0039_client_sources.sql`：`client_sources`、`remote_services`，按规格原样；`migrations.lock` 已登记。两张表不存任何令牌。
- **契约**（`packages/shared/src/contract/sources.ts`）：`sources.*` 十二条（§33.1 源表 6 条、§33.2 远程服务 6 条），读 `settings:read`、写 `settings:write`，旧路径 `/api/sources/*` 挂回同一份实现；出入参就是协议包 `@armadra/platform-protocol/core-api` 的 schema 对象。错误码注册表加 `source_unreachable`（502）、`source_unauthorized`（401）、`source_offline`（503）、`fingerprint_mismatch`（400）、`credentials_invalid`（401）、`account_locked`（429）、`cloud_account_unlinked`（401），与协议包同拼法同状态；页面 `api/request.ts` 与 `i18n/errors.ts` 有中英文案。`contract.test.ts` 的节号规则放宽到 §31 起（§31–§33 预分配给平台设计）。
- **core**（`core/sources/`）：`store.ts`（SQL）、`secrets.ts`（`armadra-source-<id>` 的 `byOrigin`、`armadra-remote-<id>`，经 core 的 SecretStore 后端）、`http-client.ts`（出站 JSON，超时；按信任锚指纹钉扎：先在对端链里或 `/ca.crt` 找指纹相符的那张，再以它为唯一 CA 照常验链与主机名）、`remote-client.ts`（个人中转 `/.well-known/armadra-platform`、`auth.login / refresh / logout`、`me.sources`、`sources.assertion`）、`source-client.ts`（对别的 core：hello、配对码换票、`identity/pair`、`session/refresh`、经中继的 `cloud/login`，以原生 App 身份 `Origin: https://localhost` 走 Bearer 模式）、`service.ts`（业务、D27 选路、同一把刷新令牌串行旋转）、`index.ts`（装配：只 upsert 本机行；登记 procedure 与路由表回落 handler）。`DOMAINS` 里排在身份域之后。
- 路由表加 `/api/sources/*` 十一条路径，`route-scopes.ts` 加 `/api/sources` 一行；`net/outbound.ts` 登记 `cloudApi`、`sourceGateway`。
- RPC 门面（`http/rpc.ts`）：域经 `fail()` 有意答的 5xx（`source_unreachable`、`source_offline` 这类「对端不在」）不再记 `rpc call failed`、不报崩溃上报；没接住的异常照旧。
- 契约 §33 由占位补成正式内容（节号不变：§33.1 / §33.2 生成表、§33.3 形状、§33.4 凭据、§33.5 行为）；`architecture.md` 的域表与迁移表各加一行。

实测（macOS arm64，2026-10-06，已合 main 80f633bc（含 #137 协议包钉版））：

- `pnpm check` 通过（lint 0 error、285 warn，本包文件 0 warn）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4718 过 / 58 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/shared test` 340 过；`pnpm --filter @armadra/server test` 87 过 / 4 跳过，`pnpm --filter @armadra/server build` 通过；web `error-codes.test.ts` 与 i18n 用例通过。
- 新用例：`store.test.ts` 5（迁移约束、CRUD、`local` 不可删、顺序）、`service.test.ts` 19（对假个人中转与假 core：配对链接两种写法、配对码、指纹不符、`remoteAdd` 各错误码、SaaS 501、挂载全流程、刷新 401 回退断言、远程会话失效、并发换票不自撤、扫描全部答案与日志无 `refreshToken` / `password` / 令牌值）、`session-broker.test.ts` 5（直连通 / hostId 不符 / 1.5 秒超时 / 都不通 / 指定 via）、`http-client.test.ts` 8（真 TLS：链里或 `/ca.crt` 取锚、错指纹、公开 CA 配别人的叶证书、系统信任）、`routes.test.ts` 9（procedure 与旧路径同答、凭据只在数据目录 SecretStore、成员 403 且零外呼、远程不可达时本机与设置照常、启动零外呼）、`rpc.test.ts` 补 1。
- **对真个人中转联调**：armadra-cloud main（be36b78）`pnpm relay:personal`（https://127.0.0.1:8102，自签，首次自动建账号 `dev`），`ARMADRA_PERSONAL_RELAY=1 … vitest run src/core/sources/personal-relay.devstack.integration.test.ts` 5 过：错指纹 400 `fingerprint_mismatch` 且不留行、错口令 401 `credentials_invalid`、`remoteAdd` 成功（响应无口令与令牌，刷新令牌只在数据目录 `secrets/armadra-remote-<id>.token`）、`remoteSession` / `remoteSources` 旋转刷新令牌、`remoteRemove` 登出并清凭据。中继日志除启动两行外无请求记录。联调后已停掉中继。

接口（供 A1-4 / A2-3 / A3-2）：

- 页面：`createClient(source).sources.<动词>(…)` 或旧路径 `/api/sources/*`（契约 §33）。`sources.session` 答 `{ accessToken, accessExpiresAtMs, httpBase, wsBase, via, relayToken?, relayTokenExpiresAtMs? }`，页面据此组 `Source`；经中继时 HTTP 带 `Armadra-Relay-Token`、WS 用子协议 `armadra-relay.<relayToken>`。错误码按 `code` 取文案（`error.sourceUnreachable` 等已在 i18n）。
- core：`sourcesDomain()` 取 `SourcesService`（`list()`、`session(id, via?)` 等）；`SourcesStore.remoteByIssuer(issuer)` 认远程服务行。A2-3 要做的：`RemoteService.registered` 现在恒 `false`，登记表落地后在 `service.ts::remoteJson` 接上；`remoteRemove` 在删行前调 `identity.cloud.revoke`；core 一侧的 `POST /api/identity/cloud/login` 收 `{ assertion }`、答 `{ session: { …, native: { accessToken, refreshToken } }, principal: { displayName } }`——`source-client.ts::cloudLogin` 按这个形状读。
- A3-2：经中继的请求以 `Origin: https://localhost` + `Authorization: Bearer` + `Armadra-Relay-Token` 进隧道，准入按 Bearer 模式（§32）。
- 出站：`networkTransport`（`core/sources/http-client.ts`）可复用于别处的指纹钉扎请求；`normalizeFingerprint` / `normalizeOrigin` 是规范拼法。

没做 / 偏离规格：

- 契约的出入参直接取协议包（#137 钉的 vendored `@armadra/platform-protocol` 0.1.0）`core-api` 的 schema 对象，`contract.test.ts` 守着「是同一个对象」；协议包的入参只校类型，名称长度、地址、指纹格式这些检查在 `service.ts`（`bad_request`）。
- 远程服务客户端没用上游 `OpenAPILink`：core 里 `@orpc/*` 只许在 `http/rpc.ts` 一处，`remote-client.ts` 用自己的钉扎 HTTP 发普通 JSON（线上编码相同）。
- 规格的 `session-broker.ts` 没单独成文件：选路在 `service.ts::session`，对 core 的调用在 `source-client.ts`；用例文件仍叫 `session-broker.test.ts`。另多 `http-client.ts`、`secrets.ts` 两个文件。
- `since` 写 `1.3`，协议 minor 不升：新增的是 procedure，页面按 `system.hello` 的 `procedures` 判断有没有。
- `remoteAdd` 存的 `issuer` 是用户填的地址的规范拼法（不改写成中继自报的 `issuer`）；`accountHint` 是账号名。`local` 行 `hasCredentials` 恒 `true`。
- `mount` 与经中继的 `session` 只对假 core 验过：真 core 的 `cloud/login`（A2-3）与隧道（A3-2）还没合入，真联调留到那时。
- SaaS：`remoteAdd { kind: "saas" }`、`remoteDevicePoll`，以及对 `saas` 行的 `remoteSources` / `mount` / `remoteSession` 一律 501 `not_implemented`。

## A1-1 页面多源连接层

设计：[平台设计](../design/platform-saas-architecture.md) §5.4、§17.6–§17.7、D27，规格：[客户端包](../design/platform/client-packages.md) §1。

做了什么：

- **传输层按源发**（`apps/web/src/api/`）：模块级 `RUNTIME_URL` 退役，本机源的地址改为第一次用到时算（`api/local-runtime.ts` 的 `localRuntime()`，`import.meta.env` 只在这里读）；`sockets.ts` 的 `socketBase` 与 `initRuntimeSockets` 退役，流地址按源的 `wsBase` 现算（`runtimeSocketUrl` 认 `wss:`）。`request(path, schema, init, source = currentSource())`，CSRF 走源的 `credentials`；五个流地址构造器、`fileDownloadUrl`、`assetUrl` 同样可传源。`api/source.ts` 加 `currentSource()`（源表接上之前是本机）、`registerSource` / `knownSources` / `sourceForUrl`、`routedFetch` 与 `openSourceSocket`（按地址找所属的源）；RPC 门面加 `clientFor(source)`、`currentClient()`，`runtimeApi` 的契约域经当前源。`RUNTIME_VIA_SERVER_SHELL` 保留（它是页面本身的事实，界面按它收起桌面才有的页）。
- **绕开 `request()` 的点**：`<img>` 取图与下载按地址找 Bearer 源（`assets.ts` 的 `bearerSourceFor`，本机与挂载的源都认），编辑器媒体、白板栅格化、拖入图片测尺寸走 `routedFetch`；会话搜索与改标题、终端后端探测与滚动、Agent 已读（顺手修掉它绕过壳地址直读 `VITE_RUNTIME_URL` 的旧写法）、文件拖拽的作用域走当前源；终端、实时同步、语言服务、浏览器画面四条流走 `openSourceSocket`。
- **原生 App 的全局补丁退役**：`installNativeTransport` 删除，`mobile/entry.ts` 改为 `installLocalTransport(...)` 给本机源装 Bearer 与换票，全局 `fetch` / `WebSocket` 在三种壳里都不再被改写。`bearerFetch`、`ticketedWebSocket`、`sameOrigin`、`WS_TICKET_PROTOCOL` 从 `mobile/native-bridge.ts` 搬到 `sources/transport.ts`，`BearerTransport` 加 `extraHeaders()`（中继令牌头 `armadra-relay-token`）与 `extraProtocols()`（`armadra-relay.<令牌>`，对调用方的 `protocol` 不可见）。
- **凭据单例**：`identity.ts` 的 `access` / `refresh` / `accessExpiresAt` 收进一份 `SessionTokens`（`sources/session-tokens.ts`），明确是本机源的会话；远程源的访问只在各自的 `CredentialProvider` 里。
- **`apps/web/src/sources/`**：`types.ts`（`SourceDescriptor`、`SourceStatus`、`SourceAccess`、`CredentialProvider`、`SourceError` 与 `source_mismatch / source_unreachable / source_unauthorized / source_offline`）；`routing.ts`（`probeDirect` 匿名问直连 `hello` 1.5 秒、`hostId` 须相符，`pickRoute` 与中继取访问并行，直连优先）；`managed-socket.ts`（换票、中继子协议、4401 / 4403 / 4404、`lib/backoff` 前台 10 秒后台 30 秒、`online` 跳过退避、回前台探活 3 秒）；`credentials.ts`（按源缓存的 `createCachedCredentialProvider`，桌面 `createDesktopCredentialProvider` 经本机 core `POST /api/sources/{id}/session`）；`connection.ts`（`createLocalConnection` 一创建即 `ready`、不发请求；`createRemoteConnection` 选路 → 访问 → `system.hello` → `sourceId` 核对，401 续期一次重放、经中继再重取一次，`socket()` 换票与中继子协议，4403 / 4404 反映到源状态、再连上时叫醒）；`registry.ts`（本机永远第一、其余按 `orderIndex`，`hydrate` 换整批、单个源或加载器失败不挡本机，页面那张源表 `sourceRegistry()` 接管当前源与按地址找源；`loadSourcesFromLocalCore` 读 `GET /api/sources`）；`context.tsx`（`SourcesProvider`、`useSources`、`useSource`、`useCurrentSource`、`useSourceStatus`，不包 Provider 也能用）；`local.ts`、`index.ts`。

实测（macOS arm64，2026-10-06，基于 main dc0fec36）：

- `pnpm check` 通过（lint 0 error、285 warn，与 main 相同）。
- `pnpm --filter @armadra/web test` 3550 过（376 个文件），`typecheck` 通过；新用例：`sources/` 下 `transport` 8（从 native-bridge 搬来 6，新增中继头与子协议 2）、`routing` 10、`managed-socket` 13、`credentials` 6、`connection` 11、`registry` 10、`zero-config` 5。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4670 过 / 53 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/server test` 87 过 / 4 跳过；`apps/mobile` 类型检查通过。
- A 档 e2e：`node tools/ci/e2e.mjs --tier a` 12 项全过。
- 打包冒烟：本分支 `pnpm --filter @armadra/desktop dist` 后 `node tools/probes/packaged-smoke.mjs --no-real-cli` 全过（Gateway 首页、回环匿名 401、PDF 与视频、桌面 PATH 下的终端回显、渲染进程无控制台错误）。

接口（供 A1-2 / A1-4 / A1-5 / A3-4）：

- 发往某个源：`request(path, schema, init, source)`、`terminalWebSocketUrl(id, writer, source)` 等、`clientFor(source)`；省略是 `currentSource()`。`SourceConnection.source` 就是要传的那个 `Source`。
- 源表：`sourceRegistry()`（页面那张，`global`）或 `createSourceRegistry({ provider, connect, remote })`；`add(descriptor)` / `remove(id)` / `hydrate(loader)` / `setCurrent(id)` / `subscribe`。桌面与服务器壳：`registry.hydrate(loadSourcesFromLocalCore)`（A1-4 在合适的时机调；A1-1 不在启动时调，零配置不多发请求）。
- 凭据：实现 `CredentialProvider { getAccess(id, via), refresh(id, via), invalidate(id) }`，或给 `createCachedCredentialProvider(exchange)` 一个换票函数（A1-5 手机钥匙串、云页面）。
- 状态：`connection.status`（`idle / connecting / ready / offline / unauthorized / waitingForSource`，`lastError.code` 为上面四个码或 core 的码）、`useSourceStatus(connection)`；4404 等待后 `connection.connect()` 成功即叫醒该源的流（A3-4 的 `sourceOnline` 接这里）。
- 流：`connection.socket(path, { protocols, onMessage, … })` → `ManagedSocket`（`send`、`wake`、`close`、`state`）。

没做 / 偏离规格：

- `api/*` 的自由函数没有逐个加可选的 `source` 第一参数：源加在传输层（`request()`、流地址、`clientFor`），省略即当前源；按调用点补源随 A1-2。
- 现有五条流的重连循环没有改用 `ManagedSocket`（事件流在 E2 改写中，其余四条换成按地址找源的 `WebSocket`，凭据与票照旧）；`ManagedSocket` 供控制面与新流用。
- 流的换票走 REST `POST /api/identity/ws-ticket`：契约里还没有 `identity.wsTicket` procedure（E3-7 的范围）。
- 本机源不问 `system.hello`（`hello` 为 `null`）：零配置不多发请求，且服务器壳上的共享成员没有 `identity:read`。远程源的 `hello` 同样要这项授权，成员身份挂载的源会落到 `unauthorized`，待 E2 / A1-3 定。
- D27 的「重连、`online`、回前台时重新探直连」只在 `connect()` 时做；已经走中继的流重连时不重新选路，留给 A3-4。
- 手机（钥匙串 + 远程服务）与云页面（`browser-cloud`）的 `CredentialProvider` 只有接口与缓存基座，实现随 A1-5 与 §7。
- 远程直连的 `hello` 探测是跨来源请求，要对方 Gateway 的来源白名单与本机壳的 CSP `connect-src` 放行（A1-4 动态 CSP）；不放行时探测失败、退回中继。
- 改到了 E2 的 `api/client.ts`（只去掉 `RUNTIME_URL` / `initRuntimeSockets` 的再导出，加 `clientFor` / `currentClient`，`runtimeApi` 经当前源）；`api/events.ts` 没动。

## A2-3 云登录与登记（`core/identity/cloud/`，迁移 0040，契约 §31）

设计：[平台实现规格 core 包](../design/platform/core-packages.md) §2；契约 §31。只实现个人中转这一个签发方，SaaS 只留形状（总计划 §12）。

做了什么：

- **迁移** `0040_cloud_identity.sql`：`cloud_registrations`（按规格，多一列 `label`）、`identity_invitations` 加 `max_uses` / `uses`、`identity_invitation_uses`（A4-1 用，消费逻辑未动）；`migrations.lock` 已登记。表里没有凭据。
- **契约**（`packages/shared/src/contract/cloud.ts`，§31.1）：`identity.cloud.{login, register, revoke, status, bind, trustedOrigins}`，出入参取协议包 `core-api` 的同一份 schema；`login` 是唯一的匿名 procedure，只经旧路径。错误码注册表加 `cloud_not_registered`、`cloud_assertion_invalid`、`cloud_assertion_replayed`、`cloud_already_registered`、`cloud_issuer_mismatch`、`invitation_invalid`、`registration_token_invalid`、`protocol_unsupported`（与协议包同拼法同状态），页面 `api/request.ts` 与 `i18n/errors.ts` 中英文案；审计动作文案进 `i18n/security.ts`。
- **RPC 门面**（`http/rpc.ts`）：`registerProcedures` 收嵌套的实现树，契约可以有子域（`identity.cloud.<动词>`）。
- **core**（`core/identity/cloud/`）：`store.ts`（SQL）、`source-key.ts`（Ed25519，私钥 PKCS8 只在 SecretStore `armadra-cloud-source-key`，所有 issuer 共用，`kid = sourceId = hostId`；源 JWS 与 `signBytes` 给隧道）、`jwks.ts`（缓存在行里，`kid` 未知时同一 issuer 每 10 分钟最多取一次，取不到照样用缓存）、`assertion.ts`（`alg` / `typ`、按 `iss` 找登记、验签、`aud = hostId`、5 分钟偏差、寿命 ≤ 重放窗口，最后才记 `jti`）、`login.ts`（映射走 oauth 凭据 `provider = cloud:<sha256(iss) 前 16 位>`；带邀请建成员一笔事务；`link.invitationId` 必须是那张邀请；组织默认角色逐条授予；按 `(iss, sub)` 每分钟 5 次；`bind`）、`register.ts`（登记 / 撤销 / 状态 / 可信来源，`CloudRelay` 接口与空实现）、`cloud-client.ts`（`platform.info`、`sources.register`、JWKS，复用 `sources/http-client.ts` 的钉扎发送点）、`http.ts`（`/api/identity/cloud*` 原样路由，自己认会话并按契约 scope 判）、`service.ts` + `index.ts`（`installCloud`、`cloudDomain()`）。身份域装配时装它（与会话、账号、加固同一份）。`AccountsService.registerExternalWithInvitation`；`LoginMethod` 加 `cloud`；审计 `cloud.login`、`cloud.bind`、`cloud.register`、`cloud.revoke`、`invitation.accept.link`。
- **源表**（A1-3 留的接口）：`RemoteService.registered` 读登记表；`remoteRemove` 删行前先撤销本机对它的登记。
- `net/outbound.ts`：加 `cloudJwks`、`relayTunnel`（A3-2 用），`cloudApi` 用途补上登记。路由表与 `route-scopes.ts` 登记 `/api/identity/cloud*`。契约 §31 由占位补成实施契约（§31.1 生成表、§31.2 登记、§31.3 断言换会话），§33 两处「随 §31 落地」改为已接上；`architecture.md` 域表与迁移表各加一行。

实测（macOS arm64，2026-10-06，基于 main 7025d0bd（含 #136、#137、#138））：

- `pnpm check` 通过（lint 0 error、285 warn，与 A1-3 基线相同，本包文件 0 warn）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4770 过 / 63 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/shared test` 348 过；`pnpm --filter @armadra/server test` 87 过 / 4 跳过，`pnpm --filter @armadra/server build` 通过（bundle 只带用到的常量，不带测试向量）；`pnpm --filter @armadra/web test` 3492 过。
- 新用例：`cloud/store.test.ts` 5、`assertion.test.ts` 14（协议包 valid / guest / with-link 通过，expired / wrong-aud / wrong-alg 与另四种令牌拒，重放、篡改、未登记 / 已撤销、时间边界、离线验签、`kid` 未知刷新一次与 10 分钟节流、同 `kid` 别的钥）、`source-key.test.ts` 5（源 JWS 与 `source-jws.jwt` 逐字相等、持久化、并发只生成一把、写失败可重来）、`identity/identity-vectors.test.ts` 5（口令策略、scrypt、锁定、会话常量与协议包相等；scrypt 与令牌哈希向量逐字节相等）、`cloud.test.ts` 19（假个人中转：登记成功 / 426 / 400 / 501 / 401 透传 / 公钥集指到别处 / 502、成员 403 且零外呼、撤销后断言 `cloud_not_registered`、可信来源、未映射 401、绑定后换 owner 原生会话且能用、重放 / 篡改 / 受众 / 过期、带邀请建号与 `invitation.accept.link`、链接邀请不符、组织默认角色、停用 403、按 sub 限流 429、Cookie 来源、login 不经 RPC）、`errors.scan.test.ts` 1（本域 `fail("…")` 的码都在协议包注册表、状态一致）、`sources/service.test.ts` 补 2、`contract.test.ts` 补 3、`outbound.test.ts` 补 1。
- **对真个人中转联调**：armadra-cloud main（be36b78）`pnpm relay:personal`（https://127.0.0.1:8102，自签，账号见 `.data/personal/dev.env`），`ARMADRA_PERSONAL_RELAY=1 ARMADRA_PERSONAL_RELAY_FP=… vitest run src/core/identity/cloud/personal-relay.devstack.integration.test.ts` 5 过：错注册令牌 401 `registration_token_invalid`；`/v1/sources/registration-tokens` 取的令牌 → `register` 200、状态与 `sources.list` 的 `registered: true` 正确、中继目录里有这台 core；中继签的断言 → `bind` → `cloud/login` 换到 owner 会话且能用，同一张再用 401 `cloud_assertion_replayed`；改了 `sub` 的断言 401 `cloud_assertion_invalid`；`links.create` → 匿名 `links.accept` 的访客断言 + core 邀请令牌 → 建成员、记 `invitation.accept.link`；`revoke` 后新断言 401 `cloud_not_registered`、`registered` 回到 `false`。A1-3 的联调 5 条同轮也过。中继日志除启动一行外无请求记录；联调后已停掉中继，并从中继目录撤掉了临时 core。

接口（供 A3-2 / A1-4 / A4-4）：

- 页面：`createClient(source).identity.cloud.<动词>(…)` 或旧路径 `/api/identity/cloud*`（契约 §31）。错误码按 `code` 取文案（`error.cloudNotRegistered` 等）。
- A1-4「分享本机」：`sources.remoteSession { serviceId }` 取远程服务访问令牌 → 页面直接 `POST <issuer>/v1/sources/registration-tokens` → `identity.cloud.register { issuer: remote.issuer, registrationToken, label }`（`issuer` 用远程服务行里那一份，这样 `registered` 亮、登记按它的指纹钉扎）→ `identity.cloud.status`（`sourceId`、`tunnel`）；分享链接：core 签邀请（`/api/identity/invitations`）→ `POST <issuer>/v1/links { kind: "source_invite", sourceId, invitationId, … }` → `<url>#<secret>.<邀请令牌>`；停用 `identity.cloud.revoke { issuer }`。owner 自己经中继进来之前先 `identity.cloud.bind { assertion }` 把远程服务账号映射到自己。
- A3-2：`cloudDomain()` → `CloudService`：`attachRelay({ start, stop, status })`（装好之后登记 / 撤销 / 状态经它）、`registrations()` / `registration(issuer)`（`trustedOrigins`、`relayOrigins`、`mode`）、`signSourceJws(issuer)`、`signBytes(data)`（握手 `auth`）、`revoke({ issuer })`（`source_revoked` 时调）。`installCloud` 的 `orgDefaultRole` 现在缺省 `null`，设置 `cloud.orgDefaultRole` 落地时在 `identity/index.ts` 接上。隧道来的请求要 `markBearerTransport(raw)`，`cloud/login` 才按原生会话答。
- A4-4：`cloudDomain()?.register / revoke / status` 与 HTTP 同一份实现。

没做 / 偏离规格：

- `cloud_registrations` 多一列 `label`（状态要答 `label?`，规格的表里没有）。
- 旧路径不经 RPC 门面的 OpenAPI 回挂：`/api/identity/` 是身份域的原样路由，先于契约旧路径；这里登记更长的原样前缀 `/api/identity/cloud`，自己认会话、按契约 scope 判，调的是与 procedure 同一份实现。`login` 不在 RPC 上登记（答 501），`system.hello` 的 `procedures` 里也就没有它。
- 契约用了子域（`identity.cloud.*`）：RPC 门面原来只认 `域.动词` 两段，改成按路径放。
- 登记的入参没有指纹：对远程服务的请求按「远程服务」表里同一 issuer 的指纹钉扎，没有那一行就用系统信任。`saas` 模式登记答 501。登记要有 owner（桌面壳没有请求主体时取 owner；还没配过对答 403）。
- 撤销只在本机：中继侧 `DELETE /v1/sources/{id}` 要远程服务的 owner 会话，留给页面或 A4-4 在需要时调；撤销后中继仍会签断言，但本机一律 `cloud_not_registered`。
- `bind` 多一个审计动作 `cloud.bind`、已映射给别人答 `409 conflict`；按 `sub` 的限流 `login` 与 `bind` 共用一个桶。`login` 的来源地址桶用「只有失败扣」那一档（与配对、刷新相同），不是每次扣。
- 云登录不要求本机 TOTP：身份由远程服务证明（与口令登录不同）；断言寿命额外封顶 10 分钟（重放窗口）。
- 组织默认角色的设置键与 `cloud.tunnel` 事件属于 A3-2；邀请多次使用的消费逻辑属于 A4-1（本包只建列）。
- `relayTunnel` 的地址按 `https://` 记（外呼表的扫描只收 `https` / `smtp`），连接时升级为 `wss`。
- `since` 写 `1.3`，协议 minor 不升（同 A1-3）。
