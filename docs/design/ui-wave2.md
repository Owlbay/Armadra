# 界面第二波：设置重排、Agent 连线与布局、小地图、ACP 创建提速、并发启动

> 状态：**目标设计（2026-10-08）**，包 A（§1、§2.1–§2.3）已实施；基线 `main @ 20248839`（v0.2.2）。协议 `PROTOCOL_MINOR = 23`（`apps/desktop/src/core/identity/protocol.ts:12`），契约最大节号 §49（`docs/contracts/core-json-api.md:3542`），迁移最大编号 0043。上一轮 [ui-acp-refresh.md](ui-acp-refresh.md) A–E 已合入，本文在其上继续。
> 规范：`docs/design/design-system.md`（下称 DS）硬性规则 + `~/.claude/skills/better-*`；极简、无说明性文字、不中英混排、只用 `apps/web/src/ui/` 里的 shadcn 组件。
> 并行中的紧急修复 `fix/no-foreign-injection-cleanup`（core 只认本产品标记、启动迁移不碰用户 HOME）**不在本文重复设计**；§2.5 的 Agent CLI 页建立在它之上。
> 编号预分配：契约 **§50**（包 C2）、**§51**（包 D）、**§52**（包 E）；协议 **1.24** 由最后合入的包统一改。**不需要数据库迁移**（见 §9）。

## 0. 结论

| #   | 反馈                  | 结论                                                                                                                                                                                                                                                       | 包   |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 弹窗随窗口变大        | `--settings-dialog-w: max(760px, 80vw)`、`-h: max(560px, 82dvh)`，外层仍夹视口 −48；正文列去掉 960 封顶；导航 `clamp(176px, 16%, 240px)`                                                                                                                   | A    |
| 2   | 设置信息架构          | 8 组 18 页（§2.1），每页 `scope: device / host / account` 并在页头常驻一枚作用范围徽标；「默认」页置顶，首行是「Agent 默认视图」；终端外观独立成本设备页，字体是探测本机等宽字体的 `Select`；集成并入「Agent CLI」，一家一行、子页看细节、只展示本产品注入 | A、B |
| 3   | 连线两类              | 数据模型不变（`role: peer / supervises`）；渲染按 role：对等 = 中性色、就近边、标签「上下文」；派发 = 簇色、按布局方向走底→顶或右→左、无常驻标签；四边各一个把手；修 UI 改 role 后链接文档不跟随的缺陷                                                     | C1   |
| 4   | 纵向 / 横向布局       | `canvas.layoutDirection`（主机设置，缺省 `vertical`）；tidy 两个方向都让主居中于子；core `placement` 同方向放置；多主各成簇                                                                                                                                | C2   |
| 5   | 小地图配色、缩放 −/+  | `familyOf(document)` 纯函数：非 Agent 按类型、派发簇按根主取 `--node-color-n`、独立 Agent 用品牌色；同一函数给派发线上色；Dock 变成 `[−][NN%][+]`                                                                                                          | C1   |
| 6   | 删向导、派生直接创建  | 删 `add.newAgent` 项、`NewAgentWizard` 与 `wizard-open.ts`；节点菜单「派生 Agent」变子菜单（选哪家就建哪家的从）；从把手拖到空白处松手 = 在落点开同一个子菜单建从                                                                                          | C2   |
| 7   | ACP 创建慢            | 短期全做：先显示节点并允许输入（首条随 `createSession.prompt` 发）、`acp.starting` 阶段事件、`session/new` 60 s 截止、安装后与空闲时预热、菜单打开时预启动；长期（适配器池、多会话一进程）本轮不做                                                         | D    |
| 8   | 并发起多个 Codex 失败 | core 启动闸门按 (agentId, 配置目录) 排队，Codex 并发 1、放行条件 = 收到 SessionStart 或 6 s；失败自动重试一次；探测时穿透 mise / asdf 垫片填 `launchTarget`；不写用户 CLI 配置、不加 `--no-daemon`                                                         | E    |

---

## 1. 设置弹窗尺寸

### 1.1 现状

- `apps/web/src/styles/tokens.css:274-275`：`clamp(760px, 78vw, 1280px)` × `clamp(560px, 80vh, 960px)`，1920 以上封顶。
- `apps/web/src/panels/SettingsDialog.tsx:212`：正文列 `max-w-[960px]`，弹窗再宽内容也不变宽；`:162` 导航固定 200px。
- `apps/web/src/styles/tokens.test.ts:47-48` 与 DS §2.7 锁死旧值。

### 1.2 目标

| 项          | 值                                                         | 说明                                                                                                                                       |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 宽          | `--settings-dialog-w: max(760px, 80vw)`                    | 外层 `max-w-[calc(100vw-48px-安全区)]` 不变（`SettingsDialog.tsx:78-79`）：1280 → 1024；1440 → 1152；1920 → 1536；2560 → 2048；3840 → 3072 |
| 高          | `--settings-dialog-h: max(560px, 82dvh)`                   | 外层 `max-h-[calc(100dvh-48px-安全区)]` 不变：800 → 656；900 → 738；1080 → 886；1440 → 1181                                                |
| 导航        | `clamp(176px, 16%, 240px)`                                 | 1024 宽时 176，1500 以上 240                                                                                                               |
| 正文列      | 去掉 `max-w-[960px]`，`w-full`                             | `SettingsRow` 标签列 `max-w-[60%]`，控件靠右（现状）；表格页（远程机器、快捷键、设备与会话）天然受益                                       |
| 页头        | 64px 不变；右端加作用范围徽标（§2.3）                      |                                                                                                                                            |
| 平板 / 手机 | 不变（`SettingsDialog.tsx:80-81`、`SETTINGS_SHEET_CLASS`） |                                                                                                                                            |

落点：`tokens.css` 两条 token、`SettingsDialog.tsx:162,212`、`tokens.test.ts:47-48`、DS §2.7 那一行。

### 1.3 测试

- `tokens.test.ts`：两条 token 形如 `max(`；`SettingsDialog.test.tsx`：正文列 class 不含 `max-w-[960px]`，导航 class 含 `clamp(`。
- 探针 `tools/probes/design-showcase.mjs --only=components --width=1280,1920,2560`：弹窗宽度 = 80vw（±1px）。

---

## 2. 设置信息架构

### 2.1 新导航（`apps/web/src/panels/settings/nav.ts`）

每页加 `scope: "device" | "host" | "account"`；`ownerOnly` 只允许出现在 `host` 页，`device` 页对成员与远程源一律可见（它们写的是 localStorage）。

