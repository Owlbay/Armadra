# 终端内存基线（桌面壳：10 个持续输出的终端）

> 状态：**占位，待录**。探针与比对规则已就位；基线要在性能包 P1–P4（Runtime 采样异步 + 诊断接口、徽标可见性与内存压力、终端分阶段生命周期、渲染器策略）合入 `main` 之后，在 macOS 与 Linux 的 GitHub 托管运行器上各跑三次夜间作业、取中位数再写（见 §4）。录之前 `tools/probes/terminal-memory-baseline.json` 的 `platforms` 是空的，B 档只报告不判。
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

待录（机器、系统、Node、tmux、`main` 提交、负载）。

## 4. 基线（三次与中位数）

待录。基线在 GitHub 托管运行器上录（B 档就在那里比，开发机的负载与窗口状态不对口）：对要录的提交连跑三次夜间作业，从 `e2e-tier-b-macos` / `e2e-tier-b-linux` 产物里取 `terminal-memory/result.json`，每个平台合并一次：

```sh
gh workflow run nightly.yml --ref <分支>          # 跑三次，各记下 run id
gh run download <run id> -n e2e-tier-b-macos -D runs/mac-1   # Linux 用 e2e-tier-b-linux
node tools/probes/terminal-memory.mjs --merge runs/mac-{1,2,3}/terminal-memory/result.json --machine "GitHub Actions macos-14（arm64），nightly <run id…>"
node tools/probes/terminal-memory.mjs --merge runs/linux-{1,2,3}/terminal-memory/result.json --machine "GitHub Actions ubuntu-22.04（x64），xvfb，nightly <run id…>"
```

`--merge` 把三次的指标取中位数写进 `terminal-memory-baseline.json` 对应平台那一项；三次的原始数与中位数抄进本节。

## 5. 改动前的参考（未进基线）

2026-10-09 在 `main` `7d75ea8f` 上用同一脚本的前身量的 20 个终端（darwin-arm64，DOM 渲染器）：Renderer 活跃约 417 MiB、长时间离屏约 207 MiB、强制 GC 比回到视口少约 67 MiB；WebGL 档全部离屏 GPU 约 317 MiB；Runtime 事件循环最大延迟最高 1484 ms，同步子进程每秒阻塞 40–55 ms；全部离屏时每 65 s 采样 31 次。这些是性能包要改掉的现状，不作基线。
