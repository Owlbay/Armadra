# 外部服务与依赖：全清单与接入设计

> 状态：部分实施（2026-10-04）。已实施：W-DEVSTACK、W-SECRETS、W-UPD、W-OUTBOUND、W-SIGN-MAC / WIN / LINUX、W-ACME、W-AUTH-OIDC、W-AUTH-PASSKEY（含 HIBP 泄露检查）、W-PUSH（不含 UnifiedPush）、W-MOBILE、W-PAIR-FP、W-DIST、W-NOTICES、W-CRASH（[补全进度](../status/completion-progress.md)）。未实施：W-MAIL、W-FORGE、W-MIRROR；§13 的条目全部仍待用户提供，汇总在补全进度 G4-1 一节。本文盘点**成品 Armadra 会碰到的每一个外部服务、账户、证书与第三方 API**，逐项给出用途、选项对比（2026 年价格与可用性，附来源）、推荐、能在本机验证到哪一步、用户必须提供什么、密钥放在哪、没配置时的降级行为。现状以源码为准，本文里「现状」一栏写的是 2026-10-03 `main`（aaca2b03）上的代码；凡是本文新提的环境变量、secret 名与配置键都带「新」字。
> 范围：发布签名与公证、更新托管、分发渠道、手机壳与推送、网关连通与 TLS、认证、实时协同基础设施、模型提供商、Git 托管 API、遥测与许可证、密钥存放。不写各 CLI 自己的账户（Armadra 不碰它们，[AGENTS.md](../../AGENTS.md)），不写计费。
> 配套：总体架构见 [完成架构](completion-architecture.md)，批次见 [完成计划](completion-plan.md)；发布流水线现状见 [CI 与发布](../guides/ci-release.md)，更新链路见 [发布、更新与服务安装](updates-and-service-install.md)，账号模型见 [服务器账号、中转与共享](server-accounts-and-sharing.md)，`ama` 的供应商目录见 [协调 Agent](coordinator-agent.md) §7。

## 0. 结论

| #   | 决定                                                                                                                                                                                                      | 理由                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | **没有任何外部服务是启动的前提**。桌面壳离线可用；服务器壳只要一张自签名证书就能跑。每一项外部依赖都是可选层，缺了就按本文写明的方式降级并如实显示                                                        | README 的「本地优先」与「如实的状态」；现有 `signingPlan()` 的 sign / skip / refuse 三态、`updates/availability.ts` 的 `notConfigured` 已是这种做法 |
| E2  | **发布只有一个来源：GitHub Releases**；`armadra.dev` 这个占位域名只在要做镜像（Cloudflare R2）、通用链接（AASA / assetlinks）或 ACME 时才需要真的注册                                                     | [更新设计 §0](updates-and-service-install.md)已定；R2 出站免费，GitHub Releases 无带宽限制（§3）                                                    |
| E3  | **macOS 签名用 Developer ID + notarytool，公证凭据改为 App Store Connect API key**（保留 Apple ID + 应用专用密码作回退）                                                                                  | notarytool 自身推荐 API key；团队持有而非个人账户，改口令不会让发布静默失败（§2.1）                                                                 |
| E4  | **Windows 签名按用户所在地二选一**：美国 / 加拿大的个人或所列国家的组织用 Azure Artifact Signing（$9.99/月，无硬件令牌，CI 直接可用）；其余用 CA 的 OV 证书 + 云签名或自托管 runner 上的 USB 令牌         | 2026 年 OV 与 EV 都必须把私钥放在 FIPS 140-2 L2 硬件或云 HSM 里，`.pfx` 文件证书已经不再签发；现有 `WINDOWS_CERT_BASE64` 路径只对旧证书成立（§2.2） |
| E5  | **更新清单双轨**：`latest.json`（minisign，Host 侧真相）保留；再补 electron-updater 的 `latest*.yml`（现在不发布，是 W-UPD 的缺口），并在 electron-builder 27 稳定后切到它的 Ed25519 签名清单             | `updater.ts` 的 `checkForUpdates()` 走 `provider: generic`，它只认 `latest*.yml`；`stage-desktop.mjs::isReleaseAsset` 却把 yml 挡在发布之外（§3.2） |
| E6  | **手机壳用 Capacitor 包同一份 `apps/web`**，产物内置、不是远程 URL 壳；推送第一期走 Web Push（VAPID，服务器壳自发，无第三方），第二期服务器壳直连 APNs（.p8）与 FCM v1（服务账号），不引入推送中间商      | App Store 4.2 对「网页套壳」的拒审风险；iOS 推送只能经 APNs，自托管 ntfy 也要绕回 ntfy.sh（§5）                                                     |
| E7  | **外网连通不自建中继服务**：文档化 Tailscale / Headscale / WireGuard / Cloudflare Tunnel 四条路；代码只做「服务器壳的 ACME 自动证书」与「配对链接携带证书指纹」两件事                                     | 终端流量用 WSS 一条连接就够，WebRTC + coturn 没有收益；中继是运维选择，不是产品代码（§6）                                                           |
| E8  | **认证：口令 + 邀请（已有）→ passkey（RP ID 必须是域名）→ TOTP → 通用 OIDC 绑定（GitHub / Google / Microsoft / Keycloak 都走同一条 OIDC 代码路径）**；不做邮件依赖，邀请与重置都是链接 / 一次性码         | WebAuthn 禁止 IP 字面量作 RP ID，局域网按 IP 访问的服务器壳只能如实拒绝；邮件服务是最容易拖慢自托管的一环（§7）                                     |
| E9  | **Armadra 自己只调四类外部 API**：models.dev 目录、三家 Statuspage、三家用量端点、GitHub REST。其中 Claude 用量端点在 2026-02 后被 Anthropic 明文限制为 Claude Code 专用，默认改为**关闭并在设置页说明**  | 读 CLI 的 OAuth 令牌去调非官方端点与 Anthropic 2026-02 的使用政策冲突（§9.3）                                                                       |
| E10 | **遥测默认关、永不默认开**；崩溃上报只做「可选、自托管 GlitchTip（Sentry 协议）」，不接 Sentry SaaS；首版只上报 JS 错误，不上传 minidump                                                                  | minidump 带进程环境变量（可能含 API key）；GlitchTip 512 MB 内存可跑、MIT（§11）                                                                    |
| E11 | **密钥存放补齐三个后端**：macOS 钥匙串（已有）、Windows DPAPI（桌面壳经 Electron `safeStorage` 注入 core）、Linux libsecret（同上，`basic_text` 视为无钥匙串）；服务器壳用数据目录 0600 文件 + 主密钥封装 | `usage/secret-store.ts` 只有 macOS 用了系统凭据库；Electron 在 Linux 不认识的桌面环境下退回硬编码密钥的 `basic_text`，必须显式拒绝（§12）           |

## 1. 清单总表

「必需」指成品发布时必须有；「可选」指缺了就降级。「本地可验」指不需要任何账户就能在本机或 Docker 里把代码路径走通。

| #   | 服务 / 依赖                                   | 用途                             | 现状                                          | 必需 | 用户需提供                              | 本地可验                                   | 节    |
| --- | --------------------------------------------- | -------------------------------- | --------------------------------------------- | ---- | --------------------------------------- | ------------------------------------------ | ----- |
| S1  | Apple Developer Program（$99/年）             | Developer ID 签名、公证、APNs    | 流水线已接，缺证书                            | 必需 | 账户、Developer ID 证书、API key        | 自签名 + `codesign` 可验到 Gatekeeper 之前 | §2.1  |
| S2  | Windows Authenticode（Azure 或 CA）           | 安装包签名、SmartScreen / SAC    | 只接了 `.pfx` 路径                            | 必需 | Azure 订阅或 OV 证书                    | 自签名证书走完 signtool 路径               | §2.2  |
| S3  | GPG（Linux 包与 AppImage）                    | `.asc` 分离签名、apt / rpm 仓库  | 无                                            | 可选 | 一把签名专用 GPG 密钥                   | 全部本地                                   | §2.3  |
| S4  | minisign（已实现）                            | `latest.json` / `SHA256SUMS`     | `tools/release/minisign.mjs`                  | 必需 | `ARMADRA_RELEASE_SIGNING_KEY`           | 全部本地（`dry-run.mjs` 自造）             | §2.4  |
| S5  | GitHub Releases                               | 唯一发布来源、更新源             | 已实现                                        | 必需 | 仓库权限                                | `mock-release-server.mjs`                  | §3    |
| S6  | Cloudflare R2 + `armadra.dev`                 | 更新镜像 / CDN                   | `electron-builder.yml` 占位                   | 可选 | 域名、Cloudflare 账户                   | 不需要（本地静态目录等价）                 | §3.3  |
| S7  | Homebrew / winget / Scoop / AUR               | 包管理器安装                     | 无                                            | 可选 | tap / bucket 仓库、PR 权限              | 本地 `brew install --cask ./x.rb` 等       | §4    |
| S8  | Flathub / Snap Store                          | Linux 商店                       | 无                                            | 可选 | 账户                                    | `flatpak-builder` 本地                     | §4.3  |
| S9  | GHCR                                          | 服务器壳容器镜像                 | 无 Dockerfile                                 | 可选 | 无（随仓库）                            | `docker build` 本地                        | §4.4  |
| S10 | App Store / TestFlight、Google Play           | 手机原生壳分发                   | 无原生壳                                      | 可选 | Apple $99/年、Google $25 一次、身份验证 | 模拟器 + 本地构建                          | §5.1  |
| S11 | APNs / FCM / Web Push（VAPID）                | 手机推送                         | 无                                            | 可选 | APNs .p8、Firebase 服务账号             | Web Push 全本地；APNs / FCM 用假端点       | §5.2  |
| S12 | 通用链接（AASA / assetlinks）                 | `https://armadra.dev/…` 直开 App | 无                                            | 可选 | 域名、Team ID、签名指纹                 | 自定义 scheme 全本地                       | §5.3  |
| S13 | ACME / Let's Encrypt                          | 服务器壳公网证书                 | 只有自签名与运维给证书                        | 可选 | 公网域名或公网 IP                       | Pebble / step-ca 容器                      | §6.3  |
| S14 | Tailscale / Headscale / WireGuard / CF Tunnel | 手机离网访问                     | 无（文档层）                                  | 可选 | 各自账户或一台 VPS                      | Headscale 容器                             | §6.2  |
| S15 | WebAuthn（passkey）                           | 服务器壳无口令登录               | 501                                           | 可选 | 一个域名（RP ID）                       | `localhost` 可验                           | §7.2  |
| S16 | OIDC（GitHub / Google / Microsoft / 自托管）  | 账号绑定、SSO                    | 501                                           | 可选 | 各家 OAuth 应用                         | dex / Keycloak 容器                        | §7.1  |
| S17 | HIBP Pwned Passwords                          | 弱口令拦截                       | 无                                            | 可选 | 无（免费、无密钥）                      | 本地 fixture                               | §7.4  |
| S18 | SMTP（可选）                                  | 邀请 / 重置通知                  | 无                                            | 可选 | SMTP 账号                               | Mailpit 容器                               | §7.5  |
| S19 | models.dev                                    | 模型目录与价格                   | `core/models/catalog.ts`                      | 可选 | 无                                      | 内置表 + 缓存                              | §9.1  |
| S20 | Statuspage（Anthropic / OpenAI / GitHub）     | Provider 状态徽标                | `core/usage/status.ts`                        | 可选 | 无                                      | `ARMADRA_STATUS_PAGE_BASE` fixture         | §9.2  |
| S21 | Claude / Codex / Copilot 用量端点             | 额度窗口                         | `core/usage/providers.ts`、`copilot-login.ts` | 可选 | 各 CLI 已登录                           | fixture                                    | §9.3  |
| S22 | `ama` 的模型供应商（13 家 + 自定义）          | 协调 Agent 调模型                | 未接入                                        | 可选 | 任一供应商 API key                      | 脚本化假供应商                             | §9.4  |
| S23 | GitHub REST / GHES                            | Git 工具窗口                     | `core/github/*`                               | 可选 | PAT 或 `gh` 登录                        | `github/fixture.ts`                        | §10   |
| S24 | GitLab / Gitea / Forgejo                      | 同上，其他托管                   | 无                                            | 可选 | PAT                                     | Gitea 容器                                 | §10.2 |
| S25 | GlitchTip（自托管）                           | 可选崩溃上报                     | 无                                            | 可选 | 一台机器                                | 容器                                       | §11   |
| S26 | OS 凭据库（钥匙串 / DPAPI / libsecret）       | 存令牌与 API key                 | 只有 macOS                                    | 必需 | 无                                      | `ARMADRA_SECRET_BACKEND=file`              | §12   |

