<div align="center">

<img src="./apps/web/public/icon.png" alt="Armadra" width="112" />

# Armadra

**把真实的 CLI Agent 放上无限画布，用连线共享上下文。**

本地优先 · 一个 core、两种壳 · 桌面 / 浏览器 / 手机共用同一份页面

[快速开始](#快速开始) · [能力一览](#能力一览) · [设计](#设计) · [路线图](#路线图) · [文档](docs/README.md)

</div>

---

Armadra 是一块面向 AI Coding 的工作画布。Claude Code、Codex、OpenCode、Pi、Oh My Pi 与
GitHub Copilot 以**真实终端节点**的形式放在画布上，保留各自的账户、模型与权限策略；
节点之间连一条线，Agent 就能读到对方的转录、摘要或终端画面，并通过信箱与投递队列协作。
编辑器、多仓库 Git、GitHub、浏览器、后台自动化、额度与资源监控围绕画布展开。

数据留在本机：一个 SQLite 库加工作区里的 `.armadra/`。关闭窗口不停止后台；需要多设备或多人时，
把同一套 core 装进无窗口服务器壳即可。

## 能力一览

### 画布与白板

- 9 种节点：终端（含 Agent）、便签、分组、编辑器、差异、文件树、浏览器、自动化、Agent 活动。
- React Flow 画布 + 自写白板层（手绘、几何、直线 / 箭头、文字、图片），与节点共用相机和撤销栈。
- Mermaid 导入：flowchart 落成可编辑的原生对象，其余图种回退为图片。
- 白板对象与 Frame 可「引用到 Agent」，以 PNG / 文字形式成为资料。
- 自动保存、revision CAS、多设备在线表与编辑租约（谁在看、谁在写、接管）。

### Agent 协作

- 6 种内置 CLI 与自定义 CLI：启动、resume、权限模式、模型选择、版本探测。
- Hook / 进程内扩展 / 插件三种状态通道，归一为 `working / waiting / blocked / done`；权限请求在节点头部直答。
- **画布内注入**：Hook、技能与画布说明只随画布启动带上，画布外启动的 CLI 零影响；SSH 终端同样适用。
- **按连线读取上下文**：对等 / 主从两种链接，转录、摘要、终端画面按预算读取。
- **两种消息模型**：拉取式 `post / inbox / ack`，推式 `send` + 投递队列、驱动租约、半截输入门，休眠节点先唤醒再投。
- **编排**：`open-agent --after / --after-turn`、`canvas team` 并行 / 流水线 / 汇总，成员各带一条 worktree。
- 对话交接（prepare → 预览 → accept）、子代理卡片、原生 Loop / Cron 观察卡片、会话索引、自动命名。

### 终端与主机

- tmux（跨 core 重启存活）、直连 PTY、SSH 三种后端；Windows 用独立 ConPTY 会话宿主。
- 后台渲染预算：聚焦 / 可见 / 离屏 / 分离分档渲染。
- **Eco 节能休眠**：空闲 Agent 先退出再结束进程，聚焦、投递或计划到点时用 resume 接回。
- Agent 工作期间的防休眠租约。

### 代码工作面

- **编辑器**：CodeMirror 6、快速打开、跳转行列、Git 行边标记、外部变更三方合并、草稿保护、媒体与 PDF 预览、Markdown。
- **语言服务**：补全、诊断、hover、定义、引用、重命名、格式化。
- **Git**：多仓库、IDEA 式工具窗口与提交图、hunk 级暂存、交互式 rebase、stash / cherry-pick / reflog、worktree 与 Frame 绑定、AI 提交信息草稿。
- **GitHub**：Issues 与 Projects v2 状态映射、PR 创建 / 评审 / 检查 / 预期 SHA 合并、检出到 worktree。

### 浏览器节点

- 桌面壳为进程内 `<webview>`，服务器壳为 headless Chromium 画面流；人与 Agent 共用同一会话。
- Agent 动词：无障碍快照与稳定引用、导航、点击、输入、拖放、下拉、等待、元素 / 整页截图、PDF、Console / Network 摘要。

### 自动化、用量与资源

- core 内持久调度：Cron / Interval / Once / 完成后循环，misfire、并发与重试策略；目标为 Agent 时走投递门。
- Claude / Codex / Copilot 额度窗口与重置时间、本地成本统计、Provider 状态页徽标、托盘迷你条。
- 按会话进程树采集内存 / CPU，主机总览、阈值提醒，覆盖远端执行主机。

### 远程与多端

- **远端执行主机**：经 SSH 拉起同一份 core 作为 Worker，文件、Git、语言服务、资源读取在执行主机上完成。
- **服务器壳**：TLS、设备配对、`__Host-` 会话与 CSRF；账号、组与按工作空间共享，收权即断流、即释放写租约。
- 手机网页：焦点页、底部导航、软键盘工具条、抽屉布局。
- 快捷键按平台 / 设备覆盖、中英双语、主题、SQLite 一致性备份。

### 支持的 Agent

| CLI            | 状态通道   | 恢复会话               | 非默认权限模式               |
| -------------- | ---------- | ---------------------- | ---------------------------- |
| Claude Code    | 命令 Hook  | `--resume ID`          | auto-edit / full-auto / plan |
| Codex          | 命令 Hook  | `resume ID`            | auto-edit / full-auto / plan |
| OpenCode       | 插件       | `--session ID`         | CLI 默认                     |
| Pi             | 进程内扩展 | `--session PATH_OR_ID` | CLI 默认                     |
| Oh My Pi       | 进程内扩展 | `--resume ID`          | auto-edit / full-auto        |
| GitHub Copilot | 命令 Hook  | `--resume ID`          | auto-edit / full-auto / plan |

自定义 Agent 可借用任一内置 CLI 的形状。完整差异见 [Agent 协作](docs/guides/agent-collaboration.md)，
逐项现状与依据见 [功能预期总表](docs/status/feature-roadmap.md)。

## 设计

```text
            apps/web  —— 唯一页面（React 19 · React Flow · xterm.js · CodeMirror 6）
           ┌───────────────────────┴───────────────────────┐
  apps/desktop  Electron 壳                      apps/server  无窗口服务器壳
  窗口 · 托盘 · 通知 · <webview>                 TLS · 设备配对 · 账号与共享
           └───────────────────────┬───────────────────────┘
                 apps/desktop/src/core  —— 唯一执行者（Electron-free TypeScript）
       画布 · 终端 · 文件 · Git · GitHub · 调度 · 语言服务 · 浏览器 · Hook · 身份
           │                         │                          │
   armadra-hook（CLI 回调）   remote Worker（经 ssh）   session-host（Windows ConPTY）
```

几条贯穿全局的决定：

| 原则                   | 含义                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| **一个 core，两种壳**  | 业务只在 `src/core/` 执行，不 import `electron`；桌面壳与服务器壳装配同一份 core 与页面。     |
| **真实 CLI，不代替它** | 启动各 CLI 本体，保留账户、模型、权限与会话格式；Armadra 只负责身份、链接、消息与可读上下文。 |
| **连线即上下文**       | 读取范围由画布上的连线决定，同级消息作为资料处理，不自动粘贴到其他终端。                      |
| **本地优先**           | 桌面安装没有服务端；数据库只接受已知迁移前缀，未知或损坏时拒绝启动，不自动重建。              |
| **如实的状态**         | `unknown / unsupported / stale / denied` 是有效状态，不显示为 0 或成功。                      |
| **最小侵入**           | Hook 与技能只在画布启动时注入，画布外的 CLI 行为不变；凭据与终端原文不进持久化与日志。        |

分层、数据模型与安全边界见 [架构](docs/guides/architecture.md)。

## 快速开始

需要 Node.js ≥ 22 与项目锁定的 pnpm，没有别的工具链。建议安装 tmux（缺失时退回直连 PTY）；
macOS 桌面目标 ≥ 13.3，并需 Xcode Command Line Tools。

```sh
pnpm install
./armadra.sh doctor        # 检查工具链
./armadra.sh run desktop   # 桌面壳持有 core（热更新）
./armadra.sh run web       # 或：core + 浏览器前端
```

打包与服务器壳：

```sh
pnpm --filter @armadra/desktop dist    # 桌面安装包 → apps/desktop/release/
pnpm --filter @armadra/server build    # 服务器壳 → apps/server/out/main.js
```

分步启动、端口、环境变量与数据位置见 [开发指南](docs/guides/development.md)。

## 路线图

代码侧已走到头、收尾依赖外部条件的项：

| 方向               | 现状                                                         | 缺的条件                   |
| ------------------ | ------------------------------------------------------------ | -------------------------- |
| Windows 正式支持   | 会话宿主、启动行方言、`.exe` Hook 启动器已由 Windows CI 覆盖 | 真机安装与长时间运行       |
| 签名发布与自动更新 | 检查 → 下载 → 验签 → 安装链路已接，未签名构建里关闭          | 代码签名证书、公证、发布源 |
| 手机原生应用       | 网页端焦点页、底部导航、软键盘工具条已交付                   | 原生壳、商店签名、推送服务 |
| passkey / OAuth    | 账号模型已预留，接口按设计返回 501                           | 依赖方域名、OAuth 应用     |
| 多账号 CLI         | 节点账号绑定只有 schema 与只读徽标                           | 各 CLI 的多账号凭据形态    |
| 真实 SSH 端到端    | Worker、远端注入与 Hook 中继已用本机子进程验证               | 一台真实远端主机           |

在现有架构上可以继续延伸的方向：

- **会话索引扩展**到 OpenCode / Pi / OMP / Copilot（当前覆盖 Claude 与 Codex），成本统计同步扩展。
- **服务器壳的团队能力**：审批角色区分驱动者与编辑者、成员自助改名与停用。
- **多执行主机协同**：Worker 已按执行主机隔离，可让一块画布上的 Agent 分布在多台机器上，由服务器壳统一托管。
- **更多 CLI 接入**：新 CLI 只需在注册表里描述启动、恢复与权限参数，并选一种状态通道。

逐项状态以 [功能预期总表](docs/status/feature-roadmap.md) 与 [TypeScript Core 进度](docs/status/typescript-core-status.md) 为准。

## 项目结构

| 目录                                         | 职责                                                      |
| -------------------------------------------- | --------------------------------------------------------- |
| [apps/web](apps/web/README.md)               | React / Vite / React Flow 前端，两种壳共用                |
| [apps/desktop](apps/desktop/README.md)       | Electron 桌面壳；`src/core/` 是业务所在                   |
| [apps/server](apps/server/README.md)         | 无窗口服务器壳：同一个 core，外加 TLS、配对、账号与共享   |
| [packages/shared](packages/shared/README.md) | 领域模型、CLI 注册表与 JSON schema                        |
| `tools/`                                     | 仓库校验、CI、发布与探针脚本                              |
| `docs/`                                      | 指南、设计、进度与契约，入口是 [文档索引](docs/README.md) |

## 开发

```sh
pnpm check                              # 格式 + 类型 + 仓库规则 + CI / 发布自检
pnpm libs:build                         # 先构建 shared，再跑依赖它的测试
pnpm --filter @armadra/web test
pnpm --filter @armadra/desktop test     # core 与桌面壳
pnpm --filter @armadra/server test
```

代码边界、迁移与文档规则见 [开发约定](AGENTS.md)；CI 与发布见 [CI 与发布](docs/guides/ci-release.md)。

## 品牌与许可

Logo 只有一个[源文件](assets/brand/armadra-armadillo-primary.png)，桌面图标与 Web favicon 均由它生成。

[MIT License](LICENSE)
