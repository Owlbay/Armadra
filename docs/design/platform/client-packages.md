# 页面与手机侧工作包：详细设计

> 状态：目标设计（2026-10-06）。本文是[落地总计划](../platform-implementation-plan.md)里 Armadra 仓 `apps/web` 与 `apps/mobile` 工作包的实现规格：**A1-1 多源连接层**、**A1-2 查询键与 store 加源**、**A1-4 「远程服务」设置页与侧栏分组**、**A1-5 手机多连接**、**A3-4 `relayed` 源与选路**、**A4-3 分享链接与落地页、组织页**。上位设计：[平台设计](../platform-saas-architecture.md) §5.4–§5.5、§6、§7、§17.6–§17.7；工程规范化 E1-3 的 `Source` 与 E2-3 的控制面客户端是本文的地基（[工程规范化包](engineering-packages.md) §2、§3）。
> 规矩：只用 `apps/web/src/ui/` 的 shadcn 组件；文案进 `apps/web/src/i18n/`（中英同步）；无说明性文字；凭据只在内存。

## §1 A1-1 多源连接层（`apps/web/src/sources/`）

### 1.1 模块

```text
apps/web/src/sources/
├── types.ts          SourceId、SourceKind、SourceDescriptor、SourceStatus、Via
├── registry.ts       SourceRegistry：源表（来源三种：本机 core 的 sources.list；手机的本地存储；云页面的云会话）；订阅变化
├── connection.ts     SourceConnection：一个源 = { descriptor, client (E1 createClient), http, ws, status, hello, renew(), connect(), disconnect() }
├── credentials.ts    CredentialProvider 接口：desktop（经本机 core sources.session）、mobile（钥匙串 + 远程服务）、browser-cloud（内存 + 云会话）
├── routing.ts        D27 选路：probeDirect(baseUrl, 1500 ms) 与 assertion 并行；结果 Via
├── managed-socket.ts ManagedSocket：换票、lib/backoff、4401 / 4403 / 4404 语义、online / visibility
├── context.tsx       <SourcesProvider>、useSources()、useSource(sourceId)、useCurrentSource()
├── local.ts          本机源（桌面：回环；服务器壳页面：同源；手机：无）
└── *.test.ts
```

### 1.2 类型

```ts
export type SourceKind = "local" | "direct" | "relayed" | "hosted";
export type Via = "local" | "direct" | "relayed";
export interface SourceDescriptor {
  sourceId: string;
  kind: SourceKind;
  label: string;
  baseUrl: string;
  relayOrigin: string;
  cloudIssuer: string;
  fingerprint: string;
  orderIndex: number;
}
export type SourceStatus = {
  state:
    | "idle"
    | "connecting"
    | "ready"
    | "offline"
    | "unauthorized"
    | "waitingForSource";
  via: Via | null;
  since: number;
  lastError: { code: string; message: string } | null;
};
export interface SourceConnection {
  readonly descriptor: SourceDescriptor;
  readonly status: SourceStatus; // 可订阅（useSyncExternalStore）
  readonly client: ArmadraClient; // E1 的 createClient(source)
  readonly hello: HelloInfo | null; // procedures[]、protocol、capabilities、sourceId（= hello.hostId）
  request(path: string, init?: RequestInit): Promise<Response>; // 过渡期：REST 残留
  socket(path: string, opts?): ManagedSocket; // 五条数据面流 + 控制面
  connect(): Promise<void>;
  disconnect(): void;
  renew(): Promise<void>;
}
```

`CredentialProvider`：`getAccess(sourceId, via): Promise<{ accessToken, expiresAtMs, httpBase, wsBase, relayToken? }>`、`refresh(sourceId, via)`、`invalidate(sourceId)`。

### 1.3 行为

