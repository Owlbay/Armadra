# CI 与发布

两份工作流：`.github/workflows/ci.yml` 在每个 PR 与 `main` 上跑三平台检查，
`.github/workflows/release.yml` 在推标签时打出全部产物并创建 draft Release。

## 1. ci.yml

触发：`pull_request`，以及推到 `main`。同一分支的新提交会取消上一次运行
（`concurrency` + `cancel-in-progress`）。权限只有 `contents: read`。

一个作业 `check`，矩阵三行：

| runner           | 标签           |
| ---------------- | -------------- |
| `ubuntu-latest`  | linux-x86_64   |
| `macos-14`       | macos-aarch64  |
| `windows-latest` | windows-x86_64 |

三行跑同一串步骤（另有一个只在 ubuntu 上跑的 `e2e` 作业，见 §1.1）：

1. `pnpm install --frozen-lockfile`
2. `pnpm check`（libs:build、prettier、`lint`、typecheck、`repo:check`、
   `ci:workflows`、`release:check`、`notices:check`）；ESLint 只有 error 让它失败
3. `pnpm repo:test`（含 `tools/lint-config.test.mjs`）、`pnpm release:test`
4. `pnpm -r --if-present test` / `typecheck`、`pnpm --filter @armadra/web build`；
   Linux 那一行的 `test` 带 `ARMADRA_COVERAGE=1`，web、desktop、server 出 lcov 并作为
   `coverage-lcov` 产物上传（只出报告，不设门槛）
5. `pnpm plugin:test` 与 `pnpm controller:real:test`（纯客户端和真实验收只读预检的单测，不调用模型或 CI 账号）
6. `pnpm --filter @armadra/desktop build`（不打包）
7. Linux/macOS：`plugin:build` 与 controller 的真 Unix socket/PTY、取消、大日志、重启和四个精确崩溃边界；内层为确定性假 CLI，不替代真实双 Agent 验收。

几条不显然的决定：

- **平台差异只用运行期门控表达。** Windows 上跑不了的用例（tmux 会话、Unix
  socket、`/bin/sh`、symlink 逃逸）在源码里按 `process.platform` 跳过，CI 不写
  任何按名字过滤的排除。按名字过滤的用例在它开始能跑之后没人会去掉过滤。
  `tools/ci/validate-workflows.test.mjs` 会断言工作流里没有这类过滤。
- **`.gitattributes` 把全仓统一成 LF。** Windows runner 默认
  `core.autocrlf=true`，而 `prettier --check` 是按字节比对，CRLF 工作副本会让它红。
- **桌面壳只构建，不打包。** `pnpm --filter @armadra/desktop build` 把
  main / preload / renderer / core 四个 target 过一遍 electron-vite，要的是三个
  平台上构建图都通得过。打包要平台特定的证书 / 公证输入，是发布流水线的事。壳与
  core 自己的单测（vitest + `node --test scripts/*.test.mjs`）在第 4 步的
  `pnpm -r --if-present test` 里已经跑过，不重复。

缓存：只有 `actions/setup-node` 的 `cache: pnpm`。R7d 之后仓库里没有第二条工具链，
Rust 与 Go 的 setup、缓存与检查步骤一并删除。

### 1.1 端到端分档

`tools/probes/` 下的端到端探针按「要不要用户的东西」分三档（[补全架构](../design/completion-architecture.md) §12）。
A 档与 B 档由 `tools/ci/e2e.mjs` 执行，清单是 `tools/ci/e2e.d/` 目录，一条一个文件：

```sh
pnpm libs:build
pnpm --filter @armadra/web build
pnpm --filter @armadra/desktop build
pnpm --filter @armadra/server build
node apps/desktop/scripts/ensure-node-pty.mjs   # Linux：给 Node 编一份 node-pty
node tools/ci/e2e.mjs --tier a            # 全部 A 档
node tools/ci/e2e.mjs --tier a --only server-e2e
node tools/ci/e2e.mjs --tier b --list     # 只列出清单
```

| 档  | 在哪跑                                            | 失败时   |
| --- | ------------------------------------------------- | -------- |
| A   | `ci.yml` 的 `e2e` 作业（ubuntu，每个 PR 与 main） | 阻断合并 |
| B   | `nightly.yml`（每天一次，可手动触发）             | 开 issue |
| C   | 手动，需要真实账号或真机                          | —        |

- **清单一条一个文件。** 每条是 `tools/ci/e2e.d/<id>.json`，写 `id`（与文件名一致）、
  `tier`、`script`、`args`（`{out}` 换成这一条的输出目录）、`requires`（`tmux` /
  `chrome` / `docker`）与 `timeoutMinutes`；外部服务替身由 `tools/dev-stack/` 提供的条目加
  `devStack: true`；只在某些系统上有意义的条目加 `platforms`（`darwin` / `linux` /
  `win32`，取 `process.platform`），别的系统上记 `skipped`。工作包新增探针就新增一个文件，不改别人的条目，合并时不冲突。
  运行顺序由加载器定：先 A 档后 B 档，同档按 `id` 排序，与文件添加先后无关。
  `tools/ci/e2e.test.mjs` 校验清单形状、文件名与 `id` 一致、脚本存在、A 档必有的
  五条，以及旧的单文件 `tools/ci/e2e.json` 没有被合并带回来。
- **逐条记账，跑完全部再判。** 每条探针的输出写进 `<out>/<id>/output.log`，
  探针自己的 `result.json` 与截图也落在 `<out>/<id>/`；汇总在 `<out>/result.json`
  （默认 `target/e2e/<档>/`）。任一条失败或超时，退出码非零，但后面的条目照跑。
  超时按进程组杀，探针起的 Chrome、core 与 Vite 一起收掉。CI 把整个目录作为
  `e2e-tier-a` 产物上传。
- **dev-stack 门控。** `ARMADRA_DEV_STACK=1` 且 `docker info` 答得上时，先
  `pnpm dev-stack up`、跑完 `down`；否则 `devStack` 条目记 `skipped`，不算失败。
  `up` 本身失败时这些条目记 `failed`。
- **Chrome 与 tmux。** Chrome 取 `CHROME_PATH`，否则找各平台的常见安装位置；缺
  `requires` 里的任何一样，那一条直接记 `failed` 并写明缺什么。`e2e` 作业用
  `browser-actions/setup-chrome` 装 stable，apt 装 tmux 与 xvfb，并放开 Ubuntu 24.04
  对非特权用户命名空间的 AppArmor 限制，好让 Chrome 的沙箱起得来。