## 2. 代码签名与公证

### 2.1 macOS：Developer ID + notarytool

**现状**。`apps/desktop/scripts/signing-electron.mjs` 在构建前决定 sign / skip / refuse；`release.yml` 先把 `APPLE_CERTIFICATE_P12_BASE64` 导进临时钥匙串做预检，再交给 electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD`；公证用 `xcrun notarytool store-credentials --validate` 预检 `APPLE_ID` / `APPLE_TEAM_ID` / `APPLE_APP_SPECIFIC_PASSWORD`。缺任何一半就跳过并 `::warning::`，不阻断发布。`main/updates/environment.ts::signatureState` 以 `_CodeSignature/CodeResources` 是否存在判定「signed」。

**事实（2026）**。

- Developer ID 证书有效 5 年；旧的 Developer ID Sub-CA 于 **2027-02-01 到期**，之后必须用 G2 链签发的证书。生成新证书时在 Apple Developer 后台选 G2。（[Apple Developer ID 支持页](https://developer.apple.com/support/developer-id)、[Apple News 2026-10-01](https://developer.apple.com/news/?id=w4atic4c)）
- 公证不另收费，但必须是付费会员；免费 Apple ID 不能公证。（[Apple 论坛 DTS 回复](https://developer.apple.com/forums/thread/127467)）
- notarytool 三种凭据：`--key/--key-id/--issuer`（App Store Connect API key）、`--apple-id/--password/--team-id`、钥匙串 profile；交互式 `store-credentials` 的提示语自己写着「推荐 API key」。API key 的 `.p8` **只能下载一次**。（[notarytool(1)](https://keith.github.io/xcode-man-pages/notarytool.1.html)）
- Homebrew 官方 cask 自 2026-09-01 起**要求签名且公证**，否则禁用。（[Homebrew Acceptable Casks](https://docs.brew.sh/Acceptable-Casks)）
- macOS 15 起不能右键「打开」绕过 Gatekeeper，只能到「隐私与安全性」里点「仍要打开」；macOS 26 没有再收紧。（[Apple 支持 102445](https://support.apple.com/en-us/102445)）

**推荐**。

1. 公证凭据改为 **App Store Connect API key**：新增 secret `APPLE_API_KEY_P8_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER_ID`。electron-builder 认 `APPLE_API_KEY`（文件路径）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER` 三个环境变量；`release.yml` 的预检步骤把 base64 解到 `$RUNNER_TEMP/AuthKey.p8`，`notarytool store-credentials --key … --validate` 预检后写进 `GITHUB_ENV`。`signing-electron.mjs::signingPlan` 的 `notarizeFields` 改为「API key 三件套**或** Apple ID 三件套，任一完整即可，两套都残缺才 refuse」。注意 app-builder-lib 只要看到 `APPLE_ID` 就走 Apple ID 分支，所以两套都给时**只把一套写进环境**。
2. 证书选 `Developer ID Application`（G2 链）；`.p12` 口令继续走 `APPLE_CERTIFICATE_PASSWORD`。`APPLE_CERTIFICATE` / `APPLE_PASSWORD` 这两个旧名 `release.yml` 已经兼容，可以保留一个版本后删除。
3. `signatureState` 现在只看文件存在；发布包加一条 `codesign --verify --deep --strict` 的构建后断言（在 `after-pack.mjs` 之后、上传之前），避免「有 `_CodeSignature` 但 Gatekeeper 不认」的包流出去。

**本地可验**。`dist` 不给证书得到未签名包（现状）；给一张自签的 `codesign` 身份能走完签名步骤与 `codesign --verify`，Gatekeeper 评估（`spctl --assess`）只有真证书 + 公证才过。公证的 CI 预检 `--validate` 会真去问 Apple，本地没有等价物。