| 组（`groupKey`）                 | 页 id           | 页名         | scope   | 标记           | 内容（来源页）                                                                                                                                                       |
| -------------------------------- | --------------- | ------------ | ------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 常用 `settings.group.frequent`   | `defaults`      | 默认         | device  |                | **Agent 默认视图**（`agents.defaultDriver`，主机项，行尾「主机」徽标）、默认 Agent、默认权限模式、简洁模式；主题、语言（原 Agent 页 5 卡 + 通用页 2 行）             |
| 外观与交互 `settings.group.look` | `general`       | 通用         | device  |                | 侧栏默认展开、启动动画、恢复上次工作空间、显示系统文件、用量徽标（原「显示用量」）                                                                                   |
|                                  | `notifications` | 通知         | device  |                | 原 4 项 + 「更新下载完成」（从更新页移来）                                                                                                                           |
|                                  | `whiteboard`    | 画布         | device  |                | 原白板 14 项 + **布局方向**（`canvas.layoutDirection`，主机项，§4）；「实时协同」移到工作空间页                                                                      |
|                                  | `terminalLook`  | 终端         | device  |                | 字体选择器、字号、行高、字距、预览；光标、闪烁；Option 作 Meta、选中即复制；WebGL、渲染名额（§2.4）                                                                  |
|                                  | `browser`       | 浏览器       | device  | desktop、local | 不变                                                                                                                                                                 |
|                                  | `keybindings`   | 快捷键       | device  |                | 不变；本设备层对成员开放，全局层只对 owner 可写（页内按行判断，不再整页 ownerOnly）                                                                                  |
| Agent `settings.group.agent`     | `agents`        | Agent CLI    | host    | ownerOnly      | 一家一行 → 子页（§2.5）；合并原「集成」与原 Agent 页的三态、启动命令                                                                                                 |
|                                  | `customAgents`  | 自定义 Agent | host    | ownerOnly      | 原 Agent 页子页独立成页                                                                                                                                              |
|                                  | `sessions`      | 会话         | host    | ownerOnly      | 自动命名（本设备，行徽标）、索引范围、重建索引（从数据页移来，统一叫「会话索引」）                                                                                   |
|                                  | `credentials`   | 凭据与密钥   | host    | ownerOnly      | 节点凭据、Armadra Agent 模型密钥、Copilot 登录（从账号与用量移来）                                                                                                   |
|                                  | `usage`         | 用量与额度   | host    | ownerOnly      | 原「账号与用量」去掉 Copilot 登录                                                                                                                                    |
| 工作空间 `settings.group.space`  | `workspace`     | 工作空间     | host    | ownerOnly      | 默认 Agent 覆盖、允许执行命令、语言服务、**运行主机 + 切换**（从执行主机页移来）、实时协同                                                                           |
| 主机 `settings.group.host`       | `service`       | 本机服务     | host    |                | 连接状态（ID / 能力折进 `Collapsible`「诊断」）；终端会话策略（后端、休眠、节能、断开保留）；电源与资源；数据（目录、备份、日志保留）；崩溃上报。成员只见连接状态    |
|                                  | `machines`      | 远程机器     | host    | ownerOnly      | SSH + 执行主机合并成一张表（§2.6）                                                                                                                                   |
|                                  | `forge`         | 代码托管     | host    | ownerOnly      | 原「Git 托管」改名                                                                                                                                                   |
| 远程访问 `settings.group.remote` | `remoteAccess`  | 远程访问     | host    | ownerOnly      | 让别的设备访问本机（局域网直连 = Gateway；经中转 = 中转账号 + 分享本机 + 分享链接）；我连接的其他 Armadra（原「已挂载的源」）。固定操作本机 core，页头徽标写「本机」 |
|                                  | `devices`       | 设备与会话   | account |                | 当前设备登录（`HostIdentityPanel`）、已配对设备（Gateway）、登录会话（`SessionList`）                                                                                |
| 账号 `settings.group.account`    | `security`      | 账号与安全   | account |                | 两步验证、通行密钥、第三方账号、登录提供方、审计                                                                                                                     |
|                                  | `accounts`      | 账号与共享   | host    | serverOnly     | 不变                                                                                                                                                                 |
| 关于 `settings.group.about`      | `about`         | 关于         | host    |                | 版本（唯一出现处）、更新通道 / 自动检查 / 自动下载 / 检查结果 / 重启（原更新页）、开源许可                                                                           |

删除的页 id：`agent`、`integration`、`terminal`、`host`、`remote`、`github`、`ssh`、`executionHosts`、`data`、`account`、`updates`。

### 2.2 旧页 → 新页迁移映射（功能一项不丢）

| 旧页 / 项（审计第二节行号）                                     | 新位置                                     |
| --------------------------------------------------------------- | ------------------------------------------ |
| 通用 · 主题、语言（`GeneralPage.tsx:61,83`）                    | 默认                                       |
| 通用 · 其余 5 项、崩溃上报                                      | 通用；崩溃上报 → 本机服务                  |
| 通知 · 全部                                                     | 通知                                       |
| 白板 · 14 项；实时协同（`:238`）                                | 画布；实时协同 → 工作空间                  |
| Agent · 三态、启动命令（`AgentPage.tsx:150-193`）               | Agent CLI 子页                             |
| Agent · ama 密钥、节点凭据（`:195,362`）                        | 凭据与密钥                                 |
| Agent · 默认 Agent、默认权限、缺省视图、简洁模式（`:198-286`）  | 默认                                       |
| Agent · 自动命名、索引范围（`:288-333`）                        | 会话                                       |
| Agent · 自定义 Agent（`:333`）                                  | 自定义 Agent                               |
| 集成 · Worker 卡（`IntegrationPage.tsx:70,112-156`）            | 远程机器（已有，删）                       |
| 集成 · 五行 / 修复                                              | Agent CLI 子页（§2.5）                     |
| 终端 · 后端、休眠、节能、断开保留（`TerminalPage.tsx:126-223`） | 本机服务 · 终端会话                        |
| 终端 · 电源、资源、内存阈值（`:250-323`）                       | 本机服务 · 电源与资源                      |
| 终端 · 渲染名额、字体…选中即复制（`:351-476`）                  | 终端（外观）                               |
| 浏览器                                                          | 浏览器                                     |
| 工作区 · 全部；执行主机 · 当前工作区 + 切换（`:126-151`）       | 工作空间                                   |
| 后台服务 · 检查连接、连接详情                                   | 本机服务 · 连接状态（详情折叠）            |
| 后台服务 · Gateway、配对二维码、CA 引导                         | 远程访问 · 让别的设备访问本机 · 局域网直连 |
| 后台服务 · 已配对设备、设备登录                                 | 设备与会话                                 |
| 远程服务 · 中转账号、分享本机、分享链接                         | 远程访问 · 让别的设备访问本机 · 经中转     |
| 远程服务 · 已挂载的源、三个加入入口                             | 远程访问 · 我连接的其他 Armadra            |
| 账号与共享 · 全部                                               | 账号与共享                                 |
| 安全 · 会话                                                     | 设备与会话 · 登录会话                      |
| 安全 · 其余                                                     | 账号与安全                                 |
| Git 托管                                                        | 代码托管                                   |
| SSH · 主机表、测试连接、测试 Worker、打开远程项目               | 远程机器（§2.6）                           |
| 执行主机 · 主机列表、验证、重新同步、导入 / 导出                | 远程机器                                   |
| 数据 · 目录、大小、备份、日志保留                               | 本机服务 · 数据                            |
| 数据 · 对话索引重建                                             | 会话                                       |
| 账号与用量 · Copilot 登录                                       | 凭据与密钥                                 |
| 账号与用量 · 其余                                               | 用量与额度                                 |
| 快捷键                                                          | 快捷键                                     |
| 更新 · 通道、自动检查、自动下载、检查结果、重启                 | 关于                                       |
| 更新 · 下载完成后通知                                           | 通知                                       |
| 关于                                                            | 关于                                       |

存储的 `lastSettingsSection` 可能是旧 id：`nav.ts` 加 `LEGACY_SECTION_IDS: Record<string, string>`（`agent → defaults`、`integration → agents`、`terminal → terminalLook`、`host → service`、`remote → remoteAccess`、`github → forge`、`ssh → machines`、`executionHosts → machines`、`data → service`、`account → usage`、`updates → about`），`isSettingsSectionId` 先映射再判断。`openSettings(section)` 的调用方（`grep -rn 'setPanel("settings"\|openSettingsSection' apps/web/src`）逐个改成新 id。

### 2.3 页头作用范围

页头右端（关闭钮左侧）一枚 `Badge variant="outline"`，不可点：

| scope   | 本机源 | 远程源（经中继 / 直连 / 挂载源） |
| ------- | ------ | -------------------------------- |
| device  | 本设备 | 本设备                           |
| host    | 主机   | 主机 · {源名}（`Source.name`）   |
| account | 账号   | 账号 · {源名}                    |