- **B 档的夜间作业。** `nightly.yml` 每个系统一条作业，各自打包后跑
  `e2e.mjs --tier b`，条目靠 `platforms` 分到对应系统：
  - `linux`（ubuntu-22.04，与发布同一个 glibc 基线）：桌面壳 `dist` 出
    AppImage / deb / rpm（不签名），
    `verify-linux-glibc-baseline.sh` 断言基线，再在 `xvfb-run` 下跑 B 档：
    `packaged-smoke --no-real-cli` 起 AppImage（`APPIMAGE_EXTRACT_AND_RUN`，不要
    FUSE），`deb-install` 在 `ubuntu:22.04` 容器里 `apt-get install` 那个 deb、`ldd`
    没有缺库、`armadra --version` 答出版本，并在同一个容器里用 `APPIMAGE_EXTRACT_AND_RUN`
    起同架构的 AppImage；另跑 `server-perf`、
    `server-container-e2e`（构建服务器壳镜像、对着容器跑 `server-e2e`，不推送）、`server-caddy-e2e`
    （本机服务器壳前面放 Caddy 容器、按部署指南 §3.3 的配置跑 `server-e2e --proxy=caddy`）、`crash-report-e2e` 与
    `update-e2e`。作业设 `ARMADRA_DEV_STACK=1`、装 Chrome，`devStack` 条目先
    `pnpm dev-stack up`。
  - `linux-arm64`（ubuntu-22.04-arm）：打 arm64 包、断言 glibc 基线，只跑 `deb-install`
    （`--only deb-install`；其余 B 档条目与架构无关）。
  - `macos`（macos-14）：同样打包，跑 `packaged-smoke --no-real-cli`。
  - `report`：前两条任一失败、且在 main 上时，用默认的 `GITHUB_TOKEN`（作业级
    `issues: write`）开一个「夜间 B 档失败」issue，已有开着的同名 issue 就追加评论；
    正文是运行链接与每条作业失败的条目（`e2e.mjs` 在 `GITHUB_OUTPUT` 里写
    `failed=<id,…>`）。夜间工作流不读任何 secret。
  - `hygiene`（ubuntu-latest）：`knip` 报告作为 `knip-report` 产物上传、不判失败；
    `pnpm audit --prod --audit-level=high` 有 high 及以上漏洞时作业失败，同样由 `report` 开 issue。
  - 要打好的包才能跑的新探针只需新增一个 B 档条目并写明
    `platforms`，在对应作业里打包之后执行，不必加作业。
- `pnpm ci:workflows` 断言 `ci.yml` 有跑 `--tier a` 的 `e2e` 作业且在 ubuntu 上，
  `nightly.yml` 有 `schedule` 与 `workflow_dispatch` 并跑 `--tier b`；B 档条目
  `platforms` 里的每个系统都有一条在该系统 runner 上跑 `--tier b` 的作业；有一条
  `failure()` 门控、`needs` 全部 B 档作业、带 `issues: write` 的开 issue 作业；
  除 `GITHUB_TOKEN` 外不引用 secret。

## 2. release.yml

触发：推 `v*` 标签，或 `workflow_dispatch` 手动运行。手动运行可以给一个 `tag`
（补发那个标签），也可以留空（在当前分支上演练）。`dry_run` 默认勾选，此时全部
作业照跑但不创建 Release。`concurrency` 不取消进行中的发布。

**版本住在仓库里，标签只是指向它的名字。** 这一点与许多流水线相反——常见做法是从标签
解出版本、写进一份生成的打包配置，仓库里根本不存版本。我们不这么做，因为版本写在仓库里
（根 `package.json` 是源；桌面、服务器两壳的 manifest 与 core、armadra-hook
的版本常量都要与它一致，`version.mjs set` 一起改、`check` 一起看，见
`tools/release/version.mjs` 的 `VERSION_SITES`；手机 / 平板 App 不在其中，见 §2.8），两种壳
都会自报它，更新检查比的也是它。于是方向反过来：`verify` 要求
**标签等于仓库版本**，不等就拒绝发布，而不是让标签去覆盖代码里的版本。

工作流里的所有 checkout 都用 `ref: ${{ inputs.tag || github.sha }}`：手动补发一个
标签时，构建的必须是那个标签的树，而不是触发它的分支的 HEAD。

| 作业       | runner         | 做什么                                                  |
| ---------- | -------------- | ------------------------------------------------------- |
| `verify`   | ubuntu-latest  | 各处版本与标签一致、全量测试、工作流与发布脚本自检      |
| `build`    | 六行矩阵，见下 | 打桌面包、改名，上传 `release-<target>`                 |
| `web`      | ubuntu-latest  | 打前端产物 `armadra-web_<version>.tar.gz`               |
| `notarize` | ubuntu-latest  | 只报告哪些平台缺签名 secret，不阻断                     |
| `assemble` | ubuntu-latest  | 校验清单、`latest.json`、说明，并创建 **draft** Release |

构建矩阵的六个目标与 `tools/release/artifacts.mjs` 的 `TARGETS` 一一对应，
`pnpm ci:workflows` 会校验这一点。矩阵里原本还有一列 Rust 三元组，只有组件包用它，
随组件包一起删了：

| runner             | target          |
| ------------------ | --------------- |
| `macos-14`         | darwin-aarch64  |
| `macos-15-intel`   | darwin-x86_64   |
| `ubuntu-22.04`     | linux-x86_64    |
| `ubuntu-22.04-arm` | linux-aarch64   |
| `windows-2022`     | windows-x86_64  |
| `windows-11-arm`   | windows-aarch64 |

`ubuntu-22.04-arm` 与 `windows-11-arm` 只对公开仓库免费。仓库转私有时这两行要
换成自托管 runner，或者删掉并同步收窄 `TARGETS`。

### 2.1 Linux 钉在 22.04

glibc 的符号版本是单向的：在 Ubuntu 24.04（glibc 2.39）上链接出来的二进制会记下
`GLIBC_2.38` / `GLIBC_2.39` 的引用，到 22.04 上动态链接器直接拒绝启动
（`version 'GLIBC_2.38' not found`），而构建过程一切正常，没有任何一处会提，
问题只会在用户那里暴露。所以把 Linux 行钉在 `ubuntu-22.04` 并在产物上断言基线。两条缺一不可：runner 决定这次
能不能过，断言拦住下一次——某个构建依赖开始要更新的 glibc 符号时，它是唯一会出声
的地方。

`tools/release/verify-linux-glibc-baseline.sh` 就是那个断言。它 `objdump -T`
electron-builder 留下的 `apps/desktop/release/linux*-unpacked/` 里我们自己链接的
东西——`armadra` 启动器，以及 asar 外的原生插件（node-pty 的 `pty.node` 与它的
`spawn-helper`）——取出所有 `GLIBC_x.y` 引用，高于基线就列出具体符号并失败。基线
默认 2.35（Ubuntu 22.04 LTS 与 Debian 12），用 `ARMADRA_GLIBC_BASELINE` 覆盖。
原生插件是在 runner 上现编的，所以这条检查正是「runner 镜像往前走了」的出声处。

arm64 用 `ubuntu-22.04-arm`：GitHub 的确提供这个标签，glibc 同样是 2.35，所以
同一条基线两个架构通用。这两个 runner 与 Ubuntu 22.04 LTS 的标准支持同在
2027-04 退役，届时换成 `ubuntu:22.04` 容器构建。

### 2.2 打包器的名字不是发布的名字

electron-builder 按各平台自己的习惯命名：`Armadra-0.1.0-arm64.dmg`、
`Armadra Setup 0.1.0.exe`、`armadra_0.1.0_amd64.deb`。这些名字里读不出更新检查
认得的目标——`assetTarget` 在 `arm64`、`amd64` 里什么都找不到，其中一个还带空格——
于是 `assemble` 会判它们「declares no target the updater can read」。直接上传等于
发了一堆永远不会提供给任何客户端的桌面产物。

