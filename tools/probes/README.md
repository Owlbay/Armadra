# M0 执行器探针

这些入口只核验底层可行性，不启动应用服务，不构成完整浏览器或 Windows 持久终端实现。全部命令从仓库根目录运行；无需修改根 manifest。

## 分档

按[补全架构](../../docs/design/completion-architecture.md) §12 分三档。A 档由 `tools/ci/e2e.mjs --tier a` 按 `tools/ci/e2e.json` 的清单跑（[执行计划](../../docs/design/completion-plan.md) G0-4 建）；外部服务的替身来自 `tools/dev-stack/`，没有 Docker 时相关条目记 `skipped`。

| 档  | 本目录的探针（计划中新增的见架构 §12）                                                                                                       | 何时跑                              | 失败时       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------ |
| A   | `server-e2e`、`ui-features-e2e`、`core-terminal-smoke`、`core-terminal-lifecycle`、`remote-e2e`、`gateway-e2e`、`design-showcase`、`acp-e2e` | 每次 push（`ci.yml` 的 `e2e` 作业） | 阻断合并     |
| B   | `packaged-smoke`、`core-terminal-packaged`                                                                                                   | `nightly.yml`                       | 开 issue     |
| C   | `agent-e2e`（真 CLI 与额度）、`canvas-stress`（真实会话）                                                                                    | 手动；清单在执行计划 §5             | 记进状态文档 |

其余脚本（`browser-cdp`、`git-tool-window`、`connection-drag`、`browser-agent-e2e`、`timezone-picker`）是单项核验，本地按需手动跑。

## 受控 Chromium

需要 Node.js 22+（内置 WebSocket/fetch）和已安装的 Chrome/Chromium；脚本不下载浏览器。默认探测系统常见安装路径，也可显式选择可执行文件：

```sh
node tools/probes/browser-cdp.mjs
CHROME_PATH='/path/to/chrome' node tools/probes/browser-cdp.mjs /path/to/output-directory
```

Windows PowerShell：

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tools/probes/browser-cdp.mjs
```

每次创建独立输出子目录，默认位于已忽略的 `target/m0-probes/`。产物包括 `result.json`、`browser.png`（截图步骤通过后）和 `chrome-stderr.log`。结果包含实际浏览器版本、系统和能力；失败返回非零退出码。

浏览器 profile 在系统临时目录中新建，正常结束或已捕获的失败均执行退出和 profile 清理；不使用已有 profile。测试 HTTP 服务和 CDP 仅绑定本机随机端口。脚本只向自身生成的表单页面注入固定测试代码，不接入真实账号。进程被强制杀死、系统崩溃等无法执行 finally 的情况需手动清理残留临时 profile。

探测导航、表单输入和点击、英文/中文/emoji 文本插入、Canvas/表单 PNG、滚动和 screencast ACK。中文文本插入不等于操作系统 IME composition 验证；没有验证画布节点裁剪/缩放、移动端、完整 Browser Worker 或性能预算。跨平台分支需在各自平台运行后才算验证。

## Git 工具窗口截图

真机渲染 [Git 工具窗口](../../docs/design/git-tool-window.md) §2 的两个页签：临时数据目录里的 core（`apps/desktop/out/core/main.js`）、含三个检出的临时工作空间（根仓库有已暂存 / 未暂存 / 未跟踪的改动与一条 stash，嵌套仓库停在一次 merge 冲突上，另有一个链接 worktree）、Vite 开发服务器，以及新 profile 的无头 Chrome。

```sh
pnpm --filter @armadra/desktop build
node tools/probes/git-tool-window.mjs [输出目录]
```

产物默认在 `target/git-tool-window/`：桌面 1440×900 的 `log-desktop.png`（三栏）、`log-maximized.png`、`commit-desktop.png`、`commit-maximized.png`，手机 390×844 的 `mobile-commits.png` / `mobile-branches.png` / `mobile-details.png` / `mobile-diff.png`（日志页的四级导航）与 `mobile-commit.png`，加一份 `result.json`。手机那几张按应用自己的行为开成最大化（`shell/MobileBottomNav.tsx`），桌面停在底部。端口随机（不用 1420 / 1421 / 43120 / 43121），数据目录与浏览器 profile 都是 `mktemp` 出来的，跑完删除；不读写操作员自己的数据目录、凭据或任何远端。页面入口（`apps/web/git-window-probe.html` 与 `src/git-window-probe.tsx`）由脚本临时写入、结束时删除——应用首页要先选工作空间，而这次要看的是窗口本身。

## 设计展示页截图

[设计展示页](../../docs/design/design-showcase.md) §3 的探针：只起一个随机端口的 Vite 开发服务器与新 profile 的无头 Chrome，不起 core 与 tmux，`ARMADRA_DATA_DIR` 指到空的临时目录，跑完删除。

```sh
pnpm libs:build
node tools/probes/design-showcase.mjs [输出目录] [--only=tokens,acp] [--theme=dark] [--width=390] [--diff=<上一次的输出目录>]
```

矩阵：`ShowcaseApp.tsx` 登记的 14 个分区 × 深浅两套主题 × 1440×900 / 1024×768 / 390×844 三种视口，每张是 `showcase.html?theme=…&only=1#<分区>` 的整页截图，文件名 `<分区>-<主题>-<宽>.png`。另做五项核验：深浅主题各执行一次 `window.__showcaseContrast()`，按浏览器算出的颜色核算设计系统 §2.1–§2.5 的每一对（文字 4.5、图形 3），低于阈值即失败；`components` 分区按 Tab 走一遍，每个可聚焦元素都要命中 `:focus-visible` 且看得见焦点环（Radix 漫游焦点组的根按一个落点算）；`prefers-reduced-motion: reduce` 下 `canvas` 分区没有在跑的动画、隔 700ms 的两张图逐字节相同（额外存 `canvas-<主题>-1440-reduced-motion.png`）；`forced-colors: active` 下焦点仍有轮廓（额外存 `components-<主题>-1440-forced-colors.png`）；控制台 error 与未捕获异常算失败。`apps/web/dist/` 存在时（CI 先构建）顺带确认产物里没有展示页的文件与代码。

