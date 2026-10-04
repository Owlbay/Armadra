# 用户待办清单

> 状态：2026-10-05 汇总。补全与 G5（G5-00…G5-30）已全部合入，代码侧没有挂着的工作包；下面每一项都要维护者提供账号、证书、设备或域名，或在 GitHub 上动手。来源：[G5 剩余事项计划](../design/g5-remaining-plan.md) §4 B 档、[补全进度](completion-progress.md) G4-1「需用户提供」与 G5 各节的「没做 / 需用户提供」，合并去重。
> 每条写：**提供**什么、**填在**哪里（secret / 变量 / 设置项 / 环境变量）、**验证**用什么命令或探针。不写真实值；步骤细节见各条链接的指南。secret 与变量都指 GitHub 仓库 Owlbay/Armadra 的 Actions 设置。

## 1. 证书与签名

- [ ] **Apple Developer ID Application 证书**
  - 提供：Apple Developer Program 会员；Developer ID Application（G2 链）证书导出的 `.p12` 与口令、Team ID。
  - 填在：secrets `APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_TEAM_ID`（可选 `APPLE_SIGNING_IDENTITY`）。
  - 验证：`release.yml` 跑出的 draft 说明顶部不再列 macOS 未签名；包上 `codesign --verify --deep --strict` 通过，设置 → 更新的签名状态为 `signed`；`node tools/probes/update-e2e.mjs <out> --install --next` 走到「安装 → 重启 → 版本号变」。
- [ ] **App Store Connect API key（公证）**
  - 提供：Developer 角色的 API key（`.p8` 只能下载一次）、Key ID、Issuer ID；或 Apple ID 加 app 专用密码作回退。
  - 填在：secrets `APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER_ID`；回退用 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`。
  - 验证：`release.yml` 的 `notarize` 作业通过，说明里 macOS 不再列为未公证；`spctl --assess -vv` 对 `.app` 答 Notarized Developer ID。
- [ ] **Windows 代码签名（三选一）与发布者名**
  - 提供：Azure Artifact Signing 账户与 Entra 应用；或 OV 证书文件与口令；或自托管 Windows runner 加 USB 令牌。
  - 填在：Azure 路径 secrets `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` 加变量 `AZURE_SIGNING_ENDPOINT` / `AZURE_SIGNING_ACCOUNT` / `AZURE_SIGNING_PROFILE`；证书文件路径 secrets `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD`；令牌路径变量 `ARMADRA_WIN_CERT_SHA1`（Windows 作业的 `runs-on` 改成自托管标签）。三条路都要变量 `ARMADRA_WIN_PUBLISHER_NAME`（证书主体 CN）。
  - 验证：安装包与 `Armadra.exe` 上 `Get-AuthenticodeSignature` 为 `Valid`；`node windows-acceptance.mjs --installer <Setup.exe> --require-signed` 的 `install.signature` 通过。
- [ ] **minisign 发布密钥**
  - 提供：`node tools/release/sign.mjs keygen --pubkey-out <minisign.pub>` 生成的私钥；公钥自己留存并公开。
  - 填在：secret `ARMADRA_RELEASE_SIGNING_KEY`。
  - 验证：draft 里每个产物带 `.sig`、`latest.json` 非空；对下载的发布目录跑 `node tools/release/sign.mjs verify --dir <dir> --pubkey <minisign.pub>`。
- [ ] **Linux GPG 签名专用密钥**
  - 提供：armored 私钥与口令。
  - 填在：secrets `ARMADRA_LINUX_GPG_KEY`、`ARMADRA_LINUX_GPG_PASSPHRASE`；首个签名发布后把导出的 `armadra-linux.gpg` 提交到 `apps/web/public/`（之后的发布按它核对指纹）。
  - 验证：`node tools/release/sign-gpg.mjs verify --dir <dir> --public-key armadra-linux.gpg`；rpm 上 `rpm -K` 通过。
- [ ] **iOS 分发证书与描述文件**
  - 提供：App ID `dev.armadra.mobile` 与 `dev.armadra.mobile.NotificationService`（开 Push Notifications 与 Keychain Sharing）、分发证书、两份 provisioning profile。
  - 填在：本机 Xcode 签名；secrets `IOS_DISTRIBUTION_P12_BASE64`、`IOS_DISTRIBUTION_PASSWORD`、`IOS_PROVISIONING_PROFILE_BASE64` 已在[客户端平台](../guides/client-platforms.md)「真机与商店」里约定，目前没有工作流读取。
  - 验证：真机装上 App，按「真机与商店」第 7 步扫码 → 钉扎 → 配对 → 画布。
- [ ] **Android 上传密钥**
  - 提供：上传用 keystore、口令与别名。
  - 填在：构建时的环境变量 `ANDROID_UPLOAD_KEYSTORE`（文件路径）、`ANDROID_UPLOAD_KEYSTORE_PASSWORD`、`ANDROID_UPLOAD_KEY_ALIAS`（可选 `ANDROID_UPLOAD_KEY_PASSWORD`），`apps/mobile/android/app/build.gradle` 只从环境读。
  - 验证：`./gradlew :app:bundleRelease` 出签名的 AAB，`apksigner verify` / `jarsigner -verify` 通过。

## 2. 发布与镜像

- [ ] **Cloudflare R2 更新镜像**
  - 提供：一个 R2 桶、只授权这个桶读写的 S3 API 令牌、桶的公开自定义域名。
  - 填在：secrets `CLOUDFLARE_R2_ACCESS_KEY_ID`、`CLOUDFLARE_R2_SECRET_ACCESS_KEY`；变量 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_R2_BUCKET`、`ARMADRA_MIRROR_PUBLIC_URL`（全缺跳过，缺一部分失败）。
  - 验证：发布一次后 `release.yml` 的 `mirror` 作业通过，转正后 `distribute.yml` 的 `mirror` 作业通过；`node tools/release/mirror.mjs verify --base <公开地址> --pubkey <minisign.pub>`。客户端第二个检查地址要把镜像加进 `release.yml` 的 `ARMADRA_UPDATER_ENDPOINTS`（现在只写 GitHub），这是一处代码改动，域名定了再做。