`tools/release/stage-desktop.mjs` 负责这次改名：按 `desktopAssets()` 声明的 `kind`
在 `apps/desktop/release/` 里按扩展名找到那一个文件，复制成 `artifacts.mjs` 规定的
名字。按扩展名而不是按全名匹配，是因为上面那些名字里的产品名大小写与架构拼写随时
可能被 electron-builder 改掉。缺了本该有的包就在这里失败，而不是等 `assemble`。

产物落在**一个平铺目录**里，旁边还有不是发布产物的文件：`latest*.yml`（electron-updater
自己的清单，本发布不发它）、`*.blockmap`（差分下载索引）、`builder-*.yml` 与
`*-unpacked/`。`isReleaseAsset()` 把它们挡在外面——`.blockmap` 按名字排序还排在它索引的
`.dmg` 前面，只看扩展名会挑错文件。

每平台的 target 列表写在 `apps/desktop/electron-builder.yml`，与 `desktopAssets()`
一一对应，由 `apps/desktop/scripts/artifact-targets.test.mjs` 钉住两端（矩阵与文件名
都钉）。

| 平台    | electron-builder target  | 发布的桌面产物                         |
| ------- | ------------------------ | -------------------------------------- |
| macOS   | `dmg`、`zip`             | `.zip`（updater）、`.dmg`              |
| Windows | `nsis`、`zip`            | `-setup.exe`（updater）、便携 zip      |
| Linux   | `AppImage`、`deb`、`rpm` | `.AppImage`（updater）、`.deb`、`.rpm` |

哪一个能原地更新不是选择，是 electron-updater 的规则：它替换的是 app bundle，
所以 macOS 更新走 zip 而不是 `.dmg`（后者是一个要挂载的磁盘映像），Windows 走安装器
而不是便携包。

### 2.3 Windows 便携版

便携 zip 就是 electron-builder 的 `zip` target：它打的是解包后的整个目录，
`after-pack.mjs` 放进 `resources/` 的东西（hook 客户端、Windows 的 session-host、
`migrations/`）本来就在里面。core 在生产构建里从 `process.resourcesPath` 找它们，
所以整目录压缩正好是它需要的形状。

便携版不是 updater 目标：解压到哪儿由用户决定，没有一个「已安装的位置」可供替换，
写进 `latest.json` 等于承诺一次做不到的更新。

### 2.4 AppImage

electron-builder 的 AppImage 由 app-builder 自己打，不经 linuxdeploy，因此不会把
宿主的 GTK/Wayland 栈拷进镜像——Electron 自带 Chromium，运行时才链接系统 GTK。
上一代壳需要一个剥离 `libwayland-client/cursor/egl` 的后处理步骤（那些库不是自包含的，
镜像里自带一份等于把同一套协议的两个版本混在一起），随那个打包器一起删掉了。

**arm64 用静态运行时。** electron-builder 缺省的 AppImage 工具集（`toolsets.appimage: 0.0.0`，
AppImageKit 12）里 arm64 的运行时动态链接**无版本号**的 `libz.so`——那个名字只有 zlib 的开发包
提供，干净系统上 AppImage 在解包之前就报 `error while loading shared libraries: libz.so`；往镜像里
放 zlib 没用，起不来的是运行时本身。`scripts/dist.mjs` 对 arm64 构建合入
`toolsets.appimage: 1.0.3`（`ARM64_APPIMAGE_TOOLSET`，静态的 type-2 运行时 20251108，没有任何
`NEEDED`）；x64 的旧运行时链接的是 `libz.so.1`（zlib1g 在 Debian / Ubuntu 是必装的），保持不变。
夜间 `linux-arm64` 作业（`ubuntu-22.04-arm`）打包后跑 `deb-install`：同一个干净 `ubuntu:22.04`
容器里装 deb、再用 `APPIMAGE_EXTRACT_AND_RUN` 起 AppImage，两者都要答出版本。

**更新缓存目录。** electron-updater 把下载放在系统缓存目录下的 `updaterCacheDirName`，NSIS 安装包
也把自己的副本留在那里给下一次差分下载用。electron-builder 从包名推这个名字，作用域包名得出
`@armadradesktop-updater`，配置里没有能改它的键（`publish.updaterCacheDirName` 会被覆盖）。
`scripts/after-pack.mjs` 把这次构建的 `AppInfo.updaterCacheDirName` 钉成 `armadra-updater`（deb / rpm
在 afterPack 之后还会重写一次 `app-update.yml`，NSIS 也从它取存放路径），并改写 electron-builder
自己已经写好的那份 `app-update.yml`。旧名字目录里已有的下载缓存不再被读，只占一点盘。

### 2.5 各平台的系统依赖与缓存

- **Linux**：只要 `file`（AppImage 用）与 `rpm` 包提供的 `rpmbuild`。
  electron-builder 自带 Chromium，不链接 WebKitGTK，原先那一长串 `-dev` 包不再需要。
  §2.1 的基线校验要 `objdump`，runner 镜像自带 binutils。
- **Windows**：NSIS 由 electron-builder 自己下载，不需要预装。实时扫描会把刚写出的
  文件占住几秒到几十秒，所以 `apps/desktop/out` 与 `apps/desktop/release` 排除出扫描
  范围，`after-pack.mjs` 的复制另有重试兜底。`after-pack.mjs` 还会用系统自带的
  .NET Framework 4 `csc.exe` 编出 `resources/cli/armadra-hook.exe`（hook 客户端的
  Windows 启动器，几 KB，anycpu，x64 与 arm64 通用；`scripts/hook-launcher.mjs`），
  不需要另装工具链；编不出来就让构建失败。非 Windows 宿主打 Windows 目标时跳过并打
  警告，那样的包退回 `armadra-hook.cmd`。
- **macOS**：不需要额外依赖。签名与公证见 §2.6。

缓存：只有 `actions/setup-node` 的 `cache: pnpm`。

所有多行 `run` 都写 `shell: bash` 与 `set -euo pipefail`：Windows 默认的 pwsh 只看
最后一条命令的退出码，`pnpm ci:workflows` 会拦住漏写 `shell` 的 Windows 步骤。

### 2.6 macOS 签名与公证

证书先自己导进一个临时钥匙串并当场 `find-identity`，再把同一份 base64 交给
electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD`。多这一步只为了**失败的时刻**：
证书或口令不对时，`security import` + `security find-identity` 在十秒内就红；只交给
打包器则要等整个前端构建和 bundling 跑完才在最后一步失败。这和
`apps/desktop/scripts/signing-electron.mjs` 把签名判断提到构建之前是同一个道理。

关键的几行与它们的理由：

- `security set-keychain-settings -lut 21600`：锁定超时要比最长的一次构建还长，
  钥匙串锁上就再也签不动了。
- `security set-key-partition-list -S apple-tool:,apple:,codesign:`：没有它，
  `codesign` 会弹一个没人能点的「允许访问」对话框并超时。
- `security default-keychain -s`：codesign 从默认钥匙串里找身份。
- 没给 `APPLE_SIGNING_IDENTITY` 时，从 `find-identity` 的输出里取第一条。
- 构建结束后 `if: always()` 删掉钥匙串。

证书只给了一半（有 `.p12` 没口令，或反过来）在这一步就失败，而不是当成「不签名」。

**公证凭据两套，API key 优先**（[外部服务](../design/external-services.md) §2.1）：

- **App Store Connect API key**（推荐）：secrets `APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、
  `APPLE_API_ISSUER_ID`。预检把 base64 解到 `$RUNNER_TEMP/AuthKey.p8`，
  `xcrun notarytool store-credentials armadra-notary --key … --key-id … --issuer … --validate`，
  通过后把 `APPLE_API_KEY`（`.p8` 的**路径**）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 写进
  `GITHUB_ENV`；
