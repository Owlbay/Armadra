# 文档索引

本文件是文档的唯一入口，新增文档必须登记在这里；`tools/repo-check.mjs` 校验登记与相对链接。

| 目录         | 内容                                         |
| ------------ | -------------------------------------------- |
| `guides/`    | 现行事实：开发、架构、协作与平台说明         |
| `design/`    | 目标设计，首行声明状态（目标设计 / 已实施）  |
| `status/`    | 已验证的实施进度与功能预期总表               |
| `contracts/` | 被代码按 §N 引用的计划文档，章节编号只增不改 |
| `history/`   | 已被取代的文档，只用于追溯，不作为实施要求   |
| `research/`  | 研究与选型材料                               |

## guides/ 现行事实

| 文档                                                   | 内容                                             |
| ------------------------------------------------------ | ------------------------------------------------ |
| [产品说明](guides/product-overview.md)                 | 产品出发点、成本分工、需求证据与应用场景         |
| [开发指南](guides/development.md)                      | 依赖、启动、检查、打包与环境变量                 |
| [CI 与发布](guides/ci-release.md)                      | 三平台矩阵、发布矩阵与密钥清单                   |
| [架构](guides/architecture.md)                         | 当前结构、数据模型与安全边界                     |
| [Agent 协作](guides/agent-collaboration.md)            | CLI 能力、消息与投递、ACP 模式、协调者与 runners |
| [界面规范](guides/ui-refinement.md)                    | 布局、交互与验收范围                             |
| [客户端平台](guides/client-platforms.md)               | 各平台职责、Gateway 配对与原生 App               |
| [服务器部署](guides/server-deployment.md)              | 镜像、证书与 ACME、外网访问、备份升级            |
| [原生白板参考](guides/native-whiteboard-references.md) | 原生对象作为 Agent 资料的规则                    |

代码边界与验证入口见[项目约定](../AGENTS.md)。

## design/ 目标设计

各文档首行声明状态（目标设计 / 部分实施 / 已实施），部分实施的写明缺什么；多数已经交付，现状以 [功能预期总表](status/feature-roadmap.md) 与源码为准。

| 文档                                                      | 内容                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [后续规划](design/product-roadmap.md)                     | 四个部分：CLI 协作、ACP 会话、协调 Agent 与工作流、多人协同；平台线并行                                            |
| [CLI 接入、通信与共享上下文](design/cli-collaboration.md) | 后续规划第一部分：本地历史适配器、投递终态回执、历史可用性与六家端到端                                             |
| [ACP 接入与会话视图](design/acp-session-view.md)          | 后续规划第二部分：六家 CLI 的 ACP 支持核实、ACP 作为同一节点的第二种驱动方式、会话视图、输出到画板、普通用户入口   |
| [协调 Agent](design/coordinator-agent.md)                 | 后续规划第三部分：`ama` 作为第七个内置 Agent 接入、Armadra 宿主适配器、`core/workflow/` 草案与运行、打包与版本锁定 |
| [平台总纲](design/canvas-platform-design.md)              | 需求、M0–M8 阶段与验收                                                                                             |
| [Agent 自动化](design/agent-automation-design.md)         | 交接、循环卡片、计划与命名                                                                                         |
| [Git / GitHub](design/git-github-design.md)               | worktree、提交、Issues 与 PR                                                                                       |
| [Git 工具窗口](design/git-tool-window.md)                 | IDEA 式日志三栏、提交页、多仓库合并图                                                                              |
| [编辑器与浏览器](design/editor-browser-design.md)         | 语言服务、远程文件与受控浏览器                                                                                     |
| [终端宿主](design/terminal-host-design.md)                | 持久终端、ConPTY、资源与快捷键                                                                                     |
| [Windows 早期方案](design/windows-session-daemon.md)      | 早期设计，本轮目标以终端宿主方案为准                                                                               |
| [仓库结构与校验](design/repository-structure.md)          | 目标目录、统一规则、repo-check 与 CI                                                                               |

按域展开的实施方案：

