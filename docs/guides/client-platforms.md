# Desktop、Web 与手机浏览器

Armadra 使用同一套 React 页面。桌面端通过 Electron 壳提供本机目录选择和真实文件路径；浏览器通过文件上传使用运行 core 的主机文件系统，不把浏览器的文件名当成本机绝对路径。

## 已实现的客户端布局

- 桌面窗口：侧栏停靠在画布左侧，保留原生标题栏和系统拖放。
- Web：使用同一份构建与 HTTP/WebSocket API，主机文件和终端能力由 core 提供。
- 手机尺寸 Web：小于 768px 时侧栏改为带焦点管理的抽屉，首次进入保持收起，画布占满宽度。抽屉内可切项目、编辑名称、搜索和进入设置；打开设置时先关闭抽屉。
- 侧栏收起时不可聚焦隐藏内容；Dock 在窄画布使用紧凑工具面板，缩略图支持收起；设置页与右侧抽屉限制在屏幕宽度内。
- 视口高度使用 `100dvh`，适应浏览器地址栏和软键盘导致的可视高度变化。

## 手机布局（H03）

- 底部导航：画布 / 文件 / Git / 自动化 / 设置。一次只开一个面板，「画布」是把它们全部关掉。还没打开工作空间时其余四项禁用，**设置仍然可点**——手机是从那里配对的。
- 单节点焦点页：终端、编辑器与浏览器节点可整屏打开，复用桌面的 `focusNodeId`，顶部是「返回画布」与节点切换器，渲染的是画布上的同一个节点组件（头部按钮、审批、状态都在）。
- 软键盘工具条：Esc / Tab / 方向键 / 粘贴常驻，Ctrl 展开 `^C ^D ^Z ^L ^R ^A ^E ^U ^K`，按一个发一个。它不是粘住的修饰键：系统键盘的按键不经过这条工具条。
- 源码控制在手机上是三级导航：分区列表 → 分区详情 → 单文件差异，每一级都有「返回」。
- 终端输入带序号，core 落到 pty 后回 `ack`，重连时按 `hello.acknowledgedInput` 只重发未确认且十秒内的输入——超时的结果未知，不自动重发。

## 连接页、推送与原生 App 的页面一半（G2-10）

- 手机浏览器扫桌面「远程访问 → 局域网直连」的二维码打开 `https://…/#pair=<票>&fp=…`：窄屏下是连接页（地址、「连接」、CA 安装引导），点「连接」配对后进画布；宽屏仍由设置页「设备与会话」那一页配对。
- 登录后手机布局里问一次推送权限；浏览器走 Web Push，worker 在站点根 `/sw.js`。点通知经 `#push=armadra://w/<工作空间>/n/<节点>` 打开节点焦点页。
- 原生 App 的页面打在包里，没有来源时是连接页（贴配对链接或扫码）；配对后 Gateway 来源记在本地、会话凭据在钥匙串，请求带 Bearer，WebSocket 升级前换一次性票。原生插件约定见 `apps/web/src/mobile/native-bridge.ts` 文件头。

## 经 Gateway 访问

桌面壳与服务器壳共用 core 的 Gateway 域（`core/gateway/`，契约 §17）：同一套 TLS、准入、页面托管与配对。

- 桌面：设置 → 远程访问 →「局域网直连」开关（托盘里是「对外服务」勾选项）。监听档 `loopback` / `private` / `all`，`private` 只收回环与私网来源；端口 0 开启后写回。证书来源：本地 CA（`<数据目录>/tls/ca.{crt,key}` 签叶证书，地址变了或剩 30 天就重签叶证书）、指定文件、ACME（`http-01` 或 `tls-alpn-01`，后者要先固定端口；续期失败时页面出 Alert 与下次重试时间）。关掉即断开经它进来的连接。服务器壳上同一页只读（`managedBy: "shell"`）。
- 配对：运行中出配对卡——二维码、复制链接、两分钟倒计时、信任锚指纹、下载 CA。链接是 `…/#pair=<票>&fp=<指纹>`，原生 App 用 `armadra://pair?host=…&ticket=…&fp=…`。手机浏览器打开后先按 CA 引导装证书，再点「连接」。`loopback` / `private` 档（以及绑在回环或私网地址上的 `all` 档）的配对卡另给一个 8 位配对码 `XXXX-XXXX`，与票同时过期、一次性：手机浏览器在连接页输入它即可配对（`POST /api/gateway/pairing-code/exchange`，契约 §24）；原生 App 只在已钉过信任锚之后多一个「输入配对码」入口。
- 准入：网页用 `__Host-` Cookie + CSRF；原生 App 用 Bearer（来源只认 `capacitor://localhost` / `https://localhost`），WebSocket 升级前换一次性 `ws-ticket`。未配对的设备只拿到页面外壳与静态资源，`/api` 一律 401。
- 已配对设备在同一页一张表里：名称、平台、添加时间、最近访问、权限、「当前」标记、撤销；成员也能看到自己的设备。「平台」由最近一次会话的 UA 归类得出，UA 原文不出 core。
- 公网部署（域名、ACME、反向代理、备份升级）见[服务器部署](server-deployment.md)。