产物默认在 `target/design-showcase/`：全部 PNG 与 `result.json`（分区、主题、视口、每张耗时、对比度表、Tab 结果、两项媒体模拟、控制台）。`--diff` 逐像素比较同名 PNG，差异超过 0.5% 的列进 `changed`，给改样式前后对照用。功能分区在实现包落地前是骨架占位；画布分区的节点体是静态内容（真终端要连 core）。没有验证：真实触屏、系统高对比主题本身（只模拟了 `forced-colors`）、Windows 与 Linux 上的字体渲染差异（CI 只在 Linux 跑）。

## 连线拖拽成功率

复现并守住[用户实测反馈](../../docs/status/platform-implementation-status.md) F6「Agent 圆点之间拖拽有时拉不出箭头」。用 CDP 的真实鼠标事件从一个终端节点的右把手拖到另一个节点身上，重复 N 次（默认 20），每次成功后点 Dock 的「撤销」把边收回来再拖下一次。

```sh
pnpm --filter @armadra/desktop build
node tools/probes/connection-drag.mjs [输出目录] [次数]
```

跑的是应用自己的首页（`?workspace=…&board=…` 深链，见 `apps/web/src/app/use-board-sync.ts`），底下是临时数据目录里的 core、临时工作空间与新 profile 的无头 Chrome；端口随机（不用 1420 / 1421 / 43120 / 43121），跑完全部删除，不读写操作员自己的数据目录或凭据。

产物默认在 `target/connection-drag/`：`result.json` 记成功次数、把手实测尺寸与每次失败时指针底下的元素，第一次失败时另存一张 `failure.png`。把手量到小于 12px 直接失败——那说明 React Flow 自己的样式表又盖过了 `apps/web/src/styles/nodes.css`，圆点和它的 34px 命中区会一起被推到节点外面，正是 F6 的根因。

两个节点在种子里就带着名字（`data.handle`）：两端缺名字时，连线一建立就会弹起名对话框（[Agent 投递](../../docs/design/agent-delivery.md) §2.2 的 `requestNodeNames`），它的遮罩会吃掉紧接着的「撤销」点击。点撤销前若看到对话框遮罩，脚本直接报「连线后弹出了对话框」，不会把它误记成撤销失败。起名对话框本身不在这里验证。

只覆盖鼠标：触屏的 pointer 事件、缩放后的坐标换算与多显示器缩放都没有验证。

## 画布压力（30 个终端 + 真实会话）

既有基线（[React Flow 画布](../../docs/design/canvas-react-flow.md) §6.5）的 30 个终端节点**没有会话**，量不到用户报的卡顿。这个脚本把那一列补上：每个终端节点都真的连着一个 core 的 PTY。

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/canvas-stress.mjs [输出目录] [终端数]
```

`pnpm libs:build` 不能省：Vite 从 `packages/shared/dist` 解析 `@armadra/shared`，没构建过的工作区只会得到一块 Vite 错误遮罩，而画布一个节点都不挂——脚本会在「挂载情况」那一步报 0 个 RF 节点。

量四段（空闲 3 s / 手形平移 10 s / 拖一个节点 6 s / 便签连续输入 100 字符），每段记平均 fps、p50、p95 帧时、最慢一帧、超过 33.4 ms 的帧数与 JS 堆；另外单独量一次「销毁一个会话」引发多少个组件重渲。重渲计数注入 React DevTools 的 hook 垫片（React 只在 hook 先于它就位时才给 fiber 打开 ProfileMode），判据抄 DevTools 自己的 `didFiberRender`，并且只走这次 commit 真正碰过的子树——React 在高层 bail out 时不克隆子节点，不设这道门会把没渲染的子树全部数进来。

视口写死在 `zoom 0.35`，30 个终端全部在视口里、React Flow 不裁剪，与既有基线同一个最坏情况。产物默认在 `target/canvas-stress/`：`result.json` 与 `canvas.png` / `mounted.png`。

便签那一段点的是便签正文，找 textarea 也限在 `[data-slot="sticky-node"]` 里：每个终端的 xterm 都挂着一个隐藏的 helper textarea，排在便签前面。2026-09-26 之前的脚本用的是不限范围的 `querySelector("textarea")`，字符其实打进了第一个终端的 PTY——那之前记下的「输入 100 字符」各项数字量的都不是便签。

无头 Chrome 的 rAF 上限是 60 Hz（既有基线在有屏幕的 120 Hz 窗口里跑，所以那张表的 fps 不能和这张直接比）。fps 在这里很快撞顶，**真正有判别力的是重渲组件数与最慢帧**。撤销栈深度放在最后数——数法是一直点到按钮灰掉，那会真的把改动撤回去。

## core 的终端域

三个脚本，三个不同的问题。结果与结论记在 [TypeScript Core 进度](../../docs/status/typescript-core-status.md)。

```sh
pnpm --filter @armadra/desktop build                      # 产出 out/core/main.js