`remoteAccess` 页固定操作本机 core（`api/remote-services.ts:32`），徽标恒为「本机」。页内个别行与页 scope 不同（如「默认」页里的 Agent 默认视图是主机项、「会话」页里的自动命名是本设备项）时，行尾一枚同样式的小徽标，复用 `LocalSourceBadge` 的位置（`local-source.tsx:35-50`）但不同的键。文案键（`i18n/modals.ts`）：`settings.scope.device`「本设备」/ "This device"、`settings.scope.host`「主机」/ "Host"、`settings.scope.hostNamed`「主机 · {name}」、`settings.scope.account`「账号」/ "Account"、`settings.scope.accountNamed`、`settings.scope.local`「本机」/ "This machine"。原 `settings.source.local`（worker-settings 文件标记）保留。

### 2.4 终端外观页

```text
┌ 字体与排版 ───────────────────────────────────────────────┐
│ 字体          [跟随系统            ▾]                     │  Select：跟随系统 / 探测到的等宽字体… / 自定义…
│ 自定义字体栈  [________________________]                  │  只在选「自定义…」时出现；占位 = 当前生效的 --font-code
│ 字号          [12]    行高 [1.15]    字距 [0]             │  三个 Input number 同一行（范围 10–20 / 1–1.6 / −2–4 步 0.5）
│ ┌ 预览 ────────────────────────────────────────────────┐ │  一行 <pre>，用当前字体 / 字号 / 行高 / 字距渲染
│ │ ~/project % git status  0123456789 中文等宽           │ │
│ └──────────────────────────────────────────────────────┘ │
├ 光标 ─────────────────────────────────────────────────────┤
│ 光标 [块 ▾]   闪烁 [Switch]                               │
├ 键盘 ─────────────────────────────────────────────────────┤
│ Option 作 Meta [Switch]   选中即复制 [Switch]             │
├ 渲染 ─────────────────────────────────────────────────────┤
│ WebGL [Switch]   渲染名额 [Input]                         │
└───────────────────────────────────────────────────────────┘
```

- 探测（`apps/web/src/terminal/surface/fonts.ts`，新，纯函数 + 一个 hook）：候选名单 `MONOSPACE_CANDIDATES`（SF Mono、Menlo、Monaco、JetBrains Mono、Fira Code、Cascadia Code、Cascadia Mono、Consolas、Source Code Pro、Hack、IBM Plex Mono、Iosevka、Ubuntu Mono、DejaVu Sans Mono、Noto Sans Mono、Sarasa Mono SC、Maple Mono、MesloLGS NF、Courier New）；每个用 `document.fonts.check("12px 'X'")` 加 canvas 宽度比对（`iiii` 与 `MMMM` 等宽且与 `monospace` 回退不同宽）过滤。桌面壳里 `navigator.queryLocalFonts` 可用时（`isDesktop()`）并入其 `fullName`，同样过等宽比对；浏览器里不调它（要手势授权）。结果缓存在模块级 Promise，设置页打开时算一次，`>300ms` 才显示 `Skeleton`（DS §3.2）。
- 存储不变：`armadra.terminal.fontFamily`（`preferences/terminal.ts:69`）。Select 值：`""` = 跟随系统；某个探测到的名字；`custom` = 自定义（此时存自由文本）。读回时若存的文本正好是探测到的名字就落到那一项，否则落「自定义…」。
- 字距：`letterSpacing` 已有存储与范围（`preferences/terminal.ts:82`），只补 UI。
- 不做：内置字体文件（`tokens.test.ts:344` 禁 `@font-face`）、连字、粗体字重。
- 文案键（`i18n/terminal.ts`）：`terminal.settings.fontSystem`「跟随系统」/ "System"、`terminal.settings.fontCustom`「自定义…」/ "Custom…"、`terminal.settings.fontStack`「自定义字体栈」/ "Font stack"、`terminal.settings.letterSpacing`「字距」/ "Letter spacing"、`terminal.settings.preview`「预览」/ "Preview"、`terminal.settings.previewSample`（样例行，中英各自一行，不混排）、`terminal.settings.group.type`「字体与排版」、`.cursor`「光标」、`.keyboard`「键盘」、`.render`「渲染」。

### 2.5 Agent CLI 页（合并集成，建立在 `fix/no-foreign-injection-cleanup` 之上）

主表（一家一行，`SettingsGroup` 内 `SettingsRow`，点整行进子页）：

```text
Claude Code     可用                    会话视图 · 终端视图          [启用 ▾]   ›
Codex           需安装                  —                            [安装]     ›
Pi              需更新                  仅终端视图                   [更新]     ›
```

| 列     | 取值                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态   | `可用`（CLI 已装且注入正常）/ `需安装`（`!installed`）/ `需更新`（`integration.stale` 或版本低于兼容区间）/ `已禁用`（三态 = 禁用）。正常时不画任何徽标 |
| 驱动   | `canvasAgents` 的四种（现有键 `integration.canvasAgents.*`）；都不可用时写「—」                                                                         |
| 主动作 | 需安装 → `secondary`「安装」；需更新 → `secondary`「更新」（= 重新生成或重新安装，按原因选）；可用 → 三态 `Select`（默认 / 启用 / 禁用，本设备项）      |

子页（`settings/subpage.ts` 现有推入机制，页头「← Claude Code」）：

```text
┌ 启动 ─────────────────────────────────────────┐
│ 启用          [默认 ▾]                 本设备 │
│ 启动命令      [________________]       本设备 │
├ 安装 ─────────────────────────────────────────┤
│ CLI           已安装 · 2.1.0      [重新安装]  │   ← 悬停 title = resolvedPath
│ ACP           已安装 · 0.88.0     [重新安装]  │
├ 画布注入 ─────────────────────────────────────┤
│ 画布注入                          [重新生成]  │   ← 只写数据目录里的产物状态（hook / skill / stale / launcherWarning）
│ 在画布中创建 Agent  会话视图 · 终端视图       │
│ 本地历史      索引 · 成本 · 转录              │
└───────────────────────────────────────────────┘
```

- 「清理旧版本残留」只在 `integration.legacy.found.length > 0` 时在画布注入行出现第二个动作（`outline`），弹层列表只含本产品标记的条目（fix 分支保证），文案 `integration.action.cleanupLegacy`「清理旧版本残留 {count}」/ "Clean up old entries {count}"。不再有红色「修复」。
- 删除：页首 `OutdatedWorkers`（`IntegrationPage.tsx:70,112-156`，功能在远程机器页）；`integration.migrated.notice` 一次性 toast 改为只在 fix 分支定义的「本产品旧安装」被清理时出现。
- 现有 `pages/integration/*` 组件拆成主表 `AgentsPage.tsx` 与子页 `AgentDetailPage.tsx`；`AgentPage.tsx` 删除（内容已分到默认 / 会话 / 凭据 / 自定义 Agent）。
- 文案键新增：`agents.nav`「Agent CLI」、`agents.state.ready`「可用」/ "Ready"、`agents.state.installNeeded`「需安装」/ "Install needed"、`agents.state.updateNeeded`「需更新」/ "Update needed"、`agents.state.disabled`「已禁用」/ "Disabled"、`agents.action.update`「更新」/ "Update"、`agents.group.launch`「启动」、`agents.group.install`「安装」、`agents.group.injection`「画布注入」。

### 2.6 远程机器页（SSH + 执行主机）