- `connect()`：`routing.pick(descriptor, provider)` → `provider.getAccess` → `client.system.hello()`（E1）→ `hello.sourceId === descriptor.sourceId` 否则 `lastError = source_mismatch`；状态 `ready`。
- 401 → `renew()` 一次重放（现有 `bearerFetch` 逻辑按源实例化）；`renew` 失败且 `relayed` → `provider.refresh` 走远程服务重取断言；再失败 → `unauthorized`。
- `socket(path)`：每次（重）连前取票（经 `client.identity.wsTicket`）；`relayed` 时把 `armadra-relay.<relayToken>` 加进子协议；关闭码：4401 → 换票重连一次；4403 → `unauthorized`；4404 → `waitingForSource`（订阅远程服务的 `me.stream` `sourceOnline` 唤醒）；其它 → `lib/backoff`。
- 全局 `fetch` / `WebSocket` 补丁（`shell-transport.ts`）退役：E1-3 后 `installShellTransport` 只给本机 `Source` 装凭据；A1-1 结束时删除补丁与 `RUNTIME_URL`。
- `api/*` 自由函数签名：过渡期加可选第一参数 `source?: SourceConnection`（省略 = 当前源，从 context 取）；调用点随 A1-2 逐个补上。

### 1.4 测试

`connection.test.ts`（两源并存、401 续期一次、4401 换票重连、4403 失权、4404 等待 + 唤醒、`hello.sourceId` 不符）；`routing.test.ts`（直连通 / 超时 / hostId 不符 / 两者皆断）；`managed-socket.test.ts`（退避、`online` 跳过退避、可见时 ping）；`registry.test.ts`（远程源 `connect` 抛错不阻塞本机源 hydrate；排序）；现有 `api/*.test.ts` 全过（mock 改为注入 `SourceConnection`）。

## §2 A1-2 查询键与 store 加源

- 查询键：`["src", sourceId, ...]`；`app/workspaces-query.ts` 的 `useWorkspaces()` 变成对每个 `ready` 源各发一次，合并为 `{ sourceId, workspace }[]`。
- `canvas-store`：`workspace` 加 `sourceId`；`realtime/session.ts` 的 `live` 按 `(sourceId, boardId)`；`api/events.ts` 的 `current` → `Map<"${sourceId}:${workspaceId}", Connection>`（E2 后它是控制面订阅，每源一条连接）。
- store 键：`agent/status-store`、`drive-store`、`acp/store`、`dependency-store`、`coordinator` 等 `${sourceId}:${id}`；`hydrate(sessions, workspaceId, sourceId)`。
- 偏好：`armadra.openWorkspaces` 等 `{ sourceId, workspaceId }[]`；旧值一次性迁到 `local`（`preferences-store.ts` 的 `migrate`，测试覆盖）。
- `hello.hostId` 在页面里改叫 `sourceId`；`executionHostId` 不动。
- 测试：旧 localStorage 键迁移；两源各开一个工作空间时事件连接各一条；store 键不碰撞。

## §3 A1-4 「远程服务」设置页与侧栏（桌面 + 服务器壳）

### 3.1 导航与页面

`panels/settings/nav.ts` 加 `{ id: "remote", page: RemoteServicesPage, serverOnly: false }`（放在 `host` 之后）；`host` 保留为本机源详情。`panels/settings/pages/RemoteServicesPage.tsx` 两段（`SettingsRow` + `ui/card`、`ui/table`、`ui/badge`、`ResponsiveDialog`、`ui/input`、`ui/select`、`IconButton`）：

**远程服务**：列表（label、kind 徽标、`accountHint`、状态徽标 `registered` / `tunnel.state`、指纹短码）；「添加」→ `ResponsiveDialog` 选 kind：

- 个人中转：`issuer`、`account`、`password` → `sources.remoteAdd` → 答 `fingerprint_mismatch`（首次：响应里带指纹，对话框再问一次「确认指纹」→ 带 `fingerprint` 重调）；
- SaaS：`issuer`（缺省 `https://api.armadra.app`，可改）→ `sources.remoteAdd` → `deviceCode` → 显示 `userCode` + 「在浏览器打开」（`shell:open-external`）→ 轮询 `sources.remoteDevicePoll` 至 `ready`。

每行动作：「分享本机」（→ 3.2）、「停用分享」（`identity.cloud.revoke`）、「查看源」（→ 已挂载段的「从此服务添加」）、「移除」。