node tools/probes/core-terminal-smoke.mjs                 # 建 / 附 / 打字 / 断 / 重附 / 销毁
node tools/probes/core-terminal-lifecycle.mjs             # 会话的生命周期：退出、回收、重启后的对账
node tools/probes/core-terminal-packaged.mjs              # 打包版，从页面开一个终端
```

- **smoke**：起一个 core，开终端，打字看回显，关掉 WS 再开一次确认看得见刚才那屏（`sawEarlierOutput`），最后销毁会话；顺带验证不存在的会话在升级前就被 404 拒掉。
- **packaged**：需要先 `pnpm --filter @armadra/desktop dist`（本机没有 `CSC_LINK` 时 `dist.mjs` 自动跳过签名与公证）。按访达的方式启动：`PATH` 只给 launchd 那条（`/usr/bin:/bin:/usr/sbin:/sbin`），数据目录用 `ARMADRA_DATA_DIR`、Chromium profile 用 `--user-data-dir`、`HOME` 都指到临时目录（HOME 也得临时：打包版的 core 启动时会迁走各 CLI 旧的全局安装、清掉上一版写进 `~/.codex/config.toml` 的会话级信任记录；画布内的 Codex 经启动器带 `--dangerously-bypass-hook-trust`，不再写信任记录），不碰操作员的 `~/Library/Application Support/Armadra`。本机装了 tmux（Homebrew 等常见位置）时，会话必须是 `tmux` 后端，资源采样（`GET …/resources`）也必须给出这个会话的 pid——两处各自找 tmux，都得用补过的 PATH。调试端口是运行时选的空闲端口，不是固定值：机器上另一个 Electron 占着固定端口时，探针会连上别人的渲染进程，失败起来和打包出错一模一样。

三个脚本都用 `mktemp` 的数据目录与各自私有的 tmux socket，跑完 `kill-server` 并删掉目录；不碰操作者自己的数据目录或 tmux server。

## 节点凭据端到端

```sh
pnpm --filter @armadra/desktop build
node tools/probes/credentials-e2e.mjs [输出目录]   # 默认 target/probes/credentials-e2e-<时间>/
```

不用真实账号（契约 §20）：一个基础 CLI 为 Claude 的自定义 Agent 指向 `fixtures/env-echo.mjs`（只打印变量长度），凭据值是一串假令牌。断言 CLI 进程看到的长度正确、节点 shell 的 `env` 里没有这个变量、值不在画面 / 日志 / 答复里、基础 CLI 不匹配时起终端被拒、条目删掉后同一 shell 重跑启动器拒绝起 CLI。临时数据目录与 HOME，密钥后端 `file-encrypted`，`ARMADRA_NO_GLOBAL_WRITES=1`；Windows 上跳过。产物 `result.json`。

## ACP 会话端到端

```sh
pnpm --filter @armadra/desktop build
node tools/probes/acp-e2e.mjs [输出目录]   # 默认 target/acp-e2e/
```

真 core、真 Vite 页面、新 profile 的无头 Chrome（契约 §14.2–§14.4）。ACP Agent 是 `@armadra/agent/acp` 的假 Agent，注册成基础 CLI 为 OpenCode 的 `custom:` 条目，不用真实账号、不起真 CLI。两个以 ACP 驱动的节点 A → B：页面挂载即起会话（`terminal_sessions` 的 `acp` 行）→ 会话视图里发一句、回复流进来、状态来源 `acp` → 审批卡在页面上点「拒绝」（审批行 `deny`、审计 `route = acp`）→ `armadra-hook canvas send` 从 A 投给 B（`delivered`，B 的会话视图里看得到）→ 经节点菜单切到终端视图再切回（同一行、代次 +2、CLI 会话接回、之前的对话还在）→ 打开 Eco（`ARMADRA_TEST_ECO_IDLE_SECONDS=3`）让 A 休眠、再在页面上发一句唤醒（同一行、适配器 pid 换了、CLI 会话 id 没变）→ 全程没有控制台错误。临时数据目录与 HOME，`ARMADRA_NO_GLOBAL_WRITES=1`。产物 `result.json` 与 `01-sessions-open.png` … `09-woken.png`。

## 本轮界面功能的端到端验证

真 core（`apps/desktop/out/core/main.js`）、真 Vite 页面、新 profile 的无头 Chrome，经浏览器级 CDP 连接驱动；多设备场景用两个独立的 browser context 当两台设备。场景拆在 `ui-features/` 里，共用一套临时环境（`harness.mjs`），媒体夹具与截图像素统计在 `fixtures.mjs`。

## Agent 协作端到端（真 Claude Code + 真 Codex CLI）

用真 CLI 把投递、依赖编排、组队与节能休眠走一遍。页面必须真的挂着这些终端节点：CLI 起来时的终端查询由 xterm 经页面写回 PTY，[状态文档](../../docs/status/typescript-core-status.md) §31.7 那个「Codex 首条任务投不出去」只在页面挂着时出现。每个 Agent 节点都由页面挂载、由页面敲启动行。

## 服务器壳端到端（账号、共享与 headless 浏览器）

真进程走一遍多人使用服务器壳的主线（[TypeScript Core 进度](../../docs/status/typescript-core-status.md) §42、§39，结果记在 §50）。

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/ui-features-e2e.mjs [输出目录] [--only=presence,editor,fileTree,search,keybindings,integration,resources,layout]
```

产物默认在 `target/ui-features-e2e/`：`result.json`（每个场景的检查项、实测数字、截图路径与控制台错误）与截图；窄屏 390×844 的截图以 `mobile-` 开头，场景失败时每个截过图的页面补一张 `failure-<场景>-N.png`。每个场景都收集 `Runtime.consoleAPICalled` 的 error 与 `Runtime.exceptionThrown`，有未预期的就算失败。

验证什么：