一张 `Table`（手机 `Item`）：名称 · 地址（user@host:port）· Worker（版本或「过期」`Badge destructive`）· 工作区数 · 动作「验证」（合并原「测试连接」与「测试 Worker」「验证」为一步：先 SSH 后 Worker，结果一行文字）。行点进子页：连接参数（原 `SshPage` 表单）、「重新同步」、「在这台机器上打开项目」（原 `SshPage.tsx:190-205`）、事件表（原 `FleetGroup`）。表尾：「添加」default、「全部重新同步」ghost、「导入 / 导出」ghost。当前工作区在哪台与切换不在此页（在工作空间页）。

### 2.7 远程访问页

```text
┌ 让别的设备访问本机 ─────────────────────────────────────┐
│ 局域网直连          [Switch]                             │  开 → 监听地址 / 端口 / 证书 / 配对二维码 / 已配对设备入口（跳设备与会话）
│ 经中转              [Switch]                             │  需要先有中转账号：没有时此行动作是「添加中转账号」；开 → 分享链接列表
├ 中转账号 ──────────────────────────────────────────────┤
│ relay.example.com   user   已登录            [登出]      │
│                                              [添加]      │
├ 我连接的其他 Armadra ───────────────────────────────────┤
│ 本机                                                     │
│ 家里的 Mac mini     经中转   已连接          [断开]      │
│ [通过链接加入] [添加自托管] [从中转添加]                 │
└──────────────────────────────────────────────────────────┘
```

两个开关并排说明「谁连进来」的两条路，不写解释段（DS §1 第 5 条）。术语替换：「源」→「其他 Armadra」、「挂载」→「连接」、「签发方」只在二维码弹层里出现。

### 2.8 测试

- `nav.test.ts`：18 页；`device` 页对成员与远程源可见；`host + ownerOnly` 页对成员不见；`LEGACY_SECTION_IDS` 每个旧 id 都映射到存在的新 id；每页 `scope` 必填。
- `SettingsDialog.test.tsx`：页头徽标按 scope 与远程源名渲染。
- 每个新页一份 `*.test.tsx`：渲染出迁移映射表里该页应有的行（用文案键断言），保证不丢项。
- `fonts.test.ts`：候选过滤对假的 `document.fonts.check` 返回正确；`queryLocalFonts` 缺席时不抛。
- `i18n.test.ts` 四条守卫自动覆盖中英同步；删除旧键前 grep 引用。

---

## 3. Agent 连线：上下文与派发

### 3.1 现状问题

