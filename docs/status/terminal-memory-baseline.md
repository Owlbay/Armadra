# 终端内存基线（桌面壳：10 个持续输出的终端）

> 状态：已验证记录。基线在 P1–P4 合入后的 `main`（`9cd38293`）加本包上，由 macOS 与 Linux 的 GitHub 托管运行器各跑三次夜间作业取中位数（§4）。
> 脚本：`tools/probes/terminal-memory.mjs`（用法见[探针说明](../../tools/probes/README.md)「终端内存基线」）；比对基线：`tools/probes/terminal-memory-baseline.json`；规则：`tools/probes/terminal-memory-lib.mjs` 的 `METRICS`。

## 1. 场景

桌面壳（打包产物，或 `--unpacked` 的开发构建）开一块画布，放 N 个终端节点（缺省 10 个，560 × 340，按窗口大小缩放到全部可见），每个终端的 shell 一起来就跑一个 `perl` 发射器（缺省 100 行 / 秒，彩色前缀 + 约 100 列文字）。阶段：

| 阶段              | 做什么                                                           |
| ----------------- | ---------------------------------------------------------------- |
| `active`          | 预热 60 s 后再等 15 s                                            |
| `offscreen-1m`    | 合成 wheel 平移到没有节点在视口里，等 `--off1`（60 s）           |
| `offscreen-3m`    | 继续离屏到 `--off2`（180 s）；其间量 65 s 的采样轮次             |
| `back-visible`    | 平移回来，等 15 s                                                |
| `switch-x10/x20`  | 离屏 3 s / 回来 3 s 反复 `--cycles` 次，两轮                     |
| `after-forced-gc` | CDP `HeapProfiler.collectGarbage` 后 5 s                         |
| 可选              | `--cadence-check`、`--pressure`、`--restore-check`（见探针说明） |

每个阶段记：各进程物理占用（macOS `top` 的 phys_footprint；Linux `smaps_rollup` 的 Pss 与 VmRSS）、Renderer 的 JS 堆与 DOM 计数、`data-render` / `data-lifecycle` 直方图、tmux 进程树的 RSS 与进程数、Runtime 的 `GET /api/diagnostics/runtime`（契约 §54）读数；`--eld-preload` 时另记同步子进程每秒阻塞的毫秒数。

## 2. 比对的指标与容差

| 指标                                         | 取自                                | 容差（相对 / 绝对）             |
| -------------------------------------------- | ----------------------------------- | ------------------------------- |
| `rendererActiveMiB`                          | `active` 的 Renderer                | 20% / 60 MiB                    |
| `rendererOffscreenLongMiB`                   | `offscreen-3m` 的 Renderer          | 20% / 40 MiB                    |
| `rendererAfterGcDeltaMiB`                    | `after-forced-gc` − `back-visible`  | — / 40 MiB                      |
| `gpuOffscreenLongMiB`                        | WebGL 档 `offscreen-3m` 的 GPU 进程 | 20% / 40 MiB；Linux 只记录      |
| `runtimeEldMaxMs`                            | 全程诊断读数的最大值                | — / 50 ms，且这次 > 100 ms 才算 |
| `runtimeEldP99MedianMs`                      | 全程诊断读数 p99 的中位数           | 50% / 10 ms                     |
| `runtimeSyncBlockedMsPerSec`                 | `--eld-preload`（仅开发构建）       | — / 5 ms/s                      |
| `cadencePsPer65s`                            | 全部离屏时 65 s 内的采样轮次        | — / 2                           |
| `tmuxTreeRssMiB`                             | `active` 的 tmux 进程树             | 30% / 20 MiB                    |
| `tmuxProcs`                                  | `active` 的 tmux 进程数             | 与基线精确相等                  |
| `restoreGridMatches`、`restoreScreenMatches` | `--restore-check`                   | 功能断言，必须为真              |

基线按 `<平台>-<架构>` 存（WebGL 加 `-webgl`，直连后端加 `-direct`），只和同一场景（终端数、速率、渲染器、后端、时长）的运行比。

## 3. 环境

- `darwin-arm64`：GitHub Actions `macos-14` 托管运行器（arm64），Node 22，tmux（Homebrew），夜间 B 档 macOS 作业里的打包产物 `apps/desktop/release/mac-arm64/Armadra.app`。
- `linux-x64`：GitHub Actions `ubuntu-22.04` 托管运行器（x64），Node 22，`xvfb-run` 下的 `linux-unpacked`，软件渲染；内存是 Pss。
- 提交：`perf/terminal-memory-probe` `4a795d06`（`main` `9cd38293`，P1–P4 已合入，加本包）；nightly 37961973088、37964685518、37967150898（第三次 macOS 作业的 `packaged-smoke` 超时失败，`terminal-memory` 通过）。