- **Apple ID**（回退）：`APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD`，
  `--apple-id … --team-id … --password … --validate`。

`--validate` 会真的去问一次 Apple，凭据不对在这里报错，而不是在打包末尾排队等公证时。
app-builder-lib 只要看到 `APPLE_ID` 就走 Apple ID 分支，所以**两套都配时只把 API key 那套写进环境**；
`signing-electron.mjs` 的 `signingPlan` 也按同一规则在打包前把另一套从环境里拿掉（`unsetEnv`）。
一套给了一半（例如只有 `APPLE_API_KEY_ID`）预检直接失败；两套都没有才是「不公证」，`::warning::`
后继续，`notarize` 作业把 macOS 列进未签名平台，`assemble` 把这句话写在 Release 说明顶部。

**打包后断言**：签过名的构建在上传前跑
`node apps/desktop/scripts/signing-electron.mjs verify-mac`，对每个 `.app` 做
`codesign --verify --deep --strict`，挡住「有签名目录但 Gatekeeper 不认」的包。更新器的
`signatureState` 在运行时也跑同一条 `codesign --verify --deep --strict`（每进程一次），ad-hoc
签名答 `unknown`，与未签名一样不装。

证书选 **Developer ID Application（G2 链）**：旧的 Developer ID Sub-CA 2027-02-01 到期，
之后签出的东西必须来自 G2 链证书。

本地演练：`ARMADRA_MAC_ADHOC_SIGN=1 ARMADRA_DIST_RELEASE=1 pnpm --filter @armadra/desktop dist`
用 ad-hoc 身份 `-` 签，`verify-mac` 能过；Gatekeeper（`spctl --assess`）与 Squirrel.Mac 只认
Developer ID 签名加公证，所以 ad-hoc 包能走到「暂存」，装不上（`tools/probes/README.md` 的自动更新端到端）。
没有用自签的 codesign 身份演练：那要往用户的钥匙串搜索列表里加钥匙串，属于改本机安全设置。

### 2.6.1 Windows 签名

三条路，只能配一条（`signing-electron.mjs::windowsPlan`，工作流「选 Windows 签名路径」一步）：

| 路径                   | 配置                                                                                                                                                                                        | electron-builder 拿到的                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Azure Artifact Signing | secrets `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`；变量 `AZURE_SIGNING_ENDPOINT` / `AZURE_SIGNING_ACCOUNT` / `AZURE_SIGNING_PROFILE`；变量 `ARMADRA_WIN_PUBLISHER_NAME` | 齐全时才合并 `win.azureSignOptions`，显式 `timestampRfc3161: http://timestamp.acs.microsoft.com`、SHA256 |
| OV 证书文件            | secrets `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD`；可选变量 `ARMADRA_WIN_PUBLISHER_NAME`                                                                                              | `CSC_LINK` / `CSC_KEY_PASSWORD`，钉了名字就加 `win.signtoolOptions.publisherName`                        |
| 自托管 runner 上的令牌 | 变量 `ARMADRA_WIN_CERT_SHA1`（证书库里的指纹）；Windows 两行 `runs-on: [self-hosted, windows, signing]`                                                                                     | `win.signtoolOptions.certificateSha1`                                                                    |

`win.azureSignOptions` 一出现 electron-builder 就走 Azure 签名、不先查凭据，所以它只在全部字段在场时
由 `signingPlan` 合并进配置，仓库里的 `electron-builder.yml` 不写它。给了一半在构建前拒绝。
Azure 的签名模块按空格切文件名，`nsis.artifactName` 因此是无空格的 `Armadra-Setup-${version}-${arch}.${ext}`。

**publisherName**：装好的副本每次更新都拿安装包证书的 CN 与 `app-update.yml` 里的
`publisherName` 比，对不上就拒装。证书文件那条路上，工作流用 PowerShell 读出 `.pfx` 主体的
CN，`signing-electron.mjs check-publisher` 要求它与 `ARMADRA_WIN_PUBLISHER_NAME` 逐字相同；
换证书时这个名字不能变。

**打包后断言**：签过名时 `signing-electron.mjs verify-windows` 要求每个安装包和
`*-unpacked/armadra.exe` 的 `Get-AuthenticodeSignature` 都是 `Valid`。

**更新器**：`main/updates/environment.ts::signatureState` 在 Windows 上读
`Get-AuthenticodeSignature`（每个进程一次）：`Valid` 才是 `signed`，`NotSigned` 是 `unsigned`，
自签证书（`UnknownError`）等一律 `unknown`；后两者都不自动更新。`environment.test.ts` 在
Windows runner 上用 `New-SelfSignedCertificate` 现做一张证书核对这条（测试结束删掉）。

### 2.6.2 Linux GPG

`assemble` 作业在 `assemble.mjs` 之前跑 `tools/release/sign-gpg.mjs sign`：密钥来自
secrets `ARMADRA_LINUX_GPG_KEY`（armored 私钥）/ `ARMADRA_LINUX_GPG_PASSPHRASE`，导进一次性的
`GNUPGHOME`（用完即删）；`.rpm` 先 `rpmsign --addsign`，再给 `.AppImage` / `.deb` / `.rpm`
各出一个 `.asc`，公钥导出为 `armadra-linux.gpg` 随 Release 发布。仓库里一旦提交了
`apps/web/public/armadra-linux.gpg`（服务器壳会把它当静态文件发出去），之后的发布都要求签名密钥的
指纹与它一致。签完立即 `sign-gpg.mjs verify`（`gpg --verify` 与 `rpmkeys --checksig`）。
没有密钥就跳过并告警，`notarize` 作业把「Linux (GPG)」列进说明顶部。

用户验证：`gpg --import armadra-linux.gpg && gpg --verify Armadra_<v>_linux-x86_64.AppImage.asc`；
rpm 用 `rpm --import` 之后 `rpm -K`。本地演练：`node tools/release/sign-gpg.mjs keygen --out <dir>`
出一把一天期的密钥。

用 `dmgbuild` 重建 DMG 再自己 `notarytool submit` + `stapler staple` 的做法，是为了拿到
确定性的 Finder 布局（背景图、图标位置）——丢掉 bundler 的 DMG 就必须自己公证。我们没有
这个需求，不做这一段。

### 2.6.3 Android 上传密钥