| 位置                                                         | 问题                                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/canvas/flow/edges/LinkEdge.tsx:151`            | 标签 `t(view.labelKey)` 来自 `linkView(…, sourceType, targetType)`，不看 `data.role`；主从线也写「⇄ 上下文」                                         |
| `flow/edges/link-visual.ts:45-58`、`sync/project.ts:303-312` | `edgeLabelKey` 只按端点类型                                                                                                                          |
| `flow/edges/link-path.ts:37`                                 | `edgeGeometry(…, "horizontal")` 固定，主从线不能走底 → 顶                                                                                            |
| `LinkEdge.tsx:144-150`                                       | 主从线一律 `--brand`，不分簇                                                                                                                         |
| `flow/nodes/ConnectionHandles.tsx:87-110`                    | 只有左右两个起笔把手                                                                                                                                 |
| `apps/web/src/canvas/context-links.ts:43-62,88-102`          | 推送的链接项无 `role`，`sameLinks` 不比 role；core `putContextLinks` 保留旧 role（`core/canvas/context-links.ts:97-110`）→ UI 改主从后投递授权不跟随 |
| `LinkEdge.test.tsx:215-231`                                  | 没有断言主从线的标签                                                                                                                                 |

### 3.2 渲染规则（按 role）

| 项   | 对等（`peer` / 缺省）                           | 派发（`supervises`）                                                                                                                     |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 锚点 | `"free"`：按两端中心连线主方向选边（就近边）    | 按布局方向：`vertical` → `"vertical"`（主底边 → 子顶边）；`horizontal` → `"horizontal"`（主右 → 子左）；同侧多条线共用一个出点，自然扇出 |
| 颜色 | `--muted-foreground`；选中 / 投递闪动 `--brand` | 簇色 `familyOf(document).get(source).color`（§5.1）；选中 `--brand`                                                                      |
| 线宽 | 2 / 选中 3.5（不变）                            | 2 / 选中 3.5                                                                                                                             |
| 箭头 | 按端点类型（不变）                              | 只在子那一端                                                                                                                             |
| 标签 | 按端点类型（`edge.context` 等，不变）           | **无常驻标签**；选中时显示 `edge.role.dispatch`「派发」/ "Dispatch"                                                                      |
| 提示 | 投递提示（不变）                                | 「主 @a → 从 @b」+ 投递提示（不变）                                                                                                      |

实现：

- `geometry.ts:57-70` `facingSides` 的 `anchor` 增加 `"vertical"`（只走上下）。
- `link-path.ts::linkCurve(source, target, anchor)` 增加参数；`link-visual.ts::linkView` 增加 `role` 与 `anchor`，`role === "supervises"` 时 `labelKey = null`。
- `LinkEdge.tsx`：`anchor = supervises ? (direction === "vertical" ? "vertical" : "horizontal") : "free"`；`direction` 来自 `useLayoutDirection()`（§4.3，包 C2 提供；C1 先用常量 `"vertical"`，C2 换成 hook，这是两包唯一允许的交叉行）；颜色从 `useFamilyColor(source)` 取。
- `edge.context` 文案改「上下文」（去掉 `⇄`，箭头已由线表达；英文 "Context"）。
- DS §4「连线 `link` 主从」行改为本节。

### 3.3 四边把手

`ConnectionHandles.tsx` 的非 `dropOnly` 节点挂 `top / bottom / left / right` 四个 `type="source"` 把手（`SOURCE_ONLY` 不变），`data-side` 四值；`nodes.css:29-74,180-185` 补 `top / bottom` 的定位（`left: 50%; transform: translateX(-50%)`，上 `top: calc(size * -0.5)`，下 `bottom: …`）与命中区。`aria-label`：四个都用 `node.linkHandle`「连线」/ "Link"（去掉「接收 / 发出上下文」：四个把手不分进出）。文件、编辑器、浏览器、便签、差异、自动化节点都走同一组件，自动得到四个把手；分组与白板对象仍 `dropOnly`。几何不读把手坐标（现状），所以从哪个把手起笔不影响最终走线。

### 3.4 修 UI 改 role 后投递授权不跟随

- `apps/web/src/canvas/context-links.ts::buildLinkDocuments`：每一项带 `role`：边 `supervises` 时 owner 是 `source` → `"sub"`，owner 是 `target` → `"main"`；对等边 → `"peer"`。`sameLinks` 比较 `role`。
- core 不改：`putContextLinks` 收到带 role 的项就落（`core/canvas/context-links.ts:106-109`）。
- 测试：`context-links.test.ts`（web）三种边各一条；core `collab/roles.test.ts` 加「页面推送 `main/sub/peer` 后 `send` 的 `UPWARD_SEND_REFUSED` 跟着变」用例（走 `putContextLinks` + `send.ts:978-985` 的判定）。
- 顺带确认「界面改主从方向后投递授权是否跟随」：修后 `setEdgeRole` / `reverseEdge` / 命名对话框三条路径都经 `usePublishContextLinks` 重推（`context-links.ts:110-121` 订阅 `edges`），400ms 内生效。

### 3.5 测试

- `LinkEdge.test.tsx`：supervises 时无 `<text>`；选中时文字为「派发」；颜色等于簇色变量；`vertical` 时 `sourceY === source.y + source.height`。
- `geometry.test.ts`：`facingSides(…, "vertical")` 只返回 top / bottom。
- `ConnectionHandles.test.tsx`：四个 `data-side`。
- 文案键：`edge.role.dispatch`、`node.linkHandle`；删 `node.linkIn / node.linkOut`。

---

## 4. 布局方向与整理

### 4.1 现状

- `apps/web/src/canvas/tidy.ts:330-380` `layoutTree` 只有横向、子顶对齐根（不居中）。
- core `collab/control/board.ts:171-193` `placement` 放调用者右侧一列、冲突时 `y += PLACEMENT_STEP`。
- `apps/web/src/acp/NewAgentWizard.tsx:47-75` `spawnPosition` 同样右侧。

### 4.2 设置项 `canvas.layoutDirection`（契约 §50）

- 主机设置（`settings.json`，`core/settings/completion-settings.ts` 旁加 `canvas: { layoutDirection: "vertical" | "horizontal" }`，缺省 **`vertical`**）。放主机而不是本设备：core 的 `placement` 要读它，且同一块画布在手机与桌面上应该排法一致。
- 页面：画布页一行「布局方向」`Select`（纵向 / 横向）；Dock「整理」钮右键菜单两项「纵向整理」「横向整理」做一次性覆盖（不写设置）。
- `useLayoutDirection()`（`apps/web/src/canvas/layout-direction.ts`，新）：读 `useRuntimeSettings`，缺省 `vertical`。
- 契约 §50 写：`settings.get / settings.update` 的 `canvas.layoutDirection`；`collab/control` 的 `open-agent` / `team` 放置遵循它。无事件。

### 4.3 tidy（`tidy.ts`，接口 `tidy(boxes, links, options)` 加 `options.direction`）

`layoutTree` 改成「主轴 / 交叉轴」通用：

| 方向       | 深度沿    | 同层沿    | 居中                                                                                                                    | 附件（对等边连着的非 Agent 单元）                                  |
| ---------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| vertical   | y（向下） | x（向右） | 自底向上算每棵子树的交叉轴跨度 `span = max(自身宽, Σ子 span + (n−1)·COLUMN_GAP)`；父 `x = 子块起点 + (span − 自身宽)/2` | 挂在宿主**右侧同一行**（`x = 宿主右 + COLUMN_GAP`），计入宿主 span |
| horizontal | x（向右） | y（向下） | 同上换轴：父 `y = 子块起点 + (span − 自身高)/2`（替代现在的顶对齐）                                                     | 宿主**正下方**（现状）                                             |

多主各成簇（现状 `treeClusters` 不变），簇之间仍按阅读顺序裹行。幂等性保持（§6.4 第 2 步的阅读顺序不受方向影响）。

### 4.4 core 放置（`board.ts::placement(document, callerId, direction)`）

- `vertical`：子行 `y = 主底 + ROW_GAP(48)`；`x` = 主已有子节点中最右者的右边 + COLUMN_GAP(60)，没有子节点时 `x = 主 x`；重叠检测用包围盒相交（替换现在的「坐标相差 < 24」），冲突则 `x += 节点宽 + 60`，64 次后放到所有节点最下方。
- `horizontal`：现状规则，但重叠检测同样改成包围盒。
- `team` 多成员一次放：同一行依次排；`--gather` 的汇总节点放在成员行再下一行、居中。
- 不在放置时移动已有节点（居中只在 tidy 时做）。
- 页面侧「派生」直接创建（§6）复用同一规则：抽成 `packages/shared/src/domain/placement.ts` 纯函数 `dispatchPlacement(nodes, parentId, size, direction)`，core 与页面共用。

### 4.5 测试

- `tidy.test.ts`：(a) vertical 一主三从 → 子同一行、等距、主 x 居中于子块；(b) horizontal 一主三从 → 主 y 居中；(c) 两方向各自幂等；(d) 附件位置按方向；(e) 两棵树不重叠。
- `placement.test.ts`（shared）：两方向各三条，含冲突回避。
- core `collab/control/nodes.test.ts`：`team` 三成员在 vertical 下 y 相同、x 递增。

---

## 5. 小地图配色与缩放按钮

### 5.1 簇色函数 `familyOf`（`apps/web/src/canvas/family.ts`，新，纯函数）

输入 `BoardDocument`，输出 `Map<nodeId, { kind: "cluster" | "agent" | "type"; rootId?: string; color: string }>`：

1. 只取 `role: "supervises"` 的边，按 `supervision.ts:45-52` 的「先到的赢」建森林，找每棵树的根。
2. 根按 id 排序（uuidv7 单调，即创建顺序），第 i 棵树的簇色 = `var(--node-color-${(i % 7) + 1})`（`packages/shared/src/domain/primitives.ts:31-39` 的七色；DS §2.5 前七条同值）。树上所有成员（根与子孙）都用这个色。两棵树颜色可能在第 8 棵起重复，可接受。
3. 不在任何树上的 Agent 节点：`var(--agent-${agentId})`（DS §2.4，自定义 Agent 用注册表 `color`）。
4. 非 Agent 节点按类型：`--mm-sticky / --mm-editor / --mm-files / --mm-browser / --mm-diff / --mm-automation / --mm-group`（新 token，`tokens.css` 两套主题；深色建议 `#e3c35a / #8e8e93 / #7f9bb3 / #5ac8fa / #c8a2ff / #b0b86a / 透明 + 1px --border`，浅色各压暗 20%；只做图形，不需 4.5:1）。

同一函数给 §3.2 的派发线上色；节点头色点仍是 Agent 品牌色（DS §1 第 7 条：标识色只说「是谁」，簇色说「谁派的」，两者不互借）。

### 5.2 小地图（`flow/Minimap.tsx:94-111`）

- `minimapFill`：填充 = `familyOf` 的颜色按 `color-mix` 取 55%（选中 80%）；分组 35%。
- 描边：状态三色不变（`minimapStroke`）；派发簇成员无状态时描边用簇色 100%，对等边不改任何颜色——于是「同一主的从同色」「不同主不同色」「上下文不改色、派发改色」三条都成立。
- `familyOf` 结果用 `useMemo` 按 `document.edges / nodes` 缓存，Minimap 与 LinkEdge 共享一个 store 选择器 `useFamilyColor(nodeId)`。

### 5.3 缩放控件（`shell/Dock.tsx:203-240`）

`[−] [NN%] [+]`：两侧 `IconButton size="dock"`（lucide `Minus` / `Plus`），点击 `zoomByStep(∓1)`（`use-flow-viewport.ts:92`）；Tooltip 用 `cmd.canvas.zoomOut / zoomIn` 并显示快捷键；到 `MIN_ZOOM / MAX_ZOOM` 时对应钮 `disabled`。百分比钮行为不变（单击适应、右键档位），档位扩成 `[0.25, 0.5, 0.75, 1, 1.5, 2]`。

### 5.4 测试

- `family.test.ts`：两棵树不同色、树内同色、独立 Agent 用品牌色、非 Agent 按类型、根顺序稳定。
- `Minimap.test.tsx`：`nodeColor` 对簇成员返回簇色 `color-mix`。
- `Dock.test.tsx`：−/+ 调用 `zoomByStep`；边界禁用。
- 展示页 `sections/canvas.tsx` 加「两簇 + 独立 Agent + 便签」固定状态，探针两主题截图。

---

## 6. 删除向导、派生直接创建

### 6.1 删除

- `canvas/menus/add-menu.ts:203-209` 的 `add.newAgent` 项；`acp/NewAgentWizard.tsx`、`acp/wizard-open.ts`、`showcase/sections/wizard.tsx`、`showcase/fixtures/wizard.ts`；`i18n/acp.ts:101-111` 的 `wizard.*` 键（`wizard.install.*` 若被 `adapter-install.tsx` 的 `WizardInstallButton` 引用，先把那枚按钮改用 `integration.action.*` 键）；`EmptyCanvas.tsx` 与 `app/commands.ts` 里对 `add.newAgent` 的引用随 `buildAddMenu` 自动消失，grep 确认。
- DS §5.3「新建 Agent 向导」整节删除。