已知限制：项目列表是**本设备**的偏好，新手机不会自动列出电脑上已有的项目。

## 运行边界

手机浏览器与原生 App 都是客户端，不在手机上启动桌面 CLI。终端、Git、文件与 Agent 仍由电脑上的 core 执行。原生 App 见下一节；商店分发与真机推送要用户的证书（清单在该节末尾）。

电脑上的浏览器可直接使用 `./armadra.sh run web`。如果已有带认证的 HTTPS 反向代理，可将 Web 静态产物和 core 的 `/api/*`、`/health`、WebSocket 代理到同一来源，并在构建时把 `VITE_RUNTIME_URL` 设置为该来源，例如 `https://canvas.example.com`（此处仅为配置示例）。也可以显式设置空值使用当前来源，或设置 `/runtime` 这样的反向代理前缀；HTTP 与 WebSocket 会保留同一前缀。core 本身仍保持回环监听；代理必须保护 HTTP 与 WebSocket 的所有入口，不能把可执行终端和主机文件 API 裸露到网络。

这份客户端适配不会自动更改监听地址、CORS、账户配置或主机权限。

## 原生 App（Capacitor 手机壳，G3-1）

`apps/mobile`（`@armadra/mobile`，Capacitor 8）把同一份 `apps/web` 生产构建**打进安装包**：不配 `server.url`、不做 OTA。App 有自己的版本线（`apps/mobile/package.json`，与桌面 / 服务器的版本无关），iOS 与 Android 的版本名、构建号都由 `apps/mobile/scripts/app-version.mjs` 派生，与主机是否兼容只看协议（[CI 与发布](ci-release.md) §2.8）。商店定位是「连接你自己的 Armadra 的通用客户端」，App 里不内置任何由我们托管的服务（[外部服务](../design/external-services.md) §5.1）。页面来源固定为 iOS `capacitor://localhost`、Android `https://localhost`，Gateway 的 CORS 只放行这两个（契约 §17.4）。

原生只补网页做不到的几件事，页面一半的约定在 `apps/web/src/mobile/native-bridge.ts` 文件头：

| 能力         | iOS（`ios/App/App/ArmadraNativePlugin.swift`）                                                                                                                                                                                              | Android（`android/app/src/main/java/dev/armadra/mobile/`）                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 会话凭据     | 钥匙串（`AfterFirstUnlockThisDeviceOnly`，首次启动清掉上次安装的残留）；一个连接一份（`session.<sourceId>.<via>`），远程服务的刷新令牌另存（`remote.<serviceId>`）                                                                          | Keystore 里不可导出的 AES-GCM 钥加密后存私有偏好，键同左；不备份                                                                                                         |
| 证书钉扎     | 插件挂 WKWebView 的认证挑战：只在链能验到「指纹等于二维码 `fp` 的信任锚」且主机名对得上时放行，系统信任库不参与；每个来源（Gateway、个人中转）各存一份（`pin.<host:port>`）                                                                 | `WebViewClient.onReceivedSslError`：叶证书要能验到同一张信任锚，否则 `cancel()`；同样每个来源一份                                                                        |
| 信任锚从哪来 | 配对时取一次 `GET /ca.crt`（本地 CA 模式下握手链里只有叶），按指纹核对后才存                                                                                                                                                                | 同左；两步取（先只看叶、再只信那一张叶去取 `/ca.crt`），不用「信任一切」的 TrustManager                                                                                  |
| 扫码         | AVFoundation 整屏扫码，系统「取消」                                                                                                                                                                                                         | Google 代码扫描器（Play 服务提供界面，不要相机权限）                                                                                                                     |
| 推送         | APNs 令牌 + 设备 X25519 公钥；Notification Service Extension 用钥匙串里的私钥解开信封（契约 §19.5），换上标题、正文、深链                                                                                                                   | FCM 令牌 + 设备公钥；数据消息在 `ArmadraMessagingService` 里解开再出通知；装了 UnifiedPush 分发器时改向它要端点（契约 §27.2），消息在 `ArmadraUnifiedPushService` 里解开 |
| 令牌轮换     | 启动时对开过推送的设备再要一次 APNs 令牌，与上次登记的不同就标「换过」并发 `pushTokenRotated`（`PushTokenLedger`）                                                                                                                          | `onNewToken` 与 UnifiedPush 的新端点标「换过」并发同一个事件（`PushRotation`）                                                                                           |
| App 版本     | `appInfo`：`CFBundleShortVersionString` / `CFBundleVersion`（「设置 → 关于」显示）                                                                                                                                                          | `appInfo`：`versionName` / `versionCode`                                                                                                                                 |
| 系统浏览器   | `openExternal`：`UIApplication.open`，只开 https 与回环 http                                                                                                                                                                                | `ACTION_VIEW`，同样只开 https 与回环 http                                                                                                                                |
| 深链         | `armadra://pair?…`、`armadra://join?…` 与 `armadra://oauth?…` → 写进页面 `#link=` 并重载（配对：连接页预填，人点「连接」才配；分享链接：连接页收到就直接挂载；OAuth：入口收尾）；`armadra://w/<工作空间>/n/<节点>` → `#push=`，进节点焦点页 | 同左；冷启动带来的深链等页面加载完再交                                                                                                                                   |

