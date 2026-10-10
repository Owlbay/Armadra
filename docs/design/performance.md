# Armadra 性能方案设计（2026-10-09）

> 状态：已实施（P1–P5 已合入，见 [终端内存基线](../status/terminal-memory-baseline.md)）。输入：外部性能分析与本仓核实基准（下文「基准 §N」指核实记录的章节，未入库）。
> 基线提交：`main` `7d75ea8f`（#217 OSC 7501 已合入；#216 小地图 `fix/minimap-polish` 仍在进行）。

## 0. 结论

1. **收益最大、风险最低的是 Runtime 采样改异步（A1）**：每 2 s 一轮同步 `ps`/`tmux`/`sysctl`×2/`pmset` 让 Runtime 主线程每秒阻塞 40–55 ms（切换期 88），70–78% 的 5 s 窗口里事件循环最大延迟超过 100 ms，最大 1484 ms（基准 §0.3、§3.2）。目标：同步子进程 0 ms/s，事件循环最大延迟回到空画布的 7–14 ms。
2. **一处 bug 修了就是 15 倍**：`MemoryBadge` 首帧 `sessionId` 为空提前 `return null`，`useOnScreen` 没挂上，离屏 30 s 降速从未生效（基准 §1.1）。修好之后全部离屏时 `ps` 从 2 s 一次降到 30 s 一次。
3. **终端前端分阶段生命周期（B2/B3）拿回的是每个离屏终端 4.5–5 MiB**（20 个约 90–100 MiB，DOM 节点 4191 → 约 500），不是外部分析说的 220 MiB。那 220 MiB 是**可见且持续输出的 DOM 终端**的 Blink（Oilpan）堆（基准 §3.3），只有换渲染策略（B1）才动得了，而 B1 要先做实验。
4. **内存压力（A3）与 WebGL 隐藏名额归还（A4）**：`releaseHidden()` 至今没有调用方；开 WebGL 时 20 个终端全部离屏 GPU 仍占 317 MiB，归还后约 125 MiB（−190 MiB）。
5. **#217 带来的新开销要纳入**：tmux 后端每个会话一个 `pipe-pane` 的 `cat`（约 1 MB 常驻）加 core 对全部原始输出的扫描。建议按需启用（§2.6），并进探针计量。
6. 拆成 5 个并行实现包（§6），合入顺序 P2 → P1 → P3 → P4 → P5；与 #216 的文件不相交，与已合入的 #217 只在契约 / OpenAPI / `use-xterm.ts` 上接续编号与接续代码。

## 1. 现状（file:line，`main` `7d75ea8f`）

### 1.1 Runtime 资源采样

| 位置                                                       | 现状                                                                                                                               | 问题                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/core/resources/sample.ts:326-330`        | `execFileSync("ps", ["-Ao", …], { maxBuffer: 32 MiB })`                                                                            | **无 timeout**；本机约 750 个进程时 70–83 ms，曾卡 1450 ms                                                                                                                                            |
| `core/resources/sessions.ts:119-134`                       | `execFileSync("tmux", [... "list-panes", "-a"])`                                                                                   | **无 timeout**                                                                                                                                                                                        |
| `core/resources/platform-probe.ts:15-26`                   | `run()` 同步、3 s timeout；`:48` `sysctl kern.memorystatus_vm_pressure_level`、`:75` `sysctl vm.swapusage`、`:140` `pmset -g batt` | 每轮每工作空间各跑一遍                                                                                                                                                                                |
| `core/resources/service.ts:283-343` `snapshot()`           | 每次 `this.sampler.refresh()`（`:285`，重跑 `ps`）、`panePids()`（`:286`，重跑 `tmux`）、三个探针（`:312-314`）                    | 一个工作空间一轮全跑                                                                                                                                                                                  |
| `core/resources/service.ts:383-411` `tick`                 | `for (workspaceId of workspaces) snapshot(workspaceId)`，`:413-417` `setTimeout(tick, effectiveInterval())`                        | N 个工作空间 N 次 `ps`；第 2 个以后的工作空间 CPU 基线只隔上一次快照的耗时（约 100 ms），`ps` 的 `time=` 精度 10 ms，CPU% 噪声极大；轮次之间没有 in-flight 保护（现在同步所以不会叠，改异步后必须加） |
| `core/resources/sample.ts:355-383` `Sampler.refresh()`     | 同步、`atMs` 取调用时刻                                                                                                            | 改异步后基线时刻要改成 `ps` 返回时刻                                                                                                                                                                  |
| `core/resources/thresholds.ts:23,121-128` `ThresholdWatch` | 登记了推送的设备时每 30 s 再按工作空间 `snapshot()`                                                                                | 同一条同步路径                                                                                                                                                                                        |
| `core/resources/hosts.ts:62-87`                            | `HostAwareResourceService.snapshot` 覆盖并调 `super.snapshot`                                                                      | 跟着变 async                                                                                                                                                                                          |
| `core/resources/index.ts:147-152,133`                      | `GET …/resources` 与 `ThresholdWatch.sample` 直接调 `service.snapshot`                                                             | 跟着变 async（router 已支持 async handler，见 `:207`）                                                                                                                                                |
| `core/remote/resources-worker.ts:153-170`                  | 远端 worker 用同一套 `Sampler.refresh()` / 探针，同步                                                                              | 另一个进程，不在 Runtime 主线程；本轮保留同步版                                                                                                                                                       |
| 事件循环延迟 / 采样耗时                                    | core 内没有 `monitorEventLoopDelay`，基准靠 `bench/eld-preload.cjs` 外挂                                                           | 打包版 fuse 不读 `NODE_OPTIONS`，外挂只能在未打包壳上用                                                                                                                                               |

### 1.2 页面：徽标可见性

| 位置                                                     | 现状                                                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/panels/resources/use-visibility.ts:17-34`  | `useOnScreen(ref)` 的 effect 依赖 `[ref]`；首帧 `ref.current` 为空就 `return`，之后不再挂                                                                                                                        |
| `apps/web/src/panels/resources/MemoryBadge.tsx:67-68,97` | `anchor` ref 在 `:119` 的按钮上；`:97` `if (!sessionId) return null` 先于按钮渲染。PTY 终端的 `sessionId` 来自 `surface.binding`（`nodes/TerminalNode.tsx:181-185`），WS hello 之后才有，**每个 PTY 终端都命中** |
| `apps/web/src/panels/resources/sampling.ts:27,36`        | `SLOW_INTERVAL_MS = 30_000`；房间取最快档                                                                                                                                                                        |