| 文档                                                                            | 内容                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [语言服务](design/language-service.md)                                          | 编辑器 LSP 集成的接口、文件与批次                                                                                                                                                                                                                                       |
| [浏览器与远端执行补全](design/remote-and-browser-completion.md)                 | B01 / H02 首轮之外的剩余部分                                                                                                                                                                                                                                            |
| [发布、更新与服务安装](design/updates-and-service-install.md)                   | S03：下载、自动更新、签名发布与系统服务                                                                                                                                                                                                                                 |
| [React Flow 画布](design/canvas-react-flow.md)                                  | 画布换成 React Flow：能力映射与批次                                                                                                                                                                                                                                     |
| [Agent 协作通道](design/agent-collaboration-channels.md)                        | Pi / OMP / Copilot 的 Hook 适配与省资源通道                                                                                                                                                                                                                             |
| [Agent 接入统一管理](design/agent-integration.md)                               | Hook + 技能一个安装单元、启动时注入、旧残留修复                                                                                                                                                                                                                         |
| [画布内注入](design/canvas-only-integration.md)                                 | Hook、技能与画布说明只在画布启动时生效，全局安装的一次性迁移                                                                                                                                                                                                            |
| [远端画布注入](design/remote-canvas-injection.md)                               | SSH 终端里的 CLI：产物同步、垫片与经 Worker 中继的 Hook                                                                                                                                                                                                                 |
| [画布启动器](design/canvas-launcher.md)                                         | 注入由数据目录里的启动器完成：启动行不带注入、Codex 零写入、Windows C# 启动器、迁移 v2 与工作分解                                                                                                                                                                       |
| [补全架构](design/completion-architecture.md)                                   | 二至四部分与平台线补全后的整体架构：新域边界、迁移 0030 起与契约 §14 起预分配、Yjs 实时协同、Gateway、ACP / 工作流 / runners 模型、移动端与推送、安全模型、三档测试                                                                                                     |
| [补全执行计划](design/completion-plan.md)                                       | 五个波次 49 个工作包：文件归属、依赖、编号、测试、dev-stack、验证命令、热点文件表与需用户提供的条件清单                                                                                                                                                                 |
| [设计系统](design/design-system.md)                                             | token、组件清单、画布视觉语言、全部界面模式与文案规范，附迁移顺序                                                                                                                                                                                                       |
| [设计展示页](design/design-showcase.md)                                         | 仅开发构建的展示页、fixtures、截图探针与验收                                                                                                                                                                                                                            |
| [外部服务与依赖](design/external-services.md)                                   | 签名公证、更新托管、分发渠道、手机壳与推送、网关连通与 TLS、认证、模型提供商、Git 托管、遥测与密钥存放的全清单、用户需提供项与本地 dev-stack                                                                                                                            |
| [G5 剩余事项计划](design/g5-remaining-plan.md)                                  | 补全之后仍未做的 91 条按源码核对分 A / B / C 三档；A 档 28 个工作包（5 组、文件归属、迁移 0036–0038 与契约 §24–§30 预分配、顺序与验证），B 档需用户提供清单，C 档设计决定；G4-2 并入                                                                                    |
| [Agent 推式投递与终端驱动](design/agent-delivery.md)                            | `send` 动词、目标状态机、驱动租约、Agent 的名字与带任务启动                                                                                                                                                                                                             |
| [全面修改方案（2026-09）](design/overhaul-plan.md)                              | 本轮总纲：界面补齐、Mermaid、功能复查、TS 核心、收尾与多端编译                                                                                                                                                                                                          |
| [服务器账号、中转与共享](design/server-accounts-and-sharing.md)                 | 多 principal、组与授予编译成 scope、接口与现有代码的预留点                                                                                                                                                                                                              |
| [正规化平台：中转、SaaS 控制面与多源挂载](design/platform-saas-architecture.md) | 中继形态取舍、独立仓库 `Owlbay/armadra-cloud`（`apps/cloud` / `apps/relay` + npm 协议包）的拓扑与能力划分、PostgreSQL / Redis 落点、云账号与源访问断言、链接加入、多源挂载、隧道协议、跨仓版本与兼容策略、分阶段计划（契约 §31–§33、迁移 0039–0040 预分配）与待拍板决策 |
| [桌面壳迁移到 Electron](design/electron-migration.md)                           | 换壳、`<webview>` 浏览器节点、画布性能前置与六条工作流                                                                                                                                                                                                                  |
| [TypeScript Core](design/typescript-core.md)                                    | Go Host 与 Rust Runtime 合一为一个 TS core，两种壳、R0–R7                                                                                                                                                                                                               |
| [画板导入 Mermaid 图](design/mermaid-import.md)                                 | flowchart → 原生白板对象，其余图种 → 图片回退                                                                                                                                                                                                                           |
| [浏览器节点的 Agent 工具](design/browser-agent-tools.md)                        | 无障碍快照与引用、动词清单、开发者能力与白名单                                                                                                                                                                                                                          |
| [工程规范化](design/engineering-standardization.md)                             | 接口改 typed procedure（HTTP + 一条多路复用 WebSocket）的利弊与迁移、WebSocket 生命周期规范、组件审计与守卫、ESLint / knip / 覆盖率等工具评估、分阶段计划与待拍板清单                                                                                                   |
| [正规化平台落地总计划](design/platform-implementation-plan.md)                  | E0–E6 与平台阶段 0–6（含个人中转）合成的七个波次：依赖图、逐包的仓库 / 目录 / 编号 / 交付 / 验收命令 / 模型 / 规模、第 1 波派发清单、测试与验收体系、风险与回滚、待拍板点                                                                                               |