- **presence**（多设备画布）：单页面不出设备条且自动拿租约；第二台只读、显示「X 正在编辑」、拖不动；第一台一笔保存被 CDP 拦下的改动在第二台二次确认接管后被丢掉并按远端重载；关掉持有者页面后租约释放。
- **editor**：PNG（透明、棋盘格像素统计、滚轮缩放）、PDF（截图里查看器区域不是空白）、MP4 / MP3（原生控件、元数据）；草稿刷新后恢复；草稿期间磁盘改同一文件出现三方合并；Git 行边的修改标记；快速打开的最近文件与 `文件:行:列`。MP4 由同一个 Chrome 的 MediaRecorder 录 canvas 得到，MP3 是合法的静音帧，PDF 手写对象表，都不依赖外部工具。
- **fileTree**：右键「复制路径 / 复制相对路径」写进剪贴板的内容（授予 context 剪贴板权限后读回），浏览器里没有「在访达中显示」。
- **search**：先直接问 core 量一次整轮扫描（约 3.6 万个文件），再在页面上中途换关键词、点「停止」；core 的 debug 日志「文件搜索随连接断开中止」带着 `visited`，断言它明显小于整轮文件数。
- **keybindings**：设为无、追加第二组键、`when` 的语法错与未知键提示且不能保存；回到画布用真实键盘事件确认改动生效，最后全部重置。
- **integration**：临时 HOME 的 `.claude/settings.json` 里 11 条相同的旧 Hook；行布局、「旧残留 11」弹层在设置对话框之上、同一命令合并为 ×11；「修复」只清残留、保留用户自己的命令并留备份。
- **layout**（§58）：顶部提示条（临时 HOME 里有旧版接入残留，所以总有一条）坐在 44px 标题带里、不压侧栏开关 / 工具簇 / 设备条，多设备时退到设备条下面；它原来位置上的节点标题栏按得到、拖得动；外框里本体之外的点不命中。1440 宽开资源管理器时 Dock 整个在抽屉左边、缩放百分比按得到，开 460px 的自动化抽屉时提示条也让开。390 宽开「文件」与「自动化」时抽屉铺满宽度、底边停在底部导航上沿，导航五个去处都按得到，工具簇没被推出屏幕，点「画布」收起。
- **resources**：`ARMADRA_REMOTE_WORKER_LAUNCHER` 指向探针写的替身 ssh，远端命令是本仓库的 `main.js worker --stdio`，所以「构建机」的总览是 Worker 真读出来的；主机筛选（全部 / 本机 / 构建机）；休眠会话在节点与面板上的显示；`ARMADRA_STATUS_PAGE_BASE` 指向本机 fixture 时用量卡的状态徽标。

没验证什么：休眠的**判据与接回**（休眠状态是经 API 结束会话后在数据库里把结束原因置成 `hibernate`，与 `Manager.hibernate` 写的同形；真正走到休眠要一个空闲 5 分钟以上的 Agent CLI）；真实 SSH 与另一台机器；打包应用里的 PDF 查看器与视频解码（这里是无头 Chrome）；触屏手势（窄屏只按视口宽度截图）。

一切都是临时的、回环的：随机端口（不用 1420 / 1421 / 43120-43125）、`mktemp` 的数据目录、HOME、`CLAUDE_CONFIG_DIR` / `CODEX_HOME`、替身脚本与浏览器 profile，结束时全部删除并停掉自己起的 tmux 服务器；不读写操作员自己的数据目录与 CLI 配置，不联网。

node tools/probes/agent-e2e.mjs [输出目录] [--only 1,2,3,4,5,6]

node tools/probes/agent-e2e.mjs [输出目录] [--only 1,2,3,4,5,6,7,8,9,10,11] [--backend direct]

