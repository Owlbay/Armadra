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

未开始。

## G1-2 跨主机交接与 Worker 舰队

未开始。

## G1-3 画面门补齐与计划投递接门

未开始。

## G1-4 ACP 传输与适配器表（A1）

未开始。

## G1-5 `armadra-hook mcp`（A3）

未开始。

## G1-6 ACP 会话视图页面（W1）

未开始。

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

未开始。

## G1-11 身份加固一：口令策略、限流锁定、passkey、TOTP（I1）

未开始。

## G1-12 OAuth / OIDC / SSO（I2）

未开始。

## G1-13 推送 core（PU）

未开始。

## G1-14 设计展示页与截图探针（WP-D2）

未开始。

## G1-15 更新链路修正与通道（W-UPD）

未开始。

## G1-16 出站地址表与用量端点政策（W-OUTBOUND）

未开始。

<!-- G2 页面与语义闭环 -->

## G2-1 ACP 会话语义（A2）

未开始。

## G2-2 输出到画板与普通用户入口（W2 + W3）

未开始。

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