落地总计划的逐包规格（`design/platform/`）：

| 文档                                                                       | 内容                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [协议包 `@armadra/platform-protocol`](design/platform/protocol-package.md) | 隧道帧与握手、四种令牌声明、`/v1` oRPC 契约、错误码注册表、identity-vectors、黄金 fixtures                                                  |
| [`armadra-cloud` 仓库骨架](design/platform/cloud-repo-skeleton.md)         | 目录、版本选择、根脚本、AGENTS.md、repo-check、CI 三条工作流、Dockerfile 与三份 compose、一键脚本                                           |
| [中继 `apps/relay`](design/platform/relay.md)                              | 隧道终端、边缘、流控、`ControlPlane` 接口；personal 模式的状态文件、账号、TLS、分享；saas 的 Redis 适配与节点间转发；测试与本地运行         |
| [控制面 `apps/cloud`](design/platform/cloud-control-plane.md)              | 技术选择、PostgreSQL 迁移 0001–0004 的 DDL、Redis 键、会话 / 设备码 / 源 / 链接的状态机、安全、配置、测试                                   |
| [Armadra core 侧工作包](design/platform/core-packages.md)                  | `core/sources/`（0039、§33）、`core/identity/cloud/`（0040、§31）、流发送队列、`core/relay/`（§32）、邀请多次、服务器壳 CLI、桌面包 `serve` |
| [页面与手机侧工作包](design/platform/client-packages.md)                   | 多源连接层、查询键与 store、「远程服务」页与分享、手机多连接、`relayed` 源与选路、分享链接落地与组织页                                      |
| [工程规范化包 E1–E6](design/platform/engineering-packages.md)              | 契约 §34–§43 预分配、E1 内核与 E2 控制面 WS 的文件级规格、E3 按域表、E4–E6                                                                  |
| [dev-stack 与验收](design/platform/dev-stack-and-verification.md)          | Armadra dev-stack 的 `platform` / `personal` profile 与 `pnpm platform:*`、cloud 仓一键脚本与 e2e、探针清单、跨仓契约测试、每波验收         |

## status/ 已验证进度

