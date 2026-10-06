# 开发指南

## 环境

Node.js ≥ 22 与 pnpm（版本锁定于根 `package.json`）——没有别的工具链。
tmux 是推荐终端后端，缺失时退回直连 PTY。
macOS 桌面目标 ≥ 13.3，并需 Xcode Command Line Tools。

```sh
pnpm install
./armadra.sh doctor
./armadra.sh run web       # core + Web，退出时一起关闭
./armadra.sh run desktop   # 桌面壳持有 core
```

`doctor` 检查 Node / pnpm / tmux / Xcode CLT。

## 分步启动

以下各进程在独立终端运行：

```sh
pnpm --filter @armadra/desktop build                       # 产出 out/core/main.js 等
node apps/desktop/out/core/main.js                         # 127.0.0.1:43120（兼容默认）
node apps/desktop/out/core/main.js --listen tcp:127.0.0.1:0   # 端口由内核分配
pnpm --filter @armadra/web dev      # 127.0.0.1:1420
# 或用桌面壳替代 Web 命令（仍需上面的外部 core）
pnpm --filter @armadra/desktop dev
```

## 监听方式与地址发现

core 的 `--listen` 可重复，每次一个：`tcp:IP:PORT`（端口 `0` 由内核分配）、
`unix:绝对路径`（0600）、`pipe:名字`（Windows 命名管道）。不给 `--listen` 时按
`ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT`，再退回 `127.0.0.1:43120`。
指定的 TCP 端口被占用直接报错，不换端口。

绑定成功后地址写入 `<数据目录>/endpoints.json`（0600）的 `runtime` 段，
含地址、instance id、pid 与写入时间；正常退出时撤回自己那段。
`./armadra.sh run web` 与 Vite 开发代理都从这个文件读地址，`VITE_RUNTIME_URL` 显式覆盖时不装代理。

桌面壳自己提供页面：主进程在 `127.0.0.1` 的一个内核分配端口上跑一个静态服务，
`BrowserWindow` 加载的就是这个地址。core 以 `--listen tcp:127.0.0.1:0` 启动并在 stdout
公告实例与端口，页面经 preload 的 `transport:endpoints` 一次性取得
`{ httpBase, wsBase, dataDir }`，`fetch` 与 `WebSocket` 直连
（[迁移设计](../design/electron-migration.md) §2.1）。没有自定义协议，也没有 WebSocket
回环转发端口。因此 `lsof -i -P | grep -i Armadra` 在「对外服务未开启」时只看到静态服务与
core 两个回环端口。

桌面包与 `./armadra.sh run desktop` 会持有自己的 core；后者额外用 `ARMADRA_RUNTIME_LISTEN`
钉一个回环端口，因为开发页面在 Vite 的 `http://127.0.0.1:1420`，不是壳的静态服务，拿不到
壳注入的基址。直接执行桌面 `dev` 默认连接外部 core。
Command W / 关闭窗口隐藏前台；Command Q / 托盘退出停止桌面持有的 core 及受管会话。
独立启动的 core 由启动它的终端管理。详见[桌面说明](../../apps/desktop/README.md)。

## 无窗口服务器壳

`apps/server`（`@armadra/server`）把同一套 core 装在同一个进程里，对外只有 TLS 一个面，
浏览器与手机加载的是同一份 `apps/web` 产物。它要求数据目录**已经过统一库迁移 0015**
（单向门，见 [实施进度](../status/typescript-core-status.md) §6），否则拒绝启动。

```sh
pnpm --filter @armadra/web build                     # 页面产物，serve 默认往上找 apps/web/dist
pnpm --filter @armadra/server build                  # esbuild → apps/server/out/main.js
node apps/server/out/main.js serve --data-dir ~/.armadra-server
node apps/server/out/main.js serve --listen 0.0.0.0:8443 \
  --public-origin https://armadra.example \
  --tls-cert /etc/armadra/tls.crt --tls-key /etc/armadra/tls.key
```

`--listen` 默认 `127.0.0.1:0`；**监听非回环地址必须同时给 `--public-origin`**，否则直接拒绝。
不给 `--tls-cert/--tls-key` 就在 `<数据目录>/tls/` 生成一张自签名证书（私钥 0600），
`status` 会把它标成「自签名」；`--acme <邮箱>`（或 `ARMADRA_ACME_EMAIL`）改由 ACME 签发并续期，
本地对 dev-stack 的 Pebble 演练，见 [服务器部署指南](server-deployment.md) §3。启动时打印一行
`armadra-server pairing https://…/#pair=<两分钟一次性票>`——用它在新设备上完成配对，
之后是 `__Host-` 前缀的会话 Cookie；POSIX 上 `kill -USR2 <pid>` 再铸一张。