### 1.3 页面：终端离屏处理

| 位置                                                  | 现状                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/canvas/FlowWorkspace.tsx:498-500`       | `onlyRenderVisibleElements={false}`；理由 `canvas/flow/nodes/ArmadraNode.tsx:29-31`（卸载后 `fit()` 量到 0×0）                       |
| `apps/web/src/terminal/render-state.ts:65-76`         | `resolveRenderState`：`:72-75` 可见但没名额 → `offscreen`（20 个终端时 4 个可见终端走批写，与 WebGL 开关无关）                       |
| `terminal/render-state.ts:92,100,108`                 | `OFFSCREEN_FLUSH_MS = 500`、`HIDDEN_DETACH_MS = 60_000`、`OFFSCREEN_BUFFER_LIMIT = 2*1024*1024`（UTF-16 码元，注释「约 2 MiB」不准） |
| `terminal/surface/use-render-budget.ts:124-131`       | 离屏时不管有没有数据都 `setInterval(flushOutput, 500)`，每个终端一个定时器                                                           |
| `terminal/surface/use-transport.ts:83-93`             | `writeChunk`：直写或入队；`:60-73` 连接前 `terminal.reset()`（tmux attach 后整屏重绘）                                               |
| `terminal/TerminalSurface.tsx:293-305`                | 断开计时只看 `collapsed`（5 s）与 `pageVisible`（60 s）；**平移离屏不进计时**                                                        |
| `terminal/TerminalSurface.tsx:217-223`                | 回到全速时补一次 `refit`                                                                                                             |
| `terminal/surface/use-xterm.ts:39,240`（#217 后行号） | `new Terminal` 在挂载 effect 里，`terminal.dispose()` 只在 effect 清理（节点卸载）时                                                 |
| `terminal/surface/use-refit.ts:14-46`                 | 唯一的 `fit()` 入口；`visibleRef` 为假时空操作                                                                                       |
| `terminal/surface/use-handle.ts:67-72`                | `writeLine` / `sendKeys` 直接 `refs.transportRef.current?.input(...)`，没有传输时**静默丢弃**                                        |
| `terminal/render-budget.ts:409-419` `claimOf`         | 隐藏持有者进隐藏档继续暖着，没有基于时间的释放；`:364-375` `releaseHidden()` 没有调用方（`:361-362` 注释自己写明）                   |
| `terminal/render-budget.ts:51,54,83`                  | 预算 mac 16 / 其他 24                                                                                                                |
| `app/preferences/terminal.ts:97`                      | `webgl: storedBoolean(TERM_WEBGL_KEY, false)`，默认 DOM 渲染器                                                                       |
| `terminal/TerminalSurface.tsx:181-213`                | 按 `preferences.webgl && budgeted` 异步挂 `WebglAddon`                                                                               |
| `apps/desktop/src/main/`                              | 没有内存压力监听；`main/browser/index.ts:115-120` 每 5 s `app.getAppMetrics()` 报壳进程给 core                                       |

### 1.4 #217 之后的新增开销（tmux 后端）

`core/terminal/tmux/program-tap.ts`：每个 tmux 会话 `pipe-pane -O` 起一个 `cat` 写进数据目录的 FIFO，core 用非阻塞句柄读，`program-status.ts` 的扫描器逐字节找 `ESC ]`。`tmux/backend.ts:125` 在每个会话创建 / 接管时无条件 `startTap`。代价：每会话约 1 MB 常驻 + 1 个进程 + 1 个 fd；core 对**全部**原始输出再读一遍（20 个终端 × 100 行/s × 约 120 B ≈ 240 KB/s 的扫描，`deliver` 按会话表线性找名字）。`core/terminal/manager.ts` 现在正好 1500 行（`pnpm repo:check` 上限），任何实现包要改它都得先拆。

### 1.5 基准数字（基准 §3.2，MiB）

| 场景                    | Renderer | GPU | 扣 GPU 合计 | R CPU% | Runtime ELD max ms | 同步子进程 ms/s |
| ----------------------- | -------- | --- | ----------- | ------ | ------------------ | --------------- |
| 空画布                  | 107      | 142 | 281         | 0.1    | 12                 | 0               |
| 20 忙碌 DOM，可见       | 417      | 212 | 623         | 18.8   | 98                 | 45.2            |
| 20 忙碌 DOM，离屏 3 m   | 207      | 123 | 419         | 2.4    | 121                | 47.4            |
| 20 忙碌 DOM，切换 ×20   | 441      | 211 | 649         | 25.9   | 431                | 87.9            |
| 20 忙碌 DOM，强制 GC 后 | 319      | 201 | 530         | 18.7   | 97                 | 36.1            |
| 20 忙碌 WebGL，可见     | 388      | 434 | 589         | 7.6    | 105                | 46.3            |
| 20 忙碌 WebGL，离屏 3 m | 207      | 317 | 411         | 1.9    | 114                | 44.2            |
| 20 空闲，离屏 3 m       | 168      | 126 | 320         | 0      | 248                | 53              |
| 5 忙碌，离屏 1 m        | 124      | 118 | 331         | 0.7    | **1484**           | 67.9            |

内存归因（基准 §3.3，20 个 DOM 终端）：可见时 `blink_gc` 213–237（存活 28–149），离屏 48；V8 66–121；JS 堆快照里没有大块持有者。

## 2. 方案

### 2.1 A1 Runtime 资源采样：异步、超时、一轮一张表（确定有效）

**目标行为**

1. **一轮只读一张整机表。** `ResourceService` 新增 `round(): Promise<SampleRound>`：一次 `ps`、一次 `tmux list-panes`、三个低频探针的缓存值、`cpus().length`，打上 `atMs`（取 `ps` 输出返回的时刻，不是发起时刻）。`snapshot(workspaceId)` 拆成两步：`round()` 取表，`snapshotFrom(round, workspaceId)` 纯计算（`sessionTargets` 的 SQL、树求和、组件、孤立会话），对所有工作空间复用同一轮。
2. **全部异步 + 超时 + 取消。** `sample.ts` 的 `readProcessTable` 改成 `readProcessTable({ signal, timeoutMs = 1500 })`，用 `promisify(execFile)`，`timeout` + `killSignal: "SIGKILL"`，`maxBuffer` 不变；`sessions.ts` 的 `panePids` 同样（1500 ms）；`platform-probe.ts` 的 `run` 改 async（2000 ms）。超时抛 `SampleTimeout`，调用方计数并**跳过这一轮**（不发 `resource.sample`），CPU 基线留着（`MAX_CPU_BASELINE_AGE_MS` 60 s 已经处理过期）。远端 worker（`remote/resources-worker.ts`）保留同步入口 `readProcessTableSync` / `refreshSync`，本轮不改它（另一个进程，不在 Runtime 主线程）。
3. **慢项低频、单独缓存。** `platform-probe.ts` 加 `cached(name, ttlMs, probe)`：内存压力 10 s、交换区 30 s、电源 60 s、磁盘（`statfsSync`，同步但快）30 s。缓存未过期直接返回上一值；过期时**先返回旧值并后台刷新**（stale-while-revalidate），一轮里永远不等探针。首轮没有值时是 `null`（规矩不变：测不到是 `null`）。
4. **不叠加。** `tick` 改成 `async`，`inFlight` 标志：上一轮没结束就跳过并计数 `overlapsSkipped`；下一次 `schedule` 在本轮**完成后**才挂（保持 `setTimeout` 而不是 `setInterval`）。`GET …/resources` 与 `ThresholdWatch.check` 调 `service.snapshot()` 时复用正在进行或 500 ms 内刚完成的那一轮（`roundPromise` + `roundAtMs`），不另起 `ps`。
5. **CPU% 按全局快照修正。** `elapsedMs` 只在 `round()` 里算一次（本轮 `atMs` − 上轮 `atMs`），所有工作空间、组件、主机 CPU 共用；第 2 个以后的工作空间不再是 100 ms 的基线。顺带让 `ThresholdWatch` 的 30 s 慢轮复用同一个 `Sampler`（它现在就是，但每次 `snapshot` 重跑 `ps` 的问题一起消失）。
6. **指标只记数字。** 新文件 `core/resources/metrics.ts`：`monitorEventLoopDelay({ resolution: 10 })` 在资源域 `install` 时 `enable()`，`SamplingMetrics` 记 `rounds`、`lastRoundMs`、`maxRoundMs`（最近 60 轮）、`overlapsSkipped`、`timeouts: { ps, tmux, probe }`、`lastRoundAt`。新路由 `GET /api/diagnostics/runtime`（契约 **§54**，见 §3.1），与 `/api/diagnostics/client-error` 同一种门（登录即可，本机 owner 不用会话）。不进 `ResourceSnapshot`（那是面板的契约，不要为诊断加字段）。事件循环 p99 连续 3 轮超过 200 ms 时记一条 `warn` 日志（只有数字）。

**预期收益**（引用基准）：同步子进程 40–55 ms/s（切换期 88）→ 0；5 s 窗口事件循环最大延迟 100–430 ms（最高 1484）→ 7–14 ms 基线；多工作空间时 `ps` 次数 N×/2 s → 1×/2 s；健康探针最大 86.7 ms（基准 §2）回到 20 ms 以内；第 2 个以后工作空间的 CPU% 不再抖。

**风险与回退**

- `Sampler.refresh` 变 async 牵连 `service.test.ts`、`sessions.test.ts`、`sample.test.ts` 的注入方式：测试注入 `read: () => Promise<Map>`。
- 采样中途工作空间被删：`snapshotFrom` 对 `sessionTargets` 的 SQL 容错（表里没有就是空数组），不抛。
- 超时值取 1500 ms 是本机 70–83 ms 的 20 倍；一台特别慢的机器可能连续超时 → 面板显示破折号而不是错数字，符合「测不到是 `null`」。可在设置 `resources.intervalMs` 之外不再加新设置；超时常量导出供测试。
- 回退：整包一个 PR，revert 即可；契约 §54 标「已撤回」而不删号。

**验收**：`tools/probes/terminal-memory.mjs --terminals 20`（§2.7）`syncBlockedMsPerSec` ≤ 1，每个 5 s 窗口 ELD max < 30 ms（容差见 §2.7）；两个工作空间各开一个面板时 `ps` 每 2 s 一次。

### 2.2 A2 修 MemoryBadge 可见性监听（确定有效，bug）

- `use-visibility.ts`：`useOnScreen(ref, enabled = true)`，effect 依赖 `[ref, enabled]`；`enabled` 为假时返回 `true`（按「看得见」处理，与拿不到 `IntersectionObserver` 同一条规矩）。
- `MemoryBadge.tsx:68`：`useOnScreen(anchor, Boolean(sessionId))`。`sessionId` 从 `null` 变为有值的那次提交之后 effect 重跑，此时按钮已经在 DOM 上。不改 `:97` 的提前返回（没有会话就不该画徽标）。
- `use-render-budget.ts:49` 的 `useOnScreen(refs.bodyRef)` 不受影响（body 首帧就在），不改。

**预期**：全部离屏 60 s 内采样从 30–31 次降到 ≤ 3 次（基准 `bench-results/cadence/result-5.json`）；没有 A1 时阻塞也降到约 3 ms/s。
**风险**：无。**验收**：`--cadence-check` 档 `fresh-nodes-offscreen-60s` 的 `ps` 次数 ≤ 3；组件测试「`sessionId` 从 null 变为有值后 IntersectionObserver 被挂上」（MemoryBadge.test.tsx 现有的「节点不可见时把采样降到 30 秒」一开始就给了 `sessionId`，所以没抓到）。

### 2.3 A3 内存压力：主进程监听 → 页面回收（确定有效）

**事件源（两路，页面取最高档）**

1. **桌面壳主进程**（新文件 `apps/desktop/src/main/memory-pressure.ts`）：每 15 s 一次异步探测，只在等级**变化**时经 IPC 发 `memory:pressure { level: "normal" | "warning" | "critical" }`。
   - macOS：`execFile("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])`，1/2/4 → normal/warning/critical（与 `core/resources/platform-probe.ts:57-62` 同一张表，主进程自己写一份 10 行的纯函数，**不 import core**）。
   - Linux：读 `/proc/pressure/memory`，`some avg10 ≥ 10` → warning，`full avg10 ≥ 5` → critical（这是我们自己定的阈值，写进注释）。
   - Windows：`process.getSystemMemoryInfo()` 的 `free/total < 10%` → warning，`< 5%` → critical。
   - 迟滞：升级立刻发；降级要连续 2 次探到低档才发，避免来回跳。
   - `shared/ipc.ts` 加 `memoryPressure: spec("memory:pressure", "event", "shared")`；`preload/index.ts` 加 `onMemoryPressure = subscribe(...)`，挂在 `window.armadra.memory.onPressure(listener)`；`apps/web/src/platform/desktop-bridge-shell.d.ts` 补声明。
2. **core 的 `resource.sample`**（服务器壳 / 浏览器里跑时的后备）：页面已经收到 `snapshot.host.memory.pressure`（`packages/shared/src/api/resources.ts:35`）。只要画布上有终端就有徽标订阅（A2 修好后离屏也是 30 s 一次），所以只要有东西可回收就有这一路信号。Linux 上 core 报 `null`（`platform-probe.ts:42-47`），此时只有壳那一路。

**页面侧**（新文件 `apps/web/src/terminal/memory-pressure.ts` + 纯函数 `pressure-policy.ts` + 事件总线 `pressure-bus.ts`）

- `pressure-policy.ts` 纯函数：`decide(level, now, last)` → `{ releaseHiddenSlots, releaseOffscreenOlderThanMs, nextAllowedAt }`：
  - `warning`：`releaseHidden()`（`render-budget.ts:364`）+ 释放离屏 ≥ 30 s 的前端实例（§2.4 的 `released`）；
  - `critical`：`releaseHidden()` + 释放**所有**不可见实例（离屏 / 折叠 / 窗口后台，不限时长）；
  - 可见与聚焦的一律不动（与 `selectGranted` 的规矩同一个理由）；
  - 同一档 20 s 内不重复扫（节流），降回 `normal` 不做任何事（不主动重建，等用户看到再恢复）。
- `pressure-bus.ts`：`onMemoryPressure(listener)` / `emitMemoryPressure(level)`，壳与 `resource.sample` 两路都往这里发，去重取最高档。§2.4 的生命周期 hook 订阅它。

**预期**：只开 WebGL 时立刻释放隐藏持有者（16 个约 190 MiB GPU）；配合 B2 每个离屏终端再省 4–5 MiB Renderer。
**风险**：压力反复跳变时来回重建——靠迟滞 + 节流 + 「降级不重建」三条挡住。壳的探测每 15 s 一次 `sysctl`（异步，主进程），可忽略。
**回退**：IPC 事件没人听就是空操作；页面模块一个开关常量 `MEMORY_PRESSURE_ENABLED`。
**验收**：注入假压力事件（探针经 CDP 调 `emitMemoryPressure("warning")`）后 `data-render` 不变、`data-lifecycle` 里离屏实例进入 `released`，GPU 足迹回落到 DOM 档（约 123 MiB）。

### 2.4 B2/B3 终端前端分阶段生命周期（确定有效，收益约 4.5–5 MiB/终端）

**三层分离**

| 层         | 东西                                                                                                                                     | 谁拥有                                                 | 释放时怎样                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| 会话层     | tmux / direct 会话、PTY、程序状态                                                                                                        | core                                                   | 永远不动（已有：`detached` 只关 socket） |
| 终端状态层 | `TerminalSurface` 的 React 状态：`sessionId`、`attempt`、`status`、`SurfaceRefs`（输入日志、离屏缓冲、重连退避、**最后行列数**）、启动器 | 页面，组件常驻（画布不裁剪节点，§1.3 的 F01 理由不变） | 保留                                     |
| 显示层     | `Terminal` 实例、FitAddon、WebGL/DOM 渲染器、ResizeObserver、滚轮桥、主题观察                                                            | `use-xterm.ts`                                         | **可以整体销毁再重建**                   |

**生命周期阶段**（新 hook `surface/use-lifecycle.ts`，纯函数 `terminal/lifecycle.ts` 决定迁移，DOM 上 `data-lifecycle` 暴露）

| 阶段       | 进入条件                                                                               | 显示层             | 传输 | 输出                                 |
| ---------- | -------------------------------------------------------------------------------------- | ------------------ | ---- | ------------------------------------ |
| `live`     | 可见（未折叠 + 视口内 + 窗口前台）                                                     | 有                 | 连着 | 直写                                 |
| `parked`   | 离屏 / 折叠 / 后台，< `DETACH_MS`                                                      | 有                 | 连着 | 共享调度器 500 ms 批写（有数据才排） |
| `detached` | 离屏连续 ≥ `DETACH_MS`（折叠 5 s、平移离屏 60 s、窗口后台 60 s；**平移离屏也进计时**） | 有（保留最后一屏） | 关   | 无                                   |
| `released` | `detached` 连续 ≥ `RELEASE_MS`（缺省 10 min，设置项见 §3.2）或内存压力提前             | **销毁**           | 关   | 无                                   |

回到可见：`released` → 重建显示层 → 连传输 → tmux attach 整屏重绘 / direct 发 snapshot → `live`；`detached` → 连传输（现有「reset → attach」路）→ `live`；`parked` → 立刻灌缓冲 → `live`。

**尺寸：三道保险，解决「卸载后量到 0×0、行列错」**

1. 显示层**只在可见时重建**（`wantsSlot` 为真的那一帧），此时 body 可量；离屏节点仍在 DOM 上（不裁剪），`getBoundingClientRect` 是真实尺寸，所以即使在 `parked` 期间重建也量得出。
2. `SurfaceRefs` 新增 `gridRef: { cols, rows }`，每次 `refit` 发出 resize 与每次 hello 后更新；重建 `Terminal` 时用 `new Terminal({ cols, rows: gridRef })` 作为初值。于是首帧 `fit.proposeDimensions()` 若与初值一致就不发 resize，core 不动窗口、tmux 不多重绘一次；`helloNeedsResize(hello, terminal)` 也对得上。
3. `use-refit.ts` 加门：`proposeDimensions()` 返回 `undefined` 或 `cols < 2 || rows < 1`（容器 0×0：折叠、字体未就绪）一律不 `fit`、不发 resize；下一次 `active` 变真时 `TerminalSurface.tsx:217-223` 已经会补一次。

**释放的豁免**（`lifecycle.ts` 的 `canRelease(inputs)`，全部可单测）

- 启动序列未完成：`launchPhaseRef !== "idle"` 且还没 `sent`，或 `agent.pendingLaunch`；
- `status.connection` 是 `starting` / `connecting`，或 `hibernation === "resuming"`；
- 节点是聚焦节点（`focusNodeId`）；
- 有未确认的输入（`inputLogRef` 里还有没落地的条目）；
- Agent 状态是 `blocked`（在等审批）——审批按钮在头部，不需要终端，但用户多半马上就要看，释放是净亏。

**输入到一个 `detached` / `released` 的终端**（修 `use-handle.ts:67-72` 的静默丢弃）：`writeLine` / `sendKeys` / `paste` / `focus` 调 `lifecycle.revive("input")`：`released` 先重建显示层（可以在离屏时重建，见尺寸第 1 条），`detached` 置 `detached=false` 重连；输入经 `transport` 的 pre-hello 队列（`transport.ts:18`）在 attach 后按序发出，一个字节不丢。投递（`collab`）走 core 的终端桥，不经页面，不受影响。

**B3 离屏停止无效工作**

- 共享调度器 `terminal/flush-scheduler.ts`：全页一个 500 ms 定时器，只在至少一个表面有待灌数据时运行；`writeChunk` 入队时 `scheduler.request(flush)`，灌完就从集合里移除；没有数据没有定时器。替换 `use-render-budget.ts:124-131` 的每表面 `setInterval`。
- 写入背压：灌缓冲时用 `terminal.write(text, callback)`，上一批没被 xterm 消化完不灌下一批（每表面一个 `flushing` 标志）；离屏缓冲上限改按**字节估算**（`chunk.length * 2`），注释改成「4 MiB 码元 / 约 2 MiB Latin1」或直接把常量定义为码元并把注释改对。
- `detached` 之后输出流在 core 侧根本不发（socket 关了），这才是真正的背压；回来靠 tmux 重绘 / direct 回放环。
- 渲染名额与 DOM 渲染器解耦（修 `render-state.ts:72-75` 的副作用）：`preferences.webgl === false` 时 `budgeted` 对渲染状态无意义，可见即 `visible`（直写）；名额只在 WebGL 开着时才决定档位。这一条由 P3 做（P4 把布尔换成枚举后保持语义）。

**预期收益**：20 个终端离屏 10 min 后 Renderer 从 186–207 MiB 降到空画布 107 + ≈10 MiB；DOM 节点 4191 → 约 500；离屏 Renderer CPU 1.2–2.4% → ≈0（定时器没了、socket 关了）；20 次往返后以强制 GC 读数为准不持续抬高（现在 441 → 319 是 GC 推迟，不是泄漏，基准 §3.2）。
**风险**：正在看的选区、搜索高亮、xterm 自己的回滚内容在 `released` 时丢（tmux 后端历史在 tmux，滚轮桥照旧；direct 后端靠回放环只拿回一屏 + 回放）；聚焦恢复一帧闪；`use-xterm.ts` 的 effect 现在只依赖 `[refs, nodeId, refit]`，加 `mounted` 与 `instance` 代次后 `use-transport.ts` 的 effect 也要以代次为依赖才会在重建后重连——改错就是「重建后没连上」，必须有渲染测试覆盖。
**回退**：`RELEASE_MS` 设 `never`（设置项）即退回今天的行为；`detached` 的平移离屏计时单独一个常量可以关。
**验收**：离屏 `RELEASE_MS` 后 Renderer ≈ 空画布 + 10 MiB；恢复后行列数与释放前一致、`tmux capture-pane` 与页面可见文本一致、光标位置一致；`released` 时 `writeLine` 后字节到达 PTY 且顺序正确；20 次往返强制 GC 后 Renderer 不高于首次 `back-visible` 读数 + 40 MiB。

### 2.5 B1 渲染器策略：DOM vs WebGL（A4 确定有效；其余需实验）

**事实**（基准 §3.2、§3.3，20 个忙碌终端）：WebGL 稳态 `blink_gc` 62–64 vs DOM 213–237，Renderer CPU 7.6% vs 18.8%，Renderer 388 vs 417；但 GPU 434 vs 212（`shared_images` 249 vs 103）。扣 GPU 口径 WebGL 省 34 MiB，整机口径 WebGL 多约 190 MiB。离屏时 WebGL 隐藏持有者占 GPU 317 vs 123。

**默认策略（本轮定）**

1. 默认仍是 DOM 渲染器（§18.2 规则 5 的文字清晰、整机内存更低）。
2. **A4：隐藏持有者 30 s 后归还名额**（`render-budget.ts` `claimOf`）：`hiddenAt` 超过 `RENDER_HIDDEN_RELEASE_MS = 30_000` 的隐藏持有者不再进隐藏档，由 `reevaluate` 收回；用一个单独的定时器在最早到期的那条上触发重算，不每条一个计时器。平移回来重建 WebGL 上下文约 1 帧（去抖 150 ms 已有）。预期：WebGL 20 个离屏 GPU 317 → ≈125 MiB。默认 DOM 不受影响。
3. 渲染名额只约束 WebGL（见 §2.4 B3 最后一条）。

**实验项（带开关，默认关）**

| 实验          | 开关（localStorage，设置页「终端外观 → 渲染」，标「实验」）                                                                   | 假设                                                                                                                       | 判据                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| E1 自动渲染器 | `armadra.terminal.renderer = "dom" \| "webgl" \| "auto"`（取代布尔 `armadra.terminal.webgl`；旧键不读，WebGL 用户重新选一次） | `auto`：聚焦 + 最近可见的 ≤ 4 个用 WebGL，其余 DOM。忙碌终端通常就那几个，Oilpan 堆主要来自它们                            | 20 可见忙碌：`blink_gc` < 100 MiB、R CPU < 10%、GPU ≤ DOM 档 + 80 MiB   |
| E2 低缩放限帧 | `armadra.terminal.repaintThrottle = "off" \| "lowZoom"`                                                                       | 缩放 < 0.5 时非聚焦可见 DOM 终端写入合并到 100 ms（10 fps）；Oilpan 堆与 `replaceChildren` 次数成正比，6× 少刷就少一半以上 | 同上；聚焦终端输入回显 p95 延迟不变（探针用 CDP 量键入 → DOM 文本出现） |
| E3 上游       | 推动 xterm DOM 渲染器复用行内 span                                                                                            | —                                                                                                                          | 不在本仓库                                                              |

实验规程：每档 ≥ 3 次，读 `after-forced-gc` 与稳态两种读数，比 `blink_gc`、Renderer CPU、GPU、ELD；此前把名额设成 4 的那次实验噪声 60–442 MiB（基准 §4 B1），不能作数。结论写进 `docs/status/terminal-memory-baseline.md` 再决定是否改默认。

### 2.6 #217 程序状态 tap 的开销（新增，随 P1 或单独小包）

- 按需启用：`tmux/backend.ts:125` 的 `startTap` 只对会发 OSC 7501 / 9;4 的会话开——节点带 Agent（`spawn-request` 里有 `agentId`）或注册表声明 `programStatus: true` 的 CLI；普通 shell 不开。手动 `tmux` 接管的会话在 `adopt` 时按同一规则。
- 会话 `detached`（没有附着）且长时间空闲时不停 tap（状态徽标正是离屏时要看的）；休眠 / 退出已经停。
- 扫描器已是 O(n)、不攒字节；`deliver` 的按名字线性查找改成 `Map<name, key>`（小）。
- 计量：探针（§2.7）记 tmux 进程树 RSS 与进程数（基准脚本已有 `tmuxRssMb` / `tmuxProcs`），以及 Runtime 在 20 个忙碌终端下的 CPU%，阈值见 §2.7。
- 若需改 `manager.ts`（1500 行上限）：先把 `connectProgramStatus` 相关接线抽到 `manager-program.ts`，再做本条。

### 2.7 验收与回归探针（固化 bench）

把 `perf-diag-20261009/bench/terminal-memory.mjs` 收进仓库为 `tools/probes/terminal-memory.mjs`（纯函数部分 `terminal-memory-lib.mjs` + `terminal-memory.test.mjs`），与 `server-perf.mjs` 同一种基线比对（`compare()`：差 > 20% **且**超过该项绝对容差才算回归；没有该平台基线时只报告）。

**场景**：`--terminals 5|10|20`（缺省 10），`--rate 100`（`0` = 空闲对照），`--renderer dom|webgl`，阶段 `active → offscreen-1m → offscreen-3m（夜间）/ offscreen-10m（人工）→ back-visible → switch-x10 → switch-x20 → after-forced-gc`，加 `--cadence-check`、`--pressure`（注入假压力）、`--restore-check`（释放后恢复：行列数、`tmux capture-pane` 文本、光标）。

**记录**：各进程 phys_footprint（macOS `top`；Linux `/proc/<pid>/smaps_rollup` 的 Pss + `VmRSS`），Renderer 的 DOM 计数 / JS 堆 / `data-render` / `data-lifecycle` 直方图（CDP），GPU（macOS `vmmap` IOSurface；Linux 软件 GL 不比），tmux 树 RSS 与进程数，Runtime 的 `GET /api/diagnostics/runtime`（ELD p50/p99/max、`lastRoundMs`、`timeouts`、`overlapsSkipped`）——**用诊断接口替代 `NODE_OPTIONS` 外挂**，打包版也量得到；`--eld-preload` 保留给未打包壳做对照。

**基线与容差**（`tools/probes/terminal-memory-baseline.json`，按 `<platform>-<arch>`，10 个终端、`rate 100`，三次中位数）

| 指标                                                        | 现状（20 个，darwin-arm64） | 目标（A1–A4 + B2 后） | 容差（相对 / 绝对）                    |
| ----------------------------------------------------------- | --------------------------- | --------------------- | -------------------------------------- |
| `rendererActiveMiB`                                         | 417                         | 不变（B1 之前）       | 20% / 60                               |
| `rendererOffscreenLongMiB`（释放后）                        | 207                         | ≤ 空画布 + 15         | 20% / 40                               |
| `rendererAfterGcDeltaMiB`（after-forced-gc − back-visible） | −67                         | ≤ +40                 | — / 40                                 |
| `gpuOffscreenLongMiB`（WebGL 档）                           | 317                         | ≤ 130                 | 20% / 40                               |
| `runtimeEldMaxMs`（全程最大）                               | 1484                        | ≤ 50                  | — / 50（> 100 才算回归）               |
| `runtimeEldP99MedianMs`                                     | 15–30                       | ≤ 15                  | 50% / 10                               |
| `runtimeSyncBlockedMsPerSec`（仅未打包壳）                  | 40–55                       | 0                     | — / 5                                  |
| `cadencePsPer65s`（全部离屏）                               | 31                          | ≤ 3                   | — / 2                                  |
| `tmuxTreeRssMiB`、`tmuxProcs`                               | 待录                        | 1 cat/Agent 会话      | 30% / 20；进程数 = 会话数 × k 精确断言 |
| `restoreGridMatches`、`restoreScreenMatches`                | —                           | 必须为真              | 功能断言，不是性能容差                 |

夜间 B 档：`tools/ci/e2e.d/terminal-memory.json` `{ tier: "b", platforms: ["darwin", "linux"], requires: ["tmux"], args: ["{out}", "--terminals", "10", "--off1", "60", "--off2", "180", "--cycles", "10"], timeoutMinutes: 30 }`；macOS 作业用 `apps/desktop/release/*.app` + `--remote-debugging-port`（与 `packaged-smoke.mjs:361` 同一种起法），Linux 在 `xvfb-run` 下用 `linux-unpacked`，GPU 列只记录不比。失败照 nightly 既有规则开 issue、不阻断合并。`docs/status/terminal-memory-baseline.md` 记环境、三次原始数与中位数，登记进 `docs/README.md`。

## 3. 契约与设置项改动

### 3.1 契约（`docs/contracts/core-json-api.md`，新增 §54，不动既有节号）

`GET /api/diagnostics/runtime`（门同 §30：登录即可，桌面壳本机请求算 owner）：

```json
{
  "eventLoop": { "windowMs": 60000, "p50Ms": 1.2, "p99Ms": 8.4, "maxMs": 23.1 },
  "sampling": {
    "intervalMs": 2000,
    "inFlight": false,
    "rounds": 1310,
    "lastRoundMs": 84,
    "maxRoundMs": 212,
    "overlapsSkipped": 0,
    "timeouts": { "ps": 0, "tmux": 0, "probe": 1 },
    "lastRoundAt": "2026-10-09T10:00:00.000Z"
  }
}
```

只有数字与时间戳；没有命令行、路径、进程名。RPC 表（§43.8）加一行 `diagnostics.runtime`（query，`canvas:read`），协议 minor 25 → 26；`docs/contracts/core-openapi.json` 同步。`ResourceSnapshot` 形状不变。

### 3.2 页面设置（localStorage，`apps/web/src/app/preferences/terminal.ts`，设置页「终端外观 → 渲染」组）

| 键                                 | 值                                  | 缺省    | 文案键（`apps/web/src/i18n/terminal.ts`，中英同步）                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `armadra.terminal.releaseAfter`    | `"5m" \| "10m" \| "30m" \| "never"` | `"10m"` | `terminal.settings.releaseAfter` 「离屏多久后释放终端画面」/ "Release terminal view after"；选项 `terminal.settings.releaseAfter.5m` 等；脚注 `terminal.settings.releaseAfterHint` 「只释放页面里的画面，会话继续运行；回到视口时重新接上。」/ "Only the on-page view is released; the session keeps running and reattaches when scrolled back into view." |
| `armadra.terminal.renderer`        | `"dom" \| "webgl" \| "auto"`        | `"dom"` | `terminal.settings.renderer` 「渲染器」/ "Renderer"；`…renderer.dom` 「DOM」、`…renderer.webgl` 「WebGL」、`…renderer.auto` 「自动（实验）」/ "Auto (experimental)"；取代现有 `terminal.settings.webgl` 开关                                                                                                                                               |
| `armadra.terminal.repaintThrottle` | `"off" \| "lowZoom"`                | `"off"` | `terminal.settings.repaintThrottle` 「缩小时限帧重绘（实验）」/ "Throttle repaint when zoomed out (experimental)"                                                                                                                                                                                                                                          |

没有新的 core 设置；`resources.intervalMs` 不变。壳的 `memory:pressure` 是壳内 IPC，不进 core 契约，写进 `docs/guides/architecture.md` 的壳 ↔ 页面一节。

### 3.3 DOM 诊断属性

`[data-slot="terminal-body"]` 在既有 `data-render` 之外加 `data-lifecycle="live|parked|detached|released"`；`data-render` 的六个值不变（不改 `TerminalRenderState`，节点头的胶囊也不变：`released` 对用户仍显示「已断开（省电）」）。

## 4. 测试要求

| 包  | 必须有的测试                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | `service.test.ts`：`ps` 挂住（注入永不 resolve 的 read，fake timers）时 tick 不阻塞、超时后计数并跳过；两个工作空间一轮只读一次表；上一轮未完成时跳过并计 `overlapsSkipped`；GET 在 tick 进行中复用同一轮；探针缓存按 TTL 返回旧值并后台刷新；多工作空间 CPU% 用同一 `elapsedMs`。`metrics.test.ts`：计数与窗口。`diagnostics/routes.test.ts`：§54 的形状、匿名主体 401。`tmux.test.ts`：tap 只对 Agent 会话启动。 |
| P2  | `use-visibility` / `MemoryBadge.test.tsx`：`sessionId` 从 null 到有值后观察器挂上、离屏降到 slow。`main/memory-pressure.test.ts`：三平台解析、迟滞、只在变化时发。`pressure-policy.test.ts`：warning/critical 的动作、节流、降级不动。`render-budget.test.ts`：隐藏 30 s 后归还、`releaseHidden` 经总线触发。                                                                                                      |
| P3  | `lifecycle.test.ts`（纯函数）：阶段迁移、豁免、压力提前。`TerminalSurface.render.test.tsx`：离屏 → detached → released 的 `data-lifecycle`；回到可见重建实例并重连（传输 effect 以代次为依赖）；重建时 `cols/rows` 用 `gridRef`；`proposeDimensions` 返回 0×0 时不发 resize；`released` 下 `writeLine` 先复活再按序发出。`flush-scheduler.test.ts`：无数据无定时器、多表面共用、背压串行。                         |
| P4  | `TerminalLookPage.test.tsx`：三个新行、枚举持久化；`preferences` 读旧键不生效（无兼容）。`use-webgl.test.ts`：`auto` 的选择规则。                                                                                                                                                                                                                                                                                  |
| P5  | `terminal-memory.test.mjs`：`compare()` 容差规则、`--restore-check` 断言、JSON 清单通过 `e2e.mjs --list`。                                                                                                                                                                                                                                                                                                         |

共同：改动结构后 `pnpm check`；前端 `pnpm --filter @armadra/web test` / `typecheck`，core 与桌面壳 `pnpm libs:build && pnpm --filter @armadra/desktop test`。

## 5. 风险总表与回退

| 项   | 风险                                           | 回退                                                     |
| ---- | ---------------------------------------------- | -------------------------------------------------------- |
| A1   | async 化牵连三组测试；超时跳轮让面板偶尔少一帧 | 单 PR revert；§54 标撤回                                 |
| A2   | 无                                             | —                                                        |
| A3   | 压力抖动时反复回收                             | 迟滞 + 节流 + 降级不重建；`MEMORY_PRESSURE_ENABLED` 常量 |
| A4   | WebGL 用户平移回来闪一帧                       | `RENDER_HIDDEN_RELEASE_MS = Infinity`                    |
| B2   | 重建后没连上 / 尺寸错 / 选区丢                 | 设置 `never`；三道尺寸保险各自可测                       |
| B3   | 共享调度器漏灌                                 | 单测覆盖；保留每表面 `flushOutput` 立即路径              |
| B1   | 整机内存反而升                                 | 实验开关默认关，不改默认                                 |
| §2.6 | 普通 shell 不再有程序状态                      | 规则在一处，可改成「全开」                               |

## 6. 实现包（并行）

| 包                                    | worktree / 分支                                                              | 文件边界（只写这些）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 依赖与合入顺序                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P2 徽标可见性 + 内存压力 + A4**     | `Armadra-worktrees/perf-badge-pressure`，`perf/badge-pressure`               | `apps/web/src/panels/resources/{use-visibility.ts, MemoryBadge.tsx, *.test.tsx}`；`apps/web/src/terminal/{render-budget.ts, render-budget.test.ts, memory-pressure.ts, pressure-policy.ts, pressure-bus.ts}` + 测试；`apps/web/src/panels/resources/sampling.ts`（把 `host.memory.pressure` 转发到总线，10 行）；`apps/desktop/src/main/{memory-pressure.ts, memory-pressure.test.ts, index.ts}`、`apps/desktop/src/shared/ipc.ts`、`apps/desktop/src/preload/index.ts`、`apps/web/src/platform/desktop-bridge-shell.d.ts`；`docs/guides/architecture.md`（壳 ↔ 页面一节）                                                                                  | 最先合（最小、独立）。P3 订阅它的 `pressure-bus.ts`                                                                                                       |
| **P1 Runtime 采样 + 诊断 + tap 按需** | `Armadra-worktrees/perf-runtime-sampling`，`perf/runtime-sampling`           | `apps/desktop/src/core/resources/{sample,sessions,platform-probe,service,hosts,thresholds,index,metrics}.ts` + 测试；`apps/desktop/src/core/diagnostics/{routes.ts, index.ts}` + 测试；`apps/desktop/src/core/http/route-scopes.ts:56,208` 与 `core/http/routes.ts:1355` 旁（§54 路径照 `client-error` 登记进 `SELF_GUARDED` 与路由清单）；`packages/shared/src/api/diagnostics.ts`（新，可选）；`docs/contracts/core-json-api.md`（**只加 §54 与 §43.8 一行**）、`docs/contracts/core-openapi.json`；`apps/desktop/src/core/terminal/tmux/backend.ts`（tap 按需，`startTap` 一处）与 `tmux/tmux.test.ts`；**不碰 `manager.ts`**（需要就先单独一个拆分提交） | 第二合。与 #217 同文件（契约、OpenAPI、`tmux/backend.ts`）但已在 main，不冲突                                                                             |
| **P3 终端生命周期 + 调度器**          | `Armadra-worktrees/perf-terminal-lifecycle`，`perf/terminal-lifecycle`       | `apps/web/src/terminal/{render-state.ts, lifecycle.ts, flush-scheduler.ts}` + 测试；`apps/web/src/terminal/surface/{use-lifecycle.ts, use-render-budget.ts, use-xterm.ts, use-transport.ts, use-refit.ts, use-handle.ts, refs.ts, constants.ts}`；`apps/web/src/terminal/TerminalSurface.tsx`（生命周期接线与断开计时两段）、`TerminalSurface.render.test.tsx`；`apps/web/src/app/preferences/terminal.ts`（只加 `releaseAfter` 字段与缺省，不加 UI）；`docs/design/terminal-host-design.md`（§7.5 新小节）                                                                                                                                                  | 第三合，在 P2 之后（import `pressure-bus.ts`）。`use-xterm.ts` 已含 #217 的 `registerProgramOsc`（`:20,146`），在其基础上改                               |
| **P4 渲染器策略与设置页**             | `Armadra-worktrees/perf-renderer-policy`，`perf/renderer-policy`             | `apps/web/src/app/preferences/terminal.ts`（`renderer` / `repaintThrottle` 枚举，删除布尔 `webgl`）、`apps/web/src/app/preferences-store.ts`、`apps/web/src/panels/settings/pages/TerminalLookPage.tsx` + 测试、`apps/web/src/i18n/terminal.ts`（§3.2 全部文案，含 `releaseAfter`）；新 `apps/web/src/terminal/surface/use-webgl.ts`（把 `TerminalSurface.tsx:181-213` 的 WebGL effect 搬出来并加 `auto` / 限帧）；`TerminalSurface.tsx` 只剩「删 effect、调 hook」一处                                                                                                                                                                                      | 第四合，基于 P3 rebase：两包都碰 `preferences/terminal.ts` 与 `TerminalSurface.tsx`，改动段落不重叠，P4 负责解决                                          |
| **P5 探针与基线**                     | `Armadra-worktrees/perf-terminal-memory-probe`，`perf/terminal-memory-probe` | `tools/probes/{terminal-memory.mjs, terminal-memory-lib.mjs, terminal-memory.test.mjs, terminal-memory-baseline.json, README.md}`；`tools/ci/e2e.d/terminal-memory.json`；`docs/status/terminal-memory-baseline.md`、`docs/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                        | 可与其余并行开发（先用 `--eld-preload` 对照），**基线在 P1–P4 合入后的 main 上录三次再写**；最后合。`tools/probes/README.md` 已含 #217 的改动，在其上追加 |

与 #216（`canvas/flow/Minimap*.tsx`、`minimap-links.ts`、`lib/use-throttled-value.ts`、`styles/canvas.css`、`showcase/sections/canvas.tsx`、`docs/design/design-system.md`）：五个包都不碰。唯一共同文件是 `docs/status/completion-progress.md`（各包末尾追加一段，谁后合谁 rebase）。

每包交付：代码 + 测试 + 本文对应小节的验收数字（P1/P2/P3 用 P5 的探针跑一次附在 PR 里，P5 未合入前用 仓库外的临时基准脚本 原脚本）。

## 7. 开放问题

1. B1 的「扣 GPU」还是「整机」口径由产品定；本文默认整机，所以不改默认渲染器。
2. 远端 worker 的同步采样（`remote/resources-worker.ts`）是否也改 async：另一个进程，收益小，留到有远端卡顿证据再做。
3. 直连后端（无 tmux）的 scrollback 5000 行真的会攒满（约 4–5 MiB/终端，基准 §4 B4）：P5 的探针加 `--backend direct` 开关先量，再决定是否随 `released` 一起缩。
