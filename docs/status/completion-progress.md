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
- `pnpm libs:build && pnpm -r --if-present test`：shared 372、server 98 / 4 跳过、mobile 10、push-relay 9 全过；desktop 5208 过 / 74 跳过，live 4 过，脚本 73 过；web 首轮只有 i18n 用量检查认不出拼接的键，改成字面量后通过。desktop 的 `contract/parity-push.test` 一条本机在负载 290 上下时连跑 3 次都 `ECONNRESET`，本包没碰 push 域，看 CI。`pnpm --filter @armadra/web typecheck` 与 `pnpm check` 通过。

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
- `pnpm libs:build && pnpm -r --if-present test`：shared 372、server 98 / 4 跳过、mobile 10、push-relay 9 全过；desktop 5208 过 / 74 跳过，live 4 过，脚本 73 过；web 首轮只有 i18n 用量检查认不出拼接的键，改成字面量后通过。desktop 的 `contract/parity-push.test` 一条本机在负载 290 上下时连跑 3 次都 `ECONNRESET`，本包没碰 push 域，看 CI。`pnpm --filter @armadra/web typecheck` 与 `pnpm check` 通过。

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
- 下载把整个文件读进内存再存；很大的文件会占内存。（已由「核心流与浮层安全区」一节改成流式，只剩 Bearer 源且没有保存对话框时仍经 Blob。）
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
- 浏览器画面没有把 Chromium 的帧确认推迟到发出之后，跟不上时由 coalesce 丢旧帧，Chromium 照常编码。（已由「核心流与浮层安全区」一节补上。）
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

实测（macOS arm64，2026-10-06，基于 main 7025d0bd（含 #136、#137、#138）；合入 main c4e3a97f（#139，只动页面）后重跑 `pnpm check` 与 web 用例）：

- `pnpm check` 通过（lint 0 error、285 warn，与 A1-3 基线相同，本包文件 0 warn）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4770 过 / 63 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/shared test` 348 过；`pnpm --filter @armadra/server test` 87 过 / 4 跳过，`pnpm --filter @armadra/server build` 通过（bundle 只带用到的常量，不带测试向量）；`pnpm --filter @armadra/web test` 3492 过（合入 #139 后 3550 过）。
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

## A1-5 手机多连接（`apps/web/src/mobile/` + `apps/mobile`）

设计：[客户端包](../design/platform/client-packages.md) §4，[总计划](../design/platform-implementation-plan.md) §12（个人中转优先；SaaS 只预留）。

做了什么：

- **原生桥多会话**（`mobile/native-bridge.ts`、`apps/mobile/src/bridge.ts`）：`getSessions / setSession / removeSession(sourceId, origin?)`、`getRemotes / setRemote / removeRemote`、`peek(origin)`（不带凭据取一次信任锚指纹，什么也不存）；`pin` 改为每个来源各存一份。会话一个连接一份（键 `sourceId` + `via`），远程服务的刷新令牌一份（键 `serviceId`），都只在钥匙串 / Keystore，连接表（无凭据）在页面本地存储 `armadra.sources`。旧的单会话方法（`getSession / clearSession`）删除，不留兼容。
- **iOS**：`SecretStore` 加 `list(prefix:)`，新 `ConnectionVault`（会话 / 远程服务 / 钉扎的校验与读写，写入前校验形状，键与内容对不上的读回时丢掉）；插件 `peek`（`AnchorFetch` 分开给握手链、`/ca.crt` 与「系统是否本来就信」）、`pin` 多来源、`armadra://join` 深链。**Android**：`SecureStore.names(prefix)`、纯 JVM 的 `ConnectionRules`（同一套校验）、`PinningWebViewClient` 按来源找钉扎、`peek`、`join` 深链。
- **手机的 `CredentialProvider`**（`mobile/credentials.ts`）：直连用钥匙串里的刷新令牌向 Gateway 轮换；经中继先用远程服务的刷新令牌取云会话（每次旋转都写回），要断言与中继令牌，再用存着的刷新令牌经中继轮换源会话，被拒才用断言 `cloud/login` 重登；源不在线答 `source_offline`，云会话失效答 `source_unauthorized`。钥匙串是刷新令牌唯一的真相（身份面轮换后也写回它）。
- **连接表与添加流程**：`mobile/connections.ts`（同一个源两种到达合并一行，两条路都在，选路直连优先）；`mobile/connect.ts` 的 `createRelayEnrollment`（个人中转：地址 → 取指纹、自签的要人确认才钉 → `auth.login` → `me.sources` 勾选 → 每台 `assertion` → `cloud/login` → 钥匙串；分享链接 / 二维码：`links.accept` → `cloud/login` 带邀请令牌，直接挂载）、`forgetConnection`、`openConnection`；`mobile/cloud-client.ts`（远程服务的一小块客户端，错误归成 `{code, message}`）；`mobile/join-link.ts`（`<issuer>/j/<id>#<秘密>.<邀请令牌>` 与 `armadra://join`）。
- **入口**（`mobile/entry.ts`）：按连接选路 → 把这一路的地址与凭据装给本机源（`setNativeRuntimeBase`、`installLocalTransport`；经中继时每个请求带 `armadra-relay-token`、每条流带 `armadra-relay.<令牌>`），令牌到期前与回前台时提前续；切换连接 = 记下选中的再重载。选中的连不上回连接页并带原因。`identity.ts` 的钥匙串读写按「当前连接」键（`setNativeConnection`）。
- **界面**（`ConnectScreen.tsx` + 新 `ConnectRelay.tsx`）：连接列表（点一行进入、行尾移除要确认）+ 「添加连接」三种方式（扫码、配对链接、个人中转），SaaS 没有入口；个人中转三步：表单、核对指纹、选择主机。只用 `Button / Item / Checkbox / Field / Input / Badge` 与 `ResponsiveAlertDialog`，文案进 `i18n/mobile-connect.ts` 中英同步，展示页 `mobile` 分区加了五个样本。

实测（macOS arm64，2026-10-06，基于 main 86271782，含 #139、#138、#140）：

- `pnpm check` 通过（lint 0 error；本包文件 0 新 warn）；`pnpm --filter @armadra/web test` 3589 过（379 个文件），`typecheck` 通过；`pnpm --filter @armadra/mobile test` 10 过、`typecheck` 通过。新用例：`credentials` 7、`connections` 4、`join-link` 5、`connect` 多连接 11（三种添加、同一个源两种到达合并一行、移除、钉扎失败不登录）、`entry` 5、`ConnectScreen` 8、`native-bridge` / `bridge` 各补多会话。
- iOS：`swift test`（`ArmadraNativeKit`）26 过；`xcodebuild build -sdk iphonesimulator`（`CODE_SIGNING_ALLOWED=NO`）BUILD SUCCEEDED。本机 CoreSimulator 版本低于 Xcode，模拟器起不来，没有在模拟器里跑 App。
- Android：`armadra-native-core` 用 `javac` + JUnit 直接跑 20 个用例全过（含新 `ConnectionRulesTest`、`DeepLinkTest` join）。本机只有 JDK 25（Gradle 8.14 不认）且没有 Android SDK，`:app` 没有编译，插件 Java 只经人工核对。
- 对本机个人中转联调（armadra-cloud main be36b78，同一份代码、自选数据目录与端口 8112、自签 TLS，用完已停）：`/ca.crt` 的 DER SHA-256 与启动日志指纹一致；`auth.login` 口令错答 `credentials_invalid`、对了拿到 `refreshToken`；`auth.refresh` 旋转、旧令牌再用被撤销；`me.sources` 空；`links.accept` 假链接答 `link_invalid`；整条添加流程（指纹确认 → 钉扎 → 登录 → 目录）走到「没有可连接的主机」。没有注册任何 core，断言 → `cloud/login` 这一段只在 mock 的 fetch 里验过（核对了请求头 `Armadra-Relay-Token`、请求体与写回钥匙串）。
- 真浏览器（Chrome 无头，设计展示页 `mobile` 分区）390 宽、明暗两主题、中英各一套：`target/a1-5-screenshots/`（`1-connection-list`、`2-add-connection`、`3-personal-relay`、`4-verify-fingerprint`、`5-choose-hosts`，另有 `0-legacy-link` 现有链接页对照）；`node tools/probes/design-showcase.mjs --only=mobile --width=390`：对比度 dark 最低 3.25、light 最低 3.07，控制台无 error。

接口（供 A1-4 / A4-3p / A3-4）：

- `createMobileCredentialProvider({ bridge, describe })` / `mobileCredentialProvider()`；`serviceIdOf(issuer)`（`personal:<host>`）。
- 连接表：`loadConnections / upsertConnection / removeConnection / activeConnection / setActiveConnection`（`mobile/connections.ts`）。
- 管理页入口：把页面地址改成 `#connections`（A1-4 的设置页可直接跳）；`armadra://join?link=&issuer=&s=` 进连接页直接挂载。
- 新增失败原因（`mobileConnect.error.*`）：`credentials`、`locked`、`link`、`offline`、`noSources`、`address`。

没做 / 偏离规格：

- 规格里的 `bridge.ts` 沿用现有的 `native-bridge.ts`；连接表放页面本地存储而不是 Capacitor Preferences（页面不依赖 `@capacitor/core`，与原来记 Gateway 来源的做法一致）。
- 登录与指纹的先后：规格写「`auth.login` → 指纹确认」，实现是先 `peek` 指纹、人确认并 `pin`，再登录——自签的中继在钉扎之前连 TLS 都过不了，登录请求发不出去。系统本来就信任的证书与已钉过同一枚的跳过确认。
- 页面其余部分仍只认「当前连接」（本机源指向选中的那一路，切换要重载），没有把手机接进 A1-1 的 `SourceRegistry` 同时挂多个源；那要等 A1-2 的查询键按源区分与 A1-4。
- 画布里没有加「连接」入口（设置页归 A1-4）；现在从 `#connections` 或深链进。
- SaaS：没有入口；设备码流与 `armadra://cloud` 没做（类型与 `saas` 分支保留）。
- `me.sources` 的名字只是标签，离线的主机不能勾；断言的 `online: false` 在挂载时再校一次。
- 访客（分享链接）的云会话刷新令牌同样存进钥匙串的远程服务那一份；若同一个中转下已经有账号登录，会被覆盖成访客的（一个签发方一份）。
- 钉扎的时间窗：`peek` 与 `pin` 是两次取证书，中间被换证书时 `pin` 的指纹核对会失败（不自动信任）。

## A1-2 查询键与 store 加源

设计：[客户端包](../design/platform/client-packages.md) §2。

做了什么（`apps/web/src/`）：

- **键的约定**（`sources/scope.ts`）：查询键 `["src", sourceId, ...]`（`sk(...)` 取当前源、`srcKey(id, ...)` 指定源、`srcPrefix()` 给手写数组展开）；store 键 `${sourceId}:${id}`（`scoped` / `unscoped`）。`activeSourceId()` = 事件派发期间是产生事件的那条连接所属的源（`withSource`），其余时候是当前源；零配置只有本机源，键只多一个 `local` 前缀，行为不变。
- **查询键**：带 `workspaceId` / `boardId` 的全部查询（工作空间、画板、会话、Git、文件、自动化、GitHub、工作流、协调器、投递、交接……）与它们的失效、`setQueryData`；`use-git-gutter` 的下标顺延。`useWorkspaces()`（`app/workspaces-query.ts`）对每个就绪源各发一次，合并成 `{ sourceId, workspace }[]`；`useWorkspacesQuery()` 仍是当前源那一份，两者同缓存。
- **canvas-store**：加 `sourceId`，`setWorkspace(workspace, sourceId?)` 按 `(sourceId, workspaceId)` 判同一个工作空间。
- **事件流**（`api/events.ts`）：`Map<"${sourceId}:${workspaceId}", Connection>`，同一个源里同时只订一个工作空间（与原来一致），不同源各一条；连接发往 `Source.WebSocket`。订阅回调多收 `sourceId`；`onWorkspaceEvent` 默认只收当前源的帧，按源记账的订阅者传 `{ allSources: true }`；连接 / 失权回调带 `sourceId`。`dispatchWorkspaceEvent(event, sourceId)`。
- **store**：`agent/status-store`（`hydrate(sessions, workspaceId, sourceId)`）、`drive-store`、`delivery-store`（`edgeKey` 带源）、`dependency-store`（读数记 `sourceId`）、`subagent-store`、`acp/store` 的键都带源前缀；读它们的点（节点头、徽标、小地图、通知、终端、命令面板）同步改。
- **实时协同**：`realtime/session.ts` 的板按 `(sourceId, boardId)` 认，`startRealtime({ source })`、`realtimeActive(boardId, sourceId?)`、`stopRealtime(boardId, sourceId?)`。
- **偏好**（`app/preferences/sources.ts`）：已打开 / 收起 / 置顶的工作空间、置顶的画布落盘为 `{ sourceId, workspaceId | boardId }[]`，上次的工作空间与画布为 `{ sourceId, … }`；内存里是 `openWorkspaceKeys` 等带源前缀的键，`idsInSource` 取某个源里的 id。旧的裸 id 在 store 创建前一次性迁到 `local`（`migrateSourceScopedPreferences`，幂等）。
- **`hello.hostId` → `sourceId`**：`identityHelloSchema` 把线上的 `hostId`（core JSON 不动）解析成 `sourceId`；`permits` 的选项改叫 `executionHostId`，调用方传 `hello.sourceId`。

实测（macOS arm64，2026-10-06，基于 main 含 A1-1）：

- `pnpm check` 通过（lint 0 error、285 warn，与 main 相同）。
- `pnpm --filter @armadra/web test` 3564 过，`typecheck` 通过。
- A 档 e2e：`node tools/ci/e2e.mjs --tier a` 12 项全过（第一轮缺 `spawn-helper` 执行位与 server / push-relay 产物，补上后对失败的 6 项重跑通过）。

新增用例：`sources/scope.test`（键约定、`withSource`、同名节点在两个源里的 store 键不碰撞）、`api/events.test`（两个源各开一个工作空间事件连接各一条、换工作空间只拆同源的）、`app/workspaces-query.test`（两源合并、零配置只发一个请求且同缓存）、`app/preferences/sources.test`（旧键迁移、幂等、损坏值）、`realtime/session.test`（同名板在两个源里不混）。

没做 / 偏离规格：

- 与「当前源」无关的查询（设置、用量、账号、Agent 列表等）没有加源前缀：它们不带工作空间 id，A1-4 切换当前源时需清掉非 `["src", …]` 的缓存（本包没有 UI 能切源，现在不会出问题）。
- `coordinator`、`dependency-store` 的读数仍经 `runtimeApi`（当前源）：对非当前源的工作空间发请求要改成 `clientFor(source)`，随 A1-4 接上多源界面时补。
- `WorkspaceTree` 仍只列当前源的行（偏好里已按源存）；按源分组是 A1-4。
- 实时协同的「这块板走不走实时」复核仍走当前源的 `runtimeApi`。

## A3-2 出站中继隧道（`core/relay/`，契约 §32）

设计：[平台实现规格 core 包](../design/platform/core-packages.md) §4；契约 §32。中继一侧的线上行为按 armadra-cloud 的 cloud-api §7、§8、§10、§11。

做了什么：

- **隧道客户端**（`core/relay/`）：`streams.ts` 的 `TunnelDuplex`（两级窗口记账，按 64 KiB 切块，`END` / `RST`，`remoteAddress` 取 `OPEN.remoteIp`、`encrypted = true`、`armadraOrigin` 取 `OPEN.clientOrigin`）；`nodes.ts`（`GET /v1/sources/me/relay` 带源 JWS，令牌缓存 50 分钟、被拒即丢，偏好节点 → 权重排序，失败换下一个，答 `410` 即 `source_revoked`）；`client.ts` 的 `TunnelClient`（`hello` → `challenge` → `auth`（源私钥签 `challengeSigningInput`）→ `ready`；`protocol_unsupported` 停下不重连、`source_revoked` 本机撤销登记、`tunnel_token_*` 丢令牌、其余退避；收 `PING` 回 `PONG`，自己每 `heartbeatMs` 发 `PING`、两次无 `PONG` 重连；`GOAWAY` 不退避立即换隧道、旧的排空或 `graceMs` 后关；退避 `min(60 s, 1 s × 2^n) × (0.5 + 随机)`；流数超 `maxStreams` 答 `RST refused`；`wss://` 按远程服务的 CA 指纹钉扎，`ws://` 只在 `ARMADRA_RELAY_ALLOW_INSECURE=1`）。
- **准入**（`admission.ts`，挂在 `createListener({ admitted: true, gate })`）：与 Gateway 的 Bearer 模式等价——回环专用路径 403；来源以 `OPEN.clientOrigin` 为准、请求头不一致 403、须在可信来源或原生 App 两个来源之内；没有来源只放行 `/health` 与身份匿名面；匿名面以无授权成员身份跑；`POST /api/identity/ws-ticket` 由隧道自己签票；其余要 Bearer，升级要 `armadra-ticket.*`，拒绝 401。会话绑在中继来源（`relayOrigins[0]`）上，放行前改写 `Origin` 并 `markBearerTransport`，`cloud/login` 经隧道答 `session.native`、不发 Cookie。
- **`http/server.ts`**：`createListener` 加 `gate`（交接点自己的门：来源、凭据、CORS 由它定，可自答 WS 票；升级同样先过它）。
- **装配**（`index.ts`）：每个有效登记一条隧道，`RelayService` 挂到 `cloudDomain().attachRelay`（登记起、撤销停、状态读它）；`main.ts` 在回环监听之后 `startAll()` 且不等，退出时先关隧道；状态变了在工作空间事件流上发 `cloud.tunnel { issuer, state }`（发给正被看着的画布，不进 outbox）。
- **设置**：`cloud.relay.enabled`（缺省 `true`，翻转经新的 `SettingsStore.onChange` 当场停 / 起）、`cloud.relay.preferredNode`，存在本机那一半（`LOCAL_PATHS` 加 `cloud.relay`）；`cloud.orgDefaultRole`（`viewer` / `editor` / `operator` / `driver` / `null`，缺省 `null`），在 `identity/index.ts` 接给云登录。两份 `completion-settings.ts` 与共享层 zod schema 同步。
- 其它：`sources/http-client.ts` 导出 `pinnedAnchor`；`CloudService.fingerprint(issuer)`；契约 §32 由占位补成实施契约（§32.1–§32.5），架构域表加 `core/relay/`，开发指南登记 `ARMADRA_RELAY_ALLOW_INSECURE`。

实测（macOS arm64，Node 26，2026-10-06，基于 main 86271782（含 #140）；合入 main 8f20daf7（#141、#142，只动页面与手机）后重跑 `pnpm check` 与 web 用例）：

- `pnpm check` 通过（lint 0 error，本包文件 0 warn）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4820 过 / 72 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/server test` 87 过 / 4 跳过，`pnpm --filter @armadra/server build` 通过；`pnpm --filter @armadra/shared test` 348 过；`pnpm --filter @armadra/web test` 3550 过（合入 #141、#142 后 3603 过），`typecheck` 通过。
- 新用例：`relay/streams.test` 8（经假中继 GET / 带体 POST / chunked / WS 回显、窗口耗尽只发一个流窗口后停、`WINDOW` 后续发且一字节不少、`bufferedAmount` 含隧道里积压的字节、隧道断开流随之结束并退避重连、`maxStreams` 答 `RST refused`）、`relay/client.test` 14（握手与签名被验、`protocol_unsupported` 停且不重连、`source_revoked` 与取令牌 `410` 都撤销本机登记、`tunnel_token_expired` 重取令牌、心跳超时重连、回 `PONG`、`GOAWAY` 在一分钟退避下仍立即换隧道且旧隧道 1000 关、退避公式、中继不可达时登记立即返回且回环 `/health` 与 `/api/workspaces` 200、开关停起、撤销即断、节点排序、签名输入与黄金向量逐字相同）、`relay/admission.test` 14（可信来源 + Bearer 放行且 CORS 只回客户端来源、无 Bearer 401、回环会话进不来、来源不可信 403、头与 `OPEN.clientOrigin` 不一致 403、回环专用路径 403、无来源只放行匿名面、原生 App 来源、预检、隧道签票换事件流与票只能用一次、无票 401 / 无来源 403、票要 Bearer、`cloud/login` 经隧道答原生会话且令牌可用、`cloud.tunnel` 事件）、`relay/frames.test` 12（协议包隧道黄金字节解码再编码逐字节相同）、设置与 `onChange` 用例 2。
- **对真个人中转联调**：armadra-cloud main（be36b78）的 `personal serve`（https://127.0.0.1:8102，自签，账号见 `.data/personal/dev.env`），`ARMADRA_PERSONAL_RELAY=1 ARMADRA_PERSONAL_RELAY_HOME=<armadra-cloud> vitest run src/core/relay/personal-relay.devstack.integration.test.ts` 9 过（修掉用例里漏收首帧的问题后连跑 4 次都过）：真 core（`run()`）经源表加远程服务（钉指纹）→ A2-3 的 `register` → 隧道 ready；中继断言绑定后经中继 `cloud/login` 换原生会话、经中继刷新、`GET /api/workspaces`、回环专用路径 403、无 Bearer 401；经中继的事件流收到本机发布的事件；经中继开终端（tmux）收发 `echo`；经中继的实时板与回环那一端双向互通；中继令牌失效 4401 后换令牌与票重连、用过的票 401；中继 SIGTERM 重启后隧道 7–9 秒内自己重连、期间回环照常；本机撤销后经中继的流随即被关（约 0.3 秒）、HTTP 503 `source_offline`；中继侧撤销后隧道被关，重连时令牌被拒、取令牌 `410`，本机登记跟着撤销。联调后中继已停，测试 core 在中继目录里全部撤销。

接口：

- **给 A3-4（页面 relayed 源）**：经中继访问用 `sources.assertion` 答的 `relayBaseUrl` + `Armadra-Relay-Token`（WS 子协议 `armadra-relay.<jwt>`），`Origin` 须是可信来源（issuer 自己、`identity.cloud.trustedOrigins` 加的）或原生 App 来源；`POST /api/identity/cloud/login { assertion }` → `session.native`（还有 `csrfToken`）；之后 `Authorization: Bearer`；刷新 `POST /api/identity/session/refresh`（Bearer = 刷新令牌 + `x-armadra-csrf`）；WS 先经中继 `POST /api/identity/ws-ticket` 换票，子协议 `armadra-relay.*` + `armadra-ticket.*`；长连接 4401 续期换票重连、4403 失权、4404 源离线。设置页：`identity.cloud.status` 的 `registrations[].tunnel`、事件 `cloud.tunnel`（共享层 `workspaceEventSchema`）、设置键（共享层 `cloudSettingsSchema`、`CLOUD_ORG_ROLE_CHOICES`）、`lastError.code` 取值见契约 §32.5（文案按码进 i18n）。
- **给 A4-4（服务器壳登记）**：服务器壳的 `run()` 用同一份 `DOMAINS`，隧道已在里面；`cloudDomain()?.register / revoke / status` 登记即起隧道、撤销即停；`relayDomain()`（`core/relay`）：`start / stop / status / statusAll / startAll / stopAll / close`；源私钥在 SecretStore（服务器壳的 `file-encrypted`）；探针连明文中继用 `ARMADRA_RELAY_ALLOW_INSECURE=1`。

没做 / 偏离规格：

- 节点选择没有延迟探测：偏好节点 → 权重 → 原顺序（个人中转只有一个节点）。
- 会话绑定的来源规格没写，取 `relayOrigins[0]`（缺省 issuer）：经隧道签的会话只在隧道上有效，回环与 Gateway 的会话也进不了隧道。隧道用自己的一份 WS 票表，不与回环共用。
- 来源被拒（不可信、与 `OPEN` 不一致、没有来源却碰受保护的路径）答 403，凭据被拒答 401；规格「拒绝一律 401」指后者。
- `cloud.relay.*` 存在本机那一半（`worker-settings.json`），`cloud.orgDefaultRole` 跟着账号走。
- `installRelay` 放在 hook 服务之前（Gateway 仍是最后一个），隧道真正连中继在 `run()` 第 5 步之后。
- `cloud.tunnel` 是工作空间事件（发给正被看着的画布、不进 outbox），没有加进 `WORKSPACE_EVENT_TYPES` 那张契约 §5 的清单（同 `board.comment`）。
- `hello.capabilities` 报空数组（中继不读）。
- 夹具位置与命名按仓库习惯：假中继在 `relay/fake-relay.fixture.ts`；联调用例是 `relay/personal-relay.devstack.integration.test.ts`（`ARMADRA_PERSONAL_RELAY=1` 才跑，不探测 dev-stack）。`sequence-http-roundtrip.bin` 按帧做解码再编码的逐字节比对，没有把 core 的回答与夹具逐帧比（回答带 `Date` 头，不确定）。
- core 自己的 4401（访问令牌 15 分钟到期）没在联调里等，联调验的是中继令牌 4401 后的换令牌与换票；core 到期复核与回环、Gateway 同一条路（`http/server.ts`），已有用例覆盖。语言会话与浏览器画面两条流没有经真中继跑，机制与终端、事件流、实时板相同（发送队列按 `bufferedAmount` 判拥塞，见 `streams.test`）。
- 中继侧撤销后，重连时中继先以 `tunnel_token_invalid` 拒（令牌的 `jti` 随源撤销），core 丢令牌、退避一次后取令牌得 `410` 再撤销，约 1–3 秒。

## A1-4 「远程服务」设置页、分享本机与侧栏按源分组

设计：[客户端包](../design/platform/client-packages.md) §3；总计划 §12（只开放个人中转与自托管直连，SaaS 不出现入口）。

做了什么：

- **core（契约 §33.6 追加）**：`sources.remoteLogout`（尽力 `auth.logout`、删凭据、留行，重新登录只要再输口令）；`remoteAdd` 与「地址 + 配对码」的 `addDirect` 没给指纹、系统又不信任对端证书时答 `400 fingerprint_mismatch`，`details.fingerprint` 是对端信任锚指纹（`http-client.ts::presentedAnchor`：链里最末那张，只发叶证书时取 `/ca.crt` 里签了它的那张），页面请人核对后带着它重调。
- **桌面壳**：CSP `connect-src` 按 core 源表动态放行（远程服务 issuer、源的 `baseUrl` / `relayOrigin`，各给 `https` 与 `wss`，形状不对的值丢掉）；主会话 `setCertificateVerifyProc` 对系统不信任、但链里有登记指纹、逐级验签、主机名与有效期都对的放行（与 core 钉扎同一定义）。壳经 core 读 `GET /api/sources`：起窗口前一次、页面发 IPC `app:sources-changed`（不带数据）后一次；答 `{ reload }`，多出新来源时页面回到设置这一页重载（CSP 只在文档载入时生效）。
- **页面**：`panels/settings/pages/RemoteServicesPage.tsx`（nav `remote`，在「本机」之后，ownerOnly）——远程服务：个人中转添加（地址、账号、口令，首次核对指纹）、登录 / 登出 / 移除、「分享中」徽标、停用分享；已挂载的源：本机行、自托管直连（配对链接或地址 + 配对码，同样核对指纹）、从远程服务挂载、连接状态、断开 / 移除。`panels/settings/ShareDialog.tsx`：开始 / 停用分享、隧道状态（5 秒轮询）、按工作空间 / 权限 / 有效期（1、7、30 天）生成分享链接、二维码（复用 `QrImage` / lean-qr）、复制、停用、生效中的链接。`api/remote-services.ts` 是调用面；`sidebar/SourceGroups.tsx` 侧栏按源分组；`sources/bootstrap.ts` + `app/use-sources-bootstrap.ts` 启动时只在「挂过源」时读源表（零配置不多发请求）。`i18n/remote.ts` 中英同步；`MESSAGE_BY_CODE` 加远程服务答的 `rate_limited`、`unauthenticated`、`session_expired` / `session_revoked`、`source_access_denied`、`source_revoked`、`limit_reached`。

实测（macOS arm64，2026-10-06，基于 main 86271782）：

- `pnpm check` 通过；`pnpm --filter @armadra/web test` 与 `typecheck`、i18n 守卫通过；`pnpm libs:build && pnpm --filter @armadra/desktop test` 通过（数字见 PR）。
- 新用例：core `service.test.ts` 补 4（首次指纹、给了指纹或系统信任不改写、配对码路径、`remoteLogout`）、`http-client.test.ts` 补 3（真 TLS 下 `presentedAnchor`）；壳 `shell-core/remote-trust.test.ts` 5（源表 → 放行与钉扎、CSP 注入防护、真 CA 链钉扎的正反例）；页面 `api/remote-services.test.ts` 9、`RemoteServicesPage.test.tsx` 5、`sources/bootstrap.test.tsx` 6（零配置不请求、侧栏分组与离线灰显）。
- **真 Electron 端到端**（开发构建 + 独立个人中转 `https://127.0.0.1:8112` 自签，临时 HOME / 数据目录、文件密钥后端）：添加个人中转 → 页面显示的指纹与中继启动日志一致 → 确认后壳重载页面回到远程服务页 → 登出（行留着）→ 重新登录（不再问指纹）→ 分享本机（页面经 CSP 放行与指纹钉扎直接调中继取注册令牌，本机登记成功，中继目录里有这台机器，`registered: true`）→ 生成链接（`https://127.0.0.1:8112/j/<id>#<secret>.<邀请令牌>`，中继上有、匿名 `links.get` 认得、本机有对应邀请）→ 停用链接（中继撤销、本机邀请作废；窄屏再来一次）→ 停用分享（登记撤销）→ 移除；全程无控制台错误、无被 CSP / 证书拦下的请求。联调后停掉了中继。

接口（供 A4-3p / A3-4 / A1-2）：

- 链接：`<issuer>/j/<linkId>#<secret>.<core 邀请令牌>`（`api/remote-services.ts::shareLinkUrl`；邀请令牌本身是 `<invitationId>.<secret>`，所以片段按第一个 `.` 切：前面是链接 secret，后面整段是邀请令牌）。二维码就是这条链接（`QrImage`）。
- 页面：`addDirectSource` / `addPersonalRelay` 答 `{ kind: "confirm", fingerprint }` 或 `{ kind: "done" }`；`presentedFingerprint(error)`；`remoteFetch(access, path, schema)` 直接调远程服务；`notifyShellSourcesChanged()` 与 `sources/bootstrap.ts` 的 `applySourceTable` / `reloadIntoSettings`——挂载类入口（如 `mountByLink`）成功后照这三步收尾。
- 侧栏：`sidebar/SourceGroups.tsx`——当前源在「项目」里，其余每个源一组（`data-source-group`，本机也是），就绪的源列出工作空间，点一行 `registry.setCurrent(sourceId)` 后 `openWorkspace(workspace, sourceId)`。
- A1-2 留下的三项已接上：换当前源清掉不带源前缀的查询（`app/use-sources-bootstrap.ts::useSourceSwitchCacheReset`）；依赖、协调器、实时复核发往读数所属的源（`api/source.ts::sourceById`、`sources/scope.ts::activeSource`）；侧栏按源分组。

没做 / 偏离规格：

- core 追加 `sources.remoteLogout`（规格没有，页面「登出」要它）与首次指纹的 `details.fingerprint`（规格写「响应里带指纹」，core 原来没有）。
- 桌面壳加了按源表指纹的证书钉扎：自签的个人中转与 Gateway 本地 CA 否则过不了 Chromium；服务器壳托管的页面在用户自己的浏览器里，自签远程服务仍要用户信任 CA（或用 ACME），其 CSP 也未动态化。
- CSP 只在文档载入时生效：新加来源后页面重载一次，回到设置的远程服务页。
- 本机邀请经 `/api/identity/invitations`（Bearer），没有 procedure；邀请必须指向一个工作空间，所以分享对话框要选工作空间。`maxUses` 未传（A4-1 未合）。从「生效中的链接」停用时只撤远程服务那条链接，本机那张邀请等过期（列表不带 `invitationId`）。
- 隧道状态靠 5 秒轮询 `identity.cloud.status`，没订阅 `cloud.tunnel` 事件（A3-2 未合，实测一直是「未连接」）。
- 已挂载源不支持拖动排序（`sources.update.orderIndex` 未接界面）；SaaS 设备码流程不出现入口。
- 没有复用手机的 `#connections` 连接页组件：手机直接调远程服务、凭据在钥匙串，桌面经本机 core 代管凭据（`sources.*`），流程与状态不同；共用的只有指纹分组显示（`groupFingerprint`）与二维码（`QrImage`）。
- 窄屏与宽屏切换时设置对话框换外壳、内容重新挂载，刚生成的链接会从界面上消失（链接仍在，可在「生效中的链接」停用）。

## A4-1 邀请多次使用 + A4-4 服务器壳 CLI（个人中转部分）

规格：[核心包](../design/platform/core-packages.md) §5、§6；总计划 §12：A4-4 只做个人中转的登记与分享链接。

做了什么：

- **A4-1**（`core/identity/accounts*.ts`，契约 §10 追加一段，节号不变）：`0040` 里已有 `max_uses`、`uses` 与 `identity_invitation_uses`，**没有新迁移**。`POST invitations` 收 `maxUses`（1–1000，其它 400），答案与列表多 `maxUses`（一次性为 `null`）与 `uses`。兑换（`accept`、口令注册、云登录）在同一笔事务里 `UPDATE … SET uses = uses + 1 WHERE consumed_at_ms = 0 AND uses < max_uses` 加 `INSERT OR IGNORE identity_invitation_uses`，用满时收口 `consumed_*`；同一个人重复兑换幂等（不加计数，用满之后也成功，过期与作废不行）；一次性邀请的路径不变。
- **A4-4**（`apps/server/src/cloud.ts`、`cli.ts`、`main.ts`）：`cloud register | revoke | status | login` 与 `invite --cloud-link`。CLI 是另一个进程，所以经数据目录里 0600 的私有通道（`core-control.sock`）取票、在 core 回环上换 Bearer（与桌面壳、探针同一条路），再调 `/api/identity/cloud*`、`/api/sources/*`；`cloud login` 与 `invite --cloud-link` 另用 core 持有的远程服务会话直接问个人中转（`networkTransport`，按指纹钉扎）要注册令牌、建链接。输出沿用服务器壳的中文单行与 `--output json`；退出码 0 / 1 / 2（用法），core 没起来是 69。
- **容器入口**（`docker/entrypoint.sh`）：`ARMADRA_CLOUD_ISSUER` 与 `ARMADRA_CLOUD_REGISTRATION_TOKEN` 都给时，后台等 serve 就绪（退出 69 就重试，最多 2 分钟）再 `cloud register`，已登记跳过，失败只记一行；令牌只走环境变量，并从传给 serve 的环境里去掉。可选 `ARMADRA_CLOUD_FINGERPRINT`、`ARMADRA_CLOUD_LABEL`。

接口：

- 命令：`armadra-server cloud register --issuer URL (--token T | --token-stdin | $ARMADRA_CLOUD_REGISTRATION_TOKEN) [--fingerprint FP] [--label L]`；`cloud revoke --issuer URL`；`cloud status [--output json]`；`cloud login --issuer URL --account A [--fingerprint FP] [--label L] (--password-stdin | $ARMADRA_CLOUD_PASSWORD | 终端提示)`；`invite --cloud-link --issuer URL (--workspace ID | --group ID) [--role R] [--max-uses N] [--expires 7d] [--label L]`，打印 `https://<中继>/j/<id>#<密>.<邀请令牌>`。都对运行中的服务器壳（同一个 `--data-dir`）操作；Windows 没有私有通道，不可用。
- core：旧路径 `POST /api/identity/cloud/register` 另收可选 `fingerprint`（契约 §31.2）——令牌登记自签个人中转没有口令可走 `sources.remoteAdd`，先把信任锚钉进「远程服务」表再登记，失败不留钉；procedure 的入参不变。

实测（macOS arm64，2026-10-06，基于 main cabe898a）：

- `pnpm check`、`pnpm libs:build && pnpm --filter @armadra/desktop test`（408 文件 / 4825 用例通过，11 文件 / 72 用例按设计跳过）、`pnpm --filter @armadra/server test`（98 通过，4 跳过）与 build 全绿。
- 新增用例：`accounts.test.ts` 多次使用 4 条（20 个并发用 `maxUses = 5` 的邀请恰好 5 个成功、同人幂等、用满后用过的人仍成功、过期与作废、越界 400、一次性不变）；`cloud.test.ts` 钉扎登记 1 条；`apps/server/src/cloud.test.ts` 13 条（参数解析、每条命令对假 core 的调用、口令与令牌不出现在输出、退出码、中继拒绝时撤掉刚建的邀请）。
- 真跑个人中转：armadra-cloud 主目录 `pnpm relay:personal`（自签 TLS，`127.0.0.1:8102`），服务器壳 `serve` 用临时数据目录。`cloud login`（口令经标准输入、指纹钉扎）→ 隧道 `ready` → `cloud status` → 再 `login` 幂等跳过 → `invite --cloud-link --max-uses 3 --expires 2d` 出链接、库里 `max_uses = 3` → `cloud revoke` → `status` 为空；另走令牌路径（清掉远程服务行，`--token` 来自环境变量 + `--fingerprint`）登记、`ready`、再登记跳过、撤销。服务器壳与中继日志里没有口令、令牌或链接密。实例已停、临时目录已删。

没做 / 偏离规格：

- 规格里的 `invite`（不带 `--cloud-link`）此前并不存在，这里只实现 `--cloud-link`，不带它是用法错误；`invite` 需要 `--workspace` 或 `--group`（core 的邀请必须指向一处）。
- 规格的 `cloud register` 没有指纹参数；自签中继没有它就无法钉扎，所以加了 `--fingerprint` 与旧路径的 `fingerprint` 字段。
- `cloud login` 的注册令牌由 CLI 向中继取（core 没有这条外呼），所以没有新增 core 外呼登记。
- 在还没有管理员的服务器上，CLI 取票换会话会成为第一个 owner（与首张配对票同一规则）；正常流程是先由管理员配对。
- 没有真 Docker 起容器跑 entrypoint（只做了 `sh -n` 语法检查与 CLI 侧的重试语义）；容器自动登记留待 server-container-e2e 覆盖。

## E2 工程规范化：控制面 WebSocket `/api/ws`

设计：[工程规范化](../design/engineering-standardization.md) §3，规格：[工程规范化包](../design/platform/engineering-packages.md) §2；契约 §35。

做了什么：

- **契约**（`packages/shared/src/contract/`）：`workspaces.events`（出参是事件迭代器：工作空间事件或位置帧 `{ type: "cursor", cursor, floor, watermark }`）；`meta.backpressure`（`drop-oldest` / `coalesce` / `resubscribe`，订阅必须写、普通调用不写，`contract.test` 守）；注册表加 `snapshot_required`、`cursor_ahead`（409）、`overflow`（503）、`limit_reached`（429）。协议 minor 4。
- **core 升级层**（`core/http/ws-control.ts`）：路由表加 `/api/ws`（`identity:read`，成员也有）。子协议报了 `armadra-rpc.v1` 就回选它（票不回选，`server.ts` 的 `handleProtocols`），没报的以 4409 关；二进制帧、不是 peer 消息的文本帧 4400；超过 `maxFrameBytes` 4413（`ws` 硬上限放宽一倍，免得被 1009 抢先）；每一帧在升级时的身份下跑并先复核会话，会话没了 4403；core 停机先以 1001 关（`CoreServer.close()`）。票、Cookie、4401 到期与 4403 授权变化的复核、`ws` 层 25 秒心跳都是 `server.ts` 给每条流的那一套（A3-0），没有另写。
- **RPC 门面**（`core/http/rpc.ts`）：同一棵契约树经 `@orpc/server/ws` 的 `RPCHandler.upgrade(socket, { context })` 挂到控制面，身份由升级层认好放进 context；控制面上的错误改成注册表里的码交给上游编码（不是 HTTP 的 envelope）。订阅（写了背压策略的 procedure）只经控制面，HTTP 上调答 405；每连接 256 个，超了答 `limit_reached` 并以 4429 关；每个订阅包一层 `SendQueue`（A3-0，新增 `QueuedValue` 让它排还没编码的值）有界队列：1024 项、连接缓冲过 1 MiB 排队，`resubscribe` 拥塞时停止从实现里取、满了 `overflow`。`RpcCall.lastEventId` 交给实现，`withEventId()` 给每项带事件 id。
- **事件流迁入**（`core/events/procedure.ts`）：`workspaces.events` 的事件 id 是 outbox 序号；起点 `lastEventId` > `cursor` > `now`；监听与读水位在同一拍挂上，补发只发到那时的水位、按页懒读，之后接实时，不漏不重；每次（重新）订上先发位置帧；`snapshot_required` / `cursor_ahead` / `not_found` 在订阅开始前拒绝；授权收回以 `forbidden` 结束这一条；实时缓冲满了以 `overflow` 结束。扇出加 `listen()`，控制面订阅照样算「在看」（资源采样、Agent 状态按它发）。旧路由 `WS /api/workspaces/{id}/events` 保留到 E4。
- **页面**：`api/ws.ts` 的 `ControlChannel` 是上游 peer 客户端要的 WebSocket 形状，架在源层的 `ManagedSocket` 上（经 `SourceConnection.socket("/api/ws")`：换票走源的凭据、本机源经 `local-runtime`、经中继带中继子协议、`lib/backoff` 退避前台 10 秒后台 30 秒、`online` 与回前台跳过退避、回前台探活 3 秒）；它补的是：内层断了先置回「连接中」再发 `close`（订阅据此由重试插件重订），4403 / 4409 / 4429 与续不上凭据停下并告诉页面，可见时每 30 秒 `system.ping`、3 秒没回就 `reconnect()`（`ManagedSocket` 新加的一个公开方法）。`api/client.ts` 加 `controlClient(connection)`（`@orpc/client/websocket` + 重试插件：订阅断线立刻重订并交回 `lastEventId`，续不上的码交给调用方；不用上游内建重连）、`errorCode()`。`api/events.ts` 改为订 `client.workspaces.events`，保留 A1-2 的源维度：每个源里一个工作空间一条订阅（键 `${sourceId}:${workspaceId}`），每个源一条控制面连接（源表里的 `SourceConnection`，没登记的源按本机的做法包一个），事件带上所属的源（`onWorkspaceEvent` 缺省只收当前源，`{ allSources: true }` 收所有源）；位置帧当作「订上了」的上升沿，`forbidden` 或那个源的控制面 4403 视为授权收回，`snapshot_required` / `cursor_ahead` 落下连接状态后从现在重订；对外 API 不变。关闭码文案 `i18n/connection.ts`（中英），4409 / 4429 停下时 toast 提示怎么办（`app/use-control-notices.ts`）。
- **路由门**（`identity/route-access.ts`）：全局的 `identity:read` 要求按主体快照判（每个登录主体都有，成员也有），成员因此能升级 `/api/ws`、调 `system.hello` / `ping`；其余全局要求照旧只有 owner。E1 留下的「成员调不了 `system.*`」随之解决。
- **探针**：`server-e2e` 的撤销共享一步改看控制面上成员的事件订阅以 `forbidden` 结束（原来看旧路由那条 socket 以 4403 关）——事件流已迁到 `/api/ws`，连接本身不因一块画布的授权收回而关，这是规格要的行为。
- **终端**：`bufferedAmount` 过 4 MiB 暂停读 PTY 已由 A3-0 做完（`terminal/socket.ts` 的 `pause` 队列），本包没有再动。
- **契约 §35**：35.1 升级层与子协议（含 peer 帧的线上样子）、35.2 关闭码表、35.3 心跳与重连、35.4 `workspaces.events`（生成块）、35.5 背压。生成器认订阅：kind 记 `subscription`，出参列事件的 `type`，`x-armadra` 带 `backpressure` 与 `transport: "/api/ws"`。

实测（macOS arm64，Node 26.10.0，tmux 3.7c，2026-10-06，已合 main 60e404f8：E1 #136、A0-4 #137、A1-3 #138、A1-1 #139、A2-3 #140、A1-5 #141、A1-2 #142、A3-2 #143、A1-4 #144、A4 #145）：

- 新用例：`http/ws-control.test` 13（回选子协议、缺子协议 4409、准入拒绝 401、坏帧 4400、超限 4413、订阅走 HTTP 405、停机 1001、第 257 个订阅 `limit_reached` + 4429、取消不占名额、会话没了 4403、授权收回 4403、scope 不放行只拒这一次、心跳两次无 pong 断开）；`events/procedure.test` 5（位置帧与序号 id、断开期间的事件带 `lastEventId` 由 outbox 补齐且与没断的一致、`snapshot_required` / `cursor_ahead` / 404、慢客户端 3000 × 8 KiB 停读后 `overflow`、重订之后一帧不少、取消后监听释放）；`route-access.test` 补 1；web `api/ws.test` 9、`api/client.control.test` 2（断线后在新连接上重订并带 `last-event-id`、`snapshot_required` 不重订）、`api/events.test` 改写 13（含两个源各一条订阅、一个源断线只落下那个源）、`use-access-lost.test` 改写 2、`managed-socket.test` 补 1；`contract.test` 补 1、`generate.test.mjs` 补 1；错误码扫描认同目录导入的 `fail`。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4858 过 / 65 跳过，live 4 过，脚本 68 过；`pnpm --filter @armadra/web test` 3637 过，`typecheck` 通过；`pnpm --filter @armadra/server test` 98 过 / 4 跳过；`pnpm repo:test` 29 过；`pnpm check` 通过（lint 0 error、285 warn，与 main 相同）。
- `node tools/ci/e2e.mjs --tier a`（合 #143 / #144 之后）：13 项全过（acp、agent-e2e-self-test、core-terminal-lifecycle、core-terminal-smoke、design-showcase、gateway、push、realtime、remote、server、ui-features、workflow、ws-mux）；其中 `agent-e2e-self-test` 的 11-coordinator 一次偶发失败（模型服务请求时序，E1 记过同一处），单独重跑通过。合 #145（身份与服务器壳 CLI，不碰控制面）之后重跑了 `pnpm check`、服务器壳全部与 core 的 http / events / identity 用例。
- 新探针 `ws-mux-e2e`：两台都订上；杀 core（SIGKILL）3 秒同端口重启、前后都有事件，两台对着 outbox 一帧不少一帧不重（各重连 5–6 次；从杀到补齐 3.5–10.6 秒，含 3 秒停机，余下是前台退避的抖动）；第二台断网 30 秒期间收到 0 帧，恢复后 162 ms 补齐；第一台切到后台、core 停 8 秒再起、产生 3 帧，回到前台 152–154 ms 收齐（预算 3 秒）；全程 23 帧不少不重，控制台无错误。
- `tools/probes/server-perf.mjs`（30 终端 + 6 事件流 + 2000 对象实时板），main 80f633bc 与本分支同机交替各跑 3 次取中位数：

| 指标               |              main |            本分支 |
| ------------------ | ----------------: | ----------------: |
| 事件扇出 p95       |            2.2 ms |            3.2 ms |
| 终端吞吐           |        25.0 MiB/s |        25.1 MiB/s |
| 单会话完成 p95     |         1192.8 ms |         1190.2 ms |
| 建会话 p95         |           50.2 ms |           56.6 ms |
| 实时板批量         |          162.6 ms |          159.0 ms |
| 实时单字段更新 p95 |            0.8 ms |            0.8 ms |
| RSS 稳态 / 峰值    | 254.1 / 269.2 MiB | 258.5 / 272.8 MiB |

事件扇出 p95 单次在 main 上 1.7–3.2 ms、本分支 2.3–3.6 ms 之间跳（容差 10 ms），扇出走的是旧路由，本包在这条路上只多了一次空的监听表查找；建会话 p95 两边都在 50–74 ms 间跳。RSS 两边都超出 `server-perf-baseline.json` 的 darwin-arm64 基线（与 A3-0 记的一样），基线没有重录。

偏离规格之处：

- `workspaces.events` 的出参多一种位置帧：没有它，订上之后还没收到任何事件就断开的订阅没有 `lastEventId`，重订只能从 `now` 起，中间那段就丢了；页面也拿它当「订上了」的上升沿（会话列表、Agent 镜像据此重读）。
- 订阅中途与调用的错误是上游的错误形状 `{ defined, code, status, message, data }`（码与状态按注册表、内部错误不外泄），不是 HTTP 的 `{ code, message, requestId, details }`：envelope 是写在 HTTP 响应体上的，peer 帧里换成它上游客户端就解不开。
- `resubscribe` 不是单纯的「队列满了抛 `overflow`」：拥塞时门面停止从实现里取（补发懒读，所以停在原处），实时一段由实现自己的 1024 项缓冲兜底；否则慢客户端的每一次重订都会在补发阶段再溢出一次。
- 订阅数按连接数（规格写法），不是工程规范化 §3.3 的「按身份」。
- `Source.ws` 没有加成 `Source` 的成员：A1-1 合入后控制面的流按 `SourceConnection.socket()` 取（`ManagedSocket` 已经做了换票、中继与退避），`controlClient(connection)` / `controlChannel(connection)` 按连接缓存。
- 契约 `workspaceEventSchema` 有三处透传的 `unknown`（`agent.approval.request`、ACP 帧的附加字段），`contract.test` 对这一条放行 3 处、只许减少，收紧留给对应域的 E3 迁移。
- 老 core（没有 `/api/ws`）不回落到旧事件流路由：本机源与本仓库同版本；远程源的版本协商归 A1-1 的 `system.hello`。

没做 / 限制：

- 只有事件流迁入控制面；资源采样（`coalesce`）等订阅留给各域的 E3。
- 控制面 4403 时页面按「当前工作空间的授权收回」处理（离开并提示），不区分是整条会话失效还是这块画布的共享被收回。
- 浏览器发不了协议层 ping，前台的半开连接最长要等到下一次 30 秒的 `system.ping` 才发现；回到前台时立刻探一次。

接口（给 A1-1 / A3-4）：

- 契约：订阅 = 出参 `eventIterator(...)` + `meta.backpressure`，契约节号按域分配；实现交出一个 `async function*`，每项 `yield withEventId(value, String(seq))`（`core/http/rpc.ts`），`call.lastEventId` 是重订时客户端最后收到的 id，`call.signal` 在客户端取消、连接断开或门面溢出时 abort；先决条件不满足就在交出迭代器之前 `throw fail(...)`。
- core：`core/http/ws-control.ts` 的 `CONTROL_PATH`、`CONTROL_PROTOCOL`、`CLOSE_*`、`MAX_ITERATORS`、`ITERATOR_MAX_FRAMES`、`ITERATOR_HIGH_WATER_BYTES`、`ControlConnection`；`core/http/stream-queue.ts` 的 `QueuedValue`；`WorkspaceEventStream.listen(workspaceId, (frame, seq) => …)`；测试用 `core/http/peer.fixture.ts`（直接说 peer 帧的客户端）。
- 页面：`api/events.ts` 的 `WorkspaceEventTransport` 按源订（`subscribe(source, workspaceId, signal)`、`onDrop(source, …)`、`closedWith(source)`），`setWorkspaceEventTransport()` 测试换来源；`controlClient(connection)`（`connection` 是 `sourceRegistry().get(id)` / `.current()` 或任何有 `socket(path, options)` 的对象）、`controlClosedWith(connection)`、`onControlDrop(connection, listener)`、`errorCode(error)`；`api/ws.ts` 的 `ControlChannel`、`controlChannel(connection)`、`onControlClosed(listener)`、`closeMessageKey(code)`、`CLOSE_*`；`ManagedSocket.reconnect()`。

## E3-2 工程规范化：files 域迁到契约（契约 §37）

设计：[工程规范化](../design/engineering-standardization.md) §2，规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-2）；契约 §37。

做了什么：

- **契约**（`packages/shared/src/contract/files.ts`）：`files.*` 共 16 条——`list`、`info`、`read`、`write`、`create`、`rename`、`trash`、`trashList`、`restore`、`index`、`search`、`watch`、`unwatch`、`version`、`reveal`、`importLocal`；全部绑 `workspaceId`，出参复用页面已有的 `api/files.ts` / `search.ts` schema，入参只校形状（路径、版本、权限的判断仍在域里，所以旧路径与 procedure 拒绝的码与原话一样）。`since` 为 1.5，协议 minor 4 → 5。
- **core**：`files/routes.ts` 把十二个 `file*` 路由的实现收成一份 `operations`，旧 handler 先解析查询串或体、再调它；`registerProcedures(server, "files", …)` 登记同一份。`reveal`（`files/reveal.ts`）与 `importLocal`（`imports/routes.ts`）各自带装配参数，由各自模块登记同一棵 `files` 子树。旧路径的校验顺序（先查工作空间与权限、再解析体）不变；搜索的取消沿用连接断开，procedure 另接调用信号。
- **页面**：`api/files.ts` 改为 `filesApiFor(rpc)`、`api/search.ts` 改为 `searchApiFor(rpc)`，经 `clientFor(currentSource())`，调用点的签名不变，答案仍过页面自己的 schema；`fileDownloadUrl` 与多部分上传 `importFiles` 留在 REST（按当前源拼地址）。
- **契约 §37**：§37.1 生成块（`pnpm contract`），§37.2 登记留在 REST 的字节流（多部分上传、下载、`Range`、`<img src>`、整库导入）与 `unwatch` 的旧路径说明。

实测：

- `pnpm check` 通过（含 `contract:check`、lint、三处 typecheck、repo:check、notices）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：412 个文件通过、11 个跳过（4882 条通过、72 条跳过）。新增 `core/contract/parity-files.test.ts` 26 条：旧路径、procedure、原 handler 三者逐字节相等，覆盖只读各操作、越界 / 不存在 / 不是目录的拒绝、写的版本冲突与「只带 expectedSize」、只读工作空间 403、条目新建改名回收站恢复的完整序列（含 409 / 400 / 404）、搜索（含过长 glob 的 400）、监听登记与注销（含读权限被关的 403）、reveal、按路径导入、scope 与路由表一致。
- `pnpm --filter @armadra/web test`：390 个文件、3644 条通过；`typecheck` 通过。新增 `api/client.files.test.ts`（procedure 路径与体、`signal` 交给请求、REST 例外、换源后请求跟着去）。
- A 档（`node tools/ci/e2e.mjs --tier a --only ui-features-e2e,server-e2e,remote-e2e`）：三项通过；`ui-features-e2e` 里的编辑器（§37）、文件树右键菜单（§38）、项目搜索取消（§38）都在其中。

没做：

- 控制面（`/api/ws`）上不需要订阅，files 没有事件流；`file.changed` 仍走工作空间事件（§35.4）。
- `unwatch` 没有旧路径条目：契约层的 `DELETE` 只读体，旧的 `DELETE …/file-watch?path=&nodeId=` 继续由路由表答；E4 删旧路径时一并处理。
- `cancelled`（499）、`reveal_failed`（500）没登记进错误码注册表：注册表只收被 `coreError` / `fail` 字面量使用的码，这两个由 `DomainError` 抛出。

接口（给 E3 其它包）：同 E1；`files` 子树由三个模块分别 `registerProcedures` 登记，做法是 `handlers as unknown as DomainHandlers<"files">`（与 `identity.cloud` 同一做法）。

## A3-4 页面的 `relayed` 源与中继托管页面（Web 端操作）

设计：[客户端包](../design/platform/client-packages.md) §5；平台设计 §17.3、§17.6、D27；契约 §32（准入一条补充）；armadra-cloud 契约 §6、§7、§10、§11。

做了什么（`apps/web/src/`）：

- **远程服务客户端共用**：`mobile/cloud-client.ts` 搬到 `sources/cloud-client.ts`，加平台信息、登出、`me.stream` 的票与浏览器设备（`platform: "browser"`）；经中继向源 core 的刷新带会话的 CSRF 密钥（core 在 Bearer 模式下也核对）。
- **经中继取访问**（`sources/relay-access.ts`，手机与网页共用）：远程服务会话（刷新令牌每次旋转写回）→ 断言与中继令牌 → 源 core 的会话（先用刷新令牌 + CSRF 经中继轮换，被拒才用断言 `cloud/login` 重登）；保管处可换（`RelayVault`：手机是钥匙串，网页只在内存）；拒绝码映射 `source_offline` / `source_revoked` / `source_access_denied`，`cloud_account_unlinked` 原样带出。手机凭据来源改用它。
- **连接**（`sources/connection.ts`）：取访问时中继答源不在线落到 `waitingForSource`；`revoke(failure)` 关流、丢访问、`unauthorized` 带原因；经中继的连接在流退避、`online`、回到前台时重新探直连（D27，两次至少隔 5 秒），通了先拿直连访问再换路，开着的流按新地址重连（`ManagedSocket.reroute()`）；本机源的 `connect()` 叫醒在等、在退避的流（不发请求）。
- **`me.stream`**（`sources/remote-stream.ts`）：每个远程服务一条，票经 `me.streamTicket`，客户端 30 秒 `ping`，4401 丢掉远程服务会话换票重连；`sourceOnline` → 那个源 `connect()`，`sourceRevoked` / `accessRevoked` → `revoke()`；流重开时补连离线与在等的源。`attachRemoteStreams(registry, { auth })` 跟着源表增减；桌面的远程服务会话经本机 core `sources.remoteSession`（`createDesktopCloudAuth`）。
- **把远程源装成本机源**（`sources/route-entry.ts`，从手机入口抽出，两边共用）：选路 → 访问 → 本机源的地址与 Bearer、中继令牌头与 `armadra-relay.*` 子协议，到期前与回前台续。
- **中继托管的页面**（`sources/hosted.ts`、`shell/RelaySignIn.tsx`）：只在 `/app/` 路径下问一次同源 `/.well-known/armadra-platform`，`personal` 且签发方就是页面来源才算；入口给 `{ kind: "relay" }`，登录页复用 `RelayForm`（地址固定、不显示），中继账号口令登录，只有一台在线主机就直接进，几台挑一台；凭据只在这个标签页的内存（关标签即丢，刷新要重新登录）。身份面加 `setHostedSession`（Bearer 传输、会话保管处、刷新也被拒时经远程服务重登一次），`setHostedRuntimeBase` 让本机源指向 `relayBaseUrl`；所有请求同源（中继给页面的 CSP 是 `connect-src 'self'`）。`me.stream` 驱动：下线 → 通知条「等待上线」，上线或流重开时主机在线 → 叫醒控制面；撤销 → 通知条带「重新登录」。
- **i18n**：`i18n/remote.ts` 加 `remote.error.*`（经中继的失败原因）与 `remote.hosted.*`（托管页面登录），中英同步；状态沿用 A1-4 的 `remote.status.*`；错误码表加 `source_mismatch`、`account_disabled`。
- **core 一处**（`core/relay/admission.ts`）：浏览器同源 `GET` / `HEAD` 不带 `Origin`，中继托管页面的这类请求原来一律 403；现在带 `Sec-Fetch-Site: same-origin` 时按会话来源（`relayOrigins[0]`）认，照样要绑在它上面的 Bearer，跨站与没写的照旧 403。契约 §32 准入一条同步。
- **桌面壳经中继**（`shell-core/relay-origin.ts`、`main/remote-trust.ts`）：桌面页面来源是回环，分享方 core 的隧道准入不认。壳对源表里中继主机的请求（含 CORS 预检与 WebSocket 升级，`webRequest.onBeforeSendHeaders`）把 `Origin` 改成原生来源 `https://localhost`，响应的允许来源回显页面真实来源并带 `Vary: Origin`（并进 `window.ts` 唯一那个 `onHeadersReceived`）；名单随源表刷新，别的请求不动。复用 `https://localhost` 而不另造来源：core 早把它当只走 Bearer 的原生客户端（`NATIVE_APP_ORIGINS`，core 对别的 core 也自称它），中继边缘的预检名单（cloud #6）也认它，两仓都不用改名单；代价是审计里分不出桌面与手机。桌面与服务器壳的页面在 `useSourcesBootstrap` 里接上 `attachRemoteStreams`（远程服务会话经本机 core 换），中继托管页面不接。
- 探针 `tools/probes/relay-web-e2e.mjs`（`--desktop` 加跑真 Electron 一段，`relay-desktop.mjs`；要 armadra-cloud 检出，本地手动跑，README 有一节）。

实测（macOS arm64，2026-10-06，已合入 main 963901f3（含 #144 A1-4、#145 A4、#146 E2）；中继用 armadra-cloud main 5e9c0ac（含 #6 预检修复））：

- `pnpm check` 通过（lint 0 error，本包文件 0 warn）；`pnpm --filter @armadra/web test` 全过、`typecheck` 通过；`pnpm libs:build && pnpm --filter @armadra/desktop test` 通过（一次全量跑里 A3-2 的 `relay/streams.test` 「隧道断了…进退避」在高负载下偶发超时，单跑连过 3 次，本包没动它）；`pnpm --filter @armadra/server test`、`pnpm --filter @armadra/mobile test` / `typecheck` 通过（数字见 PR）。
- 新用例：`sources/connection` 补 5（源离线等待再连、`revoke`、`online` / 回前台探直连换路并重连流、流退避时探直连、本机源 `connect()` 叫醒在等的流）、`remote-stream` 7（帧解析、地址、票与 30 秒 ping 与 4401、**假中继 4404 → 等待，推 `sourceOnline` → 1 秒内重连**、撤销、按签发方增减、重开补连）、`relay-access` 4、`hosted` 6、`api/identity.hosted` 2、`shell/RelaySignIn` 4、`mobile/entry` 补 1、`core/relay/admission` 补 2（同源 GET、桌面原生来源放行且任意回环来源 403）、`shell-core/relay-origin` 8（只命中源表中继主机、HTTP 与 WS、名单随源表、回 CORS 头与 Vary、对端没放行不替它放行）。
- **端到端（真浏览器）**：armadra-cloud main be36b78 的 `personal serve`（自签 TLS，`--web-root` 指本分支 `pnpm --filter @armadra/web build` 的产物）、`apps/desktop/out/core/main.js`（file 后端 SecretStore，`remoteAdd` 钉指纹 → 注册令牌 → `identity.cloud.register` → 隧道 ready → 断言 `bind` 为主人）、无头 Chrome：`ARMADRA_PERSONAL_RELAY_HOME=… node tools/probes/relay-web-e2e.mjs` 全过——打开 `/app/` 是中继登录页 → 账号口令登录直接进画布（请求全部同源 `/v1`、`/s/<源>`）→ 经中继终端 `echo $((40+2))relay` 回 `42relay` → 实时板与本机页面双向同步 → 主机关隧道（`cloud.relay.enabled=false`）时通知条「等待上线」，再开约 1–3 秒由 `me.stream` 叫醒，终端、实时板与控制面（`/api/ws` 收到 `board.changed`）照常 → SIGTERM 杀掉中继再起，隧道 4–13 秒回来，页面不刷新 10–20 秒内恢复（实时板、终端、控制面事件）→ 中继页面控制台无错误。`--desktop`：真 Electron（开发构建，mock 钥匙串、file 后端、临时数据目录）自己的 core 加个人中转（钉指纹）并经中继挂载分享方 → 页面重载后侧栏分组「就绪」→ 点工作空间、终端回 `42desktop`；预检对着真中继（cloud 5e9c0ac），没有模拟。截图在 `target/relay-web-e2e/`（`01-sign-in-{1440,390}-{dark,light}`、`02-canvas-{1440,390}-{dark,light}`、`03-waiting-for-host-1440`、`04-relay-down-1440`、`05-recovered-1440`、`06-desktop-mounted`、`07-desktop-terminal`）。用完已停掉自己起的中继、core 与 Chrome，数据目录全部删除。

接口：

- **给 V1 探针**：`tools/probes/relay-web-e2e.mjs` 的流程可直接搬：起中继（`personal serve --web-root apps/web/dist`）→ core `remoteAdd` / `register` / `bind` → 页面 `/app/` → `[data-slot="relay-sign-in"]` 里 `input[autocomplete=username]`、`input[type=password]`、回车 → 画布；通知条 `[data-slot="banner"]` 文案「等待上线」。core 侧的主人会话用 `tools/probes/probe-session.mjs`。
- **给 A4-3p（分享链接落地页）**：`sources/hosted.ts` 的 `detectRelayHost()`、`createMemoryRelayVault()`、`createHostedRelay({ issuer })`（`signIn` / `enter(source)` / `status` / `subscribe` / `signOut`）；访客路径只差一段：`links.accept` 拿到 `{ sourceId, relayBaseUrl, assertion, relayToken, guestSession }` 之后把 `guestSession.refreshToken` 存进保管处（`saveCloudRefreshToken(issuer, …)`），`cloudLogin` 那一步换成 `coreCloudLogin(…, invitationToken)`，再 `enter`。入口按路径分支在 `mobile/entry.ts::prepareEntry`（`/app/` 已占，`/j/` 留给 A4-3p）。
- 源层：`attachRemoteStreams(sourceRegistry(), { auth: createDesktopCloudAuth() })` 给桌面与服务器壳的页面（A1-4 挂远程源时调）；`SourceConnection.revoke(failure)`；`createRelayedAccess({ vault, device })`；`SOURCE_ERROR.revoked / accessRevoked`。

没做 / 偏离规格：

- 中继托管的页面仍是「一个标签页一台主机」：挑中的主机装成本机源（与手机同一做法），换主机要重新进；没有把几台同时挂进源表。页面刷新会丢掉内存里的凭据，要重新登录（刷新令牌不落任何存储）。
- 中继自己停掉时页面没有专门的提示（`me.stream` 也断了，收不到下线），通知条是实时板的「离线编辑」与运行时断开；中继回来后由流重开时的那次叫醒恢复。
- 规格只写了 `connection.ts` / `remote-stream.ts`；为了手机与网页共用，另抽了 `relay-access.ts`、`route-entry.ts`、`hosted.ts`，并动了 core 的隧道准入（同源 GET 无 `Origin` 原来进不来，见上）。
- 手机的钥匙串会话形状没有 CSRF 字段：经中继的轮换照旧被拒、退回断言重登（与 A1-5 行为相同）。

## A4-3p 个人中转的链接加入与扫码挂载

设计：[客户端包](../design/platform/client-packages.md) §6（只做个人中转，组织页不做）、总计划 §12；契约 §33.7。

做了什么：

- **共享层**：分享链接的解析从 `mobile/join-link.ts` 搬到 `@armadra/shared` 的 `join-link`（网页链接 `<issuer>/j/<linkId>#<秘密>.<邀请令牌>` 与 `armadra://join`，片段按第一个点切；`joinDeepLink` 写回深链），页面、手机与 core 认同一种拼法。
- **core（契约 §33.7 追加 `sources.mountByLink`）**：解析链接 → 签发方没登记过、系统又不信任它的证书时，与 §33.6 同样答 `fingerprint_mismatch` + `details.fingerprint` → 匿名 `links.accept` → 经 `relayBaseUrl` 调 `cloud/login`（断言 + 邀请令牌）→ 存源的刷新令牌，建或合并 `relayed` 行；签发方没有登录着的一行时，建（或补）一行访客远程服务（`accountHint` 为空，凭据是访客的刷新令牌）。已经用账号登录着的不动，访客会话尽力登出。远程服务的拒绝 `link_invalid / link_expired / link_exhausted / link_secret_invalid / rate_limited` 与源的拒绝 `invitation_invalid / cloud_not_registered / source_offline` 按码透传；注册表加 `link_expired`、`link_exhausted`（410）、`link_secret_invalid`（403）。旧路径是 `POST /api/sources/join`。
- **桌面壳**：接住 `armadra://join`——macOS 走 `open-url`，Windows 与 Linux 从启动参数里取，`shell-core/join-link.ts` 只认形状。新增 IPC：`app:join-link` 只是提醒，页面经 `app:take-join-link` 取走（只取一次）。`electron-builder.yml` 加 `protocols`，在安装时登记 URL 协议；运行时不调用 `setAsDefaultProtocolClient`。
- **页面（桌面与服务器壳）**：设置 → 远程服务 →「通过链接加入」对话框，复用指纹核对。深链与 `#join=<链接>` 会打开这一页并预填，人点「加入」才挂载。挂载成功后先记下要打开的源（`sources/join-intent.ts`，存在 sessionStorage，因为壳可能为放行新来源而重载页面），再按 A1-4 的三步收尾；`app/joined-source.tsx` 等那个源列出工作空间后切过去、打开、关掉设置。访客那一行远程服务不给「分享本机」。
- **页面（远程服务托管的 `/j/<linkId>`）**：`shell/JoinPage.tsx`。片段读进内存后立即从地址栏抹掉；`links.get` 显示源、权限与有效期；「加入」走 A3-4 托管中继新加的 `HostedRelay.join`：访客会话进内存保管处 → 带邀请令牌 `cloud/login` → 同 `enter` 装成本机源 → 地址换成 `/app/`，就地进画布并打开工作空间。「在 Armadra 中打开」给出同一条链接的深链。入口 `prepareEntry` 在普通浏览器里认 `/j/<linkId>`。
- **手机**：A1-5 的扫码 / 深链加入在失败时按码分开说明（过期、已停用、用尽、不完整、邀请被拒、钉扎时指纹不符），文案与桌面同一套 `error.*`；加入后重载进画布，并打开链接指向的工作空间。连接页与落地页在画布挂上之前就把明暗主题与语言写到文档上（原来总是深色）。
- 文案：新增 `i18n/links.ts`，`errors.ts` 加 `error.link*`，中英同步。

实测（macOS arm64，2026-10-06，合入 main cde88088（含 #145 A4-1、#146 E2、#147 E3-2、#148 A3-4）后重跑）：

- `pnpm check` 通过（lint 0 error、285 warn，与 main 相同）；`pnpm --filter @armadra/web test` 3685 过（396 个文件），`typecheck` 通过；`pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 4905 过 / 65 跳过；另有 2 条在整套负载下超时（`git/message.test` 的 provider 探测、`hibernator.pty.test` 的退出等待），与本包无关，单独重跑 22 条全过。live 4 过，脚本 68 过 / 2 跳过。`pnpm --filter @armadra/server test` 98 过 / 4 跳过；`pnpm --filter @armadra/shared test` 362 过。
- 新增用例：core `service.test.ts` 补 5 条（accept → cloud/login 带邀请令牌 → 访客远程服务与 relayed 行、秘密与邀请令牌不进 SecretStore / 日志 / 答案、深链、已登录账号时沿用、过期 / 用尽 / 撤销 / 秘密不对、指纹不符 / 邀请被拒 / 不是链接 / 链到本机）；壳 `shell-core/join-link.test.ts` 3 条；`shared/ipc.test.ts` 同步；shared `join-link.test.ts`（搬来并加 `joinDeepLink`）；页面 `JoinPage.test.tsx` 4 条、`sources/hosted.test.ts` 补 2 条（访客加入、过期）、`RemoteServicesPage.test.tsx` 补 4 条、`use-link-fragments.test.tsx` 补 3 条、`joined-source.test.tsx` 2 条、`entry.test.ts` 补 1 条、`connect.test.ts` 补失败码。
- **端到端**（真个人中转：armadra-cloud main 5e9c0ac，自选端口、临时数据目录、自签 TLS，托管本分支的 `apps/web` 构建；裸 core A 分享本机并为每个访客建一个带终端节点的工作空间与分享链接；全部用完即停）：
  - 浏览器（无头 Chrome）：打开 `/j/<id>#…`，片段被抹掉，落地页显示源、权限与有效期 →「加入」→ 进到 `/app/`，链接指向的工作空间自动打开，终端经中继收发 `echo`；控制台无错误。过期的链接提示「链接已过期」；撤销的链接一打开落地页就提示「链接已停用或不存在」。
  - 桌面（真 Electron，另一份数据目录与临时 HOME）：以 `armadra://join?…` 作启动参数 → 远程服务页「通过链接加入」已预填、没有自动挂载 → 加入 → 核对的指纹与中继 CA 一致 → 挂载 → 壳放行新来源后重载 → 自动打开工作空间，终端经中继收发 `echo`。粘贴过期与撤销的链接分别提示对应文案；渲染页无控制台错误。
  - 手机（模拟器起不来）：在 Chrome 里用 390 宽模拟，页面来源用 CDP 拦截成原生 App 的 `https://localhost` 并从构建产物应答，原生桥用假的 `Capacitor.Plugins.ArmadraNative` 替身（钥匙串存在页面存储里，扫码结果注入）。流程：连接页「扫码」→ 核对指纹 → 信任 → 挂载（会话进替身钥匙串）→ 重载进画布、打开工作空间，终端经中继收发 `echo`；扫到过期的分享码提示「链接已过期」。
  - 截图：390 / 1440 宽、明暗两主题的落地页，以及画布、过期、撤销、桌面预填、指纹核对、手机连接页等，见 PR 正文与本地 `target/a4-3p-e2e/out/`（不提交）。

接口：

- core：`sources.mountByLink { url, fingerprint?, label? }` → `ClientSource`（§33.7），页面侧是 `api/remote-services.ts::mountSourceByLink`，答 `{ kind: "confirm", fingerprint }` 或 `{ kind: "done", value }`。
- 页面：`sources/join-intent.ts` 的 `offerJoinLink(url)`（打开到远程服务页并预填）和 `openAfterJoin(sourceId)`（挂载后打开这个源的工作空间，能跨一次重载；手机与托管页面传 `"local"`）。
- 托管中继：`HostedRelay.join({ linkId, secret, invitationToken })` 返回 `sourceId`。
- 桌面壳：`window.armadra.sources.takeJoinLink()` / `onJoinLink(listener)`。
- 共享层：`parseJoinLink` / `isJoinLink` / `issuerOrigin` / `joinDeepLink`。

没做 / 偏离规格：

- 组织页（`OrganizationsPage`）与 saas 的登录后加入不做（总计划 §12）。`mountByLink` 遇到 saas 签发方答 501。
- 落地页没有按规格另走 `SourceRegistry.add(relayed)`：托管页面背后没有本机 core，所以与 A3-4 一样把那台主机装成本机源，凭据只在内存，刷新页面后要从链接重新加入。
- 桌面收到深链时只预填、不自动挂载：系统级深链任何网页都能触发，要人点一下。手机沿用 A1-5 的做法，扫码即挂。
- 桌面壳没有拿单实例锁（多份数据目录各起一个实例是常态），所以 Windows 与 Linux 上应用已开着时，再来的深链会起第二个实例；`second-instance` 的处理已接好，加锁后即生效。
- `link_invalid` 沿用注册表里邮件域原有的 409（协议包是 404）；页面只按码取文案，不受影响。
- 一个签发方只有一行远程服务：已经用账号登录着时沿用账号会话，访客会话随即登出。若那一行没有登录，访客的凭据会写进它，`accountHint` 也会被清空。
- 联调中发现两处问题，都已由 A3-4 与 cloud#6 修好；本包最后一轮端到端对真中继跑，没有任何模拟：
  1. 中继对 `/s/` 的预检也要求中继令牌；
  2. 桌面页面来源不被分享方信任。
     另有一处隧道准入问题（中继同源页面的 GET 不带 `Origin`），本包与 A3-4 修法相同，合并时以 main 为准。
- 用 `armadra-server invite --cloud-link` 生成的链接没有单独跑；它产出的链接拼法与 A1-4 的相同，`mountByLink` 和落地页都认。

## E3-3 工程规范化：terminals 域迁到契约（契约 §38）

设计：[工程规范化](../design/engineering-standardization.md) §2，规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-3）；契约 §38。

做了什么：

- **契约**（`packages/shared/src/contract/terminals.ts`）：`terminals.*` 共 11 条——`create`、`backend`、`get`、`capture`、`sessions`、`paste`、`scroll`、`terminate`、`recycle`、`wake`、`drive`；权限与旧路由表一致（开 `terminal:create`、读 `terminal:read`、其余 `terminal:write`），`create` 与 `sessions` 绑 `workspaceId`。出参复用页面 schema，并补上 core 一直在答的 `kind`、`ownerNodeId`、`platform`；会话行的 id 与时刻放宽成字符串（探针与旧库的工作空间 id 不是 RFC 变体的 UUID，严格校验会把成功的创建拒成 500，对偶测试里有回归用例）。入参只校形状，粘贴大小、滚动距离、节点 id 等判断仍在域里。`since` 为 1.6，协议 minor 5 → 6。
- **core**：`terminal/install.ts` 把十一条路由的实现收成一份 `operations`，旧 handler 先解析查询串或体、再调它；`registerProcedures(server, "terminals", …)` 登记同一份，每次回答同样等启动对账 `ready`。`TerminalError` 改为 `CoreFailure` 子类（构造参数不变），procedure 抛出的码与原话与旧路径一样（含 `not_hibernated`、`wake_failed` 这类注册表里没有的终端专属码）。
- **页面**：`api/terminals.ts` 改为 `terminalsApiFor(rpc)`，经 `currentClient`（换源后请求跟着换），函数签名不变，答案仍过页面自己的 schema；终端 WebSocket（`api/sockets.ts`）不动。直接 import `terminalsApi` 的四处（`use-access`、`acp/api`、`DriveBadge`、`delivery-commands`）改用 `runtimeApi`，对应两处测试的 mock 改指 `@/api/client`。
- **契约 §38**：§38.1 生成块与说明，§38.2 登记不在契约里的 WS 与 `node-token/refresh`（E3-8）。

实测：

- `pnpm check`：契约、格式、lint、typecheck、repo:check、workflow、release:check 通过；最后一步 `notices:check` 在本机失败（`pnpm licenses list` 缺包索引，本 worktree 用离线仓库装依赖、无法联网），本包没动依赖。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：新增 `core/contract/parity-terminals.test.ts` 17 条（旧路径、procedure、原 handler 逐字节相等，覆盖不存在的会话、过大的粘贴与滚动、不属于节点的唤醒、域里的创建拒绝、形状错只比码与状态、scope 与路由表一致）。
- `pnpm --filter @armadra/web test` / `typecheck` 通过；新增 `api/client.terminals.test.ts`。
- A 档：`core-terminal-smoke`、`core-terminal-lifecycle`、`server-e2e`、`ui-features-e2e`、`ws-mux-e2e`、`realtime-e2e` 通过。

没做 / 偏离：

- 形状错（缺字段、`action` 不是两个动词之一）经旧路径与 procedure 由入参校验先答 `bad_request`（带 `details.issues`），与迁移前那句原话不同；码与状态不变。
- `acp-e2e` 在本机起 Vite 超时（手动起 Vite 正常，疑为多个包并行时的机器负载），未得到结果。

## E3-1 工程规范化：boards 域迁到契约（契约 §36）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-1）；契约 §36。

做了什么：

- **契约**（`packages/shared/src/contract/boards.ts`）：`boards.list / create / update / delete`（§36.1）、`load / save`（§36.2）、`realtime`（§36.3）、`heartbeat / leave / acquireLease` 与订阅 `presence`（§36.4）。出参是线上形状（节点 `data` 是原样 JSON），页面的 schema 再解析一遍；`save` 的入参是「已知字段 + 透传」，语义检查与已退役 `kanban` 的拒绝仍在域里。注册表加 `canvas_lease_held`（423）与 `realtime_active`（409）。协议 minor 升到 7，`since` 为 1.7。
- **core**（`core/canvas/routes.ts`）：域动作收成 `operations`，旧 REST 处理器与 `registerProcedures("boards", …)` 调同一份，拒绝的码与原话一致；旧路径经 `meta.legacy` 继续可用。`boards.realtime` 由实时域登记读取函数（`setRealtimeStateReader`），canvas 域不 import 实时域。
- **`boards.presence` 订阅**（控制面）：订上就是第一次心跳，连着时 core 每 10 秒替页面续期（不带 `active`），取消或断线即离开（同一 `clientId` 多条订阅时最后一条走了才离开）；每项是该客户端看到的在线表（带 `writable` 与 `deviceKey`），只有 `lastSeenAt` 变的续期不发；授权被收回以 `forbidden` 结束。背压 `drop-oldest`。Yjs 同步连接未动。
- **一处顺手修的缺陷**：实时板上每拍心跳都为一个视图里恒为空的租约白发一帧 `canvas.presence`；订阅若在事件上再心跳，两个订阅会互相触发到占满事件循环（实测 realtime-e2e 刷新后 core 卡死）。现在事件只读一眼不心跳，实时板也不再分租约。
- **页面**：`api/boards.ts` 改 `boardsApiFor(rpc)`，经 `client.boards.*`，`boardRealtime(…, source)` 保留 A1-2 的源语义；`api/board-presence.ts` 订阅；`use-board-sync` 订阅连着时定时心跳只在有操作要报时发，订阅结束回到整拍兜底；关页面靠连接断开离开，不再发 `keepalive` 请求。
- **探针**：`ui-features/presence.mjs` 拦保存改认 `POST /api/rpc/boards/save`，`server-e2e` 核对保存请求认 `boards.save`。

留在 REST / 数据面：`…/sync`（Yjs）、评论、`context-links`、导出与资源上传。

偏离：入参形状不对时契约的 schema 先于域拒绝（码与状态一致，原话是字段路径）；`since` 取 1.7（main 已是 6）；评论与 `context-links` 未迁。

实测（macOS arm64，Node 26.10.0，合入 main 27b71efe 之后）：新增 `contract/parity-boards.test` 11（旧路径、procedure、原 handler 三者逐字节一致，含 404、409、423、400 envelope）、`canvas/presence-subscription.test` 7、web `api/board-presence.test` 2、`client.test` 与 `use-board-sync.test` 改写补充。`pnpm check` 通过；A 档：design-showcase、gateway、realtime、server、ui-features（多设备画布）、workflow、ws-mux、core-terminal-\*、push 通过；acp、agent-e2e-self-test、remote 三项在探针的临时 HOME 下 `pnpm exec vite` 无输出、「Vite 没有就绪」，与本包无关（环境问题）。

## V1 个人中转全流程探针（里程碑 M1 验收）

规格：[开发栈与验证](../design/platform/dev-stack-and-verification.md) §4；总计划 §12.3。

做了什么：

- `tools/probes/personal-roundtrip.mjs`（A 档）：真个人中转（armadra-cloud `personal init` + `serve`，自签 TLS，托管 `apps/web/dist`）、真 core、真 Electron、无头 Chrome。七步：中继 init；core 登记、隧道 ready、绑定主人；`/app/` 账号口令登录、终端、实时板；`/j/` 访客加入、开终端；桌面粘贴链接挂载（核对指纹）、开终端；手机 390 宽模拟扫码挂载、开终端；撤销链接与撤销登记。最后扫中继、core、Electron 与探针输出，口令、令牌、链接秘密一个都不许出现。
- e2e 清单新增依赖项 `cloud`（`tools/ci/e2e.mjs`、`tools/probes/cloud-source.mjs`）：找不到 armadra-cloud 检出（私有仓，CI 拉不到）时记 `skipped` 并写明原因，找到则经 `ARMADRA_DEV_STACK_CLOUD_SRC` 交给探针。清单 `personal-roundtrip.json` 列为 tier a，`platforms` 为 darwin、linux。
- `startStack` 可追加 Chrome 参数；`relay-desktop.mjs` 导出 `attachRenderer`。

实测（macOS arm64，2026-10-06，基于 main 13f20c09，armadra-cloud main 4cc09cc）：`node tools/ci/e2e.mjs --tier a --only personal-roundtrip` 连跑 3 次全过，100 s / 101 s / 116 s（其中 `/app/` 一段约 14.5 s、桌面一段约 8 s，第三次桌面一段 23 s；手机一步前固定等 62 s 的限流窗口）。

发现与限制：

- 中继边缘对每个来源 IP 每分钟 200 次（`edge.connect.ip`，写死在 cloud 的 `control/types.ts`，预检、请求、升级共用）。一台主机上的多个客户端（几个浏览器标签、桌面、手机模拟）共用回环 IP，手机页面启动一口气几十个请求，前面几步用掉额度后预检答 429，页面落在「连不上」。探针因此在手机一步前等一个窗口。真实部署里多人在同一出口 IP 后面（办公室、家庭）也会撞到。
- 手机模拟需要 Chrome 的 `--disable-features=LocalNetworkAccessChecks`：页面来源是拦截出来的 `https://localhost`，Chrome 当它是公网页面而拦下对回环中继的访问；原生 WebView 没有这一层。
- 手机没有真机或模拟器：原生桥是页面里的替身（钥匙串存页面存储，扫码结果注入）。
- 访客兑换一次性邀请后列表里 `uses` 为 0、`consumedAtMs` 有值：一次性邀请不计 `uses`，只记消费时间。

## E3-5a 工程规范化：git 域迁到契约（契约 §40.1，E3-5 第一部分）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-5）；契约 §40。

切分边界：E3-5 表里的「40 / 35」是整个 git 面的调用数 / 路径数（页面 `api/git.ts` 17 个调用 + `api/git-repository.ts` 23 个调用）。本包收 `api/git.ts` 那 17 个——`status`、`diff`、`head-commit`、`init`、`stage`、`unstage`、`resolve`、`revert`、`commit`、`hunks`（读与写）、`message/providers|source|generate`、`/api/git/clone`（起、读、取消）；`repositories`、`log`、`refs`、`identity` 与 `repository/*`（含操作队列与 rebase）留给第二部分（`gitRepository.*`，§40.2）。对偶测试里有一条用例核对这条边界：路由表里其余的 Git 路径都是仓库级的。

做了什么：

- **契约**（`packages/shared/src/contract/git.ts`）：`git.*` 17 条，`message.*` 与 `clone.*` 各成一棵子树。出参复用页面已有的 schema；入参只校形状，`scope` / `source` / `action` / `language` 是字符串，取值由域判断（拒绝的原话因此与旧路径一样）；旧路径查询串里的 `paths`（逗号拼）与 `ignoreWhitespace`（`"true"`）两种拼法都收。注册表登记 `git_execution_required`（403）。`since` 为 1.8，协议 minor 7 → 8。
- **core**（`core/git/routes.ts`）：这 17 个路由的实现收成一份 `operations`，旧 handler 与 `registerProcedures(server, "git", …)` 调同一份；入参是取值函数，旧 handler 照旧在权限门之后才解析体。克隆保留任务模型：`clone.start` 只起任务答 `jobId`，进度靠 `clone.status` 轮询，完成时登记工作空间。仓库级路由未动。
- **页面**：`api/git.ts` 改为 `gitApiFor(rpc)`，经 `currentClient`（换源跟着换），函数签名不变；入参照旧先过页面 schema，空路径、空提交信息、不认识的 `scope` 在发请求前同步抛出。
- **契约 §40**：§40.1 生成块与说明，§40.2 占位写明第二部分的范围。

实测（macOS arm64，基于 main 13f20c09）：

- `pnpm check` 通过（lint 0 error；`notices:check` 要指向实际装依赖的离线仓库：`npm_config_store_dir=<仓库> pnpm notices:check` 通过，本包未动依赖）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 418 个文件通过、11 跳过（4952 过 / 72 跳过），脚本 68 过 / 2 跳过。新增 `core/contract/parity-git.test.ts` 17 条：旧路径、procedure、原 handler 逐字节相等，覆盖状态、差异（两种拼法）、HEAD 提交、暂存 / 取消暂存、带冲突标记的解决被拒、还原与不认识的来源、提交与 amend 的 HEAD 不符、按块读写与不认识的动作、AI 提交信息（替身 `claude`，不跑真 CLI）、初始化、读 / 写 / 执行授权与不存在的工作空间、克隆的拒绝与任务读取取消、形状错只比码与状态、scope 与路由表一致、切分边界。
- `pnpm --filter @armadra/web test`：399 个文件、3699 条通过；`typecheck` 通过。新增 `api/client.git.test.ts` 15 条，`client.test.ts` 里旧的 git / 克隆用例搬过去按 procedure 线上形状改写。
- 探针：`git-tool-window` 通过（日志、提交两页与手机四级导航的截图）；A 档 `ui-features-e2e` 通过；`remote-e2e` 的 Git 段（远端状态、暂存、提交、fetch 与取消）全部通过。

没做 / 偏离：

- 形状错（缺字段、类型不对）经旧路径与 procedure 由入参校验先答 `bad_request`（带 `details.issues`），与迁移前那句原话不同；码与状态不变。
- 旧路径答 500 `internal_error`（如 Git 输出无法解析）时，门面按 §34.1 不外泄原话，与迁移前不同。
- `status` 的 `paths` 收下但 core 从来不按它过滤（迁移前就如此），没有顺手改。
- 探针在临时 HOME 下 `pnpm exec vite` 会先联网核对锁文件，本机断网时卡住；本地跑探针时加 `npm_config_verify_deps_before_run=false npm_config_minimum_release_age=0 npm_config_manage_package_manager_versions=false` 即可，探针本身未改。
- `remote-e2e` 的 `08b-remote-acp`（ACP Agent 启动即退出）与 `server-e2e` 的「新建浏览器」菜单项等待超时失败，两处都不经过 git 面，与本包无关，未深究。

## M1 收尾：单实例锁、撤销时删中继侧源记录、一次性邀请计数、spawn-helper 执行位

做了什么：

- **桌面壳单实例锁**（`shell-core/single-instance.ts`、`main/index.ts`）：锁按数据目录分。没指 `ARMADRA_DATA_DIR`（或指的就是默认那一份）时用 Electron 默认的 profile，已有用户的页面存储与浏览器分区不动；指了别的数据目录时 profile 放进 `<数据目录>/electron/`，锁跟着它走；命令行给了 `--user-data-dir`（探针都这样起）时不改。锁在任何装配之前取：同一份数据目录的第二个实例把深链经 `requestSingleInstanceLock` 的附加数据交给已开着的壳，然后同步退出。已开着的壳走 A4-3p 的 `onJoinLink`，只预填、不挂载，并把窗口拿到前面（启动途中窗口还没建时不抢着建，页面载入后自己来取）。
- **撤销时删中继侧的源记录**（契约 §31.4 追加，迁移 `0041_cloud_relay_cleanup`）：`identity.cloud.revoke` 先在本机完成（停隧道、记撤销时刻），再经源表域挂上的删源步骤（`CloudService.attachRelayCleaner` ← `SourcesService.removeRelaySource`）用这个 issuer 远程服务的会话调 `DELETE <issuer>/v1/sources/{sourceId}`。中继上本来就没有算删掉了。没有远程服务行、没有保存的登录、会话失效或不是 owner 记 `source_unauthorized`，连不上记 `source_unreachable`，即「中继侧待清理」。新增 `identity.cloud.relayPending` / `relayCleanup`（旧路径 `GET /api/identity/cloud/relay-pending`、`POST …/relay-cleanup`）用来列出和重试；同一个 issuer 再登记时清空。隧道收到中继的 `source_revoked` 而撤销时不再去删。`sources.remoteRemove` 先 await 撤销（用的正是这一行的会话），再登出、删凭据、删行。审计 `cloud.revoke` 的详情加 `relayCleanup`。服务器壳 `cloud revoke` 没删掉时如实输出「中继侧待清理」与码。
- **页面**：停用分享、移除远程服务之后，中继侧没删掉的按码提示原因；远程服务行上显示「中继侧待清理」徽标，菜单里可以「重试清理」；远程服务已删、中继侧还欠着的单独列一行。文案在 `i18n/remote.ts`，中英同步。
- **一次性邀请计数**（V1 探针发现）：兑换时 `uses` 同步加一，并记进 `identity_invitation_uses`，与 `maxUses` 同一口径；撤销只收口，不算使用。
- **node-pty `spawn-helper` 执行位**（V1 探针发现）：原来只有桌面 `pretest` 跑 `ensure-node-pty.mjs`。pnpm 不跑 node-pty 自己的安装脚本（`allowBuilds: false`），解包时又丢了执行位，所以新 worktree 里不经 `pretest` 直接起终端会报 `posix_spawnp failed`。新增 `--executable-only`：只 chmod，可重复执行，没装 node-pty 也不失败，只处理从 `apps/desktop` 解析到的那份。根 `postinstall` 与 `libs:build` 都会调它。服务器镜像用的 `--prebuilt` 语义不变，Linux 上仍编 Node-ABI。

实测（macOS arm64，2026-10-06，基于 main 13f20c09，合入 5d4d74da 后重跑）：

- `pnpm check` 通过；`pnpm libs:build && pnpm --filter @armadra/desktop test`（vitest 4956 过 / 67 跳，live 4 过，脚本 71 过 0 败）；`pnpm --filter @armadra/web test` 3700 过、`typecheck` 过；`pnpm --filter @armadra/server test` 98 过。
- 新用例：`shell-core/single-instance.test.ts` 5；`cloud/store.test.ts` 补 2（0041 列、待清理只记在已撤销行、再登记清空、长度约束）；`cloud/cloud.test.ts` 补 4（没挂删源 → 待清理 `source_unauthorized`、失败记码 → 重试 → 清掉 → 不欠的 404、`relaySide: "revoked"` 不删、未登录 401）；`sources/service.test.ts` 补 2（owner 会话删源且带 Bearer、中继上已没有算删掉；没有远程服务 / 登出 / 连不上各答对应码），删远程服务那条改为撤销时会话仍在；`accounts.test.ts` 补 1；`scripts/ensure-node-pty.test.mjs` 3；服务器壳 `cloud.test.ts` 补待清理输出；页面 `remote-services.test.ts` 补 2、`RemoteServicesPage.test.tsx` 补 3。
- V1 探针 `personal-roundtrip` 跟着改：第 7 步检查 core 撤销登记时是否已经删掉中继侧的源记录（经中继答 401 `relay_token_invalid`、`relay-pending` 为空、中继目录里没有这台源、断言答 410 `source_revoked`），不再由探针自己去删。一次性邀请兑换后要求 `uses` 为 1。合入 main 5d4d74da 后，`node tools/ci/e2e.mjs --tier a --only personal-roundtrip` 通过，耗时 118 s。
- **单实例真跑**（开发构建 `apps/desktop/out`，真 Electron，临时 HOME 与数据目录）：A 以数据目录 A 开着；B 用同一数据目录、带 `armadra://join?…` 启动，173 ms 后退出码 0；A 打开「设置 → 远程服务 →通过链接加入」，链接已预填，没有自动挂载；C 用另一个数据目录启动后照常运行。两个数据目录下都生成了 `electron/` profile。
- **撤销联调**（armadra-cloud main 5e9c0ac 的 `personal serve`，自选端口 8131、临时数据目录、自签 TLS，用完已停并删掉）：cloud 的 devstack 7 条全过。登记后中继目录里有这台 core；`revoke` 后目录里已经没有它，再取断言答 `source_revoked`，`relayPending` 为空。登出后撤销：本机完成、中继目录里还有它，`relayPending` 记 `source_unauthorized`；重新登录后 `relayCleanup` 答 `{ pending: false }`，目录里没有了。`remoteRemove` 连同中继侧一起撤。隧道与源表的 devstack 同轮 13 过 1 跳（重启那条要自己起中继）。隧道那条「本机撤销」经中继现在答 401（中继令牌随源一起作废），不再是 503。联调结束后用 owner 会话查中继目录，结果为空。

接口：

- core：`CloudService.attachRelayCleaner(fn)` / `relayPending()` / `relayCleanup({ issuer })`，`revoke(input, principalId?, { relaySide?: "revoked" })` 现在是异步的；`SourcesService.removeRelaySource(issuer, sourceId)`；`RemoteClient.revokeSource`。
- 页面：`stopSharing(issuer)` 返回待清理的码，`null` 表示不欠；`relayPending()`、`retryRelayCleanup(issuer)`；`ShareDialog` 导出 `RELAY_PENDING_KEY`、`relayPendingReason`、`announceStopped`。

偏离与没做：

- `revoke` 的出参仍是协议包的 `{}`，`status` 也不改：契约测试要求它们与协议包是同一个 schema 对象。所以「待清理」用两条 Armadra 自己的 procedure 表达，没有塞进 `status`。
- 迁移号取 0041（main 当时最大 0040）；合入前如果 main 有了 0041，需要改号并更新 `migrations.lock`。
- 单实例只在开发构建上真跑；打包产物与 Windows / Linux 的深链启动没有实机验证（同一套 Electron API，CI 三平台跑单测）。
- 远程服务删了之后还欠着的那条，要重新添加并登录这个远程服务才能重试；没有「放弃清理」的入口。

## E3-4 工程规范化：agents 域迁到契约（契约 §39）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-4）；契约 §39。

做了什么：

- **契约**（`packages/shared/src/contract/agents.ts`）：`agents.*` 共 21 条，覆盖页面 `api/agents.ts` 的 26 次调用里的 22 次（投递记录与排队是同一条旧路径的两个切片，合成 `deliveries`）——目录与集成（`list`、`models`、`integration`、`install/uninstall/repairIntegration`、`amaCredentials`、`set/clearAmaCredential`，§39.1）、节点状态（`markRead`、`suggestTitle`、`transcript`，§39.2）、人的答复（`answerApproval`、`confirmControl`，§39.3）、投递与上下文（`deliveries`、`cancelDelivery`、`contextReads`、`putContextLinks`，§39.4）、依赖等待（`dependencies`、`importLegacyDependencies`、`cancelDependency`，§39.5）。出参写线上形状：页面 schema 是 `looseObject` 的那几份写成已知字段 + 原样透传，出参校验不剥掉 core 多答的字段；没有缺省值。入参只校形状。`since` 为 1.9，协议 minor 8 → 9（E3-5a 先合入取了 8）。
- **scope 进 meta**：每条的 `meta.scope` 等于 `route-scopes.ts` 给旧路径的要求（对偶测试逐条断言）；绑在路径里工作空间上的都带 `workspaceKey`。路由表本身不变，服务器壳上 procedure 经门面按 `meta.legacy` 还原成旧路径，过同一道 `identity/route-access.ts`。
- **core**：每个拥有对象的域各收成一份操作实现，旧 handler 与 `registerProcedures(server, "agents", …)` 调同一份——`agent/routes.ts`（目录、状态、审批、关闭确认、投递、「谁读过我」）、`agent/ama-credentials.ts`、`hook/routes.ts`（集成，`InstallError` 换成 `CoreFailure`）、`models/index.ts`、`canvas/routes.ts`（连线）、`dependencies/index.ts`（新增 `registerDependencyProcedures`）。投递门语义不变：审批与关闭确认仍要 `approval:answer`，节点与审批按所在画布判，投递、连线、依赖绑在路径里的工作空间上。
- **页面**：`api/agents.ts` 改为 `agentsApiFor(rpc)`，经 `currentClient` / `clientFor(source)`（依赖等待保留按源发），函数签名不变，答案仍过页面自己的 schema；白板导出、资源上传与按路径导入留在 REST（§39.6）。`client.ts` 的 `boardsClient` 改名 `sourceClient`，boards 与 agents 共用。
- **契约 §39**：§39.1–§39.5 生成块与说明，§39.6 登记留在 REST 的字节流、交接与 hook 面。

实测（macOS arm64，合入 main 76580264 之后）：

- `pnpm check` 通过（含 `contract:check`、lint、三处 typecheck、repo:check、notices）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：420 个文件通过、10 个跳过（4987 条通过）；脚本 68 条通过。新增 `core/contract/parity-agents.test.ts` 28 条：路由表原 handler、旧路径、procedure 三者逐字节相等（含 404、409、400、501 与 ama 密钥不回显）；**投递门**一节用真的 `createRouteGuard`、真库查询与成员身份：viewer / editor / 别的画布上的 driver 答不了审批（审批行仍未答）、成员一律答不了关闭确认、别的画布上的成员读不到节点状态、「谁读过我」、投递、依赖也写不了连线，两条路答同一个 403；同画布的 driver 答得了、viewer 读得到；成员改不了 ama 密钥与集成。
- `pnpm --filter @armadra/web test`：400 个文件、3703 条通过；`typecheck` 通过。新增 `api/client.agents.test.ts`（procedure 路径与体、中止信号、按源发、403 仍是 `RuntimeRequestError`）。
- `@armadra/server`、`@armadra/shared` 测试通过。
- A 档（`node tools/ci/e2e.mjs --tier a --only agent-e2e-self-test,acp-e2e,ui-features-e2e,server-e2e,workflow-e2e`）：五项通过（含集成页旧残留、多设备画布、11-coordinator、12-acp）。未合并前第一轮 `agent-e2e-self-test` 的 11-coordinator 有一次首个模型请求没带 key，单跑与合并后整跑都通过，记为偶发。

没做 / 偏离：

- 形状错（缺字段、类型不对）经旧路径与 procedure 由入参校验先答 `bad_request`（带 `details.issues`），与迁移前那句原话不同；码与状态不变（与 E3-1/2/3 同）。
- 集成的意外失败（非 `InstallError`）经旧路径现在答门面统一的 500 原话，不再带异常消息。
- 对话交接（`api/handoff.ts`）不在本包；白板导出与资源上传留在 REST。
- 没有新增探针，现有探针也没有 `cli-collab` 一项；agent / 协作相关的 A 档条目就是上面五项。
- 发现一处既有不一致：core 的「谁读过我」答 `{ total, bytes, reads }`，页面 `contextReadsResponseSchema` 读的是 `recent`（缺省空表），节点头的最近读取清单因此一直是空的。契约按 core 的真形状写；页面没改，另开任务处理。

## E3-5b 工程规范化：gitRepository 域迁到契约（契约 §40.2，E3-5 第二部分）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-5）；契约 §40.2。接 E3-5a 的切分边界：本包收 `api/git-repository.ts` 的 23 个调用——`repositories`、`log`、`refs`、`identity` 与 `repository/*`（分支、标签、远端、worktree、储藏与详情、历史、reflog、提交详情与单个文件、cherry-pick 预览、rebase 待办预览、多检出状态、worktree 绑定核对、整合状态、操作队列的列 / 起 / 读 / 取消）。至此路由表里的 Git 路径全部在契约上。

做了什么：

- **契约**（`packages/shared/src/contract/git-repository.ts`）：`gitRepository.*` 23 条，操作队列是 `operations.{list,start,get,cancel}` 子树。出参复用页面已有的 schema；入参只校形状：`action` 只要求是带 `kind` 字符串的对象，其余字段与 `log` 的 `refs.kind` 由域判断。旧路径查询串里的 `limit` / `maxDepth` / `mainline`（数字串）、`refresh`（`"true"`）、`history` 的 `paths`（逗号拼）两种拼法都收。注册表登记 `invalid_cursor`（409）。`since` 为 1.10，协议 minor 9 → 10（9 是 E3-4）。
- **core**（`core/git/routes.ts`）：这 23 个路由收成一份 `repository` 实现，旧 handler 与 `registerProcedures(server, "gitRepository", …)` 同调；入参是取值函数，旧 handler 照旧在权限门之后才解析体（只读查询沿用迁移前的顺序：先取参数、后过权限门）。长操作（含 rebase）保留操作队列：`operations.start` 只排队、答快照，进度靠 `operations.get` 轮询；操作归属表仍在控制端。
- **页面**：`api/git-repository.ts` 改为 `gitRepositoryApiFor(rpc)`，经 `currentClient`（换源跟着换），函数签名不变；游标、路径表、`mainline` 是入参字段，不再拼查询串；操作与 CAS 照旧先过页面 schema，不合法的发请求前同步抛出。
- **契约 §40**：§40.2 生成块与说明；§40 引言改为两部分已覆盖全部 Git 路径。

实测（macOS arm64，基于 main 80a65133）：

- `pnpm check` 通过（lint 0 error；本包未动依赖，`notices:check` 通过）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 423 个文件通过、10 跳过（5026 过 / 67 跳过），脚本 72 过 / 0 失败。新增 `core/contract/parity-git-repository.test.ts` 16 条：旧路径、procedure、原 handler 逐字节相等，覆盖仓库发现（两种拼法、负数被拒）、合并日志（翻页、搜索与路径、换条件的旧游标 409 `invalid_cursor`、不认识的引用种类）、引用树与六种检出读（远端 URL 不含凭据）、储藏与提交详情、历史（数字串 limit、逗号路径与数组、下一页、不属于它的游标、坏 limit）、reflog、cherry-pick 与 rebase 预览、多检出状态与 worktree 绑定、整合状态、读 / 写 / 执行授权与不存在的工作空间；操作队列三条路各起一个操作、轮询到结束、读同一个操作逐字节相等、别的工作空间 404、取消；rebase 三次从同一分支起、过程与结果一样；拒绝（不许写、不认识的操作、字段不合法、不是本工作空间的会话）；形状错只比码与状态；scope 与路由表一致；Git 面迁完（每条 Git 路由恰好属于 `git` 或 `gitRepository`）。E3-5a 的切分边界用例改为核对其余路径恰好是 gitRepository 那 23 条。
- `pnpm --filter @armadra/web test`：400 个文件、3716 条通过；`typecheck` 通过。`api/client.git-repository.test.ts` 按 procedure 线上形状改写（11 条）。
- 探针（断网时加 `npm_config_verify_deps_before_run=false npm_config_minimum_release_age=0 npm_config_manage_package_manager_versions=false`）：`git-tool-window` 通过（日志、提交两页与手机四级导航截图，日志与分支树经 `gitRepository.log` / `refs`）；A 档 `ui-features-e2e` 通过；`remote-e2e` 全部通过，Git 段（远端状态、暂存、提交、fetch 进行中与取消）都过；`server-e2e` 全部通过。
- E3-5a 记下的两处失败（`remote-e2e` 的 `08b-remote-acp`、`server-e2e` 的「新建浏览器」）：在 origin/main 80a65133 的临时检出上各跑一次，两处都通过；本分支上也都通过。两者在当前 main 上不复现。推测与 #154 补的 node-pty `spawn-helper` 执行位有关（ACP 适配器与无头浏览器都经 pty 起），未逐个回溯确认。

没做 / 偏离：

- 形状错（缺字段、类型不对）经旧路径与 procedure 由入参校验先答 `bad_request`（带 `details.issues`），与迁移前那句原话不同；码与状态不变。旧路径答 500 `internal_error` 时，门面按 §34.1 不外泄原话。
- `log` 的 `limit` 在契约里是数字，旧路径体里写成数字串的会被形状校验拒绝（页面一直发数字）。
- `log`、`statusBatch`、`worktreeBinding` 只读但旧路径是 `POST`，scope 照旧是 `git:write`，没有顺手改成 `git:read`。

## E3-6 工程规范化：forge / github 域迁到契约（契约 §41）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-6）；契约 §41。

做了什么：

- **33 个本地 schema 搬进 shared**（`packages/shared/src/api/github.ts`）：同一张字段表实例化两次——页面读回的形状（`int64` 回 `bigint`、缺字段补零、认不出的枚举落 `UNSPECIFIED`）与线上的形状（契约出参，无变换、多出的字段原样放行，`githubIssueWireSchema` 等）。13 个枚举常量一并搬入，页面 `api/github.ts` 原样再导出，调用点 import 不变。
- **契约**：`github.*` 24 条（`contract/github.ts`，§41.1）、`forge.*` 20 条（`contract/forge.ts`，§41.2，旧路径全挂 `meta.legacy`；配置的两个路径形各一对 procedure）。`since` 1.11，协议 minor 10 → 11。
- **core**：forge 收成一份 `operations`（`forge/routes.ts`），旧 handler 与 `registerProcedures` 共用；github 的 24 个动词经 `GithubHttp.register` 登记，与旧的 `POST /api/github/<动词>` 走同一个 `invoke` 与同一张字段表。procedure 的调用方来自准入门核验过的请求身份，`GithubService.authorize` 照旧再核。
- **错误码 snake_case**：GitHub 面 `INVALID_ARGUMENT / UNAUTHENTICATED / PERMISSION_DENIED / NOT_FOUND / CONFLICT / RESOURCE_EXHAUSTED / UNSUPPORTED / UNKNOWN_OUTCOME / INTERNAL` 换成 `bad_request / unauthenticated / forbidden / not_found / conflict / rate_limited / unsupported / unknown_outcome / internal`（状态与英文原话不变）；forge 的 500 `internal_error` 并入 `internal`。页面 `MESSAGE_BY_CODE` 与 `classifyGithubFailure` 两种拼法都认一个 minor，`api/message-by-code.test.ts` 逐对核对取同一句话。
- **页面**：`api/github.ts` 的 `GithubApi` 经 `githubApiFor(rpc)`（`runtimeApi.openGithub(workspaceId, source?)`）走 `clientFor(source)`；`api/forge.ts` 的函数经 `currentClient().forge`。
- **契约 §41**：§41.1、§41.2 生成块与说明；§3.3 错误码表改写；§5、§29 加指向。

实测（macOS arm64，基于最新 origin/main，protocol minor 11）：

- `pnpm check`：除 `notices:check` 外全过（lint 0 error；`notices:check` 要装依赖的离线仓库，本机该 worktree 没有，本包未动依赖，未跑）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：424 个文件通过、11 跳过（5047 过 / 74 跳过），脚本 72 过 0 败。新增 `core/contract/parity-forge.test.ts`（16 条：路由表原 handler、旧路径、procedure 三者逐字节相等，含 GitLab 多级子组、DELETE 查询串、令牌与地址凭据不回显、远端 401/403/429 的码）与 `parity-github.test.ts`（12 条：旧路径与 procedure 经真会话对偶，含只读会话写被拒、别的工作空间被拒、限流原话不外传、无会话 401）。
- `pnpm --filter @armadra/web test`：401 个文件、3737 条通过；`typecheck` 通过。`api/github.test.ts`、`api/forge.test.ts` 按 procedure 线上形状改写。`@armadra/server`、`@armadra/shared` 测试通过。
- dev-stack Gitea（自起一个独立容器 `127.0.0.1:3010`，用后已删；共享卷里的管理员口令与本 worktree 的不符，所以没用 `dev-stack up gitea`，已把自己起的 `armadra-dev-gitea-1` 点名 `down`）：`gitea.devstack.integration.test.ts` 通过；`forge-panel` 探针（真 Gitea + 回放的假 GitLab，页面经 procedure）全部截图通过。A 档 `ui-features-e2e` 通过。

没做 / 偏离：

- **github 没有 `meta.legacy`**：`/api/github/` 是整段自己认证的原样路由（Origin、CSRF、查询串里的工作空间），不在路由表的逐条模式里；旧路径保留为原样路由，与 procedure 的对偶由 `parity-github.test.ts` 核对。
- 旧路径的 GitHub 错误码也换成了 snake_case（外部脚本若认大写要跟着改）。
- 形状错（类型不对）经 procedure 与 forge 旧路径由入参校验先答 `bad_request`（带 `details.issues`）；forge 入参的必填检查留在域里，所以缺字段仍是原话。
- 门面补了一处：空体的旧路径 `DELETE` 把查询串当作体（上游只读 `GET` 的查询串）；`/api/forge/resolve` 在路由规则表里单列为读权限。
- 大写拼法与 `error.permissionDenied` 文案键删去（`PERMISSION_DENIED` 现取 `error.forbidden`）；大写拼法的映射下个 minor 删。

## E3-8a 工程规范化：acp、workflows、coordinator 三个域迁到契约（契约 §43.1–§43.3，E3-8 第一部分）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-8）；契约 §43。E3-8 分 2–3 个 PR：本包做 `acp`、`workflows`、`coordinator`；`push`、`mail`、`credentials`、`gateway`、`diagnostics` 在第二部分，节号接在 §43.3 之后。

做了什么：

- **契约**（`packages/shared/src/contract/{acp,workflows,coordinator}.ts`）：`acp.*` 7 条（起会话、发提示、打断、切模式、切模型、读镜像、切换驱动）、`workflows.*` 15 条（草案 4、模板 6、运行 5，含关卡答复）、`coordinator.*` 2 条（任务读与重试）。`since` 1.12，协议 minor 11 → 12（E3-7 若先合要改号）。出参：ACP 镜像写成已知字段加原样透传；草案与模板的正文放宽成 JSON 对象（页面那份 `workflowDraftSchema` 带 `superRefine` 与默认值，契约不能比旧路径挑剔），页面读回时再解析一遍。入参只校形状，取值与长度仍在域里判。
- **scope 进 meta**：每条等于 `route-scopes.ts` 给旧路径的要求（对偶测试逐条断言）：ACP 读镜像 `terminal:read`、其余 `terminal:create`；工作流与任务读 `canvas:read`、写 `agent:launch`（关卡答复也是 `agent:launch`，不是 `approval:answer`）。
- **core**：`acp/routes.ts` 各动词收成一份操作，旧 handler 与 `registerProcedures(server, "acp", …)` 同调，`AcpError` 换成同码同状态的 `CoreFailure`。`workflow/routes.ts` 收成 `workflowOperations(service)` 与 `installWorkflowRoutes(server, service)`：**工作流原来整段挂在 `server.raw("/api/workflows/")` 上，不在路由表里，`meta.legacy` 挂不上，所以 13 条路径登记进 `http/routes.ts`（用一张小表生成，文件仍在 1500 行内），旧 handler 改走路由表**，`workflows.*` 与 `coordinator.*` 同调一份。调度域的 `upgrade` 桥改成显式收工作空间（旧路径从查询串读，procedure 从入参读，两种都到得了）。
- **门面补一处**：`gateRequest` 还原旧路径时，读与删的入参一并放进查询串——否则路由门里按 `request.query.get("boardId")` 取画板的规则对 procedure 看不到，成员会被一律拒（旧路径不受影响）。
- **页面**：`acp/api.ts`、`workflow/api.ts`、`coordinator/api.ts` 经 `currentClient()` / `clientFor(source)`（分派抽屉按事件所属的源发），导出的函数签名不变，答案仍过页面自己的 schema。`acp` 页面的审批卡片与 elicitation 答复改走已有的 `agents.answerApproval`；输出到画板的代码块与输入框租约不在这几个域，没动。
- **契约 §43**：§43.1–§43.3 生成块与说明，§14、§15 加指向。

实测（macOS arm64，基于最新 origin/main，protocol minor 12）：

- `pnpm check` 通过（含 `contract:check`、lint 0 error、三处 typecheck、`repo:check`、notices）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：426 个文件通过、11 跳过（5091 过 / 74 跳过）。新增 `core/contract/parity-acp.test.ts`（19 条）与 `parity-workflows.test.ts`（25 条，含 coordinator）：路由表原 handler、旧路径、procedure 三者逐字节相等（含 201 / 204 的状态差、404、409、400 与带 `details.issues` 的形状错）。**投递门**一节用真的 `createRouteGuard`、真库查询与成员身份，两条路答同一个 403：只读 / 别的画布上的人开不了 ACP 会话（一行都没多出来）、拿别画布的节点起会话被拒；不是自己开的会话，viewer / editor / operator / 别的画布上的人写不进去，**镜像逐字节没变**，driver 写得进去；切换别人节点的驱动要 driver；`acp.*` 里没有答审批的动词。工作流：模板的写只有 owner（operator 与 driver 也被拒，模板没被改）；viewer / editor / 别的画布上的人确认不了草案、起不了跑、答不了关卡、取消不了运行、重试不了任务，**草案仍待确认、运行仍在等、任务仍是失败**；关卡的 scope 是 `agent:launch` 且不等于 `approval:answer`。
- `pnpm --filter @armadra/web test`：403 个文件、3753 条通过；`typecheck` 通过。新增 `api/client.acp.test.ts`（7 条）、`api/client.workflows.test.ts`（9 条，含 coordinator 按源发）。`@armadra/server`（98 过 4 跳过）、`@armadra/shared`（366 过）测试通过。
- A 档（`node tools/ci/e2e.mjs --tier a --only agent-e2e-self-test,acp-e2e,workflow-e2e`，先 build web / desktop / server）：三项通过——`acp-e2e` 44 s、`agent-e2e-self-test` 228 s（含 11-coordinator、12-acp 的 claude / codex / opencode / pi / omp / copilot 回合与驱动切换）、`workflow-e2e` 30 s。探针都用临时 HOME 与独立数据目录，没碰真实库。

没做 / 偏离：

- 「没有自动化域」（升级计划）与「协作域还没装好」（重试）从 `409 unsupported` 改成 `501 unsupported`：注册表里 `unsupported` 登记的就是 501，同一个码不能在两处答出两个状态。
- 形状错（类型不对）经旧路径与 procedure 由入参校验先答 `bad_request`（带 `details.issues`），与迁移前域里那句原话不同，码与状态不变（与 E3-1–E3-6 同）；缺字段仍由域答原话。
- 工作流从 `server.raw` 改进路由表后，意外的内部错误由门面统一答 `500 internal` 并上报，不再是旧 handler 吞掉后答的 `internal_error` / 「工作流请求处理失败」；未知路径与不收的方法由路由表答 404 / 405（码同前，原话换成路由表的）。
- 这三个域没有订阅：ACP 与工作流的事件（`acp.update`、`acp.turn`、`workflow.run` 等）仍走工作空间事件流（§35 的 `workspaces.events`），不另起 `eventIterator`。
- `exportText`（输出到画板的代码块）与 `drive`（输入框租约）不在这几个域，仍走各自的旧调用；节点令牌路径随凭据域在第二部分。

## E3-7 工程规范化：identity、security、accounts 三个域迁到契约（契约 §42）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-7）；契约 §42。

做了什么：

- **契约**（`packages/shared/src/contract/{identity,security,accounts}.ts`）：45 条会话内的动作——`identity.session`、`identity.devices.{list,revoke}`（§42.1，与 §31 的 `identity.cloud.*` 同一个域，`cloud.ts` 改成导出子树）；`security.*` 22 条（passkey 5、两步验证 6、会话 3、锁定 2、OAuth 提供方表 / 密钥 / 绑定 5、审计 1，§42.2）；`accounts.*` 20 条（账号 4 含签重置链接、凭据 3、邀请 4、组 6、共享 3，§42.3）。旧路径都挂在 `/api/identity/` 上（`meta.legacy`），`scope` 等于路由表给旧路径的那一档。`since` 1.13，协议 minor 12 → 13（11 给了 E3-6、12 给了 E3-8a）。
- **留在 REST 的匿名面**（§42.4 登记）：hello、配对、ws-ticket、刷新 / 换 CSRF / 登出、口令登录与两步登录、passkey 断言、持邀请注册、OAuth 发起 / 回调 / 原生收尾、登录页的匿名提供方表、口令重置链接、审计导出（CSV）、`cloud/login`。§31–§33 已经是契约，只登记。`contract.test.ts` 加三条守卫：三域都要会话、节号 §42.1–§42.3；凭据换会话的那几条不在契约里；口令、密钥与邀请令牌只在入参。
- **core 一份实现**：`identity/accounts-http.ts` 拆成三份——`http-support.ts`（上下文、认人、体的解析、加固审计、口令策略与泄露检查、失败计数、发会话）、`accounts-http.ts`（`accountOperations` 与账号面的分发、注册、审计）、`security-http.ts`（`securityOperations` 与登录、passkey、MFA、会话、锁定、重置链接的分发）。`identity/http.ts` 收出 `identityOperations`（会话与设备），OAuth 的提供方表、密钥与绑定成为 `OAuthHttp` 的公开方法。旧路径分发与 `identity/procedures.ts`（`registerProcedures` 三个域）调同一份；操作的入参是取值函数，旧路径照旧在认人之后才解析体，迁移前的判定顺序与答案不变。路由表的身份三域旧路径放在 `http/routes-identity.ts`（单文件 1500 行上限）。
- **认人**：`RequestIdentity` 带上门认过的会话（`session: { sessionId, origin }`，`sessionIdentity` 给回环、Gateway、中继三道门共用）；`AccessRequest.verifiedSessionId` 按会话再认一次（会话活着、访问期没过、设备与账号没被撤或停用），不比对令牌——控制面上没有令牌可比，页面刷新过访问令牌之后连接仍是同一个会话。只由 core 从请求身份里取。门不在（`ARMADRA_LOOPBACK_OWNER=1` 的裸 core）时按请求里的凭据认，Cookie 会话的写要 CSRF，与旧路径同。
- **码**：procedure 上身份域的大写码换成注册表的码（`unauthenticated` / `forbidden` / `bad_request` / `conflict` / `not_found` / `not_implemented`），§18 的具名码与状态不变，限流与锁定的等待秒数进 `details.retryAfterSeconds`。旧路径的码不变。
- **页面**：`api/accounts.ts`、`api/security.ts` 的会话内动作经 `identityRpc`（`clientFor(localSource)`）发，函数签名与 `IdentityRequestError` / `IdentityTransportError` 不变；设备的列与撤从 `api/identity.ts` 挪到 `api/security.ts`；本机邀请（`api/remote-services.ts`）改用 `accounts.invitations.*`——A1-4 记下的「桌面壳跨端口带 Cookie 过不了 CORS」随之消失（Bearer、不带 Cookie）。登录、注册、重置链接与登录页的匿名提供方表仍走 `identity.ts` 的 REST 传输。
- **两处页面传输的修补**：Bearer 传输的 401 只在会话失效（`unauthenticated`）时续期重发，具名的 401（`mfa_invalid_code`）不重发——重发会把一次输错的码记成两次失败；Cookie 会话的 RPC 发出时还没有 CSRF、途中会话建好了（配对那一刻），带上新令牌重发一次。设备查询带 `signal`，会话变了先取消在路上的那一次再重取（gateway-e2e 发现：配对与设备列表同时在路上时，表一直是空的）。
- **契约 §42**：§42.1–§42.3 生成块与说明，§42.4 登记表；架构表加 `identity/procedures.ts`。E1 的 `system.*` 与 E2 的 `/api/ws` 要全局 `identity:read`、走 `route-access.ts` 的那条全局规则，与 §42 一致：§42 的 procedure 都挂在 `SELF_GUARDED` 的旧路径上，不经那一条。

实测（macOS arm64，合入 origin/main（含 #159 E3-6、#160 E3-8a）之后）：

- `pnpm check` 通过（含 `contract:check`、lint 0 error、三处 typecheck、`repo:check`、notices；本包改到的文件只有一条既有警告）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 428 个文件通过、10 跳过（5116 过 / 67 跳过），live 4 过，脚本 72 过 / 0 失败。新增 `core/contract/parity-identity.test.ts` 18 条：真 core（身份域整个装上、回环准入门、路由门、审计）上旧路径与 procedure 对同一件事逐字节相等（旧路径 201 对 procedure 200），覆盖全部 45 条；`system.hello` 报的表里都有、minor 13、scope 与路由表一致；控制面上同一条会话调 `identity.session` 与旧路径相同。**拒绝路径**两条路都拒：无会话与伪造的 Bearer 401；Cookie 会话错 CSRF 403（procedure 读也要 CSRF，带对的放行，Bearer 写不要）；成员越权（建人、锁定列表、MFA 重置、全局审计、全部会话、OAuth 密钥、邀请列表、共享、替 owner 签重置链接、撤设备）403，本人的照常，别人的会话 404，停用之后下一次 401；连错口令 5 次锁定后 `mfa.disable` 两条路都 429 `account_locked`，`Retry-After` 与 `retryAfterSeconds` 同一个数，owner 看得见、解得开，审计记了锁定、不含口令；会话被撤之后 procedure 401；口令（含策略拒绝的那一份）不出现在任何答案里。`http/peer.fixture.ts` 的 procedure 名按全部的点拆（三段名原来拼错）。
- `pnpm --filter @armadra/web test`：404 个文件、3759 条通过；`typecheck` 通过。`api/accounts.csrf.test.ts` 按 procedure 改写（Cookie 会话读写都带 CSRF、被拒换一枚重发一次、再拒照实报）；新增 `api/identity-rpc.test.ts`（桌面壳里账号与本机邀请是 Bearer、不带 Cookie 与 CSRF）、`security.test.ts` 补 4 条（设备、错误换回、连不上、匿名提供方表仍走 REST）、`client.rpc.test.ts` 补 1 条、`sources/transport.test.ts` 补 1 条；`identity.test.ts`、`HostPage.test.tsx`、`remote-services.test.ts` 按新的线上形状改。
- `@armadra/server` 98 过 4 跳过，`@armadra/shared` 372 过。
- A 档（先 build desktop / server / web；`node tools/ci/e2e.mjs --tier a --only gateway-e2e,server-e2e,personal-roundtrip,ui-features-e2e`）：四项通过——`gateway-e2e` 33 s（配对、邀请注册、成员 403、页面配对、设备表、重置链接、passkey 审计）、`server-e2e` 89 s（服务器壳 Cookie 会话、共享与撤销、成员逐页打开设置无 403）、`personal-roundtrip` 114 s（个人中转登记、邀请链接、cloud/login、撤销）、`ui-features-e2e` 187 s。探针都用临时 HOME 与独立数据目录。

没做 / 偏离：

- 规格写「约 16 条路径」，按路径族数；落地是 45 条 procedure，覆盖 `/api/identity/` 下全部会话内动作。
- 留在 REST 的比规格列的多：口令登录、两步登录、passkey 断言、持邀请注册、刷新 / 换 CSRF / 登出也先于会话或要发 Cookie，与配对同一类；`/api/rpc/` 在门上就要会话，它们进不来。页面开张时判「有没有会话」仍读旧路径 `GET session`（那时 Cookie 会话手里还没有 CSRF）；`identity.session` 给远程源与控制面用。
- 旧路径的大写码不改（已装机的原生 App 认它们），错误码守卫的大写存量名单因此还留着身份域那几个；procedure 上已经是注册表的码。§18 的具名码（`password_*`、`passkey_*`、`mfa_*`、`oauth_*`）没有登记进注册表（注册表要求 core 里有字面量用法，这些码由变量给出），契约的 `errors` 一列只写注册过的，具名码写在 §42 的说明里。
- `scope` 一列沿用路由表给 `/api/identity/` 的「管别人的」那一档（如 passkey 的写是 `identity:manage`），实际判定在身份域：门面按旧路径问路由门，`SELF_GUARDED` 对成员放行。路由表为清单补了会话、设备、锁定、账号、凭据、邀请、组与共享几行。
- Cookie 会话上 procedure 一律 `POST`，读也要 CSRF（旧路径读不要）；页面的 Cookie 凭据本来就先换一枚再发。
- `GatewaySection` 的「取消在路上的那一次」靠 gateway-e2e 覆盖，没有单独的组件用例。

## E3-8b 工程规范化：push、mail、credentials、gateway、diagnostics 五个域迁到契约（契约 §43.4–§43.8，E3-8 第二部分）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-8）；契约 §43。第一部分（acp、workflows、coordinator）见上一节，本包收尾 E3-8。

做了什么：

- **契约**（`packages/shared/src/contract/{push,mail,credentials,gateway,diagnostics}.ts`）：`push.*` 6 条（配置、设备列表、登记、改偏好、撤销、测试通知）、`mail.*` 3 条（状态、发邀请、发重置链接）、`credentials.*` 4 条、`gateway.*` 4 条（状态、改配置、铸票，加匿名的短码换票）、`diagnostics.*` 2 条。`since` 1.14，协议 minor 13 → 14（E3-7 的 13 已先合入）。出参复用页面那套 `api/*` schema，只有凭据的条目与列表另写一份不带透传的（原来的 `z.looseObject` 有未知键的位置，装得下东西；契约的守卫也不许）。入参只校形状，取值仍在域里判。
- **scope 进 meta**：逐条等于 `route-scopes.ts` 给旧路径的清单（对偶测试逐条断言）：push 与 diagnostics 是 `canvas:read`，mail 的 `status` 是 `identity:read`、发送是 `identity:manage`，凭据与 Gateway 读 `settings:read`、写 `settings:write`。push、mail、diagnostics 在 `SELF_GUARDED` 里：门放行，判定（匿名 401、别人的设备 404、本组 admin、限流）在域里，和迁移前一样。
- **core**：每个域把动作收成一份操作（`push/routes.ts` 的 `operations`、`mail/routes.ts`、`agent/credentials/routes.ts`、`gateway/routes.ts` 的 `gatewayOperations`、`diagnostics/routes.ts`），旧 handler 与 `registerProcedures` 调同一份，拒绝都是 `CoreFailure`。`CredentialError` 改为 `CoreFailure` 的子类；密钥后端抛的别的错误一律换成**不带原因**的固定拒绝再往外走（异常消息可能带路径，门面会把它写进日志）。
- **门面补两处**（`http/rpc.ts`）：① 限流的 429 带 `details.retryAfterSeconds` 时，RPC 与旧路径的响应都给 `Retry-After` 头（`http/errors.ts` 加 `rateLimited` 与 `failureResult`；E3-7 的身份域本来就写 `details.retryAfterSeconds`，它的 procedure 现在也带这个头，`parity-identity.test.ts` 里那条「procedure 没有头」的断言相应改为有头）；② 旧路径只由**登记了实现**的 procedure 接管——匿名面的 procedure 只登记形状不登记实现，不再让门面把它的旧路径答成 501。
- **匿名面**：配对短码换票（§24.2）登记成 `gateway.exchangePairingCode`（`scope: null`，与 `identity.cloud.login` 同一种做法），**RPC 路径不实现**（501，不在 `system.hello` 的表里），旧路径仍由路由表那条 handler 答（Gateway 准入放行、限流与档位在域里判）。`contract.test.ts` 的匿名清单与路径正则相应加这一条。`GET /ca.crt` 等 Gateway 的 REST 匿名面不是 core 的 JSON 面，不在契约里。
- **页面**：新增 `api/push.ts`；`api/credentials.ts`、`api/gateway.ts`、`api/mail.ts`、`diagnostics/report.ts` 经 `currentClient()`，导出的函数签名不变，答案仍过页面自己的 schema；`push/service-worker.ts`、`mobile/PushPermission.tsx`、`mobile/push-rotation.ts` 改调 `pushApi`。换票 `exchangePairingCode` 不走 RPC 客户端（还没有会话）。
- **契约 §43**：§43.4–§43.8 生成块与说明，§17、§19、§20、§28、§30 加指向；新登记进错误码注册表的码：`invalid_origin` 与七个 `credential_*`（`error-codes.test.ts` 的「还在被用」扫描加上 `CredentialError`、`GatewayError` 两种写法，`coreError` 字面量下限从 50 放到 10——迁走一批之后本来就少了）。

实测（macOS arm64，基于合并了 E3-7 的最新 origin/main，protocol minor 14）：

- `pnpm check` 通过（含 `contract:check`、lint 0 error、三处 typecheck、`repo:check`、notices）。
- `pnpm libs:build && pnpm --filter @armadra/desktop test`：432 个文件通过、11 跳过（5172 过 / 74 跳过），脚本测试 72 过。新增 `core/contract/parity-{push,mail,credentials,gateway,diagnostics}.test.ts`（14 / 10 / 12 / 17 / 10 条）与共用件 `parity-kit.ts`：路由表原 handler、旧路径、procedure 三者逐字节相等（含 201 / 204 / 202 的状态差、404、409、400、401、429 与 `Retry-After`）。**安全面**：凭据——每个答案、日志与审计事件里都没有值（成功的、被拒的、后端坏了的，连异常消息里夹着值也没有），成员读写改删一律 403 且密钥后端的值原样没动；Gateway——成员 403、配对票不进审计与日志、取值错时设置没动、壳托管时 409、换票的限流与档位；邮件——本组 admin / 跨组 / 匿名、被拒时信箱里一封没多、令牌与地址不进答案与审计；推送——成员改不了也撤不掉别人的设备（与不存在同一句 404，设备原样在）、答案里没有令牌与密钥；页面错误上报——收下的错误先剥离（家目录与密钥不外泄）、关着不看请求体。
- `pnpm --filter @armadra/web test`：405 个文件、3770 条通过；`typecheck` 通过。新增 `api/client.platform.test.ts`（11 条，五个域的页面一侧：procedure 名、体、答案、拒绝码、凭据值只出现在请求体）；`mobile/PushPermission.test.tsx`、`push-rotation.test.ts`、`HostPage.test.tsx` 的假 core 改成答 procedure。`@armadra/server`（98 过 4 跳过）、`@armadra/shared`（372 过）测试通过。
- A 档（先 build web / desktop / server / push-relay）：`node tools/ci/e2e.mjs --tier a --only push-e2e,gateway-e2e,server-e2e` 三项通过（gateway-e2e 34 s、push-e2e 3 s、server-e2e 87 s）；`node tools/probes/credentials-e2e.mjs` 通过（假令牌、临时 HOME 与数据目录、`file-encrypted` 后端，值不在画面、日志与列表里）。

没做 / 偏离：

- 旧路径的体多了一个键：限流的 429（邮件、页面错误上报）现在带 `details.retryAfterSeconds`（从前只有头）；页面错误上报的头名从 `Retry-After` 统一成小写 `retry-after`（HTTP 头不分大小写）。
- 页面错误上报的旧路径成功状态一律 `202`（`{ accepted: false }` 从前是 `200`）：契约的 `successStatus` 是静态的；procedure 恒为 `200`。页面不看状态。
- 凭据的 `500 internal` 原话从英文句子换成门面统一的那一句；其余码、状态与原话不变。
- 形状错（类型不对、Gateway 配置里多出来的键）经旧路径与 procedure 由入参校验先答 `bad_request`（带 `details.issues`），与迁移前域里那句原话不同，码与状态不变（与 E3-1–E3-8a 同）；缺字段与取值错仍由域答原话。
- Gateway 的配对短码换票成功一路（需要真票）在对偶测试里没覆盖，由 `gateway.integration.test.ts` 与 `gateway-e2e` 覆盖；对偶测试覆盖它的 404 / 403 / 429 / 400 与「不经 RPC」。
- 这五个域没有订阅；`gateway-e2e` 与 `push-e2e` 只证明旧路径经门面接管之后行为不变，没有改它们的断言。

## E3-9 工程规范化：语言会话是否并入控制面（评估，契约 §35.6）

规格：[工程规范化包](../design/platform/engineering-packages.md) §3（E3-9「量补全请求频率与体积后决定；默认保持独立连接」）；设计：[工程规范化](../design/engineering-standardization.md) §3.1、F10。

结论：**不并入，保持独立连接。** 契约 §35.6 把语言会话登记为控制面之外的数据面例外（连接、帧、升级前拒绝、关闭码、中继、重新评估的条件）；工程规范化 §0、§2.3、§3.1 与 F10 同步改成已定。没有改 core 与页面的代码。

做了什么：

- **探针** `tools/probes/language-load.mjs`（纯函数在 `language-load-lib.mjs`，测试 `language-load.test.mjs` 6 例进 `pnpm release:test`；README 一节；基线 `language-load-baseline.json`）：真 core（临时 `ARMADRA_DATA_DIR`、`probe-home` 的临时 HOME、file 后端 SecretStore、随机端口，跑完删除，意外退出也同步杀子进程）+ 真语言会话代理。语言服务器是 `mock-lsp.mjs`，新加 `--completion-items` / `--member-items` / `--hover-bytes` / `--diagnostics` 四个参数按 TypeScript 服务器的体积塑形（补全 1200 项、`.` 后 80 项、悬停 2 KiB、每次诊断 25 条；不给参数时行为与原来一样，语言域 71 例照过）；本机有 clangd 时再跑真服务器（Apple clangd 21.0.0，借 `gopls` 的覆盖项启动，打开 `.c` 文件）。客户端按页面 CodeMirror 语言客户端的节奏打字：`editor` 档 1 个编辑器 8 字 / 秒，词首与 `.` 后 100 ms 请求补全、请求前 `didChange`、停手 150 ms 再 `didChange`，每 2 秒一次悬停；`stress` 档 3 个编辑器各 15 字 / 秒，每个字符都 `didChange` 加补全（服务器答 `isIncomplete` 时的上限）。
- **四段测量**：A 语言流本身；B 回环上与控制面 `/api/ws` 的 `workspaces.events` 混跑，每 100 ms 存一次画布，量 `board.changed` 从发起保存到控制面收到；C 本机塑形代理模拟共享瓶颈（1 MiB/s、单程 20 ms，近似手机网络或家宽上行；每条连接积压过 256 KiB 就停读 core 那一侧，背压交回 core），`fair` = 每条连接一个队列轮转（独立连接），`fifo` = 所有字节一个队列（并进一条连接，语言帧挡在事件前面）；D 经 armadra-cloud 的真个人中转（init + serve、自签 TLS、core 登记与绑主人、客户端以原生来源经中继 `cloud/login`，语言流与控制面各一条隧道流），再加一段中继 + 瓶颈。

实测（macOS arm64，Node 26.10.0，机器 load 7–11，2026-10-06；第一次每段 15 秒，第二次 10 秒加 `--check`，括号里是第二次）：

语言流本身（A，回环）：

| 场景          | 下行帧 / s | 下行 KiB/s | 下行单帧 p50 / p95 / max         | 100 ms 峰值       | 上行帧 / s | 补全往返 p95 |
| ------------- | ---------: | ---------: | -------------------------------- | ----------------- | ---------: | -----------: |
| mock editor   |  3.5 (2.9) |        516 | 14 188 B / 342 358 B / 342 358 B | 3 帧 / 348 KiB    |        3.5 |   47 (26) ms |
| mock stress   |      161.6 |     13 220 | 14 190 B / 341 159 B / 344 759 B | 26 帧 / 2 244 KiB |       77.7 |   40 (41) ms |
| clangd editor |        2.7 |         28 | 353 B / 47 790 B / 49 473 B      | 3 帧 / 49 KiB     |        2.7 |   27 (10) ms |
| clangd stress |      158.0 |        389 | 548 B / 9 441 B / 53 092 B       | 36 帧 / 303 KiB   |       73.7 |    13 (9) ms |

按种类：补全答案是大帧（mock 338–345 KB，clangd 16–53 KB，clangd 缺省最多 100 项），诊断推送是高频帧（stress 下每秒 126 条，mock 14 KB、clangd 0.5–1.6 KB），悬停 2 KB 以内；上行全是小帧（`didChange` 0.2–1.1 KB，请求 0.2 KB）。

事件延迟（`board.changed`，p50 / p95 / max，ms）：

| 段                  | 只有事件                | + mock editor            | + mock stress             | + clangd editor     | + clangd stress          |
| ------------------- | ----------------------- | ------------------------ | ------------------------- | ------------------- | ------------------------ |
| B 回环（现状）      | 2.7 / 3.4 (11.5) / 12.7 | —                        | 3.2 / 12.2 (9.7) / 22.7   | —                   | —                        |
| C 瓶颈 fair（独立） | 27 / 36.5 (24.7) / 41   | 26 / 36.4 (28.0) / 51    | 32 / 45.2 (60.9) / 96     | 26 / 33.8 (53) / 41 | 25 / 33.8 (45.6) / 39    |
| C 瓶颈 fifo（并入） | —                       | 24 / **317 (342)** / 357 | **581 / 594 (878) / 849** | 24 / 29.6 (63) / 41 | 24 / **180 (240)** / 312 |
| D 中继（独立）      | 2.7 / 6.5 (31.2) / 8.7  | 2.8 / 5.0 (18.9) / 14.5  | 3.7 / 15.4 (16.8) / 28.3  | —                   | —                        |
| D 中继 + 瓶颈 fair  | 24 / 32.3 (30.6) / 67   | 25 / 30.2 (28.5) / 44    | —                         | —                   | —                        |
| D 中继 + 瓶颈 fifo  | —                       | 24 / **284 (271)** / 335 | —                         | —                   | —                        |

- 经中继（回环上的真中继）语言 stress 下行 13 MiB/s、补全往返 p95 52 ms，三条语言流与控制面都没被关（关流码全空），没有丢事件。
- 两次的帧体积一致，`--check` 通过；延迟随机器负载跳，结论不变：**独立连接时语言负载对事件 p95 的影响在 0–25 ms 之内（多半是 core 的 CPU），并进一条连接后在 1 MiB/s 的链路上 editor 档就让事件 p95 涨到 0.3 秒，stress 档 0.6–0.9 秒**。
- 验证：`pnpm check` 通过；`node --test tools/probes/language-load.test.mjs` 6 过（也在 `pnpm release:test` 里）；`apps/desktop` 的 `src/core/language` 71 例过（`mock-lsp` 的缺省行为没变）；探针连跑两次（15 秒档与 10 秒档 `--check`）都通过，跑完没有残留进程与临时目录。

为什么不并入：

1. **队头阻塞**：一个补全答案 340 KB（TypeScript 体积）或 50 KB（clangd），同一条连接上排在它后面的事件要等它整帧送完；1 MiB/s 上是 330 ms / 48 ms。上表 fifo 一行就是这个，fair 一行不受影响。
2. **背压不相容**：语言流不能丢也不能重放（请求与答案一一对应、诊断是状态），只能「暂停」——core 暂停的是语言服务器的 stdout，按服务器算，同一服务器的几个会话一起等（契约 §3.4）。控制面的发送缓冲是整条连接的，策略是丢旧 / 合并 / 重订：合在一起，事件的拥塞会暂停语言服务器，语言的积压会让事件订阅 `overflow` 后反复重订。实测 stress 档 1 秒峰值 17 MB，远超控制面 1 MiB 的排队线。
3. **中继的流配额**：中继每条流的初始信用 256 KiB、整条隧道 8 MiB、每隧道最多 256 条流（armadra-cloud 协议包 `LIMITS`）。一个 340 KB 的补全就超过单流信用，要等一次 `WINDOW` 回补；并入控制面，事件和补全分同一份 256 KiB。分开时一个会话一条流，最多 32 个会话（`MAX_SESSIONS`），离 256 条流还远；中继的限流按 HTTP 请求与升级计数，不按帧，独立连接多出来的只是每个会话一次升级。
4. **手机**：手机下行窄、抖动大，正是上面 C / D 段的瓶颈情形；控制面上的事件（Agent 状态、审批、通知）是手机上最要紧的，不该排在补全后面。语言会话的连接本身就是会话的生命周期，后台被系统断开后重开会话即可；并入控制面也换不来续订，因为语言流没有可续的序号。
5. **形状**：上游 RPC 的流是单向的（服务端 → 客户端），语言会话是双向的；并入要么上行每条 `didChange` / 请求都变成一次调用，要么另造一种帧，两样都比现在多一层而没有收益。

没做 / 偏离：

- 没有真的把语言流并进 `/api/ws` 再量：「并入」用共享瓶颈上的单一 FIFO 队列近似（所有连接的字节按 core 写出的先后排队），没有算 oRPC peer 帧的封装开销与控制面门面的排队，真并入只会更慢。
- 塑形代理的 `fair` 是理想的轮转；真实网络上几条 TCP 连接分享瓶颈不会这么均匀，路由器的缓冲也会让独立连接的事件多等一点——但不会等一整帧补全。
- 本机没有 TypeScript / Python 的真语言服务器，TypeScript 的体积是按它的补全项形状估的（每项约 280 字节、全局补全 1200 项）；真服务器只量了 clangd。中继跑在回环上，只看了经中继的开销与关流；带宽受限的情形是在客户端到中继这一段加塑形代理。
- 探针不进 A 档（要几分钟、要 clangd 与 armadra-cloud 的检出才完整），本地按需跑；`--check` 只比确定性的帧体积。

接口：

- 契约 §35.6（新增，节号只追加）。
- `mock-lsp.mjs` 的四个塑形参数；`language-load-lib.mjs` 的 `SharedLink`（`fair` / `fifo` 共享瓶颈，可换时钟）、`summarizeFrames`、`burstPeak`、`keystrokeActions`。

## V2 修复：直连源刷新 CSRF、桌面直连 Origin、隧道静默超时

V2 探针（#167）发现的缺陷。契约 §17.4、§32.2。

做了什么：

- **Bearer 刷新不核 CSRF**（`core/identity/service.ts`、`http.ts`）：`refresh` / `logoutRefresh` 原先不分传输一律核会话绑定的 CSRF，契约 §17.4 规定 Bearer 模式没有 CSRF，`SourceClient.refresh` 按契约只带刷新票，于是直连源一刷新就 401、凭据被清。改为 HTTP 层按 `csrfRequired` 传 `requireCsrf`；服务层缺省仍要。Cookie 会话照旧要（刷新票在 Cookie 里是环境凭据）；Bearer 的刷新票在 `Authorization` 头里，跨站页面带不上，也过不了只回原生来源的 CORS，没有安全回退。页面与手机照旧带 CSRF（兼容还核它的旧版 core），注释改正。
- **桌面直连源的 Origin 改写**（`shell-core/remote-trust.ts`、`relay-origin.ts`）：修好刷新后直连组停在「离线」——core 以 `https://localhost` 与 Gateway 配对，访问令牌绑在 Bearer 模式上，页面却带回环来源去连，Gateway 403。改写名单 `relayOrigins` 更名 `rewriteOrigins`，加入直连源的 Gateway 来源。
- **隧道静默看门狗**（`core/relay/client.ts`）：只有「连续两次没有 PONG」时，最后一个 PONG 之后要到第三拍（60 秒）才断，`docker pause` 中继 60 秒整段停在 ready。就绪后超过 `heartbeatMisses × heartbeatMs`（缺省 40 秒，即两个心跳周期，与规格「两次」一致）没收到任何帧即以 `heartbeat_timeout` 断开，走原退避重连，`cloud.tunnel` 随状态变化。两条规则的 `lastError.message` 分开。
- 探针：multi-source 去掉「直连停在需要登录记已知问题」的旁路，直连必过；`startDirectServer` 补 `NODE_PATH`（否则直连源上的终端因找不到 node-pty 一连就断）；nat-core-offline 断言冻结 60 秒时 50 秒内发现断开（40 秒 + 采样 5 秒 + 余量 5 秒）。

实测（macOS arm64，2026-10-06，基于 main 4dae5463）：

- `pnpm check` 通过；`pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 432 文件 5178 过 / 74 跳过，live 4 过，脚本 73 过 / 0 失败。
- `ARMADRA_PROBE_STRICT=1 node tools/ci/e2e.mjs --tier a --only multi-source` 连过 3 次；`--only link-join` 连过 3 次；`--tier b --only nat-core-offline` 连过 3 次，发现断开 40.4–40.5 秒（采样粒度 5 秒），恢复后隧道 0.4–0.5 秒 ready。

没做 / 偏离：

- A3-2 一节「刷新带 `x-armadra-csrf`」的接口说明以本节为准：Bearer 刷新不要它（带了也不看）。
- `SourceClient` 没有为兼容旧版对端补发 CSRF（0.2.0 未发布，不做旧版兼容）。

## ACP 适配器的安装与重装（契约 §39.7）

用户发现 Codex 的 ACP 适配器没装，软件里只有新建向导能复制一条命令。

做了什么：

- **core**（`core/agent/adapter-install.ts`）：`agents.installAdapter({ agentId, reinstall? })` 与 `agents.adapterInstall({ agentId })`，只经 procedure。只认 `@armadra/shared` 的 `ACP_ADAPTER_PACKAGES`（claude、codex、pi）；命令固定为 `npm install --global <包>`，不收其他参数。npm 先用 CLI 所在 bin 目录里的那个，没有再用补齐过的 PATH 上的；子进程 PATH 以那个目录开头。任务在内存里，页面轮询；输出只留最后 40 行，去掉控制字符并脱敏（协作脱敏表 + npm 令牌、`_authToken`、URL 口令）。结束后忘掉记着的 ACP 版本并重新探测。只有 owner（scope `settings:write` / `settings:read`，域里再判主体）。开始、结束各写一条审计。不写 CLI 配置。协议 minor 升到 15。
- **包名表**：从 `NewAgentWizard.tsx` 的 `INSTALL_COMMANDS` 挪到 `packages/shared/src/api/acp.ts`（`ACP_ADAPTER_PACKAGES`、`AGENT_CLI_PACKAGES`、`acpInstallCommand`），页面与 core 共用。
- **页面**（`apps/web/src/acp/adapter-install.tsx`）：集成页每行 ACP 状态徽标旁是「安装 / 重新安装」；运行中徽标转圈、按钮停用；失败徽标可点开看原因（按码取文案）与输出尾部；结束时刷新 Agent 列表并提示。新建向导「需要安装」那一行加「安装」按钮，保留复制命令。读不到任务（成员）时不画按钮。

实测（macOS arm64，2026-10-06，基于 main 88dd2748）：

- `pnpm check` 通过；`pnpm libs:build && pnpm --filter @armadra/desktop test`：vitest 434 文件 5204 过 / 67 跳过，live 4 过，脚本 73 过 / 0 失败；`pnpm --filter @armadra/web test` 407 文件 3789 过。
- 隔离 core（临时 `HOME` 与 `ARMADRA_DATA_DIR`、`ARMADRA_LOOPBACK_OWNER=1`）加假 `codex` 与假 `npm`（先成功、再改成 404 失败），无头 Chrome 截图：未安装、运行中、已安装、失败、失败输出，各 390 / 1440 宽、暗色。脱敏在输出里生效。

没做 / 偏离：

- scope 用 `settings:write`（高于 `agent:launch`、不在任何共享角色里）。
- ACP 入口就是 CLI 本身的那几家（opencode、copilot、ama、omp）不代装，只给复制命令。
- 任务不跨重启；关 core 时不结束正在跑的 npm（中途打断的全局包更糟）。
- npm 的联网是用户程序的网络访问，未登记 `core/net/outbound.ts`。（已由「核心流与浮层安全区」一节登记为 `npmRegistry`。）

接口：

- 契约 §39.7（节号只追加）；错误码 `adapter_not_installable`(400)、`adapter_already_installed`(409)、`npm_not_found`(409)；任务失败码 `adapter_install_failed | adapter_install_timeout | adapter_install_missing`。

## 远程服务的分享链接：可复用、就地可见、可管理

做了什么：

- **契约 §33.9（协议 minor 16）**：`sources.shareLinks` / `shareLinkCreate` / `shareLinkUrl` / `shareLinkRevoke`，旧路径 `/api/sources/remotes/{serviceId}/links[/{linkId}[/url]]`。
- **core**（`sources/share-links.ts`）：建链接改由 core 代办——以当前主体签一张多次可用的邀请（`maxUses` 1–1000），用远程服务会话 `links.create`（同样的 `maxUses` 与到期），整条链接 `<url>#<秘密>.<邀请令牌>` 存进 SecretStore `armadra-share-links-<serviceId>`，之后 `shareLinkUrl` 随时再取。列表按 撤销 > 过期 > 用尽 > 生效 判状态，失效或远程服务上已没有的顺手删存档；远程服务那边撤销的作废本机邀请；没登记时答空表并清存档。撤销：中继撤链接与访客、作废邀请、删存档。删远程服务时连存档一起删。`RemoteClient` 加 `createLink / listLinks / revokeLink`。
- **页面**：`ShareDialog` 换成 `RemoteShare.tsx`，挂在远程服务行下（`Collapsible`，缺省展开）：分享本机开关 + 隧道状态（停用要确认）；链接列表（名称或备注、权限、工作空间、创建时间、有效期、已用 / 上限）；复制、二维码（随时重开）、系统分享（有 Web Share 才出现）、撤销（`ResponsiveAlertDialog` 确认）；失效链接折进「历史」；刷新。新建对话框：备注、工作空间、权限、有效期、可用次数（1 / 10 / 100 / 1000，缺省 1000）。文案 `i18n/remote.ts` 中英同步。
- **探针** `tools/probes/link-join.mjs` 跟上新界面：再复制、重开二维码、两个访客先后加入、撤销后第三个访客被拒、390 / 1440 明暗截图。

实测（macOS arm64，2026-10-06，合入 main 后）：

- `pnpm check` 通过；`pnpm --filter @armadra/web test` 3796 过、`typecheck` 过；`pnpm libs:build && pnpm --filter @armadra/desktop test` 5212 过 / 67 跳，脚本 73 过；`@armadra/server` 98 过。`@armadra/shared` 的「§31 错误码与协议包注册表」一条在 main 上就失败（`address_invalid` 不在协议包注册表），与本包无关。
- 新用例：core `share-links.test.ts` 8 条（建、列、再取、状态与清存档、撤销幂等、未登记、失败作废邀请、30 天上限、删远程服务清存档；日志不含秘密）；页面 `RemoteServicesPage.test.tsx` 改写分享流程与停用确认、`remote-services.test.ts` 改为经 core。
- 端到端：`node tools/probes/link-join.mjs`（Docker 里的个人中转，随机端口与临时目录；真 Electron，临时 HOME 与数据目录）全部通过：开关分享 → 新建 → 列表再复制得同一条整链接 → 重开二维码 → 访客 1、访客 2 先后加入并看到画布 → 列表显示「已用 2/1000」→ 撤销（确认）→ 折进历史 → 访客 3 被拒「链接已停用或不存在」；中继、桌面与探针日志里没有口令、令牌与链接秘密。截图在本地 `target/link-join/`。

没做 / 偏离：

- 改备注：中继没有更新链接的接口，未做。
- 系统分享：桌面壳没有原生分享桥，只在页面有 `navigator.share` 时出现（Electron 桌面上通常不出现）。
- 本包之前建的链接本机没有存档，列表里只能撤销、不能再复制。

## 远程服务设置页与分享收尾（P4）

做了什么：

- **隧道状态不再轮询**：设置页去掉 `refetchInterval: 5_000`，改订阅本机的 `cloud.tunnel` 事件（`useTunnelEvents`，别的源推来的同名事件不管），事件到了或本机事件流重新连上就重读 `identity.cloud.status`。`cloud.tunnel` 登记进 `WORKSPACE_EVENT_TYPES`（33 种）。
- **已挂载的源拖动排序**：侧栏 `SourceGroups` 的组头是拖动把手（指针与键盘，`@dnd-kit`），只在桌面壳与服务器壳的页面（源表在本机 core）出现。松手后按位置 1、2、3… 逐行写回 `sources.update.orderIndex`；侧栏先按新顺序画，不为此重连各源，失败退回原顺序并提示。当前源不在分组里，保持它在源表里的位置。
- **刚建的链接不再随重挂载消失**：正在看的那条链接（含刚建时的整条链接）放进组件外的内存 store（`useShowingStore`，按远程服务记，不落盘），窄屏 / 宽屏切换导致设置框整个重挂载后二维码框照样在；关掉即清。
- **放弃中继侧清理**（契约 §31.5，协议 minor 17）：`identity.cloud.relayDismiss { issuer }`（旧路径 `POST /api/identity/cloud/relay-dismiss`）只清本机记着的待清理，不再去删中继侧；审计 `cloud.relayDismiss`。页面上「远程服务已删、中继侧还欠着」那一行的菜单里加「放弃清理」，要确认。
- **分享链接改备注**（契约 §33.10）：`sources.shareLinkUpdate { serviceId, linkId, label }`（旧路径 `PUT /api/sources/remotes/{serviceId}/links/{linkId}`）经远程服务 `links.update` 只改备注，答 `{ link }`；远程服务记着的能力里没有 `links.update` 先重问 `platform.info`，仍没有答 `not_implemented`。页面每条生效链接加「编辑备注」。armadra-cloud 协议包升 0.2.0（`links.update`、能力 `links.update`），个人中转实现它；本仓 vendored tgz、sha256、镜像 tag 与锁文件同步到 0.2.0。
- **桌面壳原生分享桥**：新 IPC `app:share`（`main/share.ts`，请求经 `shell-core/share-request.ts` 收窄成 http/https、不带账号口令、≤4096），macOS 弹系统分享菜单（`ShareMenu`），其余平台与坏请求答 `{ shared: false }`；preload 暴露 `window.armadra.share { available, url }`。页面有壳的分享菜单就交给它、壳不接退回复制；没有壳时用 Web Share；都没有就只留复制。

实测（macOS arm64，2026-10-07，基于 main cdb7dea5）：

- armadra-cloud（feat/share-link-note）：`pnpm check` 通过；`pnpm -r test` 全过（协议包 146、cloud 65、relay 212）。新用例：relay `sources.test.ts`「改链接备注」1 条（去空白、其余字段不动、撤销后可改、访客 forbidden、不存在 not_found），`personal-e2e` 加 PATCH 一步（真 HTTPS 起中继：owner 改、落地信息跟着变、访客 forbidden、不存在 404、超长 400）；SaaS 预留路由多一条（51 → 52）。
- Armadra：`pnpm libs:build && pnpm -r --if-present test`——desktop vitest 5213 过 / 74 跳，`parity-push` 一条在满载时超时、单跑通过；live 4 过、脚本 73 过；web 3807 过；server 98 过；shared 372 过。新用例：core `share-links.test.ts` 3 条（改备注、不存在、能力缺失重问后 501 与升级后可改）、`cloud.test.ts` 2 条（放弃清理与 401）、`events/stream.test.ts` 改 33 种；desktop `share-request.test.ts` 3、`main/share.test.ts` 2、`ipc.test.ts` 加 `app:share`；web `SourceGroups.test.tsx` 3（含键盘拖动写回）、`RemoteServicesPage.test.tsx` 5（事件驱动重读、重挂载保留链接、改备注、壳分享与退回复制、放弃清理）、`remote-services.test.ts` 3。

接口：

- core：`ShareLinks.updateLabel`、`SourcesService.remoteCapabilities(serviceId, { refresh })`、`RemoteClient.updateLink`、`CloudRegistry.relayDismiss`；IPC `app:share`。
- 页面：`dismissRelayCleanup(issuer)`、`renameShareLink(serviceId, linkId, label)`、`reorderSources(sourceIds)`、`shellCanShare()` / `shareViaShell(title, url)`；`RemoteShare.tsx` 导出 `useTunnelEvents`、`useShowingStore`、`shareNatively`；`SourceGroups.tsx` 导出 `applyOrder`。

没做 / 偏离：

- 合并顺序：先合 armadra-cloud 的协议包 0.2.0，再合本仓（vendored tgz 是那个分支打的包）。ghcr 镜像 tag 已随版本钉到 0.2.0，但镜像本身还没发布。
- 协议 minor 取 17；与别的包同时合入时后合的一方改号。
- 拖动排序只在侧栏；写回之后页面源表里的编号要到下次读源表（启动、设置页）才更新，届时编号变了的源会按原有逻辑重连一次（`sources/` 连接层不在本包范围）。
- 系统分享菜单只有 macOS（Electron `ShareMenu`）；Windows / Linux 退回复制。没有在打包产物上实机点过分享菜单。
- 设置页现在靠事件更新隧道状态；没有任何画布打开（没有工作空间事件流）时不会自己刷新，重开设置或刷新时重读。

## 核心流与浮层安全区：流式下载、画面背压、npm 出站登记、iPad 浮层

做了什么：

- **下载流式**（`apps/web/src/api/assets.ts::downloadRuntimeFile`）：有 File System Access（Chromium、桌面壳）时先弹保存对话框（趁点击的用户激活），再经源的 `fetch` 取，响应体 `pipeTo` 进选中的文件；取消答 `true`，取不回答 `false` 并删掉对话框建出的空文件；对话框打不开（没有激活、被策略拦）退到下面两条。同源且不是 Bearer 的源（服务器壳，Cookie）只取一次看状态、拿到响应头即中止，再交给浏览器自己的下载（core 答 `content-disposition: attachment`）。只有 Bearer 源且没有保存对话框（iPad 原生 App 等）才取回成 Blob。
- **画面背压**：`SendQueue.push(frame, key?, settled?)` 多一个回调，单元全部写完（`ws` 写完回调）答 `sent`，被合并、挤掉、没被接受或队列关闭答 `dropped`，恰好一次。`HeadlessNode` 把 `Page.screencastFrameAck` 交给 `ViewerSocket.sendFrame(header, jpeg, sent)`，跟不上的客户端让 Chromium 停下等，而不是照常编码再丢；没有 `sendFrame` 的观看者与没人看时照旧立即确认。
- **npm 出站登记**：`OUTBOUND.npmRegistry`（`https://registry.npmjs.org`，用户 `.npmrc` 可换镜像），`switch: null`、只在点安装时连；`SPAWNED_OUTBOUND` 标出由 core 起的子进程（`npm` ← `agent/adapter-install.ts`）；`adapter-install.ts` 导出 `ADAPTER_INSTALL_OUTBOUND`。外部服务 §12.3 表加一行。
- **浮层安全区**（只改 `apps/web/src/ui/` 与 `tokens.css`）：新增 `--overlay-inset-top = max(--safe-top, --window-controls-top)`；`ui/safe-area.ts` 用探针元素把变量量成像素（窗口尺寸、横竖屏、根元素样式变动时重算），作为 Popover / DropdownMenu(+Sub) / Select / Tooltip / HoverCard / ContextMenu(+Sub) 的 `collisionPadding`（有安全区的边 + 4px，没有的边 0，桌面不变；调用方给了就用调用方的）。Select 有安全区时改用 popper（对齐选中项的定位不认碰撞边距）。Popover 加 `max-h-(--radix-popover-content-available-height) overflow-y-auto`。Dialog / AlertDialog 中心挪到可用区域中心、最大宽高减去安全区（`SAFE_CENTERED`，变量为 0 时与原来一致）；Sheet 按贴着的边加安全区内边距，关闭钮跟着挪，调用方给了 `p-0` / `pt-…` 就用调用方的。设计系统 §3.1 补一句。

实测（macOS arm64，2026-10-07，基于 main cdb7dea5）：

- core：`stream-queue.test` 新增 settled 3 例；`stream-queue.integration.test` 新增真 socket 慢客户端：编码器等确认，客户端停读后不再编码、恢复后继续；`headless/node.test` 新增「确认等观看者说帧已发出」；`outbound.test` 新增 2 例（npm 登记、起 `npm install` 的文件都在子进程登记里）；`adapter-install.test` 1 例。
- web：`assets.test` 新增 6 例（逐块写入不取 Blob、取消、失败删文件、无激活退回、同源 Cookie 中止后交给浏览器、同源 Bearer 仍经 Blob）；`ui/safe-area.test` 11 例（量法、窗口控件、碰撞边距、根样式变动重算、Select 切 popper、Dialog / AlertDialog / Sheet 类名与调用方覆盖）。`ResponsiveDialog.test` 两条断言从 `top-1/2` 改成 `top-[calc(50%+`：居中类名换了，语义（桌面居中、手机贴底）没变。
- 新探针 `tools/probes/overlay-safe-area.mjs`（登记 `tools/ci/e2e.d/overlay-safe-area.json`，tier a）：无头 Chrome + Vite，iPad 窗口化 1180×820（上 24、下 20、窗口控件 40）与手机横屏 844×390（左右 47、下 21）两组，四种弹出层 × 四个角都落在安全区内，`collisionPadding={0}` 对照各量出 10 / 11 处越界；高 2000px 的对话框被限在安全区内；右侧抽屉内边距等于安全区、关闭钮让开；控制台无 error。
- 完整验证见 PR 正文。

没做 / 限制：

- iPad 原生 App 等没有保存对话框的 Bearer 源仍经 Blob（`<a href>` 带不了 Bearer，没有引入 Service Worker 流式下载）。Electron 的 `showSaveFilePicker` 未在打包产物里实测，只有单元测试与 Chromium 行为。
- 保存对话框出现后到取回之间如果取不回，删空文件靠 Chromium 的非标准 `FileSystemFileHandle.remove()`，没有它的浏览器会留下一个空文件。
- 窗口控件只占左上角，`collisionPadding` 只能给整条顶边，所以顶边按窗口控件高度整条让开。
- 真机上 `env()` 的取值与窗口控件尺寸只能在 iPad 上验证，这里只用 Chromium 模拟变量。

接口：

- web：`downloadRuntimeFile(url, filename, load?, { picker?, sources?, origin? })`、`saveFilePicker()`、`SaveFileHandle`、`SaveFilePicker`；`ui/safe-area.ts`：`measureSafeInsets`、`useSafeInsets`、`useOverlayCollisionPadding`、`hasSafeInsets`、`OVERLAY_SAFE_GAP`、`SAFE_CENTERED`；CSS `--overlay-inset-top`。
- core：`SendQueue.push(frame, key?, settled?)`、`SettleOutcome`；`ViewerSocket.sendFrame(header, jpeg, sent?)`；`OUTBOUND.npmRegistry`、`SPAWNED_OUTBOUND`；`ADAPTER_INSTALL_OUTBOUND`。

## P1 Forge / Git 小残项：Gitea 合并方式与检查通过后合并、fork 检出认远端、徽标直达、Git 只读 scope、status 的 paths

做了什么：

- Gitea 合并方式（G5-29 残项）：`merge-options` 读仓库的 `allow_merge_commits` / `allow_squash_merge` / `allow_rebase` 给出可用方式，字段缺省按允许；`rebase-merge`、`fast-forward-only` 不在三种之内。
- Gitea 检查通过后合并（G5-29 残项）：`auto-merge` 先核 head、方式必须是仓库允许的，`POST …/merge` 带 `merge_when_checks_succeed: true`；远端 201 是排上了，200 是检查已过、当场合并（合并提交从 PR 读回）。撤销发 `DELETE …/merge`，远端 404 或 PR 不是开着的答 `409`。PR 本身没有「已排上」字段，单条详情从 `issues/{n}/timeline` 取最后一条排程 / 撤销事件（至多 10 页，读不到按 `false`，不让详情失败）；列表不读时间线。页面在 Gitea 上把按钮、确认与提示叫「检查通过后合并」，GitLab 仍是「流水线通过后合并」。
- fork 检出认基仓库（G5-30 残项）：检出表单读本地远端的地址（`gitRepository.remotes`），主机与路径（去 `.git`、大小写不敏感，http(s) 允许站点前缀，整条对上优先）对上 PR 所在仓库的那个远端作缺省；认不出才退回 `origin` / 第一个，仍可手选。
- 连接徽标直达（G5-15 / G5-30 残项）：Gitea / GitLab 的连接徽标点开时带上记着的仓库（含多级子组），抽屉按仓库走 `forge.detect`，不靠手填的地址，认出后直接打开那条 PR / MR 或 issue 的详情。GitHub 的徽标不变。
- Git 只读 scope：`gitRepository.log` 与 `gitRepository.worktreeBinding` 的 `meta.scope` 改为 `git:read`；路由表为这两条 `POST` 旧路径单列 `git:read`（其余 Git 写仍是 `git:write`，`statusBatch` 维持 `git:write`）。契约 §40.2 说明与生成表同步。
- `git.status` 的 `paths`：契约收、页面也传，但 core 原先只把 `path` 交下去，等于没过滤（契约里还写着「收下但不过滤」）。现在旧路径的逗号拼法与 procedure 的数组都交给 `readStatusFiltered`，计数与逐文件行按 pathspec 收窄，越出检出的路径答 `400`；远端 Worker 的 `git.status` 同步。§40.1 说明改了。

实测（macOS arm64，2026-10-07）：

- core：`forge/gitea.test` 新增 4 条（合并方式细分、排上 / 时间线 / 撤销、当场合并与不发写的拒绝、时间线读不到与跨页）；`forge/forge.test` 的 Gitea 路由用例按新设计改了断言：`merge-options` 现在读一次仓库、`autoMerge: true`，已合并 PR 的 `auto-merge` 答 `409` 而不是 `400`（旧断言写的是「Gitea 没有这个能力」，本包正是去补它）。`git/routes.test` 1 条、`contract/parity-git.test` 补 `paths` 的三方一致、`http/route-scopes.test` 补只读两条与同族写。
- web：`model.test` 3 条（按地址认远端、子组与站点前缀、认不出）、`ForgeHosted.test` 3 条（Gitea 叫法、徽标焦点直达详情、fork 检出取地址对上的远端，去掉修复时这条失败）、`GithubDrawer.test` 1 条（子组徽标 → `forge.detect` → 直达 MR，不调 `resolve`）。
- `pnpm libs:build && pnpm -r --if-present test`：shared 372、server 98 / 4 跳过、mobile 10、push-relay 9 全过；desktop 5208 过 / 74 跳过，live 4 过，脚本 73 过；web 首轮只有 i18n 用量检查认不出拼接的键，改成字面量后通过。desktop 的 `contract/parity-push.test` 一条本机在负载 290 上下时连跑 3 次都 `ECONNRESET`，本包没碰 push 域，看 CI。`pnpm --filter @armadra/web typecheck` 与 `pnpm check` 通过。

没做 / 限制：

- Gitea 的排程状态靠时间线推断：被远端自己撤掉（例如关掉 PR）而没写撤销事件时，开着的 PR 可能仍显示「已设自动合并」，撤销会答 `409`。
- Gitea 普通合并不预先核对仓库允许的方式（多一次请求），不收的方式仍由远端答 405 / 422。
- 都没有连真实的 Gitea / GitLab 实例。

## P3 多源页面收尾（A1-2 / A1-5 / A3-4 留下的几项）

做了什么（`apps/web/src/`）：

- **按源发的读数不再经 `runtimeApi`**：新 `sources/source-api.ts` 的 `sourceApi(source)`（agents、boards、terminals 三个域，经 `clientFor(source)`，同一个源同一份）。`agent/dependency-store` 的读数、取消、旧依赖迁入，`realtime/session` 的「这块板走不走实时」复核，会话列表（`agent/sessions.ts` 的 `sessionsQuery`，侧栏与镜像补齐共用）都发往读数所属的源；会话查询的键与请求绑在渲染时的同一个源上，不随之后的当前源漂走。
- **切源时数据不串**：`dropUnscopedQueries` 原来只 `removeQueries`，有人在看的查询留着上一个源的答案直到下次重渲染；现在有人在看的 `resetQueries`（向新源重取，上一个源在路上的答案作废），没人看的照旧丢。`["src", …]` 各归各的源。
- **一个标签页同时挂多个源**：`sources/mounts.ts` 的 `mountSiblingSources({ primary, siblings, provider, cloudAuth? })`——选中的那台照旧装成本机源（带它的名字），其余连接作为远程源挂进页面源表（`registry.ts` 新 `installPageSourceRegistry(options)`，带自己的凭据来源），侧栏按源分组、点一行即切当前源。只有一台时什么也不做，与单源逐字相同。
  - 手机（`mobile/entry.ts`）：进入选中的连接后挂上连接表里其余的连接；`createMobileCredentialProvider` 多交出 `cloudAuth`，经中继的源各签发方一条 `me.stream`。
  - 中继托管页面（`sources/hosted.ts`）：登录时目录里的其余主机在进入后挂上（访客只挂链接那一台）；托管页自己那条 `me.stream` 把其余主机的上线、撤销与重开补叫落到各自的连接上。
  - `createLocalConnection({ label })`；侧栏 `SourceGroups` 本机组有名字时用名字（只改这一行，桌面与服务器壳名字为空、不变）。
- **中继自己停了**：`HostedStatus.relayDown`——托管页的 `me.stream` 开过之后 `RELAY_DOWN_AFTER_MS`（4 秒）回不到 `open` 即算中继停了（主机下线时这条流照常开着，由此分开），流重开即落回。通知条（`shell/Banners.tsx`）专门一条「中转服务不可用，正在重连」，盖过主机等待与「本地服务已断开」，不给刷新钮（凭据只在内存）。文案 `remote.hosted.relayDown`，中英同步。

实测（macOS arm64，2026-10-07，基于 main cdb7dea5）：

- 新用例：`sources/source-api.test`（依赖读数在别的源的事件里发往那个源、两源同名工作空间不串、会话键与请求绑源、实时复核按源）、`sources/switch-isolation.test`（换源后看着的查询向新源重取、上一个源晚到的答案不落缓存、带源前缀的留着；前两条在旧实现上失败）、`sources/mounts.test`、`mobile/entry.test` 补 2（多连接同时挂、单连接不动）、`sources/hosted.test` 补 6（多主机挂载与事件分发、单台不换源表、中继停了的判定与恢复、短断与自关不算、主机下线不算）、`shell/Banners.relay.test` 2。
- 端到端：`ARMADRA_PERSONAL_RELAY_HOME=<armadra-cloud> node tools/probes/relay-web-e2e.mjs`（armadra-cloud main 342dd23，临时目录与 HOME，用完即停）全过；探针改为断言中继 SIGTERM 后出现「中转服务不可用，正在重连」且没有「等待上线 / 本地服务已断开」，中继回来后通知条收起、终端与实时板恢复（隧道 17.5 秒、页面 25 秒）。

接口：

- `sourceApi(source?)`、`sessionsQuery(workspaceId)`；`mountSiblingSources(...)` / `SiblingMount`、`installPageSourceRegistry(options)`；`createLocalConnection({ label })`；`MobileCredentialProvider.cloudAuth`；`HostedStatus.relayDown`、`RELAY_DOWN_AFTER_MS`、`HostedRelayOptions.mount / setTimeout / clearTimeout`。

没做 / 偏离：

- 只动了 `sidebar/SourceGroups.tsx` 一行（本机组的名字）与 `shell/Banners.tsx`（中继停了那一条），其余在约定的目录内。
- 多主机同时挂载没有对真中继跑端到端（探针只登记一台 core）；由单测覆盖挂载、事件分发与单台兼容。手机多连接同样只在单测里验过。
- 中继停了的提示只在托管页面上；手机经中继的连接没有这一条（仍是运行时断开与源状态）。
- `runtimeApi` 其余域（handoff、git 等 REST 与 `currentClient` 的）仍发往当前源，键带源前缀的在切源前后由键区分。

## P2 契约补迁与错误码注册表（契约 §36.5、§37.3、§39.8，协议 minor 18）

补 E3 各包留下的尾巴：评论、交接、输出到画板迁到契约，`cancelled` / `reveal_failed` 与 §18 的具名码进注册表，事件流里 `agent.approval` 的 `request` 收紧。

做了什么：

- **评论**（§36.5）：`boards.comments` / `createComment` / `updateComment` / `deleteComment` / `resolveComment`，旧路径 `…/boards/{boardId}/comments[/{commentId}[/resolve]]`。`core/realtime/comments-routes.ts` 收成 `commentOperations`，旧 handler 与 procedure 同调；旧路径仍在判过板与权限之后才读体，拒绝的先后不变。`installCommentRoutes` 改收 `CoreServer`。页面 `realtime/comments/store.ts` 的 `commentsApi` 经 `currentClient().boards.*`，签名不变。
- **连线**：`agents.putContextLinks`（§39.4）在 E3-4 已迁，页面早已走 procedure；本包只更正 §36 的「留在 REST」一句。
- **对话交接**（§39.8）：`agents.handoffs` / `handoff` / `prepareHandoff` / `acceptHandoff` / `cancelHandoff`。`core/agent/routes.ts` 加 `handoffOperations`；页面 `api/handoff.ts` 改 `handoffApiFor(rpc)`，经 `runtimeApi` 的签名不变。
- **输出到画板**（§37.3）：`files.exportText`，旧路径 `POST …/exports/{exportId}/text`，scope 同路由表 `assets:read`；`core/assets/routes.ts` 登记进 `files` 子树。`drive`（输入框租约）其实已是 §38 的 `terminals.drive`；`acp/api.ts` 改为直接 `currentClient().terminals.drive`，两条都发往当前源。
- **注册表**：加 `cancelled`（499）、`reveal_failed`（500），`files.search` / `files.reveal` 的 `errors` 声明它们；§18 的 `password_*`（5 个）、`password_reset_invalid`（404）、`passkey_*`（4）、`mfa_*`（4）、`oauth_*`（10）按 §18 的状态登记，`i18n` 指向已有的 `security.error.*` / `auth.error.*`。`security.passkeys.register*`、`security.mfa.*`、`accounts.credentials.setPassword` 声明对应的码。`api/error-codes.test.ts` 加两种扫描：身份域里的具名字面量（码常由变量或三元式给出）与 `IdentityRefusal` / `OAuthError` 的字面量状态；`DomainError` 与身份域拒绝用了登记过的码时状态必须一致。
- **`agent.approval.request`**（`packages/shared/src/api/events.ts`）：从 `unknown` 收紧成 `agentApprovalRecordSchema`——审批行（`id`、`nodeId`、`workspaceId`、`createdAt`，答复字段 `nullish`，hook 面的行没有 `revision`），答复事件的 `resolved` / `decision` / `route` / `elicitation`，CLI 的原话 `request` 按 JSON 透传，其余键 JSON 透传。`workspaces.events` 的 `unknown` 放行从 3 降到 2（剩 ACP 工具调用的 `rawInput` / `rawOutput`，是适配器的原样载荷）。
- **`GatewaySection`**：新增组件用例，会话变化时还在路上的设备请求被中止、重取的答案上屏；把「先取消」那一步去掉用例就红。
- 协议 minor 17 → 18（17 给了 P4 #181），新 procedure 的 `since` 为 1.18。
- **探针**：`ui-features/keybindings.mjs` 在设置对话框停稳（`dialogSettled`）之后再点侧栏最底下的「快捷键」——CI 上两次在对话框放大动画里按坐标点空。

实测（macOS arm64，基于 main c04224cf）：

- 新增 core 对偶测试 `contract/parity-comments.test.ts`（5）、`parity-handoffs.test.ts`（4）、`parity-export-text.test.ts`（3）：路由表原 handler、旧路径、procedure 三者逐字节相等（含 201 / 204 的状态差、400 / 403 / 404 / 409），scope 与路由表一致；形状错由契约先答 `bad_request`。`parity-agents` / `parity-files` 的条数随之更新。
- 页面新增 `api/client.comments.test.ts`、`client.handoffs.test.ts`，`client.acp.test.ts` 加 `exportText` / `drive`，`GatewaySection.test.tsx`（2）。`@armadra/shared` 的事件用例覆盖新请求、答复与两种不收的形状。
- `pnpm check` 通过（含 `contract:check`、lint 0 error、各处 typecheck、`repo:check`）。`pnpm libs:build && pnpm -r --if-present test`：desktop 5246 过 / 67 跳（live 4 过），web 3864 过，shared 372 过，server 98 过 / 4 跳，mobile 10、push-relay 9 过。

没做 / 偏离：

- `handoff_host_offline`（501）没登记：它由常量给出、只在交接域答，注册表的「还在被用」扫描认字面量；页面按码取文案不受影响。
- 入参形状错（`resolved` 不是布尔、交接的代数不是数字等）经旧路径与 procedure 由契约先答 `bad_request`（带 `details.issues`），原话与迁移前不同，码与状态不变（与 E3 各包同）。
- 白板 PNG 导出与资源上传仍留在 REST（字节流与大体积 data URL）。

接口：

- 契约 §36.5、§37.3、§39.8（节号只追加）；`boardCommentWireSchema`、`commentListWireSchema` 从 `@armadra/shared` 导出；`agentApprovalRecordSchema` / `AgentApprovalRecord`。
- core：`commentOperations(options)`、`installCommentRoutes(server, options)`、`handoffOperations(collab)`。
- 页面：`handoffApiFor(rpc)`；`commentsApi` 与 `acpApi.exportText` / `drive` 签名不变。

## R2 ACP 回合对账（契约 §39.9，协议 minor 19）

经中继发 ACP 提示时，POST 偶发在页面侧失败（连接被复用后关闭），而 core 其实已经收下、回合照常跑完；会话视图却当场判「这一轮没有完成」，重试还可能重复投递。会话视图也只在挂载时读一次日志，控制面重连后漏掉的 `acp.turn` 补不回来。

做了什么：

- **core 去重**（`core/acp/routes.ts`）：`acp.prompt` 收可选的 `clientTurnId`（1–128 字符）；同一会话行同一 id 只投递一次，同时到的与之后再到的答同一个 `{ turnId }`，投递失败的不记。同一会话行的提示经一把锁串行（记 id → `writeSubmit` → 读回合 id），顺带消掉了 `lastTurn` 在并发提示下的竞态。只记最近 512 个 id，core 重启从空开始。
- **回合记录**（`core/acp/session.ts`、`bridge.ts`）：会话记最近 32 个回合 `{ turnId, clientTurnId?, state: queued | running | ended, stopReason?, error? }`，`acp.log` 出参多 `turns`（只在有活进程时）；`acp.turn` 带回 `clientTurnId`。页面回合 id 经桥的 `expectClientTurn` 交给下一条 prompt，不改终端管理器。
- **页面对账**（`apps/web/src/acp/`）：每轮生成 `clientTurnId`（非安全上下文退回 `getRandomValues`）。请求 4xx 带 `code` 照旧当场失败；其余（网络错误、无响应、5xx、答复解析失败）进「确认中」，立刻、1 秒、3 秒各重读一次镜像，按 `turns` 认自己的那一轮：已结束画真实结局，排队 / 在跑继续流式，活会话的 `turns` 里没有才显示「这一轮没有送达」，重试沿用同一 id（提问不重复画）；几次都读不到也判没送达。对账期间别的回合的 `acp.turn` 不覆盖它。控制面断开再连上后会话视图重读一次镜像（同一套先缓存、读回后丢分块的次序），并按 `turns` 收掉断线期间漏掉的回合结束。
- 文案：`acp.turn.confirming`「正在确认这一轮」、`acp.error.undelivered`「这一轮没有送达」，中英同步；只用现有的 `Alert`、`Spinner`、`Button`。
- 协议 minor 18 → 19。

实测（macOS arm64，基于 main 9f33e3df）：

- core：`acp/routes.test.ts` 新增一例（真管理器 + 假 ACP Agent 子进程）：同一 id 并发两次加之后再一次只投递一轮、同一 `turnId`，`acp.turn` 与 `log.turns` 带 `clientTurnId`，换 id 是新一轮，超长 id 答 400。
- 页面：`store.test.ts` 加 5 例（已结束 / 拒答 / 排队 / 在跑 / 没收到 / `turns` 缺席 / 重试不重画 / 别的回合结束帧不覆盖）；`SessionView.test.tsx` 加 7 例（网络失败 → 对账成功、仍在跑、确认没收到 → 同 id 重试、日志一直读不到 → 判没送达且重试同 id、4xx 当场失败、重连后重读并收掉漏掉的回合、首次「已连上」不重读）。两条旧断言因 `prompt` 多了第三个参数改为 `expect.any(String)`，拒答后的重试断言换了新 id（沿用旧 id 会被 core 当成同一轮）。
- 探针 `personal-roundtrip`（真个人中转 + 真 core + 无头 Chrome）第 3 步加一段：中继托管的页面里给假 ACP Agent 发一轮，回复流回，core 侧 `log` 里这句只有一条、`turns` 一项带页面的 `clientTurnId`、`end_turn`，会话视图没有误报。本机全程通过。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 5240 过 / 74 跳，web 3876 过，shared 372 过，server 98 过 / 4 跳，mobile 10、push-relay 9 过。`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。

没做 / 偏离：

- 没有在探针里制造真实的「POST 半路断开」：中继的连接复用问题由 R1 处理，这里只验证经中继的一轮带 id、不重复；断开后的对账由页面单测覆盖。
- 会话不在跑（适配器已退、`turns` 缺席）或旧 core（没有 `turns`、不去重）时无从确认，显示「没有送达」；旧 core 上重试仍可能重复，与之前一样。
- 去重表在内存里，core 重启后同一 id 会再投一次（重启本身已结束了旧回合）。
- 重读镜像与活事件之间的分块次序沿用挂载时的做法（读回之前到的分块按「已在镜像里」丢掉）。

接口：

- 契约 §39.9（新增）；§14.2 提示行的请求、§14.3 `acp.turn` 指向它。
- `@armadra/shared`：`acpPromptRequestSchema` 多 `clientTurnId?`，`acpTurnRecordSchema` / `AcpTurnRecord`、`AcpPromptRequest`，`acpLogResponseSchema.turns?`，`acpTurnEventSchema.clientTurnId?`；契约 `acp.prompt` 入参与 `acp.log` 出参同步。
- core：`AcpSession.prompt(text, clientTurnId?)`、`recentTurns()`；`AcpBackend.expectClientTurn(key, id)`；`bus` 的 `acp.turn.clientTurnId?`。
- 页面：`acpApi.prompt(sessionId, text, clientTurnId?)`；store 的 `begin(sessionId, text, clientTurnId?)`、`confirm`、`reconcile`，纯函数 `reconcileTurn`；视图字段 `clientTurnId`、`confirming`、`undelivered`。

## R1 中继与 core 的 HTTP 层：keep-alive 与边缘额度

iPad（WebKit）经个人中转给 ACP Agent 发 prompt 偶发「这一轮没有完成」：服务端监听没设 `keepAliveTimeout`，Node 缺省 5 秒就关空闲连接；WebKit 复用一条刚被关掉的连接发 POST 时不重试，直接加载失败（Chromium 会重试，所以桌面与浏览器探针看不出来）。

做了什么：

- **core**：`core/http/timeouts.ts` 的 `HTTP_TIMEOUTS`（空闲 keep-alive 75 秒、请求头 76 秒、整条请求 300 秒）与 `applyHttpTimeouts(server)`；`CoreServer.createListener` 建的每台监听（回环、服务器壳、Gateway 交接点、中继隧道交接点）和 Gateway 的 HTTPS 监听都套上。服务器壳没有自己的监听，走同一个 `createListener`。隧道流是 `TunnelDuplex`，`setTimeout` 不落到 TCP，空闲上限实际由中继那一侧决定。
- **armadra-cloud**（Owlbay/armadra-cloud，分支 `fix/relay-keepalive-limits`）：`cloud-shared` 的 `listen()` 同样套 75 / 76 / 300 秒（中继与 cloud 共用，HTTP 与 HTTPS）；边缘缺省额度放宽——预检每 IP 1200/分（原 300）、有效令牌 1200/分（原 600）、账号 3600/分（原 1800）、账号并发 WebSocket 256（原 64，与隧道单源流数上限对齐）；中继预检与控制面的 `Access-Control-Max-Age` 600 → 7200（WebKit 自己封顶 600，Chromium 2 小时）。cloud 契约 §7、部署说明、CLI 帮助、CHANGELOG Unreleased 同步。
- **探针**：`personal-roundtrip` 第 2 步加一项——照 iOS App 的路子（`Origin: capacitor://localhost`）在同一条 keep-alive 连接上经中继 `POST /api/identity/cloud/login` 换会话，空闲 6.5 秒后再 `POST system.hello`；连接不许被服务端先关、不许换连接、两次都 200。共用件 `platform-lib.mjs` 的 `idleKeepAlivePost`。

实测（macOS arm64，基于 main 9f33e3df；中继用 cloud 分支 `fix/relay-keepalive-limits`）：

- 新增 `core/http/timeouts.test.ts`（2）：监听取值；同一条连接空闲 6 秒后 POST 仍 200、没换连接。把 `applyHttpTimeouts` 注掉两条都红。
- cloud：`cloud-shared/src/http/index.test.ts` 加取值与空闲 6 秒后 POST 两条（注掉修复两条都红），`tls.test.ts` 断言 HTTPS 监听取值，`serve.test.ts` 断言新缺省额度，`cors.test.ts` 断言 `max-age` 7200；`pnpm check`、`pnpm test` 全过。
- `personal-roundtrip` 全程通过（keep-alive 一项 `statuses [200,200]`、`reused true`、`closedByServer false`，日志秘密扫描 0 泄漏）；同一探针对注掉修复的中继跑，这一项红（`closedByServer true`、`reused false`）。

没做 / 偏离：

- 没在真 iPad 上复现与回归；WebKit 的不重试行为由探针以「服务端没先关连接」间接验证。CI 没有 armadra-cloud 检出，这条探针在 CI 上照旧 skipped。
- core 回环 CORS 没有 `Max-Age`（Gateway 与中继隧道准入仍为 600，已等于 WebKit 上限），没改。
- 并发 WebSocket 上限仍不可配（只有四种速率额度可配）；ACME `http-01` 挑战监听只做跳转，没套超时。

接口：

- core：`HTTP_TIMEOUTS`、`applyHttpTimeouts(server)`（`core/http/timeouts.ts`）。契约形状不变。
- cloud：`@armadra/cloud-shared/http` 导出 `HTTP_TIMEOUTS`、`applyHttpTimeouts`；`DEFAULT_LIMIT_RULES` 新缺省；`PREFLIGHT_MAX_AGE_S = "7200"`。
- 合并顺序：先合 armadra-cloud 的 PR，再合本 PR（探针的 keep-alive 一项对旧中继会红）。

## R4 手机端经中继的缺口：推送点开带主机、中继停了的通知条、访客令牌分槽

补 A1-5 / P3 留下的三处：手机连着另一台时点通知没反应；中继停了的提示只在托管页；访客链接加入覆盖同一中继下主人的登录。

做了什么：

- **推送点开带主机**（契约 §19.4、§43.4 末条）：core 的深链加签发方 `armadra://w/<工作空间>[/n/<节点>]?s=<hostId>`（`core/push/triggers.ts::deepLink`，`PushService` 新选项 `sourceId`，装配时取 `IdentityStore.hostId()`）。`s` 只在 `url` 里，载荷键集合不变（仍 `strict`），随载荷端到端加密。页面 `mobile/push-open.ts`：`parseDeepLink` 多答 `sourceId`（旧格式为 `null`），`pushRouteOf` 决定就地打开（当前连接 / 已挂上且连上的远程源，先 `setCurrent`）、切连接（连接表里有：记为当前、深链留在 `#push=` 里重载后接着开）或提示（`mobile.push.unknownSource`，中英同步）。原生 `DeepLink.swift` / `DeepLink.java` 只多认一个 `?s=`。
- **手机经中继的连接也显示「中转服务不可用」**：新 `mobile/relay-status.ts`。入口选路时记下中继来源（`setMobileRelayRoute`，直连是 `null`）；通知条在运行时断开时问一次中继自己的平台信息（匿名，5 秒一次），传输失败或代理 502–504 即算中继停了，复用 `remote.hosted.relayDown` 那一条并盖过「本地服务已断开」；中继答话（主机下线、凭据失效）仍是原来的提示。
- **访客令牌不覆盖主人**：钥匙串的远程服务登录按（签发方，主体）分槽——主人 `personal:<host>:<账号>`（远程服务没答账号时 `owner`），访客 `personal:<host>:guest.<源>`（`credentials.ts::serviceIdOf(issuer, principal)`、`guestPrincipal`、`isGuestSlot`）。连接用哪一槽记在 `armadra.sources.remoteSlots`（只有键名，`connections.ts::remoteSlotOf / setRemoteSlot`，移除连接一并忘掉）。凭据来源一槽一个 `createRelayedAccess`（云会话缓存也分开）；`me.stream` 一个签发方一条，用主人那一槽，只有访客时才用访客的。移除连接只在没有别的连接用同一槽时删那一槽。
- **迁移**：旧连接没有槽的记录，照旧读签发方原来的单槽 `personal:<host>`，钥匙串里的数据不搬不删；之后新登录的主人与访客各写自己那一槽，不再碰旧槽。原生侧键名规则（`[A-Za-z0-9._:-]{1,128}`）不变，不用改原生。

实测（macOS arm64，基于 main 9f33e3df）：

- 新用例：`core/push/triggers.test`（深链带 `s` 与编码、测试通知与没给源时不带、入队载荷带本机 hostId）、`transport-relay` / `transport-unifiedpush` 断言线上没有 hostId 明文；`mobile/push-open.test` 7（带 `s` 的解析与拒收、五种去向、切连接留 `#push=`）；`mobile/credentials.test` 5（槽名、主人与访客各用各的槽并各自写回、旧单槽照读、记的槽缺失不借别人的、`me.stream` 选主人槽）；`mobile/connections.test` 1；`mobile/connect.test` 1（主人登录后访客扫码：两槽并存，移除访客只删它那槽）并更新两条既有断言（主人与访客不再落旧单槽）；`mobile/relay-status.test` 2；`shell/Banners.relay.test` 补 3（手机经中继：中继停了盖过运行时断开、中继还答话不说中继、正常时不探测）；`mobile/entry.test` 断言选路记下中继。
- 原生：`swift test --filter DeepLinkTests` 4 过；`DeepLink.java` + `DeepLinkTest` 用 `javac` + JUnit 4 过。
- 探针：`push-e2e` 的 APNs 深链断言改成带 `?s=<hostId>`（取自 `GET /api/identity/hello`），本机全过；`link-join` 加一段手机（App 页面、假钥匙串预置主人的旧单槽）扫同一条链接以访客加入，断言主人那一槽原样还在、访客另存一槽、主人的刷新令牌在中转上仍有效——本机（Docker 中继，armadra-cloud 本地检出）全过。手机那一段的页面来源是拦截出来的 `https://localhost`，探针的 Chrome 关掉本地网络访问检查（同 `personal-roundtrip`）。`mobile-shell-e2e` 走配对、不涉及这三处，没改没跑。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 5248 过 / 67 跳（live 4 过），web 3883 过，shared 372 过，server 98 过 / 4 跳，mobile 10、push-relay 9 过；`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。

接口：

- core：`deepLink(workspaceId, nodeId?, sourceId?)`，`render(draft, locale, { workspace, agent, source? })`，`PushServiceOptions.sourceId`。
- 页面：`parseDeepLink → { workspaceId, nodeId, sourceId }`、`pushRouteOf(sourceId, context)`、`switchConnectionFor(link, sourceId)`；`serviceIdOf(issuer, principal?)`、`guestPrincipal(sourceId)`、`isGuestSlot`；`remoteSlotOf / setRemoteSlot`；`MobileCredentialDeps.slotOf / connections`；`setMobileRelayRoute / useMobileRelayDown / probeRelay`。

没做 / 偏离：

- 深链用查询串 `?s=` 而不是新增载荷键：载荷 schema 是 `strict`，加键会让旧页面的 service worker 整条丢弃；放在 `url` 里旧客户端照样显示通知，只是旧版 App 点开不跳转（只进 App）。协议 minor 不升（procedure 形状没变）。
- 经中继的远程源（一起挂着的其余连接）中继停了只在侧栏里灰着，通知条只说当前连接那一路。
- 访客与主人在同一中继下时，`me.stream` 只开主人那一条：访客加入的那台若不在主人的目录里，它的上下线事件收不到（回前台与重连时照常补齐）。
- 旧单槽里若已被旧版写成访客的令牌，无法分辨，照旧给那些旧连接用；重新添加即写入新槽。

## R3 经中继 / 远程访问时的设置页与托管页会话

做了什么（`apps/web/src/`）：

- **远程访问的判定**：`panels/settings/remote-access.ts` 的 `useRemoteAccess()` / `remoteAccessOf(facts)`，不新造概念，从已有的源描述推：中继托管页面（`hostedRelay()`）、原生 App（本机源地址在 `/s/<源>` 下即经中继，否则直连 Gateway）、经 Gateway / 服务器壳同源打开的网页（直连），以及当前源是挂载的远程源（`descriptor.kind !== "local"`，`api/*` 发往它）。答 `{ remote, via, relayIssuer, currentSourceId }`；桌面窗口与开发服务器的本机源永远在本机。
- **设置导航**：`nav.ts` 新 `localOnly` 标记与 `visibleSettingsSections(server, member, remote)` / `isSettingsSectionId(value, member, remote)` 的第三个参数，远端时不列只对眼前设备有意义的分区（现在是「浏览器」：桌面窗口里当前源切到远程源时也不列，免得把 `<webview>` 配置写到远端 core）。其余分区作用在那台 core 上，照常列，按页处理：
  - 数据：远端时不出「在访达中打开」（路径照常显示，备份、重建照常）。
  - 更新：远端时只读一行「主机版本」（`health.version`），不跑检查、不出频道与开关。
  - 远程服务：页面正走的那个中继（`sameOrigin(remote.issuer, relayIssuer)`）那一行脚注「本页经此连接」，登出、移除置灰，分享本机开着时开关置灰（不给停）；当前源那一行脚注「正在使用」，断开、移除置灰。中继托管页面不再把主机的源表 `applySourceTable` 到页面源表（会盖掉中继目录挂上的主机）。
- **托管页刷新不丢登录**（`sources/hosted.ts`）：`createSessionRelayVault(issuer, storage)` 在内存保管处上加一层 `sessionStorage`（键 `armadra.hosted.resume`）：只写两把刷新令牌（远程服务的、源 core 的）与上次进的主机，访问令牌不落盘；读回的源会话访问令牌为空、已过期，`relay-access.ts` 取用前先轮换。`HostedRelay.resume()`：用刷新令牌静默续上远程服务 → 目录 → 进上次那台（答 `{ kind: "entered" }`）；那台不在 / 进不去答 `{ kind: "signedIn", hosts, failure }`；没记下或令牌被拒答 `null` 并清空。`shell/RelaySignIn.tsx` 挂上时先续（只续一次，严格模式安全），续的时候只显示 Spinner。登出远程服务（`signOut` / `dispose`）、在设置里登出主机（`logoutIdentity` → 保管处 `clear`）、刷新令牌被拒都清掉。
  - 为什么是 `sessionStorage`：只这个标签页、只中继这个来源能读，关标签即丢，与原先「凭据只在这个标签页」的边界一致；中继给页面的 CSP 是 `script-src 'self'`、`connect-src 'self'`，读得到它的脚本本来就能拿内存里的令牌发请求，多记两把刷新令牌不扩大 XSS 能做的事，只延长到刷新之后。两把刷新令牌每用一次都旋转。
- 文案：`remote.inUse`、`remote.inUse.current`、`updates.hostVersion`，中英同步。

实测（macOS arm64，2026-10-07，基于 main 9f33e3df）：

- 新用例：`panels/settings/remote-access.test`（6）、`nav.test`（3）、`pages/DataPage.test`（2）、`pages/UpdatesPage.test` 补 1、`pages/RemoteServicesPage.test` 补 3（正走的中继不给登出 / 移除 / 停分享，当前源不给断开 / 移除，托管页不覆盖源表）、`sources/hosted.test` 补 6（只记刷新令牌、刷新后两把各轮换一次回到那台且不重登不新开主机会话、没记下不发请求、被拒即清、登出远程服务与登出主机都清、那台不在给目录与原因）、`shell/RelaySignIn.test` 补 3。
- 端到端：`ARMADRA_PERSONAL_RELAY_HOME=<armadra-cloud> node tools/probes/relay-web-e2e.mjs`（armadra-cloud main c5e5410，临时目录与 HOME，用完即停）全过，新增：登录后 `sessionStorage` 只有刷新令牌 → `Page.reload` 后不出登录表单、直接回画布、终端 `42reload`；中继重启恢复之后打开设置：远程服务页正走的中继标「本页经此连接」、分享本机开着且开关禁用，更新页只有「主机版本」、没有开关与下拉，数据页没有「在访达中打开」；控制台无错误。截图 `06-settings-remote-{1440,390}-{light,dark}`、`07-settings-updates-1440-dark`。

接口：

- `useRemoteAccess()` / `remoteAccessOf(facts)` / `pageAccessFacts()` / `sameOrigin(a, b)`、`RemoteAccess`、`AccessFacts`；`SettingsSection.localOnly`；`visibleSettingsSections(server, member, remote)`、`isSettingsSectionId(value, member, remote)`；`RemoteShareSection` 的 `inUse`。
- `HostedRelay.resume(): Promise<HostedResume>`、`HostedResume`、`HostedRelayOptions.storage`、`createSessionRelayVault`、`SessionRelayVault`、`HOSTED_RESUME_KEY`；`RelaySignInProps.relay` 可带 `resume`。

没做 / 偏离：

- 动了 `panels/SettingsDialog.tsx`（把 `remote` 传给导航）、`shell/RelaySignIn.tsx`（挂上时续）与 `api/identity.ts` 一处注释；`shell/Banners.tsx` 未动——中继停了那条仍不给刷新钮，现在刷新其实能续上，留给后续。
- 同一标签页「复制标签页」会把 `sessionStorage` 一起复制，两页共用同一把刷新令牌，先轮换的一页让另一页续不上（回登录页）；不做跨标签协调。
- 中继托管页面上 `RUNTIME_VIA_SERVER_SHELL` 在模块加载时按 HTTPS 页面来源算成 `true`，导航因此列「账号与共享」；本包没改这个判定。
- 经 Gateway 直连打开时关掉对外服务同样会自断，但 `gateway-e2e` 明确要求页面上能经 Gateway 自己关掉它（「在页面上点开关关掉对外服务」），本包不改这条既有行为；`useRemoteAccess().via === "direct"` 已可用于以后加确认。
- 原生 App 的设置页按同一判定生效，但只在单测里验过（`mobile/` 不在本包范围）。

## R5 经中继的数据流与覆盖：媒体票、语言会话恢复、两台经中继的源、WebKit（协议 minor 21）

做了什么：

- **媒体票与 Range**（契约 §37.4，§37.2 追加一句）：`files.mediaTicket`（`files:read`）答相对源的 `/api/media/<票>`；票在 core 内存里，绑签票时的请求身份、一个文件与用法（`inline` / `attachment`），可多次用，闲置 5 分钟或签出 30 分钟作废，每次取按签票会话复核、按那个文件的下载路由过路由门。`GET` / `HEAD /api/media/<票>` 由 `core/files/routes.ts` 的原样路由答：本机文件流式读盘、单区间 `Range` 回 206 / 416，图片（SVG 除外）与音视频按真实类型内联，其余附件 + octet-stream，带 nosniff、`sandbox` CSP、`no-store`；任何失败在路由里答完，路径（含票）不进日志。回环、Gateway、隧道三道门对这条路径只认票（`identity/transport.ts` 的 `mediaPath`）。`file-download` 也认单区间 `Range`，本机文件只读那一段。
- **经中继**：armadra-cloud 的边缘加媒体票（cloud-api §12，PR 见下）：`POST <源地址>/_relay/media-tickets` 带中继令牌换票，`<源地址>/_relay/m/<票>` 不带头按票转到源上那条路径。页面 `api/assets.ts` 的 `directFileUrl` 先换 core 票，源经中继（`Source.relayed()`，含中继托管页面的本机源）时再换中继票。
- **编辑器**：音视频与图片的 `src` 直接是票地址；图片 32 MiB、文本 1 MiB（不再先读正文）、退回 `blob:` 的那条（老 core、PDF）16 MiB 设上限，超了给「下载」。下载在 Bearer 源没有保存对话框时（iPad）用附件票地址交给链接，不取回成 `Blob`。
- **桌面 CSP**：`img-src` / `media-src` 加回环与按源追加的 `https:` 来源（原来只许 `blob:`，票地址被拦）。
- **`sourceForUrl` 按路径前缀认源**：同一个个人中转上的两台源来源相同，原来只按来源比，第二台的终端、媒体与流拿第一台的凭据（中继 `relay_source_mismatch`）。多源探针改成两台都经中继后暴露。
- **语言会话**：五次退避都失败后不再停在「已断开」——每 30 秒再开一轮新会话，`online` 或页面回到前台立刻开，连上即停；§35.6 的独立连接不变。
- **探针**：`multi-source` 两台 core 都经中继挂载（第二台换成不带壳的 core，服务器壳经中继绑定的主人没有工作空间权限，终端开不起来），补媒体票 Range、语言会话诊断往返与断开后重开、浏览器画面点击往返；`platform-lib` 加 `startPlainCore`、`relayedRoute`、`socketOpened`。新增 `webkit-roundtrip`（B 档，`requires: webkit`），e2e 运行器认 `webkit`，没装记 skipped；根 devDependency `playwright-core` 1.63.0（开发依赖，notices 不变）。

实测（macOS arm64，基于 main 9f33e3df）：

- core：`files/media.test.ts`（12）、`main.test.ts` 回环上不带头按票取 206、登出后 401；gateway / relay 准入、CSP、`parity-files`（18 条）。web：`EditorNode.media.test.tsx`（6）、`assets.test.ts` 的 `directFileUrl`（3）、`source.test.ts`（4）、语言恢复（2）。
- `multi-source` 全过（中继镜像用 cloud 分支构建，`ARMADRA_PROBE_RELAY_IMAGE`）；`webkit-roundtrip` 经运行器 passed（WebKit 26.6：空闲 6 秒后的 POST 三轮都有 HTTP 答复，视频 206 `bytes 0-1/…` 后整段）。
- `pnpm check` 通过；`pnpm libs:build && pnpm -r --if-present test`：desktop 5262 过 / 67 跳，web 3879 过，shared 372、server 98 / 4 跳、mobile 10、push-relay 9 过。

没做 / 偏离：

- 浏览器画面流：页面在 socket 打开时发的 `viewport` 落在服务端挂上观看者之前会丢（`core/browser/stream.ts` 在 attach 之后才接 `message`），换视口也不会主动出新帧；探针改用点击验往返，这两点留给后续。
- ACP mock 发 prompt 不在 WebKit 跑法里（personal-roundtrip 本来没有）。CI 拉不到 armadra-cloud，`webkit-roundtrip` 与其余中继探针在 CI 上都是 skipped；ubuntu 上要跑需 `playwright-core install --with-deps webkit`。
- 中继媒体票只在签票的那个中继进程内存里，SaaS 多节点要共享存储或粘连。
- iPad 原生 App 的下载走 `<a href>` 附件票地址，真机行为没验（无设备）。

接口：

- 契约 §37.4；`files.mediaTicket` `{ workspaceId, path, disposition? } → { url, expiresAt, size, mimeType }`，自 1.21；`PROTOCOL_MINOR = 21`。
- core：`files/media.ts`（`MediaTickets`、`parseRange`、`byteHeaders`、`writeBytes`）、`identity/transport.ts` 的 `MEDIA_PATH_PREFIX` / `mediaPath`。
- 页面：`directFileUrl(workspaceId, path, disposition, issue, source?)`、`downloadRuntimeFile(…, { direct })`、`Source.relayed?()`、`runtimeApi.mediaTicket`。
- 合并顺序：armadra-cloud 的媒体票 PR 先合（老中继上换中继票失败时页面退回 `blob:`，不坏），再合本 PR。

## nightly 回归修复（2026-10-05 起连续失败）

nightly 在 `b8353492`（运行 37338174906）之后连续失败。逐个作业对完整日志与产物，四个作业里三个是探针 / 用例没跟上新行为，一个是基线没跟上契约内核带来的内存：

- **windows acceptance**：`terminal.backend` 答 401 `unauthenticated`，之后整串跳过。根因是 `78d277c5`（回环上每条 `/api/` 与每条流都要会话，契约 §3.2）——探针装进页面的 `PAGE_HELPERS` 直接 `fetch` 不带凭据。改成与页面同一条路：经 `window.armadra.identity.ticket()` 取票、`POST /api/identity/pair` 换 Bearer，HTTP 带 `Authorization`（401 时换一枚只重发一次），WebSocket 先 `POST /api/identity/ws-ticket` 再放进 `Sec-WebSocket-Protocol`。Bearer 只在页面内存里。
- **mobile (android / ios)**：多连接连接页（`4f84ed65`）在还没有连接时先列添加方式（扫码 / 配对链接 / 个人中转），输入框要点「配对链接」才出现；Android 与 iOS 的用例还在一上来找输入框。给「配对链接」按钮加不依赖文案的 `data-connect-method="link"`，Android 用例先点它；iOS 按「配对链接 / Pairing link」等连接页、点开后再找输入框，深链那条直接落在预填的输入框。Android 的取图（R-55）在 `86271782` 就已失败（`Failed to fetch`）：`2f72173e` 起页面不再改写全局 `fetch`，凭据装在本机源上，用例改为从 Keystore（`ArmadraNative.getSessions()`）读回这台 Gateway 的会话、自己带 `Authorization` 取。`adb: device offline` 只是模拟器启动等待期的输出，不是失败原因。
- **Linux 打包与 B 档**：只有 `server-perf` 判 RSS 退化（稳态 175.9 → 228–260 MiB）。定位到契约内核与 E3 各域契约：`@armadra/shared` 在模块求值时建全部 zod schema（约 40 MiB 活对象，zod 4 classic 每个实例约 7.5 KiB），只加载服务器壳 bundle 的 RSS 就从 135 涨到 254 MiB。不是泄漏、也不是这次能顺手降的东西，`rssPeakMiB` / `rssSteadyMiB` 按三次夜间中位数重录（`server-performance-baseline.md` §3.2），其余指标不动。

实测：

- `windows-acceptance.test.mjs` 加页面工具的配对、401 重配、WS 票子协议用例；`ConnectScreen.test.tsx` 加 `data-connect-method` 用例；`server-perf.test.mjs` 过。
- 分支上手动触发 nightly 37545888094：android、ios、macOS、Linux arm64、knip 全过；Windows 首跑全部检查过、只有 `soak` 的 powershell 30 秒内没回显（之前 4 次 nightly 都过），重跑作业通过；Linux 只剩 `server-perf` 的 RSS 两项（重录前）。
- `pnpm libs:build && pnpm -r --if-present test` 全过。

没做 / 偏离：

- 服务器壳启动内存的真正下降（换 `zod/mini` 或按需构建契约）没做，留作独立工作。
- Windows `soak` 的 powershell 偶发无回显只见过一次，没有证据指向产品问题，没改。

接口：无变化。页面只多一个 `data-connect-method="link"` 标记（给真机 UI 用例用）。

## 设置弹窗按视口取尺寸、节点头控件常显（UI 包 B）

设置弹窗原先固定 920×680，大屏上只占视口三分之一；节点头的 `···` 与 × 悬停才出现，而同一行的名字、内存常显，看起来像「有时有、有时没有」。

- **设置弹窗**：`tokens.css` 新增 `--settings-dialog-w: clamp(760px, 78vw, 1280px)`、`--settings-dialog-h: clamp(560px, 80vh, 960px)`，`SettingsDialog` 用它们并保留「视口 −48 与安全区」的上限；平板（768–1023）满宽 −32、满高 −48，导航 176；手机底部 Sheet 改整高（`data-[side=bottom]:h-…` 压过 Sheet 自己的 `h-auto`）；正文列 `max-w-[960px]` 靠左。
- **节点头**：删掉 `.node-secondary-action` 的隐藏规则，所有控件常显。头部分身份 / 胶囊簇 / 状态 / 审批 / 动作几段：段间 8px，身份段内 4px，审批与动作段内 2px；没内容的段不渲染。胶囊统一走 `nodes/header-chip.ts` 的 `HEADER_CHIP_CLASS`（`Badge` 18px / caption / `px-1.5` / 等宽数字），内存徽标的触发器改成同款 `Badge outline`。胶囊簇最多占 40%，挤的时候胶囊逐个让，不再压到折叠计数上；身份段 `flex-auto`，标题不会被让光。
- 设计系统 §2.7 加两条 token，§4 加「节点头」一行；展示页 `canvas` 分区加满载节点头的固定状态，`components` 分区加真设置弹窗的触发器。

实测：

- `SettingsDialog.test.tsx`（token 与整高）、`NodeShell.test.tsx`（`···` / × 常显、分段与间距）、新增 `HeaderChips.test.tsx`、`styles/nodes.test.ts`（样式表里没有隐藏规则、胶囊簇 40%）、`tokens.test.ts` 过；web 全量测试与 typecheck 过。
- 无头 Chromium 实量设置弹窗（深浅两套）：1920×1080 → 1280×864，1440×900 → 1123×720，1280×800 → 998×640，1024×768 → 799×614，900×1100 → 868×1052（导航 176），390×844 → 390×796 底部整高；`design-showcase.mjs --only=canvas,components` 在 1440 / 1024 / 390 与两套主题下全过（对比度、Tab 可达、焦点环、减少动效、控制台）。

没做 / 偏离：

- 账号与交接两枚胶囊（`agent/account/AccountBindingBadge.tsx`、`agent/handoff/HandoffBadge.tsx`）不在本包文件边界内，没对齐到 `HEADER_CHIP_CLASS`。
- 展示页探针只认 1440 / 1024 / 390 三档宽度，1280 / 1920 由上面的单独实量覆盖；设置弹窗要点开才出现，探针的整页截图里看不到它。

接口：无契约改动。新增 `HEADER_CHIP_CLASS`（`apps/web/src/nodes/header-chip.ts`）、`SETTINGS_DIALOG_CLASS` / `SETTINGS_SHEET_CLASS`（`panels/SettingsDialog.tsx`）、token `--settings-dialog-w/h`。

## 多端加入不刷新：终端多端尺寸、身份通知分级、租约只读（包 E）

现象：手机或第二台电脑打开同一块画布时，已经开着的那一端「全部刷新一下」。根因已在隔离数据目录复现：终端尺寸是会话级共享的——新页面 attach 后无条件发一次 resize，core 把这个会话**所有** tmux 客户端改成新来者的尺寸，`window-size latest` 让窗口跟着变，每一端的终端都整屏重绘（去掉了 smcup/rmcup，每次重绘还往 scrollback 追加一屏）；手机端列数小，桌面端被压成手机宽且不会自己恢复。次因是身份层每次 CSRF 轮换、令牌续期都通知「会话变了」，`App.tsx` 随即整个 QueryClient 失效。

做了什么：

- **终端窗口尺寸（core）**：`record.cols/rows` 改为窗口尺寸，每个 attachment 自己记尺寸。窗口取谁的由纯函数 `windowSizeOf` 决定：有人类驾驶者（持终端驱动租约、经仍连着的那一端敲键）取驾驶者的；否则取面积最大的一端；同样大时保持当前，不来回切。只有结果变了才调后端一次。tmux 每个窗口建好（或重启后接管）就设成 `window-size manual`，窗口由 core 用 `resize-window` 显式设置（全局 conf 仍是 `latest`：全局 `manual` 会让 tmux 3.4 在第一次 detached `new-session` 时退出，Ubuntu 24.04 上复现过）；resize 帧只改发出它的那一端自己的 tmux 客户端（后端新增可选的 `resizeViewer`，SSH 包装按内层透传）。direct / session-host 只有一个 pty：别端的 resize 只记下来，pty 只跟窗口走。attach 不再用新来者的尺寸覆盖窗口；没给尺寸的 attach 从窗口尺寸起步，`hello` 报的就是这一端自己的尺寸。驾驶者停手十秒租约过期后，窗口自动回到最大端。
- **页面 attach**：`hello` 尺寸与本地容器相同就不发 resize（`helloNeedsResize`）。比窗口小的一端由 tmux 裁切显示，比窗口大的一端右、下留空，不压主端。
- **身份通知分级**：`onIdentitySessionChange` 的回调带 `appeared | gone | switched | rotated`。CSRF 轮换、Bearer 续期、同一会话的刷新都是 `rotated`；`forgetCsrf` 之后再采用别的窗口换来的令牌也算 `rotated`；登出与壳签不出票是 `gone`。`App.tsx` 只在 `appeared`、`switched` 时整体失效，`rotated` / `gone` 不动。
- **租约模式丢租约**：`applyPresence` 判定 `lost` 时只切只读，不清本地改动、不改保存状态；`use-board-sync` 不再重取文档。画布活动只在真正的编辑（文档被 commit 置 dirty）时记，指针按下、按键不再算，空闲持有者的租约不会被「摸一下」抢走。
- **休眠唤醒**：休眠中的 tmux 终端被别的端叫醒时，本页重连不再 `terminal.reset()`（direct 会补发 snapshot，仍清屏）。

实测：

- core 单测：`windowSizeOf`（最大端、同大保持、驾驶者、Agent 持租约不算）；两端 attach，B resize 只改 B 的视图、窗口不动、同尺寸不再下发；B 敲键拿到租约后窗口变 B 的，十秒后回到 A 的；最大端断开后顺延；单 pty 后端只记尺寸。真 tmux：一端 `resizeViewer` 后 `list-clients` 里另一端尺寸与窗口不变，`resize` 只改窗口。socket：`hello` 报 manager 给的尺寸、resize 带 attachmentId、按键先记驾驶端。
- web 单测：`helloNeedsResize`；`use-hibernation` 被别端叫醒的 tmux 表面重连不清屏、direct 照旧；`identity.test.ts` 配对 `appeared`、刷新与 CSRF 轮换 `rotated`、Bearer 续期 `rotated`、换人 `switched`、登出 `gone`、`forgetCsrf` 后采用 `rotated`；`App.test.tsx` `rotated` / `gone` 不失效、`appeared` / `switched` 全量；`use-board-sync.test.tsx` 被接管只读不重取、本地改动保留、只有编辑记活动（原来两条「被接管就按远端重载 / 丢掉本地改动」的断言按新设计改写）。
- 新探针 `tools/probes/join-no-refresh.mjs`（A 档，`tools/ci/e2e.d/join-no-refresh.json`）：A 1440×900 开两终端一便签，手机 390×844、第二台桌面 1280×800 先后加入，再从手机端开一条终端连接发 `resize 40x12`；每步断言 A 无整页重载、无重挂载、终端 WS 不断、3 秒内 output 帧 0、tmux 里 A 的客户端与窗口尺寸不变、画面逐行相同、只有周期请求与在线心跳、视口不变；手机那一端客户端是 40×12。本分支通过；把 `apps/` 换回 main 的代码再跑，第一步就失败（A 收到 8 帧重绘），和调查时的 7 帧一致。
- `realtime-e2e` 回归通过；`ui-features-e2e --only=presence` 的接管一步按新行为改为断言「第一台保留本地改动、不重载」后通过；`gateway-e2e` 通过。

没做 / 偏离：

- 文件边界外动了几处，都是接口或仓库规则所需：新增 `core/terminal/viewers.ts`、`core/terminal/manager-types.ts`（只是把类型挪出去），`core/terminal/backpressure.test.ts` 的假 manager 补 `size`，以及`core/terminal/backend.ts`（`TerminalBackend.resizeViewer?` 与 `resize` 的语义注释）、`core/terminal/ssh/backend.ts`（透传 `resizeViewer`，否则 SSH 下的 tmux 会话退回单 pty 行为）。
- `appeared` 也整体失效，而不是设计里的「只失效以 401 / 403 失败的查询」：配对前有些查询是**成功地**答「没有会话」（`useAccess` 的会话查询答 `null`），只重取失败的会让经 Gateway 打开、刚配对完的页面一直按成员处理（`gateway-e2e` 的「对外服务开着、二维码出来」超时，CI 上复现、本地验证）。`appeared` 只在配对、登录、过期后重新接上时出现，与别端加入无关；`switched` 同理全量，缓存里的数据不是这个人的。
- `IdentityGate`、`Banners`、`GatewaySection` 三个订阅者不在本包边界内，没改：前者在 `rotated` 时仍失效一次会话查询（只是一条 `GET session`），`Banners` 用它刷新壳签票失败的通知条（需要所有通知），`GatewaySection` 在设备列表页才挂载。
- 租约模式下，丢租约前还在去抖里的编辑，会在下一次保存时被 `autosave` 的只读分支丢掉（`save/autosave.ts` 不在边界内）；画布不再闪、撤销栈保留。
- 单 pty 后端（direct / session-host）的别端仍按窗口宽度换行显示，这是单 pty 的固有限制。
- 驾驶者是手机时窗口会变成手机尺寸，桌面端看到的是裁切视图；手机停手十秒（租约过期）后窗口回到桌面尺寸，这期间各端会各重绘一次。
- 代码注释里的 `ui-acp-refresh §7.3 E-1…E-4` 指向本轮 UI / ACP 设计文档，若该文档最终不进仓库需要改成本节。

接口：无契约变化。终端 WS（不在契约里）：`hello` 的 `cols/rows` 改为这一端自己的起始尺寸（未给尺寸时等于当前窗口）；resize 帧只作用于发出它的连接。页面：`onIdentitySessionChange(listener: (change: IdentityChange) => void)`，新增导出 `IdentityChange`。core：`TerminalManager.attach(sessionId, size?, writer?)` 返回多一个 `size`，`resize(…, attachmentId?)`，新增 `noteViewerInput`、`windowOf`；观看者与窗口规则在新文件 `core/terminal/viewers.ts`（纯函数 `windowSizeOf`、`TerminalWindows`）；`TerminalBackend.resizeViewer?`。`manager.ts` 的公开类型挪到 `manager-types.ts`（`manager.ts` 照旧全部再导出），否则超过仓库 1500 行的上限。

## 包 A 集成页重设计、适配器与 CLI 代装、在画布中创建 Agent（契约 §47 §48）

设计：[界面与 ACP 刷新](../design/ui-acp-refresh.md) §1、§2（本包把设计文档收进仓库）。

做了什么：

- **代装两张白名单（§47）**：`agents.installAdapter` 入参加 `target?: "adapter" | "cli"`（缺省 `adapter`）与 `rollback?`；`AGENT_CLI_PACKAGES` 补齐七家 CLI 包（claude / codex / opencode / pi / omp / copilot / ama），删掉 omp「没有公开 npm 包」的过时注释。任务键 `${agentId}:${target}`，同一家另一样在装答 409 `adapter_install_busy`。开始前用同一个 npm 跑 `npm ls --global --depth=0 --json <包>` 记 `previousVersion`；`rollback` 装回 `<包>@<previousVersion>`，没有就 409 `adapter_rollback_unavailable`。
- **canvasAgents（§48）**：`agents.integration` 出参加 `canvasAgents: { terminal, acp, reasons }`，`core/hook/install/integration.ts::canvasAgentsOf` 纯函数按 CLI 在不在、Hook / 技能、启动器警告、ACP 程序、适配器 `canvasTools`、`AcpClient.features.mcpServers` 判。适配器表加 `canvasTools: "mcp" | "runners" | "none"`；pi 改 `none` 并 `injection.mcp: false`（不再给 pi-acp 带 `mcpServers`）。
- **集成页**：一家一张 `SettingsGroup`（标题 CLI 名），行 CLI / ACP / 画布注入 / 在画布中创建 Agent / 本地历史；值是灰字不是徽标，正常时不出任何提示。CLI 与 ACP 各一个「安装 / 重新安装」（原生 ACP 的 ACP 行写「随 CLI」、无动作；`custom:` 只给「复制命令」）；失败时行下一条 `Alert`：「{包名} 没有装上」+ 重试 / 查看输出 / 恢复上一版本；没有 npm 时「没有找到 npm」+ 复制命令。注入行只在待更新 / 缺 Hook / 缺技能 / 注入受限时有值，旧残留是「修复 N」弹层（看清单再修）。「已清理全局安装」改成首次一条提示（`localStorage` 记已提示）。加载 >300ms 才出 `Skeleton`，空列表是 `Empty`。
- **派生 Agent…**：Agent 节点 `···` 菜单多一项，打开同一个新建向导（`openSpawnAgentWizard(supervisorNodeId)`，标题「派生 Agent」），建好后 `addEdge` + `setEdgeRole("supervises")`，新节点放在主节点右侧（被占就往下错开）；节点与边在一次合并历史里，撤销一次全回。向导的直接安装钮在 CLI 没装时装 CLI。
- 文案进 `i18n/integration.ts`（按设计 §1.5 重排，删掉 `mode.* / hook.revision / skill.revision / stale / launcherWarning / migrated / acp.missing…` 等不再用的键）与 `i18n/nodes.ts` 一个键；两个新错误码进注册表与 `i18n/errors.ts`。

实测：

- core：`adapter-install.test.ts`（CLI 表、任务键与 busy、记上一版本与回滚、`npm ls` 解析、procedure 的 `target`）、`integration.test.ts`（`canvasAgentsOf` 各分支、`state()` 在临时 PATH 上答 claude 全可用 / pi 会话视图受限）、`adapters.test.ts`（`canvasTools === "mcp"` ⇔ `injection.mcp`）、`mcp.test.ts`（pi 不带 MCP）。全部用假 runner / 假 npm，没有在本机执行 `npm i -g`。
- 页面：`IntegrationPage.test.tsx`（五行、健康时没有徽标、历史值、修复弹层、注入受限与原因提示、原生「随 CLI」、CLI 安装）、`adapter-install.test.tsx`（两样各自安装、失败 Alert、查看输出、恢复上一版本带 `rollback`、没有 npm、向导装 CLI）、`NewAgentWizard.test.tsx`（派生：位置、主从边、一次撤销）、`terminal-menu.test.ts`、`SettingsDialog.test.tsx` 集成两例改新结构。
- `design-showcase.mjs --only=integration --width=1440,390`：深浅两主题四张图，对比度通过，控制台无 error。
- `pnpm libs:build && pnpm -r --if-present test`：shared 372、server 98、web 3945、desktop 5329 过；desktop 整套并行时 `parity-terminals` 的 afterAll 与 `hibernator.pty` 的 5 秒计时各超时一次（机器负载高），单独重跑两文件 19 条全过；desktop live 4 条、scripts 73 条过。`pnpm --filter @armadra/web typecheck`、`pnpm check` 过。

没做 / 偏离：

- `PROTOCOL_MINOR` 没改（由最后合入的包统一改到 22）；§47 沿用 §39.7 的两条 procedure，`since` 仍是 1.15，扩展字段写在 §47。
- 文件边界外多动了几处（都是接线所需）：`packages/shared/src/api/agents.ts`（`integrationStateSchema.canvasAgents`）、`contract/errors.ts` 与 `apps/web/src/api/request.ts` / `i18n/errors.ts`（两个新码）、`apps/web/src/api/agents.ts`（`target` / `rollback` 入参，缺省不写 `target` 以兼容旧 core）、`core/acp/mcp.test.ts`（pi 不再带 MCP）、`panels/SettingsDialog.test.tsx` 两例（与包 B 同文件不同用例）、`i18n/showcase.ts` 一条展示页说明。
- 远端执行主机上的代装、经中继看别人 core 时的安装（`available === false` 分支不出按钮）不在本包。`team` 不带 `--cwd / --resume` 仍是协调者设计剩余项。
- 真实 npm 安装、真实 CLI 登录没有在本机跑（规矩不许）；需要用户在自己机器上点一次「安装 / 恢复上一版本」确认 npm 全局前缀落在 PATH 上。

接口：

- 契约 §47：`agents.installAdapter { agentId, reinstall?, target?, rollback? }`、`agents.adapterInstall { agentId, target? }`；任务多 `target`、`rollback?`、`previousVersion?`；错误码 `adapter_install_busy`(409)、`adapter_rollback_unavailable`(409)。共享层 `AGENT_CLI_PACKAGES`、`ADAPTER_INSTALL_TARGETS`、`installablePackage(agentId, target)`、`agentCliInstallable`、`acpInstallCommand(agentId, target?)`。
- 契约 §48：`IntegrationState.canvasAgents`（共享层 `canvasAgentsSchema`）；core `AcpAdapter.canvasTools`、`canvasAgentsOf`。
- 页面：`useInstallJob(agent, target)`、`InstallButton`、`InstallFailure`、`AgentIntegrationGroup`（取代 `AgentIntegrationRow`）、`openSpawnAgentWizard(nodeId)`、`spawnPosition(nodes, supervisorId)`。

## C ACP 会话视图的展示与动作（契约 §49，协议 1.23）

会话视图按 ACP 的内容类型逐类补上展示与操作，并修「会话里什么都点不了 / 选不了」。

- **根因**（在浏览器里核实）：按钮的点击本身能到，问题是 React Flow 给 `.react-flow__node` 的 `user-select: none` 让整块会话的字选不中、复制不了，而且会话里除了展开工具行几乎没有可点的东西；手形工具开着时在会话里拖动会平移画布。会话视图根上加 `select-text nopan nodrag nowheel`，`ExportMenu` 不再包住正文，只是消息工具条里的一个 `⋯`。
- **页面**（`apps/web/src/acp/*`）：回合分组与时间；消息工具条（复制、编辑后重发、重新发送、重新生成、输出到画板），代码块单独复制；图片缩略图与资源链接（工作区内文件开编辑器、`http(s)` 开浏览器节点、其余只复制）；思考的流式指示与 40 字摘要；工具行 `completed` 改 `done` 胶囊、文件胶囊（≤2 + `+N`，工作区内的点了跳行）、复制入参 / 输出 / 命令、失败时「让它重试」；差异块复制补丁 / 路径、落为变更节点（`exportDiff`，一条历史）、超过 200 行折到 60 行；计划卡（回合结束自动折叠，图标 + 读屏文字）；模式切换行；`max_tokens` / `max_turn_requests` / `refusal` / `cancelled` 的回合尾行（`refusal` 不再算失败，只有协议错误进「这一轮没有完成」）；权限卡「详情」（差异、入参前 20 行、文件），钉住时焦点落到第一枚允许钮、人在输入时不抢、Esc 不答；输入框斜杠命令列表、上下文用量（≥90% 警示色）、编辑后回填。重发走同一条 `send`：只有「没送达」的那一轮沿用 `clientTurnId`（§39.9），跑完的回合重发换新 id。消息区 `role="log"` 不逐块念，回合结束时把最后一条回复放进 `role="status"`。
- **core**：镜像多记 `image`（base64 超 512 KiB 只记 `dropped`）、`resource_link`、工具结果的 `diffs` / `status: "failed"`、`tool_use` 的 `kind` / `locations`；只有 `acp.log` 以 rich 读法拿到，连线读取与摘要照旧。`acp.log` 出参多 `snapshot`（计划、用量、斜杠命令、标题），条件与 `pending` 相同。

实测：

- 隔离数据目录 + 临时 HOME 起 core 与 Vite，用假 ACP Agent 在浏览器里点：字可选（选择模式与手形工具下都是选字、视口不动）、编辑后重发回填、停止后「已停止 · 重新发送」、计划卡与用量、重载后计划 / 用量 / 工具种类与文件胶囊 / 失败状态都在。
- `acp-e2e.mjs` 新增 3b（展开工具行、复制入参写进剪贴板、根上 `user-select: text` 与 `nopan`、计划卡、失败胶囊）全过；唯一失败是第 5 步「终端里敲了恢复行」：worktree 路径更长，`fake-agent-main` 在 xterm 里折行被拆开，与本包无关。
- `design-showcase.mjs --only=acp` 两主题 × 1440 / 1024 / 390，对比度与控制台检查过。
- 新增 / 扩充用例：`store.test.ts`（十种 update、附件、计划折叠、快照）、`MessageList.test.tsx`、`ToolCallRow.test.tsx`、`DiffBlock.test.tsx`、`PermissionCard.test.tsx`、`PromptBox.test.tsx`、`SessionView.test.tsx`（四种停止原因各一行、根类名、`/` 命令、快照恢复）、`open-link.test.ts`；core `mirror.test.ts`、`session.test.ts`、`routes.test.ts`（`snapshot`）。

没做 / 偏离：

- 经中继看别人 core 时节点头的「源名」徽标没做：它在 `HeaderChips` / `TerminalNode`（包 B 与节点文件），超出本包文件边界；`acp.source.remote` 文案也就没加。
- `session_info_update` 的标题只记在 store（`view.title`），没接到节点命名建议（同样在 `nodes/*`）。
- 回合尾的停止行与模式切换行不进镜像，重载或断线重读后不再画；重载后计划卡画在最后一回合（快照不知道它属于哪一回合）。
- 镜像的读写改了 `core/acp/mirror.ts` 与 `core/history/acp-mirror.ts`（设计写的是 `session.ts`，实际写镜像的在这两处）。
- 没改全局 `PROTOCOL_MINOR`（仍 21）；§49 写「自协议 1.23 起」，由最后合入的包统一改。

接口：

- 契约 §49；`acpTranscriptBlockSchema` 多 `image` / `resource_link` 两种块，`tool_use.kind?` / `locations?`，`tool_result.status?` / `diffs?`；`acpLogResponseSchema.snapshot?: AcpLogSnapshot`；新导出 `acpUsageSchema`、`acpAvailableCommandSchema`、`acpLogSnapshotSchema`。
- core：`AcpSession.snapshot()`、`AcpMirror.read()` 返回 `MirrorEntry`；`readMirrorEntries(path, from, max, { rich: true })`。
- 页面：`PromptBox` 新增可选 `commands` / `usage` / `prefill`，`PermissionCard` 新增 `pinned`，`MessageList` 新增 `plan` / `actions`，`ExportMenu` 不再收 `children`（改为工具条按钮）。

## 画布「整理」按刚体排、导入成组（UI 设计 2026-10-07 §6，包 D）

用户报：导入一个项目后点「整理」，导入的东西被打散成一长排，Agent 簇散落。根因是整理按无向连通分量分簇：Mermaid 导入的框 / 字 / 线全是顶层白板对象、彼此没有链接，每一个都成了独立的盒子；主从边与对等边一视同仁；列内顺序是输入顺序。

做了什么：

- `canvas/tidy.ts` 重写内核（接口 `tidy(boxes, links, options)` 保留）：白板对象按「相交或间距 ≤ 24px」并成孤岛（并查集），组节点、顶层节点、孤岛各是一个刚体，内部相对位置不变；单元按原位置的阅读顺序（`y` 以 48 量化成行、行内按 `x`）排；只取 `role: "supervises"` 的边建主从森林，主在第 0 列、从在第 1 列顶对齐主且纵向等距、孙按父分段，环从阅读顺序最靠前处剪断；对等边连着树成员的非 Agent 单元作为附件挂在那个成员正下方；其余分量拓扑分列、之后各列按重心法排；每步前进量向上取整到 8px 网格（等高兄弟仍等距），簇照旧按视口宽高比裹行。整理两次第二次位移为 0。2000 个单元约 11 ms。
- `canvas/tidy-flow.ts`：盒子带原位置与 `kind`（带 `agent` 的终端或主从边端点是 Agent），链接带 `role`；新增 `tidySelection(state)`：选区换算到顶层后 ≥ 2 个才只整理选中的，原点取选区包围盒左上角；原点吸网格。一次整理仍是一条历史。
- `FlowWorkspace` 的 `canvas.tidy`：只整理选中时不 `fitView`；整理那一下给画布根加 `data-tidying`，`canvas.css` 只在这时给节点开 220ms 的 transform 过渡，260ms 后撤掉；减少动效下不加。Dock 的按钮在有可整理选区时提示「整理选中」。
- 导入批次 = 一个 `group` 节点（新模块 `canvas/import-group.ts`：`commitBatch` / `wrapInGroup` / `ungroup`）：导入 Mermaid、一次拖入 / 选择 / 粘贴 ≥ 2 个图片或文件时，新建对象、套组（`data.origin: "import"`，组名「Mermaid」/「导入」）、选中组在一个合并会话里完成，撤销一次整批消失；单个对象不套组。外部内容的几条入口改成先攒一批再一次落地。组节点右键菜单加「解组」。
- `@armadra/shared` 的 `groupNodeDataSchema` 加可选 `origin: "import" | "team" | "manual"`（缺省即 manual），不改 `whiteboard_json v2`，无迁移。
- 新探针 `tools/probes/canvas-tidy.mjs`（登记在 `tools/probes/README.md`）。

实测（macOS arm64，基于 main fb54e0b1）：

- `tidy.test.ts` 加 §6.7 (a)–(h) 与环、重心法；`tidy-flow.test.ts` 加主从、孤岛、只整理选中（未选中不动、一次撤销全回）、选区不足两个单元、二次整理不提交；`import-group.test.ts`、`mermaid/import.test.ts`、`external-content.test.ts`（≥ 2 个成组、单个不套）、`Dock.test.tsx`（提示切换）。
- `canvas-tidy.mjs` 全过：主从边 3 → 3、8 个顶层单元两两不重叠、导入组 11 个 / 旧导入孤岛 8 个 / 手画 3 个对象相对位置不变、子 Agent 保持阅读顺序且同列顶对齐等距、浏览器挂在所连从下方、8px 网格、包围盒 1436×1556、二次整理位移 0、撤销一次全回；`canvas-stress.mjs` 跑通。
- `pnpm libs:build && pnpm -r --if-present test` 全过（web 3964、desktop 5324 / 67 跳、shared 372、server 98 / 4 跳）；web typecheck、`pnpm check` 通过。

没做 / 偏离：

- 新增了 `canvas/import-group.ts`（+test）、`mermaid/import.test.ts` 与 `Dock.test.tsx` 的一条用例，不在 §9 列出的文件里：成组逻辑 Mermaid 与外部内容两处共用，放进任何一边都要另一边反向依赖。
- `design-showcase` 的「整理后」固定状态没加（`showcase/sections/canvas.tsx` 与包 B 共改，避免冲突）；整理前后对比由探针截图给。
- 「插入 Memory」仓库里没有这个入口，没有对应改动；导入链接目前每次只落一个对象，不成组。已有画布里散落的旧导入不自动补组，整理按孤岛保持它们不散；手动补组用现有「成组」（只收节点，白板对象不进组，沿用现状）。
- 发现但未修（core，不在本包边界）：文档 REST 保存的 `parseEdge`（`core/canvas/routes.ts`）不收边的 `role`，非实时板上页面设的主从会在下一次保存后变回对等；实时板经 Yjs 落盘不受影响。探针因此等画布可写后用 `setEdgeRole` 设主从。

接口：

- 页面：`tidy(boxes, links, options)` 的 `TidyBox` 多 `x? / y? / kind?`，`TidyLink` 多 `role?`，`TidyOptions` 多 `grid?`；`tidyKindOf(node)`；`arrangeCanvas({ aspect, only })`、`tidySelection(state)`；store `arrangeNodes({ aspect?, only? })`；`commitBatch(batch, title, label?)`、`wrapInGroup(nodeIds, itemIds, title)`、`ungroup(groupId)`。
- 共享：`GroupNodeData.origin?`。契约、协议号、数据库都不变。
- 文案：`canvas.tidySelection`、`canvas.group.import`、`canvas.group.mermaid`、`canvas.group.ungroup`（`i18n/canvas.ts` 中英）。

## 并发启动多个 Codex：启动闸门、失败重试、垫片穿透（界面第二波 §8，契约 §52，包 E）

用户报：`canvas_team` 一次起 3 个 Codex，第 3 个报 `account/read failed during TUI bootstrap: … workspace routing discovery timed out` 起不来。调查（同一份 `CODEX_HOME` 上并发自举会争状态库迁移与账号路由探测；三个节点的启动行几乎同时敲出；PATH 上第一个命中的是 mise 垫片，每次多一层 mise + node）见设计 §8.1。

做了什么：

- **core 启动闸门**（新 `core/agent/launch-gate.ts`）：按 `(agentId, 配置目录)` 排队；Codex 同时 1 个，持有者报出第一条真上报（`hook` / `extension` / `acp`）或 6 s 到期放行下一个，再随机等 500–1500 ms；其余 CLI 不排。只在内存里。`agent/index.ts` 装配时订阅 `agent.status` 放行；依赖与运行由 core 启动的节点（`dependencies/launch.ts`）在敲行前直接 `acquire`，SSH 节点不排。
- **两条 REST**（`core/agent/routes.ts`，登记进 `http/routes.ts`，服务器壳的路由门在 `identity/route-access.ts`）：`POST /api/agents/launch-slot` 长轮询拿位置；`POST /api/agents/launch-result` 判这一次起没起来——只看 shell 下面还有没有进程、节点报没报过状态，不读屏幕。第二次（`attempt ≥ 2`）仍失败时 `send-queue.ts::failLaunch` 把排给它的投递结算为 `cancelled` / `settledBy: "gate"` / `launch_failed`，回执照常写回，`wait --task` 答 `failed` + `reason: "launch_failed"`。
- **页面**（`terminal/surface/use-launch.ts`）：提示符安静后先申请位置再敲，敲完问结果；失败退避 2–5 s 自动重敲一次；第二次失败节点头显示「启动失败」胶囊与「重试」按钮（重开终端走同一遍）。闸门请求失败或旧 core 没有路由时照常敲、不重试。文案 `agent.launch.failed` / `agent.launch.retry` 中英同步。
- **垫片穿透**（`core/agent/registry.ts::versionManagerTarget`）：`resolvedPath` 是 mise / asdf 垫片时在家目录跑一次 `<manager> which <cli>`（10 s 超时，按 `(路径, mtime)` 缓存），把真实路径填进 `launchTarget`；页面与 `dependencies/launch.ts` 都优先起它。只读，问不出来维持原样。
- 共享 schema：`launchSlotRequestSchema` / `launchSlotResponseSchema` / `launchResultRequestSchema` / `launchResultResponseSchema`、`LAUNCH_VERDICTS`、`LAUNCH_FAILED_REASON`。
- 新探针 `tools/probes/launch-concurrency.mjs`（登记在 `tools/probes/README.md`）。

实测（macOS arm64，基于 main 20248839）：

- `launch-concurrency.mjs`：隔离数据目录 + 临时 HOME + `ARMADRA_NO_GLOBAL_WRITES=1` + 文件密钥后端，假 `codex`（同一状态目录同时只容两个自举、慢启动 2.5 s）。不过闸门同时敲：`failed, started, started`，恰好 2 个起来；过闸门：放行间隔 7314 / 7272 ms，三个都 `started`、都起来。
- 新增 / 扩充用例：`launch-gate.test.ts`（串行放行间隔 ≥ 500 ms、上报提前放行、holdMs 兜底、非 Codex 与别的配置目录不排、等满答 `granted: false`、同节点重复申请顶掉旧的、`watchLaunch` 四种判定）、`registry.test.ts`（假 mise 垫片穿透、问不出来回退且缓存、答非可执行文件不收、普通程序不问）、`routes.test.ts`（HTTP 拿位置、越界 404 / 未知 Agent 400、两次失败结算队列、`started` / `unknown`）、`wait.test.ts`（`launch_failed`）、`dependencies/service.test.ts`（core 起的 Codex 等前一个放行才敲）、web `use-launch.test.ts`（先申请再敲、闸门不通照敲、失败重敲一次后标失败且不敲第三次、清掉后不重试）、`TerminalNode.test.tsx`（失败胶囊与重试钮）。
- `pnpm libs:build && pnpm -r --if-present test` 全过（web 4032、desktop 5371 / 67 跳、shared 372、server 98 / 4 跳）；web typecheck、`pnpm check` 通过。

没做 / 偏离：

- **失败判定改在 core**：设计 §8.3 写的是页面看 `lastExitCode`，但启动行是敲进 shell 的，CLI 退出后 shell 还在，PTY 不会报退出、也拿不到 CLI 的退出码。改为新增 `launch-result` 长轮询由 core 看前台进程；代价是 30 s 内被人自己退掉、又从没报过状态的 CLI（Codex 启动不报 `SessionStart`）也会被当成失败并自动重敲一次。Windows 会话宿主答不出前台，判 `unknown`，不重试。
- 「重试」按钮用重开终端（`restart()`）而不是 `ManualRunButton`：后者是带提示词的手动运行入口，语义不同。
- ACP 驱动的 `AcpRuntime.open` 没接闸门：按 §10 由包 D 在 `startAdapter` 前 `launchGate().acquire(...)`、`session/new` 返回后 `release(nodeId)`。
- 文件边界外的必要改动：`core/agent/index.ts`（装配一行）、`core/http/routes.ts`（路由登记，顺手把集成的三条 POST 收成一行以守住 1500 行上限）、`core/identity/route-access.ts`（服务器壳按体里的工作空间判）、`terminal/surface/types.ts`（`launch` 字段）、`manual-launch.test.tsx`（桩补 `statusRef`）、`docs/guides/architecture.md`。
- `--no-daemon` 与真实账号下的路由探测没有验证（需要真实 ChatGPT 账号，见设计 §8.5）；按目录切版本的项目，垫片穿透以家目录的全局版本为准。
- 没改全局 `PROTOCOL_MINOR`（仍 23）；§52 写「自协议 1.24 起」，由最后合入的包统一改。

接口：

- 契约 §52：`POST /api/agents/launch-slot { workspaceId, nodeId, agentId } → { granted, waitedMs }`；`POST /api/agents/launch-result { …, attempt } → { verdict: started|failed|unknown, settled }`；`agents.list` 的 `launchTarget` 也用于垫片；`wait` 的 `reason: "launch_failed"`。
- core：`launchGate()`（`acquire({ agentId, configDir, nodeId, timeoutMs? })`、`release(nodeId)`、`forget(nodeId)`、`holds` / `position`）、`configDirFor(baseAgentId, env?, home?)`、`policyFor`、`watchLaunch`、`installLaunchGate(bus)`、`activeLaunchGate()`；`registry.versionManagerTarget(resolved, which?)`、`clearShimCache()`；`send-queue.failLaunch(database, nodeId)`、`LAUNCH_FAILED_REASON`；`routes.launchOperations(collab, options?)`。
- 页面：`runtimeApi.launchSlot(body, signal?)`、`runtimeApi.launchResult(body, signal?)`；`TerminalSurfaceStatus.launch?: "failed" | null`。

## 集成清理只认本产品签名、启动不写 HOME（紧急修复 2026-10-08）

用户要求：不动用户的配置与系统配置，只注入自己的，不管也不改别人的东西。审计发现 `hook/install/repair.ts` 把另一个独立应用写进 CLI 配置的 Hook、指令块与技能目录当成我们旧版的残留（按名字子串、任意 `target/debug/`、通用技能名、指令块前缀匹配），集成页「修复」会列出并删除；启动迁移不经点击就删技能目录。实证：该应用在用户机器上运行，`~/.copilot/hooks/` 里它的文件被反复清空，两边互相改写，累积了多份 `.armadra-backup-*`。

做了什么：

- `repair.ts`：只认本产品签名——程序（路径最后一段）是 `armadra-hook` / `aicc-hook`（含 `.exe` / `.cmd`、开发构建）的 Hook 与状态行；调用它的状态模块；`armadra`、`armadra-canvas`、`armadra-linked-context`、`aicc-canvas`、`aicc-linked-context` 且 `SKILL.md` 带 `armadra:skill-revision` 尾注或调用我们客户端的技能目录；恰为 `armadra:skills` / `aicc:skills` 的指令块；与我们条目同在时 Codex `hooks.json` 的顶层 `version`。其他条目不进 `found` / `removed` / `kept`，所在文件没有我们的条目就不读写、不备份。`isLegacyCommand` 改为 `isOwnCommand`，`LEGACY_SKILL_DIRS` 改为 `OWN_SKILL_DIRS`。
- `migrate.ts`：启动只清数据目录里旧安装器的 `installed.json`，记录 `version: 3`、`agents: {}`；已有任何版本记录的原样读回。删掉启动时改 Claude / Codex / Copilot 配置、删模块与技能、清 Codex 会话信任记录的步骤；Worker 的 `integration.sync` 也不再改执行主机的 `~/.codex/config.toml`。
- `integration.ts`：早期版本记录里技能根下非本产品目录的路径不再出现在 `migration.removed` / `backups`。
- 页面：「修复 N」改为「清理旧版 N」，结果里的「保留 N 处（不是我们写的）」改为「保留 N 处」（中英同步）。
- 探针：`ui-features/integration.mjs` 夹具改为我们真实写过的命令形状，外加一条其他工具的命令，断言弹层不列、清理后仍在；`packaged-smoke.mjs` 改为断言启动不改临时 HOME 的任何 CLI 文件，再经 API 逐个点清理，断言我们的条目移除、他人的 Hook / 技能 / 指令块与 `config.toml` 字节不变；`scenario-5` 断言记录为 `version: 3`。

实测（macOS arm64，基于 main 20248839）：

- `repair.test.ts`、`migrate.test.ts`、`integration.test.ts`、`remote/integration.test.ts` 新夹具（中性名 `othertool` 的 Hook、Copilot 文件、技能目录、指令块、Codex 未知键）：扫描、清理、启动迁移都不碰，结果与集成状态里不含它；我们的条目照常列出与清理。
- `ui-features-e2e --only=integration` 通过（截图核对弹层只列我们的一条 ×11）。
- `pnpm libs:build && pnpm -r --if-present test` 全过（web 4027、desktop 5346 / 67 跳、shared 372、server 98 / 4 跳）；`pnpm check` 通过。

没做 / 偏离：

- 用户机器上已被改写的他人文件不恢复：该应用会自己重写；Armadra 留下的 `.armadra-backup-*` 也不自动删除（删除同样是改用户目录），由用户决定。
- 清理我们自己的 Codex 条目时不再同步修剪 `config.toml` 的按序号信任记录（规则按位置、认不出归属）；残留的信任记录无副作用。
- 已删除的启动步骤不在执行主机上补做；早期 Worker 写下的会话信任记录留在原处。

接口：

- 契约 §39.1 写明 `repairIntegration` 只认本产品签名；§13.3 记录 `version: 3`；§13.4 Worker 不再写执行主机。形状不变。
- core：`isOwnCommand(command)`、`isOwnSkill(body)`、`OWN_SKILL_DIRS`；`MigrationOptions` 去掉 `env` / `homes`；`MIGRATION_VERSION = 3`；`integration-worker.sync(stateDir, args)` 去掉 `env`；删除 `clearCodexSessionTrust`、`clearSessionTrustOnce`、`CODEX_SESSION_KEY_PREFIX`。

## 连线按 role 渲染、四边把手、簇色小地图与 Dock 缩放（界面第二波 §3 §5，包 C1）

用户报：主从线也写「上下文」、只能从左右两侧连、小地图分不清谁派的谁、Dock 没有 −/+；另疑在画布上改主从后投递授权不跟随。

做了什么：

- 修投递授权不跟随（先写测试复现）：页面推的链接文档不带 `role`，而 `@armadra/shared` 的 `contextLinkSchema` 也没有这个字段，`contextLinksRequestSchema.parse` 会把它剥掉；core `putContextLinks` 对缺省 `role` 保留旧值，于是「设为主→从」「掉头」「设为对等」后授权停在旧方向。现在 `buildLinkDocuments` 每项带 `role`（派发边主那侧 `sub`、从那侧 `main`，对等 `peer`），`sameLinks` 比 `role`，schema 收 `peer / main / sub`。core 不改。
- 连线按 role 渲染：`geometry.ts` 的锚点加 `"vertical"`（`LinkAnchor = horizontal | vertical | free`）；`linkCurve(source, target, anchor = "free")`；`linkView(…, role, anchor)`；`edgeLabelKey(…, role)` 对 `supervises` 返回 `null`。对等线就近边、中性色、按端点类型标签（`edge.context` 去掉 `⇄`，「上下文」/ "Context"）；派发线按布局方向走主底→子顶（C1 先写常量 `"vertical"`，在 `LinkEdge.tsx` 的 `const direction` 一行，C2 换成 hook）、簇色、只在子端画箭头、无常驻标签，选中时写「派发」并换 `--brand`。拖线预览（`ConnectionLine`）跟着 `linkCurve` 的缺省走就近边。
- 四边把手：`ConnectionHandles` 非 `dropOnly` 时挂 `top / right / bottom / left` 四个 source 把手，`aria-label` 统一 `node.linkHandle`「连线」/ "Link"（删 `node.linkIn / linkOut`）；`nodes.css` 补上下定位，命中区往节点外偏。
- 簇色：新模块 `canvas/family.ts`，`familyOf(document)` 只取 `supervises` 边按「先到的赢」建森林，根按 id 排序取 `--node-color-${i % 7 + 1}`，树上全员同色；不在树上的 Agent 用 `agentColorVar`；其余按类型 `--mm-*`（新 token，两套主题，`tokens.css` / `tokens.test.ts`）。`currentFamilies` 按 `nodes / edges` 引用缓存，`useFamilyColor(nodeId)` / `useFamilies()` 给 LinkEdge 与小地图共用。
- 小地图：填充按家族色 55%（选中 80%、分组 35%）；描边仍是三种状态色，派发簇成员无状态时描边用簇色。
- Dock：缩放段改 `[−] [NN%] [+]`（`ZoomControls`），−/+ 调 `zoomByStep(∓1)`，Tooltip 带当前键位，到 `MIN_ZOOM / MAX_ZOOM` 禁用；百分比钮单击适应、右键档位扩到 25 / 50 / 75 / 100 / 150 / 200%。
- 设计系统 §4 连线两行改为对等 / 派发、把手改四边、加小地图与 Dock 缩放两行；§2 补 `--mm-*` 表。展示页画布分区加「两簇 + 独立 Agent + 便签」固定状态与同色小地图。

实测（macOS arm64，基于 main 20248839）：

- web：`context-links.test.ts`（三种边的 role、改主从后需重推）、`family.test.ts`、`Minimap.test.tsx`、`LinkEdge.test.tsx`（派发无标签、选中「派发」、簇色、纵向底→顶）、`link-visual / link-path / geometry.test.ts`、`ConnectionHandles.test.tsx`（四个 `data-side`）、`Dock.test.tsx`（−/+ 调 `zoomByStep`、边界禁用）、`tokens.test.ts`、`client.agents.test.ts`（`role` 穿过客户端）；shared `api-agents.test.ts`（schema 收 / 拒 role）；desktop `collab/roles.test.ts` 加「页面推 main/sub 后 `send` 的 `UPWARD_SEND_REFUSED` 跟着变、推回 peer 后放行」。
- `design-showcase.mjs --only=canvas` 深浅两主题 × 三宽全过（对比度、减少动效静止、无控制台 error）。
- `pnpm libs:build && pnpm -r --if-present test` 全过（web 4053、desktop 5344 / 74 跳、shared 372、server 98 / 4 跳）；web typecheck、`pnpm check` 通过。另改了 `context-link-publication.test.ts` 三处期望：节点链接现在带 `role: "peer"`，属行为变化本身。

没做 / 偏离：

- 动了边界外的四处：`packages/shared/src/api/agents.ts`（`contextLinkSchema.role`，不加它页面带上的 role 会在客户端被剥掉，修复不成立；契约 §39.4 早已写 `role?: string`，`contract:check` 无变化）与它的测试、`api/client.agents.test.ts`、`nodes/NodeShell.test.tsx`（把手数 2 → 4）、`showcase/{fixtures,sections}/canvas.*`（§5.4 要求的固定状态）。
- 契约不改：§50 的「页面推送链接文档带 role」行为说明按预分配由 C2 写。
- 布局方向仍是常量 `vertical`；横向锚、方向设置与放置在 C2。

接口：

- 页面：`familyOf(document) → Map<nodeId, { kind: "cluster" | "agent" | "type", rootId?, color }>`、`currentFamilies`、`useFamilyColor(nodeId)`、`useFamilies()`、`clusterColor(i)`；`LinkAnchor`；`linkCurve(source, target, anchor?)`；`linkView(source, target, sourceType?, targetType?, role?, anchor?)`，`LinkView.labelKey: string | null`；`edgeLabelKey(sourceType?, targetType?, role?) → string | null`；`DISPATCH_LABEL_KEY`；`minimapItemOf(node, glowOf, families?)`，`MinimapItem.color? / cluster?`；`ZoomControls`、`ZOOM_STEPS`。
- 共享：`ContextLink.role?: "peer" | "main" | "sub"`。协议号、数据库不变。
- 文案：`edge.role.dispatch`、`node.linkHandle`（删 `node.linkIn / node.linkOut`），`edge.context` 改「上下文」/ "Context"。
- token：`--mm-sticky / editor / files / browser / diff / automation / group`。

## 设置框架：弹窗随窗口变大、8 组导航与作用范围（界面第二波 §1、§2.1–§2.3，包 A）

做了什么：

- 弹窗尺寸：`--settings-dialog-w: max(760px, 80vw)`、`-h: max(560px, 82dvh)`，不再封顶（1280 → 1024、1920 → 1536、2560 → 2048），外层仍夹视口 −48 与安全区；导航 `clamp(176px, 16%, 240px)`；正文列去掉 `max-w-[960px]`。DS §2.7 同步。
- 导航（`panels/settings/nav.ts`）：8 组 21 行（设计表里的 18 页 + 浏览器 / 账号与共享 / 关于三个随壳显隐的页）；每页带 `scope: device / host / account`，`ownerOnly` 只在 `host` 页；`remoteAccess` 标 `pinnedLocal`。`LEGACY_SECTION_IDS` 把 11 个旧 id 映射到新页，`isSettingsSectionId` / `activeSectionId` 先映射再判断；`setLastSettingsSection` 的调用方改成新 id（`usage`、`service`、`forge`、`agents`、`remoteAccess`）。
- 页头右端作用范围徽标（`settings/scope-badge.tsx`）：本设备 / 主机 / 账号，远程源带源名（`主机 · {name}`），远程访问页恒为「本机」；行内与页不同的项用同一枚小徽标（默认页的「Agent 默认视图」、通知页的「更新下载完成」）。
- `pages/index.ts` 的 `SECTION_PAGES` 注册表；B 的新页先指向现有页：`agents` → 集成页，`customAgents / sessions / credentials` → Agent 页，`usage` → 账号与用量页，`workspace` = 工作区页 + 实时协同，`service` = 后台服务 + 终端会话策略 + 数据 + 崩溃上报（成员只见后台服务），`machines` = SSH + 执行主机（子页开着时只画推入它的那一段），`forge` / `remoteAccess` / `devices` / `security` 各指原页。
- 新页 / 改页：`DefaultsPage`（Agent 默认视图、默认 Agent、默认权限、简洁模式、主题、语言；默认相关代码从 `AgentPage` 搬来）；通用页只剩本设备五项（「显示用量」改叫「用量徽标」，崩溃上报导出为 `CrashReportGroup` 挂到本机服务）；通知页加「更新下载完成」；白板页改名「画布」，实时协同移走；`TerminalLookPage` 四组（字体 `Select` 列本机探测到的等宽字体 / 跟随系统 / 自定义字体栈，字号·行高·字距一行，预览，光标，键盘，渲染），`TerminalPage` 只留会话策略与电源资源；快捷键页对成员开放（只写本设备层，不读写主机设置）；`UpdatesPage` 并入 `AboutPage` 后删除，版本只出现一次，成员与远端只读报版本。
- `terminal/surface/fonts.ts`：候选名单 + `document.fonts.check` + canvas 比对（`monospace` 与 `serif` 两种兜底画同一串等宽才算装了，避免把恰是系统等宽回退的字体误判；`iiii` 与 `MMMM` 等宽才算等宽）；桌面壳里并入 `queryLocalFonts` 的 `family`；模块级缓存，>300ms 才画骨架。
- 探针：`design-showcase.mjs` 加 `--width=1280,1920,2560`（不进默认矩阵），`components` 分区在每个宽度打开真设置弹窗量宽度并两主题截图；`remote-e2e` / `server-e2e` / `link-join` / `personal-roundtrip` / `relay-web-e2e` / `gateway-e2e` / `ui-features/integration` 的导航文字改成新页名。
- 设计文档进仓库：`docs/design/ui-wave2.md`，登记 `docs/README.md`。

实测（macOS arm64，基于 main 20248839）：

- 新增 / 改写：`nav.test.ts`（顺序、分组、scope、ownerOnly 只在主机页、旧 id 映射、成员 / 远程可见性）、`SettingsDialog.test.tsx`（尺寸 class、页头徽标、旧 id 落新页）、`pages/index.test.tsx`、`DefaultsPage` / `NotificationsPage` / `WhiteboardPage` / `TerminalLookPage` / `GeneralPage` / `AboutPage` / `KeybindingsPage`（成员）测试、`fonts.test.ts`。
- `design-showcase.mjs --only=components --width=1280,1920,2560,390`：弹窗宽 1024 / 1536 / 2048 与 80vw 相符，导航 176 / 240 / 240，两主题截图、Tab 可达、对比度与控制台全过。
- 全量 `pnpm libs:build && pnpm -r --if-present test`、web typecheck、`pnpm check` 通过。

没做 / 偏离：

- §2.4 只做到设计写的范围；§2.5–§2.7（Agent CLI 主表与子页、远程机器合表、远程访问页）是包 B。过渡期同一现有页会出现在几个新导航项下（例如 Agent 页同时在自定义 Agent / 会话 / 凭据下），B 拆页后消失。
- 18 页 vs 21 行：设计 §2.1 表本身列了 21 个 id，测试按表断言。
- 字体探测用 `queryLocalFonts` 的 `family` 而不是 `fullName`：写进 `font-family` 的是族名。
- 页名键统一放在 `i18n/modals.ts` 的 `settings.section.*`，没有用设计里 B 的 `agents.nav`；原 `*.nav` 键（集成、后台服务、远程服务、Git 托管、SSH、执行主机、安全、账号与共享）没人引用后删除。`acp.settings.defaultDriver` 文案改为「Agent 默认视图」。
- 配对链接 `#pair=` 现在打开到 `service`（后台服务那段所在页）；B 若把配对移到远程访问 / 设备页，要同步 `use-link-fragments.ts`。

接口：

- `nav.ts`：`SettingsScope`、`SettingsSection.scope / pinnedLocal`、`LEGACY_SECTION_IDS`、`canonicalSectionId`、`activeSectionId`；`pages/index.ts`：`SECTION_PAGES`（B 只改自己那些行）；`scope-badge.tsx`：`ScopeBadge`、`useScopeLabel`；`useRuntimeSettings({ enabled })`；`GeneralPage.tsx` 导出 `CrashReportGroup`；`AboutPage.tsx` 导出 `UpdateStatusRows / UpdateStatusNotes / loadThirdPartyNotices`；`fonts.ts`：`MONOSPACE_CANDIDATES`、`filterMonospace`、`detectMonospaceFonts`、`useMonospaceFonts`；偏好 `TERMINAL_LETTER_SPACING_RANGE`。
- 文案：`settings.group.*`（8 组）、`settings.section.*`（21 页）、`settings.scope.*`（6 个）、`terminal.settings.{fontSystem,fontCustom,fontStack,letterSpacing,preview,previewSample,group.*}`。契约、协议号、数据库都不变。

## 布局方向、删向导与派生直接建从、上下文线专用色（界面第二波 §4 §6，契约 §50，包 C2）

用户报：画布只能横着排、主不居中于从；「新建 Agent…」向导多一步；「派生」还要再开向导；拖线到空白什么都不发生。另加一条硬性要求：上下文线与派发线作用不同，必须用明显不同的颜色。

做了什么：

- 设置键 `canvas.layoutDirection`（主机设置，`vertical | horizontal`，缺省纵向）：两份 `completion-settings.ts` 加 `LAYOUT_DIRECTION_CHOICES` 与缺省，shared zod schema 与 core `normalize` / `completionSettings` 同步（坏值退回纵向）。设置 → 画布加一行「布局方向」`Select`（`canvas/LayoutDirectionRow.tsx`，包 A 已合入，按设计只加这一行）。
- 共享纯函数 `dispatchPlacement(boxes, parentId, size, direction, childIds)`（`packages/shared/src/domain/placement.ts`）：纵向从排在主下一行、接在已有从的右边；横向排在主右侧一列、接在已有从的下面；包围盒相交就沿行 / 列让一格，64 次后放到最下 / 最右。core `board.ts::placement(document, callerId, direction = 设置)` 改用它（只和同一分组里的兄弟比，未知尺寸按 960×600）；`team` 成员依次排成一行，`--gather` 汇总节点在下一行居中。
- 整理：`tidy.ts` 的 `layoutTree` 改成主轴 / 交叉轴通用，自底向上算子树跨度，父块居中于子块（附件计入宿主块：纵向在右侧同一行、横向在正下方）；`TidyOptions.direction`，缺省纵向。`canvas.tidy` 读当前方向；Dock 整理钮右键「纵向整理 / 横向整理」一次性覆盖、不写设置（`tidyInDirection`）。
- `canvas/layout-direction.ts`：小 store + `useLayoutDirectionSync()`（画布挂一次，从设置查询同步）+ `useLayoutDirection()` / `layoutDirection()`。`LinkEdge` 里 C1 留的 `const direction = "vertical"` 换成 hook。
- 删向导：`add.newAgent` 项、`NewAgentWizard`（含测试）、`wizard-open.ts`、展示页 `wizard` 分区与夹具、`wizard.*` 文案；`WizardInstallButton` 改用 `integration.action.install` / `acp.message.copied`。简洁模式的新建菜单改留各 Agent（`add.agent.*`）+ 便签 / 文字 / 画框。
- 派生直接建从：`add-menu.ts` 加 `spawnSubordinate(agent, parentId, anchor?)`（`beginCoalesce("canvas.spawn")` 里建节点 + `supervises` 边，按布局方向放或以落点为中心，继承父的权限模式（这家支持时）与分组，撤销一次全回）与 `buildSpawnItems`；节点右键「派生」变一层子菜单（`NodeMenuItem.children`，`node-menu.tsx` 渲染 `ContextMenuSub`），与父同一家排第一，没有可用 Agent 时整项置灰。
- 拖线建从：`canvas/flow/use-connect-end.tsx`，从 Agent 节点把手拖到空白松手，在落点弹 `AddMenuContent` 的「派发」形态（顶上「派发自 @名字」，只列各 Agent），选中在落点建从；非 Agent 起笔、落到节点上、没有可用 Agent 时不弹。
- 上下文线专用色（用户新增硬性要求）：新 token `--link-context`（深 `#ff5fb8` / 浅 `#c2187a`，色相约 326°，对画布底 6.3 / 5.7:1）；派发簇色从七色改为五色 `CLUSTER_PALETTE = [1, 2, 3, 6, 7]`（去掉红与紫，与品红至少隔 68°）。`link-visual.ts::linkColor` 画布与小地图共用；小地图现在画出连线（中心连中心、1.5px 不随缩放，上下文线品红、派发线簇色）。展示页簇色状态加一条跨簇上下文线。
- 契约 §50（布局方向设置、放置规则、谁遵循、链接文档带 role 的行为说明）；设计系统 §5.3 改为「派生与拖线建从」（节号保留），§2 补 `--link-context`，§4 对等线、派发线、小地图三行更新并加「Dock 整理」一行。

实测（macOS arm64，基于 main 019ad14d，合入 main 368d1bb9 后复跑）：

- `pnpm libs:build && pnpm -r --if-present test` 全过（web 4107、desktop 5349 / 67 跳、shared 380、server 98 / 4 跳）；web typecheck、`pnpm check` 通过。
- 新增 / 改动的测试：shared `domain-placement.test.ts`（两方向各三条含冲突）、`api-settings.test.ts`；desktop `completion-settings.test.ts`、`collab/control.test.ts`（open-terminal 纵向在下、横向在右、两节点同一行、`team` 成员同一行 x 递增 + 汇总下一行居中）；web `tidy.test.ts`（两方向一主三从居中、三层、两树、附件、两方向幂等）、`tidy-flow.test.ts`、`menus/spawn.test.ts`（建从 + 撤销、第二个接右边、横向、落点、继承权限）、`terminal-menu.test.ts`（子菜单项、置灰）、`use-connect-end.test.tsx`、`add-menu.test.ts`（无 `add.newAgent`）、`simple-mode.test.ts`、`Dock.test.tsx`（整理右键覆盖后复原）、`WhiteboardPage.test.tsx`、`link-visual / LinkEdge / Minimap / family / tokens.test.ts`（`--link-context` 两主题对比度 ≥ 3、与五个簇色及品牌蓝色相 ≥ 60°）。
- `tools/probes/canvas-tidy.mjs`（真 core + Vite + 无头 Chrome，隔离数据目录与 HOME）全过：子在主下面同一行、主中线 1010 对子块中线 1004、浏览器在所连子右侧同一行、幂等、撤销。探针原先在实时连接起来之前就判「可写」，偶发把 `setEdgeRole` 冲掉，已改成等实时连接可写。
- 临时探针（同样隔离，PATH 上放假 `claude` / `codex`）在真页面里用 CDP 鼠标验证：右键「派生」子菜单列出各家且父那家排第一，选 Codex 后多一个节点与一条派发边、放在主下方，撤销一次全回；从主把手拖到空白弹「派发自 @main」，选中后在落点建从。
- `design-showcase.mjs --only=canvas` 深浅两主题过（对比度、减少动效、无控制台 error），截图里上下文线品红、派发线簇色，小地图同样分色。

没做 / 偏离：

- 边界外改动：`agent/launch.ts`（加 `agentRegistry()`，菜单工厂要同步拿 Agent 列表）、`canvas/menus/node-menu.tsx`（注册项支持一层 `children`）、`acp/simple-mode.ts`、`canvas/whiteboard/tools/ToolLayer.tsx` 与 `showcase/ShowcaseApp.tsx`（删向导的挂载点）、`acp/adapter-install.test.tsx`、`i18n/integration.ts`（删不再引用的 `integration.wizard.spawnTitle`）、`store/canvas/types.ts`（`arrangeNodes` 收 `direction`）、`apps/web/src/api/settings.ts`（PATCH 类型）、`tools/probes/canvas-tidy.mjs`；用户授权范围内改了 C1 的 `link-visual.ts`、`family.ts`、`tokens.css`，以及 `LinkEdge.tsx` 的颜色几行与 `Minimap.tsx`。
- 协议号仍 1.23（契约 §50 写「自 1.24 起」，由最后合入的包统一改）；无数据库迁移。
- 共享画布的成员读不了主机设置（`settings.get` 403），画布按缺省纵向、设置页不摆「布局方向」一行；core 侧放置照旧按主机设置。CI 的 `server-e2e`「成员打开共享画布没有任何 403」第一次就抓到了这一条，已修并本地复跑通过。
- 浅色主题下黄色簇（`--node-color-3`）在白底上偏淡，是节点调色板本身的取值，本包没改。

接口：

- 共享：`LAYOUT_DIRECTION_CHOICES`、`LayoutDirection`、`DEFAULT_LAYOUT_DIRECTION`、`dispatchPlacement`、`PlacementBox`、`PLACEMENT_ROW_GAP / COLUMN_GAP / ATTEMPTS`；`CompletionSettings.canvas.layoutDirection`。
- core：`placement(document, callerId, direction?)`、`layoutDirection()`、`NODE_FALLBACK_HEIGHT`。
- 页面：`TidyOptions.direction`；`layoutDirection()`、`useLayoutDirection()`、`useLayoutDirectionSync()`、`tidyInDirection()`、`layoutDirectionOf()`；`spawnSubordinate`、`spawnPosition`、`buildSpawnItems`、`SpawnMenuItem`；`AddMenuContent` 的 `spawnFrom`；`NodeMenuItem.children / hint`；`useConnectEndSpawn`、`spawnSourceOf`；`linkColor`、`LINK_CONTEXT_COLOR`；`CLUSTER_PALETTE`；`minimapLinksFrom`、`MINIMAP_LINK_WIDTH`；`TidyButton`；`LayoutDirectionRow`。
- 文案：`node.menu.spawn`、`node.menu.spawnFrom`（删 `node.menu.spawnAgent`、`wizard.*`、`integration.wizard.spawnTitle`）；`canvas.tidyVertical / tidyHorizontal`、`canvas.layoutDirection(.vertical / .horizontal)`。
- token：`--link-context`。

## 注入只用 armadra 命名、清理不再认旧名（2026-10-09）

用户要求：注入的 Hook 等一律用本产品独立的名称，不和别的工具混淆，也不兼容旧别名。

做了什么：

- 盘点：交给 CLI 的名字已全部以 `armadra` 开头——Hook 程序 `armadra-hook`、技能 `armadra`、插件清单 `armadra`、状态模块 `armadra-status.*`（导出 `ArmadraStatus`）、Copilot `armadra.instructions.md`、MCP 服务器 `armadra`、环境变量 `ARMADRA_*`、备份后缀 `.armadra-backup-*`、`armadra-launch.exe`。不需要改名，因此也没有要迁移的旧 armadra 条目。清单写进契约 §13.5。
- `repair.ts`：删掉改名前旧名的识别（Hook 客户端、`…:skills` 指令块、两个旧技能目录）；Copilot 只看我们写过的 `hooks/armadra.json`，状态模块只看 `armadra-status.ts` / `.js`，同目录的其他文件不再打开。
- `integration.ts`：早期迁移记录里的旧名技能目录路径随之不再出现在 `migration`。
- 测试：`inject.test.ts`「our names」对每个 CLI 生成产物，断言每个文件与目录名（CLI 规定的除外）、技能 `name`、插件 `name`、每条 Hook 命令的程序、Codex `-c hooks.*` 的程序都以 `armadra` 开头，我们设的环境变量以 `ARMADRA_` 开头，MCP 服务器名同样；`repair.test.ts`「entries under the former name」在六种 CLI 的每个扫描位置放与旧名同名的条目（以及调用我们客户端的他人文件），断言不列、不改、不删、不备份、字节不变。web 夹具与 `ui-features/integration.mjs` 改用 armadra 命名，探针多一条与旧名同名的命令，断言弹层不列、清理后保留。
- 文档：契约 §13.5（新增）、§39.1，`design/agent-integration.md` §4 / §7，`guides/agent-collaboration.md`。

实测（macOS arm64，基于 main f2f1d18b）：

- `pnpm libs:build && pnpm -r --if-present test` 全过（web 4027、desktop 5342 / 74 跳、shared 372、server 98 / 4 跳）；web / desktop typecheck、`pnpm check` 通过。
- `ui-features-e2e --only=integration` 通过（临时 HOME 与数据目录）。

没做 / 偏离：

- MCP 与 ama 的工具名（`canvas_post`、`browser_click` 等）不改：它们在 `armadra` 服务器的命名空间下，各 CLI 显示为该服务器的一组；改名会改动词表与契约。
- `run/<cli>`、`shims/<cli>` 必须与 CLI 同名才能接管启动，只在数据目录里，不进 CLI 配置。
- 用户机器上旧名的残留不再由「清理旧版」处理，需要时用户手动删除。

接口：

- core：`OWN_SKILL_DIRS` 只剩三个 armadra 目录；`isOwnCommand` 只认 `armadra-hook`。形状不变，契约 §13.5 新增、§39.1 改写。

## 设置拆页：Agent CLI、主机、远程访问与账号各页（界面第二波 §2.5–§2.7，包 B）

做了什么：

- `pages/index.ts` 的 `SECTION_PAGES` 一页一个组件，A 留的过渡指向与 `stack()` 删除。删掉 `AgentPage`、`IntegrationPage`、`TerminalPage`、`HostPage`、`SshPage`、`ExecutionHostsPage`、`DataPage`；`GithubPage → ForgePage`、`AccountPage → UsagePage`、`RemoteServicesPage → RemoteAccessPage`、`execution-hosts/FleetGroup → MachinesTable` 改名。
- Agent CLI（`AgentsPage` + `AgentDetailPage`，共用件在 `pages/integration/parts.tsx`）：一家一行，状态只在不正常时一枚 `Badge outline`（需安装 / 需更新 / 已禁用，`agentState()`），能用的视图（都不能用写「—」），主动作（安装 / 更新 = 重新生成 / 三态 `Select`）；点名称推入子页 `cli:<id>`（`subpage.ts` 加 `cli` 类，页头是 CLI 名）：启动（三态、启动命令，行尾「本设备」）· 安装（CLI、ACP）· 画布注入（Hook 与技能 + 重新生成；`legacy.found` 非空时 `outline`「清理旧版 N」弹层清单，沿用现有键，不再红色）· 在画布中创建 Agent · 本地历史。自定义条目不在这一页。页首「Worker 待升级」删掉（功能在远程机器页）。
- 自定义 Agent（`CustomAgentsPage`，原 Agent 页的列表与子页表单）、会话（`SessionsPage`：自动命名带「本设备」、索引范围、已索引条数与重建）、凭据与密钥（`CredentialsPage`：节点凭据、模型密钥、Copilot 登录）、用量与额度（`UsagePage` 去掉 Copilot 登录）。
- 工作空间：执行权限 · 运行主机 + 切换（子页 `executionHosts:switch` 从执行主机页移来）· 默认 Agent · 语言服务 · 实时协同。
- 本机服务（`ServicePage`）：连接一行（打开即查一次，ID / 进程 / 能力折进 `Collapsible`「诊断」）；终端会话、电源与资源、数据（目录、大小、备份、日志保留）、崩溃上报只给 owner。
- 远程机器（`MachinesPage`）：SSH 主机与执行主机合成一张 `Table`（窄屏 `Item`）：名称 · 地址 · Worker（版本 / `destructive` 过期 / `outline` 未配置）· 工作区数 ·「验证」（一步问完 ssh 与 Worker）；点名称进子页：连接参数、Worker 重新同步、在那台机器上打开项目、主机密钥、健康记录表；表尾添加、全部重新同步（两台以上）、导入 / 导出（对话框）。
- 远程访问（`RemoteAccessPage`）：「让别的设备访问本机」一张卡：局域网直连（Gateway 开关、监听、证书、配对码，`GatewayConfigSection`）+ 经中转（每个登录着的中转账号一个分享开关与分享链接；没有账号时动作是「添加中转账号」）；中转账号（有账号才出现）；我连接的其他 Armadra。术语：「远程服务」→「中转账号」、「已挂载的源」→「我连接的其他 Armadra」、「挂载」→「连接」、对外服务开关叫「局域网直连」。
- 设备与会话（`DevicesPage`）：CA 引导、设备登录（打开即查连接，失败一句原因 + 检查连接）、已配对设备（`GatewayDevicesSection`）、登录会话（`security/LoginSessions`）；账号与安全去掉会话一组。`#pair=` 打开到 `devices`（`use-link-fragments.ts`）；自动化 / Git 托管面板「前往设置」没配对时去 `devices`，其余去 `service`；「前往设置 → 连接 / Git 托管」等旧指引改成新页名。
- 探针：`gateway-e2e` 开关与二维码改在远程访问页找（`局域网直连`）、设备表在设备与会话页；`remote-e2e` 打开远程项目与重新同步先点进机器子页、切换主机走工作空间页；`link-join` / `relay-web-e2e` 分享开关叫「经中转」；`forge-panel` 引 `ForgePage`。DS §5.15 改写为 Agent CLI 与远程机器；架构、客户端平台、服务器部署指南里的页名同步。

实测（macOS arm64，基于 main 368d1bb9）：

- 新增 / 改写测试：`AgentsPage`（主表状态与动作、子页三组、清理清单分组计数、迁移提示一次、启动器受限、ACP 随 CLI、代装 CLI）、`MachinesPage`、`WorkspacePage`（切换的阻塞项、草稿、已停止提示）、`ServicePage`、`DevicesPage`（配对链接自查与重试、局域网直连开关与二维码、设备撤销、成员只读）、`SessionsPage`、`CustomAgentsPage`、`CredentialsPage`、`security/LoginSessions`、`RemoteAccessPage`（三段结构）、`SettingsDialog`（Agent CLI 主表三态、子页、更新、清理）、`index.test`（每页挂组件且不共用）。
- 隔离 `ARMADRA_DATA_DIR` + 临时 HOME + `ARMADRA_NO_GLOBAL_WRITES=1` 起 core 与 Vite，内置浏览器 1280 / 1920 / 390、明暗看过 Agent CLI 主表与子页、本机服务、远程机器（表与子页）、远程访问、设备与会话；`design-showcase.mjs --only=integration,gateway --width=1280,1920,390` 两主题、对比度、控制台全过。
- `pnpm check`、web typecheck、全量 `pnpm libs:build && pnpm -r --if-present test` 通过。

没做 / 偏离：

- 子页「画布注入」组里那一行叫「Hook 与技能」，不与组名重复；`agents.state.ready`、`agents.nav` 没加（正常不画徽标、页名用 `settings.section.agents`）。「清理旧版」沿用 `integration.action.repair` / `integration.repair`，没新造 `cleanupLegacy` 键。
- 「检查连接」去掉了「取消」（打开页面自动查一次）。
- 远程访问页「经中转」是每个中转账号一个开关，不是一个总开关（分享本身按账号登记）。
- 改了包 B 边界外的几处，都是删页的直接后果：`subpage.ts`（`cli` 类）、`SettingsDialog.test.tsx`、`showcase/sections/gateway.tsx`、`use-link-fragments.ts`+test、`AutomationDrawer.tsx` / `GithubDrawer.tsx`+test 的去向、`i18n/{modals,automation,github,forge}.ts` 删无人引用的键与改旧页名指引、上面列的探针与指南。未改 core。

接口：

- `AgentsPage.tsx`：`agentState`、`AgentRow`；`AgentDetailPage.tsx`：`AgentModeSelect`；`integration/parts.tsx`：`useIntegrationActions`、`useMigrationNotice`、`CleanupButton`、`injectionProblem`、`historyValue`、`canvasAgentsValue`；`MachinesPage.tsx`：`machineRows`、`executionHostLabel`、`EXECUTION_HOSTS_KEY`、`parseHostForm`；`execution-hosts/MachinesTable.tsx`：`MachinesTable`、`HealthTable`；`gateway/GatewaySection.tsx`：`GatewayConfigSection({ extra })`、`GatewayDevicesSection`；`GatewayPanel` 去掉设备表 props、加 `extra`；`RemoteShareSection` 加 `label`；`SessionsPage.tsx`：`DATA_INFO_KEY`；`ServicePage.tsx`：`ConnectionGroup`；`security/LoginSessions.tsx`。契约、协议号、数据库都不变。

## ACP 创建提速：先显示可先输入、阶段提示、60 s 截止、预启动与预热（界面第二波 §7，契约 §51，包 D）

用户报：右键创建 ACP Agent 很慢，节点出来后一直是骨架屏、输入框禁用。调查（`_shared/acp-create-latency.md`）：core 自己的链路约 14 ms；时间在适配器的 `session/new`（同步跑完 CLI 启动，含用户的 SessionStart hook 与账号探测），页面又要等它返回才让输入；`session/new` 也没有截止时间。

做了什么：

- **core 阶段与计时**（`core/acp/host.ts`）：`startAcp` 每阶段开始时报 `onPhase`（spawn / initialize / session / configure），结束时报 `onTimings`（各段毫秒、`prestarted`）；`session/new` 带 60 s 截止（`SESSION_NEW_TIMEOUT_MS`），超时答 `acp_session_timeout`（HTTP 504）并收掉进程。`startAdapter` 拆出 `adapterStartOptions`，预启动按同一份程序 / argv / 环境起。
- **事件与日志**（`core/acp/index.ts`）：阶段发成 `acp.starting { nodeId, phase, at }`；每次起会话记 info 日志 `ACP session start timings`（只有数字）；适配器 stderr 里 `[session/create] phase=<名> durationMs=<n>` 只取名字与数字记成 `ACP adapter phase`，正文仍不进日志。
- **接入包 E 的闸门**：本机 ACP 会话在 `startAdapter` 前 `launchGate().acquire({ agentId: base, configDir: configDirFor(base, env), nodeId })`，进入 `configure`（`session/new` 已答）或失败时 `release(nodeId)`。两个 Codex 同时起时第二个在第一个 `session/new` 答复之后才 spawn（用例里用假 `codex-acp` 验证）。
- **预启动**（新 `core/acp/prestart.ts`，`POST /api/acp/prestart { workspaceId, agentId }` → 204）：`(agentId, workspaceId)` 一个已 `initialize` 的进程，10 s 没领走就收；起会话时启动签名相同就领走，直接 `session/new`。回调经 `callbackRelay` 转接，领走时换成会话那一套。
- **预热**：`adapter-install.ts` 装好 / 升级成功后、core 空闲 10 s 后、预启动时发现适配器程序（路径 + mtime）换过，对每家已装适配器跑一次 `initialize` 并执行一次自带 CLI 的 `--version`（`bundledCli` 找 SDK 平台包里的 `claude`、`@openai/codex-<平台>` 里的原生程序）；串行、同一家同一份程序 10 分钟一次；Codex 也过闸门。`ARMADRA_ACP_WARMUP=0` 关空闲预热；vitest 与 `ARMADRA_NO_GLOBAL_WRITES=1`（探针）里不做——`agent-e2e-self-test` 断言探针 core 不替人起任何真 CLI。
- **页面**（`acp/SessionView.tsx`）：输入框只在断线或起会话失败时禁用；会话就绪前发的第一条先画成用户气泡，`createSession` 还没发出就随 `prompt` 一起发，已发出就等会话开好、镜像读到后经 `acp.prompt`（带 `clientTurnId`）发；骨架区上方一行 11px 阶段提示 + 12px Spinner，`session` 阶段超过 3 s 追加「首次启动较慢」；超时显示「启动超时」+「重试」。节点挂载时工作空间还没读到的，读到后再起会话（以前不会再起）。
- **菜单打开时预启动**：`acp/api.ts::usePrestartOnOpen(agents)`，`AddMenuContent.tsx` 加一行；只对默认 Agent、以 ACP 驱动、本机源。画布右键、Dock `+`、会话侧栏 `+` 与包 C2 的拖线到空白处菜单都经这份组件，打开即预启动；节点菜单的「派生」子菜单不经它，没接。
- 契约 §51（§14.2 错误码、§14.3 事件列表各加一句指向）；协议 minor 统一升到 24（`identity/protocol.ts`、`parity-identity.test.ts`、`http/rpc.test.ts`）；文案 `acp.starting.{spawn,initialize,session,configure,cold}`、`acp.error.timeout` 中英同步；`docs/guides/architecture.md`、`development.md`（`ARMADRA_ACP_WARMUP`）。

实测（macOS arm64，隔离 `ARMADRA_DATA_DIR` + 临时 HOME + `ARMADRA_NO_GLOBAL_WRITES=1`，无任何账号；Vite 开发页 + 无头 Chrome；从点下菜单里的 Agent 到「输入框可输入」/「会话就绪」，每家 4 次取后 3 次）：

| Agent                                                    | main 5059e4f2：可输入（= 就绪） | 本分支：可输入 | 本分支：就绪                                |
| -------------------------------------------------------- | ------------------------------- | -------------- | ------------------------------------------- |
| Claude（真 claude-agent-acp 0.88，临时 HOME）            | 650–700 ms                      | 160–180 ms     | 440–590 ms（领走预启动，`sessionMs` ≈ 257） |
| 假 Agent，`session/new` 慢 3 s（模拟 SessionStart hook） | 3320–3360 ms                    | 150–165 ms     | 3250–3275 ms                                |

- 「可输入」剩下的 ~160 ms 是建节点、懒加载会话视图（开发模式）；「就绪」仍取决于 CLI 自己的启动，预启动只省 spawn + `initialize`（Claude 约 180–200 ms）。core 日志里每次都有 `prestarted: true` 的 timings；空闲预热记了 claude 205 ms / `--version` 11 ms、codex 2175 ms / 18 ms（量的时候空闲预热在 `ARMADRA_NO_GLOBAL_WRITES=1` 下还开着；之后改为探针模式不预热，表里的「可输入 / 就绪」不靠它）。
- `acp-e2e.mjs` 全过，新增一步：会话视图挂出到输入框可聚焦 0 ms（≤ 200 ms），节点出现到可输入 316 ms。
- 新增用例：`host.test.ts`（四阶段按序、计时只有数字、`session/new` 不答 300 ms 后 `acp_session_timeout` 且进程被收、预启动进程不再 spawn / 协商且回调接上）、`prestart.test.ts`（签名与环境顺序无关、领走一次且幂等、签名不同不领、10 s 回收、起不来丢弃、`bundledCli`、预热节流与换文件重做、过闸门、`adapterPhases` 只取名字与数字、HTTP 预启动 → 领走只报 session / configure、注入按节点的不预启动、400 / 404、两个 Codex 过闸门串行）、web `SessionView.test.tsx`（起会话期间可输入可聚焦、阶段文字随事件变、首条等会话开好经 prompt 发、请求未发时随 `createSession.prompt` 发、首次启动较慢、启动超时）、`acp/api.test.ts`（默认 Agent 以 ACP 驱动才预启动、只一次、远程源与没有工作空间不调、失败不打扰）。
- `pnpm libs:build && pnpm -r --if-present test` 全过（web 4104、desktop 5385 / 67 跳、shared 372、server 98 / 4 跳）；合入 C2（#204）与 B（#205）后重跑 web 4131、desktop 5390 / 67 跳；web typecheck、`pnpm check` 通过。

没做 / 偏离：

- **预启动只给注入不靠节点身份的那几家**（适配器表 `injection.reuse` 为空：Claude、ama）。预启动时还没有节点，进程环境里没有 `ARMADRA_NODE_ID` 等；画布工具的身份随 `mcpServers` 走不受影响，但 Codex / OpenCode / Copilot / Pi 复用终端注入的环境或 argv，在 CLI 里按节点身份生效，领走会让它们的注入失效。这几家调 prestart 答 204、不起进程。节点带凭据或 SSH 节点不领。
- **`resolveCommand` / `agentPath` 的解析缓存没做**：实测 < 5 ms，而按 PATH + mtime 校验缓存要 stat 同样多的目录，省不下来；也避免与包 E 在 `registry.ts` 上冲突。
- 「`agents.list` 发现版本变化后预热」改为「预启动时发现适配器程序换过」触发（不改 `agent/routes.ts`）；安装 / 升级与空闲两条照做。
- `session/new` 的截止用 `Promise.race` + 收进程实现，没有给 `mcp.ts` 的 `sessionOpener` 加 signal；`session/load` / `resume` 不设截止（长会话回放可能合法地久）。
- 文件边界外的必要改动：`core/acp/client.ts`（错误码一行）、`core/bus.ts`（事件类型）、`packages/shared/src/api/events.ts`（事件进联合）、`core/http/routes.ts` / `route-scopes.ts` / `identity/route-access.ts`（新路由登记、`terminal:drive`、服务器壳按体里的工作空间判）、`docs/guides/*`。
- 真实账号下 Claude 的 hook / 插件与 Codex 的路由探测耗时没有测（隔离环境测不到）；用户机器上看 info 日志的 `ACP session start timings` 与 `ACP adapter phase` 即可定位。

接口：

- 契约 §51：事件 `acp.starting { nodeId, phase, at }`；`POST /api/acp/sessions` 新错误 504 `acp_session_timeout`；`POST /api/acp/prestart { workspaceId, agentId } → 204`（权限 `terminal:drive`）。
- core：`host.ts` 的 `SESSION_NEW_TIMEOUT_MS`、`AcpStartPhase`、`AcpStartTimings`、`AcpPrestarted`、`callbackRelay`、`adapterStartOptions`、`negotiate`、`ACP_CLIENT_INFO`，`AcpStartOptions.{sessionTimeoutMs,prestarted,onPhase,onTimings}`；`prestart.ts` 的 `AcpPrestartPool`（`key / prestart / claim / dispose / killAllSync`）、`launchSignature`、`spawnPrestarted`、`AcpWarmer`、`bundledCli`、`programFingerprint`、`adapterPhases`、`setAcpWarmer`、`warmAfterInstall`；`acp/index.ts::acpPrestartPool()`。
- 共享：`ACP_START_PHASES`、`acpStartPhaseSchema`、`acpStartingEventSchema`、`acpPrestartRequestSchema`。
- 页面：`acpApi.prestart(workspaceId, agentId)`、`usePrestartOnOpen(agents)`。

## nightly 37858782422 的三个失败作业（2026-10-09）

做了什么：

- **macOS 打包 `packaged-smoke`「Armadra serve 起来并打印配对链接」**（产品缺陷）：探针给 serve 的数据目录在 macOS 临时目录下，`<dataDir>/controller.sock` 105 字节，超出 `sun_path`（macOS 103、Linux 107 可用字节），`listen EINVAL` 让 `run()` 中途失败；失败路径先关了库，而终端启动对账、依赖与工作流扫描、ACP 空闲预热仍在跑，日志满是 `database is not open`，进程也不退出，探针等满 60 s。
  - `controller/channel.ts`：路径放不下时改落 `<tmpdir>/armadra-ctl-<数据目录哈希16位>/c.sock`，目录须是本用户的真目录且 0700，socket 0600；客户端只从 `endpoints.json` 读地址，无需改动。
  - `main.ts`：关停与启动失败走同一个 `teardown`——控制通道、运行、Gateway、中继、监听 → 各域经新增的 `CoreContext.onStop` 登记的收尾（逆序；一个失败记 warn 不拦后面）→ 实时板、语言服务 → 关库。登记的域：终端（等启动对账结束再 `shutdown`，对账期间开始关停就不再武装周期任务）、调度、依赖、工作流、资源、用量、模型目录、ACP（撤预热计时器、收预启动池）。
- **iOS XCUITest**（用例没跟上，外加时序）：#205 把「安全」分区改名为「账号与安全」，OAuth 深链之后的断言找不到；开屏动画盖在页面上且按下即跳过，用例的第一下点按被吞掉，30fps 动画还让慢模拟器上的无障碍快照超时。Debug 构建认启动参数 `-ArmadraUITest`，在文档开始前把 `armadra.splash.shown` 记进 `sessionStorage`，用例都带这个参数；断言改认「账号与安全 / Account & security」。
- **Android 插桩**：用例 a 在 CI 上报「Process crashed」，日志里 logcat 为空、插桩报告未上传，无法定位；本机 API 36 模拟器通过，分支上的 nightly 也通过（未改用例）。nightly 补传 `app/build/reports/androidTests/` 与 `outputs/androidTest-results/`（含逐条用例的 logcat），下次再崩能看到栈。

实测（macOS arm64，基于 main 8049c762）：

- 新增用例：`main.test.ts` 三条（启动失败先停域再关库、正常关停逆序且失败不拦、深数据目录照常起来并公布挪过去的地址；后者在修复前复现 `EINVAL`），`controller/channel.test.ts` 两条（路径选择、私有目录与权限）。
- `pnpm libs:build && pnpm -r --if-present test`：web 4131、desktop 5395 / 67 跳、shared 380、server 98 / 4 跳、mobile 10、push-relay 9 全过；live 配置的 `passkey-cdp.live.integration.test.ts` 在本机失败，基线 8049c762 同样失败，与本改动无关。desktop / server typecheck、`pnpm check` 通过。
- 本机 iOS 模拟器（Xcode 27、iPhone 18 Pro）跑 `mobile-shell-e2e --platform ios`：修复前两条都失败（点按被开屏吞掉；OAuth 后找不到「安全」），修复后两条通过；Android（API 36）通过。
- 分支 nightly 37882764862（ed31e6d2）：七个作业全绿，其中 macOS packaged-smoke 的 serve 五条、iOS 两条 XCUITest、Android 插桩都通过；常规 CI 37882759344 三平台与 e2e tier a 全绿。
- 中途一次常规 CI 暴露关停后迟到的退出通知：终端域现在会在关停时 `shutdown`，直连会话被结束后才报退出，此时库已关，`markExited` 抛错成了未处理的拒绝（server `roles.integration`）。现在关停期间库还开着就照常记 `exited`（保留 `survival.test` 的约定），库已关就作罢；`manager.test.ts` 补一条。

没做 / 偏离：

- 身份私有通道 `core-control.sock` 的路径桌面壳是按数据目录推出来的，这次没有挪；超长时它照旧只记 warn、不拖垮 core。
- Android 的 CI 崩溃没有根因，只补了诊断产物。

接口：

- core：`CoreContext.onStop?(stop)`（可选，只有 `run` 装配的 core 有）；`controllerSocketPath(dataDir)` 与 `maxSocketPath()` 导出。线上 JSON 形状不变。
- iOS：Debug 构建的启动参数 `-ArmadraUITest`（只关开屏动画）。

## 连线随两端位置换边（#211，2026-10-09）

做了什么：

- `canvas/geometry.ts`：`free` 锚改按两个矩形的**空隙**选轴——只在一条轴上分开就走那条轴相对的两条边，斜放时取空隙大的一轴，叠在一起才比中心。原先只比中心，宽节点斜下方挂小节点时会走左右，线先往回折。新增 `dispatchAnchor(source, target, direction)`：子整个在布局下游（纵向在主下方、横向在主右侧）时用布局方向，被拖到主的上方、左侧或与主并排时退回 `free`。
- `flow/edges/LinkEdge.tsx`：派发线的锚改由 `dispatchAnchor` 现算；对等线、引用线（`ReferenceEdge`）、拖线预览本来就走 `free`，一起受益。边仍读 `useInternalNode` 的矩形，不读把手坐标；`useInternalNode` 只订阅两端节点，拖一个节点时只有挂在它身上的边重算。
- 存储：边本来就只存 `source` / `target`，没有持久化把手；`canvasEdgeSchema` 是 zod 默认的 strip，旧数据若带 `sourceHandle` / `targetHandle` 读时丢掉。无迁移、无契约变化。
- 展示页「画布」加一块「连线随动」：主在中间，上、左、下三个从加右侧便签，四条线从主的四条边各出一条。
- `design-system.md` 连线两行改成新的选边规则。

实测（macOS arm64，基于 main ae520e9a）：

- 新增用例：`geometry.test.ts`（空隙选轴五条、`dispatchAnchor` 三条）、`link-path.test.ts`（目标绕一圈两端各换一次边、纵向 / 横向派发线被拖到上游后换边）、`LinkEdge.test.tsx`（派发线子在上方 / 并排时走就近边；原「纵向主底 → 子顶」用例把子挪到主下方，并排时按本 issue 应走左右）、新文件 `LinkEdge.drag.test.tsx`（受控 React Flow 里连续改节点位置：路径两端逐步换边；连拖三帧只为被拖节点那条线调用 `linkView`，另一条线一次不算；派发线拖上去再拖回来）、`use-flow-nodes.test.ts`（连线时不把把手写进边）、shared `domain/nodes.test.ts`（旧边带把手字段读时丢掉）。
- 展示页在开发服务器上看过：四条线分别从主的顶、左、底、右边中点出。

没做 / 偏离：

- 同侧多条派发线仍共用一个出点（设计 §3.2 的「自然扇出」），没有按条数分散锚点。

接口：

- `geometry.ts`：新增 `dispatchAnchor`；`facingSides` / `edgeGeometry` 签名不变，`free` 的选边规则变了（`horizontal` / `vertical` 仍是硬约束；`CanvasOverlays` 的子代理派生线用 `free`，一并按新规则选边）。

## Codex 启动不再打两行警告：会话层信任记录与内嵌模式（2026-10-09）

做了什么：

- 画布内的 Codex 启动时 TUI 打两条 Startup 警告：`--dangerously-bypass-hook-trust` 本身一条；有 `-c` 就退回内嵌模式，Codex 0.156 起又打一条「Running without the shared background server: command-line configuration overrides … requires embedded mode.」。
- `hook/install/inject.ts::codexArgs` 去掉旗标，改在同一层 `-c` 里带八个 Hook 的信任记录 `hooks.state={"<来源>:<event>:0:0"={trusted_hash="sha256:…"},…}`。Codex 从用户层与会话旗标层都读 `hooks.state`（0.134.0–0.162.0 源码一致），来源是会话层的合成路径 `/<session-flags>/config.toml`（Windows 为 `C:\<session-flags>\config.toml`，远端一律 POSIX）；哈希 `codexHookTrustHash` = `{event_name, hooks:[{type, command, timeout, async}]}` 按键排序的 JSON 的 SHA-256。每个 Hook 表写明超时（`SessionEnd` 1，其余 600，即今天的默认值），哈希不随各版本默认值变化。用户自己没审过的 Hook 不再被放行，画布内与画布外一样要审查。
- 加 `-c features.daemon_auto_start=false`：画布内的 Codex 本来就得内嵌（Hook 在会话所在进程里跑，接共享服务器就带不上节点的 `ARMADRA_NODE_ID`，`-c` 层也只属于这个进程），之前也是因 `-c` 走内嵌，启动路径不变、不变慢，并发仍由启动闸门（契约 §52）排队；关掉自启后不再打提示。旧版本只把认不出的 `features` 键记进日志，所以不按版本区分；没用 `--no-daemon`，因为 0.156 之前不认、远端又不探版本。
- 门槛常量改名 `CODEX_SESSION_HOOK_TRUST_MIN`（仍 0.134.0）、`codexTrustsSessionHooks`；`injectionFromLayout` 多 `windows` 选项，`remote.ts` 传 `false`。
- 文档：画布启动器 §7 重写、§2.1 / §5.2 / §13 / §14 / §15，画布内注入 §4，远端注入，契约 §13.2 示例，指南 agent-collaboration / architecture / local-cli-plugin（更正「0.159 `-c hooks.state` 无效」的说法），探针 README、场景 5 与 packaged-smoke 的断言和说明。

实测（macOS arm64，Codex 0.160.0，临时 `HOME` 与 `CODEX_HOME`，mock 模型提供方指向不可达地址，不登录）：

- `codex app-server <启动器的参数>` 的 `hooks/list`：八个 Hook 全是 `trusted`，`currentHash` 与 `codexHookTrustHash` 相同（两条答案写进 `inject.test.ts`）；不带信任记录时为 `untrusted`。
- 同样的参数起 TUI（node-pty）：启动后 0 条警告；提交一句话后 `SessionStart`、`UserPromptSubmit` 的 Hook 都跑了且带节点身份；`CODEX_HOME/config.toml` 前后字节相同。对照：旧参数启动即「2 warnings」。
- `pnpm libs:build && pnpm -r --if-present test`：web 4131、desktop 5390 / 74 跳、shared 380、server 98 / 4 跳、mobile 10、push-relay 9 全过；live 配置的 `passkey-cdp.live.integration.test.ts` 本机失败（与上一节同，和本改动无关），其后的 `node --test scripts/*.test.mjs` 单独跑 73 / 2 跳通过。desktop typecheck、`pnpm check` 通过。

没做 / 偏离：

- Windows 的来源键 `C:\<session-flags>\config.toml` 按 Codex 源码推出，没在 Windows 上对真 Codex 核过；不对时症状是画布内启动停在「Hooks need review」。
- 以后的 Codex 若改了信任哈希的组成，症状同上；用 `app-server` 的 `hooks/list` 对一次 `currentHash`（画布启动器 §7.2）。
- 场景 5（真 CLI、C 档）的断言已改，没有用真实账号跑。

接口：

- core：`CODEX_SESSION_HOOK_TRUST_MIN`、`codexTrustsSessionHooks`、`codexHookTrustHash(event, command, timeout?)`、`codexSessionKeySource(windows)`、`codexArgs(command, instructions?, hooks?, windows?)`；删 `CODEX_BYPASS_HOOK_TRUST`、`CODEX_HOOK_TRUST_BYPASS_MIN`、`codexBypassesTrust`。
- `GET /api/agents/codex/integration` 的 `launchArgs` 只变值：不再有 `--dangerously-bypass-hook-trust`，多 `features.daemon_auto_start=false` 与 `hooks.state=…`。线上 JSON 形状不变。

## Windows 验收保活后 5.1 无回显（nightly 37906434287，2026-10-09）

做了什么：

- 判断：探针时序问题，不是会话宿主缺陷。同一个 Windows PowerShell 5.1 会话在 `terminal.shells`（首条命令）和 `restart.survives`（重启后）都有回显；三种 shell 的输入走同一条原样写 ConPTY 的路径，cmd / pwsh 都过。只有「Ctrl+C 停循环 → 固定睡 2 秒 → 敲记号」不过：5.1 在忙的 runner 上回到提示符可以超过 2 秒，期间敲进去的字被 Ctrl+C 的输入缓冲清理吞掉。不改用户 shell 的启动参数。
- `windows-acceptance-lib.mjs`：页面助手 `terminal` 的 `waitFor` 支持 `{ quietMs }`（发完输入后等输出停够这么久，快照不算，每帧输出重计）；新增 `responsiveAfterLoop`：Ctrl+C 后等静 3 秒（不静再按一次），再敲记号，没回显整行重敲，最多 3 次、每次 20 秒。
- soak 的 detail 多了 `answers`：每个 shell 的敲了几次、怎么静下来的，失败时带输出尾巴。

实测：

- `windows-acceptance.test.mjs` 新增两条（等静与重敲、静默计时）。
- 分支上手动跑 nightly 两次（37911707342、37911747495），windows acceptance 都过，三个 shell 都是一次静下来、一次回显。

没做：

- 5.1 吞字的具体机制（conhost 的 Ctrl+C 处理还是 PSReadLine）没在真机上拆开验证；新 detail 下次再挂能直接看屏幕。

接口：无产品接口变化。

## 终端程序自报的状态：OSC 7501 与 OSC 9;4（契约 §53，2026-10-09）

做了什么：

- 规范核对：Program Status Protocol（OSC 7501）是 2026-10-06 公布的终端协议，规范修订 0.3（2026-10-07）。正文 `key=value` 以 `:` 分隔，`state` 为 `idle` / `working` / `blocked` / `done` / `error` / `clear`，另有 `kind`、`progress`、`app`、`id`（层级记录）、base64 的 `msg` / `title`；`OSC 7501 ; ?` 为特性查询。程序侧已发出的有 Claude Code 2.1.295（启动时先查询，DA1 当哨兵，收不到回应就不发）；Codex 只有原型，没有正式版本发出。
- core：`terminal/program-status.ts`（跨分片 OSC 扫描、tmux DCS 透传解包、规范级解析、记录表与生命周期、OSC 9;4 映射）、`program-status-book.ts`（每会话一份、查询回应、250 ms 节流、`connectProgramStatus` 接线）。后端新增可选的 `programTap`：direct 交 pty 的每次读；tmux 用 `pipe-pane -O` 把 pane 原始输出 `cat` 进数据目录 `program-taps/` 下的 FIFO（tmux 自己吞掉未知 OSC，实测 3.7c 连 OSC 9;4 也不转发），adopt 时重建、`list` 时收走；session-host 只读附着中的实时输出；SSH 装饰器转发。
- 事件 `terminal.program`（不进 outbox），会话列表加 `programStatus`；协议 minor 24 → 25。程序自报不写 `agent_status`、不进任何闸门，`msg` / `title` 不出 core。
- 页面：`agent/program-status-store.ts` 单独一张表与合并规则（活的上报优先，程序自报只补进度；没有上报时程序自报画节点头胶囊、光晕、小地图描边与离屏提醒）；节点头来源点新增 `program`；xterm 注册 7501 与 9;4 的处理器只吞不答；文案进 `i18n/agent.ts` 中英。
- 探针 `core-terminal-program-status`（A 档）：tmux 与 direct 各一遍，`printf` 序列断言事件流，读回查询的回应，tmux 下断开终端 socket 后用 `send-keys` 证明离屏也更新。

实测（macOS arm64，tmux 3.7c）：

- 新单测：解析器 23（分片到每个字节、非法序列、超长、透传、RIS、9;4、记录上限）、账本 6、manager 5、direct 1、tmux 2（真 tmux 的 FIFO 读取与 adopt 重接）、会话列表 1、页面合并与提醒 9、xterm 处理器 1。
- `pnpm libs:build && pnpm -r --if-present test`：web 4157、desktop 5435 / 67 跳、shared 382、server 98 / 4 跳、mobile 10、push-relay 9 全过；live 配置的 `passkey-cdp.live.integration.test.ts` 本机失败（同前几节，与本改动无关），`node --test scripts/*.test.mjs` 单独跑 73 / 2 跳通过。`pnpm check` 通过。
- `node tools/probes/core-terminal-program-status.mjs`：两种后端全过。
- 隔离数据目录与临时 HOME 起 core + 页面：终端里 `printf` 之后节点头出现「运行中 40%」与光晕、终端里无乱码；改报 `blocked` 后变「需要你」。

没做 / 偏离：

- tmux 后端下 Claude Code 2.1.295 仍不会发 7501：它把 DA1 当哨兵，而 tmux 即刻回答 DA1，core 经 pipe-pane 看到查询再回应必然晚一步。direct 后端下回应先于页面的 DA1，可以通过；没有用真实账号的 Claude Code 核实。Claude 节点的状态仍以 Hook 为准，不受影响。
- session-host（Windows）没有附着时读不到；回放帧不解析。
- 没有 OSC 133 的 shell 里，程序死掉之前没报 `done` / `error` 的话，`working` 会一直留到终端退出或下一条报告。
- 页面没有 Dock 状态色这一处（Dock 只有工具按钮），所以没有改。

接口：

- core：`ProgramTap { subscribe, answer }`（`TerminalBackend.programTap?`）、`TerminalManagerOptions.onProgramStatus`、`TerminalManager.programStatus(sessionId)`、`listSessions(..., program?)`、`OscScanner` / `parseProgramReport` / `ProgramStatusTracker` / `ProgramStatusBook` / `connectProgramStatus`、`TmuxProgramTap`。
- shared：`programStatusSchema` / `ProgramStatus`、`sessionSummarySchema.programStatus`、事件 `terminal.program`（`TerminalProgramEvent`）。
- web：`useProgramStatusStore`、`headerStateFor`、`programHeaderState`、`reportedLive`、`programNotificationStatus`、`registerProgramOsc`。

## 小地图收起钮悬停才显示、连线同画布锚点与曲线（#216，2026-10-09）

做了什么：

- 收起钮：拆出 `MinimapToggle`。展开时是缩略图右上角里的一个 24px「−」（`Minus`），平时 `opacity: 0` 且不接指针，悬停缩略图或钮本身、键盘 `focus-visible` 时出现（`styles/canvas.css`，用 `.react-flow__minimap:hover ~ .minimap-toggle-panel` 与 `.minimap-toggle-panel:hover`）；`(hover: none), (any-pointer: coarse)` 下常显。收起后原地是常显的带边框缩略图图标（`Map`），文案沿用 `canvas.expandMinimap` / `canvas.collapseMinimap`，无新文案。
- 连线：新文件 `flow/minimap-links.ts`。每条 `link` 边按画布同一套规则取锚（上下文线 `free`，派发线 `dispatchAnchor`，四边中点）、同一组 `bezierControls` 的三次贝塞尔，去掉箭头、标签、命中区与选中 / 闪动；颜色仍是 `linkColor`（`--link-context`、主的簇色）。所有边**按颜色合并**成几条 `<path>`（上下文一条、每个簇一条），坐标取整；线宽 = 画布线宽 ÷ 缩略图比例，夹在 1–1.5px（`vector-effect: non-scaling-stroke`）。
- 渲染：整层只挂一次——`<MiniMap>` 的 SVG 没有插槽，于是由第一个可见节点的 `nodeComponent` 在自己的矩形前面画（`firstMinimapNodeId`），连线压在全部节点下面。原来每个节点各订阅 `nodes` / `edges` / `nodeLookup` 并各画一组 `<line>`，现在只有这一处订阅。只在节点、边、簇色、布局方向变化时重算，拖动节点时按 60ms 节流（新 `lib/use-throttled-value.ts`，尾沿一定跟上），平移缩放视口不重算。
- 展示页「画布」：簇色样本的小地图右上角定格「−」悬停态（`reveal`），连线随动样本右下角放收起后的展开钮。`design-system.md` 小地图一行同步。

实测（macOS arm64，基于 main afc8daa3）：

- 新增用例：`minimap-links.test.ts`（曲线与画布 `linkCurve` 同点、四边中点、按颜色合并与先后、派发线子在下游 / 上游的锚、引用 / 隐藏 / 缺端点不画、无簇色退回品牌色、线宽比例与上下限、外接尺寸）、`use-throttled-value.test.ts`（冷却期只跟尾沿且是最新值、冷却后立刻跟）、`styles/canvas.test.ts`（展开钮默认隐藏不接指针，悬停缩略图 / 钮 / 聚焦 / 收起态显示，触屏常显）、`Minimap.test.tsx`（真 React Flow 里整层只一组、两条上下文线合成一条 path、没有 `<line>`、在第一个节点矩形之前；首节点隐藏时换下一个挂；无边不画；`−` / 缩略图图标两态）。
- 展示页在开发服务器上看过深浅两种主题：曲线从节点四边中点出，派发线簇色、上下文线品红；真实指针悬停缩略图时钮 `opacity` 变 1、可点，移开变回 0。

没做 / 偏离：

- 线宽的缩略图比例只按节点外接矩形估，不含视口框（为它在平移时逐帧重算不划算）；视口远大于节点时线比真实比例略粗，仍在 1.5px 上限内。

接口：

- `flow/minimap-links.ts`：`minimapLinkLayer`、`minimapLinkSegment`、`minimapLinkWidth`、`boxesExtent`、`MINIMAP_LINK_THROTTLE_MS` 等常量；`Minimap.tsx`：新增 `MinimapToggle`、`MinimapLinkLayer`、`firstMinimapNodeId`，删去 `minimapLinksFrom`、`MINIMAP_LINK_WIDTH`、`MinimapLink`；`lib/use-throttled-value.ts`：`useThrottledValue`。

## 性能包 P2：徽标可见性、内存压力与隐藏名额归还（A2 / A3 / A4，2026-10-09）

做了什么：

- A2：`useOnScreen(ref, enabled)`，effect 依赖 `[ref, enabled]`；`MemoryBadge` 传 `Boolean(sessionId)`。PTY 终端的会话 id 在 WS hello 之后才到，首帧徽标 `return null`，以前观察器永远没挂上，离屏降到 30 秒从未生效。
- A3 壳侧：`main/memory-pressure.ts` 每 15 秒异步探一次（macOS `sysctl kern.memorystatus_vm_pressure_level` 1/2/4；Linux `/proc/pressure/memory`，`some avg10 ≥ 10` 为 warning、`full avg10 ≥ 5` 为 critical，阈值是自定的；Windows `getSystemMemoryInfo` 空闲 < 10% / < 5%），升档立刻、降档连续两次才推 `memory:pressure { level }`，页面重载后补发非 normal 的当前档。preload 挂 `window.armadra.memory.onPressure`。
- A3 页面侧：`terminal/pressure-policy.ts`（纯函数 `decide` / `actionFor`，warning 还隐藏名额并释放离屏 ≥ 30 秒的实例，critical 释放全部不可见的，同档 20 秒节流，降回 normal 不动），`pressure-bus.ts`（壳与本机 `resource.sample` 两路取最高档，采样那一路 90 秒没报作废），`memory-pressure.ts`（壳事件进总线，诊断把手 `window.__armadraMemoryPressure.emit(level)` 供探针注入）。`sampling.ts` 只转发 `host.location === "local"` 的非空压力。渲染名额在第一个终端登记时订阅总线并 `releaseHidden()`。
- A4：`render-budget.ts` 隐藏持有者只暖 `RENDER_HIDDEN_RELEASE_MS = 30_000`，全表一个计时器挂在最早到期那条上；`Infinity` 即旧行为。

实测（macOS arm64，未打包壳，`_shared/perf-diag-20261009/bench/terminal-memory.mjs --repo <本 worktree>`，各跑 1 次）：

- `--terminals 5 --cadence-check`：`fresh-nodes-offscreen-60s` 的 `ps` 31 → 5（含跨平移那个 5 秒窗口里的 3 次；平移后稳态每 30 秒 1 次），`reloaded-offscreen-60s` 30 → 2，`reloaded-visible`（重载后视口仍停在离屏处）18 → 2；同步子进程 46.5–49.1 → 4.2–6.7 ms/s。
- `--terminals 20 --webgl --cycles 2`：GPU `offscreen-1m` / `offscreen-3m` 140 / 140 MiB（基线 3 分钟 317），回到视口 385 MiB，`data-render` 回到 visible 16 + offscreen 4。
- 单测：`pressure-policy` 8、`pressure-bus` 7、`memory-pressure`（页面）3、`render-budget` 新增 8、`MemoryBadge` 新增 1（不改实现时失败）、`sampling` 新增 1、`main/memory-pressure` 8。

没做 / 偏离：

- 前端实例的释放（`released`）是 P3 的事，这里只给总线；P3 订阅 `onMemoryPressure(level)`，按 `actionFor(level)` 自己算要释放谁。
- A4 的 GPU 是 140 MiB，比设计目标 ≤ 130 多 10 MiB（同机 20 个 DOM 终端离屏是 118–123）；没有单独测「注入假压力 → 立刻回落」，A4 的 30 秒已覆盖同一组持有者，单测覆盖了总线触发。
- Linux / Windows 的探测只有解析与迟滞单测，没在真机上制造压力。

接口：

- IPC：`memory:pressure`（event，shared），载荷 `{ level: "normal" | "warning" | "critical" }`；`window.armadra.memory?.onPressure(listener) → unsubscribe`。
- web：`pressure-bus.ts` 的 `MemoryPressureLevel`、`emitMemoryPressure(level, source?: "shell" | "sample")`、`onMemoryPressure(listener: (level) => void) → unsubscribe`（只在该回收时与变回 normal 那一次回调）、`currentMemoryPressure()`；`pressure-policy.ts` 的 `decide`、`actionFor`、`MEMORY_PRESSURE_ENABLED`、`PRESSURE_RESCAN_MS`、`WARNING_RELEASE_OFFSCREEN_MS`；`render-budget.ts` 的 `RENDER_HIDDEN_RELEASE_MS`；`useOnScreen(ref, enabled?)`。

## 性能包 P1：Runtime 资源采样异步化、诊断接口与 tap 按需（契约 §54，2026-10-09）

做了什么：

- 资源采样（`core/resources/`）：一拍只读一轮整机表——一次异步 `ps`、一次异步 `tmux list-panes`（各 1.5 s 期限，超时 `SIGKILL`），所有在看的工作空间共用，CPU% 的分母只算一次；基线时刻取 `ps` 读回的那一刻。三个平台探针（内存压力 / 交换区 / 电源）按 10 / 30 / 60 s 缓存，过期先交旧值、后台刷新，一轮从不等探针。下一拍在这一拍走完后才挂；停掉又重起的循环撞上还没走完的一拍时跳过并计数。`ps` / `tmux` 超时这一轮作废：不发 `resource.sample`，`GET …/resources` 答 `503 resources_unavailable`。`GET …/resources` 与阈值慢轮（`ThresholdWatch`，改 async、不叠加）搭正在进行或 500 ms 内刚完成的那一轮。远端 worker 仍走同步版（另一个进程）。
- 诊断：`metrics.ts` 记事件循环延迟（`monitorEventLoopDelay` 10 ms，只报超出间隔的部分，两段 30 s 轮换）与采样计数（轮数、最近 / 最大耗时、跳过、各命令超时）；p99 连续 3 轮 > 200 ms 记一条只有数字的 `warn`。`GET /api/diagnostics/runtime` 与 procedure `diagnostics.runtime`（§43.8 表一行），门同 §30；协议 minor 25 → 26。
- tmux 的程序状态 tap（§53）只给 Agent 会话（环境里有 `ARMADRA_AGENT_ID`）开，接管时用 `show-environment` 判断；tap 输出按会话名查表，不再线性扫。探针 `core-terminal-program-status` 改用 Agent 终端。
- 契约 §54（§53 的 tap 范围一句同步）、架构指南两处、错误码 `resources_unavailable`。

实测（macOS arm64，`_shared/perf-diag-20261009/bench/terminal-memory.mjs`，10 个终端各 100 行/s，未打包壳 + 测量垫片，前 = `main` `7d75ea8f`，后 = 本分支）：

| 阶段            | Runtime ELD max（ms） | 同步子进程（ms/s） | core ELU      | tmux 进程 |
| --------------- | --------------------- | ------------------ | ------------- | --------- |
| active          | 152.4 → 7.4           | 46.6 → 0           | 0.121 → 0.037 | 41 → 31   |
| offscreen 1 min | 133.0 → 8.1           | 48.1 → 0           | 0.107 → 0.039 | 41 → 31   |
| back-visible    | 95.2 → 11.5           | 39.1 → 0           | 0.077 → 0.041 | 41 → 31   |
| switch ×10      | 236.6 → 13.6          | 55.4 → 0           | 0.166 → 0.037 | 41 → 31   |
| after-forced-gc | 93.1 → 7.4            | 35.0 → 0           | 0.071 → 0.047 | 41 → 31   |

- 隔离数据目录起 core，订阅资源后读 `GET /api/diagnostics/runtime`：每轮 `lastRoundMs` 约 110 ms（异步，不占主线程），`timeouts` 全 0，procedure 与旧路径同一份答案。
- 新单测：采样服务 5（`ps` 挂住不阻塞并超时计数、两个工作空间一拍一次 `ps`、GET 搭进行中的一轮、跳拍计数、多工作空间同一 `elapsedMs`）、探针缓存 2、阈值慢轮 1、metrics 3、诊断路由 2、对偶 2、tmux 2（只给 Agent 会话开 tap，含接管）。
- `node tools/probes/core-terminal-program-status.mjs`：tmux 与 direct 都过。
- `pnpm libs:build && pnpm -r --if-present test`：web 4172、desktop 5452 / 67 跳、shared 382、server 98 / 4 跳、mobile 10、push-relay 9 全过；live 配置的 `passkey-cdp.live.integration.test.ts` 本机失败（同前几节，与本改动无关），`node --test scripts/*.test.mjs` 单独跑 73 / 2 跳通过。`pnpm check` 通过。

没做 / 偏离：

- 普通 shell 在 tmux 后端下不再有程序自报状态（设计 §2.6 的取舍；规则在 `tmux/backend.ts` 的 `wantsTap` 一处）。注册表里没有 `programStatus` 能力位，所以只按 Agent 会话判断。
- 磁盘（`statfsSync`）仍每轮同步读，没有缓存（亚毫秒）。
- 远端 worker 的同步采样没改（设计 §7.2）。

接口：

- core：`ResourceService.round(reuseMs?)` / `snapshotFrom(round, workspaceId)` / `snapshot()` 改 async / `metrics`；`ResourceDomain.runtime()`；`Sampler.refreshAsync()`、`readProcessTableAsync`、`panePidsAsync`、`SampleTimeout`、`ProbeCache`、`*Async` 探针；`installRoutes(server, reports, runtime?)`；`wantsTap(env)`。
- shared：`diagnostics.runtime`、`runtimeDiagnosticsSchema`、`RUNTIME_DIAGNOSTICS_PATH`、错误码 `resources_unavailable`。

## 终端前端分阶段生命周期、共享灌写调度器与背压（性能包 P3，2026-10-09）

做了什么：

- 生命周期 `live → parked → detached → released`：判定在 `apps/web/src/terminal/lifecycle.ts`（纯函数），计时、内存压力订阅与复活在 `terminal/surface/use-lifecycle.ts`，`[data-slot="terminal-body"]` 加 `data-lifecycle`。断开时长：折叠 5 s、窗口后台 60 s、**平移离屏 60 s**（新增，`OFFSCREEN_DETACH_MS`，设 `null` 即关）；断开满 `armadra.terminal.releaseAfter`（5m / 10m / 30m / never，缺省 10m，只加了偏好字段，设置页的行由 P4 加）销毁 xterm 实例与观察器，会话、输入账、离屏缓冲留在 `SurfaceRefs`。`data-render` 的六个值不变，`released` 仍显示「已断开（省电）」。
- 复活：回到可见，或输入到已断开 / 已释放的终端（`writeLine` / `sendKeys` / `paste` / `focus` / xterm `onData`）。输入在没有可用传输时排队（`deliverInput`，上限 64 Ki 码元），传输建好后进 pre-hello 队列按序发出；以前是静默丢弃。传输与 WebGL effect 以显示层代次为依赖。
- 尺寸：`gridRef` 记最后对齐的行列数（refit 发 resize 与每次 hello 后），重建时作为 `new Terminal({ cols, rows })` 初值；`use-refit.ts` 在 `proposeDimensions()` 为 `undefined` 或小于 2×1 时不 fit、不发 resize。
- 豁免：启动行已武装 / 等依赖、`starting` / `connecting` / 休眠接回中、10 s 内有没确认或排队的输入时不断开也不释放；聚焦模式节点与 `blocked` 的 Agent 另外不释放。命中时 5 s 后重看。
- 内存压力：订阅 P2 的 `terminal/pressure-bus.ts`，阈值取 `pressure-policy.ts` 的 `actionFor(level).releaseOffscreenOlderThanMs`：告警档释放离屏满 30 s 的、紧急档释放全部看不见的，可见的不动，降回 normal 不重建，`never` 时不响应。开发时先按设计接口写了本地占位，P2（#219）合入后已合并 main 并换成正式实现。
- B3：`terminal/flush-scheduler.ts` 全页一个 500 ms 定时器，只在有表面待灌时排，替换每表面 `setInterval`；灌写用 `terminal.write(text, callback)`，上一批没消化完不灌下一批。DOM 渲染器下渲染名额不再决定档位（`RenderInputs.webgl`），看得见即直写。离屏缓冲上限注释改正（2 Mi 码元）。释放时在 `terminal.dispose()` 前抓 canvas 并 `loseContext`。

实测（macOS arm64，未打包壳，20 个 DOM 终端各 100 行/s，tmux 后端，`_shared/perf-diag-20261009/bench/terminal-memory.mjs` 加 `--release-after` / `--gc-offscreen` 两个开关；Renderer phys_footprint，MiB）：

| 阶段                  | main 基线 | P3 `never`（只断开） | P3 `5m`（释放） |
| --------------------- | --------- | -------------------- | --------------- |
| 离屏 1 m              | 186       | 174                  | 179             |
| 离屏 3 m（基线）/ 7 m | 207       | 174                  | 174             |
| 同上，强制 GC 后      | —         | 165                  | **138**         |
| 回到可见              | 386       | 210                  | 180             |
| 往返 ×20 后强制 GC    | 319       | 335                  | 325             |

- 释放后 xterm 实例 20 → 0，页面元素 2820 → 1080，DOM 节点计数 4209 → 1409；离屏 Renderer CPU 2.4% → 0.1–0.2%；回到可见 20 个全部重建并 attach。
- 每个释放的终端在强制 GC 后约省 1.4 MiB（165 → 138），低于设计估的 4.5–5 MiB；大头来自平移离屏也断开（207 → 174）。不强制 GC 时 Blink 不立刻归还，7 m 读数与只断开相同。
- 「活跃」一档噪声大（同一构建两次 418 / 499，基线 417）；DOM 渲染器下 20 个可见终端现在全部直写（基线 16 个直写 + 4 个批写），Renderer CPU 21–29%（基线 18.8%）。
- 单测：`lifecycle.test.ts` 9、`flush-scheduler.test.ts` 5、`render-state.test.ts` +1、`TerminalSurface.render.test.tsx` +6（离屏 → detached → released、重建沿用行列且不多发 resize、0×0 不 resize、释放后输入先复活再按序发、调度器按拍灌写、压力两档）。
- `pnpm libs:build && pnpm -r --if-present test`：web 4178、desktop 5435 / 67 跳、shared 382、server 98 / 4 跳、mobile 10、push-relay 9 全过；live 配置的 `passkey-cdp.live.integration.test.ts` 本机失败（同前几节，与本改动无关）。`pnpm check` 通过。

没做 / 偏离：

- 基准没有 `--restore-check`（`tmux capture-pane` 与页面文本、光标比对），恢复的行列由渲染测试覆盖；探针化由 P5 做。
- 释放会丢 xterm 自己的回滚、选区与搜索高亮；direct 后端只靠回放环拿回一屏与回放。
- 设置页 UI 与文案归 P4。

接口：

- web：`lifecycle.ts`（`LifecyclePhase`、`detachDelay`、`canDetach` / `canRelease`、`pressureReleases`、`releaseAfterMs`、`OFFSCREEN_DETACH_MS`、`RELEASE_AFTER_OPTIONS`）、`useSurfaceLifecycle`、`flushScheduler` / `createFlushScheduler`、`deliverInput` / `flushPendingInput`、`measurable`（use-refit）、`SurfaceRefs` 新增 `gridRef` / `pendingInputRef` / `reviveRef` / `mountQueueRef` / `flushingRef`、`TerminalPreferences.releaseAfter`（`armadra.terminal.releaseAfter`）、`RenderInputs.webgl`。

## 性能包 P4：渲染器策略与设置页（B1 / E1 / E2，2026-10-09）

做了什么：

- `apps/web/src/app/preferences/terminal.ts`：删除布尔 `webgl`（`armadra.terminal.webgl` 不再读，按设计不做兼容，开过 WebGL 的用户重选一次），新增 `renderer`（`armadra.terminal.renderer`：`dom` / `webgl` / `auto`，缺省 `dom`）与 `repaintThrottle`（`armadra.terminal.repaintThrottle`：`off` / `lowZoom`，缺省 `off`）。
- `apps/web/src/terminal/renderer-policy.ts`（纯函数）：`dom` 不装 addon；`webgl` 持有名额才装、没名额的可见终端批写（P3 的语义不变）；`auto` 把协调器上限压到 `AUTO_WEBGL_SLOTS = 4`（`syncDocumentPreferences` 里 `effectiveRenderBudget`），焦点不计上限，没名额的可见终端 DOM 直写；`repaintThrottled`：缩放 < 0.5、看得见、没焦点、没装 WebGL 的终端写入合并到 100 ms。
- `apps/web/src/terminal/surface/use-webgl.ts`：WebGL effect 从 `TerminalSurface.tsx` 整段搬出（丢上下文上报、dispose 前抓 canvas 并 `loseContext` 照旧），返回 addon 是否真的装着；`useLowZoom` 开关关着时不订阅画布 store。`use-render-budget.ts` 加 `writeThrough` / `throttled`，限帧时排进 `flush-scheduler.ts` 新增的 `repaintScheduler`（100 ms），关掉或聚焦时立刻灌完。
- 终端体加 `data-renderer="dom|webgl"` 与 `data-throttled` 诊断属性。
- 设置页「终端外观 → 渲染」：渲染器（Select）、渲染名额（只在 `webgl` 档显示）、缩小时限帧重绘（实验，Switch）、离屏多久后释放终端画面（5 分钟 / 10 分钟 / 30 分钟 / 从不，带脚注）；文案在 `apps/web/src/i18n/terminal.ts`，中英同步，删掉 `terminal.settings.webgl`。
- `docs/design/terminal-host-design.md` 加 §7.6。

实测（macOS arm64，未打包壳，20 个终端各 100 行/s，tmux 后端，画布缩放 0.317；`_shared/perf-diag-20261009/bench/terminal-memory.mjs` 的副本加 `--renderer` / `--throttle` / `--run`，`--off1 60 --off2 180 --cycles 5 --memory-infra`；每档 3 次取中位数；MiB，CPU 为 `top` 的 %）：

| 档位（20 个可见，active） | Renderer | GPU | 整机 | 扣 GPU | `blink_gc` | R CPU | GPU CPU | WebGL 数       |
| ------------------------- | -------- | --- | ---- | ------ | ---------- | ----- | ------- | -------------- |
| `dom`                     | 423      | 210 | 836  | 626    | 226        | 19.8  | 12.5    | 0              |
| `webgl`（名额 16）        | 367      | 420 | 998  | 573    | 135        | 7.5   | 7.4     | 16             |
| `auto`（4）               | 441      | 258 | 905  | 646    | 224        | 17.4  | 10.9    | 4              |
| `dom` + `lowZoom`         | 440      | 197 | 841  | 644    | 239        | 20.5  | 3.3     | 0（20 个限帧） |

| 档位（往返 ×10 后 / 强制 GC 后） | Renderer  | GPU       | 整机      | `blink_gc` | R CPU       |
| -------------------------------- | --------- | --------- | --------- | ---------- | ----------- |
| `dom`                            | 413 / 338 | 204 / 204 | 837 / 764 | 219 / 212  | 19.7 / 19.1 |
| `webgl`                          | 252 / 184 | 391 / 387 | 865 / 811 | 40 / 37    | 7.5 / 7.5   |
| `auto`（4）                      | 414 / 330 | 250 / 256 | 887 / 808 | 219 / 206  | 16.9 / 16.9 |
| `dom` + `lowZoom`                | 416 / 337 | 203 / 203 | 835 / 765 | 221 / 216  | 15.9 / 14.7 |

- 阈值扫描（临时把 `AUTO_WEBGL_SLOTS` 改成 8 / 16 重建，未提交；8 跑 2 次、16 跑 1 次有效）：`auto`(8) active `blink_gc` 214、GPU 312、整机 945、R CPU 15.4；`auto`(16) active 148 / 往返后 94、GPU 420、整机 1000、R CPU 13–15。
- E1 判据（`blink_gc` < 100、R CPU < 10%、GPU ≤ DOM + 80）：4 / 8 个名额只满足 GPU 一条，16 个名额只满足 `blink_gc` 一条，任何阈值都不同时满足。只要还有持续输出的 DOM 终端，Oilpan 堆就涨到同一个 GC 水位（20 个 DOM 226，16 个 DOM 224），不随 DOM 终端数线性下降；纯 `webgl` 档的 4 个无名额终端走 500 ms 批写，所以稳态只有 40。
- **结论：默认渲染器仍是 `dom`（整机最低）；`auto` 保留为实验档，阈值定 4**——加到 8 / 16 每个名额多约 11–13 MiB GPU，`blink_gc` 到 16 才降，那时已等于 `webgl` 档的整机成本。
- E2：`lowZoom` 下 20 个可见终端全部限帧，GPU 进程 CPU 12.5% → 3.3%，往返阶段 Renderer CPU 19.7–25.6% → 13.3–15.9%（active 一档噪声大：20.5 / 21.1 / 12.8）；内存不降（`blink_gc` 239）。默认仍关。
- 离屏 1 m / 3 m 四档相同（Renderer 172–185、GPU 122–142，平移离屏已断开），即 P2 的 A4 与 P3 的断开已生效。
- 单测：`renderer-policy.test.ts` 8（三档、`auto` 的选择规则含协调器、限帧判定）、`use-webgl.test.tsx` 5（`dom` 不装、`auto` 有名额装丢名额卸、丢上下文上报、`useLowZoom`）、`TerminalLookPage.test.tsx` +3（三个新行、枚举持久化、名额只在 `webgl` 显示）、`preferences/terminal.test.ts` +2（枚举读回、旧键不读）、`TerminalSurface.render.test.tsx` +1（限帧按 100 ms 一拍、关掉立刻灌）。

没做 / 偏离：

- E2 判据里的「聚焦终端输入回显 p95」没在基准里量；聚焦终端不限帧由单测保证。
- `auto` 选谁用 WebGL 按「先可见先得、隐藏持有者先让位」，不看哪个终端在忙；20 个都忙的场景下与「最近可见」无差别。
- 基准副本没进仓库（P5 收进 `tools/probes/`）；原脚本的临时目录名带标签，标签变长后 Unix 套接字路径超长，core 起不来，副本改成短前缀，P5 收录时需注意。
- 一次 `auto`(16) 因窗口被切到后台（`document.hidden`）卡在 rAF，按 PID 结束，只留了前四个阶段的数据。

接口：

- web：`TerminalPreferences.renderer` / `repaintThrottle`、`TERMINAL_RENDERERS` / `TERMINAL_REPAINT_THROTTLES`；`renderer-policy.ts`（`AUTO_WEBGL_SLOTS`、`LOW_ZOOM_THRESHOLD`、`THROTTLED_REPAINT_MS`、`rendererUsesWebgl`、`rendererGatesRender`、`wantsWebgl`、`effectiveRenderBudget`、`isLowZoom`、`repaintThrottled`）；`useWebglRenderer`、`useLowZoom`；`repaintScheduler`；`RenderBudget.writeThrough` / `throttled`；`useRenderBudget` 的选项 `webgl` 换成 `renderer` / `repaintThrottle` / `lowZoom`；DOM 属性 `data-renderer`、`data-throttled`。

## 终端内存探针与基线（性能包 P5，2026-10-09）

做了什么：

- `tools/probes/terminal-memory.mjs`：把性能诊断时的基准脚本收进仓库。桌面壳（缺省打包产物，`--unpacked` 用开发构建）里 N 个持续输出的终端（`--terminals 5|10|20`、`--rate`、`--renderer dom|webgl`、`--backend tmux|direct`），阶段 `active → offscreen-1m → offscreen-3m → back-visible → switch-x10 → switch-x20 → after-forced-gc`；每段记各进程物理占用（macOS `top` 的 phys_footprint，Linux `smaps_rollup` 的 Pss 与 VmRSS）、Renderer 的 JS 堆 / DOM 计数 / `data-render` 与 `data-lifecycle` 直方图、tmux 进程树 RSS 与进程数、Runtime 的 `GET /api/diagnostics/runtime`（§54；接口不在时记 null 并注明），长离屏段里量 65 s 的采样轮次。可选 `--cadence-check`（新建节点 vs 重载后）、`--pressure`（经 `window.__armadraMemoryPressure.emit("warning")` 注入假压力，断言 `data-render` 不变）、`--restore-check`（停发射器、窗格打标记，离屏后回来比页面行数 / 文字 / 光标与 `tmux capture-pane`）、`--eld-preload`（只配 `--unpacked`，`terminal-memory-eld.cjs` 记同步子进程阻塞做对照）。SIGTERM 时先收拾自己的 tmux 与临时目录再退。
- `terminal-memory-lib.mjs`：参数、读数解析、Runtime 汇总、恢复比对、`compare()`（相对阈值**且**超绝对容差才算退化；只看绝对差、下限、精确断言、GPU 在 Linux 只记录）、`--merge` 三次取中位数。规则表 `METRICS` 即设计 §2.7 的表。
- 基线 `terminal-memory-baseline.json` 先占位（`platforms` 为空，B 档只报告不判），按 `<平台>-<架构>[-webgl][-direct]` 存，只和同一场景比；`docs/status/terminal-memory-baseline.md` 写了场景、指标、录法，环境与三次原始数待录。
- 夜间 B 档 `tools/ci/e2e.d/terminal-memory.json`（darwin / linux，`--terminals 10 --off1 60 --off2 180 --cycles 10`，30 分钟）；`pnpm release:test` 加 `terminal-memory.test.mjs`。

实测（macOS arm64，开发构建 `--unpacked --eld-preload --cadence-check`，10 个终端，`main` `7d75ea8f`，P1–P4 均未合入）：

- Renderer 活跃 359 MiB、长离屏 134 MiB、强制 GC 比回到视口 +148 MiB（回到视口后 15 s 画面还没长回来）；Runtime 事件循环最大 346 ms，同步子进程 55.5 ms/s；全部离屏时每 65 s 采样 31 次，新建节点与重载后离屏 60 s 都是 28 次（徽标降速未生效，P2 要修的那个）；tmux 树 144.8 MiB / 41 个进程。
- `--restore-check`（3 个终端）：行列、文字、光标与 `capture-pane` 全部对上（P3 未合入，离屏时 `data-lifecycle` 还没有值，这次验的是探针本身）。
- P1 / P2 合入后的 `main`（`454a7861`，P3 / P4 未合入）同一开发构建、5 个终端、`--pressure`：Runtime 读数改由 §54 诊断接口给出——事件循环最大 81 ms、p99 中位数 4.3 ms，一轮采样最长 115 ms、无超时；垫片记的同步子进程阻塞 0 ms/s；全部离屏时每 65 s 采样 2 次（之前 31）；tmux 进程数 16 = 1 个服务器 + 5 × (shell + 发射器) + 5 个控制客户端（tap 的 `cat` 只给 Agent 会话后少了 5 个）；注入假压力后 `data-render` 不变。
- 夜间作业在本分支手动跑一次（run 37930415539）：macOS 打包产物上 `terminal-memory` 通过（约 7.6 分钟，10 个终端，Renderer 活跃 381 / 长离屏 172 MiB），Linux `linux-unpacked` 在 xvfb 下通过（Renderer Pss 活跃 1087 / 长离屏 244 MiB，软件渲染）。
- 基线（P1–P4 合入后的 `main` `9cd38293` 加本包，GitHub 运行器各三次夜间作业的中位数，nightly 37961973088、37964685518、37967150898）：macOS Renderer 活跃 468 / 长离屏 183 MiB，Linux 1073 / 214 MiB；两平台全部离屏每 65 s 采样 2 次，事件循环最大 82.5 / 42.2 ms，tmux 31 个进程；长离屏时十个终端都是 `detached`。六次运行各自对基线比都不报退化。原始数见[终端内存基线](terminal-memory-baseline.md) §4。
- 探针临时目录改短前缀 `atm-`，数据目录里的 Unix socket 路径不再逼近上限（P4 报的问题）。
- `node --test tools/probes/terminal-memory.test.mjs`：14 个全过（`compare()` 各规则、恢复断言、合并、解析、清单经 `e2e.mjs --list`）。

没做 / 偏离：

- Renderer 活跃读数与强制 GC 差值在 Linux 只记录（设计里只有 GPU 列如此）：软件渲染下同一提交三次是 1057 / 1073 / 2061 MiB 与 −450 / +31 / −129 MiB，按容差比会误报。
- 多了一个文件 `tools/probes/terminal-memory-eld.cjs`（`--eld-preload` 的垫片），设计的文件边界里没列。
- `--pressure` 依赖 P2 的 `window.__armadraMemoryPressure`，`--release-after` 写 P3 的 `armadra.terminal.releaseAfter`，渲染器同时写 P4 的 `armadra.terminal.renderer` 与旧的 `armadra.terminal.webgl`；这些包合入前探针只记录。
- 打包产物这条路径（B 档用的）本机没跑，靠 nightly 验；GPU 列在 Linux 软件 GL 下只记录。

接口：

- `node tools/probes/terminal-memory.mjs [输出目录] [选项]`，产物 `result.json`（`phases[].stage`、`metrics`、`comparison`、`restore`、`pressure`、`cadence`、`runtime`）、`table.md`；`--merge r1 r2 r3 [--machine 说明]` 写基线。
- lib：`parseArgs`、`METRICS`、`compare(current, baseline, { platform })`、`deriveMetrics(report)`、`mergeRuns(reports)`、`restoreCheck({ before, after, paneBefore, pane })`、`summarizeDiagnostics(samples)`、`baselineKey`。

## 移动端独立版本线与「关于」页的协议兼容（2026-10-10）

手机与 iPad（Android 手机与平板）是同一个 App，版本从桌面 / 服务器套件里拆出来，单独演进；与主机是否兼容只看协议。细节见 [CI 与发布](../guides/ci-release.md) §2.8。

做了什么：

- 版本线：`apps/mobile/package.json` 改为 **1.0.0**（与 0.2.x 一眼分得开，且 Android 版本号不再由 semver 推出，没有换号约束），移出 `VERSION_SITES`；`version.mjs` 加 `mobile check [--tag mobile-vX.Y.Z] | set | print`（只收纯 `X.Y.Z`）；`pnpm release:check` 两条都跑。更新记录另立 `apps/mobile/CHANGELOG.md`，根 `CHANGELOG.md` 头注明。
- 派生：`apps/mobile/scripts/app-version.mjs write`（`sync` 第一步）写不入库的 `ios/version.generated.xcconfig` 与 `android/app/version.properties`。构建号 = `ARMADRA_BUILD_NUMBER` 或 `git rev-list --count HEAD`，浅克隆报错。iOS：`project.pbxproj` 删掉六处写死的 `MARKETING_VERSION = 0.2.0` / `CURRENT_PROJECT_VERSION = 1`（iPad 显示 0.2.0（1）的缺陷），新增 `ios/version.xcconfig` 作工程级 Release 的基础配置、`debug.xcconfig` include 它。Android：`build.gradle` 读 `version.properties`，缺文件即失败；`ARMADRA_VERSION_CODE` 与 semver 推号删除。
- 兼容：`compatibility.json` 加 `mobile.minimumHostProtocol`（1.14，不进围栏），`compatibility.mjs::normalizeMobile` 严格校验；页面副本 `apps/web/src/mobile/host-compatibility.ts`（`hostCompatibility` → `compatible / updateHost / updateApp / unknown`），`mobile check` 核对两者与 core 的 `PROTOCOL_MAJOR` / `PROTOCOL_MINOR`。
- 关于页：原生插件加 `appInfo`（iOS 读 `CFBundleShortVersionString` / `CFBundleVersion`，Android 读 `PackageInfo`），页面 `nativeBridge().appInfo()`；原生 App 里「设置 → 关于」显示 App 版本（构建号）、主机版本、主机协议，不兼容时 `Alert destructive` 说明更新哪一边（i18n `updates.appVersion*`、`updates.hostProtocol*` 中英）。原生 App 里不再出桌面的更新行。
- 工作流：`nightly.yml` 两个移动端作业 `fetch-depth: 0`，版本取 `version.mjs mobile print`，iOS 不再在命令行覆盖 `MARKETING_VERSION`；产物名带移动端版本。

实测：

- `app-version.test.mjs` 21（版本名、构建号四种来源、两份文件、xcconfig 链解析并叠加个人签名配置、gradle 读法重放）；`version.test.mjs` +7（不在桌面清单、仓库自查、`mobile set`、标签、写死版本 / 旧推号、协议对齐、`mobile` 键严格且不进围栏）；`host-compatibility.test.ts` 5、`native-bridge.test.ts` +1、`AboutPage.test.tsx` +3。
- 本机：`xcodebuild -showBuildSettings`（带与不带 `-xcconfig ~/armadra-ios-build/personal.xcconfig`，Debug / Release，App、NotificationService、AppUITests）全部 1.0.0 / 3185；模拟器 `xcodebuild build` 成功，App 与 NSE 的 Info.plist 都是 1.0.0（3185）；`./gradlew :app:processDebugMainManifest` 合并清单 `versionCode="3185"`、`versionName="1.0.0"`，`:app:compileDebugJavaWithJavac` 通过（JDK 21）。

没做 / 偏离：

- `release.yml` 不打移动端产物：商店构建要用户的签名与上传凭据，`mobile-v*` 标签之后的上架仍是人的动作；`mobile-v*` 不触发 `v*` 发布。
- 「关于」页的 App 版本要新装的安装包（插件有 `appInfo`）；旧包显示「未知」。真机上的显示没跑。
- 构建号取提交数，分支上的构建号可能高于之后主干上的某次构建；商店构建应只从主干 / 标签出。

接口：

- `version.mjs`：`mobileVersion`、`setMobileVersion`、`checkMobile`、`MOBILE_MANIFEST`、`MOBILE_CHANGELOG`、`MOBILE_TAG_PREFIX`、`MOBILE_PAGE_PROTOCOL`；`compatibility.mjs`：`readMobileCompatibility`、`normalizeMobile`。
- `apps/mobile/scripts/app-version.mjs`：`parseMobileVersion`、`mobileVersion`、`buildNumber`、`nativeVersionFiles`、`writeNativeVersion`；环境变量 `ARMADRA_BUILD_NUMBER`。
- web：`NativeBridge.appInfo()` → `NativeAppInfo { version, build }`；`MINIMUM_HOST_PROTOCOL`、`hostCompatibility`、`formatProtocol`；`MobileAbout`。

## 终端选区随按键释放结束（#227，2026-10-10）

根因：xterm 的选区（以及应用开鼠标上报时的松开上报）靠 `mousedown` 时挂在 `document` 上的 `mouseup` 收尾，它的 `mousemove` 不看 `buttons`。画布平移用的 d3-zoom 在 `window` 捕获相位接住 `mouseup` 并 `stopImmediatePropagation()`；手形工具下左键按在终端上、或中键按在终端上（这两种都会平移画布），按下那一下 xterm 与 d3-zoom 都收到，松开那一下只有 d3-zoom 收到，于是松开后选区仍跟着指针走、开了鼠标上报的应用一直以为键按着。窗口外松开、失焦、`pointercancel`、页面切后台是同一类「键松了，`document` 不知道」。

做了什么：

- 新增 `terminal/surface/pointer-release.ts` 的 `guardPointerRelease(body)`，在 `use-xterm.ts` 随 xterm 实例装卸：终端体捕获相位记下按下的键，`document` 真收到 `mouseup` 就划掉；`pointerup` 这一轮派发完仍没划掉、`mousemove` 的 `buttons` 里已没有这个键、`blur`、`visibilitychange` 到 hidden、`pointercancel` 时，在 `document` 上补派一个 `mouseup`，xterm 按自己的逻辑收尾（选区停在松开处；上报模式下应用收到松开）。只在有键按着时挂 `window` 监听；正常的节点内拖选、画布平移、应用自己的鼠标模式都不改路径。
- e2e：`ui-features` 加场景 `terminalSelection`（`tools/probes/ui-features/terminal-selection.mjs`）；`harness.mjs` 的中键按下带上 `buttons: 4`。

实测（macOS arm64，基于 main 9cd38293）：

- 修复前场景 `--only=terminalSelection` 在「手形工具：松开后不按键移动，选区不变」失败（松开时无选区，晃一下出三段选区）；探索时中键拖出节点，`cat -v` 只收到 `^[[<1;5;2M`，没有松开。修复后全过：选择工具节点外 / 窗口外松开、手形工具拖动平移画布且选区不再变、`?1002h`+SGR 下中键松开收到 `^[[<1;5;2m`、节点内拖选照常、控制台 0 条 error。
- 新增 `pointer-release.test.ts` 10 条：节点内正常拖选不补派、节点外松开、被吞的 `mouseup` 在 `pointerup` 之后补上且之后移动不改选区、无键移动先收尾、`blur` / `pointercancel` / `visibilitychange`、中键被吞仍有松开、未按键时不挂监听、拖动中卸载摘监听。

没做 / 偏离：

- 手形工具按在终端上仍会先被 xterm 当作一次按下（随即在松开时收尾），没有在手形工具下让终端完全不接收指针。
- 没有在 Electron 里用真实 HID 事件复现；CDP 合成的窗口外松开在无头 Chrome 里本来就能送达。

接口：

- web：`guardPointerRelease(body: HTMLElement): () => void`（`terminal/surface/pointer-release.ts`）。无契约、迁移变化。

## 多端入口：选择服务页与「切换服务」（A7-1，多端入口设计 §1，2026-10-10）

做了什么：

- 新目录 `apps/web/src/services/`：`rows.ts`（源描述 → 行，一个 `sourceId` 一行，到达方式按直连优先排，「全部」按首选路分组：本机 / 中转 · 服务名 / 直连；行数超过 3 才单列「最近使用」）、`recent.ts`（`armadra.sources.recent`，带时刻、前插去重；一次性的进入意图 `armadra.services.enter` 在 `sessionStorage`）、`probe.ts`（直连 `GET /api/identity/hello` 1.5 秒；经中继的每个远程服务一次 `GET /v1/me/sources`，`online` 覆盖组内全部源，换不到访问令牌 4xx 记「已登出」、网络断了记未知；并发 3、缓存 30 秒；进页面与回前台各探一次）、`ServicePicker.tsx`（`page` / `dialog` 两种：行 = `Item` + `StatusPill` + 「当前」`Badge`，失败 `Alert` 挂在那一行下面，可带动作；登录失效的组头「已登出」+「登录」；空表 `Empty`）、`SwitchServiceDialog.tsx`、`ServicesSettingsGroup.tsx`、`switcher.ts`。
- 原生 App 入口（`mobile/entry.ts`）：连接表非空不再自动 `enterConnection`，缺省落在选择页（`pick: true`）；`startupTarget` 决定的三种直接进：选择页点过一行（进入意图）、推送要切连接（地址带 `#push=`）、偏好 `services.autoEnter`（`armadra.services.autoEnter`，缺省关）。进成功记进最近使用；进不去回选择页，失败带 `failedId` 挂在那一行。表为空、记着早先单连接 Gateway 的旧路径不变。配对、个人中转挂载、分享链接加入之后照旧直接进（`connect.ts::enterNext` 同时记进入意图）。
- `ConnectScreen` 的列表态换成 `ServicePicker`（标题「选择服务」，在线状态来自 `useServiceProbe`；行上「需要重新登录」且经中继时动作「登录」，打开中转表单并预填那个远程服务；从画布回来多一个「返回」）。旧 `ConnectionList` 删掉。
- 中继托管页面（`shell/RelaySignIn.tsx`）登录后挑主机改用同一个列表（`disableOffline`：目录答的离线行点不了；进不去的失败挂在那一行）；`remote.hosted.open` / `remote.hosted.offline` 两个键随之删掉。
- 桌面与服务器壳：「切换服务」对话框（`ResponsiveDialog`，手机宽度是底部 Sheet）：本机 / 中转 / 直连分组，状态取各源的连接状态，行尾「切换」= `registry.setCurrent`（不带源前缀的查询经 `useSourceSwitchCacheReset` 重取）并把侧栏滚到那一组；桌面壳再多「在新窗口打开」。底部「添加连接」去设置 → 远程访问。入口：设置 → 远程访问顶部「服务」一组、命令面板 `app.switchService`（不预设键位）。
- 手机设置首页（「常用」）顶部「服务」一组：当前服务（名字 · 到达方式）+「切换服务」（`#connections` 重载回选择页）、「启动时直接进入上次的服务」开关。
- 推送 `unknown`（签发通知的主机不在连接表）的提示加动作「选择服务」。
- 桌面壳 IPC `window:open { sourceId }` → `{ opened }`（`shared/ipc.ts`、`main/index.ts`、preload `windows.openSource`）：`main/window.ts::openSourceWindow` 用同一张页面另开窗口，地址带 `?source=`；它不是主窗口（`sendToWindow` 只对主窗口，关它真关），`onWindowCreated` 加 `scope`，抢占快捷键的拦截只装主窗口（它的回答经 `sendToWindow`）。页面 `use-sources-bootstrap.ts::followInitialSource` 在那个源挂上后设为当前，只设一次。
- i18n 新模块 `i18n/services.ts`（中英同步）；设计展示页加「切换服务」对话框样本，手机列表样本换成新行模型。
- 测试：`services/probe.test.ts` 7（直连认不认、超时、中继一服务一问、登出与网络断开、两条路、并发 3、缓存 30 秒）、`services/ServicePicker.test.tsx` 14（合并与分组、最近使用门槛、意图只取一次、整页与对话框两种、行内失败、登出组头、空态、新窗口交给壳、`?source=`）、`entry.test.ts` +6（缺省落选择页、单连接也先选、意图直进并记最近、`autoEnter`、`#push=` 不受影响、失败挂行）、`ConnectScreen.test.tsx` +3、`RelaySignIn.test.tsx` 改为按行断言、`main/window.test.ts` +4、`shared/ipc.test.ts` 登记 `window:open`。
- 真机用例：iOS `ConnectFlowUITests` 重开后先落选择页、点那一行进画布；Android `ConnectFlowTest` 另记一个连不上的连接，走「两个连接 → 选择页 → 选配对的那一行 → 画布 → `#connections` 回选择页 → 再进」，`c_` 用例先选再进。`mobile-shell-e2e.mjs` 的步骤名同步。A 档 `multi-source` 加 2b：设置 → 远程访问 →「切换服务」切到服务器，侧栏分组与「当前服务」一致，再切回本机。

实测（macOS arm64）：

- `pnpm check` 通过；web 全量 vitest 单独跑通过（与 desktop 并行跑时 `SettingsDialog.test.tsx` 等十几条超时，单独重跑通过）；desktop 全量里 `parity-terminals.test.ts` 的 `afterAll` 钩子超时、`stream-queue.integration.test.ts` 一条时序断言失败，都在 core、本包没改，机器负载下复现、单独重跑 `stream-queue` 通过。
- A 档 `multi-source`（`ARMADRA_PROBE_RELAY_IMAGE=armadra-probe-relay:r5-media-ticket`）全部通过，含 2b；用 `armadra-probe-relay:local` 那一版镜像时第 4 步探针自己取中继媒体票答 403 `forbidden`（镜像版本问题，与 2b 无关）。
- 设计展示页 390 / 1440、明暗两套截图自查：行高 ≥ 48、行尾移除 44×44、状态胶囊文字用 `-text` token、未知只呼吸文字给读屏、无说明性文字。
- iOS XCUITest / Android 插桩没在本机跑（夜间 `mobile-shell-e2e` 跑）。

没做 / 偏离：

- 空表仍直接是「添加连接」的三种方式（不另加一屏 `Empty` 再点一次）；`services.empty` 用在没有主机可列时（对话框、托管页）。
- 移除连接沿用行尾垃圾桶 +「移除连接」确认（`mobileConnect.remove*`），没有做长按 / 右滑；`services.remove*` 两个键不新增。
- 桌面对话框的在线状态取各源现有连接状态（桌面所有源本来就同时挂着），不另跑 `probe.ts`。
- 侧栏组头点击切当前源没做（组头是拖动排序的把手，点和拖会抢）。
- 新窗口里抢占的快捷键（⌘W 等）不拦截，走系统菜单（关的是那扇窗）；通知点击、内存压力推送仍只到主窗口。
- 到达方式读 `SourceDescriptor` 的 `baseUrl` / `relayOrigin`；A7-2（一源多路，0044）合并后变基时改读 `routes`。
- 推送 `?s=` 在 A7-2 之后按多路由选路，这里未改。

接口：

- web：`services/rows.ts`（`ServiceRow`、`ServiceRoute`、`serviceRowOf`、`layoutServices`、`hostOf`）、`services/recent.ts`（`loadRecent`、`recentIds`、`recordRecent`、`forgetRecent`、`setEnterIntent`、`takeEnterIntent`、`RECENT_LIMIT`）、`services/probe.ts`（`createServiceProbe`、`useServiceProbe`、`ServiceStatus`）、`services/switcher.ts`（`useServiceSwitcher`、`switchService`、`returnToPicker`、`openSourceWindow`、`initialSourceParam`）、`ServicePicker` / `SwitchServiceDialog` / `ServicesSettingsGroup`；`mobile/entry.ts::startupTarget`，`Entry` 的 `connect(native)` 加 `pick` / `recent` / `failedId`；偏好 `servicesAutoEnter`；命令 `app.switchService`；`followInitialSource`；DOM 标记 `data-slot="service-picker"`、`data-service-row`、`data-service-group`、`data-service-status`、`data-service-failure`、`data-action="switch-service"`、`data-testid="switch-service-dialog"`。
- 桌面壳：IPC `window:open`（`window`），preload `window.armadra.windows.openSource({ sourceId })`；`main/window.ts` 的 `openSourceWindow`、`sourceWindowUrl`、`onWindowCreated(listener, scope)`。
- 存储键：`armadra.sources.recent`、`armadra.services.autoEnter`（localStorage），`armadra.services.enter`（sessionStorage）。

## 一源多路：客户端源表的路由表（A7-2，契约 §55，迁移 0044，2026-10-10）

做了什么：

- 迁移 `0044_client_source_routes.sql`：一台主机每种到达方式一行（`direct` / `relayed` × 来源），`client_sources` 的地址列留作首选路由的镜像。回填直连优先；旧版挂第二个中继留下的错配（旧中继来源 + 新 issuer，两者都是登记过的远程服务）拆成两条路。SecretStore 不动，凭据键就是路的来源。
- core `sources`：`mount` / `mountByLink` 以这一次的中继来源为凭据键并 upsert 一条路，不再覆盖前一个中继的那份；`session` 加 `route`，省略时直连探测与至多 3 条中继并行要断言、第一条在线的用；新 `sources.routePrefer` / `sources.routeRemove`（最后一条答 `conflict`）；`remoteSources.mounted` 改为「经这个服务有路」；`update` 改地址即换那条路。协议 minor 26 → 27。
- 桌面壳的远程信任放行每条路的来源（直连按路的指纹钉扎，中继沿用同名远程服务的指纹）。
- 页面：`SourceDescriptor.routes`（缺时由镜像推出）；选路中继按首选、最近成功逐条试，桌面交给本机 core 选；凭据来源接口加可选 `origin`。手机连接表 v2：行上 `routes[]`，远程服务槽按 `(sourceId, origin)`，v1 表一次性拆路、旧槽搬到那条中继；经中继的会话只在钥匙串里那份来自同一中继时才拿来换票。
- 探针 `multi-source` 加一条断言：经中继挂载后路由表只有这一条、首选、与镜像一致。
- 契约 §55（55.1 表与镜像、55.2 选路与两条 procedure、55.3 其余读者），§33 的生成表随出参更新；架构指南的迁移表与 `core/sources/` 一行。

实测：

- 新单测：core 一源多路 11（两个中继各一槽、来回切换 6 次不再 `cloud/login`、首选不通 / 不在线时用另一条、`mounted` 按服务、`routePrefer` / `routeRemove` 与最后一条、删首选后接替、答案与路由表里没有凭据、直连 + 中继、`update` 换来源、删源连同路由）；迁移 4（回填、错配拆分、不是登记服务的中继节点不拆、升级后旧凭据直接换票不重新登录）；壳的信任 1；页面选路 4；手机连接表 5（两条中继、按来源的槽、v1 → v2 搬表搬槽、坏表不升、最近成功）；手机凭据 1（按来源选槽、别的中继的会话不拿来换票）。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 5467 / 74 跳过（整跑时 `parity-terminals`、`stream-queue.integration`、`resources/sessions` 三个文件因负载失败，单独重跑通过），web 4250、shared 384、server 98 / 4 跳、mobile 10、push-relay 9；`node --test scripts/*.test.mjs` 73 / 2 跳。`pnpm check` 通过。
- 契约对偶：`sources.list` / `addDirect` / `mount` 的出参与 `session` 的入参改为断言「协议包形状的超集、字段逐个是同一个对象、只多 §55 的字段」——协议包（cloud 仓 0.2.1）还没有 `routes`，原先「就是同一个对象」的断言不再成立。

没做 / 偏离：

- 手机的原生钥匙串按 `sourceId + via` 存会话（`ConnectionVault.swift` / `ArmadraNativePlugin.java`），不是设计说的按 `(sourceId, origin)`：同一台主机经两个中继时只存得下最近那条的会话，切到另一条会用断言重新登录（源 core 上多一台设备）。页面这侧已按来源分槽、不会拿错的会话去换票；原生改键与迁移留给手机包。
- 手机连接表的 `kind` 照 v1（有中继那条路就是 `relayed`），没有改成随首选：`me.stream` 与通知条按它认经中继的连接。`me.stream` 仍按镜像的签发方订阅，一源的其余中继不另开流。
- 设置页没有管理路的界面（列出、设首选、删一条），只有接口；设计的 A7-1 / A7-3 再接。
- 契约节号与 minor 取合入时 main 的最大值 +1（现为 §55 / 1.27）；与同期别的包撞号时后合的一方改号。

接口：

- core：`SourcesStore.routes / allRoutes / route / upsertRoute / preferRoute / deleteRoute / touchRouteOk / mirror`；`SourcesService.session(sourceId, via?, route?)`、`routePrefer`、`routeRemove`；`RELAY_RACE`。
- shared：`clientSourceRouteSchema`、`clientSourceSchema`（加 `routes`）、`sourcesListOutputSchema`、`sourcesSessionInputSchema`（加 `route`）、`sourceRouteInputSchema`、`sources.routePrefer` / `sources.routeRemove`、类型 `ClientSourceRoute` / `SourceRouteRef`。
- web：`SourceRoute`、`SourceDescriptor.routes?`、`routesOf`、`Route.origin`、`CredentialProvider.getAccess/refresh(…, origin?)` 与 `selectsRelay`；手机 `remoteSlotOf(sourceId, origin?)`、`setRemoteSlot(sourceId, serviceId, origin?)`、`touchRoute`。

## Agent 节点粘贴与上传图片、文件（#226，契约 §56，2026-10-10）

现状与根因（改之前实测与读代码）：

- 终端节点：⌘V / Ctrl+V 只走 xterm 的 `paste` 事件，它只读 `text/plain`——截图粘不进任何东西，Finder 复制的文件只粘出一个文件名；从系统拖进来的文件被直接拒绝（`fileDrag.externalPathUnavailable`），只认应用内文件树的拖放；右键「粘贴」只读文字。
- ACP 节点：`acp.prompt` 只收 `text`，`session.ts` 永远只发一个 `text` 块；`initialize` 的 `promptCapabilities` 记在 core 里但页面拿不到；输入框没有附件入口，拖进来的文件落到画布上成了节点。
- 浏览器页面、桌面壳与经中继的远程源同一份前端，问题相同；远程源上「本机路径」对 Agent 没有意义，所以必须上传到会话所在的 core。

做了什么：

- core：`files/uploads.ts` + `upload-routes.ts`（`POST /api/workspaces/{id}/agent-uploads`，数据目录按工作空间隔离、名字只留安全字符、单文件 25 MiB、7 天与每工作空间 256 MiB 的清理）；`acp/attachments.ts` 把上传转成 `image` / 内嵌 `resource` / `resource_link`（按 `promptCapabilities` 与 SSH 判断）；`acp.prompt` 收 `attachments`，经桥的 `expectAttachments` 随同一次 `writeSubmit`（租约与授权不变）；镜像与 `acp.update` 只记链接；`acp.log` 多 `promptCapabilities`；协议 minor 升到 28。
- 终端（`terminal/file-paste.ts`、`surface/use-file-drop.ts`、`TerminalSurface.tsx`）：粘贴与系统拖放的文件上传后把路径以括号粘贴插入，一个文件一段、不加回车；Agent 会话给 TUI 的写法（安全字符原样、否则加引号、Windows 路径换正斜杠），普通 shell 按它的引用规则；Agent 正等人回答、启动输入未完成、SSH 节点时不粘；桌面壳本机源拖进来的磁盘文件直接用原路径。右键「粘贴」读得到剪贴板图片。
- 各 CLI 的实际方式（只读了本机安装包，没运行）：Claude Code 去掉引号与反斜杠转义后把以 `.png/.jpg/.jpeg/.gif/.webp` 结尾的粘贴当图片附上；Codex 把整段恰好是一个图片路径的粘贴附成图片。两家的 Ctrl+V 剪贴板图片只读 CLI 所在机器的系统剪贴板，远程源上不成立，所以统一走「上传 + 粘路径」。
- ACP 输入框（`acp/PromptAttachments.tsx`、`PromptBox.tsx`、`SessionView.tsx`）：粘贴、拖到会话视图任何地方、回形针选文件；图片缩略图、文件徽标，都可移除；Agent 不收图片、SSH 节点打不开本机文件、超限、超过 10 个时当场提示；发送时先上传再带 id 发 prompt，上传失败不发、草稿留着；本页先画的用户消息带附件。文案进 `i18n/acp.ts`、`i18n/file-drag.ts`，中英同步；错误码进 `MESSAGE_BY_CODE`。

实测：

- 单测 / 组件测试：`core/files/uploads.test.ts` 9、`core/acp/attachments.test.ts` 5（含真假 ACP Agent 子进程的路由用例：链接到达、正文不进镜像与事件、图片按能力拒绝、只有附件可发）、`core/relay/uploads.test.ts` 2（经假中继隧道上传 3 MiB，落在那台 core 的数据目录；匿名 401、超限 413）、`route-scopes.test.ts` +1；`terminal/file-paste.test.ts` 10、`TerminalSurface.file-drop.test.tsx` +4、`acp/PromptAttachments.test.tsx` 7。
- 探针 `tools/probes/agent-attachments-e2e.mjs`（`tools/ci/e2e.d/agent-attachments-e2e.json`，darwin / linux）：真 core + Vite + 无头 Chrome，假终端 Agent（`fixtures/fake-paste-cli.mjs`，开 2004、报每段粘贴与回车）收到恰好一段括号粘贴的上传路径、没有回车；普通 shell 拖入文件，路径插入未执行；假 ACP Agent（`fixtures/fake-acp-attach.mjs`，声明收图片与内嵌正文）收到 `text`、`image`（字节数对得上）与 `resource`，镜像只有两条链接；无控制台错误。本机 macOS 跑通。
- 开发构建的 Electron（隔离数据目录、HOME 与 profile，跑完按 PID 结束）：合成的截图粘贴上传并插入路径。

没做 / 限制：

- Electron 里「从 Finder 拖入、按原路径插入」只有单测覆盖：CDP 的 `Input.dispatchDragEvent` 没能在壳里触发文件拖放，真实拖放没有自动化；也没有用系统剪贴板测真 ⌘V（会覆盖使用者的剪贴板）。
- 经真个人中转的页面级探针没加：中转上传由假中继隧道上的用例覆盖（同一个 HTTP 接口）。
- 重发 / 编辑后重发只带文字，不带上一轮的附件；SSH 终端节点不支持粘文件。
- 用户消息里的图片缩略图只在本页内存里（`blob:`）；重载后是带名字的链接徽标。

## Claude Code mod M1：状态上报改走 mod、状态栏、版本门与环境回退（契约 §57，2026-10-10）

做了什么：

- 产物：`<数据目录>/integration/claude/` 多出 `settings-permission.json`（只有 `PermissionRequest`）与 `mod/`（`armadra-mod`：`.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/armadra.ts`）。生成器在 `core/hook/install/claude-mod/`（`template` / `transport` / `status`，`ui` / `commands` / `i18n` 是留给 M2 / M3 的空段）。`mod/` 在 core 每次启动时删掉重写，之后每次启动前只按字节比较。
- 模块：九个 `classic.*` 事件（设置 hook 的除 `PermissionRequest` 外全部）原样经 `$.http.fetch` 走 Unix socket POST 到 `/hook/claude`，socket 不通走 TCP 端口，都被拒就 `$.process.run` 起 `armadra-hook claude`；`classic.PreToolUse` 的工具调用信封拼回设置 hook 的形状。每个 hook 立即 `next(e)` 且带 `.catch`，`SessionEnd` 最多等 800 ms。交互式会话的状态栏只画节点名。`session.start` 发 hello（`POST /node/mod`），报告改走另一条路时再发；fetch 被拒时 hello 经新的 `armadra-hook mod-hello`。不注册 `PermissionRequest` / `tool.check` / `tool.call`，不调 `prompt.*` / `session.append`，token 只在函数局部。
- 门：`CLAUDE_MODS_MIN = 2.1.293`，读 `claude --version` 的探测缓存，未知即关；Windows、执行主机第一版不挂。门开时 `run/claude` 接 `--settings settings-permission.json` 与第二个 `--plugin-dir mod`，并在节点环境里有 `CLAUDE_CODE_SAFE_MODE` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 时改接全套设置 hook（`LauncherSpec.fallback`）。
- core：`terminalBinding` 可以不带 `sourceRevision`，core 在同样的门之后对同一个 `.seq` 计数器（同一把 `.lock`）代分配（`runs/reports.ts::allocateSourceRevision`）；`POST /node/mod` 的 hello 只存内存、每节点一条；`GET /api/agents/claude/integration` 带 `mods`；`GET /node/overlay` 进路由表、答 501（M2）。`INTEGRATION_REVISION` 改为 `<hook>×10000 + <mod>×100 + <skill>` = 50118；协议 minor 27 → 29。
- 探针 `claude-mod-launch`（A 档，`requires: ["claude"]`，CI 没有 Claude 时记 skipped；e2e 运行器新增 `claude` 需求）：真 core + 画布 Agent 终端里经 `run/claude` 跑真 Claude `-p`，模型是本机假 Messages API，假 key。`compatibility.json` 新增 `claudeMods`（`minVersion`、`verified`，不进围栏）。

实测（macOS arm64；本机全局 `claude` 是 2.1.287，低于门槛，没动它；2.1.293 与 2.1.295 用 `npm install --prefix /tmp/…` 装到临时目录验证）：

- 新单测：生成器 10（确定性、env 名全是字面量、无 `import()`、不出现权限 / 代答相关的名字、对垫片类型检查、在本进程里用假 `$` 跑：原样转发、PreToolUse 改形、socket → TCP → 客户端、hello 与再发、画布外与 ACP 不报）、注入 4（产物布局、版本门与 argv、启动器随探测缓存切换与环境分支、缺文件重写且不碰 Claude 写的 `types/`）、启动器 2（分支正文、真 `/bin/sh` 按环境选 argv）、ingest 3（代分配连续递增与 16 字节格式、非当前会话 / 未验证 / 多键丢弃、没有计数器时不带绑定）、hello 5、集成状态 2、客户端 `mod-hello` 1、e2e 运行器 1、compatibility 1。
- `ARMADRA_CLAUDE_PROBE=1` 下 2.1.293、2.1.295 的 `claude plugin validate`（无「gating hook without .catch」，env 读取全是 `ARMADRA_*`）与 `claude plugin test`（转发、fetch 被拒退回客户端、hello，共 3 条）全过。
- `node tools/probes/claude-mod-launch.mjs`：2.1.293、2.1.295 全过——hello 走 socket、节点状态 `done` 来自 `hook` 且已验证、可信报告的 `sourceRevision` 是 core 代分配的递增值；两个环境变量下启动器接的是全套设置 hook、没有 hello；2.1.293 上模块对引擎自带的 `.claude-plugin/types/` 类型检查通过（2.1.295 不再写类型文件）；`~/.claude/settings.json` 前后哈希一致。`--record-compat` 写入 `claudeMods.verified = 2.1.293–2.1.295`。
- `pnpm libs:build && pnpm -r --if-present test`：desktop 5486 / 69 跳（`parity-terminals` afterAll 超时与 `oauth` 一条 ECONNRESET 是负载下的偶发，单独重跑 59 条全过）、web 4240、shared 382、server 98 / 4 跳、mobile 10、push-relay 9；live 配置的 `passkey-cdp.live.integration.test.ts` 本机失败（同前几节），`node --test scripts/*.test.mjs` 73 / 2 跳。`pnpm --filter @armadra/web typecheck`、`pnpm check` 通过。

没做 / 偏离：

- 2.1.293 上 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 不再拒绝插件不带 `auth` 的 fetch（2.1.287 会），所以探针里「宿主拒绝 fetch → 客户端代报、hello 说 `process`」这条路在真 Claude 上走不到，只在 `claude plugin test` 与本进程单测里验证；`CLAUDE_CODE_SAFE_MODE` 在 2.1.293 连设置 hook 也不跑，回退后节点没有状态上报，这是 Claude 的行为。两条环境回退都保留。
- 状态栏只画节点名，画布名要等 M2 的 `/node/overlay`；交互式 TUI 里状态行的 `⚠` 前缀观感没有在 2.1.293 上截图确认。
- 集成页还不显示 mod 的状态（M2 的设置子页行）；「SessionStart 到了却没有 hello」的会话没有点名；集成页的「重新生成」没有顺手忘掉探测缓存。
- 计数器文件不存在时 core 不创建（与 hook 客户端同一条规矩），报告不带绑定照常归约；设计原写「没有也可创建」。
- CI 没有装 Claude，e2e 里这条记 skipped；没有用真实账号跑。

接口：

- core：`claudeModSource` / `claudeModManifest` / `claudeModHooks` / `MOD_PLUGIN_NAME` / `MOD_MODULE_FILE`、`claudeModPluginTest`；`CLAUDE_MODS_MIN`、`CLAUDE_MODS_BROKEN`、`CLAUDE_MODS_FALLBACK_ENV`、`claudeLoadsMods`、`claudeModsGate`、`probedClaudeVersion`、`resetClaudeMod`；`ArtifactLayout.{settingsPermission,modDir,modManifest,modHooks,modModule}`、`InjectionRequest.claudeVersion`、`Injection.fallback`、`injectionFromLayout(..., { claudeMods })`、`LauncherSpec.fallback`；`MOD_REVISION`；`allocateSourceRevision`；`HookService.recordModHello` / `modSessions`、`ModHello`、`parseModHello` / `receiveModHello`；`IntegrationState.mods`、`modsState`、`IntegrationOptions.modSessions`。
- 客户端：`armadra-hook mod-hello`（内部）。
- shared：`integrationModsSchema`、`modSessionSchema`、`MOD_GATE_REASONS`。
- 线上：§57（hook 的 `terminalBinding` 可缺 `sourceRevision`、`POST /node/mod`、`GET /node/overlay` 501、`agents.integration.mods`），协议 1.29。
- 工具：`tools/probes/claude-mod-launch.mjs`（`findClaude`、`--record-compat`）、e2e 需求 `claude`、`compatibility.json` 的 `claudeMods`、`tools/vendor/claude-mod-api.d.ts`。

## A7-3 签发方与设备分组（Refs #229）

做了什么：

- 设置「账号与共享」的成员行与待用邀请行标出签发方（来自哪个中转 / 本机）；「设备与会话」的已配对设备按来源分组，组头可折叠，显示来源与台数。
- 来源只读现有字段：本机 `sources.list` 的 `remotes[].issuer` 算出 `cloud:<SHA-256 前 16 位>`，与 `accounts.credentials.list` 里未撤销凭据的 `provider` 比对；对不上或读不到都算本机。邀请取 `issuedBy` 的来源，设备取 `principalId` 的来源。
- 全是本机来源时不多出任何一列或分组，界面与以前一致。不改 core 与契约。

实测：`pnpm --filter @armadra/web typecheck`；`src/panels/settings/pages` 下 39 个测试文件 276 条通过（新增：成员签发方显示 / 隐藏、设备分组与折叠、无中转不分组）。

没做 / 偏离：

- 邀请本身没有来源字段，显示的是签发者的来源；设备按来源分组，没有按 `(来源, 名字)` 合并同名设备（合并会藏起可撤销的行）。
- `listOrigins` 的摘要比对没有单测（依赖 WebCrypto），由页面测试替身覆盖。

接口：`api/accounts.ts` 的 `listOrigins`、`Origin`；`GatewayDevices` 的可选 `originOf`；i18n `sharing.origin.local`。

## 三端统一版本线（#245）

做了什么：

- `version.mjs` 只剩 `check / set / print`；`VERSION_SITES` 重新纳入 `apps/mobile/package.json`，删除 `mobile` 子命令与 `mobile-v*` 标签；`check` 一并校验原生工程派生、协议门槛（`compatibility.json` 的 `mobile.minimumHostProtocol`）与根 `CHANGELOG.md` 有本版本一节。`release:check` 只剩一条。
- `apps/mobile/package.json` 由 1.1.0 对齐到 0.2.6（本 PR 不改套件版本）；构建号仍是 `git rev-list --count HEAD`，单调递增、不回退。`app-version.mjs` 对预发布版本取 `X.Y.Z` 核心作商店版本名。
- `apps/mobile/CHANGELOG.md` 并回根 `CHANGELOG.md`（0.2.5、0.2.6 下的「手机与平板」小节）；nightly 的移动端产物名用统一版本；文档 `ci-release.md` §2.8 与 `.github/CONTRIBUTING.md` 写明版本规则。

实测：`version.test.mjs`、`app-version.test.mjs`、`pnpm release:test`、`release:check`、`ci:workflows`、`pnpm check`。

没做：下一次统一发版 0.3.0 由发布时 `version.mjs set 0.3.0` 完成。

接口：`version.mjs` 导出 `checkMobile({base, mobile})`（不再收 `tag`）、`checkChangelog`；移除 `mobileVersion`、`setMobileVersion`、`MOBILE_CHANGELOG`、`MOBILE_TAG_PREFIX`。