```

入口只装配与收尾；各场景在 `agent-e2e/scenario-*.mjs`，共用的临时环境、core / Vite / Chrome 装配与断言工具在 `agent-e2e/lib.mjs`。

场景：

十个场景（缺省全跑；`--backend direct` 先把 `terminal.backend` 设成 direct、重起一次 core 再跑，macOS 缺省是 tmux）：

1. **Codex 首投**：普通终端节点当发送方（探针以它的节点身份跑 `armadra-hook canvas`，令牌经 `POST /api/terminals/{id}/node-token/refresh` 签发），`send` 投给两个互相连线的 Codex，再 `open-agent --task` 建第三个；断言投递 `delivered` + `targetState = observed-quiet`，且 hook 随后报了一轮。
2. **Claude 投递**：`claude-a` 用「自动编辑」起（`--permission-mode acceptEdits`，场景 2、4、8 共用这个节点；理由同场景 10：缺省权限模式是 bypass 时新版 Claude 先弹「把 auto 设成缺省？」，投进去的回车会替人答掉它），断言进程 argv 带着它；hook 状态通道那条路（`targetState = idle`）；半截输入门——经页面在 Claude 输入框里打半行不回车，等人的租约过期后 `send` 排队 `TARGET_INPUT_PENDING`，回车后投出去。
3. **依赖编排与组队**：`open-agent --after <上游> --after-turn next`、`team --member … --chain`；再关掉页面触发一次，断言由 core 自己起进程并投出任务。
4. **节能休眠**：`ARMADRA_TEST_ECO_IDLE_SECONDS=20`（`core/terminal/hibernate.ts::ecoTestOverride`，只有启动 core 的进程能给，设置的 5 分钟下限不变），关掉页面让 Claude 与 Codex 都睡着、确认 CLI 进程退出；重开页面点节点唤醒，断言同一会话 id 起下一代、恢复行带同一个 provider 会话 id、接回的 Claude 仍带 `--permission-mode acceptEdits`、还记得之前让它记的数。

5. **画布内注入（Claude / Codex）**：经 `GET /api/agents` 的 `launcher`（数据目录里的 `run/<cli>`，[画布启动器](../../docs/design/canvas-launcher.md) §13.3）起 `<launcher> <程序> … "<prompt>"`，每家三遍：画布内（带 `ARMADRA_NODE_ID`）会话里有带修订标记的画布规则与技能、Codex 打出 `--dangerously-bypass-hook-trust` 的警告、Hook 打到 core——注入的旗标落在位置参数 prompt 之后也照样生效；画布外重跑同一行（只去掉 `ARMADRA_NODE_ID`）与行上没有启动器的裸程序都什么也不加载、Hook 不打到 core。Codex 用一个只放了 `auth.json` 的新 CODEX_HOME，三遍跑完里面没有 `config.toml`；另核 `/api/agents/{id}/integration` 的 `launchArgs`（Codex 的旗标与八个 `-c hooks.*`）、`globalWrites` 为空、迁移记录 `version: 2` 且 `sessionTrust.removed` 为空。
6. **画布内注入（OpenCode / Pi / OMP / Copilot）**：每个 CLI 一个临时 HOME，非交互跑一轮（提示词一行）。画布外直接起，环境里带着节点身份但没有注入；画布内由 core 在这个节点的终端里起（`POST /api/terminals` 带 nodeId 与 agent，环境是 core 给的那份），经 `GET /api/agents` 的 `launcher` 起；节点终端的环境里有 `ARMADRA_SHIMS`、没有 `OPENCODE_CONFIG_*` / `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`（这些由启动器只给 CLI 进程）。断言模型答得出技能名与 `armadra-hook canvas`、扩展或 Hook 的事件回到 core 写出这个节点的状态行；画布外都没有。OpenCode 另用 `debug skill` / `debug config` 不经模型核对。凭据只复制：Pi 复制 `auth.json` 里 API key 形式的那一条；OMP 用同一把 key 经环境变量交给临时 `models.yml`；OpenCode 用包里的原生二进制（npm 包装脚本没跑 postinstall 起不来）和它自带的免费模型；Copilot 的登录在钥匙串里，`gh auth token` 取出的令牌经 `COPILOT_GITHUB_TOKEN` 交给这一个进程。认不上的 CLI 记「未能认证」并跳过，不回退到真实目录。
7. **Claude 的权限请求在画布里答复**：节点用「自动编辑」（`--permission-mode acceptEdits`，盖过操作员设置里的 bypass），经页面让 Claude 跑一条 `node -e` 写文件；断言节点状态 blocked 带 pendingId、请求文件在 `pending/`、节点头的「允许 / 拒绝」可点且没被遮住；允许后文件写出来，拒绝后文件不存在，终端里不残留 Claude 自己的权限对话框。
8. **休眠后经 `send` 唤醒**：关页面让 Claude 睡着，`canvas send` 当场答排队（`TARGET_STARTING`），同一会话 id 起下一代、进程带 `--resume <同一个 id>` 且仍带 `--permission-mode acceptEdits`，投递 `delivered` 并跑完一轮；重开页面问一句，确认接回的是原来那段对话。
9. **组队带 worktree**（§59）：不用真 CLI，自己另起一套 core（临时 git 仓库当工作区，假 CLI 是一段记下自己工作目录再停在 shell 里的 sh），`--only 9` 单跑时不检查 CLI 登录、不起 Vite 与 Chrome。`team --member "…|worktree=名字"` 与按路径的成员各建出一条检出与绑定的 Frame、同名的两个成员共用一个 Frame、成员终端从节点 `cwd` 起在检出里；`open-agent --worktree` 按分支名进同一个 Frame；`--dry-run` 不建，Git 拒绝时画布不多一个节点。
10. **六家互读**（设计 cli-collaboration §8）：claude、codex、opencode、pi、omp、copilot 各起一个**交互式 TUI** 节点，按这个顺序以 `peer` 连成环。每个节点经页面敲一句跑完一轮；环上每个下游以自己的节点身份（`canvasAs` / `contextAs`，换的只是 `ARMADRA_NODE_ID`）`context summary` 与 `context transcript` 读上游，断言非空且「来源」落在那一家的根下（OpenCode 是 `opencode:<id>`）；沿环 `send` 一轮，每条都 `delivered` 且目标真的跑了一轮；半截输入门造一条排队，`DELETE /api/workspaces/{id}/deliveries/{queueId}` 拒收，发送方收件箱（`inboxOf`）出现 `receipt:<queueId>`、投递记录有 `cancelled`；Pi → 下游走一次交接 prepare → accept（材料里有转录摘录、目标收件箱多一条）；会话索引（`conversationsRows`，只取这次的工作目录）每家都有、同一个文件不被两家各认一次，`GET /api/usage/cost` 每家 `source` 不是 none 且 24 小时里记到了用量。`result.json` 的 `sixWay` 记每家每步的通过 / 失败 / 跳过矩阵、每个节点的 `agent_status.transcript_path` 与分段耗时。另外四家的临时 HOME 与凭据和场景 6 是同一个函数（`prepareCliHomes`），但 Pi / OMP 的 agent 目录、`COPILOT_HOME` 与 OpenCode 的 `XDG_DATA_HOME` 指到 core 自己的根（core 才认得出这些会话；Pi 与 OMP 因此共用一个目录）；它们的启动行经页面的「自定义启动命令」（localStorage `armadra.launchOverrides`）换成临时包装脚本，注入参数照常由页面拼上。Claude 用「自动编辑」起：操作员缺省是 bypass 时新版 Claude 先弹「把 auto 设成缺省？」，缺省选项是「是」，一条投递的回车就会改掉 `~/.claude/settings.json`（首跑踩中，已改回；收尾因此单独比对 `permissions.defaultMode`）。Claude 的转录在真实目录，探针把**这一次**的那个文件硬链接进 core 的临时 `CLAUDE_CONFIG_DIR`，索引与成本才扫得到。没装或认证不上的那家整家记 skipped 并写原因，环只连能跑的几家；没跑完首轮的节点不往里投。`--only 10` 单跑约 1.5 分钟（2026-10-02 实测三家：84 秒），花费是每家三轮左右「回复 OK」（首轮、环上一轮、交接目标收到通知后多一轮）。
11. **协调者 ama**（设计 coordinator-agent §8 第 1–4 步）：不用真模型、不用真密钥，和场景 9 一样自己另起一套 core，`--only 11` 单跑。本地起一个 OpenAI 兼容的脚本化模型服务（`agent-e2e/mock-model.mjs::mockModelServer`），临时 HOME 下 ama 的 `config.json` 把内置 `deepseek` 的 `baseUrl` 指到它；假 key 经 `PUT /api/agents/ama/credentials/deepseek` 存进 core（文件密钥后端），由 `run/ama` 凭节点 token 兑换、只设给 ama 进程（`AMA_API_KEY_DEEPSEEK`）。协调者节点的启动行按 `GET /api/agents` 的 `launcher` 与 `resolvedPath`（`<数据目录>/bin/ama`）拼，交给 `sh -c` 跑。断言：注入只有 `--profile`、没有 key 文件；key 到了模型服务（请求头 `Bearer`），却不在节点 shell 的环境、数据目录里除密钥后端外的任何文件与 core 日志里；`agent_status` 有 ama 行且来源 `extension`；`canvas_team` 建出两个成员与两条边；成员 `canvas post` 后收件箱唤醒，协调者 `canvas_inbox → canvas_ack → canvas_sticky` 写出汇总便签、两条结论都确认；画布外同一 profile 的 `ama -p` 工具表里没有画布工具。约 15 秒。

隔离：数据目录、工作空间、浏览器 profile 与 CODEX_HOME 全部 `mktemp`，结束删除并停掉自己的 tmux 服务器。Codex 用临时 CODEX_HOME（只复制 `~/.codex/auth.json`，关掉启动时的升级检查，预先信任工作目录；token 超过 7 天没刷新就拒跑）。Claude 的登录在钥匙串里，临时 `CLAUDE_CONFIG_DIR` 认证不上，所以 Claude 进程用真实配置目录——前提是 Armadra 对 Claude 只经数据目录里的启动器注入（`--settings` 指向数据目录里的文件），探针启动前就检查这一点；core 自己的 `CLAUDE_CONFIG_DIR` 指向临时目录，技能文件只写在那里。终端子进程的环境按白名单建，于是 `SHELL` 换成一个临时包装脚本（导出临时 CODEX_HOME、去掉 CLAUDE_CONFIG_DIR、`exec zsh -f`）。跑前跑后比对 `~/.claude/settings.json`、`~/.codex` 的 `config.toml` / `hooks.json` / `auth.json`、另外四个 CLI 的配置与凭据文件，以及两个 CLI 的版本；Claude 仍会像平常一样在 `~/.claude.json` 与 `~/.claude/projects/` 里记下这个临时目录的会话。

产物默认在 `target/agent-e2e/`：`result.json`（逐条断言、时间线、投递记录、控制台错误、配置比对）、每个场景的截图与 `core.log`。一次全量约 4–5 分钟（实测 245 秒），花费是十几轮「回复 OK」量级的 token。

没验证的：会话宿主后端（Windows）；OpenCode / OMP / Copilot 的交互式 TUI（场景 10 写了它们的路径，但 2026-10-02 这台机器上三家都没装、记 skipped；Pi 的 TUI 真跑过）；打包版见「打包版冒烟」一节。
```