## 4. 基线（三次与中位数）

### `darwin-arm64`（macos-14）

| 指标                       | 第 1 次 | 第 2 次 | 第 3 次 | 中位数（进基线） |
| -------------------------- | ------: | ------: | ------: | ---------------: |
| `rendererActiveMiB`        |     468 |     465 |     510 |              468 |
| `rendererOffscreenLongMiB` |     181 |     183 |     193 |              183 |
| `rendererAfterGcDeltaMiB`  |     -16 |      17 |      21 |               17 |
| `runtimeEldMaxMs`          |   82.47 |   63.07 |    88.7 |             82.5 |
| `runtimeEldP99MedianMs`    |    6.88 |    6.86 |    7.99 |              6.9 |
| `cadencePsPer65s`          |       2 |       2 |       2 |                2 |
| `tmuxTreeRssMiB`           |    88.8 |   120.4 |    97.7 |             97.7 |
| `tmuxProcs`                |      31 |      31 |      31 |               31 |

### `linux-x64`（ubuntu-22.04，xvfb）

| 指标                       | 第 1 次 | 第 2 次 | 第 3 次 | 中位数（进基线） |
| -------------------------- | ------: | ------: | ------: | ---------------: |
| `rendererActiveMiB`        |  2060.5 |  1057.1 |  1072.5 |           1072.5 |
| `rendererOffscreenLongMiB` |   221.4 |   213.9 |   212.6 |            213.9 |
| `rendererAfterGcDeltaMiB`  |  -449.5 |    31.4 |  -128.8 |           -128.8 |
| `runtimeEldMaxMs`          |   42.23 |   16.87 |   56.68 |             42.2 |
| `runtimeEldP99MedianMs`    |    1.96 |     1.8 |    1.69 |              1.8 |
| `cadencePsPer65s`          |       2 |       2 |       2 |                2 |
| `tmuxTreeRssMiB`           |   154.3 |   156.5 |   154.3 |            154.3 |
| `tmuxProcs`                |      31 |      31 |      31 |               31 |

读法：

- 两个平台全部离屏时每 65 s 都只采样 2 次（改动前 31 次），Runtime 事件循环最大延迟 40–90 ms（改动前最高 1484 ms），全部读数来自 §54 诊断接口（打包版没有 `--eld-preload`，同步阻塞一列为空）。
- 长离屏时十个终端都进了 `detached`，Renderer 回到约 180 MiB（macOS）/ 214 MiB（Linux）。
- tmux 进程数 31 = 1 个服务器 + 10 × (shell + 发射器) + 10 个 core 的控制客户端；tap 的 `cat` 只给 Agent 会话，普通终端不再有。
- Linux 软件渲染下 Renderer 的活跃读数与强制 GC 差值噪声远超容差（活跃 1057 / 1073 / 2061 MiB，GC 差 −450 / +31 / −129 MiB），这两项在 Linux 只记录；三次运行各自对这份基线比都不报退化。

重录：基线在 GitHub 托管运行器上录（B 档就在那里比，开发机的负载与窗口状态不对口）：对要录的提交连跑三次夜间作业，从 `e2e-tier-b-macos` / `e2e-tier-b-linux` 产物里取 `terminal-memory/result.json`，每个平台合并一次：

```sh
gh workflow run nightly.yml --ref <分支>          # 跑三次，各记下 run id
gh run download <run id> -n e2e-tier-b-macos -D runs/mac-1   # Linux 用 e2e-tier-b-linux
node tools/probes/terminal-memory.mjs --merge runs/mac-{1,2,3}/terminal-memory/result.json --machine "GitHub Actions macos-14（arm64），nightly <run id…>"
node tools/probes/terminal-memory.mjs --merge runs/linux-{1,2,3}/terminal-memory/result.json --machine "GitHub Actions ubuntu-22.04（x64），xvfb，nightly <run id…>"
```

`--merge` 把三次的指标取中位数写进 `terminal-memory-baseline.json` 对应平台那一项；三次的原始数与中位数抄进本节。

## 5. 改动前的参考（未进基线）

2026-10-09 在 `main` `7d75ea8f` 上用同一脚本的前身量的 20 个终端（darwin-arm64，DOM 渲染器）：Renderer 活跃约 417 MiB、长时间离屏约 207 MiB、强制 GC 比回到视口少约 67 MiB；WebGL 档全部离屏 GPU 约 317 MiB；Runtime 事件循环最大延迟最高 1484 ms，同步子进程每秒阻塞 40–55 ms；全部离屏时每 65 s 采样 31 次。这些是性能包要改掉的现状，不作基线。