### 6.2 「派生 Agent」= 直接创建

节点头 `···` 菜单（`nodes/terminal-menu.ts:68`）的「派生 Agent…」改成 `DropdownMenuSub`「派生」：子项 = `buildAddMenu` 的 `agentItems`（同一份可用性与禁用原因），第一项是与父节点同一家。选中后一步完成（`beginCoalesce("canvas.spawn")`）：

1. `addNode("terminal", { position: dispatchPlacement(nodes, parentId, size, direction), title, data: { agent: { id, permissionMode: 父的, driver: preferredDriver } } })`；父在分组里时新节点进同一组。
2. `addEdge({ source: parent, target: new, role: "supervises" })`。
3. 链接文档由 `usePublishContextLinks` 自动推送（带 role，§3.4），core 侧 `send` 授权立即成立。
4. `revealCreatedNode(new)`。

与 Agent 自己 `canvas open-agent` 的结果一致（头部「主 · N 从」胶囊立刻出现）。

### 6.3 拖线创建

React Flow `onConnectEnd` 落在空白 pane（`connectionState.toNode === null`）时：在落点打开 `AddMenuContent`（现有组件）的「派发」形态——只列 agentItems，菜单顶部一行 `DropdownMenuLabel`「派发自 @{name}」。选中后执行 §6.2 的四步，位置用落点（`centeredAt`）而不是 `dispatchPlacement`。Esc 或点空白关闭不建。这一条只对 Agent（terminal 带 `agent`）节点起笔的连线生效；从便签等节点拖到空白不弹。

文案键（`i18n/nodes.ts`）：`node.menu.spawn`「派生」/ "Spawn"、`node.menu.spawnFrom`「派发自 @{name}」/ "Dispatch from @{name}"；删 `node.menu.spawnAgent`。

### 6.4 测试

- `terminal-menu.test.ts`：子菜单项数 = 可用 Agent 数；选中后 store 多一个节点与一条 `supervises` 边，撤销一次全回。
- `FlowWorkspace` 或新 `use-connect-end.test.tsx`：空白落点弹菜单；非 Agent 起笔不弹。
- `add-menu.test.ts`：不再有 `add.newAgent`。

---

## 7. ACP 创建提速

### 7.1 现状

- `apps/web/src/acp/SessionView.tsx:46-100` `useAcpSession`：`createSession` 返回前 `starting`，`:665` `PromptBox disabled={!connected || !sessionId || …}`，`:540-544` 只有骨架。
- `core/acp/host.ts:294` `opener.newSession(options.cwd)` 无 signal；`initialize` 有 30 s（`:53,389`）。
- `core/acp/routes.ts:289,346-352` 已支持 `prompt` 字段，开好会话后 `writeSubmit`。
- `core/acp/index.ts:415-419` stderr 只记字节数。

### 7.2 本轮实现范围（短期方案全做）

| 项                 | 设计                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 先显示、先输入     | `PromptBox` 在 `starting` 期间**可输入**（`disabled` 去掉 `!sessionId` 这一项，只在 `!connected` / `failed` 时禁用）。发送时若还没有 `sessionId`：把文本存进 `pendingPrompt`，`useAcpSession` 的 `createSession` 若尚未发出就把它放进 `prompt` 字段一起发；已发出则等 `sessionId` 回来后走 `POST …/prompt`（现有 `clientTurnId` 去重）。消息流里先画出用户气泡（`optimistic`，与 §39.9 的「确认中」同一条路） |
| 阶段提示           | 骨架区上方一行 11px 灰字 + `Spinner 12`：`acp.starting.spawn`「启动适配器」/ `initialize`「连接」/ `session`「加载配置」/ `configure`「应用设置」；来自新事件 `acp.starting`（§7.3）。冷启动（§7.2 第 4 行）时 `session` 阶段超过 3 s 追加「首次启动较慢」`acp.starting.cold`                                                                                                                                 |
| `session/new` 截止 | `host.ts:294` 带 `AbortSignal.timeout(SESSION_NEW_TIMEOUT_MS = 60_000)`；超时 → `AcpError("acp_session_timeout", …)`，进程 terminate；页面 `Alert destructive`「启动超时」+「重试」                                                                                                                                                                                                                           |
| 预热               | (a) `adapter-install.ts` 安装 / 升级成功后、(b) core 启动后空闲 10 s、(c) 每次 `agents.list` 发现适配器版本变化后：对每家已装适配器跑一次 `probeAcp`（只到 `initialize`）并执行一次适配器自带 CLI 的 `--version`（Claude：SDK 包内 `claude`；Codex：`node_modules/@openai/codex` 的 bin），把 macOS 首次执行扫描与换页提前。串行、每家最多 1 次 / 10 分钟，受 §8 的闸门约束                                   |
| 菜单打开时预启动   | 右键 / Dock `+` 菜单打开时，对**默认 Agent**（`defaultAgentId`，只这一家）调 `POST /api/acp/prestart { workspaceId, agentId }`：core spawn 并完成 `initialize`，挂在 `(agentId, workspaceId)` 的池里，10 s 没被 `createSession` 领走就收掉；领走 = `createSession` 发现池里有同家同工作空间的进程就直接 `session/new`。节点带凭据（§26.4）时不领                                                              |
| 耗时日志           | `startAcp` 记 spawn / initialize / session / configure 各段毫秒到 info 日志；解析适配器 stderr 里 `[session/create] phase=<名> durationMs=<n>` 只取名字与数字，不记正文                                                                                                                                                                                                                                       |
| 缓存解析           | `resolveCommand` / `agentPath` 以 `PATH + mtime` 为键缓存（<5 ms，顺手）                                                                                                                                                                                                                                                                                                                                      |

长期方案（常驻适配器池、预建会话池、一进程多会话、`session/resume` 优先）本轮不做；预启动池已是适配器池的最小形态，后续扩展不改契约形状。

### 7.3 契约 §51（协议 1.24）

- 事件 `acp.starting { nodeId, phase: "spawn" | "initialize" | "session" | "configure", at }`，每阶段开始时发一次；`acp.driver` 之前、`acp.update` 之前。
- `POST /api/acp/sessions` 新错误码 `acp_session_timeout`（60 s）；`prompt` 字段语义不变，文档补「页面在会话就绪前输入的第一条随此字段发出」。
- `POST /api/acp/prestart { workspaceId, agentId }` → `204`；幂等；权限 `terminal:drive`；远程源不调。
- `acp.log` 不变。

### 7.4 测试

- core `host.test.ts`：`session/new` 不答 → 60 s 后 `acp_session_timeout`，进程被收；`acp.starting` 四次按序；prestart 10 s 回收；领走时不再 spawn。
- web `SessionView.test.tsx`：`starting` 期间输入框可用，发送后 `createSession` 带 `prompt`；阶段文字随事件变化。
- 探针 `tools/probes/acp-e2e.mjs` 加一步：节点出现后 200 ms 内输入框可聚焦。

---

## 8. 并发启动多个 Codex

### 8.1 现状