TLS、准入、CSP 与页面托管不在 `apps/server` 里，而在 core 的 Gateway 域
（`apps/desktop/src/core/gateway/`）：`serve` 解析完参数就调 `openGateway`，桌面壳的
「对外服务」用的是同一个。两者的差别只在配置从哪来：服务器壳来自命令行，
`/api/gateway` 报 `managedBy: "shell"`、`PUT` 答 409；桌面壳来自设置 `gateway.*`
（整段是本机路径，不随账号走），`PUT /api/gateway` 写设置并当场开、关或重开。
桌面缺省的证书来源是 `<数据目录>/tls/` 的**本地 CA**（`ca.key` 0600）加它签的叶证书，
叶证书的 SAN 覆盖主机名与当前私网地址，地址变了只重签叶证书；`GET /ca.crt` 匿名发出 CA，
`POST /api/gateway/pairing` 给出 `#pair=<票>&fp=<指纹>` 的网页链接与 `armadra://pair` 深链。
原生 App 走 Bearer 模式（来源 `capacitor://localhost` / `https://localhost`），WebSocket 先
`POST /api/identity/ws-ticket` 换 30 秒一次性票，经 `Sec-WebSocket-Protocol: armadra-ticket.<票>` 升级。
桌面壳的页面产物按 `ARMADRA_GATEWAY_WEB_ROOT`、core 旁的 `../renderer`、检出里的 `apps/web/dist` 依次找，
都没有就只服务 API。形状见 [契约](../contracts/core-json-api.md) §17。

