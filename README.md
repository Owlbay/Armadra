<div align="center">

<img src="./apps/web/public/icon.png" alt="Armadra" width="112" />

# Armadra

**在同一张无限画布上，打破 Agent 之间的界限，让不同模型围绕同一个目标协作。**

本地优先 · 一个 core、两种壳 · 桌面与浏览器共用同一份页面，手机经服务器壳访问

[产品说明](docs/guides/product-overview.md) · [快速开始](#快速开始) · [能力一览](#能力一览) · [设计](#设计) · [路线图](#路线图) · [文档](docs/README.md)

</div>

---

Armadra 是一块本地优先的 **AI Coding 画布**。Claude Code、Codex、OpenCode、Pi、Oh My Pi 与
GitHub Copilot 以**真实终端节点**的形式放在无限画布上，保留各自的账户、模型与权限策略。
你可以通过连线共享必要的上下文，通过消息和交接组织分工，在同一张画布上查看资料、执行过程与成果。

画布上的节点承载完整的 Agent 产品与相关资料，连线表达上下文共享和协作关系，分组帮助你组织不同任务。
从整体分工到具体成果，你可以在同一空间里查看、比较和调整，让协作关系直接呈现在画布上。

当一项工作跨越多个会话，你需要让接手者知道已经确认的决定、失败过的方法和结果的位置；
当任务包含不同难度的步骤，你也需要选择适合的模型，把预算用在最需要判断的地方。
Armadra 从 CLI Agent 协作出发，用无限画布把这些关系变成看得见、能操作的工作空间。

### 三个产品出发点

- **工作可以接续**：相连的 Agent 按范围读取摘要、转录与相关资料，交换消息并进行阶段性交接。
- **模型可以分工**：为节点选择不同模型，让经济模型承担边界明确的工作，让更强模型处理复杂判断；当前分工由用户或任务指令安排，自动难度路由与预算优化尚未实现。
- **过程可以查看**：Agent、便签、编辑器、Git 差异、文件、浏览器和白板资料共同构成工作面，方便检查成果与调整方向。

### 以成熟 Agent 产品作为协作节点

Workflow 能将步骤明确的任务编排成可重复流程。开放任务的路径会随着新发现变化，预设流程需要维护分支、异常和重新执行规则；若节点只是模型调用，还需自行组装工具、上下文与会话能力。

Armadra 的 Agent 节点运行 Claude Code、Codex 等成熟产品，复用它们已有的多轮执行、工具调用和会话机制。你可以按工作目标安排调查、实现与审查，让节点内部的细节由 Agent 推进，并通过画布检查材料与成果。

Workflow 也能嵌入 Agent，两种方式可以结合：先探索和验证任务，再将稳定的协作过程沉淀为可复用 workflow。完整模板复用属于后续规划，详细比较见[产品说明](docs/guides/product-overview.md#workflow-已经解决了什么代价又在哪里)。

### 需求依据

- **多工具与成本**：[Adobe / Harris Poll 的创作者调查](https://news.adobe.com/news/2025/10/adobe-max-2025-creators-survey)中，60% 过去三个月使用过多种创意生成式 AI 工具，38% 将高成本列为采用障碍；样本为超过 16,000 名新兴及半专业创作者。
- **协作缺口**：[Stack Overflow 2025 调查](https://survey.stackoverflow.co/2025/ai)的 Agent 影响问题有 12,823 份回答，只有 17% 认可团队协作得到改善。
- **模型分工**：[RouteLLM 作者报告](https://www.lmsys.org/blog/2024-07-01-routellm/)在 MMLU 基准上保留约 95% GPT-4 表现，同时降低 45% 成本，说明按任务选择模型具有优化空间。

这些资料支持产品方向，实际效果取决于任务、模型和协作开销；以上节省比例属于外部研究，非 Armadra 实测。

### 可以用于哪些工作

AI Coding 画布覆盖软件开发、算法开发、数据分析与科研编程，服务于通过代码和 Agent 推进工作的开发者与研究人员：

- **软件工程**：需求分析、代码开发、测试、问题诊断与交叉审查。
- **算法与数据科学**：算法实现、数据处理、模型训练与评测、实验结果比较。
- **科研**：论文复现、计算实验、数据分析与可视化、研究结果复核。

产品研究、设计、运营与 HR 等工作方式保留为后续探索；具体流程与证据见[产品说明](docs/guides/product-overview.md)。

工作空间记录保存在本机 SQLite 与 `.armadra/`；各 CLI 调用模型时仍按其提供方规则传递必要输入。
关闭窗口不停止后台。编辑器、多仓库 Git、GitHub、浏览器、自动化、额度与资源监控围绕画布展开；
需要多设备访问或工作空间共享时，可使用无窗口服务器壳。

[阅读完整产品说明](docs/guides/product-overview.md) · [查看调研来源与统计口径](docs/research/product-demand-and-cost-evidence.md)

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
- 手机网页（经服务器壳访问）：焦点页、底部导航、软键盘工具条、抽屉布局。
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
| **连线即上下文**       | 读取范围由画布上的连线决定，同级消息作为资料处理；显式任务投递遵循目标状态与驱动规则。        |
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

后续按四个部分推进，平台线并行（详见 [后续规划](docs/design/product-roadmap.md)）：

1. **CLI 接入、通信与共享上下文**（当前优先）：六种 CLI 能力对齐、会话索引与多账号、投递回执、跨主机通信、真 CLI 端到端。
2. **ACP 接入与会话视图**：现有 CLI 经 ACP 以对话形式展示，Agent 的产出一键落到画板，面向普通用户。
3. **协调 Agent 与工作流**：以 Pi 为核心的协调 Agent 拆分与分派任务，协作过程沉淀为可一键复用的工作流。
4. **多人协同**：一块画板多人实时协作，服务器部署后外部成员登录协同，配套登录服务与安全强度校验。

平台线：手机目前经服务器壳访问；桌面端 Gateway 供手机与其他设备访问在计划中（[补全执行计划](docs/design/completion-plan.md) G1-10 / G2-7）→ 移动网页完善 → 手机 / 平板原生应用 → 桌面三平台与服务端优化。

此外，代码侧已经完成、收尾依赖外部条件的项：

| 方向               | 现状                                                         | 缺的条件                   |
| ------------------ | ------------------------------------------------------------ | -------------------------- |
| Windows 正式支持   | 会话宿主、启动行方言、`.exe` Hook 启动器已由 Windows CI 覆盖 | 真机安装与长时间运行       |
| 签名发布与自动更新 | 检查 → 下载 → 验签 → 安装链路已接，未签名构建里关闭          | 代码签名证书、公证、发布源 |
| 手机原生应用       | 网页端焦点页、底部导航、软键盘工具条已交付                   | 原生壳、商店签名、推送服务 |
| passkey / OAuth    | 账号模型已预留，接口按设计返回 501                           | 依赖方域名、OAuth 应用     |
| 多账号 CLI         | 节点账号绑定只有 schema 与只读徽标                           | 各 CLI 的多账号凭据形态    |
| 真实 SSH 端到端    | Worker、远端注入与 Hook 中继已用本机子进程验证               | 一台真实远端主机           |

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