**密钥位置**。GitHub Actions secrets：`APPLE_CERTIFICATE_P12_BASE64`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`（可空）、`APPLE_TEAM_ID`、新 `APPLE_API_KEY_P8_BASE64` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER_ID`，回退 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`。本机不存。

**未配置时**。与现状相同：未签名包、`::warning::`、Release 说明顶部列「macOS 未公证」、更新器 `notConfigured`。

### 2.2 Windows：Authenticode

**现状**。`release.yml` 把 `WINDOWS_CERT_BASE64` / `WINDOWS_CERT_PASSWORD` 填进 `CSC_LINK` / `CSC_KEY_PASSWORD`；`environment.ts` 对 Windows 的 `signatureState` 固定返回 `unknown`，更新器据此拒绝自动更新（设计原则：先签名再开自动更新）。`after-pack.mjs` 用 `csc.exe` 编的 `armadra-hook.exe` 启动器随包一起进签名步骤，未用真证书确认（[功能预期总表 §4](../status/feature-roadmap.md)）。

**事实（2026）**。

- 2023-06-01 起 CA/B Forum 要求 OV 与 EV 的私钥都存在 FIPS 140-2 L2 硬件或云 HSM 里，**可导出的 `.pfx` 证书不再签发**；2026-03 起最长有效期 460 天。（[SSL Dragon 对比](https://www.ssldragon.com/blog/code-signing-certificate-providers/)、[Hendrik Erz：GitHub Actions 上的 Azure Trusted Signing](https://hendrik-erz.de/post/code-signing-with-azure-trusted-signing-on-github-actions)）
- EV 自 2024 起不再立即获得 SmartScreen 信誉；OV 与 EV 都靠下载量累积信誉。EV 只在内核驱动签名时必需。（同上）
- **Azure Artifact Signing**（原 Trusted Signing）：Basic $9.99/月（5,000 签名）、Premium $99.99/月；证书每日轮换、24 小时有效、带时间戳。**个人开发者仅限美国与加拿大**；组织限美、加、欧盟、英、澳、新、日、韩、新加坡、瑞士、挪威、以色列，需要 3 年以上可核验的税务记录。（[Azure Artifact Signing 快速入门](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[Microsoft 代码签名选项](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)）
- electron-builder 26 原生支持 `win.azureSignOptions`（`endpoint`、`codeSigningAccountName`、`certificateProfileName`、`publisherName`），凭据走 `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`；两个已知坑：产物名有空格会断（本仓 `nsis.artifactName` 已经改成无空格的 `${productName} Setup ${version}-${arch}.${ext}`，**仍有空格**，要改成 `Armadra-Setup-…`）；配置块一出现就走签名路径，不检查凭据，所以要像 `signingPlan` 一样只在 secret 存在时合并进去。时间戳要显式加 `TimestampRfc3161: http://timestamp.acs.microsoft.com`、`TimestampDigest: SHA256`。（[electron-builder #8626](https://github.com/electron-userland/electron-builder/issues/8626)、[#8828](https://github.com/electron-userland/electron-builder/issues/8828)）
- CA 的 OV 证书：SSL.com OV $129/年起（USB 令牌或其 eSigner 云签名），Sectigo OV 经分销约 $219/年、EV 约 $280–400/年，令牌通常含在价格里或另加 $50–130。（[SSL.com OV](https://www.ssl.com/products/software-integrity/code-signing/ov/)、[Sectigo 2026 指南](https://sslinsights.com/sectigo-code-signing-certificate-guide/)）
- Windows 11 24H2 / 25H2 的 Smart App Control 对未签名程序**直接阻止、无「仍要运行」**；2026-03 起可以关掉再开。（[Microsoft SAC FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)）

**推荐**。

| 用户情况                                  | 方案                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 美 / 加个人，或所列国家的组织（3 年税务） | Azure Artifact Signing Basic。secrets：`AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`（或 OIDC 联合凭据，免 secret，需自写 sign hook）；repo variables：`AZURE_SIGNING_ENDPOINT`、`AZURE_SIGNING_ACCOUNT`、`AZURE_SIGNING_PROFILE`                                                      |
| 其他地区（含中国）                        | CA 的 OV 证书。两种接法：(a) CA 的云签名（SSL.com eSigner 等，走 `win.signtoolOptions.sign` 自定义 hook，凭据进 secrets `WINDOWS_CLOUD_SIGN_*`）；(b) USB 令牌插在一台**自托管 Windows runner** 上，`release.yml` 的 Windows 两行改 `runs-on: [self-hosted, windows, signing]`。价格以各 CA 当期为准 |
| 暂不签名                                  | 现状：SmartScreen 提示、SAC 机器直接拒绝；更新器 `unknown` → 不自动更新。Release 说明顶部已标注                                                                                                                                                                                                      |

无论哪条路，`environment.ts::signatureState` 的 Windows 分支要落实：读取 `process.execPath` 的 Authenticode 状态（`Get-AuthenticodeSignature` 子进程，或 `@electron/windows-sign` 的 verify），`Valid` 才报 `signed`。electron-updater 在 Windows 比的是 `publisherName` 与证书 CN，`win.publisherName` 必须与证书主体一致，否则换证书后更新会被拒。

**本地可验**。`New-SelfSignedCertificate -Type CodeSigningCert` 出一张自签证书 + `signtool`，能走完 `CSC_LINK` 路径与 `Get-AuthenticodeSignature`（状态 `UnknownError`，证明链路通、信任不通）；Azure 路径本地无等价物，但 `azureSignOptions` 的合并逻辑可以在 `signing-electron.test.mjs` 里断言。

### 2.3 Linux：AppImage / deb / rpm

**现状**。无签名。`signatureState` 对 Linux 报 `notApplicable`，信任来自 sha512 + Host 公布的 sha256。

**事实**。AppImage 规范支持内嵌 GPG 签名（`appimagetool --sign`），但**运行时不校验**，所以 Electrum、Cryptomator 等都另发 `.asc` 分离签名让用户 `gpg --verify`；electron-builder 的 AppImage target 没有一等签名选项。apt 校验的是仓库元数据（`InRelease`），rpm 校验的是包自身签名（`rpmsign --addsign`）。（[AppImage 签名文档](https://docs.appimage.org/packaging-guide/optional/signatures.html)、[packagecloud：reprepro](https://blog.packagecloud.io/how-to-create-debian-repository-with-reprepro/)、[rpmsign(1)](https://rpm.org/docs/6.1.x/man/rpmsign.1)）

**推荐**。一把**签名专用**的 GPG 密钥（新 secret `ARMADRA_LINUX_GPG_KEY`（armored 私钥）、`ARMADRA_LINUX_GPG_PASSPHRASE`），`assemble` 作业里：`.AppImage`、`.deb`、`.rpm` 各出一个 `.asc`；`.rpm` 另 `rpmsign --addsign`；公钥 `armadra-linux.gpg` 作为 Release 资产与 `apps/web/public/` 的静态文件一起发布。apt / rpm 仓库（GitHub Pages 托管 `InRelease` + `repodata`）放在 §4.3 的可选工作包里。`latest.json` 与 `SHA256SUMS` 继续用 minisign（§2.4），GPG 只给人和包管理器看。

**本地可验**。全部本地：`gpg --quick-gen-key`、`gpg --detach-sign --armor`、`gpg --verify`、`rpm -K`。

### 2.4 更新清单签名：minisign 与 electron-builder 27

**现状**。`tools/release/minisign.mjs` 用 Node 自带 Ed25519 实现 minisign legacy `Ed` 格式；`sign.mjs` 从 `ARMADRA_RELEASE_SIGNING_KEY`（base64 的 8 字节 key id + 32 字节 seed）读密钥，给所有可发布文件与 `SHA256SUMS` 出 `.sig`；`updater-manifest.mjs` 把每个平台更新包的整段 `.sig` 写进 `latest.json`。桌面壳里**没有** minisign 公钥（`updater.ts:481`），所以 `offer.ts` 的 key id 比较无事可做，信任来自平台代码签名 + Host 列出的 sha256。

**事实**。electron-builder 的下一主版本（v27，文档标「next」）引入 **signed update manifests**：发布时用一把或多把 Ed25519 私钥签 `latest*.yml`（`updateManifest.signingKey` / `signingKeyFile` 或 `ELECTRON_BUILDER_UPDATE_SIGN_KEY`），公钥在构建时嵌进应用，electron-updater 下载前先验签；嵌了公钥的安装遇到无签名或签名无效的清单**直接失败**（`ERR_UPDATER_MANIFEST_NOT_SIGNED` / `ERR_UPDATER_MANIFEST_SIGNATURE_INVALID`）；轮换时双签，无需桥接版本。（[electron.build：Signed Update Manifests](https://www.electron.build/docs/features/signed-update-manifests/)）

**推荐**。短期保留 minisign（它签的是 `SHA256SUMS` 与 `latest.json`，是运维和 Host `upgrade` 的真相）；electron-builder 27 稳定后在 `electron-builder.yml` 加 `updateManifest.publicKey`，CI 用 `ELECTRON_BUILDER_UPDATE_SIGN_KEY` 签 `latest*.yml`。两把 Ed25519 密钥各管各的文件，不要复用同一个 seed。

## 3. 更新托管与通道

### 3.1 来源与带宽

- GitHub Releases：单个资产 < 2 GiB、每个 Release ≤ 1000 个资产、**总大小与带宽无限制**；浏览器上传上限 25 MB，所以 CI 用 `gh release`（已是）。未认证的 API 调用 60 次 / 小时，2025-05 起 GitHub 收紧了匿名请求限额；直链下载（`release-assets.githubusercontent.com`）在部分网络上有**单连接限速**，大包要支持断点 / 多连接。（[GitHub Docs：About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[GitHub Changelog 2025-05-08](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)、[omlx #4199](https://github.com/jundot/omlx/issues/4199)）
- 更新检查走 `GET /repos/{owner}/{repo}/releases`（Host 侧），匿名 60 次 / 小时按 IP 计——一个 NAT 后的办公室里几十台机器同时每小时检查就会撞上限。**检查间隔不低于 6 小时**，并支持 `ETag` / `If-None-Match`（304 不计入限额）。

### 3.2 electron-updater 的清单缺口（W-UPD）

`updater.ts::transferBytes` 把 `autoUpdater.setFeedURL({ provider: "generic", url: <latest.json 所在目录> })` 后调用 `checkForUpdates()`，electron-updater 会在那个目录取 `latest-mac.yml` / `latest.yml` / `latest-linux.yml`；而 `stage-desktop.mjs::isReleaseAsset` 明文把 `*.yml` 排除出发布资产（注释写着「本发布不发它」）。`offer.ts::MANIFEST_NAMES` 虽然列了四个名字，但真 Release 上只会有 `latest.json`，于是下载一步在真实环境里会 404。`mock-release-server.mjs` 没有覆盖这一点（它只造 `.sig` 与 `digest`）。要做的事：

1. `stage-desktop.mjs` 把 electron-builder 产出的 `latest*.yml` 一并暂存，并把其中 `files[].url` / `path` 改写成 `artifacts.mjs` 规定的发布名（electron-builder 27 起 `sha512` 必须 base64，现版本 hex 仍可用但已弃用）；
2. `assemble.mjs` 校验 yml 里的 sha512 与 `SHA256SUMS` 指向同一份字节；
3. `mock-release-server.mjs` 与 `dry-run.mjs` 覆盖「yml 存在、名字改写正确、electron-updater 真能下载」；
4. 做完 §2.4 的 Ed25519 清单签名后，yml 本身也被验签。

### 3.3 镜像：`armadra.dev/updates`

**何时需要**：中国大陆直连 GitHub 不稳定，或要做灰度。**方案**：Cloudflare R2（10 GB 存储、Class B 操作 1000 万次 / 月免费，**出站永久免费**）挂在 `updates.armadra.dev` 自定义域名后，`assemble` 之后加一个 `mirror` 作业 `rclone copy` 到桶；`ARMADRA_UPDATER_ENDPOINTS` 已支持逗号分隔多个端点，桌面壳按顺序尝试。（[Cloudflare R2 定价 2026](https://mecanik.dev/en/posts/cloudflare-r2-pricing-explained-real-costs-vs-s3-and-backblaze/)）
**用户需提供**：注册 `armadra.dev`（或任何域名）、Cloudflare 账户；secrets `CLOUDFLARE_R2_ACCESS_KEY_ID`、`CLOUDFLARE_R2_SECRET_ACCESS_KEY`、变量 `CLOUDFLARE_R2_BUCKET`、`CLOUDFLARE_ACCOUNT_ID`。
**未配置时**：`mirror` 作业跳过，端点只有 GitHub。

### 3.4 通道与灰度

[更新设计 §1.1](updates-and-service-install.md) 已定 `stable` / `beta` / `development` 三通道，按标签里有没有 `-` 判 prerelease。补两点：

- `settings.updates.channel` 落到 core 的 settings 域（设计 §3 列过，未实施），桌面壳检查时把 `allowPrerelease` 传给 Host 侧的筛选；
- 灰度用 `latest.json` 的新字段 `rollout: { percent, seed }`（与 electron-updater 的 `stagingPercentage` 同义），客户端用安装 id 的哈希落在百分比内才接受。不需要任何外部服务。

## 4. 分发渠道

### 4.1 Homebrew cask（macOS）

官方 `homebrew/cask` 要求签名 + 公证（§2.1），且有「知名度」门槛（社区口径约 ≥ 225 stars / 90 forks，官方不公布数字）。**先建自家 tap** `Owlbay/homebrew-tap`：`release.yml` 的 `assemble` 之后加 `publish-tap` 作业，用 `HOMEBREW_TAP_TOKEN`（细粒度 PAT，只对 tap 仓库 `contents: write`）推一条 `Casks/armadra.rb`（`sha256` 来自 `SHA256SUMS`，`livecheck` 指向 GitHub Releases）。达到门槛后向官方提 PR。（[Homebrew Acceptable Casks](https://docs.brew.sh/Acceptable-Casks)、[ksail #5150](https://github.com/devantler-tech/ksail/issues/5150)）
**本地可验**：`brew install --cask ./Casks/armadra.rb` + `brew audit --cask`。
**未配置时**：作业跳过。

### 4.2 winget 与 Scoop（Windows）

- **winget**：社区仓库 `microsoft/winget-pkgs` **不要求代码签名**，靠 schema 校验 + URL 安全 + Defender 扫描；首次提交人工审（数天），之后 `wingetcreate update` 自动 PR。安装器必须支持静默安装（NSIS 的 `/S` 已满足）。secret `WINGET_TOKEN`（对 fork 仓库 `contents: write` + `pull_requests: write` 的细粒度 PAT）。（[winget-pkgs 文档](https://github.com/microsoft/winget-pkgs/blob/master/doc/README.md)、[wingetcreate](https://github.com/microsoft/winget-create)）
- **Scoop**：自家 bucket `Owlbay/scoop-bucket`，manifest 用便携 zip（本仓已有 Windows zip 产物）、`checkver: github`、`autoupdate` 从 `SHA256SUMS` 取哈希；官方 `Extras` 门槛约 100 stars。（[Scoop Autoupdate wiki](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifest-Autoupdate)）
  **本地可验**：`winget validate --manifest`、`scoop install ./bucket/armadra.json`。

### 4.3 Linux：AUR、apt / rpm 仓库、Flathub、Snap

| 渠道           | 要求                                                                                                                                                                    | 推荐                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| AUR            | 预编译包必须叫 `armadra-bin`；社区可以自己维护，不需要我们的密钥                                                                                                        | 发布 `.deb` 之外附一份 `PKGBUILD` 模板在 `tools/release/templates/`，不自己维护 AUR                                                 |
| apt / rpm 仓库 | `InRelease` 用 §2.3 的 GPG 签；静态目录可托管在 GitHub Pages 或 R2                                                                                                      | 可选工作包 W-LINUX-REPO：`aptly` 或 `apt-ftparchive` + `createrepo_c`，用户 `deb [signed-by=…] https://pkg.armadra.dev stable main` |
| Flathub        | 只接受从 manifest 构建（不收预编译）、ID 需 `io.github.owlbay.Armadra` 形式、MetaInfo 过 linter、沙箱权限要逐项说明；Electron 要基于 `org.electronjs.Electron2.BaseApp` | 延后：终端 + PTY + 任意 CLI 需要 `--talk-name` / `--filesystem=host` 一类宽权限，审核难过                                           |
| Snap           | `core24`、strict 限制下需要 `browser-support` 等接口；classic 要人工审                                                                                                  | 延后，同上                                                                                                                          |

（[Flathub Requirements](https://docs.flathub.org/docs/for-app-authors/requirements)、[Flatpak：Electron](https://docs.flatpak.org/en/latest/electron.html)、[electron-builder snap](https://www.electron.build/docs/snap/)、[ArchWiki Electron 打包指南](https://wiki.archlinux.org/title/Electron_package_guidelines)）

### 4.4 服务器壳容器镜像（GHCR）

**事实**。GHCR 公共镜像存储与带宽「目前免费」，GitHub 承诺改政策前至少提前一个月通知；无拉取限额。（[GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)）
**方案**。新增 `apps/server/Dockerfile`（`node:22-bookworm-slim`，安装 `tmux`、`git`、`openssh-client`；headless 浏览器节点用 `chromedp/headless-shell:stable` 作第二阶段的 `COPY --from`，或文档化 `ARMADRA_BROWSER_PATH` 指向宿主 Chromium），`release.yml` 加 `image` 作业用 `docker/build-push-action` 推 `ghcr.io/owlbay/armadra-server:<version>` 与 `:latest`，凭据是 `GITHUB_TOKEN`（`packages: write`），**不需要新 secret**。`tools/dev-stack/` 的 compose 直接 `build: ../../apps/server`。
**未配置时**：无；镜像作业只在非 dry-run 的发布里跑。

### 4.5 手机商店

见 §5.1。

## 5. 手机：原生壳、推送、深链、配对

### 5.1 原生壳与商店

**现状**。只有响应式网页（焦点页、底部导航、软键盘工具条）；无原生安装包、无推送（[客户端平台](../guides/client-platforms.md)、[功能预期总表 §4](../status/feature-roadmap.md)）。

**壳的选择**。Capacitor 包同一份 `apps/web` 产物（**打进包里**，不是远程 URL），终端仍由 xterm.js 渲染；原生只补五件事：钥匙串存配对令牌、QR 扫码、推送注册、通用链接、后台保活策略。React Native 要重写前端，排除。（[Capacitor vs React Native 2026](https://www.bacancytechnology.com/blog/capacitor-vs-react-native)）

**审核风险**。App Store 4.2「最低功能」会拒绝「只是一个网站」的 WKWebView 壳；4.2.7（远程桌面客户端）要求「镜像特定软件」的 App 只连局域网、不做云端瘦客户端。Armadra 的手机壳要定位成**通用的自托管 Armadra 客户端**（像 Termius / Blink 这类 SSH 客户端那样是「连接你自己的服务器」的工具），不内置任何由我们托管的服务，不在 App 里卖东西；审核账号用一台公网可达的演示服务器壳。Web 层 OTA 更新（Capgo 之类）受 DPLA §3.3.1(B) 允许，但本项目**不做 OTA**——版本与服务器壳同步发布就够。（[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[Mobiloud：webview 审核](https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper/)）

**费用与流程（2026）**。

| 平台    | 账户                                                                                            | 测试分发                                                                                    | 上架前置                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| iOS     | Apple Developer Program $99/年（与 §2.1 同一个账户）                                            | TestFlight：内部 100 人免审，外部 10,000 人、每版首个构建要 Beta App Review，构建 90 天过期 | App Store 审核；需要隐私清单、演示服务器                                                                |
| Android | Google Play $25 一次；2023-11 后的个人账户每个新 App 要 **12 名测试者封闭测试 14 天**才能上生产 | 内部测试 100 人即时；封闭测试每列表 2,000 人                                                | 2026-09-30 起巴西 / 印尼 / 新加坡 / 泰国要求**开发者身份验证**（含侧载），2027 全球；组织账户要 D-U-N-S |

（[Apple Developer Program](https://developer.apple.com/programs)、[TestFlight 限制 2026](https://ptkd.com/journal/testflight-external-tester-limit-2026)、[Google Play 开发者验证](https://support.google.com/googleplay/android-developer/answer/16471116)、[Google Play 账户指南 2026](https://www.testerscommunity.com/blog/google-play-developer-account-guide)）

**CI**。iOS 构建需要 macOS runner（已有）、分发证书与 provisioning profile（新 secrets `IOS_DISTRIBUTION_P12_BASE64`、`IOS_DISTRIBUTION_PASSWORD`、`IOS_PROVISIONING_PROFILE_BASE64`，上传用 §2.1 的同一把 App Store Connect API key）；Android 需要上传密钥（`ANDROID_UPLOAD_KEYSTORE_BASE64`、`ANDROID_UPLOAD_KEYSTORE_PASSWORD`、`ANDROID_UPLOAD_KEY_ALIAS`）与 Play 服务账号 JSON（`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`）。不用 EAS / Capgo 一类托管构建（免费档 15 次 / 月不够，且不需要）。

**本地可验**。iOS 模拟器与 Android 模拟器上装本地构建、对着本机服务器壳配对；`tools/probes/` 加一条「手机壳冒烟」用模拟器跑配对 → 终端 → 推送注册（假端点）。

**未配置时**。没有手机壳，网页端照旧。

### 5.2 推送

**约束**。iOS 的后台唤醒只能经 APNs，持有 App 签名凭据的一方才能发；自托管 ntfy 想推到 iPhone 也必须把「有新消息」的事件经 ntfy.sh → FCM → APNs 中转，只是正文留在自己服务器上；UnifiedPush 没有 iOS 实现。（[ntfy #1680](https://github.com/binwiederhier/ntfy/issues/1680)、[SSD Nodes：自托管 ntfy](https://www.ssdnodes.com/learn/self-host-ntfy-push-notifications)）

**分期**。

| 期   | 通道                                                                                                                            | 第三方          | 用户需提供                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| 1    | **Web Push（VAPID，RFC 8292）**，服务器壳直接向浏览器厂商的推送端点发；Android Chrome 与 iOS 16.4+「添加到主屏幕」的 PWA 都支持 | 无（厂商端点）  | 无。VAPID 密钥对由服务器壳首次启动生成到 `<数据目录>/push/vapid.json`（0600）                                  |
| 2    | **APNs token（.p8）** 直连 `api.push.apple.com`；**FCM HTTP v1** 用 Firebase 服务账号换短期 OAuth 令牌直连 `fcm.googleapis.com` | Apple、Google   | APNs：`.p8` + Key ID + Team ID（一把 key 全团队 App 共用、不过期）；FCM：Firebase 项目 + 服务账号 JSON（免费） |
| 可选 | Android 的 UnifiedPush（ntfy 作分发器）：服务器壳向用户自己的 ntfy 实例 POST                                                    | 用户自己的 ntfy | ntfy 地址                                                                                                      |

（[Pushpad：iOS Web Push 要求](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications)、[Firebase FCM REST](https://firebase.google.com/docs/reference/fcm/rest)、[OneSignal：APNs .p8](https://documentation.onesignal.com/docs/en/ios-p8-token-based-connection-to-apns)）

**配置键（服务器壳，新）**：`ARMADRA_PUSH_APNS_KEY_FILE`、`ARMADRA_PUSH_APNS_KEY_ID`、`ARMADRA_PUSH_APNS_TEAM_ID`、`ARMADRA_PUSH_APNS_BUNDLE_ID`、`ARMADRA_PUSH_FCM_CREDENTIALS_FILE`、`ARMADRA_PUSH_UNIFIEDPUSH_URL`；运行时也可在「设置 → 后台服务 → 推送」里填，密钥经 SecretStore（§12）。**只传文件路径，不把 .p8 内容放进环境变量**。
**要推什么**：Agent `blocked`（等审批）、`done`、投递失败、调度到点、资源阈值——都是 core 已有的事件，推送只是 `core/events` 的一个新订阅者 `core/push/`。正文**不含终端原文与文件内容**（AGENTS.md 的 P0 规则）。
**本地可验**：Web Push 全本地（Chrome 对着本机服务器壳订阅；或 `web-push` 库的本地测试端点）；APNs / FCM 用 `ARMADRA_PUSH_APNS_ENDPOINT` / `ARMADRA_PUSH_FCM_ENDPOINT`（新，仅测试）指向 `tools/dev-stack/` 里的假端点，断言请求形状与 JWT 签名；Apple 的 APNs sandbox 要真机与真证书。
**未配置时**：推送页显示 `notConfigured`；事件照常进通知中心（桌面壳的 `main/notifications.ts` 不受影响）。

### 5.3 深链与通用链接

- `armadra://pair?host=…&ticket=…&fp=…` 自定义 scheme 不需要任何外部条件，桌面壳（Electron `setAsDefaultProtocolClient`）与手机壳都注册；
- 通用链接 `https://armadra.dev/pair/…` 需要在域名根或 `/.well-known/` 托管 `apple-app-site-association`（无扩展名、HTTPS、无重定向、≤ 128 KB）与 `assetlinks.json`（HTTPS、`application/json`、HTTP 200、SHA-256 指纹大写；用 Play App Signing 时指纹是 Google 的那把）。只在 §3.3 注册域名之后做。（[Apple：Supporting associated domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains)、[Android App Links](https://developer.android.com/training/app-links/configure-assetlinks)）

### 5.4 QR 配对与证书指纹

**现状**。`apps/web/src/host/qr.ts` 自写 QR 编码器（版本 ≤ 6，装得下 `https://192.168.1.20:8443` 这类地址）；服务器壳启动打印 `https://…/#pair=<两分钟一次性票>`。
**改动**。配对链接追加 `&fp=<sha256(证书 DER)>`：自签名证书时手机壳据此做**证书固定**（跳过系统信任，只信这一张，并把指纹存进钥匙串）；浏览器端做不到固定，只能显示指纹让人核对。QR 版本上限要提到 10（L 级 271 字节）。证书轮换时旧指纹失效 → 手机壳提示重新扫码，不自动信任新证书。

## 6. 网关连通与 TLS

### 6.1 局域网直连（现状）

服务器壳监听 + `--public-origin` + 自签名证书（`apps/server/src/tls.ts`，397 天，SAN 覆盖每个 origin 的主机）；桌面壳「对外服务」开关显示地址与二维码。浏览器要人工信任自签名证书，或用 mkcert 的本地 CA（iOS 要「安装描述文件」+「证书信任设置」里打开完全信任）。（[mkcert](https://github.com/filosottile/mkcert)）

### 6.2 离网访问：四条路，都是运维选择

| 方案              | 费用（2026）                                                                | 适合                                             | Armadra 侧要做的事                                                                  |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Tailscale         | Personal 免费（6 用户、非商用）；Standard $8 / 用户 / 月起                  | 个人与小团队，零配置                             | 文档：`--listen <tailscale IP>:8443 --public-origin https://<magicdns 名>`          |
| Headscale         | 自托管、BSD-3，官方 Tailscale 客户端 `--login-server`                       | 不想把控制面交给第三方                           | 同上                                                                                |
| WireGuard         | 自建；官方手机客户端免费                                                    | 有公网 UDP 端口或一台 VPS                        | 同上                                                                                |
| Cloudflare Tunnel | 免费、无带宽上限；Access 50 用户内免费；**请求体上限 100 MB**（Free / Pro） | 只有 HTTP(S) + WebSocket、没有公网 IP 的家用网络 | 文档 + `--public-origin https://armadra.example.com`；大文件上传走分块（core 已有） |
| 自托管反向隧道    | frp / rathole / wstunnel + $3–6 / 月的 VPS                                  | 全部自持                                         | 文档                                                                                |

（[Tailscale 定价 2026](https://wz-it.com/en/blog/tailscale-pricing-2026-headscale-netbird-self-hosted/)、[Headscale](https://github.com/juanfont/headscale)、[Cloudflare Tunnel 限制](https://tech-insider.org/cloudflare-tunnel-setup-2026-homelab/)、[awesome-tunneling](https://github.com/anderspitman/awesome-tunneling)）

**不做**：自建 `armadra-relay` 中继服务（要我们运营基础设施，与本地优先相悖）；WebRTC + coturn（终端与事件流是一条 WSS 就够的低带宽流，打洞没有收益；画面流也走同一条 WSS）。coturn 留在 `research/` 作参考。

### 6.3 公网证书：ACME 内建

**事实（2026）**。Let's Encrypt 2026-01-15 起 **6 天短期证书与 IP 地址证书**正式可用：IP 证书只能走 `shortlived` profile（160 小时），仅 `http-01` / `tls-alpn-01`；默认证书寿命也在逐步缩短（45 天 profile 开始试点）；续期不计入限额。certbot 2026-03 起支持。（[Let's Encrypt 公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)）

**方案**。服务器壳新增 `--acme <email>`（配置键 `ARMADRA_ACME_EMAIL`，可选 `ARMADRA_ACME_DIRECTORY` 覆盖目录地址、`ARMADRA_ACME_PROFILE=shortlived|classic`）：用 `acme-client`（Node，MIT）在 80 端口做 `http-01`（或 443 的 `tls-alpn-01`，不用额外端口），证书与账户密钥写 `<数据目录>/tls/acme/`（0600），到期前三分之一自动续；`status` 报告来源「ACME」与到期时间；续期失败连续 3 次发通知但**继续用旧证书直到过期**。`--tls-cert/--tls-key`（运维给的）与 ACME 互斥。
**用户需提供**：一个解析到服务器的域名（或公网 IP），80/443 可达。
**本地可验**：`tools/dev-stack/` 里跑 [Pebble](https://github.com/letsencrypt/pebble)（Let's Encrypt 官方测试 ACME 服务器）或 `smallstep/step-ca`（`DOCKER_STEPCA_INIT_ACME=true`），`ARMADRA_ACME_DIRECTORY` 指过去，`ARMADRA_ACME_CA_BUNDLE` 信任其根。（[step-ca ACME](https://smallstep.com/docs/tutorials/acme-protocol-acme-clients/)）
**未配置时**：现状——自签名，`status` 标「自签名」。

### 6.4 局域网证书：本地 CA 与固定

不内建 CA。文档化 mkcert / step-ca 两条路；手机壳走 §5.4 的指纹固定，所以**手机不需要装根证书**。

## 7. 认证

### 7.1 OAuth / OIDC：一条代码路径

**现状**。`core/identity/accounts-http.ts` 对 `POST /api/identity/credentials/oauth/*` 返回 501；设计（[账号设计](server-accounts-and-sharing.md) S7）是「OAuth 只做绑定，不做账号来源」。

**事实（2026）**。

- GitHub：OAuth App 免费；设备流必须在应用设置里手动启用；只要 `read:user` 就够绑定。（[GitHub：Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)）
- Google：只请求 `openid email profile` 不触发「未验证应用」警告、不需要审核、不受 100 用户上限；测试模式下授权 7 天过期。（[Google：Unverified apps](https://support.google.com/cloud/answer/7454865)）
- Microsoft Entra：多租户应用若只要基本登录（`User.Read`）不需要发布者验证；超出就要 Partner Center 账户与域名验证。（[Microsoft：Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)）
- 自托管：Keycloak、Authentik、dex、Zitadel 都是标准 OIDC。

**方案**。`core/identity/oidc.ts`：一个**通用 OIDC 授权码 + PKCE** 实现（发现文档 `/.well-known/openid-configuration`、`state` / `nonce`、`id_token` 验签），GitHub 用它的非 OIDC 变体（`/login/oauth/authorize` + `GET /user`）作唯一特例。提供商表存在 `identity_oauth_providers`（新迁移 `0030`，编号以实施时为准）：`{ id, kind: 'oidc'|'github', issuer, clientId, scopes, enabled }`，`clientSecret` 进 SecretStore（`armadra-oidc-<id>`）。回调地址固定 `https://<public-origin>/api/identity/oauth/<id>/callback`，所以**必须先有 `--public-origin`**。绑定成功写 `identity_credentials(kind='oauth', provider, subject)`；登录用「口令或 passkey」之后才能绑，绑定后可用 OAuth 登录已存在的 principal，**不开放注册**（`allow_registration` 仍是 501）。
**用户需提供**：每家一个 OAuth 应用的 client id / secret（GitHub：Settings → Developer settings；Google：Cloud Console 的 OAuth 同意屏幕 + 凭据；Microsoft：Entra 应用注册；Keycloak：客户端）。
**本地可验**：`tools/dev-stack/` 的 **dex**（`staticClients` + `staticPasswords`，完全离线）跑通整条授权码流程；Keycloak 作第二个 issuer 验证发现文档差异。`identity/oidc.test.ts` 用本机起的假 issuer（`node:http`）覆盖 state / nonce / 签名错误分支。
**未配置时**：设置页「账号与共享」的「绑定」区显示「未配置提供商」；接口返回 `{ code: "oauth_not_configured" }`（替换现在的 501）。

### 7.2 WebAuthn / passkey：RP ID 的硬约束

**事实**。RP ID 必须是域名（eTLD+1 或其子域），**不能是 IP 字面量**，`localhost` 是唯一的非 HTTPS 例外；改 RP ID 会让已登记的 passkey 全部失效。（[web.dev：RP ID deep dive](https://web.dev/articles/webauthn-rp-id)、[Nocturne #1194](https://github.com/nightscout/nocturne/pull/1194)）

**方案**。`@simplewebauthn/server`（v14，Node ≥ 22，MIT，周下载 330 万）；RP ID 取 `--public-origin` 的主机名；当主机是 IP 字面量时 `POST /api/identity/passkey/*` 返回 `{ code: "passkey_unavailable_on_ip_host", message: "passkey 需要域名；当前以 IP 访问" }`，设置页解释清楚而不是让浏览器抛 `SecurityError`。多个 `--public-origin` 时 RP ID 取它们的公共后缀，取不到就只对第一个启用并报出来。凭据存 `identity_credentials(kind='passkey', public_key, counter, transports)`。（[@simplewebauthn/server](https://www.npmjs.com/package/@simplewebauthn/server)）
**用户需提供**：一个域名（局域网也可以用 `armadra.home.arpa` 这种私有名 + 本地 CA）。
**本地可验**：`https://localhost:<port>` 完整可验（Chrome 虚拟认证器 / Playwright 的 `webauthn` CDP 域）。
**未配置时**：按 IP 访问 → 如实不可用；口令照旧。

### 7.3 TOTP

`otplib` v13（`@otplib/totp`，RFC 6238，noble 审计过的哈希实现，无原生依赖）；密钥 AES-GCM 封装后存 `identity_credentials(kind='totp')`，恢复码 10 个（scrypt 哈希）。无外部服务。（[otplib](https://github.com/yeojz/otplib)）

### 7.4 泄露口令检查（HIBP）

Pwned Passwords range API **免费、无需密钥、无限额**，k-匿名：只发 SHA-1 前 5 位，收回约 800 个后缀本地比对；加 `Add-Padding: true` 头抵抗流量分析。（[HIBP API v3](https://haveibeenpwned.com/api/v3)、[HIBP NIST 页面](https://haveibeenpwned.com/NIST)）
**方案**。`core/identity/passwords.ts` 设口令时调用（新设置键 `identity.passwords.breachCheck`，服务器壳默认开、桌面壳不涉及）；网络失败**不阻止**设口令，只记一条审计。测试用 `ARMADRA_HIBP_BASE`（新）指向 fixture。
**用户需提供**：无。

### 7.5 邮件：可选，不是前提

邀请、重置、通知都设计成**链接 / 一次性码**由管理员亲手交给人（已是现状：持邀请注册）。邮件只是一个可选通知通道：新配置 `ARMADRA_SMTP_URL`（`smtps://user:pass@host:465`，口令部分建议用 SecretStore 引用 `secret://smtp`）+ `ARMADRA_SMTP_FROM`，Node 自写 SMTP 客户端太重，用 `nodemailer`（MIT）。不接 Resend / Postmark / SES 的 API（它们只是 SMTP 的一种后端：Resend 免费 3,000 封 / 月、Postmark 免费 100 封 / 月、SES $0.10–0.16 / 千封，都给 SMTP 凭据）。（[2026 邮件 API 价格对比](https://www.buildmvpfast.com/api-costs/email)）
**本地可验**：Mailpit 容器（SMTP 1025、UI 8025、REST 断言收件）。（[Mailpit](https://mailpit.axllent.org/)）
**未配置时**：邀请页只显示链接与二维码，没有「发送邮件」按钮。

## 8. 实时协同基础设施

**不需要任何外部服务**。现状已经是：core 内存里的在线表与一把写租约（`core/canvas/presence.ts`，10 秒心跳）、按工作空间扇出的事件流、画布 CAS 保存、收权即断流（[架构 §5、§7](../guides/architecture.md)）。多人同写一块板是「单写者 + 接管」而不是 CRDT；若后续白板要做多光标并行编辑，Yjs 的文档与 awareness 都可以跑在 core 进程内（`y-websocket` 的 server 部分就是一个 `ws` 处理器，装配进现有的 WebSocket 面即可），仍然没有第三方。

## 9. AI / 模型提供商

### 9.1 models.dev 目录

**现状**。`core/models/catalog.ts` 每天抓一次 `https://models.dev/api.json`（约 4.6 MB，MIT，社区维护，OpenCode 同源），缓存 `<数据目录>/models-catalog.json`，失败用缓存或内置表；用户刷新 60 秒冷却。（[models.dev 仓库](https://github.com/anomalyco/models.dev)）
**补充**。`ama` 的供应商目录（文档 A 第五波）改为「随包携带 models.dev 快照 + 覆盖项」，运行时不联网；Armadra 侧两处读的是同一份数据，接入 `ama` 时让 `core/models` 把缓存路径交给 profile（`ARMADRA_AMA_BUNDLE` 同级新增 `modelsSnapshot`），避免两份目录各自更新。
**未配置时**（离线）：内置表，价格显示「未知」而不是 0。

### 9.2 Provider 状态页

**现状**。`core/usage/status.ts` 轮询三家 Atlassian Statuspage 的 `/api/v2/status.json`（公共 Status API **不限额**，但旧文档写过每 IP 1 请求 / 秒，保持 ≥ 60 秒间隔）；`ARMADRA_STATUS_PAGE_BASE` 可指向 fixture。**注意**：`status.anthropic.com` 现在 302 到 `status.claude.com`，fetch 必须跟随重定向（现实现用 `fetch` 默认跟随，保留一条测试钉住）。（[Atlassian：Statuspage 的两种 API](https://support.atlassian.com/statuspage/docs/what-are-the-different-apis-under-statuspage/)）

### 9.3 用量端点：政策风险

| 供应商  | 现状调用                                                                                    | 凭据来源                                      | 2026 政策                                                                                                                                                                                                                    | 处理                                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | `GET api.anthropic.com/api/oauth/usage`（`anthropic-beta: oauth-2025-04-20`）               | 读 Claude Code 的钥匙串 / `.credentials.json` | Anthropic 2026-02 更新使用政策：**消费者计划的 OAuth 令牌只允许 Claude Code 与 Claude.ai 使用**，其他产品用它调任何请求都违反条款；2026-01 起已有工具被封。该端点未公开文档，且需伪装 `User-Agent: claude-code/…` 才不被限流 | **默认关闭**。设置页「账号与用量」加开关「读取 Claude Code 的额度（使用其登录令牌调用未公开端点，可能违反 Anthropic 条款）」，默认关；替代方案：解析本地 JSONL 的 token 用量（`core/history/`）做本地统计，额度窗口显示 `unknown` |
| Codex   | `GET chatgpt.com/backend-api/wham/usage`                                                    | `$CODEX_HOME/auth.json`                       | 未公开端点，随时可变，可能返回 HTML 挑战；OpenAI 工作人员口头表示条款「相当宽松」，个人用自己订阅可接受                                                                                                                      | 保留，默认开，标注「非官方端点」；HTML 响应判 `unsupported` 而不是错误                                                                                                                                                            |
| Copilot | 设备流（公开 client id `Iv1.b507a08c87ecfe98`）+ `GET api.github.com/copilot_internal/user` | core 自己拥有令牌（SecretStore）              | GitHub 允许列表里把 `copilot_internal/*` 列为「用户管理」端点；社区回复称官方客户端之外使用违反 Copilot 条款，有封号风险（针对生产 / 商用）                                                                                  | 保留，默认关；开关文案说明风险。`ARMADRA_COPILOT_CLIENT_ID` 允许企业换成自己的 OAuth 应用                                                                                                                                         |

（[The Register 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)、[Claude-Code-Usage-Monitor #202](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor/issues/202)、[Rhythm #1568](https://github.com/ajhochy/Rhythm/issues/1568)、[GitHub Community #178117](https://github.com/orgs/community/discussions/178117)、[GitHub Copilot allowlist](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference)）

### 9.4 `ama` 的模型供应商

文档 A §3.3：13 家内置（Anthropic、OpenAI、Google、DeepSeek、Moonshot、智谱、DashScope、OpenRouter、Groq、xAI、Mistral、Ollama、LM Studio）+ 自定义 OpenAI 兼容；**只支持 API key**，不做 OAuth，不做 Azure / Bedrock / Vertex（云身份不是 key）。Armadra 侧按 [协调 Agent §7](coordinator-agent.md)：key 进 SecretStore（`ama-<provider>`），启动前写 0600 的 `auth.json` 只传路径，不进环境变量、不进启动行、不进 `injection.json`。ChatGPT 登录（SIWC）那条线在文档 A 里是后续波次，Armadra 不替它保存 OAuth 条目。
**本地可验**：场景 11 用本地脚本化 OpenAI 兼容服务（文档 A 的 `fake-provider`）；不需要任何真实 key。
**未配置时**：`ama` 节点启动时提示「没有可用的供应商密钥」，其余六家 CLI 不受影响。

### 9.5 六家 CLI 的账户

不碰。多账号第二阶段只做「按节点注入凭据环境变量」（[CLI 协作设计 §7.3](cli-collaboration.md)），凭据仍是用户自己的，Armadra 只保管引用。

## 10. Git 托管 API

### 10.1 GitHub（已实现）

`core/github/credentials.ts`：令牌来源是 `gh` CLI（按需读取、不存）或用户粘贴的 PAT（OS 钥匙串引用名，Linux / Windows 退化为 0600 文件并如实标注 `GITHUB_STORE_FILE_FALLBACK`）；`ARMADRA_GITHUB_API_BASE` 指向 GHES 或 fixture；`ARMADRA_GITHUB_SECRET_STORE=file` 强制降级。
**事实（2026）**。PAT 限额 5,000 / 小时（与同一用户的 OAuth / GitHub App 共享预算）；`Authorization: Bearer`；细粒度 PAT 每人 50 个、最长 366 天、不能访问用户账户下的 Projects、Checks API 与 Packages。Git 工具窗口用到 Issues、Projects v2（GraphQL）、PR、Checks、合并——**Projects v2 与 Checks 在细粒度 PAT 上不可用**，设置页要说明「用 classic PAT（`repo`、`read:org`、`project`）或 `gh auth login`」。（[GitHub：REST 限额](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[GitHub：管理 PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)）
**补**：读 `x-ratelimit-remaining` 头，低于 200 时 Git 面板显示「接近限额」并把轮询拉长。

### 10.2 GitLab / Gitea / Forgejo（设计）

把 `core/github/` 的服务面抽成 `core/forge/`：`Forge` 接口（issues、pulls、checks、merge）+ 三个实现。GitLab 用 `PRIVATE-TOKEN`（`api` 或 `read_api` + `write_repository` 范围；细粒度令牌的拒绝码是 `insufficient_granular_scope`）；Gitea / Forgejo 用 `Authorization: token`（`read:repository` / `write:repository` / `write:issue`，Forgejo 已支持按仓库限定令牌）。术语映射：merge request ↔ pull request。配置键 `ARMADRA_FORGE_<id>_API_BASE`（测试）与每仓库的 `forge` 设置。（[GitLab PAT](https://docs.gitlab.com/user/profile/personal_access_tokens/)、[Forgejo #1712](https://codeberg.org/forgejo/forgejo/issues/1712)）
**本地可验**：`gitea/gitea` 容器（Forgejo 同源）+ 预置管理员；GitLab CE 容器太重（≥ 4 GB），只用录制的 fixture。
**未配置时**：Git 工具窗口的「托管」区只对识别出的 GitHub 远端显示。

## 11. 遥测、崩溃上报与许可证

### 11.1 遥测：没有

不收集使用数据，没有「匿名统计」。README 的「本地优先」是承诺。

### 11.2 崩溃上报：可选、自托管、默认关

**选项**。Sentry SaaS 免费档 5,000 错误 / 月、1 用户；Sentry 自托管要 16 GB 内存与 40+ 容器；**GlitchTip** 兼容 Sentry SDK 与 DSN、4 个容器、512 MB 内存、MIT。（[GlitchTip vs Sentry 2026](https://selfhosting.sh/compare/glitchtip-vs-sentry/)、[GlitchTip：Electron](https://glitchtip.com/sdkdocs/electron/)）
**方案**。`@sentry/electron`（桌面壳）与 `@sentry/node`（服务器壳）只在用户在「设置 → 通用 → 诊断」里**显式打开并填 DSN**时初始化（`ARMADRA_CRASH_REPORT_DSN` 作服务器壳配置键）；`beforeSend` 剥掉路径里的用户名、所有环境变量、`extra`；**不启用** minidump（Crashpad 转储含进程环境，可能带各 CLI 的 API key）——只报 JS 错误与 breadcrumbs；`autoSessionTracking: false`。core 自己不 import SDK（它不能依赖壳），壳通过 `platform` 注入一个 `reportError(error, context)`。
**本地可验**：GlitchTip 容器（`glitchtip/glitchtip` + Postgres + Redis）收事件；单测断言 `beforeSend` 的剥离。
**未配置时**：什么都不发；`process.on('uncaughtException')` 照旧写本地日志。
**页面错误**（G5-19，契约 §30）：另一个开关 `diagnostics.reportPageErrors`（缺省关，DSN 生效后才显示）。页面自己挂 `error` / `unhandledrejection`，剥离后每分钟最多 5 条；桌面壳经 IPC `diagnostics:report` 交主进程（`ipcMode` 仍为 0），服务器壳 / Gateway 经 `POST /api/diagnostics/client-error`，收件一侧再剥离、限流。

### 11.3 许可证与声明

- Electron 发行包里的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 是 BSD 等许可证**要求随二进制分发**的声明；electron-builder 在 macOS 上会把它们丢掉，要在 `after-pack.mjs` 里从 `node_modules/electron/dist/` 复制回 `Contents/Resources/`，Windows / Linux 确认它们落在可执行文件旁。（[electron/electron #34236](https://github.com/electron/electron/issues/34236)、[windows-installer #568](https://github.com/electron/windows-installer/issues/568)）
- npm 依赖：`pnpm licenses list --prod --json` 生成 `THIRD_PARTY_NOTICES.md`（根目录，`repo.rules.json` 的 `root` 列表加一项），构建时复制进包并在「关于」页显示；CI 加 `--check` 防漂移。node-pty 是 MIT（三行版权：chjj、Daniel Imms、Microsoft）。`@armadra/agent` 自己带 `THIRD_PARTY_NOTICES.md`，打进 `resources/agent/` 时一起带上。
- 仓库 `LICENSE` 已在；Flathub 若做需要 MetaInfo 里的 `project_license`。

## 12. 安全与合规基础

### 12.1 密钥存放：按平台补齐

**现状**。`core/usage/secret-store.ts`：macOS 用 `security(1)` 写登录钥匙串；其他平台 0600 文件并自报 `file`（降级）。`core/github/credentials.ts` 同一做法。Windows 上 `chmod` 不起作用，只继承用户目录 ACL（[CLI 协作设计 §7.2](cli-collaboration.md)）。

**事实**。Electron `safeStorage` 在 Windows 用 DPAPI、macOS 用钥匙串、Linux 用 libsecret / kwallet；Linux 下桌面环境不被识别（Hyprland、Sway……）时退回 `basic_text`——PBKDF2 一次迭代 + 写死的口令，等于明文，而 `isEncryptionAvailable()` 在某些版本仍返回 true；要用 `getSelectedStorageBackend()` 判 `basic_text` / `unknown` 为「无钥匙串」。（[Electron #38873](https://github.com/electron/electron/pull/38873)、[safeStorage 分析](https://chenguangliang.com/en/posts/blog169_electron-credential-storage-security/)）

**方案**。core 定义 `SecretBackend` 接口（已有 `SecretStore`，抽成 `{ kind, get, set, delete }`），由壳注入：

| 壳 / 平台    | 后端                                                                                                                                                 | 自报                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 桌面 macOS   | 现状 `security(1)`（不改，避免两套条目）                                                                                                             | `keychain`           |
| 桌面 Windows | `safeStorage`（DPAPI）加密后的密文存 `<数据目录>/secrets/<service>.bin`                                                                              | `dpapi`              |
| 桌面 Linux   | `safeStorage` 且 `getSelectedStorageBackend() ∈ {gnome_libsecret, kwallet*}` 才用；`basic_text` / `unknown` → 文件                                   | `libsecret` / `file` |
| 服务器壳     | `<数据目录>/secrets/master.key`（0600，首启生成）AES-256-GCM 封装各条目；`ARMADRA_SECRET_MASTER_KEY_FILE` 可指到别处（如 systemd `LoadCredential=`） | `file-encrypted`     |
| 任意         | `ARMADRA_SECRET_BACKEND=file` 强制明文 0600（测试与无人值守）                                                                                        | `file`               |

设置页继续只显示「存在哪儿」，从不回显值。所有 `armadra-*` service 名统一前缀，便于用户在钥匙串里一眼找到并清理。

### 12.2 令牌范围表

| 令牌                                                          | 最小范围                                                                                          | 存放                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| GitHub PAT（Git 窗口）                                        | classic：`repo`、`read:org`、`project`；细粒度：Contents / Issues / PR 读写（Projects v2 不可用） | SecretStore `github-<ref>`             |
| Copilot 设备流令牌                                            | `read:user`                                                                                       | SecretStore `copilot`                  |
| `ama` 供应商 key                                              | 各家 key                                                                                          | SecretStore `ama-<provider>`           |
| 节点凭据引用（多账号第二阶段）                                | `CLAUDE_CODE_OAUTH_TOKEN`（只能调模型）、Copilot 细粒度 PAT 仅 Copilot Requests                   | SecretStore `armadra-credential-<ref>` |
| OIDC client secret                                            | —                                                                                                 | SecretStore `armadra-oidc-<id>`        |
| APNs .p8 / FCM 服务账号                                       | 文件路径，不进环境变量                                                                            | 数据目录 0600                          |
| CI：Apple API key、Azure、GPG、minisign、R2、tap / winget PAT | 见各节                                                                                            | GitHub Actions secrets                 |

### 12.3 外呼清单与限额

core 的全部出站地址集中在一处（新 `core/net/outbound.ts` 导出常量表，`grep` 得到），每条带用途、间隔与是否可关：

| 地址                                                                                 | 用途        | 频率             | 关闭开关                         |
| ------------------------------------------------------------------------------------ | ----------- | ---------------- | -------------------------------- |
| `models.dev/api.json`                                                                | 模型目录    | 每日 1 次        | `models.catalog.autoRefresh`     |
| `status.claude.com` / `status.openai.com` / `githubstatus.com` `/api/v2/status.json` | 状态徽标    | ≥ 60 秒          | `usage.statusBadges`             |
| `api.anthropic.com/api/oauth/usage`                                                  | Claude 额度 | 用户打开用量页时 | `usage.claudeUsage`（默认关）    |
| `chatgpt.com/backend-api/wham/usage`                                                 | Codex 额度  | 同上             | `usage.codexUsage`               |
| `github.com/login/device/*`、`api.github.com/copilot_internal/user`                  | Copilot     | 登录时 / 用量页  | `usage.copilotUsage`（默认关）   |
| `api.github.com`（或 GHES）                                                          | Git 窗口    | 用户动作 + 轮询  | 不配置令牌即无                   |
| `api.github.com/repos/<repo>/releases`                                               | 更新检查    | ≥ 6 小时、ETag   | `updates.autoCheck`              |
| `api.pwnedpasswords.com/range/*`                                                     | 口令检查    | 设口令时         | `identity.passwords.breachCheck` |
| ACME 目录、APNs、FCM、SMTP、GlitchTip DSN                                            | 各节        | 事件驱动         | 不配置即无                       |

浏览器节点与各 CLI 自己的网络访问不在此表（它们是用户的程序）。

## 13. 用户需提供（按优先级）

| 优先级 | 项目                                                                                                       | 用途                                       | 费用（2026）                                   | 交给谁                                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P0     | Apple Developer Program + Developer ID Application（G2）证书 + App Store Connect API key（Developer 角色） | macOS 签名公证、Homebrew、APNs、TestFlight | $99 / 年                                       | secrets `APPLE_CERTIFICATE_P12_BASE64` 等（§2.1）                                                                          |
| P0     | minisign 发布密钥（`node tools/release/sign.mjs keygen`）                                                  | `latest.json` / `SHA256SUMS`               | 0                                              | secret `ARMADRA_RELEASE_SIGNING_KEY`；公钥提交进仓库                                                                       |
| P1     | Windows 签名：Azure Artifact Signing（美 / 加个人或合规组织）**或** CA 的 OV 证书                          | Windows 安装包、SAC 机器可运行、自动更新   | $9.99 / 月 或 $129–220 / 年（+ 令牌 / 云签名） | secrets `AZURE_*` 或 `WINDOWS_CLOUD_SIGN_*` / 自托管 runner                                                                |
| P1     | 自家 tap / bucket 仓库 + 细粒度 PAT                                                                        | Homebrew、Scoop、winget 自动 PR            | 0                                              | secrets `HOMEBREW_TAP_TOKEN`、`SCOOP_BUCKET_TOKEN`、`WINGET_TOKEN`                                                         |
| P1     | GPG 签名专用密钥                                                                                           | Linux `.asc`、rpm 签名、apt 仓库           | 0                                              | secrets `ARMADRA_LINUX_GPG_KEY`、`ARMADRA_LINUX_GPG_PASSPHRASE`                                                            |
| P2     | 域名 `armadra.dev`（或任意）+ Cloudflare 账户                                                              | 更新镜像、通用链接、公网演示服务器         | 域名约 $15 / 年；R2 免费档                     | secrets `CLOUDFLARE_R2_*`；AASA / assetlinks 静态文件                                                                      |
| P2     | 一台公网 Linux 机器（演示 / 审核 / ACME 实测）                                                             | 服务器壳公网路径、App 审核演示             | $3–6 / 月                                      | 运维                                                                                                                       |
| P2     | Google Play 开发者账户 + 身份验证 + Firebase 项目（FCM）                                                   | Android 分发与推送                         | $25 一次；FCM 免费                             | secrets `ANDROID_UPLOAD_KEYSTORE_*`、`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`；运行时 `ARMADRA_PUSH_FCM_CREDENTIALS_FILE` |
| P2     | APNs 密钥（.p8，Keys 页）、iOS 分发证书与描述文件                                                          | iOS 推送与 TestFlight                      | 含在 $99 内                                    | 运行时 `ARMADRA_PUSH_APNS_*`；secrets `IOS_DISTRIBUTION_*`                                                                 |
| P3     | OAuth 应用：GitHub（免费）、Google Cloud 项目（免费）、Entra 应用注册（免费）                              | 账号绑定                                   | 0                                              | 运行时设置页 + SecretStore                                                                                                 |
| P3     | SMTP 账号（任选）                                                                                          | 邀请 / 通知邮件                            | Resend 免费 3,000 封 / 月 等                   | `ARMADRA_SMTP_URL`                                                                                                         |
| P3     | GlitchTip 实例                                                                                             | 可选崩溃上报                               | 自托管 0                                       | `ARMADRA_CRASH_REPORT_DSN`                                                                                                 |

不需要用户提供的：models.dev、Statuspage、HIBP、GHCR、Let's Encrypt（只要域名 / IP）、Web Push、Tailscale 个人版（用户自装）。

## 14. 本地 dev-stack

`tools/dev-stack/docker-compose.yml`（随 `pnpm dev-stack up` 起，探针与集成测试用 `ARMADRA_DEV_STACK=1` 门控，CI 的 Linux 行可跑；不装 Docker 时所有相关用例 `skipped` 而不是失败）：

| 服务             | 镜像                                                                | 端口          | 验证什么                                             | 节    |
| ---------------- | ------------------------------------------------------------------- | ------------- | ---------------------------------------------------- | ----- |
| `release`        | `tools/release/mock-release-server.mjs`（已有，改成也能跑在容器外） | 8090          | 更新检查、`latest.json` + `latest*.yml`、下载、验签  | §3    |
| `pebble`         | `letsencrypt/pebble`                                                | 14000 / 15000 | 服务器壳 `--acme`：签发、续期、失败保留旧证书        | §6.3  |
| `step-ca`        | `smallstep/step-ca`（`DOCKER_STEPCA_INIT_ACME=true`）               | 9000          | 第二个 ACME 实现 + 本地 CA 根                        | §6.3  |
| `dex`            | `ghcr.io/dexidp/dex`                                                | 5556          | OIDC 授权码 + PKCE，静态用户                         | §7.1  |
| `keycloak`       | `quay.io/keycloak/keycloak:26 start-dev`                            | 8080          | 第二个 issuer、发现文档差异、SSO 登出                | §7.1  |
| `mailpit`        | `axllent/mailpit`                                                   | 1025 / 8025   | SMTP 发送与收件断言                                  | §7.5  |
| `gitea`          | `gitea/gitea`                                                       | 3000          | `core/forge/` 的 Gitea / Forgejo 实现                | §10.2 |
| `glitchtip`      | `glitchtip/glitchtip` + postgres + redis                            | 8000          | 可选崩溃上报的事件形状与剥离                         | §11.2 |
| `push-sink`      | `tools/dev-stack/push-sink.mjs`（自写 Node）                        | 8091          | 假 APNs / FCM / UnifiedPush 端点：记录请求、校验 JWT | §5.2  |
| `hibp`           | `tools/dev-stack/hibp-fixture.mjs`（自写）                          | 8092          | range API 固定响应                                   | §7.4  |
| `headscale`      | `headscale/headscale`（可选 profile）                               | 8080          | 文档验证用，不进 CI                                  | §6.2  |
| `ntfy`           | `binwiederhier/ntfy`（可选 profile）                                | 8093          | UnifiedPush 分发                                     | §5.2  |
| `armadra-server` | `build: ../../apps/server`                                          | 8443          | 容器化服务器壳本身（§4.4 的 Dockerfile）             | §4.4  |

不进 dev-stack 的：Apple 公证与 APNs sandbox（要真账户）、Azure Artifact Signing（要订阅）、Google OAuth 同意屏幕（dex 等价）、Tailscale SaaS（Headscale 等价）。

## 15. 工作包与文件归属

| 包             | 内容                                                                                                                                               | 文件                                                                                                                                                                                | 依赖                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| W-SIGN-MAC     | App Store Connect API key 公证路径；`codesign --verify` 断言；G2 证书说明                                                                          | `apps/desktop/scripts/signing-electron.mjs`（+ test）、`.github/workflows/release.yml`、`docs/guides/ci-release.md`                                                                 | —                      |
| W-SIGN-WIN     | `azureSignOptions` 条件合并；云签名 / 自托管 runner 两条路；无空格产物名；Windows `signatureState` 真实现                                          | `signing-electron.mjs`、`electron-builder.yml`、`apps/desktop/src/main/updates/environment.ts`、`release.yml`、`tools/release/stage-desktop.mjs`（名字改动）                        | —                      |
| W-SIGN-LINUX   | GPG `.asc` / `rpmsign`；公钥发布                                                                                                                   | `tools/release/{assemble,sign-gpg}.mjs`、`release.yml`                                                                                                                              | —                      |
| W-UPD          | 发布 `latest*.yml`（改名 + sha512 校验）；mock 服务器覆盖；ETag 检查；`settings.updates.channel`；灰度字段；electron-builder 27 清单签名（等稳定） | `tools/release/{stage-desktop,assemble,updater-manifest,mock-release-server,dry-run}.mjs`、`apps/desktop/src/{main,shell-core}/updates/*`、`core/settings/*`                        | W-SIGN-\*              |
| W-MIRROR       | R2 镜像作业；多端点                                                                                                                                | `release.yml`、`docs/guides/ci-release.md`                                                                                                                                          | 域名                   |
| W-DIST         | tap / bucket / winget 自动 PR；`PKGBUILD` 模板；GHCR 镜像与 `Dockerfile`                                                                           | `.github/workflows/release.yml`、`tools/release/templates/*`、`apps/server/Dockerfile`                                                                                              | W-SIGN-MAC（Homebrew） |
| W-NOTICES      | `THIRD_PARTY_NOTICES.md` 生成与 `--check`；Chromium 声明随包                                                                                       | `tools/notices.mjs`、`apps/desktop/scripts/after-pack.mjs`、`repo.rules.json`、关于页                                                                                               | —                      |
| W-SECRETS      | `SecretBackend` 接口与四个后端；`basic_text` 拒绝；`armadra-*` 命名统一                                                                            | `core/usage/secret-store.ts` → `core/secrets/`、`apps/desktop/src/main/secrets.ts`、`apps/server/src/secrets.ts`、`core/github/credentials.ts`                                      | —                      |
| W-OUTBOUND     | 出站地址常量表与开关；Claude / Copilot 用量默认关 + 文案；`status.claude.com` 重定向测试                                                           | `core/net/outbound.ts`、`core/usage/*`、`apps/web/src/i18n/*`、设置页                                                                                                               | —                      |
| W-ACME         | 服务器壳 `--acme`；Pebble / step-ca 集成测试                                                                                                       | `apps/server/src/{tls,acme}.ts`、`apps/server/src/cli.ts`、`tools/dev-stack/`                                                                                                       | dev-stack              |
| W-AUTH-OIDC    | 通用 OIDC + GitHub 特例；提供商表迁移；绑定 / 登录；dex + Keycloak 测试                                                                            | `core/identity/{oidc,oauth-github}.ts`、`core/db/migrations/00NN_oauth_providers.sql` + `migrations.lock`、`core/identity/accounts-http.ts`、`docs/contracts/core-json-api.md` 新节 | W-SECRETS、dev-stack   |
| W-AUTH-PASSKEY | `@simplewebauthn/server`；RP ID 规则与 IP 拒绝；TOTP；HIBP                                                                                         | `core/identity/{passkey,totp,breach}.ts`、`core/identity/passwords.ts`、契约新节                                                                                                    | —                      |
| W-MAIL         | `ARMADRA_SMTP_URL` + nodemailer；Mailpit 测试                                                                                                      | `core/notify/mail.ts`、`apps/server/src/cli.ts`                                                                                                                                     | dev-stack              |
| W-PUSH         | `core/push/`：Web Push → APNs / FCM / UnifiedPush；订阅表迁移；push-sink 测试                                                                      | `core/push/*`、`core/db/migrations/00NN_push_subscriptions.sql`、`apps/web/src/push/*`（service worker）、设置页                                                                    | W-SECRETS、dev-stack   |
| W-MOBILE       | Capacitor 壳；钥匙串、QR 扫码、证书固定、深链、推送注册；CI 构建到 TestFlight / Play 内部轨                                                        | `apps/mobile/`（新，`@armadra/mobile`，`repo.rules.json` 登记）、`.github/workflows/mobile.yml`、`docs/guides/client-platforms.md`                                                  | W-PUSH、§5.4           |
| W-PAIR-FP      | 配对链接带证书指纹；QR 版本上限 10                                                                                                                 | `apps/server/src/auth.ts`、`apps/web/src/host/qr.ts`、`apps/web/src/host/*`                                                                                                         | —                      |
| W-FORGE        | `core/forge/` 抽象 + GitLab / Gitea 实现；Gitea 容器测试                                                                                           | `core/github/` → `core/forge/`、Git 面板                                                                                                                                            | dev-stack              |
| W-CRASH        | 可选崩溃上报（JS 错误）；`beforeSend` 剥离；GlitchTip 测试                                                                                         | `apps/desktop/src/main/diagnostics.ts`、`apps/server/src/diagnostics.ts`、`core/platform.ts`（`reportError` 注入）                                                                  | dev-stack              |
| W-DEVSTACK     | compose 文件、push-sink、hibp-fixture、`pnpm dev-stack`、CI 门控                                                                                   | `tools/dev-stack/*`、根 `package.json`、`docs/guides/development.md`                                                                                                                | —                      |

迁移编号在实施时按 `migrations.lock` 的下一个连续号分配，两个新迁移（OAuth 提供商、推送订阅）由先合并的包占先，另一包改号；契约新节用新 §N，不复用。

## 16. 来源

正文各节已内嵌链接；下面是按主题的主来源，便于复核。

- 签名：[Apple Developer ID](https://developer.apple.com/support/developer-id)、[notarytool(1)](https://keith.github.io/xcode-man-pages/notarytool.1.html)、[Azure Artifact Signing 快速入门](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)、[Microsoft 代码签名选项](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)、[electron-builder Windows 签名](https://www.electron.build/docs/features/code-signing/code-signing-win/)、[Signed Update Manifests](https://www.electron.build/docs/features/signed-update-manifests/)、[AppImage 签名](https://docs.appimage.org/packaging-guide/optional/signatures.html)
- 托管与分发：[GitHub About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)、[Cloudflare R2](https://mecanik.dev/en/posts/cloudflare-r2-pricing-explained-real-costs-vs-s3-and-backblaze/)、[Homebrew Acceptable Casks](https://docs.brew.sh/Acceptable-Casks)、[winget-pkgs](https://github.com/microsoft/winget-pkgs/blob/master/doc/README.md)、[Scoop Autoupdate](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifest-Autoupdate)、[Flathub Requirements](https://docs.flathub.org/docs/for-app-authors/requirements)、[electron-builder snap](https://www.electron.build/docs/snap/)
- 手机：[Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[TestFlight 2026](https://ptkd.com/journal/testflight-external-tester-limit-2026)、[Google Play 开发者验证](https://support.google.com/googleplay/android-developer/answer/16471116)、[ntfy #1680](https://github.com/binwiederhier/ntfy/issues/1680)、[Pushpad iOS Web Push](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications)、[FCM REST](https://firebase.google.com/docs/reference/fcm/rest)、[Android App Links](https://developer.android.com/training/app-links/configure-assetlinks)
- 连通与 TLS：[Let's Encrypt 6 天与 IP 证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[step-ca ACME](https://smallstep.com/docs/tutorials/acme-protocol-acme-clients/)、[mkcert](https://github.com/filosottile/mkcert)、[Tailscale 2026](https://wz-it.com/en/blog/tailscale-pricing-2026-headscale-netbird-self-hosted/)、[Headscale](https://github.com/juanfont/headscale)、[Cloudflare Tunnel 2026](https://tech-insider.org/cloudflare-tunnel-setup-2026-homelab/)、[coturn Docker](https://meetrix.io/blogs/coturn-docker-compose/)
- 认证：[web.dev RP ID](https://web.dev/articles/webauthn-rp-id)、[@simplewebauthn/server](https://www.npmjs.com/package/@simplewebauthn/server)、[otplib](https://github.com/yeojz/otplib)、[HIBP API v3](https://haveibeenpwned.com/api/v3)、[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[Google Unverified apps](https://support.google.com/cloud/answer/7454865)、[Microsoft Publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)、[Mailpit](https://mailpit.axllent.org/)、[邮件 API 价格 2026](https://www.buildmvpfast.com/api-costs/email)
- 模型与用量：[models.dev](https://github.com/anomalyco/models.dev)、[Atlassian Statuspage API](https://support.atlassian.com/statuspage/docs/what-are-the-different-apis-under-statuspage/)、[The Register：Anthropic 第三方访问](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/)、[GitHub Community #178117](https://github.com/orgs/community/discussions/178117)
- Git 托管：[GitHub REST 限额](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[GitHub PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、[GitLab PAT](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- 遥测与许可证：[GlitchTip Electron](https://glitchtip.com/sdkdocs/electron/)、[GlitchTip vs Sentry](https://selfhosting.sh/compare/glitchtip-vs-sentry/)、[Electron crashReporter](https://www.electronjs.org/docs/latest/api/crash-reporter)、[electron #34236](https://github.com/electron/electron/issues/34236)
- 密钥：[Electron safeStorage 后端](https://github.com/electron/electron/pull/38873)、[Smart App Control FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)