| 文档                                                     | 内容                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [平台实施记录](status/platform-implementation-status.md) | 阶段状态、需求核对与验证证据                                                                                                        |
| [功能预期总表](status/feature-roadmap.md)                | 按源码核实的功能现状表（附依据节号）、需要外部条件的项与代码侧残项                                                                  |
| [画布性能基线](status/canvas-performance-baseline.md)    | 30 个终端 + 真实会话的 fps / 帧时 / 重渲组件数，改动前后                                                                            |
| [服务端性能基线](status/server-performance-baseline.md)  | 服务器壳 30 个终端、6 个事件流、2000 对象实时板的延迟 / 吞吐 / RSS / CPU 与热点修复                                                 |
| [Electron 迁移复查](status/electron-migration-review.md) | 换壳后功能总表逐行核查、UI 死角、文档漂移与测试盲区；已修复项见 §0                                                                  |
| [TypeScript Core 进度](status/typescript-core-status.md) | R0–R7 与 2026-09-25/26 补齐轮的逐节实施记录、实测数字与验证命令                                                                     |
| [补全进度](status/completion-progress.md)                | 补全执行计划 49 个工作包与 G5 的 31 个包逐包的「做了什么 / 实测 / 没做」；剩余用户事项见用户待办清单                                |
| [安全审查 2026-10](status/security-review-2026-10.md)    | 补全计划新增面的安全审查：已修的中高危、低危的修复状态与设计约束                                                                    |
| [用户待办清单](status/user-action-checklist.md)          | G5 之后剩下要用户提供或动手的事项：证书与签名、发布与镜像、外部账号、真机验证、CLI 登录、仓库管理；每条写提供什么、填在哪里、怎么验 |

## contracts/ 实施契约

- [v3 Agent 终端](contracts/v3-agent-terminal-plan.md)：章节 §N 被代码引用，保留编号。
- [core 的 JSON 面](contracts/core-json-api.md)：`/api/github/*`、`/api/automations/*`、`GET /api/identity/hello` 与 `GET /api/nodes/{id}/context-reads` 的线上形状，自动化域存进库里的那份 JSON，以及补全阶段的 §14 ACP、§15 工作流与 runners、§16 实时协同与评论、§17 Gateway、§18 身份扩展、§19 推送、§20 节点凭据、§21 跨主机交接与舰队、§22 画面门、§23 权限补充，以及平台预留的 §31 云登录与登记、§32 隧道面、§33 客户端源表（cloud 仓接口见其 [cloud-api.md](https://github.com/Owlbay/armadra-cloud/blob/main/docs/contracts/cloud-api.md)）。章节 §N 被代码引用，保留编号。
- [tldraw 画布](history/tldraw-canvas-plan.md) 已被 [React Flow 画布](design/canvas-react-flow.md)取代并移入 `history/`。代码注释里的「旧画布契约 §N」指的就是它，只写编号不写路径；§6.1 / §6.3 已改指 React Flow 画布的 §3.1 / §2.5，§6.2（资产端点）与 §8（实施阶段）在新文档里没有对应章节，仍按编号回溯本文。

## history/ 与 research/

`history/` 保存已被取代的需求、界面方案、实施与交接记录；[实施批次记录](history/platform-implementation-log.md)归档各提交的详细验证过程。

分进程时代（Go Host + Rust Worker + 写入所有权切换）的四份文档在 R7d 随那两个进程一起移进来，只用于追溯：

| 文档                                                      | 当时描述的东西                            |
| --------------------------------------------------------- | ----------------------------------------- |
| [Host 与协议](history/host-protocol-design.md)            | Go Host、Rust Worker、Protobuf 与设备接入 |
| [Host 业务所有权迁移](history/host-business-migration.md) | 五个业务域在两个实现之间的六步切换        |
| [桌面壳原生 Host 会话](history/host-native-session.md)    | 打包桌面壳经私有通道取票、Bearer 会话     |
| [Host 设备认证](history/host-device-auth.md)              | `armadra-host` 的 owner 多设备认证接口    |

现状对应的文档：进程与装配见[架构](guides/architecture.md)，core 的线上形状见 [core 的 JSON 面](contracts/core-json-api.md)，服务器壳的账号模型见[服务器账号、中转与共享](design/server-accounts-and-sharing.md)。
`research/` 保存研究材料：[产品需求与成本调研](research/product-demand-and-cost-evidence.md)、[M0 探针记录](research/m0-executor-probes.md)与[运行入口](../tools/probes/README.md)、[UI 风格参考](research/ui-style-references/README.md)、[立项会话归档](research/chatgpt-conversation-archive.md)。

架构变化同步更新 `guides/architecture.md`。