pnpm --filter @armadra/server build
pnpm --filter @armadra/web build
node tools/probes/server-e2e.mjs [输出目录]

````

`apps/server/out/main.js serve` 用临时数据目录启动并托管 `apps/web/dist`（自签名 HTTPS，Chrome 带 `--ignore-certificate-errors`）。无头 Chrome 开两个互不共享 Cookie 的浏览器上下文：管理员打开启动日志里的配对链接完成配对，在「账号与共享」生成只读邀请；成员在另一个上下文打开 `#invite=` 链接注册。之后依次验证：成员打开共享画布与逐页打开设置都没有任何 403（逐条记在 `memberForbidden`、`memberSettings`），设置导航里没有本机管理的那几页（`memberSettingsNav`），界面没有报错横幅与控制台错误；只读时右上角写「只读」、便签拖不动、不发被拒的保存，直接写接口是 403；管理员改成「编辑」后下一拍心跳解除只读、拖动落盘；撤销共享后成员的事件流以 4403 关闭、下一个请求 403、页面离开那块工作空间，他手里的写租约当场释放（管理员打开画布时没有「正在编辑」）；同一浏览器上下文再开一个管理员窗口，它写「本机另一个窗口正在编辑」，点「接管」不弹确认、一次拿到租约，先开的窗口转只读，审计里有一条 `canvas.lease.takeover`（`takeoverAudit`）；最后管理员在服务器壳上新建浏览器节点，起始页是探针自己的回环页面，取画面流上的像素确认第一帧到了。

产物默认在 `target/server-e2e/`：`result.json` 与 `01-admin-paired.png` … `13-second-window-took-over.png`。端口随机，数据目录、项目目录与浏览器 profile 都是 `mktemp`，服务器壳先 SIGTERM（让它收掉自己起的 headless Chromium）再删目录、停 tmux。没有验证：`--public-origin` 与真证书、passkey / OAuth、多于一个成员、手机布局。

## 远端执行主机端到端（假 ssh）

在界面上把远端工作空间用一遍（§34、§44，结果记在 §50），不需要 sshd，也不改任何 SSH 或系统配置。

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/remote-e2e.mjs [输出目录]
````