- [ ] **CHANGELOG 发布日期**
  - 提供：0.2.0 的发布日期。
  - 填在：`CHANGELOG.md` 的 `## 0.2.0（未发布）` 改成 `## 0.2.0（YYYY-MM-DD）`。
  - 验证：`node tools/release/changelog.mjs check --version 0.2.0 --released` 通过；不改的话 `release.yml` 在 `verify` 就失败。
- [ ] **打标签、审阅 draft、转正**
  - 提供：发版决定。
  - 填在：推 `v0.2.0` 标签；`release.yml` 建出 draft 后人工审阅说明（顶部会列出未签名的平台）再转正。
  - 验证：`pnpm release:check`、`pnpm release:dry-run` 先在本机过；标签触发的 `server-image.yml` 把服务器壳镜像推到 GHCR，转正后 `distribute.yml` 跑完（[CI 与发布](../guides/ci-release.md) §2.7、§3.1）。
- [ ] **分发渠道仓库与令牌**
  - 提供：Homebrew tap 仓库、Scoop bucket 仓库、`microsoft/winget-pkgs` 的 fork，各一个细粒度 PAT。
  - 填在：secrets `HOMEBREW_TAP_TOKEN`、`SCOOP_BUCKET_TOKEN`、`WINGET_TOKEN`；仓库名不是缺省值时设变量 `ARMADRA_HOMEBREW_TAP`、`ARMADRA_SCOOP_BUCKET`。Homebrew cask 要求包已签名且公证（第 1 节前两项）。
  - 验证：Release 转正后 `distribute.yml` 推送成功，tap / bucket 里出现新版本，winget 出现 PR。

## 3. 外部账号与服务

- [ ] **稳定域名与公网主机**
  - 提供：域名、一台公网可达的主机（或反向代理）。
  - 填在：服务器壳 `ARMADRA_PUBLIC_ORIGIN`、`ARMADRA_ACME_EMAIL`（可选 `ARMADRA_ACME_CHALLENGE=tls-alpn-01`），见[服务器部署](../guides/server-deployment.md)第 2–3 节。
  - 验证：部署指南第 3 节签出 Let's Encrypt 证书；手机浏览器不装 CA 直接打开；真手机注册并登录 passkey。OAuth 回调、通用链接、商店审核演示服务器都依赖这一项。
- [ ] **SMTP 账号**（可选）
  - 提供：SMTP 地址、用户名、口令、发件人。
  - 填在：`armadra-server secrets set armadra-smtp`（口令从标准输入读），再 `serve --smtp-url 'smtps://<用户>:secret://armadra-smtp@<主机>:465'`，或环境变量 `ARMADRA_SMTP_URL` / `ARMADRA_SMTP_FROM`（部署指南第 10 节）。
  - 验证：`GET /api/mail/status` 答 `configured: true`；设置 → 账号与共享签发邀请或重置链接，「发送邮件」后收件箱收到，链接能打开。
- [ ] **OAuth 应用**（可选）
  - 提供：GitHub OAuth App（回调 `<公网来源>/api/identity/oauth/github/callback`，scope `read:user user:email`）；一个 OIDC 提供方的 client id / secret。
  - 填在：设置 `identity.oauth.providers[]`（契约 §18.5，开放建号时填 `allowedDomains`）；密钥经 `PUT /api/identity/oauth/providers/{id}/secret` 进密钥后端。
  - 验证：设置 → 安全里绑定 → 登出后用它登录 → `allowSignup` 建号一次；手机真机那一条见第 4 节。