桌面安装包也带着服务器壳：`Armadra serve [参数]`（`main/entry.ts` 在装配桌面之前识别 `serve`，
`main/serve-launch.ts` 以 `ELECTRON_RUN_AS_NODE=1` 把自己当 Node 起 `resources/server/main.js serve …`，
参数透传，不开窗口、不进单实例锁；数据目录缺省 `~/.armadra-server`，不碰桌面的默认库）。`after-pack.mjs` 把 `apps/server/out/main.js` 与桌面自己的
`out/renderer`（与 `apps/web` 构建同一份产物）放到 `resources/server/{main.js,web/}`，
`pnpm --filter @armadra/desktop dist` 会先构建服务器壳。`packaged-smoke` 的第五步起
`Armadra serve` 验配对链接、`/health`、首页与 SIGTERM 退出。用法见[服务器部署指南](server-deployment.md#24-用桌面安装包直接起服务器)。

运维相关的四条命令只写文件，**绝不调用 launchctl / systemctl / sc.exe**：

```sh
node apps/server/out/main.js install --service-dir /etc/systemd/system \
  --run-as armadra --web-root /opt/armadra/web   # 只生成定义，自己审阅后再注册
node apps/server/out/main.js status --output json
node apps/server/out/main.js logs --lines 200
node apps/server/out/main.js upgrade --binary /tmp/armadra-server.next   # 没有 --confirm 只打印计划
```

`install` 必须显式给 `--service-dir` 与 `--run-as`，拒绝 root/SYSTEM 一类账号，`--env` 里名字带
TOKEN / SECRET / PASSWORD / CREDENTIAL 字样一律拒绝。

## 检查与打包

从仓库根执行，按改动涉及的模块选择：

| 范围               | 命令                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 仓库规则           | `pnpm repo:check`（秒级）、`pnpm repo:test`                                                                           |
| 一次过静态检查     | `pnpm check`＝libs 构建 + format:check + lint + typecheck + repo:check + ci:workflows + release:check + notices:check |
| lint               | `pnpm lint`（ESLint，只有 error 失败）；`pnpm exec eslint <路径>` 只看一处                                            |
| 未用代码与依赖     | `pnpm knip`（只出报告，退出码恒为 0；不在 check 里）                                                                  |
| 覆盖率             | `pnpm test:coverage`（web、desktop、server，报告在各包 `coverage/`）                                                  |
| 前端               | `pnpm --filter @armadra/web test`、`pnpm --filter @armadra/web typecheck`                                             |
| 共享模型           | `pnpm --filter @armadra/shared test`                                                                                  |
| core 与桌面壳      | `pnpm --filter @armadra/desktop test`（vitest + `node --test scripts/*.test.mjs`）                                    |
| 服务器壳           | `pnpm --filter @armadra/server test`、`pnpm --filter @armadra/server typecheck`                                       |
| 全部包             | `pnpm test`                                                                                                           |
| 格式 / 类型        | `pnpm format:check`、`pnpm typecheck`                                                                                 |
| 发布与 CI 脚本     | `pnpm release:test`、`pnpm ci:workflows`、`pnpm release:check`                                                        |
| 桌面构建（不打包） | `pnpm --filter @armadra/desktop build`                                                                                |
| 桌面打包           | `pnpm --filter @armadra/desktop dist`                                                                                 |

身份域的端到端在 `apps/desktop/src/core/identity/accounts.integration.test.ts`：真起 core，走完取票、配对、重放被拒、撤销。
`tools/probes/` 下的探针跑的也是真的 core（`apps/desktop/out/core/main.js`）：终端的冒烟、
生命周期与打包后验证，以及三个用无头 Chrome 驱动真实页面的 UI 探针（连线拖拽、Git 工具窗口、
画布压力）。运行入口见 [探针说明](../../tools/probes/README.md)。

R7d 删掉了一批只对分进程时代有意义的脚本：写入所有权的 e2e 与 harness、Host 的几支烟囱测试、
Rust↔Go 的归档互通，以及需要受管二进制路径的 `agent:smoke` / `handoff:read-smoke`。它们验证
的事实现在由 core 各域的用例覆盖；真 CLI 的端到端版本要重写成对着 core 的形式，还没有。

`armadra.sh check` 就是 `pnpm check`；`test` 是 shared 构建加 `pnpm -r test`。
`all` 执行 doctor → install → check → build → run。

`pnpm repo:check` 读 `repo.rules.json` 校验仓库结构：文档登记与相对链接、黑名单文件、包名与目录名、
根目录白名单、源码行数上限（超限文件登记在豁免表）、迁移编号与 `migrations.lock` 里的 sha256、
`pinnedVersions` 登记的上游包（现为 `@orpc/*`）精确锁版、非预发布且全树同一版本。
规则说明见[仓库结构与校验](../design/repository-structure.md)。
仓库级脚本都在 `tools/`，各 app 自己的脚本仍在各自的 `scripts/`。

### lint、knip 与覆盖率

工程规范化第 1 步（[设计](../design/engineering-standardization.md) §4.3、§5）：工具都只报告，不阻断。

- **ESLint**：根目录 `eslint.config.js`（flat config），覆盖 `apps/web`、`apps/desktop`、`apps/server`、
  `packages/shared` 与 `tools/`（手机壳与推送中继不在内）。typescript-eslint、react-hooks、jsx-a11y 与
  `@eslint/js` 的推荐规则一律 warn；格式归 Prettier（`eslint-config-prettier` 放最后）。只有这几条是 error：
  `react-hooks/rules-of-hooks`；core 与 session-host 不得 import `electron`、`../main/`、`../shell-core/`
  （shell-core 只禁前两个）；`@orpc/*` 只能出现在三处门面 `packages/shared/src/contract/`、
  `apps/desktop/src/core/http/rpc.ts`、`apps/web/src/api/client.ts` 与 `tools/contract/`。页面业务代码的
  禁止事项（手写 `<button>` / `<input>` / `<select>` / `<textarea>` / `<dialog>`、`role="dialog"`、直接 import
  `ui/dialog` / `ui/alert-dialog` / `ui/sheet`、`Loader2`、无 `aria-label` 的图标钮、`dark:`、`z-[N]`、
  调色板外的字面色值）是 `no-restricted-syntax` 的 warn。类型感知规则（`no-floating-promises`、
  `no-misused-promises`）只开在 `core/http`、`web/src/api` 与 `shared/src`。确有理由的豁免写带理由的
  `// eslint-disable-next-line <规则> -- 理由`。规则本身的自检是 `tools/lint-config.test.mjs`（在 `pnpm repo:test` 里）。
  本机加了 `--cache`（缓存在 `node_modules/.cache/eslint/`）。
- **knip**：`knip.json` 登记各 workspace 的入口（壳的构建目标、测试、脚本、探针）。`pnpm knip` 只出报告；
  夜间 `hygiene` 作业把报告传成产物。要看机器可读的结果用 `pnpm exec knip --reporter json`，
  只看一个包加 `--workspace apps/web`。
- **覆盖率**：`@vitest/coverage-v8`，web、desktop、server 三个 vitest 配置里写好 `coverage`，平时关着；
  `pnpm test:coverage` 或 `ARMADRA_COVERAGE=1 pnpm --filter <包> test` 打开，输出 text-summary 与
  `coverage/lcov.info`（已在 `.gitignore`）。不设门槛；CI 只在 Linux 那一行打开。
- **依赖漏洞**：`pnpm audit --prod --audit-level=high` 在夜间 `hygiene` 作业里跑，有就开 issue。

打包只有一步：`pnpm --filter @armadra/desktop dist`（细节在[桌面说明](../../apps/desktop/README.md)）。
它先定签名计划、再 `electron-vite build`、最后调用 electron-builder；包里要带的东西由
`scripts/after-pack.mjs` 从 `out/` 与 `src/core/db/migrations` 放进 `Resources/`。没有受管二进制
要先构建。产物落在 `apps/desktop/release/`。

### 更新签名

桌面包的信任分两层，各自有自己的密钥：

- **平台代码签名**（macOS Developer ID + 公证、Windows Authenticode）由 electron-builder 做，
  也是 electron-updater 安装前校验的东西。密钥经 `CSC_LINK` / `CSC_KEY_PASSWORD` 与
  `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 传入。
- **发布清单签名**：`latest.json` 里每个平台条目带一份 minisign 分离签名，由
  `tools/release/assemble.mjs` 用 `ARMADRA_RELEASE_SIGNING_KEY` 在写清单之前签出
  （[发布、更新与服务安装 §2.5](../design/updates-and-service-install.md#25-引入步骤一次性)）。

仓库里**没有**真实密钥。`pnpm --filter @armadra/desktop dist` 在开工前就决定这次要不要签名
（`scripts/signing-electron.mjs`），而不是把失败留到打包最后一步：

| `CSC_LINK` | 其余条件                          | 结果                                                          |
| ---------- | --------------------------------- | ------------------------------------------------------------- |
| 有         | 有 `CSC_KEY_PASSWORD`             | 正常签名；公证凭据齐全时一并公证，缺了就只签不公证            |
| 有         | 没有 `CSC_KEY_PASSWORD`           | **立即报错**：electron-builder 会在签名那一步以钥匙串错误收场 |
| 无         | `ARMADRA_REQUIRE_SIGNED_BUNDLE=1` | **立即报错**：发布不能是无签名的                              |
| 无         | 其余                              | 跳过签名，命令行明确告警                                      |

本机 `dist` 还会经 `extraMetadata` 往打进包里的 `package.json` 写一个
`armadraUpdates: "disabled"` 标记：`app.isPackaged` 对本机包和发布包都是 true，没有这个
标记它就会去轮询一个从未发布过这个版本的生产 feed。发布脚本不写这个标记，所以正式包不受影响
（`apps/desktop/src/shell-core/updates/availability.ts` 是读的那一半）。

本机想演练完整的清单 + 签名 + 校验用 `pnpm release:dry-run`，它自带一次性密钥，不碰任何真实密钥。

## Windows 真机验收

Windows 特有的部分（ConPTY、会话宿主与命名管道、`armadra-launch.exe` 在 cmd / pwsh 7 / Windows
PowerShell 5.1 里的读法、DPAPI、NSIS 安装与卸载）由 `tools/probes/windows-acceptance.mjs` 一键走完，
写出一份 `result.json`。它只用 Node 22 自带的东西，可以只把 `tools/probes/` 下的 `windows-acceptance.mjs`、
`windows-acceptance-lib.mjs` 与 `probe-home.mjs` 三个文件拷到 Windows 机器上（数据目录、HOME 与凭据变量的隔离同其他探针）。

**要准备的**：一台 Windows 10 22H2 / 11（x64 或 arm64）、Node 22+、要验的安装包
（`pnpm --filter @armadra/desktop dist` 在 Windows 上打出的 `Armadra-Setup-<版本>-<架构>.exe`，或 Release
资产）。机器上已经装着 Armadra 时，先卸载它，或改用 `--app` 对着它跑（同一个 appId 的安装包会先卸掉旧的）。
想顺带验真 Codex：装好 `codex` 并登录过（只把 `%USERPROFILE%\.codex\auth.json` 复制进临时 HOME）。

```powershell
node windows-acceptance.mjs --installer .\Armadra-Setup-0.1.0-x64.exe            # 完整：装、跑 30 分钟保活、卸
node windows-acceptance.mjs --installer .\Armadra-Setup-0.1.0-x64.exe --with-codex
node windows-acceptance.mjs --app "$env:LOCALAPPDATA\Programs\Armadra\Armadra.exe" --soak-minutes 5
node windows-acceptance.mjs --dry-run                                              # 只验脚本自己
```

其他选项：`--soak-minutes <n>`（默认 30）、`--require-signed`（发布候选：Authenticode 不是 `Valid` 就失败）、
`--out <目录>`、`--keep`（失败时留下临时目录）。跑的时候会弹出一个 Armadra 窗口，别去操作它；
防火墙不会弹窗（Gateway 只开在回环上）。数据目录、HOME / USERPROFILE 与 Chromium profile 都在临时目录，
跑完删除；开始前与卸载后各给真实用户配置（各 CLI 的配置目录、`%APPDATA%\Armadra`）拍一次快照，必须逐字节相同。

**结果**：命令最后打印每一项的 ✓ / ✗ / ! / - 与 `result.json` 的路径（仓库里跑在
`target/windows-acceptance/<时间>/`，拷出去跑在当前目录的 `windows-acceptance-<时间>/`）。把 `result.json`
整个贴回来即可；同目录的 `app-output.log` 是应用的标准输出，失败时一并附上。

`result.json` 的形状（`schema: "armadra-windows-acceptance/1"`）：

| 字段                | 含义                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `status`            | `passed`、`failed`（有 `fail` 项）、`incomplete`（中途退出）、`dryRun`                              |
| `options`           | 模式（`installer` / `app` / `dryRun`）、安装包文件名、保活分钟数、是否带 Codex                      |
| `machine`           | 系统版本、架构、内存、Node、三种 shell 的路径与 PowerShell 版本、`csc.exe`、PATH 上找得到的各家 CLI |
| `app`               | 被测的 `Armadra.exe` 与它的版本号                                                                   |
| `checks[]`          | 每项 `{ id, title, status: pass/fail/warn/skip, detail, seconds }`，id 稳定，见下表                 |
| `samples[]`         | 保活期间每分钟一次：Armadra 各进程（main / sessionHost / renderer / gpu …）与各 shell 的内存与句柄  |
| `failures[]`        | `fail` 项的 id                                                                                      |
| `leftover`、`error` | 没删掉的临时目录；脚本自己的异常                                                                    |

| id                                     | 验什么                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `preflight.platform` / `.existing`     | Windows + Node 22；`--installer` 时没有已登记的 Armadra 安装                                                                                   |
| `install.silent` / `.layout`           | `/S /D=<临时目录>` 静默安装；包里有 `armadra-hook.exe`、`armadra-launch.exe`、会话宿主、`conpty.node`                                          |
| `install.signature`                    | 安装包、`Armadra.exe`、`armadra-launch.exe` 的 Authenticode；未签名记 `warn`                                                                   |
| `app.start` / `app.updater`            | 临时目录里起应用、页面与 core 应答；更新器状态（签名、是否本地构建）                                                                           |
| `terminal.backend` / `terminal.shells` | 后端是 `sessionHost`；cmd / pwsh 7 / 5.1 各起一个终端，输入回显、`capture` 读得到                                                              |
| `sessionHost.process`                  | 会话宿主进程与 `\\.\pipe\armadra-session-*` 在                                                                                                 |
| `launcher.dialects` / `.credential`    | 三种 shell 里经 `armadra-launch.exe` 起程序：参数原样、注入在后、门关不注入；凭据兑换只进 CLI 进程                                             |
| `credentials.status`                   | `GET /api/credentials`：`dpapi` 且 `available`                                                                                                 |
| `gateway.loopback`                     | 回环上开 Gateway 能握 TLS，关掉后不再监听                                                                                                      |
| `files.watch`                          | 外部改文件后收到 `file.changed`                                                                                                                |
| `agent.codex`                          | `--with-codex`：经页面起 Codex，启动行是 `run\codex.exe`                                                                                       |
| `soak`                                 | 保活：进程都在、终端仍应答；会话宿主内存涨三倍以上或句柄多 2000 记 `warn`                                                                      |
| `restart.survives`                     | 杀主进程后宿主与 shell 都在，重启后同一会话接回并应答                                                                                          |
| `conpty.close`                         | 终止会话后 shell 与它的 `conhost` / `OpenConsole` 都退出                                                                                       |
| `sessionHost.leaves`                   | 应用退出后（没有会话、没有 core 连着）会话宿主 45 秒内自己退出，不用结束进程                                                                   |
| `app.logs`                             | 数据目录日志里的 error / fatal 行（有就 `warn`，内容附在 detail）                                                                              |
| `uninstall.silent`                     | 卸载后 `Armadra.exe`、注册表卸载项、开始菜单与桌面快捷方式都不在；卸载前起的空闲宿主经 `shutdownIfIdle` 自己退出，卸载后没有残留 `Armadra.exe` |
| `userConfig.untouched`                 | 真实用户配置前后逐字节相同                                                                                                                     |

`result.json` 不含凭据；终端内容只在某项失败时带最后一小段，探针自己的标记行之外没有别的输入。
CI 有两处：三个平台的 `pnpm release:test` 跑干跑（Windows 上顺带核对三种 shell 与 `csc` 都探测得到），
`nightly.yml` 的 `windows-acceptance` 作业在 windows runner 上打 NSIS 包并完整跑一遍（保活两分钟），
结果作为产物上传。真机上的长时间保活、真 CLI 与用户自己的 shell 配置只有用户的机器能答。

## 本地 dev-stack

`tools/dev-stack/` 用 Docker Compose 在本机起一组外部服务的替身，供探针与集成测试对着跑
（设计见 [外部服务](../design/external-services.md) §14）。Docker 是可选的：没装、没启动或没有
compose 插件时，`pnpm dev-stack up` 打印原因并退出 0，依赖它的用例记 `skipped`。

```sh
pnpm dev-stack up                      # 起全部非 profile 服务，并从宿主机跑健康检查
pnpm dev-stack up dex mailpit          # 只起其中几个
pnpm dev-stack up --profile ntfy       # 加上可选 profile（headscale / ntfy / s3）
pnpm dev-stack health --json           # 只跑健康检查
pnpm dev-stack logs keycloak -f
pnpm dev-stack down                    # 加 --volumes 连卷一起删
pnpm dev-stack down gitea              # 只停并删这几个
```

各 worktree 共用同一个 compose 项目：`up` 不清理别处起的服务，几个 worktree 同时用时，
`down` 点名只停自己起的那几个。

镜像全部钉到明确版本，端口只绑 `127.0.0.1`。端口与健康检查的唯一来源是
`tools/dev-stack/services.mjs`，`stack.test.mjs` 守住它与 `docker-compose.yml` 一致。

| 服务             | 端口          | 用途                                                           |
| ---------------- | ------------- | -------------------------------------------------------------- |
| `release`        | 8090          | 假 GitHub Releases：`latest.json`、下载、minisign 验签         |
| `pebble`         | 14000 / 15000 | ACME（验证一律放行，改 `PEBBLE_VA_ALWAYS_VALID=0` 测真挑战）   |
| `step-ca`        | 9000          | 第二个 ACME 实现与本地 CA 根（`/roots.pem`）                   |
| `dex`            | 5556          | OIDC，issuer `http://127.0.0.1:5556/dex`                       |
| `keycloak`       | 8080          | OIDC，issuer `http://127.0.0.1:8080/realms/armadra`            |
| `mailpit`        | 1025 / 8025   | SMTP 与收件 API                                                |
| `gitea`          | 3000          | Gitea API，管理员 `armadra-dev`                                |
| `glitchtip`      | 8000          | 崩溃上报（带 postgres 与 redis，均不对外）                     |
| `push-sink`      | 8091          | 假 APNs（h2c）/ FCM / Web Push / 推送中继，记录请求            |
| `hibp`           | 8092          | Pwned Passwords range API 固定响应                             |
| `armadra-server` | 8443          | 容器化服务器壳（`apps/server/docker/Dockerfile`，自签名 TLS）  |
| `headscale`      | 8094          | 可选 profile，只做文档验证，不进 CI                            |
| `ntfy`           | 8093          | 可选 profile，UnifiedPush 分发                                 |
| `pebble-va`      | 14100 / 15100 | 可选 profile，真回连挑战（`tls-alpn-01` 5001、`http-01` 5002） |
| `caddy`          | 8444          | 可选 profile，部署指南 §3.3 的反向代理演练                     |
| `s3`             | 8095          | 可选 profile，S3 兼容桶（versitygw），更新镜像作业的替身       |

开发夹具与密钥：

- dex 与 Keycloak 的用户都是 `dev@armadra.test` / `password`，公开客户端 `armadra-dev`（PKCE S256），
  机密客户端 `armadra-dev-confidential`。回调要绑临时端口时：dex 用不列回调的公开客户端
  `armadra-dev-loopback`（放行 `http://localhost:<任意端口>/…`），Keycloak 的 `armadra-dev` 直接放行
  `http://127.0.0.1:<任意端口>/…`。Keycloak 另有一个 `emailVerified: false` 的 `unverified` 用户。
  这些是写在 `tools/dev-stack/dex/`、`keycloak/` 里的公开夹具，不是凭据。
- Keycloak 管理员口令、GlitchTip 的 `SECRET_KEY` 与库口令、Gitea 管理员口令在首次 `up` 时随机生成到
  `tools/dev-stack/.data/dev.env`（已 gitignore），只在本机。
- `release` 每次启动现生成 minisign 密钥对，私钥只在容器内存里，公钥写到 `.data/release/minisign.pub`。
- `push-sink` 的请求用 `GET /_sink/requests` 取、`DELETE` 清；把 `<kid>.pem` 放进
  `.data/push-sink/apns/` 后 APNs 令牌会验签。设备令牌以 `bad` / `gone` 开头分别答「令牌无效」/「已注销」。
- `hibp` 里 `password`、`123456`、`qwerty`、`armadra-pwned-fixture` 一定命中。

`armadra-server` 第一次 `up` 要在容器里装依赖并构建页面与服务器壳，耗时几分钟；源码变了用
`pnpm dev-stack up armadra-server --build` 重建。

## 本地平台环境

平台（云控制面、中继、单人中转）的本地替身也在 dev-stack 里，用两个自成一体的 profile：起 `platform` /
`personal` 只会起各自的服务，不连带默认那组。云仓（`armadra-cloud`）的镜像缺省取 GHCR 的钉版本；
设了 `ARMADRA_DEV_STACK_CLOUD_SRC=<armadra-cloud 克隆>`（或克隆就在本仓库旁边的 `../armadra-cloud`）时
改为本地构建，并打印一行说明。

```sh
pnpm platform:personal   # 个人中转：relay-personal + armadra-server-nat，起来后逐个健康检查
pnpm platform:up         # 平台：postgres + redis + cloud + relay + armadra-server-nat，并跑 cloud 迁移
pnpm platform:health     # 只跑 platform 的健康检查
pnpm platform:down       # 只停 platform 的服务（不影响默认那组与别的 worktree）
pnpm platform:e2e        # 跨仓端到端：A 档 personal-roundtrip / multi-source / link-join，B 档 nat-core-offline；relay-roundtrip 预留（等 SaaS 服务端）
pnpm dev-stack down relay-personal armadra-server-nat   # 停个人中转那组：点名只停自己起的
```

`platform:down` 只停 `platform` profile；`pnpm dev-stack down` 不点名会停掉所有服务（含别的 worktree
正在用的）。

| 服务                 | 端口（127.0.0.1） | profile             | 用途                                                              |
| -------------------- | ----------------- | ------------------- | ----------------------------------------------------------------- |
| `platform-postgres`  | 5441              | platform            | 云控制面的 PostgreSQL（库 `armadra_cloud`）                       |
| `platform-redis`     | 6391              | platform            | 控制面与中继共用的 Redis                                          |
| `cloud`              | 8100              | platform            | 控制面，`/health`、`/ready`；SaaS 路由预留，答 501                |
| `relay`              | 8101              | platform            | 多租户中继，本地走 HTTP，源地址形如 `<sourceId>.src.localhost`    |
| `relay-personal`     | 8103              | personal            | 单人中转，不带数据库；自签 TLS 随 R2 落地，之前是 `--tls plain`   |
| `armadra-server-nat` | 不发布            | platform / personal | 模拟在 NAT 后、只能外连的 core，健康由容器内自己的 `/health` 给出 |

平台探针（`tools/probes/{personal-roundtrip,multi-source,link-join,nat-core-offline}.mjs`）不用上面这组容器：dev-stack 里 `relay-personal` 的对外地址是容器内端口，宿主机上的客户端按断言签发方对不上，所以探针用 `platform-lib.mjs` 自己 `docker run` 一份同镜像的个人中转（随机端口与名字、收尾只删自己的，`docker pause` 即用它冻住中继），NAT 后的 core 是宿主进程。需要 armadra-cloud 的本地检出与 Docker；中继镜像取 `ARMADRA_PROBE_RELAY_IMAGE`，缺省从检出 `docker build`。

随机生成的 `PLATFORM_DB_PASSWORD`、`PERSONAL_RELAY_PASSWORD`、`PLATFORM_SEED_PASSWORD`、
`ARMADRA_CLOUD_MASTER_KEY` 在首次 `up` 时补进 `tools/dev-stack/.data/dev.env`（旧文件会被补全，不会重写）。

## 平台协议包

`@armadra/platform-protocol`（隧道帧、断言声明、`/v1` 契约、错误码）由 `armadra-cloud` 发布，npm 发布前
以 vendored tarball 引用：`tools/vendor/armadra-platform-protocol-<版本>.tgz`，`packages/shared`、
`apps/desktop`、`apps/web` 用 `file:` 依赖指向它。版本、tarball 文件名与 sha256、协议主次号、两个镜像 tag
记在 `tools/release/compatibility.json` 的 `platform`（不进发布说明的围栏）；`pnpm release:check` 校验三份
manifest、tgz 的 sha256、锁文件（版本与 integrity）与已安装的版本一致。

更新 tgz：

1. 在 `armadra-cloud` 的 main 上 `pnpm install`，再 `pnpm protocol:pack`，得到 `.data/pack/armadra-platform-protocol-<版本>.tgz`。
2. 删旧 tgz，把新文件放进 `tools/vendor/`；用 `shasum -a 256` 取摘要。
3. 改三处 manifest 的 `file:` 路径，改 `compatibility.json` 的 `platform`（`version`、`tarball.file`、`tarball.sha256`、两个镜像 tag）。
4. `pnpm install`、`pnpm release:check`、`pnpm notices:check`，提交 tgz、manifest、锁文件与 `compatibility.json`。

协议包发布到 npm 后切换：三处 manifest 的依赖改成精确版本号（不带 `^`），删除 `tools/vendor/`（`repo.rules.json` 无需改），
`compatibility.json` 去掉 `tarball`，并去掉 `normalizePlatformPin` / `checkPlatformPin` 里
对 tarball 与 `file:` 路径的校验；其余（版本、锁文件、已安装版本）照旧。

## 来源与凭据

core 的 CORS 只放行回环 HTTP 来源：桌面壳放行的是自己静态服务的那个来源（端口由内核分配，
所以每次启动都不同），开发时再加上 Vite 的 `http://127.0.0.1:1420`。自定义 scheme 一律拒绝。
CSP（`apps/desktop/src/shell-core/csp.ts`）只允许本机 core 的 http/ws。桌面壳里页面经
preload 向壳要一张一次性配对票、换成自己的会话（Windows 经 fork 的 IPC 取票）；服务器壳的设备配对与可撤销会话见上面的「无窗口服务器壳」。
自 0.2.0 起 core 回环监听上的每一条 `/api/` 与每一条流都要会话（契约 §3.2）：桌面壳的页面在全局
`fetch` / `WebSocket` 上装了请求层（`apps/web/src/api/shell-transport.ts`），请求带票据换来的
`Authorization: Bearer`（CORS 放行这个头），流先 `POST /api/identity/ws-ticket` 换一张一次性票、经
`Sec-WebSocket-Protocol` 升级；托盘经 `shell-core/core-session.ts` 用自己的会话。没带会话的调用（包括
`curl` 与本机别的回环端口上的网页）一律 401，只有 `/health`、`/api/health`、`/api/identity/*` 与配对短码
换票例外。只有设了 `ARMADRA_LOOPBACK_OWNER=1` 的裸 core 不装这道门、按本机主人处理；所以浏览器里经
Vite 开发页面时，core 要由 `armadra.sh run web` 起（它带这个变量），连桌面壳起的 core 会处处 401。探针要从
Node 直接打桌面壳起的 core 时用 `tools/probes/probe-session.mjs`（经私有通道要票配对）。
分进程时代的票据链见 [桌面壳原生 Host 会话](../history/host-native-session.md) 与
[设备认证](../history/host-device-auth.md)，两份都是历史文档。

## 环境变量与数据

| 变量                                            | 作用                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ARMADRA_RUNTIME_HOST` / `ARMADRA_RUNTIME_PORT` | 没有 `--listen` 时的监听地址，默认 `127.0.0.1:43120`；设置后 `armadra.sh run web` 用固定端口而非随机端口                                                                                               |
| `ARMADRA_RUNTIME_LISTEN`                        | 桌面壳持有的 core 在私有 socket 之外额外监听的一个 `--listen` spec（开发用）                                                                                                                           |
| `ARMADRA_WEB_PORT`                              | `armadra.sh run web` 的前端端口                                                                                                                                                                        |
| `VITE_RUNTIME_URL`                              | 前端连接地址；设置后 Vite 不装代理。不设时浏览器开发走 Vite 代理（地址取自 endpoints.json），桌面壳里取 preload 给的 `httpBase`                                                                        |
| `ARMADRA_DATA_DIR`                              | core 的数据目录，`endpoints.json` 与 core 的 socket 都在这里                                                                                                                                           |
| `ARMADRA_DATABASE_URL`                          | SQLite 连接，例如 `sqlite://…?mode=rwc`                                                                                                                                                                |
| `ARMADRA_CORE_MIGRATIONS_DIR`                   | 迁移目录，覆盖「包内 `resources/migrations` → 往上找检出」这条查找顺序（测试与夹具用）                                                                                                                 |
| `ARMADRA_LOG`                                   | 日志级别，默认 `info`                                                                                                                                                                                  |
| `ARMADRA_CRASH_REPORT_DSN`                      | 服务器壳的可选崩溃上报 DSN（自托管 GlitchTip / Sentry 协议）；设了就以它为准，不设时读设置 `diagnostics.crashReportDsn`，两处都空则不发（外部服务 §11.2）                                              |
| `ARMADRA_LOOPBACK_OWNER`                        | `=1` 让裸 core 不装回环监听上的门，把明文回环上没带凭据的调用当成本机主人（契约 §3.2）。只给探针（`tools/probes/probe-home.mjs` 统一设）与 `armadra.sh run web`；桌面壳不把它带给 core，服务器壳不听它 |
| `ARMADRA_RPC_VALIDATE_OUTPUT`                   | RPC procedure 的出参按契约校验（`1` / `0`）；缺省开发与测试开、打包的生产构建关（契约 §34.1）                                                                                                          |
| `ARMADRA_RPC_TRACE`                             | `=1` 记每条 RPC 调用的耗时                                                                                                                                                                             |
| `ARMADRA_HOOK_DEBUG`                            | Hook 调试                                                                                                                                                                                              |
| `ARMADRA_DESKTOP_OWNS_RUNTIME`                  | 开发也由壳持有 core（默认连外部 core）                                                                                                                                                                 |
| `ARMADRA_DESKTOP_PACKAGED`                      | 按打包布局解析随包资源的位置，不必真打包                                                                                                                                                               |
| `ARMADRA_DESKTOP_LIFECYCLE_TRACE`               | 打印启动 / 退出编排的事件                                                                                                                                                                              |
| `ARMADRA_UPDATES_DEV`                           | `=1` 让未打包的构建也接更新器，用来对着本地发布服务走一遍流程；它不放松安装校验，未签名的包照样会被拒                                                                                                  |
| `ARMADRA_UPDATER_ENDPOINTS`                     | 逗号分隔的更新清单地址，覆盖 `electron-builder.yml` 里的占位 `publish.url`；仓库里从不写死真实地址                                                                                                     |
| `ARMADRA_HOOK_TIMEOUT_MS`                       | Agent 扩展模块上报的超时（默认 1500 ms，上限 60000）。只有测试驱动会调大它：进程级回退路径要在同一预算里起一个子进程                                                                                   |
| `ARMADRA_REMOTE_WORKER_LAUNCHER`                | 替换远端 Worker 启动行的 argv[0]（默认 `ssh`）。必须是绝对路径、不含空白；SSH 选项与远端命令原样保留。测试与自建隧道用                                                                                 |
| `ARMADRA_STATUS_PAGE_BASE`                      | 用量页的 Provider 状态页改读 `<地址>/<anthropic\|openai\|github>/api/v2/status.json`（探针用本机 fixture，不碰真网络）                                                                                 |
| `ARMADRA_COPILOT_CLIENT_ID`                     | Copilot 设备流换成自己的 GitHub OAuth 应用（企业部署）；设备流本身在 `usage.copilotUsage` 后面，默认关                                                                                                 |
| `ARMADRA_SECRET_BACKEND`                        | `=file` 强制密钥后端为 0600 明文文件（测试与无人值守；测试的 setup 默认设了它，不碰开发者的钥匙串）；`=file-encrypted` 用数据目录里的 master key 封存（探针用，节点凭据拒绝 `file`）                   |
| `ARMADRA_RELAY_ALLOW_INSECURE`                  | `=1` 让出站中继隧道接受 `ws://` 节点（探针与本机明文中继用）；缺省只连 `wss://`（契约 §32）                                                                                                            |
| `ARMADRA_SECRET_MASTER_KEY_FILE`                | 服务器壳的 master key 换个位置（如 systemd `LoadCredential=`）；不设时用 `<数据目录>/secrets/master.key`，首启生成                                                                                     |
| `ARMADRA_SMTP_URL` / `ARMADRA_SMTP_FROM`        | 服务器壳的可选邮件通道（同 `serve --smtp-url` / `--smtp-from`，契约 §28）：`smtp(s)://用户:口令@主机:端口`，口令可写 `secret://armadra-smtp`；不设则不发信、页面不显示「发送邮件」                     |

脚本发现 core 端口占用时直接报错。节点身份、Hook token、端点与权限等待变量由 core 注入 Agent 终端，无需手工配置。
core 不监听 TCP 时 `hook-endpoint.env` 不写 `ARMADRA_HOOK_PORT`，Hook 客户端只走 `hook.sock`。

默认数据目录：macOS `~/Library/Application Support/Armadra`，Windows `%LOCALAPPDATA%\Armadra`，
Linux `$XDG_DATA_HOME/armadra`。包含 `canvas.db`、设置、`endpoints.json`、core 的 socket、Hook 端点、节点 token、审批文件和 tmux socket。
工作区 `.armadra/` 保存图片、导出与板日志，已加入 `.gitignore`。

「设置 → 数据」使用当前连接的 SQLite 一致性快照备份，包含已提交 WAL 数据；完整性检查通过后写入数据库旁的唯一文件。
内存数据库不提供旁路文件备份。数据库只允许空库初始化或完整已知迁移前缀升级，异常时拒绝启动，保留原数据。
开发约定见[AGENTS.md](../../AGENTS.md)。