「远端」就是这台机器：core 本来就读 `ARMADRA_REMOTE_WORKER_LAUNCHER` 替换每条 `ssh` 启动行的 argv[0]（`core/remote/index.ts`），探针把它指到临时目录里的一个假 ssh——按 `ssh(1)` 的规则吃掉选项与目的主机，把剩下的远端命令交给本机 `/bin/sh -c`；Worker 就是 `apps/desktop/out/core/main.js worker --stdio`。执行主机登记与 mock-lsp 的语言服务器设置走接口，其余全在界面上：设置 → SSH 打开远程项目；资源管理器打开文件、编辑、⌘S 落盘；Git 窗口的状态、勾选暂存、提交；日志页右键「获取远端更新」看进行中的提示与百分比，再对一次 upload-pack 睡 30 秒的 fetch 点「取消」；打开 `notes.md` 看 mock-lsp 的诊断（并按进程树确认它跑在 `worker --stdio --language-link` 下面）；在远端磁盘上改开着的文件看编辑器跟上（登记答 `mode: events`）；资源面板按主机筛选；设置 → 执行主机把一个本机工作空间切到假远端再切回来。最后一步走接口：画布上建一个连到假远端的 SSH Agent 节点、开它的终端（与页面同一个请求），敲页面为 SSH 节点敲的那一行 `claude --model probe`；执行主机上的 `claude` 是一个假 CLI，报告它经垫片收到的注入 argv、远端 shell 里的节点身份与端点文件、读到的说明与技能，并照 settings.json 的 Hook 命令报一次 SessionStart，探针在库里看到它经 Worker 中继到达。画布 SSH 终端的 `ssh` 是同一个假 ssh（放在 core 的 `PATH` 最前面），它和真 ssh 一样不带本机的 `ARMADRA_*` 过去；core 带着 `ARMADRA_NO_GLOBAL_WRITES=1`，不碰操作员的 CLI 配置。

产物默认在 `target/remote-e2e/`：`result.json` 与每一步的截图（`01-remote-workspace.png` … `08-remote-injection.png`）。上游是临时目录里的裸仓库，`remote.origin.uploadpack` 指向一个先睡几秒的包装，本机传输才看得到进行中与取消。没有验证：真实的 ssh 传输、主机密钥与 askpass、跨机器的路径与平台差异、真 sshd 对远端命令的处理。

