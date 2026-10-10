# 多端加入时「其他页面全部刷新」根因调查（2026-10-07，main fb54e0b1）

只做调查，没改仓库代码。复现用的是隔离数据目录、临时 HOME 和无头 Chrome。探针脚本与产物在
仓库外的临时探针（`probe.mjs` 与 JSON / 截图产物，未提交）。因为 `packages/shared/dist`
过期，Vite 页面报缺少导出（`ManualRunResponseSchema`），所以先跑了一次 `pnpm libs:build`，
它只重新生成 gitignore 掉的产物。core 用的是现有的 `apps/desktop/out/core/main.js`（10-06 构建）。

## 结论（按可能性和影响排序）

### 1. 主因（已复现）：终端尺寸是共享的，任何一端 attach 或 resize 都会改所有端的 tmux 客户端，所有终端整屏重绘

新页面打开画布后，画布上的每个终端节点都会 attach。hello 之后它**无条件**发一次 resize。core 收到后把这个会话的
**所有** tmux 客户端 pty 一起改到这个尺寸，tmux 按 `window-size latest` 整窗口重绘。于是所有已打开页面上的所有终端
一齐重画，看起来就是「全部刷新一下」。如果新端是手机，焦点页把终端铺满 390px，列数大约只有 40，桌面端的终端就会
被压成手机的尺寸并保持下去。

触发链路：
1. `apps/web/src/terminal/surface/use-transport.ts:104-107`：`onHello` 里先 `refit()`，再无条件 `transport.resize(cols, rows)`。
2. `apps/desktop/src/core/terminal/socket.ts:372-377`：resize 帧交给 `manager.resize`。
3. `apps/desktop/src/core/terminal/manager.ts:949-961`：`resize` 改的是会话级的 `record.cols/rows`，再调后端；`attach`（`manager.ts:835-866`）同样把会话尺寸覆盖成新来者的尺寸（`:859-860`）。
4. `apps/desktop/src/core/terminal/tmux/backend.ts:396-407`：`for (const client of session.clients.values()) client.pty?.resize(cols, rows)`，**所有观看者**的 tmux 客户端 pty 都被改掉。新客户端 attach 时也用自己的尺寸开 pty（`:231-238`）。
5. `apps/desktop/src/core/terminal/tmux/config.ts:44-45`：`window-size latest` 加 `aggressive-resize on`，窗口跟着变，所有客户端都整屏重绘。`:64-66` 去掉了 smcup/rmcup，注释写明每次整屏重绘都会**往 scrollback 追加一屏重复内容**。shell 和 Agent CLI 收到 SIGWINCH 后也会重画提示符或整个 TUI。
6. 旧页面不会自己纠正：`apps/web/src/terminal/surface/use-refit.ts:37-44` 只在**本地**容器的列行数变化时才发 resize，所以被别人改过的尺寸会一直留着。
7. 手机端：`apps/web/src/shell/MobileFocusPage.tsx`（在 `App.tsx:140` 挂载）把同一个终端节点铺满整屏，列数远小于桌面。
8. direct 后端（`apps/desktop/src/core/terminal/direct.ts:334-345`）是单个 pty，后一个 resize 生效，现象相同。

复现证据（`out/desktop.json`、`out/mobile.json`）：
- A 页面（1440×900，两个终端 + 一张便签）稳定后，B（桌面尺寸或 390×844 mobile）打开同一块板。A 的 `window.__mark` 还在（**没有整页 reload**）。A 上 React Flow 节点和 xterm 的 DOM 都**没有被移除或重挂载**，A 上 WS **没有断开重连**。B 打开后 1.1–1.5s 内 A 的两个终端各收到一波重绘 output（共 7 帧，418–710 字节）。截图 `out/mobile-a.png` 里每个终端多出一行重复的提示符。
- 在 B 上新开一条终端 WS，发 `resize 40x12`：`tmux list-clients` 显示**该会话的全部客户端（包括 A 的）**都从 69x18 变成 40x12，窗口也变成 40x12；A 的 xterm 还是 18 行，内容又追加了一行重复提示符。

### 2. 次因（代码证实，与加入时机偶合）：身份层的 `announce()` 让整个 QueryClient 全量失效

`apps/web/src/app/App.tsx:89-91` 订阅 `onIdentitySessionChange`，回调是 `queryClient.invalidateQueries()`，不带任何过滤，
所以页面上所有活跃查询都会重取。可 `announce()` 触发得远比「会话变了」频繁：
- `apps/web/src/api/identity.ts` 的 `rememberCsrf`：只要 CSRF 值变了就 `announce()`。core 每次刷新都会轮换 CSRF（`core/identity/service.ts` 刷新时重新生成 `csrfHash`）。
- `remember()`（`identity.ts:375-411`）在每次 `refreshIdentity` 后调用。桌面壳在访问令牌到期前 2 分钟主动轮转（`scheduleShellRefresh`，`identity.ts:802-827`，`ACCESS_TTL_MS = 15min`），大约**每 13 分钟全量重取一次**。原生 App 和中继托管页在 401 后刷新也一样。
- 同一浏览器的 Cookie 会话下开新标签页：新页 `ensureCsrf` 会轮换 CSRF，旧页靠 BroadcastChannel 收到，正常情况下不 announce。但如果旧页有写请求正好 403，`forgetCsrf`（`identity.ts`）会把 csrf 清空，随后 `adoptCsrf` 的 `had === false` 分支就会 `announce()`；旧页自己 renew 时也会走 `rememberCsrf` 的 announce。结果是旧页全量重取，还可能和新页互相作废令牌。