- [ ] **推送密钥**
  - 提供：APNs `.p8`、Key ID、Team ID；Firebase 项目的 `google-services.json` 与服务账号 JSON。
  - 填在：自建部署给 core 的 `ARMADRA_PUSH_APNS_KEY_FILE` / `ARMADRA_PUSH_APNS_KEY_ID` / `ARMADRA_PUSH_APNS_TEAM_ID` / `ARMADRA_PUSH_APNS_BUNDLE_ID`、`ARMADRA_PUSH_FCM_CREDENTIALS_FILE`（或设置 `push.*`，`push.transport = "direct"`）；`google-services.json` 放到 `apps/mobile/android/app/`（不进仓库）。商店版填进中继的 `ARMADRA_RELAY_APNS_*`、`ARMADRA_RELAY_FCM_CREDENTIALS_FILE`。
  - 验证：真机开推送后 `POST /api/push/test` 收到通知，锁屏显示解密后的标题。
- [ ] **推送中继主机与 App 证明**（商店版，是否运营由发布方定）
  - 提供：一台公网主机；App Attest 与 Play Integrity 所需的商店账号。
  - 填在：主机上运行 `apps/push-relay`（`ARMADRA_RELAY_*`，见它的 README）；构建 App 时设 `ARMADRA_MOBILE_RELAY_URL`。
  - 验证：商店版 App 以 `transport: "relay"` 登记并收到 `POST /api/push/test`。安全审查 L5（未经证明的 `/v1/register` 应答 401）代码侧还没做，账号就绪后另开工作包。
- [ ] **GitLab 实例与令牌**（可选；Gitea / Forgejo 同理）
  - 提供：一个 GitLab 实例（自建或托管，合并列车要 Premium）与带 `api` scope 的令牌、一个测试项目（含子组更好）。
  - 填在：设置 → Git 托管 →「其他平台」，按主机或仓库选 GitLab、填地址与令牌（保存时核验）。
  - 验证：在 Git 托管面板对测试项目走 issue 开关、新建 MR、检查、合并方式、流水线通过后合并、fork 检出与合并后删分支；答复形状与 `apps/desktop/src/core/forge/fixtures/gitlab/` 不符就重录夹具。
- [ ] **商店账号与审核材料**
  - 提供：Google Play 开发者账号（个人账户新 App 要封闭测试 14 天）与上传用服务账号 JSON；App Store Connect 里的 App 记录；一台演示服务器壳与审核账号、隐私说明、出口合规问卷。
  - 填在：两家商店后台；演示服务器依赖上面的域名。
  - 验证：TestFlight 与 Play 封闭测试能装上并完成「配对 → 画布」。
- [ ] **崩溃上报 DSN**（可选）
  - 提供：自托管 GlitchTip（或同协议服务）的 DSN。
  - 填在：设置 → 通用 → 诊断；服务器壳可用 `ARMADRA_CRASH_REPORT_DSN`。要收页面错误再打开「包含页面错误」。
  - 验证：故意触发一次错误后收件端出现事件，里面没有家目录、环境变量值与令牌。
- [ ] **Claude 订阅档额度来源**（可选）
  - 提供：各订阅档 5 小时 / 7 天额度的可靠来源。
  - 填在：暂无入口：`UsageService` 的 `claudeWindowLimits` 没有接进装配，有来源后另开工作包接线。
  - 验证：用量卡上「本地估算」从只报 token 变成带百分比。

## 4. 需真机验证

- [ ] **真 Windows 10 / 11 验收**
  - 提供：一台 Windows 10 22H2 / 11、Node 22+、要验的安装包；想验 Codex 时装好并登录。
  - 填在：按[开发指南](../guides/development.md)「Windows 真机验收」只拷三个探针文件。
  - 验证：`node windows-acceptance.mjs --installer <Setup.exe>`（有 Codex 加 `--with-codex`），回传 `result.json`；重点看 `soak`（30 分钟）、`restart.survives`、`sessionHost.leaves`、`uninstall.silent` 与 `userConfig.untouched`。同一台机器顺带做节点凭据 T9。
- [ ] **Windows 取票通道与接管提示**
  - 提供：同一台 Windows 机器。
  - 填在：无。
  - 验证：打包版正常启动后，页面、终端、事件流、图片与下载都不出 401，没有「请重开应用」通知条，托盘用量有数；`result.json` 的 `app.logs` 里没有 401。再让一个外接的 core 占住数据目录后启动应用，应出现通知条，「重连」能恢复。