`android` 作业从 secrets `ANDROID_UPLOAD_KEYSTORE_BASE64`（PKCS12 密钥库的 base64）、
`ANDROID_UPLOAD_KEYSTORE_PASSWORD`、`ANDROID_UPLOAD_KEY_ALIAS` 还原密钥到 `RUNNER_TEMP`，经
`app/build.gradle` 读的 `ANDROID_UPLOAD_KEYSTORE*` 环境变量签名，用完即删。三个都没有就跳过并告警，
给了一部分就失败。维护者在自己的机器上跑 `apps/mobile/scripts/create-upload-keystore.sh`：生成
`~/.armadra-signing/armadra-upload.jks` 与随机口令（已存在就拒绝覆盖），经 stdin 写进三个 secrets，
打印证书 SHA-256。这把密钥丢了就发不了同一个 App 的更新，生成后立即离线备份；同一把密钥以后也是
Play 上架的上传密钥。

### 2.7 发布说明与 draft

说明正文是 `CHANGELOG.md` 里本版那一节：从 `## X.Y.Z` 起（标题后可跟「（未发布）」或
「（2026-10-10）」），到下一个二级标题止（`tools/release/changelog.mjs`）。`verify` 作业先
`changelog.mjs check` 一次，缺这一节就在构建之前失败；`assemble` 作业把它交给
`assemble.mjs --changelog CHANGELOG.md`，由 `compatibility.mjs` 的 `releaseNote()` 在外面
套上未签名平台的提示与兼容性围栏，`latest.json` 的 `notes` 也是这段正文。真建 Release
的那一次（`publish`）还带 `--released` / `--require-released`：标题仍标「未发布」就失败——
打标签前把它改成发布日期。分支演练与 `pnpm release:dry-run` 只要求这一节存在。

`gh release create` 带 `--verify-tag`：标签不存在时拒绝，而不是替我们建一个指向当前
提交的标签。预发布按标签里有没有 `-` 判定（`v0.2.0-rc.1`），与 semver 的读法一致。
`latest.json` 仍由 `tools/release/updater-manifest.mjs` 生成并随产物一起上传。

**更新清单是两份。** `latest.json`（minisign 签名）之外，每个目标还发一份
electron-updater 自己读的清单——桌面壳下载时走 `provider: generic`，只认 yml。
electron-builder 写的 `latest-mac.yml` / `latest.yml` 只按平台起名，两台 macOS
runner、两台 Windows runner 合进同一个目录会互相覆盖，所以 `stage-desktop.mjs` 把它
改写成按目标命名的一份：`latest-<target>` 是 electron-updater 的通道名，文件名是它
自己对这个通道算出的名字（`latest-darwin-aarch64-mac.yml`、`latest-windows-x86_64.yml`、
`latest-linux-aarch64-linux-arm64.yml`……，`artifacts.mjs::updaterFeedFile`；
`apps/desktop/src/shell-core/updates/feed.test.ts` 用钉住的 electron-updater 核对）。
改写时只留这个目标的更新包，`url` / `path` 换成发布名，`sha512` 写 base64；打包器
清单里的条目按字节对上暂存的包，对不上就在构建作业里失败。`--require-updater` 下
缺清单也失败。

`assemble.mjs` 再核一遍：每个目标的清单都在、版本对、`files[].url` 是本次发布的
文件、清单的 sha512 与 `SHA256SUMS` 的 sha256 说的是同一份字节。`latest.json` 的每个
平台条目带 `feed: { url, sha256 }` 点名这份清单；桌面壳下载前先取它、核对 sha256 与
它描述的包，再把 `autoUpdater.channel` 设成 `latest-<target>` 交给 electron-updater。
清单本身的 Ed25519 签名等 electron-builder 27 稳定后另做（外部服务 §2.4）。2026-10-04 核对：
npm 上 `latest` 仍是 26.15.3（本仓库钉的版本），`v26` 线到 26.17.0，27 只有 `next` 标签的
`27.0.0-alpha.9`（2026-09-26）。alpha 不进发布流水线，继续等；27 的 `latest` 出来后升级、在
`electron-builder.yml` 加 `updateManifest.publicKey`、CI 用新的 `ELECTRON_BUILDER_UPDATE_SIGN_KEY`
签 `latest*.yml`，并跑一次 `release:dry-run` 与 `release.yml` 全矩阵演练。

**灰度**：`assemble.mjs --rollout <percent>` 给 `latest.json` 写
`rollout: { percent, seed }`，seed 缺省为版本号；客户端用安装 id（数据目录
`updates/install-id`）与 seed 的哈希落在百分比内才接受。不写 electron-updater 的
`stagingPercentage`，免得同一台机器被两道闸各筛一次。放量就是改百分比重发
`latest.json`（及其 `.sig`）。

**检查**：桌面壳自己问 `GET …/releases`（发布源来自 `ARMADRA_UPDATER_SOURCE`，或由
已发布构建的 `github.com/<owner>/<repo>` 更新地址推出 `api.github.com/repos/…`），
带上一次的 `ETag` 发 `If-None-Match`，304 不计入匿名限额；自动检查启动约一分钟后
一次，之后间隔不短于 6 小时并加抖动，`updates.autoCheck` 关掉就不查。`updates.channel`
为 `beta` 才考虑预发布，缓存按发布源与通道分开。

本地对着 dev-stack 验一遍：`pnpm dev-stack up release`，然后
`pnpm release:dry-run --against http://127.0.0.1:8090/repos/armadra/armadra --pubkey tools/dev-stack/.data/release/minisign.pub`
——检查（带 ETag 再查一次应得 304）→ 取 `SHA256SUMS` 与 `latest.json` 并验签 → 逐个
目标取清单与它点名的包，核对 sha512、sha256、索引 digest 与 minisign 签名。

仍然只创建 **draft**，不直接发布、不加 `--latest`。产物清单与说明要
人审阅，更新检查会跳过 draft，所以未发布前任何客户端都看不到它。

### 2.8 版本规则（三端一条线）

桌面、服务器壳与手机 / iPad App（iOS 通用二进制、Android 同一 APK）**共用一条版本线和一个标签 `vX.Y.Z`**，设备形态不靠版本号区分：

- **Z（修订）**：只修缺陷，没有大改动。
- **Y（次版本）**：功能更新。
- **X（主版本）**：特大更新（如 1.0）。
- 任一端升级时，其他端在下一次发版对齐到同一版本；没有改动的一端也随版本号走。
- **构建号**单调递增，用来区分同一版本的不同构建（见下），不进版本名。
- armadra-cloud（中转 / 平台服务）**不在这条线上**：它与协议包 `@armadra/platform-protocol` lockstep，版本随协议包走，更新记录里只写「中转仍用 armadra-cloud X.Y.Z」。

| 项       | 做法                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------- |
| 版本的源 | 根 `package.json`；`VERSION_SITES` 里的桌面、服务器、`apps/mobile/package.json` 与两处常量都要等于它 |
| 改版本   | `node tools/release/version.mjs set X.Y.Z`（一次改全）                                               |
| 校验     | `version.mjs check [--tag vX.Y.Z]`（`pnpm release:check`）：版本、原生工程派生、协议门槛、更新记录   |
| 标签     | `vX.Y.Z`，触发 `release.yml`；不再有 `mobile-v*`                                                     |
| 更新记录 | 根 `CHANGELOG.md` 的 `## X.Y.Z` 一节；有改动的端分「桌面 / 服务器」「手机与平板」小节                |