- 启动行由页面在 shell 安静 400 ms 后敲（`apps/web/src/terminal/surface/use-launch.ts:127-140`，`LAUNCH_QUIET_MS`），`canvas_team` 三个节点几乎同时敲；core 侧由依赖服务启动的（`core/dependencies/launch.ts`）同样无闸门。
- `run/codex` 启动器直接 `exec "$@"`（`hook/install/launcher.ts`）；页面用 `resolvedPath` 作程序（`agent/launch.ts:244`），但 `resolvedPath` 就是 PATH 上第一个命中的 **mise 垫片**，于是多一层 mise + node。
- 调查已复现：全新 `CODEX_HOME` 同时起 3 个 TUI 死 2 个（state DB 迁移竞争）；真实账号下是 routing discovery 超时。

### 8.2 启动闸门（core，`core/agent/launch-gate.ts`，新）

- 键：`(agentId, configDir)`，`configDir` = Codex `CODEX_HOME ?? ~/.codex`、Claude `CLAUDE_CONFIG_DIR ?? ~/.claude`、其余 `~/.<cli>`。
- 策略表（core 常量，不是用户设置）：`codex: { concurrency: 1, holdMs: 6000, jitterMs: [500, 1500] }`；其余 `{ concurrency: Infinity }`。
- 放行条件：持有者的节点报出 `SessionStart`（`hook/reduce.ts` 规则 4，`target-state.ts:246` 同一来源）或 `holdMs` 到期，二者先到者；放行后对下一个加抖动。
- 两条路都过闸门：终端驱动——页面在 `typeLaunch` 前调 `POST /api/agents/launch-slot { workspaceId, nodeId, agentId }`（长轮询，最多 30 s，答 `{ granted: true }`；页面超时直接敲，闸门只是减速带不是门禁）；依赖服务启动的节点在 core 内直接 `acquire()`。ACP 驱动——`AcpRuntime.open`（`core/acp/index.ts:464`）在 `startAdapter` 前 `acquire()`，`initialize` 完成后 `release()`（Codex 的 `account/read` 在 `session/new`，所以 ACP 的放行条件改为 `session/new` 返回或 `holdMs`）。
- 关闭页面 / 节点删除时释放；闸门只在内存里。

### 8.3 失败自动重试一次

- 判定（页面，`use-transport.ts:170-176` 已写回 `lastExitCode`）：启动行敲出后 30 s 内进程退出且 `exitCode !== 0`。不读屏幕正文（原始输出不进任何记录）。
- 动作：退避 2–5 s（随机）后重新申请闸门并再敲一次（`launchPhaseRef` 回到 `armed`）。第二次仍失败：节点头状态胶囊 `failed`「启动失败」+ 头部动作「重试」（复用 `ManualRunButton`），不再自动重试。
- 首条任务：`agent_send_queue` 的 `first-task` 项 TTL 300 s（`send-queue.ts:19`）覆盖一次重试；第二次失败时 core 把该节点的队列项结算为 `failed`（`settledBy: "gate"`），`wait --task` 答 `failed` 并带 `reason: "launch_failed"`，调用方不再等到过期。

### 8.4 穿透垫片（`launchTarget` 扩展，契约 §52）

- 探测（`core/agent/registry.ts` / `probe`）：`resolvedPath` 是符号链接且目标文件名为 `mise` / `asdf`（或路径含 `/mise/shims/`、`/.asdf/shims/`）时，执行一次 `mise which <cli>`（asdf：`asdf which <cli>`，10 s 超时，结果按 `(resolvedPath, mtime)` 缓存），填 `launchTarget = { program: <真实路径>, args: [] }`。页面 `launch.ts:240-244` 已优先 `target.program`，无需改。
- 真实路径是 `codex.js` 这类 node 脚本时不再继续穿透（`node` 本身也可能是 mise 管的，再穿一层收益小、风险大）。
- 只读用户环境，不写任何 CLI 配置；`mise which` 失败则维持原样。

### 8.5 不做与待验证

- 不加 `--no-daemon`：hook 在 daemon 模式下由谁执行、`ARMADRA_NODE_ID` 是否正确未验证；留一条探针任务（真实账号两个节点触发 SessionStart，核对上报的节点 id），验证通过后再议。
- 不改 Codex 超时配置（没有暴露项）。
- 版本不一致（codex-acp 自带 0.159 / TUI 0.160 / daemon 0.161 共用 `~/.codex`）：Agent CLI 子页 ACP 行 `title` 带两个版本号，不出徽标。

### 8.6 契约 §52（协议 1.24）

- `POST /api/agents/launch-slot { workspaceId, nodeId, agentId }` → `200 { granted: true, waitedMs }`；长轮询 ≤ 30 s；权限 `terminal:drive`。
- `agents.list` 的 `launchTarget` 语义扩展：除 Windows `.cmd` 包装外，也用于版本管理器垫片的穿透（§26 原文不改，§52 写「自 1.24 起」）。
- `wait --task` 结果多 `reason?: "launch_failed"`（只在 `failed` 时）。

### 8.7 测试

- `launch-gate.test.ts`：并发 3 个 codex → 串行放行、间隔 ≥ 500 ms；SessionStart 提前放行；holdMs 兜底；非 codex 不排队。
- `registry.test.ts`：假 mise 垫片 → `launchTarget.program` 为真实路径；`mise which` 失败回退。
- web `use-launch.test.ts`：先申请槽再敲；30 s 内非零退出 → 2–5 s 后重敲一次；第二次失败不再重敲并 `patch({ error })`。
- 探针 `tools/probes/launch-concurrency.mjs`（新，隔离 `CODEX_HOME` + 假 API key）：`canvas_team` 起 3 个 Codex，断言 3 个都报 SessionStart、无 `table … already exists`。

---

## 9. 契约、协议、数据库汇总

| 节  | 协议 | 内容                                                                                                     | 包  |
| --- | ---- | -------------------------------------------------------------------------------------------------------- | --- |
| §50 | 1.24 | `canvas.layoutDirection` 设置；`open-agent` / `team` 放置遵循方向；页面推送链接文档带 `role`（行为说明） | C2  |
| §51 | 1.24 | `acp.starting` 事件、`acp_session_timeout`、`POST /api/acp/prestart`                                     | D   |
| §52 | 1.24 | `POST /api/agents/launch-slot`、`launchTarget` 垫片穿透、`wait` 的 `reason`                              | E   |

`PROTOCOL_MINOR` 由最后合入的包改成 24；各包测试用 `since` 断言各自 procedure。**无数据库迁移**：边的 `role`（0024）与链接文档的 `role` 已存在，方向是设置，簇色每帧派生，闸门与预启动池只在内存。

DS 同步：§2.7 弹窗 token；§4 连线两行（对等 / 派发）与把手「四边」；删 §5.3 向导；§5.15 改指 Agent CLI 子页；新增 `--mm-*` token 进 §2。

---

## 10. 实现包

