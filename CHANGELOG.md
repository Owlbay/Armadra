# 更新记录

每个版本一节，按发布倒序。括号里是合入的 PR 编号（github.com/Owlbay/Armadra）。兼容范围以 `tools/release/compatibility.json` 为准，发布说明里的 `armadra-compatibility` 围栏由它渲染。

## 0.2.0（未发布）

0.1.0 之后的第一个版本。0.1.0 是 Tauri 壳加 Rust Runtime / Go Host；0.2.0 起只剩一份 TypeScript core，由 Electron 桌面壳与无窗口服务器壳装配，页面仍是同一份。

### 兼容性

- `minimumInstalled` 仍为 0.1.0：迁移只新增（0001–0013 与 0.1.0 逐字节相同，新增到 0035），0.1.0 的数据库可以直接升上来。
- 随桌面壳打包的 `@armadra/agent` 为 0.6.7，宿主 API 版本 1。
- ACP 入口实测通过的版本：claude-agent-acp 0.85.1 起、pi-acp 0.0.34 起；其余五家（codex-acp、opencode、omp、copilot、ama）还没有真跑记录。

### 架构与壳（#5–#13）

- 桌面壳换成 Electron；Runtime 与 Host 合并为 Electron-free 的 TypeScript core（`apps/desktop/src/core/`），新增无窗口的服务器壳 `apps/server`。
- 远端执行主机：SSH 终端里的 Agent 拿到画布注入，远端的 Git 长操作、文件监听、语言服务、资源采样与交接都经执行主机上的 Worker。
- 节能休眠：空闲的 Agent 会话结束以释放内存，聚焦、投递或计划冷启动时用 CLI 自己的 resume 接回。
- `canvas team` 一次组一队 Agent；`open-agent` / 成员可各带一条 worktree。
- 浏览器节点的 Agent 工具补强（无障碍快照、hover / drag / fill / pdf、多选、穿 shadow root、整页截图）。
- 成员权限：组管理员管自己的组，只读共享、写租约与接管按权限判。
- Hook、技能与画布说明只在画布启动时注入，不再写全局配置；Gemini CLI 退役。
- CLI 协作第一部分：投递前的画面门、通信与共享上下文。

### 画布启动器（#14–#19）

- 启动行统一经 `run/<cli>` 启动器与委托垫片拼出，节点终端只带垫片 PATH；`/api/agents` 答 `launcher`。
- Codex 改用会话旗标，不再写信任记录；迁移 v2 清掉旧信任记录。
- Windows 启动器 `armadra-launch.exe`。

### Agent 与 ACP

- ACP 传输与适配器表（#29），会话视图页面（#37），ACP 作为同一节点的另一种驱动、与终端共用行 / 代次 / 租约 / 休眠（#51）。
- 第七个内置 Agent ama 与宿主适配器（#35）；`@armadra/agent` 升到 0.6.5（ACP 会话带画布 MCP，#52）与 0.6.7（宿主注入的 runner，ama 可以给 ama 派任务，#71）。
- `armadra-hook mcp`：stdio MCP，工具表与 `armadra-hook canvas` 一致（#44）。
- 画面门补齐，计划投递也经过它；未登记的选择菜单一律拦下（#38）。
- 节点凭据：多账号第二阶段，启动器按需兑换，节点 shell 里只有引用（#30）。
- `HostApi.runners` 与 `wait` 动词（#63）；输出到画板与新建 Agent 向导（#48）。
- Agent 权限角色：operator 驱动与审批自己起的终端，ACP 与工作流按对象落到画布（#64）。
- 跨主机交接与 Worker 舰队（#42）。

### 协作与工作流

- 实时协同：core（#32）、页面绑定与在线光标（#50）、评论与提及，Agent 可读评论（#56）。
- 工作流引擎：草案、模板、运行与关卡（#36）；工作流页面、再运行与定时（#65）。

### 账号与安全

- 身份加固：口令策略、限流锁定、passkey、TOTP（#34）；安全页面：会话 / 设备、MFA、审计、两步登录（#61）。
- OAuth / OIDC / SSO：GitHub 与通用 OIDC（#39）。
- 安全收尾：泄露口令检查、公网加固、安全审查（#73）。
- 出站地址表与用量端点政策（#40）；密钥后端按平台补齐（#25）。
- 同浏览器多窗口不再互相作废 CSRF（#58）。
- 依赖安全告警修复：undici、brace-expansion、ip-address、hono、fast-uri、dompurify（#46）。

### Gateway、推送与手机

- Gateway core：本地 CA、配对载荷、Bearer 模式与 `/api/gateway`（#31）；桌面 Gateway 设置页与配对（#47）。
- 推送 core：Web Push、APNs / FCM 直连与端到端加密中继（#33）。
- 移动网页连接页与手机细节（#62）；Capacitor 手机壳：iOS / Android 原生端，钥匙串、指纹钉扎、扫码、推送解密、深链（#68）。

### 平台、发布与运维

- 签名、公证与自动更新端到端；本地构建不自动更新（#53）。更新链路修正与通道（#41）。
- 服务器部署：镜像、内建 ACME、公网部署指南、备份与升级（#54）；服务端性能基线与执行主机舰队视图（#55）。
- Linux 打包验证与夜间冒烟（#57）；Windows 真机验收包与启动器凭据兑换（#66）。
- 分发渠道与第三方声明（#67）；可选崩溃上报（#59）。
- 界面：设计系统 token 与基础件（#24）、设计展示页（#43）、存量界面两轮套用（#49、#72）。

### 工程

- 共享层、core 骨架与契约节（#22、#23、#27）；CI 端到端分档、每条一个清单文件（#26、#57）；本地 dev-stack（#28）。
- 真 CLI 端到端 C 档探针与运行手册（#70）；探针一律用临时 HOME（#69）。
- 端到端稳定性修复（#45、#60、#74）。
- macOS 上无头 Chromium 关掉 GPU，修掉 CI 虚拟机里浏览器偶发整体冻住；CDP 线路追踪与卡住时的现场采集；update-e2e 进程树清理（#76）。
- 真 CLI 端到端探针：Claude / Codex 前提改为可选、`--preflight` / `--setup-only`、TUI / ACP 只跑选中的家、信任对话框等选项画出再答；实跑通过 claude-agent-acp 0.85.1 与 pi-acp 0.0.34，记入兼容表（#77）。

### 已知限制

- 证书与发布源要由维护者提供；没有时发布按「未签名」处理，系统首次安装会警告。
- 手机壳不随本版上架商店。
- 启动兼容字段（`launchWords` / `launchArgs`）本版仍保留，在含启动器的版本发出之后的下一个版本移除。