商店版本名不收预发布后缀：预发布版本（如 `0.3.0-beta.1`）的 App 版本名取核心 `0.3.0`，靠构建号区分。

**构建号**单调递增：`ARMADRA_BUILD_NUMBER`（正整数，CI 想用别的序列时显式给）优先，否则是 `git rev-list --count HEAD`——同一提交本地与 CI 得到同一个数，主干往前只增不减；浅克隆数不出真实提交数，脚本直接报错（`nightly.yml` 的两个移动端作业因此 `fetch-depth: 0`）。新号远大于旧方案的 204（0.2.4），已装的 Android 包照常升级。

**派生**：`apps/mobile/scripts/app-version.mjs write`（`pnpm --filter @armadra/mobile sync` 的第一步）写出两份不入库的文件：

- `apps/mobile/ios/version.generated.xcconfig`：`MARKETING_VERSION`、`CURRENT_PROJECT_VERSION`。入库的 `ios/version.xcconfig` include 它，工程级 Release 以它为基础配置、`debug.xcconfig` 也 include 它；`project.pbxproj` 的工程与各目标（App、NotificationService、AppUITests）都不再写这两个键，扩展与 App 版本始终一致。命令行加的 `-xcconfig ~/armadra-ios-build/personal.xcconfig` 这类外部配置只管签名与包名，不设这两个键，叠加不冲突（2026-10-10 用 `xcodebuild -showBuildSettings` 带与不带它核过三个目标、两种配置）。
- `apps/mobile/android/app/version.properties`：`versionName`、`versionCode`，`app/build.gradle` 读它；缺文件时构建直接失败并提示先跑脚本。旧的 `ARMADRA_VERSION_CODE` 不再认，用 `ARMADRA_BUILD_NUMBER`。

**兼容性只看协议**，不看两边版本是否相等（版本线统一后仍如此）：`compatibility.json` 的 `mobile.minimumHostProtocol`（现为 1.14：手机用到的推送与对外服务动词自此都在契约上；已发布的 0.2.x 都在 1.18 及以上）是 App 内页面能用的最老 core 协议，页面副本在 `apps/web/src/mobile/host-compatibility.ts`；`version.mjs check` 核对两者一致、major 等于 core 的 `PROTOCOL_MAJOR`、minor 不高于 core 的 `PROTOCOL_MINOR`。它不进发布说明的围栏。App 的「设置 → 关于」显示 App 版本与构建号（原生插件 `appInfo`）、所连主机的版本与协议，主机协议不够或 major 不同时提示更新哪一边。

**产物**：`nightly.yml` 的移动端产物名用统一版本（`artifacts.mjs::mobileAssets(version print)`，如 `armadra-mobile_0.3.0_android-debug.apk`）。`release.yml` 的 `android` 作业打一个用上传密钥签名的 release APK（`artifacts.mjs::androidReleaseAsset`，如 `armadra-mobile_0.5.1_android.apk`），`apksigner verify` 通过后进 draft Release 与 `SHA256SUMS`，可直接安装；没有密钥就跳过并告警（§2.6.3）。iOS 只能经 App Store / TestFlight 分发，仍不进 Release；商店上架是人的动作（客户端平台指南「真机与商店」）。

## 3. 密钥清单

全部是 GitHub 仓库 secret。**一个都没有时发布仍然跑得通**：产物是未签名的，
`assemble` 会把这件事写进 Release 说明顶部，`latest.json` 会把没有签名的
updater 包排除在外。

| Secret / 变量                                                               | 谁用                                                                                                             | 缺了会怎样                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `APPLE_CERTIFICATE_P12_BASE64`                                              | macOS 代码签名（base64 的 Developer ID Application .p12，G2 链）                                                 | 不签名，首次打开有 Gatekeeper 提示           |
| `APPLE_CERTIFICATE_PASSWORD`                                                | 导入上面的证书                                                                                                   | 只给一半：构建失败                           |
| `APPLE_SIGNING_IDENTITY`                                                    | 指定用哪张证书；缺则取第一张                                                                                     | 钥匙串里有多张时可能选错                     |
| `APPLE_API_KEY_P8_BASE64`                                                   | 公证（推荐）：App Store Connect API key 的 .p8，base64                                                           | 退回 Apple ID；两套都没有就不公证            |
| `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID`                                  | 同上的 key id 与 issuer                                                                                          | 三个只给一部分：构建失败                     |
| `APPLE_ID` / `APPLE_TEAM_ID`                                                | 公证（回退）                                                                                                     | 不公证，`notarize` 作业把 macOS 列进说明     |
| `APPLE_APP_SPECIFIC_PASSWORD`                                               | 公证回退用的 app 专用密码                                                                                        | 同上                                         |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`               | Windows：Azure Artifact Signing 的 Entra 凭据                                                                    | 与下面三个变量、发布者名一起：缺一个构建失败 |
| 变量 `AZURE_SIGNING_ENDPOINT` / `_ACCOUNT` / `_PROFILE`                     | Windows：Artifact Signing 账户、证书配置                                                                         | 同上                                         |
| 变量 `ARMADRA_WIN_PUBLISHER_NAME`                                           | Windows：证书主体 CN，钉进 `publisherName`                                                                       | Azure 路径必需；证书文件路径缺省取证书 CN    |
| `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD`                             | Windows：OV 证书文件（与 Azure、令牌三选一）                                                                     | 不签名，SmartScreen 提示，不自动更新         |
| 变量 `ARMADRA_WIN_CERT_SHA1`                                                | Windows：自托管 runner 证书库里的令牌证书                                                                        | 同上                                         |
| `ARMADRA_LINUX_GPG_KEY` / `ARMADRA_LINUX_GPG_PASSPHRASE`                    | Linux 包的 `.asc` 与 rpm 签名                                                                                    | 不带 `.asc`，rpm 不签名，说明里写明          |
| `ANDROID_UPLOAD_KEYSTORE_BASE64` / `_PASSWORD` / `ANDROID_UPLOAD_KEY_ALIAS` | Android release APK 的签名（§2.6.3）                                                                             | 全缺：不带 APK，告警；缺一部分：发布失败     |
| `ARMADRA_RELEASE_SIGNING_KEY`                                               | 每个产物与 `SHA256SUMS` 的 minisign 签名，`latest.json` 引用的也是它                                             | 产物不带签名，`latest.json` 为空，说明里写明 |
| `HOMEBREW_TAP_TOKEN`                                                        | `distribute.yml` 推 Homebrew tap（细粒度 PAT，只对 tap 仓库 `contents: write`）                                  | 跳过 tap，告警                               |
| `SCOOP_BUCKET_TOKEN`                                                        | `distribute.yml` 推 Scoop bucket（同上，只对 bucket 仓库）                                                       | 跳过 Scoop，告警                             |
| `WINGET_TOKEN`                                                              | `distribute.yml` 用 wingetcreate 向 `microsoft/winget-pkgs` 提 PR（对 fork `contents` + `pull_requests: write`） | 跳过 winget，告警                            |
| 变量 `ARMADRA_HOMEBREW_TAP` / `ARMADRA_SCOOP_BUCKET`                        | tap / bucket 仓库名，缺省 `Owlbay/homebrew-tap` / `Owlbay/scoop-bucket`                                          | 用缺省                                       |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY`           | 更新镜像（§3.3）：R2 的 S3 API 令牌，只授权镜像那个桶的读写                                                      | 与下面两个变量一起：全缺跳过，缺一半失败     |
| 变量 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_R2_BUCKET`                       | 镜像：端点 `https://<账户>.r2.cloudflarestorage.com` 与桶名                                                      | 同上                                         |
| 变量 `ARMADRA_MIRROR_PUBLIC_URL`                                            | 镜像桶的公开地址（例如 `https://updates.armadra.dev`），`assemble` 据此另签一份链接指向镜像的 `latest.json`      | 镜像里的 `latest.json` 仍指向 GitHub 下载    |