- 安全区与窗口控件：页面 `viewport-fit=cover` 铺满，贴边元素按 `--safe-*` 让开（设计系统 §5.13）；iPadOS 窗口化时 `ArmadraBridgeViewController` 把左上窗口控件的范围（`ArmadraNativeKit/WindowControls`）写成 `--window-controls-left/top`，布局变化与每次页面加载后都重写；状态栏文字颜色由页面经 `SystemBars` 按主题设定（`apps/web/src/mobile/status-bar.ts`）。
- 商店版走发布方的推送中继：构建时设 `ARMADRA_MOBILE_RELAY_URL`（写进 `capacitor.config.ts` 的 `plugins.ArmadraNative.relayUrl`），App 先向中继 `/v1/register` 换中继令牌，再以 `transport: "relay"` 登记；不设时以 `direct` 登记，适合自己构建、自己持有 APNs / FCM 密钥的部署。
- 推送令牌换了（R-54）：页面对开过推送的设备在启动时与收到 `pushTokenRotated` 时向插件要一份新登记、`PUT /api/push/devices`，成功后清标记（`apps/web/src/mobile/push-rotation.ts`）。
- 图片（R-55）：`<img>` 带不了 Bearer。页面里指向 Gateway 的图片地址经 `useAssetUrl`（`apps/web/src/api/assets.ts`）用带 Bearer 的 `fetch` 换成 `blob:`，白板图片与 Markdown 预览都走它；浏览器与桌面里原样用地址。
- 第三方登录（R-56）：App 里点 GitHub / OIDC，页面以 `start?native=1` 拿授权地址与一次性 `nativeState`（记在本机），交系统浏览器；提供方跳回 core 的回调，回调把 `state` 与授权码转成 `armadra://oauth?…` 深链交回 App，入口在挂载前带着 `nativeState` 调 `POST oauth/{id}/native` 收尾，结果写成 `#oauth=` 打开「安全」页（契约 §18.5）。提供方那边只登记原来那一个 https 回调地址。App 里没有会话、OAuth 登录走到第二因素时，入口进整页验证码页（`mobile/NativeMfa.tsx`，复用登录页的两步验证），验证通过进画布。
- 系统本来就信任的证书（ACME、反向代理的真证书）在 Android 上由系统校验，WebView 没有别的钩子，指纹不再参与；iOS 照样按指纹判。
- 钉扎、信封与深链的判定在不依赖 UI 的模块里：iOS `ios/ArmadraNativeKit`（`swift test`），Android `android/armadra-native-core`（纯 JVM，`./gradlew :armadra-native-core:test`），两边读同一份样本 `apps/mobile/fixtures/`，`src/fixtures.test.ts` 守着样本与 core 的实现一致。

### 多连接与个人中转（A1-5）

一部手机可以同时记住多个连接，每个连接是电脑上的一个 core（源）。连接页（`mobile/ConnectScreen.tsx`）列出已有的连接，「添加连接」有三种方式：

1. **扫码 / 配对链接 / 配对码**：局域网 Gateway，现有流程。配对成功后以 core 的 `hostId` 记成一个连接。
2. **个人中转**：地址、账号、口令。先让原生不带凭据取一次中转的信任锚指纹（`peek`），自签的中转要人核对指纹并确认，才钉住（`pin`），再 `POST /v1/auth/login`；登录后按 `me.sources` 勾选要连的在线主机，每台：`sources.assertion` → 经中继向源 core `cloud/login` → 会话进钥匙串。系统本来就信任的证书（ACME）与已经钉过同一枚的跳过核对。
3. **分享链接 / 二维码**（`<issuer>/j/<id>#<秘密>.<邀请令牌>` 或 `armadra://join?link=&issuer=&s=`）：App 内扫码或系统相机扫到深链都直接挂载（`links.accept` → `cloud/login` 带邀请令牌）。