**已挂载的源**：列表（label、kind、via 徽标、状态、`lastOkAtMs`）；「添加自托管」→ 对话框：粘贴配对链接 / 输入 origin + 8 位码 → 显示指纹确认 → `sources.addDirect`；「从远程服务添加」→ 选服务 → `sources.remoteSources` 列表勾选 → `sources.mount`。每行：「断开」（`sources.forget`）、「移除」、拖动排序（`sources.update.orderIndex`）。本机行不可删。

### 3.2 分享本机（`panels/settings/ShareDialog.tsx`）

1. 选远程服务 → `identity.cloud.register({ issuer, registrationToken })`（页面先用 `sources.remoteSession` 的远程会话调远程服务 `sources.registrationToken`）→ 显示 `tunnel.state` 实时（事件 `cloud.tunnel`）。
2. 「生成邀请链接」：角色（`viewer/editor/operator/driver`）、有效期、次数 → `identity.invitations.create({ maxUses, role, … })` → 远程服务 `links.create({ kind: "source_invite", sourceId, invitationId, … })` → URL：`https://<issuer>/j/<linkId>#<secret?>.<invitationToken>`（personal 带 `secret`；saas 只有 `invitationToken`）→ 展示 + 二维码（`ui/qr` 若无则复用手机配对码已有的二维码组件）+ 复制。
3. 「停用」：撤邀请（core）+ `links.revoke`。

### 3.3 侧栏按源分组

`shell/Sidebar`（现有工作空间列表）按源分组：组头 = 源 label + 状态点（`member-dot` / `status-pill`）；离线源灰显、板只读（`canvas` 现有只读态）。`local` 组始终第一。

### 3.4 i18n

`apps/web/src/i18n/remote.ts`（中英）：`remote.title`、`remote.services`、`remote.sources`、`remote.add`、`remote.kind.personal`、`remote.kind.saas`、`remote.kind.direct`、`remote.share`、`remote.share.stop`、`remote.fingerprint.confirm`、`remote.deviceCode.open`、`remote.status.*`（`ready / connecting / offline / unauthorized / waitingForSource / disabled / draining / backoff`）、`remote.invite.*`、错误码映射 `MESSAGE_BY_CODE` 加 §31–§33 与协议包账号类错误码。

### 3.5 测试

`RemoteServicesPage.test.tsx`（添加个人中转的指纹两步；SaaS 设备码轮询；分享链接拼接；停用）；`Sidebar.test.tsx` 分组与离线态；i18n 守卫。桌面 A 档探针 `multi-source.mjs`（[验证](dev-stack-and-verification.md) §4.3）。

## §4 A1-5 手机多连接（`apps/mobile` + `apps/web/src/mobile/`）

- 原生桥 `bridge.ts`：`getSessions(): Session[]`、`setSession(s: { sourceId, origin, via, accessToken, refreshToken, expiresAtMs })`、`removeSession(sourceId, origin?)`、`getRemotes() / setRemote({ serviceId, issuer, kind, refreshToken, fingerprint })`；iOS `SecretStore` / Android `SecureStore` 以 `sourceId` / `serviceId` 为键多条；`armadra.sources`（无凭据的源表）在 Preferences。
- `mobile/connect.ts`、`ConnectScreen.tsx` 列表化：源列表 + 「添加连接」三选一（平台设计 §17.7）：扫码 / 局域网（现状）、个人中转（`issuer`、`account`、`password` → 页面直接调远程服务 `auth.login` → 指纹确认（原生 TLS 钉扎：`relayed` + personal 时钉 CA 指纹；saas 不钉）→ `me.sources` 勾选 → 每个源：`sources.assertion` → `cloud/login` → 钥匙串）、SaaS（设备码流：系统浏览器 + `armadra://cloud` 回到 App 后轮询）。
- `CredentialProvider` 的 mobile 实现从钥匙串读；`routing` 同桌面。
- 深链：`armadra://pair`（现状）、`armadra://join?link=&s=`（A4-3）、`armadra://cloud`（回到 App）。
- 测试：`connect.test.ts`（三种添加；同一源两种到达合并一行）；B 档 `mobile-shell-e2e` 加「扫两个码挂两源、杀 App 重开仍在」；真机只在用户账号下验。