证书与公证密码用当前的两个 secret 名字；工作流同时接受早先的
`APPLE_CERTIFICATE` 与 `APPLE_PASSWORD`（`${{ secrets.A || secrets.B }}`），
已经配好的仓库不用改 secret。

工作流只把**非空**的 secret 写进环境：空字符串的证书变量会被当成「有密钥」，
然后在打包最后一步失败；没有密钥时要的是跳过，不是一个更晚、更难读的错误。
macOS 的证书与公证凭据走 §2.6 的两个预检步骤，Windows 走 §2.6.1 的三选一，Linux 走 §2.6.2，
都是「全缺就跳过并告警，缺一半就失败」。

**签名在写清单之前。** 上一代打包器在构建过程中就给每个 updater 包签出一份分离
签名，所以 `assemble.mjs` 读得到一个已经在盘上的 `.sig`；electron-builder 只做平台
代码签名，不产出分离签名。于是 `assemble.mjs` 自己先签一遍，再用刚签出的东西写
`latest.json`，最后写 `SHA256SUMS` 并补签那两个当时还不存在的文件。整条链上只剩
`ARMADRA_RELEASE_SIGNING_KEY` 一把钥匙。

`GITHUB_TOKEN`：`release.yml` 顶层声明 `permissions: contents: write`，
`assemble` 用它 `gh release create --draft`。`ci.yml` 是 `contents: read`。
工作流永远不会把 Release 从 draft 转正——那一步是人的动作。

更新地址不写进仓库。`electron-builder.yml` 的 `publish.url` 是占位，CI 通过
`ARMADRA_UPDATER_ENDPOINTS` 注入，`signing-electron.mjs` 把它与签名判断合成同一个
`--config`。

打包这一步走 `pnpm --filter @armadra/desktop dist`，也就是
`apps/desktop/scripts/dist.mjs`，而不是直接 `electron-builder`：签名判断必须发生在
构建之前，否则缺密钥的失败要等到最后一步才出现。该脚本用 Node 直接启动
electron-vite 的入口——Windows 上包管理器是 `.cmd`，`execFileSync` 不带 shell
启动不了它。它之前没有别的构建步骤：这个壳不再有受管二进制。

### 3.1 分发渠道与第三方声明

渠道清单不手写：`tools/release/publish-channels.mjs render` 从版本、仓库名与发布里的
`SHA256SUMS` 渲染 `tools/release/templates/` 下的模板——Homebrew cask（`armadra.rb`，
dmg）、Scoop（`armadra.json`，便携 zip，`checkver: github`，`autoupdate` 从
`$baseurl/SHA256SUMS` 取哈希）、winget 三件套（`Owlbay.Armadra`，NSIS 安装包）、AUR
`armadra-bin` 的 `PKGBUILD`（基于 `.deb`）。文件名取 `artifacts.mjs` 的 `desktopAssets()`，
`SHA256SUMS` 缺哪个就拒绝渲染；只渲染稳定版。

两处工作流：

- `release.yml` 的 `channels`（Ubuntu：渲染两份——指向 GitHub Release 的与指向
  `127.0.0.1:8765` 的本地版；PKGBUILD 在 Arch 容器里过 `makepkg --printsrcinfo` 与
  `namcap`）、`channels-macos`（本地 tap 上 `brew style` / `brew audit --cask --strict`，
  从本地静态服务器 `brew install --cask` 进临时 appdir，断言包里有 Electron / Chromium
  声明与 `THIRD_PARTY_NOTICES.md`）、`channels-windows`（`winget validate`、`scoop install`
  本地版）。只校验，不推送：此时 Release 还是 draft，下载地址对外是 404。
- `distribute.yml` 挂在 `release: published` 上（也可手动给标签补跑）：从已发布 Release 的
  `SHA256SUMS` 重新渲染，`publish-tap` / `publish-scoop` 用 `publish-channels.mjs push` 把
  文件提交进渠道仓库（令牌经 HTTP 头交给 git，不进 URL），`publish-winget` 用
  wingetcreate 提 PR（包已在 winget-pkgs 里用 `update`，首次用渲染好的三件套 `submit`）。
  每个作业缺自己的 secret 就跳过并告警。

官方 `homebrew/cask` 与 Scoop `Extras` 有知名度门槛，达到后再提；`brew audit --new` 要求仓库
公开可查，私有期间只跑 `--strict`。Linux 的结论（外部服务 §4.3）：AUR 只附 `PKGBUILD` 模板、
不自己维护；apt / rpm 仓库是可选的 W-LINUX-REPO；Flathub 与 Snap 延后——终端、PTY 与任意
CLI 需要的宽沙箱权限过不了审核。服务器壳镜像推 GHCR 由 `server-image.yml` 负责（G3-5）。

第三方声明：`node tools/notices.mjs` 用 `pnpm licenses list --prod --json` 生成根目录的
`THIRD_PARTY_NOTICES.md`（每个包带许可证原文），`pnpm check` 里的 `notices:check` 防漂移——
**改了生产依赖要重新生成并提交**。`apps/desktop/scripts/after-pack.mjs` 把它放进
`resources/`，把 ama 自带的 `LICENSE` / `THIRD_PARTY_NOTICES.md` 放进 `resources/agent/`，
并把 Electron 的 `LICENSE.electron.txt` / `LICENSES.chromium.html` 放回 macOS 的
`Contents/Resources/`（Windows / Linux 上 electron-builder 已放在可执行文件旁，缺了才补）。
设置 → 关于 → 开源许可显示的就是这份文件。

`--prod` 看不到被打包器整段打进 `out/` 的构建期依赖（页面 CSS 里的 `tailwindcss` 与
`tw-animate-css`），它们列在 `tools/notices.mjs` 的 `BUNDLED_DEV_DEPENDENCIES`，照样读许可证
原文进同一张表。名单够不够全由 `node tools/notices.mjs --scan apps/desktop/out` 对构建产物核：
rolldown 在未压缩的 JS 里给每个模块留 `//#region <路径>`，CSS 留 `/*! 包名 v版本` 版权头；
从 `node_modules` 来的包既不在 `--prod` 表里、也不在名单里（工作区自己的 `@armadra/*` 除外）
就失败。`release.yml` 的 `linux-x86_64` 构建打完包跑它。新加一个会被打进页面或 core 的构建期
依赖时，把它加进名单再重新生成。

### 3.2 依赖安全：覆盖、补丁与构建期豁免

Dependabot 警报按三种办法收口，理由都写在 `pnpm-workspace.yaml` 对应条目旁：