SaaS 的添加方式没有入口，类型与分支留着。同一个源从两条路到达（局域网配对、个人中转）合并成连接表里的一行，选路时直连优先、探不通退回中继。

存放：连接表（`armadra.sources`，无凭据）在页面的本地存储；凭据只在钥匙串 / Keystore 里。`mobile/credentials.ts` 是手机的 `CredentialProvider`：直连用钥匙串里的刷新令牌向 Gateway 轮换，经中继先用远程服务的刷新令牌取云会话、要断言与中继令牌，再轮换源会话，被拒才用断言重新登录；轮换后的新令牌每次写回钥匙串，钥匙串是刷新令牌唯一的真相（身份面轮换后同样写回）。页面其余部分只认「当前连接」：入口（`mobile/entry.ts`）选路后把这一路的地址与凭据装给本机源，经中继时每个请求带 `armadra-relay-token`、每条流带 `armadra-relay.<令牌>` 子协议，令牌到期前与回到前台时提前续。切换连接 = 记下选中的再重载。管理页入口：把地址改成 `#connections`。

### 本地构建

```sh
pnpm libs:build && pnpm --filter @armadra/web build
pnpm --filter @armadra/mobile sync          # 写版本与构建号、拷页面产物进 www/、插插件桥、cap sync
# iOS 模拟器（「Sign to Run Locally」，不要证书；关掉签名的包在模拟器上拿不到钥匙串）
xcodebuild build -project apps/mobile/ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator'
# Android debug APK（要 Android SDK 与 JDK 21）
(cd apps/mobile/android && ./gradlew :armadra-native-core:test :app:assembleDebug)
```

「连接 → 配对 → 画布」在模拟器里跑：`node tools/probes/mobile-shell-e2e.mjs --platform ios|android`（B 档，`nightly.yml` 的 `mobile-ios` / `mobile-android` 作业；产物名见 `tools/release/artifacts.mjs` 的 `mobileAssets`）。

### 真机与商店：需用户提供

对应[补全执行计划](../design/completion-plan.md) §5 的 U8、U9、U10。仓库里没有任何签名材料，下面每一项都由用户提供后再做：

1. **Apple**：Apple Developer Program 账号（与桌面公证同一个）；App ID `dev.armadra.mobile` 与 `dev.armadra.mobile.NotificationService`，都开 Push Notifications 与 Keychain Sharing（组 `dev.armadra.mobile.shared`）；开发 / 分发证书与两份 provisioning profile；CI secrets `IOS_DISTRIBUTION_P12_BASE64`、`IOS_DISTRIBUTION_PASSWORD`、`IOS_PROVISIONING_PROFILE_BASE64`，上传用桌面公证的同一把 App Store Connect API key。发布构建把 `App.entitlements` 的 `aps-environment` 交给分发 profile 决定（`production`）。
2. **APNs**：`.p8` + Key ID + Team ID。自建部署填进 core 的 `ARMADRA_PUSH_APNS_*`（`direct`）；商店版填进中继的 `ARMADRA_RELAY_APNS_*`。验证：真机开推送 → `POST /api/push/test` 收到通知，锁屏上显示解密后的标题。
3. **Android**：Play 开发者账号（个人账户的新 App 要 12 名测试者封闭测试 14 天）；上传密钥 `ANDROID_UPLOAD_KEYSTORE`（构建时的文件路径）、`ANDROID_UPLOAD_KEYSTORE_PASSWORD`、`ANDROID_UPLOAD_KEY_ALIAS`（`app/build.gradle` 只从环境读；用 `apps/mobile/scripts/create-upload-keystore.sh` 生成并写进仓库 secrets，每次发布的 GitHub Release 就带签名 APK，见 CI 与发布 §2.6.3）；Play 服务账号 JSON（上传用）。
4. **Firebase**：一个 Firebase 项目，下载 `google-services.json` 放到 `apps/mobile/android/app/`（不进仓库；有它构建时才套 google-services 插件，没有时 App 照常、开推送答失败）；服务账号 JSON 给 core 的 `ARMADRA_PUSH_FCM_CREDENTIALS_FILE` 或中继的 `ARMADRA_RELAY_FCM_CREDENTIALS_FILE`。
5. **推送中继**（商店版）：一台公网主机运行 `apps/push-relay`，构建 App 时设 `ARMADRA_MOBILE_RELAY_URL`。
6. **商店审核**：一台公网可达的演示服务器壳与审核账号；隐私说明（App 只连用户自己的服务器、不收集数据）；出口合规问卷（只用系统自带的标准算法：TLS、AES-GCM、X25519）。
7. **真机验收**：扫桌面「对外服务」的二维码 → 钉扎 → 配对 → 画布；关掉再开 App 不用重配；换证书（重置 CA）后 App 提示重新扫码、不自动信任；收到审批推送、点开进节点焦点页。