## 浏览器节点的 Agent 工具（armadra-hook browser）

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
node tools/probes/browser-agent-e2e.mjs              # 真 core 的 headless 后端
node tools/probes/browser-agent-e2e.mjs --electron   # 再跑一遍桌面壳的 <webview>
```

真链路：`apps/desktop/out/cli/armadra-hook.js browser <动词>` → 真 core（没有桌面壳时用自己起的 headless Chromium，与服务器壳同一个后端）→ 节点令牌、连线、同工作空间三条授权 → 控制租约 → 动词 → CDP 白名单 → 页面。画布由接口建：一个终端节点连到一个浏览器节点，另有一个没连线的浏览器节点；终端节点起一个 `/bin/sh` 会话换来 core 签发的节点令牌。fixture 是本机随机端口上的一页表单，含同源 iframe 与 `localhost` 那个端口上的跨源 iframe（真 OOPIF）、原生与自绘下拉、HTML5 拖放、悬停菜单、confirm、文件输入、下载、延时文字、一个 200 与一个 404 的 fetch。每个动词都跑（fixture 还有开放与闭合的 shadow root、`<select multiple>`、页底一整块红色的跨源 iframe）：`select` 多选与非 multiple 被拒、`--selector 宿主 >>> 里面` 与闭合 shadow root 的拒绝、整页截图逐屏拼接后页底 iframe 确实是红的；快照（缺省、`--interactive`、`--max-bytes`）、按引用 / 角色名称 / 选择器点击（含两种 iframe 里的元素）、`--snapshot` 差异、`type` / `fill` / `select`、组合键与被拒的按键、`hover` / `drag`、`wait --text / --text-gone / --idle` 与一次 3 秒的超时、控制台与请求元数据（核对 token、Cookie 不出现）、左右滚与滚到元素、视口 / 整页 / 元素截图、PDF、`resize`、上传与下载、对话框阻塞与处理、`--action stop`、导航后旧引用重找、没发过的引用被拒、`back` / `forward`、`tabs --new` 与 `--tab` 读后台标签、`close`、租约查看与交还，外加 `--help` 的浏览器段。`--electron` 起开发构建的 Electron（临时数据目录与 profile，`ARMADRA_DESKTOP_OWNS_RUNTIME=1`、随机 `ARMADRA_RUNTIME_PORT`），在它的渲染页里调接口并打开画布，让浏览器节点挂成真的 `<webview>`，再跑同一批动词；另查第一次驱动之前页面打出的控制台已经读得到（节点一连线就被动旁听）、上传后画布上的选择框提示消失、渲染页没有意料之外的 error。整批动词结束时租约仍是「Agent 正在操作」，即 Agent 自己的 CDP 输入没有被当成人在操作。

真链路：`apps/desktop/out/cli/armadra-hook.js browser <动词>` → 真 core（没有桌面壳时用自己起的 headless Chromium，与服务器壳同一个后端）→ 节点令牌、连线、同工作空间三条授权 → 控制租约 → 动词 → CDP 白名单 → 页面。画布由接口建：一个终端节点连到一个浏览器节点，另有一个没连线的浏览器节点；终端节点起一个 `/bin/sh` 会话换来 core 签发的节点令牌。fixture 是本机随机端口上的一页表单，含同源 iframe 与 `localhost` 那个端口上的跨源 iframe（真 OOPIF）、原生与自绘下拉、HTML5 拖放、悬停菜单、confirm、文件输入、下载、延时文字、一个 200 与一个 404 的 fetch。每个动词都跑：快照（缺省、`--interactive`、`--max-bytes`）、按引用 / 角色名称 / 选择器点击（含两种 iframe 里的元素）、`--snapshot` 差异、`type` / `fill` / `select`、组合键与被拒的按键、`hover` / `drag`、`wait --text / --text-gone / --idle` 与一次 3 秒的超时、控制台与请求元数据（核对 token、Cookie 不出现）、左右滚与滚到元素、视口 / 整页 / 元素截图、PDF、`resize`、上传与下载、对话框阻塞与处理、`--action stop`、导航后旧引用重找、没发过的引用被拒、`back` / `forward`、`tabs --new` 与 `--tab` 读后台标签、`close`、租约查看与交还，外加 `--help` 的浏览器段。`--electron` 起开发构建的 Electron（临时数据目录与 profile，`ARMADRA_DESKTOP_OWNS_RUNTIME=1`、随机 `ARMADRA_RUNTIME_PORT`），在它的渲染页里调接口并打开画布，让浏览器节点挂成真的 `<webview>`，再跑同一批动词；另查上传后画布上的选择框提示消失、渲染页没有任何 error（关标签页时 Electron 自己那句 `Invalid guestInstanceId` 由页面在卸载那一刻拦下，§58）。整批动词结束时租约仍是「Agent 正在操作」，即 Agent 自己的 CDP 输入没有被当成人在操作。

产物默认在 `target/browser-agent-e2e/`：`result.json`（每个场景与每次 hook 调用的耗时）、两个后端各自的快照文本、请求与控制台输出、视口 / 整页 / 元素截图、PDF，以及 Electron 画布前后两张截图。没有验证：Windows 与 Linux（原生下拉在那两处走同一条输入路径，但没跑过）、真实站点（登录、反自动化脚本）、非 macOS 上 Electron 的打印、人与 Agent 同时抢一个页面的交互（租约本身由单测覆盖）。

## 自动化表单的时区选择（服务器壳）

```sh
pnpm libs:build
pnpm --filter @armadra/desktop build
pnpm --filter @armadra/server build
pnpm --filter @armadra/web build
node tools/probes/timezone-picker.mjs [输出目录]
```

自动化抽屉要一个已配对的会话（裸浏览器连桌面 core 只显示「连不上 Host」），所以用服务器壳：打开启动日志里的配对链接，建一个工作空间，自动化 →「新建计划」→ 计划类型选 Cron，在 1440×900 与 390×844 下各看一次时区（§58）：关着时页面上没有任何 `role=option`；打开后最多 60 行、当前值在第一行；输入 `new_y` / `shang` 筛出目标并选中，按钮回写、弹层收起；渲染页没有 error。产物默认在 `target/timezone-picker/`：`result.json` 与 `timezone-closed` / `timezone-open` / `timezone-chosen` / `mobile-timezone-*.png`。端口随机，数据目录、项目目录与浏览器 profile 都是 `mktemp`，结束删除并停 tmux。没有验证：保存计划之后编辑表单里带回的时区（单测覆盖）、键盘上下选择。

## 打包版冒烟

只有打包版才验得出的四件事，结果记在 [TypeScript Core 进度](../../docs/status/typescript-core-status.md) §60。

```sh
pnpm --filter @armadra/desktop dist        # 没有 CSC_LINK 时自动跳过签名与公证
node tools/probes/packaged-smoke.mjs [输出目录] [--app <Armadra.app>]
```

直接执行 `apps/desktop/release/mac-arm64/Armadra.app` 里的二进制，按访达的方式给环境（launchd 的 PATH、`SHELL=/bin/zsh`），`HOME`、`ARMADRA_DATA_DIR`、`--user-data-dir` 都在 `mktemp` 的目录里，Chromium 用 `--use-mock-keychain`（临时 HOME 下没有登录钥匙串）。不安装、不替换 `/Applications/Armadra.app`，也不碰正在运行的那个 Armadra（单实例锁按 `--user-data-dir` 算）。

1. **升级后自动迁移全局安装**：临时 HOME 里预先造出旧版装进各 CLI 全局目录的东西（Claude `settings.json` 的 Hook、Codex `hooks.json`、Copilot `hooks/armadra.json`、OpenCode / Pi / OMP 的状态模块、`skills/armadra`）和用户自己的条目。断言我们的都清掉、清之前有备份（用户也编辑的文件备份在旁边，只有我们写的备份进数据目录）、用户的 Hook / 设置 / 技能原样留着；临时 HOME 的 `~/.codex/config.toml` 预置一条上一版的会话级信任记录和用户自己的行，起打包版后我们的记录被清掉、用户的行留着，画布里起过 Codex（启动器方案，零写入，带 `--dangerously-bypass-hook-trust`）之后也没有写回。
2. **编辑器的 PDF 与视频**：视频夹具由打包版自己的 MediaRecorder 录出来；截图里 PDF 区域不是空白，`<video>` 读得出 320×240、没有解码错误，播一下之后画面不是一块纯色。
3. **节能休眠与唤醒**：真 Codex（临时 HOME 里的 `~/.codex`，只复制 `auth.json`；mise 的 Node 目录用一个符号链接给过去）。`ARMADRA_TEST_ECO_IDLE_SECONDS=20`，页面离开画布后 Codex 进程退出、会话记成休眠；回到画布节点显示「休眠中」，点节点后同一会话 id 起下一代、进程带同一个 provider 会话 id，问「之前让你记的数加一」答 418。
4. **控制台**：渲染进程没有 error 级别的输出与未捕获异常。

产物默认在 `target/packaged-smoke/`：`result.json`、`app.log`、`packaged-media.png`、`packaged-before-hibernate.png`、`packaged-hibernated.png`、`packaged-resumed.png`。没验证：Claude（登录在钥匙串里，临时 HOME 认证不上）、签名与公证后的包、自动更新。