- **有修复版**：`overrides` 只覆盖受影响的区间、钉到最低修复版（如 `uuid@<11.1.1`），父包自己的
  范围已经容得下；父包自己升过去后删掉那一条。
- **没有修复版、但漏洞代码可以整个拿掉**：`patchedDependencies` + `"父包>子包": "-"`。
  `acme-client` 只在旧的 `forge` 导出里用 `node-forge`，Armadra 不用它（CSR 在
  `core/gateway/acme.ts` 自己拼，账户密钥的 JWS 走 `node:crypto`），所以
  `patches/acme-client@5.4.0.patch` 删掉那个导出与文件，`node-forge` 不再安装、也不进包。
  `acme-client` 发了不依赖 `node-forge` 的版本后，补丁与覆盖一起删。升 `acme-client` 时补丁
  不再适用，`pnpm install` 会直接失败，不会悄悄失效。
- **没有修复版、只在构建期**：锁在 `pnpm-lock.yaml` 的现有版本，登记在下表，等上游发版；
  警报由维护者在 GitHub 上以「仅构建期 / 代码路径不可达」dismiss。

| 包                           | 警报                | 经由                                                                 | 为什么不进运行时                                                                                                            |
| ---------------------------- | ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `braces@3.0.3`               | GHSA-vfj7-8cjw-p6xm | `micromatch` ← `fast-glob` ← `shadcn` / `ts-morph`（web 开发依赖）   | 只有开发者手动跑 `shadcn` CLI 时加载；匹配的模式来自仓库自己的配置，不是外部输入                                            |
| `http-cache-semantics@4.2.0` | GHSA-ch52-4w7c-c8xp | `cacheable-request` ← `got@11` ← `@electron/get`（electron-builder） | 只在安装 / 打包时下载 Electron 用；是单用户的私有缓存，不是多用户共享缓存，警报说的跨用户泄露没有发生条件；4.3.0 未修此问题 |

### 3.3 更新镜像（W-MIRROR）

桶里与 GitHub Release 同形的两处（`tools/release/mirror.mjs`，传输用 rclone，PATH 上没有就跑钉住的
`rclone/rclone` 镜像；远端配置走 `RCLONE_CONFIG_MIRROR_*` 环境变量，不落盘）：

- `releases/download/v<版本>/`：`release.yml` 的 `mirror` 作业在建 draft 时传（只在 `publish` 时跑）。
  先传包、再传清单（`latest.json`、`SHA256SUMS`、`latest-*.yml` 与各自的 `.sig`），读到清单的客户端
  不会去拿还没到的包；传完 `rclone check --one-way`。配了 `ARMADRA_MIRROR_PUBLIC_URL` 时，
  `assemble.mjs --mirror-base` 另写一份 `latest.json`（链接指向镜像这一处，同一把钥匙、同一句可信注释
  `file:latest.json version:X`），它盖掉镜像里那一份；`SHA256SUMS` 仍是发布自己的，不列它。
- `releases/latest/download/`：只有清单。人把 Release 转正后，`distribute.yml` 的 `mirror` 作业把那一版的
  清单服务端复制过来（`mirror.mjs promote`）；预发布不提。清单里的地址都指向带版本的那一处，所以这里
  不需要包，旧版本的包也不会被覆盖。

客户端的检查地址：`ARMADRA_UPDATER_ENDPOINTS=https://github.com/<repo>/releases/latest/download/latest.json,https://updates.armadra.dev/releases/latest/download/latest.json`，
按顺序尝试。`node tools/release/mirror.mjs verify --base <公开地址> --pubkey <minisign.pub>` 像客户端那样读一遍
（签名、每个平台的 feed 与包、所有地址都在镜像之下）。

本地演练：`pnpm dev-stack up s3 --profile s3`（versitygw，`127.0.0.1:8095`，访问键在
`tools/dev-stack/services.mjs` 的 `S3_DEV`），`ARMADRA_DEV_STACK=1 node --test tools/release/mirror.test.mjs`
建一个一次性的桶、`stage` + `promote`，再用 `rclone serve http` 把桶当公开地址、`verifyMirror` 读回。
真 R2 与域名要用户提供（补全进度 G5-18「需用户提供」）。

## 4. 本地怎么先验

```sh
pnpm ci:workflows      # 两份工作流的结构、runner 标签与矩阵三元组
pnpm release:test      # tools/release 与 tools/ci 的单元测试
pnpm release:check     # 三端各处版本一致、兼容范围包含本版本、更新记录有本版本一节（§2.8）
pnpm release:dry-run   # 把一次完整发布落到临时目录并校验
```

下面这些只有真 runner 能回答，本机无从验证，列在这里免得下次有人以为它们已经过：

- `ubuntu-22.04` / `ubuntu-22.04-arm` 上 electron-builder 能否打出 AppImage / deb / rpm
  三种包（换打包器后未在真 runner 上跑过）；
- Apple 证书导入、`notarytool --validate`（API key 与 Apple ID 两条）与 electron-builder 的公证（要真 secret）；
- Windows Authenticode 的 Azure / 证书文件 / 自托管令牌三条路（要真 secret 或订阅）；
- 签名包的「安装 → 重启 → 版本号变」（`tools/probes/update-e2e.mjs --install`，要真证书；
  未签名包的「检查 → 下载 → 验签 → 暂存 → 拒装」已在本机打包版上走通）；
- Windows 便携 zip 解压后 core 能不能在 `resources/` 里找到 hook 客户端、
  session-host 与 `migrations/`。

首次打标签 `v0.1.0`（2026-09-14）跑了四遍才到 draft：arm64 行缺 appimagetool（见 §2.4）；
`assemble` 把「一个 `.sig` 都没有」当成六个洞而不是未签名发布，与 §3 的承诺相反，
现在只有部分签名或缺包才算洞；`verify` 的 Linux 行两次撞上 hook 序号锁测试的偶发。
最终六个桌面目标全部成功，draft Release 带 37 个文件（六平台桌面包 + 组件包 +
Web 包 + 空的 `latest.json` + `SHA256SUMS`）。上面两条带 secret 的项仍未验证。
那次发布的组件包（host / worker / hook / session-host）在 R7d 随受管二进制一起
取消，之后的发布只有桌面包、Web 包与两份清单。

### 历史：Rust / Go 的三平台真跑（2026-09-13 / 09-14）

分进程时代 CI 还要在三个平台上跑 `cargo test --workspace` 与 `go test ./...`。
首轮 Windows 上 38 条失败，根因归成五类（SQLite 连接 URL、`\\?\` 扩展长度前缀、
驱动器盘符不是目录、`--listen unix:` 的绝对路径判断、只有 Unix 有的东西），第二轮
`--no-fail-fast` 又列出了几批夹具与两处真缺陷（Go 的事件流关闭、服务定义按宿主
规范化；Rust 的终端 stale 判定），`71715cc29` 三平台全绿（Linux 14 分钟、macOS 10
分钟、Windows 33 分钟）。这些结论随 R7d 一起失效：那两条工具链与它们的用例都已
删除。当时的详细记录见 [实施批次记录](../history/platform-implementation-log.md)。
留下的只有一条仍然适用的教训：**平台差异写在源码的门控里，不写成 CI 的名字过滤**。