| 包  | worktree（`armadra-wt/`） | 范围                                                                                                                                 | 文件边界（只许动这些；`+test` 配套测试）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 验证                                                                                                        |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A   | `settings-frame`          | §1 尺寸；§2.1 导航与 `scope`；§2.2 映射；§2.3 页头；默认 / 通用 / 通知 / 画布 / 终端外观 / 快捷键 / 关于 页                          | `apps/web/src/panels/SettingsDialog.tsx`+test、`panels/settings/nav.ts`+test、`panels/settings/pages/{DefaultsPage,GeneralPage,NotificationsPage,WhiteboardPage,TerminalLookPage,KeybindingsPage,AboutPage}.tsx`+test（`AgentPage.tsx` 里「默认」相关代码搬到 `DefaultsPage`，其余留给 B；`UpdatesPage.tsx` 并入 `AboutPage` 后删除）、`pages/index.ts`（新：`SECTION_PAGES` 注册表，B 的新页先指向现有页）、`apps/web/src/terminal/surface/fonts.ts`+test、`styles/tokens.css`、`styles/tokens.test.ts`、`i18n/modals.ts`、`i18n/terminal.ts`、`i18n/updates.ts`、`docs/design/design-system.md` §2.7、`showcase/sections/components.tsx`                                                                                                                                                                                                                                                                                                                                                                 | `pnpm --filter @armadra/web test typecheck`、`design-showcase.mjs --only=components --width=1280,1920,2560` |
| B   | `settings-agent-host`     | §2.5 Agent CLI、自定义 Agent、会话、凭据与密钥、用量与额度、工作空间、本机服务、远程机器、代码托管、远程访问、设备与会话、账号与安全 | `panels/settings/pages/{AgentsPage,AgentDetailPage,CustomAgentsPage,SessionsPage,CredentialsPage,UsagePage,WorkspacePage,ServicePage,MachinesPage,ForgePage,RemoteAccessPage,DevicesPage,SecurityPage}.tsx`+test、`pages/integration/*`、`pages/execution-hosts/*`、`pages/ssh/*`、`pages/gateway/*`、`pages/security/*`、`panels/settings/RemoteShare.tsx`、`pages/index.ts`（只改自己那些行）、`i18n/{integration,agent,ssh,execution-hosts,host,remote,gateway,security,account,sharing}.ts`、`showcase/sections/integration.tsx`、`showcase/fixtures/integration.ts`。删除：`AgentPage.tsx`、`IntegrationPage.tsx`、`TerminalPage.tsx`、`HostPage.tsx`、`RemoteServicesPage.tsx`、`GithubPage.tsx`、`SshPage.tsx`、`ExecutionHostsPage.tsx`、`DataPage.tsx`、`AccountPage.tsx`                                                                                                                                                                                                                         | web test/typecheck、`design-showcase.mjs --only=integration`                                                |
| C1  | `canvas-links-minimap`    | §3 连线按 role、四边把手、role 同步修复；§5 簇色、小地图、缩放 −/+                                                                   | `apps/web/src/canvas/flow/edges/{LinkEdge.tsx,link-visual.ts,link-path.ts}`+test、`canvas/geometry.ts`+test、`canvas/sync/project.ts`（`edgeLabelKey` 签名）、`canvas/flow/nodes/ConnectionHandles.tsx`+test、`styles/nodes.css`、`canvas/context-links.ts`+test、`canvas/family.ts`（新）+test、`canvas/flow/Minimap.tsx`+test、`shell/Dock.tsx`+test、`styles/tokens.css`（只加 `--mm-*`）、`styles/tokens.test.ts`（只增）、`i18n/canvas.ts`、`i18n/nodes.ts`（把手键）、`apps/desktop/src/core/collab/roles.test.ts`（只加用例）、`docs/design/design-system.md` §4                                                                                                                                                                                                                                                                                                                                                                                                                                    | web test/typecheck、`pnpm --filter @armadra/desktop test`、`design-showcase.mjs --only=canvas`              |
| C2  | `canvas-layout-spawn`     | §4 布局方向（设置 §50、tidy、core 放置）；§6 删向导、派生直接创建、拖线创建                                                          | `apps/web/src/canvas/tidy.ts`+test、`canvas/tidy-flow.ts`+test、`canvas/layout-direction.ts`（新）、`canvas/flow/edges/LinkEdge.tsx`（**只改锚点一行**换成 hook）、`canvas/menus/{add-menu.ts,AddMenuContent.tsx}`+test、`canvas/FlowWorkspace.tsx`（`onConnectEnd`、整理命令方向）、`canvas/EmptyCanvas.tsx`、`app/commands.ts`、`nodes/terminal-menu.ts`+test、`acp/{NewAgentWizard.tsx,wizard-open.ts}`（删）、`acp/adapter-install.tsx`（只改 `WizardInstallButton` 文案键）、`showcase/{sections,fixtures}/wizard.*`（删）、`shell/Dock.tsx`（只加整理右键菜单）、`panels/settings/pages/WhiteboardPage.tsx`（只加一行，A 合入后）、`i18n/{acp,nodes,canvas}.ts`、`packages/shared/src/domain/placement.ts`（新）+test、`packages/shared/src/api/settings*.ts`（`canvas.layoutDirection`）、`apps/desktop/src/core/settings/completion-settings.ts`+test、`core/collab/control/board.ts`+test、`core/collab/control/nodes.ts`（只改放置调用）、`docs/contracts/core-json-api.md`（§50）、DS §5.3 删除 | `pnpm libs:build`、desktop test、web test/typecheck、`canvas-tidy.mjs`                                      |
| D   | `acp-startup`             | §7 ACP 创建提速、契约 §51                                                                                                            | `apps/desktop/src/core/acp/{host.ts,index.ts,routes.ts,prestart.ts(新)}`+test、`core/agent/adapter-install.ts`（预热调用）、`core/agent/registry.ts`（解析缓存）、`packages/shared/src/api/acp.ts`（事件与 prestart schema）、`apps/web/src/acp/{SessionView.tsx,PromptBox.tsx,store.ts,api.ts}`+test、`canvas/menus/AddMenuContent.tsx`（只加打开时 prestart 一行，与 C2 协调：D 后合）、`i18n/acp.ts`（`acp.starting.*`、`acp.error.timeout`）、`docs/contracts/core-json-api.md`（§51）、`tools/probes/acp-e2e.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `pnpm libs:build`、desktop test、web test/typecheck、`acp-e2e.mjs`                                          |
| E   | `launch-gate`             | §8 启动闸门、重试、垫片穿透、契约 §52                                                                                                | `apps/desktop/src/core/agent/launch-gate.ts`（新）+test、`core/agent/registry.ts`+test（`launchTarget` 穿透；与 D 的缓存改动不同函数，D 后合时 rebase）、`core/agent/routes.ts`（launch-slot）、`core/dependencies/launch.ts`、`core/collab/send-queue.ts`+test（`launch_failed` 结算）、`core/collab/control/wait.ts`、`packages/shared/src/api/agents.ts`（launch-slot schema、`wait` reason）、`apps/web/src/terminal/surface/{use-launch.ts,use-transport.ts,constants.ts}`+test、`apps/web/src/api/agents.ts`、`nodes/TerminalNode.tsx`（失败态 + 重试钮）、`i18n/agent.ts`（`agent.launch.failed`「启动失败」/ "Launch failed"）、`docs/contracts/core-json-api.md`（§52）、`tools/probes/launch-concurrency.mjs`（新）、`tools/probes/README.md`                                                                                                                                                                                                                                                    | `pnpm libs:build`、desktop test、web test/typecheck、`launch-concurrency.mjs`                               |

交叉点与合入顺序：

- **A 先合**（nav 与 `pages/index.ts` 是 B 的地基）；**B 建立在 A 与 `fix/no-foreign-injection-cleanup` 之上**，从两者合入后的 main 开分支。
- **C1 → C2**：C2 只改 `LinkEdge.tsx` 的锚点一行；`Dock.tsx` C1 改缩放段、C2 改整理钮右键，位于不同函数。`i18n/canvas.ts` 两包都加键，追加在各自注释段下。
- **E → D**：D 在 `AcpRuntime.open` 里调 E 的 `acquire()`；`registry.ts` 两包改不同函数。D 的 `AddMenuContent.tsx` 一行在 C2 之后合。
- 契约末尾追加顺序 C2（§50）→ D（§51）→ E（§52）与合入顺序无关，节号已预分配，谁先合谁先追加，后者 rebase。
- 本文进仓库：由 A 顺手放 `docs/design/ui-wave2.md` 并登记 `docs/README.md` 的 `design/` 表；新探针登记 `tools/probes/README.md`。
- 代码、文案、提交信息里不得出现参考项目的名字。