- [ ] **NSIS 更新缓存目录**
  - 提供：同一台 Windows 机器、两个相邻的签名版本。
  - 填在：无。
  - 验证：从旧版检查并下载新版后，缓存在 `%LOCALAPPDATA%\armadra-updater\`（不是 `@armadradesktop-updater`）；带着活会话升级一次，记下会话被结束的体验。
- [ ] **手机真机 OAuth**
  - 提供：iOS / Android 真机、上面的 OAuth 应用与域名。
  - 填在：无。
  - 验证：App 里设置 → 安全点 GitHub / OIDC → 系统浏览器授权 → 回到 App 的「安全」页显示已绑定；对开了两步验证的账号在没有会话时走一次，应进验证码页再进画布。
- [ ] **局域网与 UnifiedPush 真机**
  - 提供：同一网段的电脑与手机；Android 上装一个 UnifiedPush 分发器（可选自建 ntfy）。
  - 填在：设置 → 后台服务与对外服务，Gateway 设 `private` / `all` 各一次。
  - 验证：两档下手机扫码与输入 8 位配对码各配对一次；Android 设备登记带 `unifiedpush` 端点，`POST /api/push/test` 经分发器收到。
- [ ] **真实 sshd 主机**
  - 提供：一台可 SSH 登录的 Linux / macOS 主机。
  - 填在：设置 → SSH 与执行主机里登记。
  - 验证：`remote-e2e` 没有真主机模式，按它的步骤手工走：建远端工作空间、Git 长操作、SSH 终端里的注入与 Hook 中继、跨主机交接、SSH 节点切到 ACP 答一轮。
- [ ] **nightly 首跑与观察项**
  - 提供：无（看 CI）。
  - 填在：无。
  - 验证：`gh run list --repo Owlbay/Armadra --workflow nightly.yml` 里 main 的夜间运行：`linux-arm64` 作业的 `deb-install`（arm64 deb 与 AppImage）通过；`server-caddy-e2e` 通过；日志里统计「配对重试后完成」出现的次数（R-89 的修复是推断的）。

## 5. CLI 安装与登录

这几项都在 `tools/probes/README.md`「C 档运行手册」里，用临时 HOME 跑，只复制登录文件、不改真实配置。

- [ ] **OpenCode**
  - 提供：装好并登录 OpenCode 的机器。
  - 验证：`ARMADRA_E2E_REAL=1 node tools/probes/agent-e2e.mjs <out> --only 10,12 --record-compat`；通过后画面门里它的特征翻成 `verified: true`，`tools/release/compatibility.json` 记上版本。
- [ ] **Oh My Pi（OMP）**
  - 提供：装好并登录 OMP 的机器。
  - 验证：同上。
- [ ] **GitHub Copilot CLI**
  - 提供：装好并登录 Copilot CLI 的机器（账号带 Copilot）。
  - 验证：同上，另核对 `copilot --acp --stdio` 下的权限旗标。
- [ ] **Codex（ChatGPT 登录）与 codex-acp**
  - 提供：用 ChatGPT 登录过的 Codex（`~/.codex/auth.json`），以及 codex-acp 适配器。
  - 验证：同上，`compatibility.json` 的 `codex.verified` 由 `--record-compat` 写入；场景 10 的成本一步一并复跑。
- [ ] **pi-acp 的会话映射**
  - 提供：已装的 pi-acp（本机已实跑过 0.0.34）。
  - 验证：ACP 驱动的 Pi 节点答一轮后看 `~/.pi/acp/sessions.json` 的形状与 `core/acp/adapters.ts` 的约定一致，切回终端视图能接回同一会话。
- [ ] **多账号实测（T1–T9）**
  - 提供：两个 Claude 订阅（一个 `/login`、一个 `setup-token`）、两个带 Copilot 的 GitHub 账号与其中一个的细粒度 PAT；Codex / Pi / OMP / OpenCode 的 API key。
  - 填在：设置 → Agent → 节点凭据。
  - 验证：按 [CLI 协作](../design/cli-collaboration.md) §7.4 逐项实测，通过一项就在 `apps/desktop/src/core/agent/credentials/inject.ts` 的 `CREDENTIAL_KINDS` 打开对应种类。
- [ ] **打包版冒烟带真 Claude**
  - 提供：能在隔离 HOME 下登录的 Claude 凭据（不依赖钥匙串）。
  - 验证：`node tools/probes/packaged-smoke.mjs`（不加 `--no-real-cli`）。

## 6. 仓库管理

- [ ] **Dependabot 警报 #49、#50**
  - 提供：无。
  - 填在：GitHub → Security → Dependabot，#49 `braces`、#50 `http-cache-semantics` 选「代码路径不可达 / 仅构建期」dismiss，理由见 [CI 与发布](../guides/ci-release.md) §3.2。
  - 验证：`gh api 'repos/Owlbay/Armadra/dependabot/alerts?state=open'` 答空。