## §5 A3-4 `relayed` 源（页面）

A1-1 已留接口；本包补：`relayToken` 头 / 子协议注入；`relayBaseUrl` 作为 `httpBase` / `wsBase`；4404 等待 + 远程服务 `me.stream` 唤醒（`sources/remote-stream.ts`：每个远程服务一条 WS，票经 `me.streamTicket`；事件 `sourceOnline` → 对应 `SourceConnection.connect()`；`sourceRevoked` / `accessRevoked` → 标记并提示）；状态徽标 `waitingForSource` 文案。测试：假中继答 4404 → 等待；推 `sourceOnline` → 1 秒内重连。

## §6 A4-3 分享链接落地、`#join`、组织页

### 6.1 落地页 `/j/<linkId>`（页面由远程服务托管，同一份 `apps/web`）

`app/use-link-fragments.ts` 加 `#join`（与 `#pair=` / `#invite=` 同一处理器）；路由 `/j/:linkId`（`App.tsx` 顶层判 `location.pathname.startsWith("/j/")`）→ `shell/JoinPage.tsx`：

1. `links.get(linkId)`（匿名）→ 显示 `label`、`role`、`sourceName`、过期；片段 `#<secret>.<invitationToken>` 解析（`secret` 可空）。
2. 需要账号（saas）→ 内嵌登录（口令 / passkey / 设备码「在应用里打开」）；personal 访客 → 直接「加入」。
3. `links.accept({ linkId, secret, device: { platform: "browser", name: navigator.userAgent 摘要 } })` → `{ sourceId, relayBaseUrl, assertion, relayToken }` → `POST <relayBaseUrl>/api/identity/cloud/login { assertion, invitationToken }` → 会话（内存）→ `SourceRegistry.add(relayed)` → 跳转画布。
4. 「在应用里打开」：`armadra://join?link=<id>&s=<片段>`（手机）；桌面显示「复制链接后在应用的远程服务页粘贴」。
5. 失败文案按 `code`（`link_expired / link_exhausted / link_secret_invalid / invitation_invalid / source_offline`）。

### 6.2 桌面 / 手机处理 `#join` 与 `armadra://join`

桌面：粘贴到「已挂载的源 → 添加 → 分享链接」输入框 → `sources.mountByLink({ url })`（新 procedure，§33 追加：core 解析 linkId / issuer / 片段，走 `links.accept` + `cloud/login`，存凭据）；手机：深链 → 同一流程在页面里做。

### 6.3 组织页（saas，`panels/settings/pages/OrganizationsPage.tsx`，`id: "orgs"`，只在有 saas 远程服务时显示）

组织列表 / 新建 / 成员与角色 / 组织加入链接（`links.create org_join`）/ 把本机源挂到组织（`orgs.sourceAttach`）。全部经 `sources.remoteSession` 的远程会话直接调远程服务（OpenAPILink，协议包契约）。

### 6.4 i18n 与测试

`i18n/links.ts`、`i18n/orgs.ts`；`JoinPage.test.tsx`（三条路径：saas 登录后加入、personal 访客加入、失败码）；`use-link-fragments.test.tsx` 加 `#join`；`OrganizationsPage.test.tsx`。验收「从链接到画布可见 ≤ 3 步」在 A 档探针 `link-join.mjs` 里量（[验证](dev-stack-and-verification.md) §4.4）。

## §7 浏览器从云端页面打开（saas）

`app.<cloud>` 托管同一份页面：启动时 `GET /.well-known/armadra-platform` 判 `webApp === location.origin` → `CredentialProvider` 用 `browser-cloud` 实现（云会话 = `__Host-` Cookie；各源 Bearer 在内存；刷新令牌不落 localStorage，关标签即丢，重开用云会话再取断言）；无本机源。CSP 由云端下发。测试：`credentials.browser-cloud.test.ts`。