影响：各处查询同时重取，loading 状态闪一下。实时板的文档不会被回写（`use-board-sync.ts:259`），所以画布不会被盖掉，但侧栏、会话、Git、用量这些都会抖一次。不同设备之间不会互相触发，所以它不是「别的设备加入」的直接原因，但很容易让人以为和加入有关。

### 3. 条件触发：租约模式（非实时板）下，新来者一动手，旧页就丢租约并重载文档

只在板不走实时时出现，比如 `collab.realtime` 被关掉，或连的是老 core。持有者空闲超过 3 分钟、又有别人在看时，
core 会释放租约（`core/canvas/presence.ts:458-465`）。新来者一次带 `active` 的心跳就能拿到租约，旧页随即
`applyPresence` 判定 `lost`（`apps/web/src/store/canvas/presence.ts:195-221`）→ `clearLocalEdits` → `onLeaseLost`
重取文档并合并（`apps/web/src/app/use-board-sync.ts:159-170`），画布会重载一次，并变成只读。默认实时板走
`isReadOnly` 的 realtime 分支（`presence.ts:177-179`），不会触发。

### 4. 低概率：Eco 休眠的终端被新端唤醒，旧页重连

如果某个终端已经被 Eco 休眠，新端打开时会唤醒它，core 广播 `terminal.hibernation running`。显示休眠态的旧页会
`awake()` 重连（`apps/web/src/terminal/surface/use-hibernation.ts:83-101`）→ `terminal.reset()`（`use-transport.ts:58`）
→ 重新 attach 并重绘。

## 已排除（附证据）

- **实时协同**：加入只交换 awareness，不改 Y.Doc。`binding.ts:54-129` 只对非本地 origin 的事务回灌；`readNodes`/`orderLike`（`realtime/doc.ts:413-470`）内容相同时保留对象身份和顺序。复现中 A 没有任何节点被移除，也没有重新拉文档（加入后 A 的 fetch 只有周期性的 `resources/subscription` 和 `usage`）。
- **React Flow 或 SourceProvider 整树重挂**：没有找到以 presence、realtime 或 source 状态为 key 的画布根节点（只有侧栏列表项用 sourceId 作 key）。新设备加入不会改本机页面的源表（`useSourceSwitchCacheReset` 只在当前源 id 变化时触发）。
- **控制面事件**：加入时 A 没有收到触发全量失效的事件。`useWorkspaceEvents`（`api/events.ts:363-430`）只做按键失效；`canvas.presence` 只更新在线表。
- **页面 reload**：`location.reload` 只出现在手机端自己的连接管理、推送切连接（`mobile/MobileRoot.tsx:108,139`、`mobile/push-open.ts:107`）和横幅上的手动「重新登录」（`shell/Banners.tsx:171`），都不会被其他端触发。桌面壳的 CSP 重载（`main/remote-trust.ts`、`main/index.ts:206`）只在本页改了源表时触发。
- **service worker**：`mobile/sw.ts` 和 `push/service-worker.ts` 只处理 push 和 notificationclick，没有 fetch、skipWaiting、clients.claim，也没有 reload。
- **个人中继同源替换和 GOAWAY**：只在同一个源建了新隧道时才发生（armadra-cloud `apps/relay/src/tunnel/server.ts:224`），客户端加入不会触发。`~/armadra-relay-lan/relay.log`（只读）里隧道 10 多小时只开关过两次，没有 replaced。
- **设备配对或登录**：没有撤销其他会话或抬高 epoch 的逻辑（epoch 只在撤销设备时 +1，`core/identity/store.ts:253`）。`accessChanged` 只触发 presence 复判，有变化才广播。
- **「主 · N 从」**：这是连线的 supervisor 角色徽标（`i18n/canvas.ts:154`），和终端主从、重连无关。

## 修复方向

1. **终端尺寸改成每个观看者各自独立（主因）**
   - core `tmux/backend.ts::resize`：只改发出 resize 的那个 attachment 自己的 tmux 客户端 pty，不再遍历 `session.clients`。为此 `manager.resize` 和 `socket.ts` 要带上 `attachmentId`。
   - tmux 策略：`window-size latest` 会被最近活跃的客户端（手机）牵走。可以考虑 `largest` 或 `manual`，并定一个「主观看者」规则（比如持有输入租约 `terminal.lease` 的那端，或桌面端优先）；手机焦点页只读时不该抢尺寸。
   - web `use-transport.ts:104-107`：attach 后的那次 resize 只在尺寸确实和 hello 里的 `cols/rows` 不同时才发（hello 本来就带了 rows/cols，`socket.ts:254-261`）。
   - `manager.attach` 不要用新来者的尺寸覆盖会话尺寸（`manager.ts:859-860`），或者只在第一个 attachment 时才设置。
   - direct 和 session-host 后端只有一个 pty，需要一个「谁的尺寸生效」的仲裁规则，同上。
   - 补测试：两个 attachment，一个 resize 后另一个的 pty 尺寸不变；手机焦点页 attach 不改变桌面端尺寸。
2. **身份层 announce 收窄**：`identity.ts` 只在会话真正出现、消失或换人时 `announce()`，CSRF 轮换和 Bearer 续期不算；`adoptCsrf` 不能因为 `forgetCsrf` 清空了令牌就当成「新会话」。`App.tsx:89-91` 的全量 `invalidateQueries()` 改成只在从无会话变成有会话时执行，或者只失效之前因 401/403 失败的查询。
3. **租约模式**：丢租约时只把画布切成只读，不清空、不重载；或者在 `releaseIdle` 后要求明确的编辑动作才能拿租约，单纯的触摸或指针按下不算（`markPresenceActivity` 目前在任何 pointerdown 上都会触发，`use-board-sync.ts:419-423`）。
4. **休眠唤醒**：旧页收到 `running` 后重连时，如果画面本来就是休眠占位，可以保留不 reset；属于低优先级。
