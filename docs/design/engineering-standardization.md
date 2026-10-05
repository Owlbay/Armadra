# 工程规范化：接口层、WebSocket、组件与检查工具

> 状态：目标设计（2026-10-06）。本文回答四个问题：接口要不要改成 RPC、WebSocket 怎么规范、前端组件哪些没按设计系统走、测试与检查工具缺什么；最后给分阶段计划与待拍板清单。平台侧（SaaS 中转、PostgreSQL / Redis、各端登录、多源挂载、多人协同）由 [平台与 SaaS 架构](platform-saas-architecture.md) 负责，本文只标出两者的依赖点。
> 现状来源：`apps/desktop/src/core/http/*`、`apps/web/src/api/*`、`packages/shared/src/api/*`、`apps/web/src/ui/*`、`tools/`、`repo.rules.json`、`.github/workflows/*`、[架构](../guides/architecture.md)、[core 的 JSON 面](../contracts/core-json-api.md)、[设计系统](design-system.md)。所有数字都是在 `docs/platform-saas-design` 分支上实际跑命令得到的，命令列在附录 A。

## 0. 结论

1. **「改 RPC 会不会更稳」——网络不会更稳，契约会。** 现有链路上真正会出事的不是 HTTP 本身，而是四件事：请求体形状只在前端 zod 里有、core 侧 26 个文件用 `typeof body.x` 手写校验（core 一处都没 import zod）；错误码两套拼法、119 个 `code:` 字面量没有注册表；5 条 WebSocket 各有一套帧格式与 4 套重连实现、core 侧没有心跳；客户端是单源的模块级常量（`RUNTIME_URL`、`runtimeApi` 单例、`events.ts` 只有一条 `current` 连接）。这四件事 RPC 能解决前两件，第三件要靠 WebSocket 规范，第四件要靠「源」抽象——而多源挂载与 SaaS 中转都压在第四件上。
2. **推荐方案 (b)：自研一层薄的 typed procedure，跑在现有 HTTP 与一条多路复用 WebSocket 之上**，不引入 JSON-RPC 全量走 WebSocket，也不引入开源 RPC 框架。procedure 定义放 `packages/shared/src/rpc/`，`input` / `output` / `errors` / `scope` 都是 zod；core 用同一份 schema 校验入参，前端客户端从定义推导类型，契约文档的形状表由定义生成。HTTP 传输是 `POST /api/rpc/{name}`，WebSocket 传输是 `/api/ws` 上的 `call` 帧，两者走同一个 dispatcher。
3. **REST 不是全部迁走。** 留在 REST 上的有：文件上传下载与资产（multipart、`Range`、`<img src>`）、hook 面 5 条路由（单文件 JS 客户端 `armadra-hook.js`）、身份域的匿名面（hello、配对、OAuth 回调要 302）、`/health`、Gateway 托管的页面。可迁的是 199 条路径里约 170 条 JSON 请求响应。
4. **WebSocket：控制面合一，数据面独立。** 事件流、订阅、RPC 流、以后的语言会话合到一条 `/api/ws`（文本 JSON 帧，带 `id` 多路复用、心跳、游标续订、换票）；终端（16 ms / 64 KiB 合帧）、实时协同（Yjs 二进制）、浏览器画面（JPEG 二进制）各保留自己的连接——它们的背压与帧格式和控制面不是一回事，塞进同一条连接只会让一个终端刷屏拖慢所有订阅。
5. **多源挂载要的第一块砖是 `Source`**：`{ origin, credentials, http, ws }` 一个对象一台 core，`createClient(source)` 代替今天的 `runtimeApi` 单例、`installShellTransport()` 改写全局 `fetch` 的做法。这一步在 RPC 内核（E1）里做，平台设计的多源挂载在它之上。
6. **组件：底子已经很整齐，剩的是尾巴。** 功能代码里 `<button` 为 0、`IconButton` 108 处全部有 `label`、i18n 守卫把写死中文压到 0。剩下的是 9 个原生 `<input type="checkbox">`、20 个原生 `<select>` / `<textarea>`、2 个没 `aria-label` 的图标 `Button`、8 个无 `alt` 的 `<img>`、4 处 `Loader2`、11 处手写卡片、5 处绕过 `ResponsiveDialog` 直接用 `ui/dialog`。全部列在 §4.1，一周内能清完。
7. **守卫从「扫描测试」升级到「lint 规则 + 扫描测试」。** 已有 5 条扫描守卫（`no-raw-button`、`no-raw-alert-dialog`、`spinner-label`、`type-scale`、`i18n` 三条）+ `no-electron` 边界守卫；缺的是原生表单控件、直接 import `ui/dialog` / `ui/sheet`、`<img alt>`、图标钮 `aria-label`、字面色值、错误码注册表。通用的那几条用 ESLint（`no-restricted-syntax`、`no-restricted-imports`、`jsx-a11y`）做，仓库语义的继续写扫描测试。
8. **检查工具：加 ESLint、knip、覆盖率报告；不加 Playwright；提交前钩子可选。** 仓库现在没有任何 lint（只有 Prettier 与 tsc）。ESLint 9 + typescript-eslint + react-hooks + jsx-a11y 先 warn 后 error、按目录收紧；knip 先出报告再按基线阻断（基线：web 未用导出 198 + 类型 82，desktop 363 + 145）；覆盖率先报告、再对 `core/http`、`shared`、`api/` 三处设 80% 门槛；CDP 探针三档体系保留，Playwright 不替代它。
9. **契约文档 `core-json-api.md` 的 §1–§30 编号保留**，形状表改为由 procedure 定义生成、嵌进各 § 的标记块内，散文与编号手写；新域从 §34 起（§31–§33 已由[平台设计](platform-saas-architecture.md)预分配）。`pnpm check` 多一条「生成物与源一致」的校验。
10. **分五个阶段**：E0 基线与守卫（1 周）→ E1 RPC 内核 + `Source` + 契约生成（2 周）→ E2 `/api/ws` 多路复用（2 周）→ E3 按域迁移（4–6 周，可并行）→ E4 清理旧路由与 E5 工具链收紧。平台设计里凡是「多源」「中转」「登录」的工作包都依赖 E1 / E2 完成。

## 1. 现状盘点

### 1.1 接口面

| 指标                                         | 数字                                                                      | 说明                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 路由表条目（`core/http/routes.ts`）          | 199 条路径、228 个 (方法, 路径)                                           | 196 条 `implemented: true`，3 条答 501；194 条 `runtime` 面，5 条 `hook` 面                                                            |
| 路由表之外的原样前缀（`server.raw(prefix)`） | 3 个                                                                      | `/api/identity/*`（身份域自己路由约 16 条路径）、`/api/identity/oauth/*`、`/api/automations/*`；表里各只占一行占位                     |
| WebSocket 路由                               | 5 条                                                                      | 事件流、终端、实时同步、语言会话、浏览器画面（§1.2）                                                                                   |
| handler 注册点                               | 177 处 `.handle(`，30 个文件，25 个域目录                                 | 路由门的权限由 `route-scopes.ts`（428 行）按路径族查表，不在注册点                                                                     |
| 契约文档                                     | 2118 行，30 个一级 §，70 个二级 §                                         | 代码里「契约 §N」字样 692 处（两份契约合计），直接写 `core-json-api` 的 18 处                                                          |
| `packages/shared` 的 zod                     | 548 个导出 `*Schema`，2679 个 `z.*` 构造，14 处 `z.unknown()` / `z.any()` | `errors.ts` 注释里的「347 个」已过时                                                                                                   |
| 前端请求调用                                 | 237 次 `request(`                                                         | `api/` 31 个模块 206 次；`acp/api.ts` 10、`workflow/api.ts` 11、`realtime/comments/store.ts` 5、`coordinator/api.ts` 2、诊断 2、推送 1 |
| 前端本地定义的 schema                        | 72 个 `z.object(`                                                         | `github.ts` 33、`accounts.ts` 11、`identity.ts` 10、`security.ts` 5——这些形状不在 `shared`，core 也看不见                              |
| 前端手写类型                                 | 79 个 `export interface/type`，49 处 `z.infer`                            | 手写的多是客户端自己的状态类型，不是线上形状                                                                                           |
| core 对请求体的校验                          | 0 个文件 import zod；26 个文件 `typeof body.x` 手写                       | core 只有 7 个文件 import `@armadra/shared`，拿的是类型与常量，不是 schema                                                             |
| 错误码                                       | 19 个 `coreError(` 码 + 119 个不同的 `code: "…"` 字面量                   | 前端 `MESSAGE_BY_CODE` 映射 31 条；GitHub 面 UPPER_SNAKE、其余 snake_case（契约 §3.3 承认是历史遗留）                                  |
| 错误形状                                     | `{ code, message }`                                                       | `apiErrorSchema` 已多一个可选 `requestId`；`RuntimeRequestError.body` 把 409 的原样 body 交给调用方                                    |
| 能力协商                                     | 两处                                                                      | `/health` 的 `capabilities: Record<string, boolean>`；`identity/hello` 的 `capabilities: string[]` + `protocol { major, minor }`       |
| 缓存头                                       | core 只在 Gateway 静态托管、OAuth、GitHub 出站上写                        | `/api/` 的 JSON 响应没有 ETag / Cache-Control，前端靠 `@tanstack/react-query`（104 个文件用）做缓存与失效                              |

读法：**线上形状有三份说法**——前端 zod（`shared` + 本地 72 个）、core 的手写校验、契约文档的表——三份靠人对齐。路由表只管「有哪条路、收什么方法、答不答」，不管形状。这就是漂移的结构性原因，与 HTTP 还是 RPC 无关。

### 1.2 WebSocket

| 流           | 路径                               | 帧                                                             | 鉴权                                       | 重连                                                          | 心跳                                  |
| ------------ | ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------- |
| 工作空间事件 | `…/workspaces/{id}/events?cursor=` | 文本 JSON；29 种事件 + `{"type":"cursor"}` 控制帧              | 升级前一次性票（`Sec-WebSocket-Protocol`） | `api/events.ts`：1 s → 10 s 指数，无抖动；4403 停；游标续订   | 无（`events/stream.ts` 第 15 行明写） |
| 终端         | `/api/terminals/{id}/ws?writer=`   | 文本 JSON（`hello` / `output` / `ack` …），16 ms / 64 KiB 合帧 | 同上                                       | `terminal/surface/use-transport.ts`：1 s → 10 s；`stale` 重建 | 无                                    |
| 实时协同     | `…/boards/{id}/sync`               | 二进制，y-protocols sync + awareness                           | 同上                                       | `realtime/client.ts`：500 ms × 2ⁿ ≤ 10 s；4403 转只读         | awareness 自带应用级过期              |
| 语言会话     | `…/language/sessions/{id}/stream`  | 文本，JSON-RPC 2.0                                             | 同上                                       | 上层决定（`editor/language/transport.ts` 不自己重连）         | 无                                    |
| 浏览器画面   | `…/browser/{nodeId}/stream`        | JSON 头帧 + 二进制 JPEG                                        | 同上                                       | `nodes/browser/StreamSurface.tsx` 自己一套                    | 无                                    |

共同点：升级前过路由门与 `guard`，升级后按 `onAccessChanged` 复核（4403）、按令牌到期复核（4401）；core 停机对所有连接 `terminate()`。差异点：五种帧格式、四套退避实现、没有统一的关闭码表、没有版本协商（只有身份 hello 的 `protocol`）、浏览器侧没有前后台感知。`maxFrameBytes` 已在 hello 里报（4 MiB）。

### 1.3 前端组件与守卫

- `apps/web/src/ui/` 49 个文件，`components.json` 指向它（`radix-nova`，`lucide`），生成文件不改；设计系统 §3.1–§3.3 的清单与仓库一致。
- 守卫测试 6 条：`panels/no-raw-button.test.ts`（功能代码 `<button` = 0）、`panels/no-raw-alert-dialog.test.ts`（只有 `ResponsiveDialog` 可 import `ui/alert-dialog`）、`panels/spinner-label.test.ts`（`Spinner` 必带本地化 `aria-label` 或 `aria-hidden`）、`styles/type-scale.test.ts`（无 11px 以下字号）、`i18n/i18n.test.ts`（中英键集合一致、无写死中文、键必须被引用）、`showcase/production.test.ts`（展示页不进生产包）；core 侧 `shell-core/no-electron.test.ts` 守 import 边界。
- 审计数据见 §4.1。

### 1.4 测试与检查工具

| 项              | 现状                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测            | Vitest 4.1：web 362 个文件 / 4141 个用例（jsdom）；desktop 406 个文件 / 4197 个用例（forks，含 `vitest.live.config.mts` 真 Chromium 一条）+ `node --test scripts/*.test.mjs`；server 11 / 84；shared 33 个文件；tools 21 个 `node:test` |
| 格式            | Prettier 3.6.2，无配置文件（默认），`format:check` 在 `pnpm check` 里                                                                                                                                                                   |
| 类型            | tsc 5.9 `strict` + `noUncheckedIndexedAccess`；`@ts-ignore` / `@ts-expect-error` 0 处，`as any` 1 处，`: any` 2 处                                                                                                                      |
| 仓库规则        | `tools/repo-check.mjs`（根目录白名单、黑名单、文档登记与相对链接、包名前缀、1500 行上限、迁移锁）；`tools/ci/validate-workflows.mjs`；`tools/release/version.mjs check`；`notices --check`                                              |
| 端到端          | `tools/ci/e2e.mjs` 三档，`e2e.d/` 19 条清单；A 档 12 条每次 push，B 档 nightly（linux / macos / mobile-ios / mobile-android / windows-acceptance / report 六个作业），C 档手动                                                          |
| CI              | `ci.yml`：三平台矩阵 + `e2e (tier a)`。最近一次（run 37344131164，2026-10-05）：linux 10 m 37 s（其中 `pnpm -r test` 7 m 54 s、`pnpm check` 1 m 39 s）、macOS 12 m 09 s、Windows 16 m 12 s、e2e 16 m 12 s；墙钟 ≈ 18 分钟               |
| 没有的          | ESLint / Biome、knip、覆盖率、git hooks、依赖漏洞扫描（只有 `pnpm-workspace.yaml` 的手工 `overrides` 与 `minimumReleaseAge`）、视觉回归（展示页探针只截图不比对）                                                                       |
| knip 一次性基线 | web：未用导出 198、未用导出类型 82、重复导出 7、未用依赖 1（`@codemirror/autocomplete`）；desktop：未用导出 363、类型 145、「未用文件」7（其中 `main/index.ts`、`preload/index.ts` 等是入口误报，要配 `entry`）                         |

## 2. 接口：要不要改成 RPC

### 2.1 「不稳定」来自哪里

把用户说的「稳定」拆开，对应到仓库里能指出来的东西：

| 现象                                          | 根源                                                                    | RPC 能不能治                                          |
| --------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| 页面某处突然渲染炸 / 字段 undefined           | 契约漂移：core 改了响应，前端 zod 没同步，或 72 个本地 schema 没人更新  | 能：output schema 唯一来源，core 出参也过同一份       |
| core 收到形状不对的请求体静默接受或 500       | core 用 `typeof body.x` 手写校验，没有 input schema                     | 能：input schema 在 core 入口 `parse`，400 带字段路径 |
| 同一类失败两种码（`NOT_FOUND` / `not_found`） | 没有错误码注册表                                                        | 能：`errors` 是 procedure 定义的一部分，注册表可测    |
| 断线后侧栏停在旧状态、重连风暴                | 四套重连、无心跳、无前后台感知                                          | 不能：这是 WebSocket 规范的事（§3）                   |
| 手机后台回来一段时间没反应                    | 同上 + 没有「可见时立即探活」                                           | 不能                                                  |
| 多源 / 中转做不了                             | 客户端单源：模块级 `RUNTIME_URL`、全局 `fetch` 改写、`events.ts` 单连接 | 不能，但做 RPC 客户端时顺手引入 `Source` 就解决了     |

诚实的结论：**RPC 不会让网络更稳，不会让重连更稳，它让「两端说的是不是同一句话」这件事从靠人变成靠类型与测试。** 这正是现在缺的，而且值得做；但如果只做 RPC 不做 §3 与 `Source`，用户感知到的「不稳」至少一半还在。

### 2.2 三个方案

| 维度            | (a) 保留 REST，契约即代码                               | (b) typed procedure，跑在 HTTP + 多路复用 WS 之上（推荐）                   | (c) 全量 WebSocket RPC（JSON-RPC 2.0）                                                          |
| --------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 消除类型漂移    | 能（路由表挂 schema）                                   | 能                                                                          | 能                                                                                              |
| 改动量          | 小：路由表每行加 `input` / `output`，前端客户端按表生成 | 中：新 dispatcher、新客户端，按域迁移 237 处调用                            | 大：237 处调用 + 177 处 handler + 所有依赖 HTTP 语义的测试（core 78 个测试文件按路径 dispatch） |
| 路径与 §N 引用  | 完全保留                                                | 新 procedure 名与旧路径一一登记，§N 保留（§2.8）                            | 路径消失，契约文档要重写                                                                        |
| 多源挂载        | 要另做 `Source`                                         | `Source` 是客户端的一部分                                                   | 同左                                                                                            |
| SaaS 中继       | 中继转发 HTTP + 5 条 WS，每条 WS 各自鉴权               | 中继转发 HTTP + 1 条控制面 WS + 数据面 WS；控制面帧有统一 envelope 可做路由 | 中继只转发 WS；但文件、OAuth 回调、hook 面仍要 HTTP，等于还是两套                               |
| 手机后台断线    | 请求响应天然无状态，重连只影响 WS                       | 同 (a)：请求响应走 HTTP 时不受 WS 断线影响；走 WS 时按 §3.3 重发            | 所有请求都挂在 WS 上：后台回来先重连再发请求，每次都多一个 RTT，且要自己做请求级超时与重放      |
| HTTP 缓存 / CDN | 可用（但现在没用）                                      | 可用（REST 残留 + `GET` 形式的 query 可选保留）                             | 不可用                                                                                          |
| 文件上传下载    | 原生                                                    | 留在 REST                                                                   | 要自己分片或旁路回 HTTP                                                                         |
| DevTools 可调试 | 最好：Network 面板一行一请求                            | HTTP 传输同 (a)；WS 帧在 Messages 面板里要靠 `id` 对                        | 全在 WS Messages 里，筛选困难                                                                   |
| 迁移风险        | 低                                                      | 中（新旧并存一个版本）                                                      | 高（没有并存，要一次切）                                                                        |
| 不解决的        | 5 条 WS 仍各自为政；`Source` 仍要另做                   | —                                                                           | —                                                                                               |

为什么不是 (a)：它把 schema 挂在路由表上，但路由表只认 `(method, path)`，`GET` 的入参在 query 里、`POST` 在 body 里、路径参数又是一处，一个「input」要拆三份；订阅与流也不在表里。做完 (a) 再做订阅、再做多源，等于分三次做 (b)。

为什么不是 (c)：JSON-RPC 2.0 本身很好（语言服务已经在用），问题在「全量」——文件、OAuth 302、hook 面的单文件客户端、`<img src>` 都离不开 HTTP，所以 (c) 实际是「WS 为主 + HTTP 残留」，和 (b) 一样是两套传输，但把请求响应也挂在了最不稳的那条连接上。手机后台回来、网络切换、中继重启，HTTP 请求各自失败各自重试，WS 上的请求要先等连接恢复；(b) 让请求响应默认走 HTTP，正是为了把「请求」和「连接」解耦。

为什么自研而不是引开源 typed-RPC 库：要塞进去的东西全是本仓库特有的——`Sec-WebSocket-Protocol` 一次性票、Cookie + CSRF 与 Bearer 两种凭据、`route-scopes` 的权限族、§N 编号、`Source` 多源、中继的 principal 透传、以 `cursor` 续订的事件流。这些在任何库里都要绕；而 `procedure(name, input, output)` + 一个 dispatcher + 一个客户端本身不到一千行。若评估开源库，要核实两点：对 zod 4（本仓库 4.4.3）的支持、订阅是否能跑在自定义 WS envelope 上。

### 2.3 推荐方案的形状

#### 2.3.1 procedure 定义（`packages/shared/src/rpc/`）

```ts
// packages/shared/src/rpc/define.ts
export interface ProcedureDef<I extends z.ZodType, O extends z.ZodType> {
  /** `<域>.<动词>`，camelCase：`workspaces.list`、`boards.saveSnapshot`、`terminals.wake` */
  readonly name: `${string}.${string}`;
  readonly kind: "query" | "mutation" | "subscription" | "stream";
  readonly input: I;
  readonly output: O; // subscription / stream 时是每一帧的形状
  /** 这条会答的错误码（注册表里的键），文档生成与测试用 */
  readonly errors: readonly ErrorCode[];
  /** 与 route-scopes 同一套词：`boards:write`、`settings:read`；`null` = 匿名面 */
  readonly scope: string | null;
  /** 绑定工作空间的入参字段名；没有则是全局授权 */
  readonly workspaceKey?: keyof z.infer<I> & string;
  /** 允许的传输；默认 query/mutation 走 ["http","ws"]，subscription/stream 只 ["ws"] */
  readonly transports?: readonly ("http" | "ws")[];
  /** 从哪个协议小版本起有；文档生成写进「自 1.N」 */
  readonly since: `${number}.${number}`;
  /** 迁移期：对应的旧 REST 路径与方法，生成文档的「原路径」列并让旧路径仍能答 */
  readonly legacy?: { method: string; path: string };
  /** 契约文档里的落点，生成器据此把表写进那一节 */
  readonly contract: `§${number}` | `§${number}.${number}`;
}

export const workspacesList = defineProcedure({
  name: "workspaces.list",
  kind: "query",
  input: z.object({}),
  output: z.object({ workspaces: z.array(workspaceSchema) }),
  errors: ["unauthenticated"],
  scope: "workspaces:read",
  since: "1.1",
  legacy: { method: "GET", path: "/api/workspaces" },
  contract: "§34.1",
});
```

规矩：

- 一个域一个文件 `rpc/<domain>.ts`，`rpc/index.ts` 导出 `PROCEDURES` 数组；一条测试断言名字唯一、`contract` 唯一、`errors` 全在注册表、`scope` 全在权限词表。
- `output` 禁止 `z.unknown()` / `z.any()`（现在 shared 有 14 处，迁移时逐个落实形状；确实是「原样 JSON」的用 `jsonValueSchema`）。
- 命名：域名用现有目录名（`workspaces`、`boards`、`terminals`、`git`、`identity`、`acp`、`workflows`、`push`、`gateway`、`forge`、`mail`、`credentials`、`diagnostics`），动词用 `list / get / create / update / delete / <业务动词>`；订阅用名词 `events.workspace`、`resources.samples`；流用 `<域>.<名词>Stream`。
- 编码规则沿用契约 §2（camelCase、int64 为十进制字符串、零值照写、未知字段忽略）；zod 层面统一 `z.object` 非 strict（未知键剥离而不拒绝）。

#### 2.3.2 错误

- 形状仍是 `{ code, message }`，加可选 `requestId`（schema 已有）与可选 `details?: Record<string, unknown>`（给 409 这类要带指纹、修订号的拒绝，替代今天 `RuntimeRequestError.body` 的「原样 body」）。是否加 `details` 列入决策 F4。
- 码一律 snake_case；注册表 `packages/shared/src/rpc/errors.ts`：`code → { http: number, i18n: string }`。GitHub 面的 UPPER_SNAKE 在 `forge` / `github` 域迁移时改成 snake_case，旧拼法由前端 `MESSAGE_BY_CODE` 映射保留一个 minor 版本。
- core 的 `coreError(status, code, message)` 改为 `fail(code, message, details?)`，状态码查注册表；一条测试扫 core 源码里所有 `code: "…"` 字面量都在注册表里（现在 119 个）。
- 入参校验失败答 `bad_request`，`details.issues` 是 zod issue 列表（路径 + 消息），前端表单可逐字段提示。

#### 2.3.3 版本与兼容

- 协议版本就是 `identity/hello` 的 `protocol { major, minor }`，RPC 层不另起一套。同一 major 内只增不改：新 procedure、新可选字段、新枚举值；去掉 procedure 先标 `deprecated: "1.N"` 一个 minor 版本，再删——删后答 `not_implemented`（与路由表「表里有、没写」同一语义）。
- 客户端在 hello 里拿到 `procedures: string[]`（取代 `capabilities` 里按面板开关的布尔）；面板按「这台 core 有没有这条 procedure」决定开不开——与多源挂载正好对上：不同源版本不同，按源判断。
- `since` 写进定义，文档生成器写进表；破坏性改动必须 major +1，hello 不匹配时页面整页提示更新（今天没有这一步）。

#### 2.3.4 鉴权贯穿

| 传输 | 凭据                                                                                               | 不变的部分                                                                             |
| ---- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| HTTP | 桌面壳 / 原生 App：`Authorization: Bearer`；服务器壳 / Gateway 浏览器：Cookie + `X-Armadra-CSRF`   | 准入门（`identity/loopback.ts` 与 Gateway 准入）在 dispatcher 之前，一个字都不改       |
| WS   | 升级时 `Sec-WebSocket-Protocol: armadra-ticket.<票>, armadra-mux.v1`                               | 票仍由 `POST /api/identity/ws-ticket` 签，30 秒一次性，绑来源                          |
| 中继 | 中继在 TLS 一侧认人，往 core 转发时带 principal（形状由平台设计定）；core 只认「中继签名的身份头」 | `runAs(identity)` 的身份上下文不变；路由门改为读 procedure 的 `scope` + `workspaceKey` |

`scope` 从 `route-scopes.ts` 的 428 行正则表搬到每条 procedure 定义上；`route-scopes.test.ts` 的覆盖率用例改为「每条 procedure 都声明了 scope」。REST 残留路由继续查旧表。关键区别：今天 `bearerFetch` / `ticketedWebSocket` 改写的是**全局** `fetch` / `WebSocket`，只认一个 origin；改为 `Source.http` / `Source.ws` 两个实例方法，每个源一套凭据与换票，全局不再被改写。

#### 2.3.5 订阅与流

| 种类           | 例                                                  | 传输                 | 语义                                                                                                                     |
| -------------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `subscription` | `events.workspace { workspaceId, cursor? }`         | `/api/ws` 控制面     | 服务端推、客户端只退订；`cursor` 续订与今天一样（`floor` / `watermark`，409 变成 `end { reason: "snapshot_required" }`） |
| `subscription` | `resources.samples`、`acp.session`、`workflows.run` | 控制面               | 同上；可合并的（资源采样）标 `coalesce: true`，背压时只留最新一帧                                                        |
| `stream`       | 语言会话（JSON-RPC 双向）                           | 控制面（E3 末评估）  | 双向：客户端 `send` 帧、服务端 `evt` 帧，同一个 `sid`                                                                    |
| 独立连接       | 终端、Yjs 实时同步、浏览器画面                      | 各自 WS，不进 RPC 层 | 帧格式不变；只统一 §3.3 的生命周期（心跳、退避、关闭码、换票）                                                           |

### 2.4 迁移路径

原则：**新旧并存一个 minor 版本，按域分批，每批有验收，任何一批可以单独回滚。**

1. **E1 内核**（不动任何现有路由）：`shared/rpc/`、core `http/rpc.ts`（`POST /api/rpc/{name}` 挂进路由表一行 `/api/rpc/{name}`；dispatcher 做 `input.parse` → handler → `output.parse`（开发态与测试态必开，生产可按 `ARMADRA_RPC_VALIDATE_OUTPUT` 关）→ 错误注册表映射）、web `api/rpc.ts`（`createClient(source).call(def, input)`）、契约生成器。试点域：`workspaces`（8 次调用）与 `settings`（18 次）。
2. **每个域一批**，做法固定：
   - 在 `shared/rpc/<domain>.ts` 写定义，`legacy` 指向旧路径；
   - core 的域 `install()` 改为 `rpc.handle(def, fn)`；dispatcher 自动按 `legacy` 把旧路径也接到同一个 handler（旧路径的 query / path 参数按定义里的 `legacyBind` 映射成 input），旧路径的用例不改；
   - web 的 `api/<domain>.ts` 改为 `client.call(def, …)`，保留函数签名，调用点不改；
   - 验收：① 该域的旧路径与新 procedure 对同一夹具输出 `canonicalJson` 相等（`contract/parity.test.ts`，复用 `contract/message.ts` 的规范化）；② 该域的 web 用例与 core 用例全绿；③ 文档生成无 diff；④ A 档 e2e 不变。
3. **批次顺序**（按调用数与风险）：`workspaces` / `settings` → `boards`（11 条路径、10 次调用，含 presence / lease）→ `files` 的 JSON 部分（上传下载留 REST）→ `terminals` 的 HTTP 部分 → `agents`（27 次）→ `git` + `git-repository`（35 条路径、40 次调用，最大的一批，可拆两次）→ `forge` / `github`（33 个本地 schema 搬进 shared，错误码换拼法）→ `identity` / `security` / `accounts`（原样前缀改成 procedure；hello、配对、ws-ticket、OAuth start/callback、password-reset 链接留 REST 匿名面）→ `acp` / `workflows` / `push` / `coordinator` / `mail` / `credentials` / `gateway` / `diagnostics`。
4. **E4 清理**：该域旧路径在下一个 minor 版本删除（路由表删行、`legacy` 字段删除、`route-scopes` 删对应规则）；最终 `routes.ts` 只剩 REST 残留（估 25–30 行：文件、资产、hook 面 5 条、身份匿名面约 8 条、health、`/api/rpc/{name}`、5 条 WS）。

成本估算：237 处调用 + 177 处 handler；web `api/` 169 个用例多数只改 mock 的 URL（10 个文件 stub 了 `fetch`）；core 78 个测试文件按路径 dispatch，旧路径保留期内不改，E4 删路径时改成 `rpc.dispatch(def, input)`。按一个域 1–3 天、可两人并行，E3 四到六周。

### 2.5 契约文档的处理

- `docs/contracts/core-json-api.md` 的 §1–§30 编号与散文保留；每节「形状」表改成标记块：

  ```md
  <!-- rpc:begin contract=§9.2 -->

  | procedure | kind | input | output | errors | scope | 自 | 原路径 |
  | … 生成 … |

  <!-- rpc:end -->
  ```

  `tools/contract/generate.mjs` 从 `PROCEDURES` 用 zod 4 的 `z.toJSONSchema` 渲染字段表（嵌套对象展开两层，再深的链接到同节的 `<details>`），只改标记块内的内容；`--check` 模式比对 diff，挂进 `pnpm check`。

- 新域从 §34 起（§31–§33 预分配给平台设计的云登录、隧道面与客户端源表），一域一节；§34 先给 `workspaces` / `settings` 试点。没迁的节保持手写，生成器不碰没有标记块的节。
- `docs/README.md` 的 contracts 段加一句「§N 的形状表由 `tools/contract/generate.mjs` 生成，改形状改 `packages/shared/src/rpc/`，不手改表」。
- 代码里 692 处「契约 §N」注释不动：编号没变。

## 3. WebSocket 规范

### 3.1 要不要合成一条连接

结论：**控制面合一（`/api/ws`），数据面独立。**

| 流              | 去向              | 理由                                                                                                                                                                                            |
| --------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件流          | 合入控制面        | 低频、文本、已有游标续订；合入后一个工作空间 N 个面板不再各自开连接，多源时一源一条                                                                                                             |
| 新订阅与 RPC 流 | 控制面            | 本来就不存在，直接按新帧写                                                                                                                                                                      |
| 语言会话        | 先独立，E3 末评估 | 已是 JSON-RPC 文本帧，技术上能做 `stream`；但补全请求的频率与体积不小，先量再决定                                                                                                               |
| 终端            | 独立              | 16 ms / 64 KiB 合帧、一个 PTY 刷屏可到每秒几 MB；`ws` 的 `bufferedAmount` 是整条连接的，合进控制面就是「一个 `cargo build` 让侧栏事件排队」。多会话也不合成一条：一条连接一个会话，背压各算各的 |
| 实时协同        | 独立              | 二进制 y-protocols，客户端与 `y-websocket` 同一编码，合并要给二进制帧加 envelope 没有收益                                                                                                       |
| 浏览器画面      | 独立              | JPEG 二进制，一个节点一个观看者（409 已在升级前判）                                                                                                                                             |

代价：多源时每源最多 1 + 终端数 + 板数 + 画面数条连接——与今天相同，只少了事件流的重复；中继要转发的是「控制面 1 条 + 数据面 N 条」，数据面帧原样透传，不解析。

### 3.2 控制面帧

文本 JSON，一行一帧（`maxFrameBytes` 沿用 hello 的 4 MiB）：

| `t`             | 方向  | 字段                                                                                                       | 说明                                                                                                |
| --------------- | ----- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `hello`         | S → C | `protocol {major,minor}`、`procedures[]`、`heartbeatMs`、`maxFrameBytes`、`sessionExpiresAt`、`instanceId` | 升级后第一帧；`instanceId` 变了说明 core 重启，客户端清易失缓存（替代今天 `onWorkspaceConnection`） |
| `call`          | C → S | `id`、`name`、`input`                                                                                      | 请求响应（query / mutation 走 WS 时）                                                               |
| `result`        | S → C | `id`、`output`                                                                                             |                                                                                                     |
| `error`         | S → C | `id` 或 `sid`、`code`、`message`、`details?`                                                               |                                                                                                     |
| `sub`           | C → S | `sid`、`name`、`input`                                                                                     | `input` 里可带 `cursor`                                                                             |
| `ack`           | S → C | `sid`、`cursor?`                                                                                           | 订阅已建立；带游标的订阅报当前水位                                                                  |
| `evt`           | S → C | `sid`、`seq?`、`data`                                                                                      | 一帧一事件；可续订的流带 `seq`                                                                      |
| `send`          | C → S | `sid`、`data`                                                                                              | 双向流的上行                                                                                        |
| `end`           | 双向  | `sid`、`reason`、`cursor?`                                                                                 | `unsubscribed` / `overflow` / `snapshot_required` / `forbidden` / `gone`                            |
| `ping` / `pong` | 双向  | `ts`                                                                                                       | 应用级心跳（浏览器发不了 WS 层 ping）                                                               |

`id` / `sid` 由客户端生成（单调整数即可），服务端不复用。帧 schema 也放 `shared/rpc/frames.ts`，两端同一份。

### 3.3 生命周期

| 环节     | 规则                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本协商 | 升级时客户端报 `Sec-WebSocket-Protocol: armadra-ticket.<票>, armadra-mux.v1`；服务端选一个子协议回；不认识的 major 以 `4409` 关闭，客户端不重连、整页提示更新                                                                                                                                                                                                                                |
| 换票     | 每次（重）连前 `POST /api/identity/ws-ticket`；4401 关闭 = 令牌到期，刷新 Bearer 后换票立即重连一次，不退避；换票失败按 HTTP 的 401 流程走（复核 → 刷新 → 重新配对）                                                                                                                                                                                                                         |
| 心跳     | 服务端每 `heartbeatMs`（默认 25 s）发 `ping`，连续 2 次无 `pong` 则 `terminate()`；客户端在页面可见时每 30 s 发 `ping`，无 `pong` 3 s 视为断线主动关闭重连。Node 侧另开 `ws` 层 ping 给中继与代理保活（很多代理 60 s 空闲断）                                                                                                                                                                |
| 前后台   | `visibilitychange` → 可见：立刻发 `ping`，3 s 无回应就重连并带游标续订；`pagehide` / 隐藏：不主动断，由系统断；`online` 事件：立刻重连（跳过当前退避）                                                                                                                                                                                                                                       |
| 重连退避 | 统一一份 `backoff(attempt)`：`min(cap, 500 ms × 2^attempt)` + 全抖动（随机 0–100%）；前台 cap 10 s，后台 cap 30 s；连接打开过则 `attempt` 归零。四套实现（`events.ts`、`use-transport.ts`、`realtime/client.ts`、`StreamSurface.tsx`）换成 `lib/backoff.ts` 这一份，数据面连接也用                                                                                                           |
| 关闭码   | `1000` 正常；`1001` core 停机（客户端按退避重连）；`4400` 坏帧；`4401` 令牌到期（换票重连）；`4403` 授权收回（停，通知页面，与今天一致）；`4409` 协议版本不兼容（停）；`4413` 帧超限；`4429` 订阅数超限（停，提示）                                                                                                                                                                          |
| 多路复用 | 一条连接上 `sid` 不限种类；每源一条控制面连接，`Source` 持有；服务端按身份限制订阅总数（默认 256）                                                                                                                                                                                                                                                                                           |
| 背压     | 服务端每订阅一个有界队列（默认 1024 帧），连接的 `bufferedAmount` > 1 MiB 时：`coalesce: true` 的订阅只留最新一帧；可续订的订阅（事件流）丢队列并以 `end { reason: "overflow", cursor }` 结束，客户端从 `cursor` 重订，缺口由 outbox 补发；都不是的（ACP 会话）关闭订阅让客户端重读。数据面连接：终端保持现有 64 KiB 合帧，`bufferedAmount` 超 4 MiB 时暂停读 PTY（今天没有这一步，列入 E2） |
| 续订     | `evt.seq` 单调；客户端只前进；`sub` 带 `cursor` 时服务端先补发再接实时（与今天的 `?cursor=` 一样）；`ack.cursor` 替代今天的 `{"type":"cursor"}` 控制帧                                                                                                                                                                                                                                       |
| 调试     | 开发态在 `hello` 后支持 `?trace=1`：服务端每帧附 `_t`（处理耗时 ms）；DevTools Messages 面板按 `sid` 过滤                                                                                                                                                                                                                                                                                    |

中继透传要求（平台设计用）：控制面帧 envelope 固定，中继只看 `t` 与 `sid` 就能做路由与配额；数据面不解析。中继重启表现为 `1001`，客户端按退避重连并续订。

## 4. 通用组件审计

### 4.1 问题清单（带数据）

扫描范围 `apps/web/src`，排除 `ui/`、`*.test.*`、`showcase/fixtures/`。命令见附录 A。

| 类别                                               | 数量          | 位置（文件:行）                                                                                                                                                                                                                                                                                                                                                                                                                                           | 整改                                                                                                                                               |
| -------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手写 `<button>`                                    | 0             | —                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 已有守卫                                                                                                                                           |
| 原生 `<input type="checkbox">`                     | 8             | `nodes/DiffNode.tsx:112`、`panels/automation/CreatePlanForm.tsx:652`、`panels/git/commit/CommitMessage.tsx:143`、`:170`、`panels/git/commit/ChangeTree.tsx:66`、`panels/git/RepositoryConfirmDialog.tsx:163`、`panels/git/forms.tsx:30`、`agent/CapabilityInheritance.tsx:57`                                                                                                                                                                             | 换 `ui/checkbox`（已存在），`accent-[var(--brand)]` 这种内联取色随之消失                                                                           |
| 原生 `<input type="text">`                         | 1             | `session/SignIn.tsx:310`                                                                                                                                                                                                                                                                                                                                                                                                                                  | 换 `ui/input` + `ui/field`                                                                                                                         |
| 原生 `<select>`                                    | 19            | `panels/settings/pages/GithubPage.tsx:127`、`ForgeConfigs.tsx:192`、`panels/github/link-targets.tsx:130`、`PullDetail.tsx:384`、`Filters.tsx:122`、`StatusMappingEditor.tsx:159`、`:309`、`:375`、`ForgeHosted.tsx:176`、`:775`、`CheckoutWorktree.tsx:174`、`panels/git/RebaseTodo.tsx:137`、`:156`、`CommitMessageAssistant.tsx:183`、`:197`、`Reflog.tsx:247`、`CherryPick.tsx:140`、`commit/StashDialogs.tsx:62`、`log/menus/worktree-dialog.tsx:139` | 换 `ui/select`；集中在 GitHub 面板与 Git 日志，说明那两块是在设计系统之前写的                                                                      |
| 原生 `<textarea>`                                  | 1             | `canvas/whiteboard/nodes/InlineText.tsx:104`                                                                                                                                                                                                                                                                                                                                                                                                              | 画布内行内编辑，可豁免（`i18n-exempt` 同款标记 `ui-exempt: 画布行内编辑`），但要加 `aria-label`                                                    |
| 手写 `role="dialog"`                               | 1             | `shell/MobileFocusPage.tsx:66`                                                                                                                                                                                                                                                                                                                                                                                                                            | 评估换 `Sheet side="bottom"`；若因全屏焦点页保留，补焦点陷阱与 `aria-modal`                                                                        |
| 直接 import `ui/dialog`（绕过 `ResponsiveDialog`） | 5             | `grep -rln 'ui/dialog"' apps/web/src --include='*.tsx' \| grep -v /ui/`                                                                                                                                                                                                                                                                                                                                                                                   | 与 `no-raw-alert-dialog` 同款守卫扩到 `ui/dialog`；`ResponsiveDialog` 已被 52 个文件用                                                             |
| 直接 import `ui/sheet`                             | 15            | 同上命令换 `ui/sheet`                                                                                                                                                                                                                                                                                                                                                                                                                                     | 盘点哪些是「手机底部面板」的正当用法，其余经 `ResponsiveDialog`；列白名单                                                                          |
| 图标 `Button` 无 `aria-label`                      | 2             | `canvas/whiteboard/StylePanel.tsx:233`、`:242`                                                                                                                                                                                                                                                                                                                                                                                                            | 改用 `IconButton`（`label` 必填）                                                                                                                  |
| `IconButton` 无 `label`                            | 0             | 108 处全部有                                                                                                                                                                                                                                                                                                                                                                                                                                              | 类型已强制                                                                                                                                         |
| `<img>` 无 `alt`                                   | 8             | `ui/brand-mark.tsx:13`、`nodes/browser/WebviewTabs.tsx:54`、`WebviewGuest.tsx:537`、`WebviewSurface.tsx:386`、`nodes/editor/MediaPreview.tsx:138`、`MarkdownPreview.tsx:14`、`canvas/whiteboard/nodes/ImageNode.tsx:17`、`:37`                                                                                                                                                                                                                            | 装饰性的写 `alt=""`，内容性的用文件名 / 页面标题                                                                                                   |
| `Loader2` 残留                                     | 4             | `grep -rn Loader2 apps/web/src --include='*.tsx'`                                                                                                                                                                                                                                                                                                                                                                                                         | 换 `Spinner`（设计系统 §3.2）                                                                                                                      |
| 手写卡片 `border bg-card`                          | 11            | 同上命令                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 换 `ui/card`                                                                                                                                       |
| `window.alert / confirm / prompt`                  | 0             | 7 个命中都是同名局部函数或 ACP 的 `prompt()` 方法                                                                                                                                                                                                                                                                                                                                                                                                         | 无                                                                                                                                                 |
| 字面十六进制色                                     | 69            | `terminal/surface/appearance.ts` 20、`canvas/whiteboard/palette.ts` 13、`panels/git/log/graph.ts` 7、`panels/git/CommitGraph.tsx` 6、`app/use-canvas-preferences.ts` 4、其余零星                                                                                                                                                                                                                                                                          | 终端主题与白板调色板是**数据**（用户可选的颜色），豁免并集中到 `*/palette.ts`；Git 图的 7 + 6 处与 `use-canvas-preferences.ts` 的 4 处要改读 token |
| `rgb() / hsl() / oklch()` 字面量                   | 4             | `showcase/harness.tsx` 2（对比度计算）、`lib/contrast.ts` 2                                                                                                                                                                                                                                                                                                                                                                                               | 都是计算用，豁免                                                                                                                                   |
| Tailwind 调色板类（`bg-red-500` 等）               | 0             | —                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 已干净                                                                                                                                             |
| `dark:` 分支                                       | 1             | —                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 删除（设计系统 §1 原则 1）                                                                                                                         |
| 内联 `style={{…}}`                                 | 114           | `showcase/sections/*` 20、`realtime/CursorLayer.tsx` 6、`panels/git/log/LogTable.tsx` 6、`CommentLayer.tsx` 3、`GroupNode.tsx` 3 …                                                                                                                                                                                                                                                                                                                        | 位置、变换、虚拟列表高度是合理用法；守卫只禁 `style` 里出现 `color` / `background` / `fontSize` 键                                                 |
| 任意像素值 `[Npx]`                                 | 643           | `panels/github/ForgeHosted.tsx` 20、`PullDetail.tsx` 15、`automation/CreatePlanForm.tsx` 14 …                                                                                                                                                                                                                                                                                                                                                             | 不作为违规计数；规范：宽高用 `tokens.css` 的 `--panel-*` / `--node-*` 常量或 Tailwind 刻度，新代码禁止 `[Npx]` 用于字号与间距（字号已有守卫）      |
| 任意 z 轴 `z-[N]`                                  | 27            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 改用 `tokens.css` §2.11 的 `--z-*`                                                                                                                 |
| 重复实现                                           | 5             | `formatBytes` ×2、`clamp` ×3                                                                                                                                                                                                                                                                                                                                                                                                                              | 合到 `lib/format.ts` / `lib/math.ts`                                                                                                               |
| 写死中文                                           | 0             | 247 个 CJK 命中全在注释（守卫去注释后为 0）                                                                                                                                                                                                                                                                                                                                                                                                               | 已有守卫                                                                                                                                           |
| 未用导出（knip）                                   | 198 + 82 类型 | 见 §1.4                                                                                                                                                                                                                                                                                                                                                                                                                                                   | E0 建基线，E5 阻断新增                                                                                                                             |

### 4.2 规范

**分层**（不改目录，只定边界并写进设计系统 §3）：

| 层        | 位置                                                                          | 允许                                                                                                                                     | 禁止                                                                                     |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ui 原语   | `apps/web/src/ui/`                                                            | shadcn CLI 生成件；仓库薄封装只做取色与尺寸预设（`icon-button`、`status-pill`、`agent-avatar`、`member-dot`、`color-dot`、`brand-mark`） | 业务逻辑、i18n、store、`api/` import；手改生成件                                         |
| 复合件    | `panels/ResponsiveDialog.tsx`、`panels/settings/SettingsRow.tsx` 这类跨域复合 | 组合原语 + 响应式规则；无业务数据                                                                                                        | 直接调 `api/`；一个复合件被两个域以上用时才有资格进这一层                                |
| 业务组件  | 各域目录（`nodes/`、`panels/<域>/`、`acp/`、`workflow/` …）                   | 读 store / query、调 `api/`、组合上面两层                                                                                                | 原生表单元素、`<button>`、字面色值、`dark:`、直接 import `ui/dialog` / `ui/alert-dialog` |
| 面板 / 页 | `panels/*Panel.tsx`、`shell/*Page.tsx`                                        | 布局与导航                                                                                                                               | 同上                                                                                     |

**命名**：`ui/` 文件 kebab-case（生成件）；业务组件 PascalCase 文件 = 默认导出名（knip 报的 7 个「重复导出」是同一组件既具名又默认导出，统一只用具名导出）；hook 文件 `use-*.ts`；一个文件一个组件，超过 1500 行由 repo-check 挡。

**token**：颜色、圆角、字号、动效、z 轴只从 `tokens.css` 取（设计系统 §2）；功能代码里不出现字面色值；例外只有「用户可选的颜色数据」且必须集中在 `palette.ts` / `appearance.ts` 并在守卫白名单里登记。

**禁止事项**（守卫可测的）：`<button>`、`<input>`（`type="file"` / `"hidden"` 除外）、`<select>`、`<textarea>`、`<dialog>`、`role="dialog"` 手写；import `ui/dialog` / `ui/alert-dialog` / `ui/sheet`（白名单外）；`Loader2`；`dark:`；`#rgb` 字面量（白名单外）；`z-[`；图标钮无 `aria-label`；`<img>` 无 `alt`；写死中文；`Spinner` 无标签。

### 4.3 守卫：已有与缺口

| 守卫                                                               | 现状                     | 落点                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手写 `<button>`                                                    | 有（扫描测试）           | 改为 ESLint `no-restricted-syntax`（JSX 元素名），扫描测试保留一个版本后删                                                                           |
| 手写 `<input>` / `<select>` / `<textarea>` / `<dialog>`            | 缺                       | ESLint `no-restricted-syntax`，`type="file"` / `"hidden"` 例外                                                                                       |
| 直接 import `ui/alert-dialog`                                      | 有                       | 扩到 `ui/dialog` / `ui/sheet`，改为 ESLint `no-restricted-imports` + 白名单（`overrides` 按文件放行）                                                |
| `Spinner` 标签                                                     | 有                       | 保留扫描测试（仓库语义）                                                                                                                             |
| 字号下限                                                           | 有                       | 保留                                                                                                                                                 |
| i18n 三条                                                          | 有                       | 保留                                                                                                                                                 |
| `<img alt>`、图标钮 `aria-label`、`onClick` 在非交互元素、焦点可达 | 缺                       | `eslint-plugin-jsx-a11y` recommended（`alt-text`、`control-has-associated-label`、`click-events-have-key-events`、`no-static-element-interactions`） |
| hooks 依赖                                                         | 缺（272 处 `useEffect`） | `eslint-plugin-react-hooks`（`rules-of-hooks` error、`exhaustive-deps` 先 warn）                                                                     |
| 字面色值 / `dark:` / `z-[`                                         | 缺                       | 扫描测试 `styles/no-literal-color.test.ts`（白名单：`palette.ts`、`appearance.ts`、`lib/contrast.ts`、`showcase/`）                                  |
| 错误码注册表                                                       | 缺                       | `shared/rpc/errors.test.ts` 扫 core 源码的 `code: "…"`                                                                                               |
| 未用导出 / 依赖                                                    | 缺                       | knip（§5）                                                                                                                                           |
| core import 边界                                                   | 有                       | 也加一条 ESLint `no-restricted-imports`（`electron`、`../main/`、`../shell-core/`）让编辑器里就能看到                                                |

## 5. 测试与检查工具

| 项                                                                  | 推荐                   | 理由                                                                                                                                                                                                 | 引入成本                                                                                                                               | CI 时长                                                | 渐进启用                                                                                                                                                |
| ------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint 9（flat config）+ typescript-eslint + react-hooks + jsx-a11y | **加**                 | 仓库零 lint；上面一半守卫天然是 lint 规则；core 大量 async，`no-floating-promises` 这类类型感知规则只有它有                                                                                          | 根 `eslint.config.js`；首轮基线估计 hooks `exhaustive-deps` 几百条 warn、a11y 几十条；类型感知规则先只开 `core/http`、`api/`、`shared` | 非类型感知约 1 分钟；类型感知全仓估 3–5 分钟（要实测） | 第 1 步全 warn 只报不阻断；第 2 步 `ui/`、`api/`、`shared/`、`core/http` 转 error；第 3 步按域目录逐个转 error；`--max-warnings` 按基线数设上限只减不增 |
| Biome 代替 ESLint + Prettier                                        | 不加                   | 快，但没有类型感知规则，格式器与 Prettier 有差异会产生一次全仓 reformat（git blame 污染），a11y / hooks 规则覆盖面也小于 ESLint 插件                                                                 | —                                                                                                                                      | —                                                      | —                                                                                                                                                       |
| knip                                                                | **加**                 | 本文一次运行就找出 1 个未用依赖、198 + 363 个未用导出；RPC 迁移会产生大量「旧路径还在导出」的死代码，没有它清不干净                                                                                  | `knip.json` 配 workspace 入口（`main/index.ts`、`preload/index.ts`、`core/main.ts`、probes、scripts）去掉 7 个误报                     | 约 1–2 分钟（本机单 workspace 一分钟内）               | 第 1 步 nightly 出报告；第 2 步 CI 以 `--max-issues` 基线阻断新增；第 3 步基线归零                                                                      |
| Playwright                                                          | **不加**               | 现有 CDP 探针 19 条已覆盖真 core + 真页面 + 多浏览器上下文（realtime-e2e），且与 dev-stack、临时 HOME、三档体系深度绑定；Playwright 带来的是断言 API 与 trace，不是新的覆盖面；两套 harness 双倍维护 | —                                                                                                                                      | —                                                      | 以后：若探针数超过 40 条或多人协同场景需要录制回放，再评估把 A 档迁到 Playwright 的 CDP 后端，而不是双轨                                                |
| 覆盖率（`@vitest/coverage-v8`）                                     | **加报告，门槛按目录** | 4141 + 4197 个用例却不知道盖住了哪里；全局门槛没意义（UI 与 core 差异太大），按目录才有信号                                                                                                          | 三个 vitest 配置各加 `coverage`，CI 上传 lcov                                                                                          | +10–20%（v8 开销小）；只在 linux 作业开，三平台不重复  | 第 1 步报告；第 2 步对 `core/http`、`shared/rpc`、`api/` 设 80% 行覆盖；第 3 步新域工作包验收写覆盖率                                                   |
| 类型覆盖工具                                                        | 不加                   | `strict` + `noUncheckedIndexedAccess` 已开，`any` 逃逸只有 3 处；ESLint `no-explicit-any` error 就够                                                                                                 | —                                                                                                                                      | —                                                      | —                                                                                                                                                       |
| 依赖漏洞扫描                                                        | **加（nightly）**      | 现在靠手工 `overrides`；`pnpm audit --prod --audit-level=high` 进 nightly `report` 作业，失败开 issue（与 B 档同规则）                                                                               | 一步                                                                                                                                   | 秒级                                                   | 先 nightly 不阻断；SaaS 上线前改为 PR 阻断 high 以上                                                                                                    |
| 提交前钩子（lint-staged）                                           | **可选，不强制**       | 用户习惯细粒度提交，钩子会拖慢每次 commit；CI 已经是守门人                                                                                                                                           | `simple-git-hooks` + `lint-staged`（prettier + eslint 只跑暂存文件），`pnpm hooks:install` 显式装，不在 `postinstall`                  | 无                                                     | 由个人决定装不装                                                                                                                                        |
| 组件视觉回归                                                        | 以后                   | 展示页探针已截图；像素比对在三平台字体差异下误报多                                                                                                                                                   | nightly 里对展示页截图与上次产物做 `pixelmatch`，阈值 0.5%，差异上传产物不阻断                                                         | nightly +1 分钟                                        | 先只比 linux；稳定后再决定是否进 PR                                                                                                                     |
| 契约生成一致性                                                      | **加**                 | §2.5                                                                                                                                                                                                 | `tools/contract/generate.mjs --check` 进 `pnpm check`                                                                                  | 秒级                                                   | E1 起                                                                                                                                                   |
| RPC 对偶测试（旧路径 = 新 procedure）                               | **加（迁移期）**       | §2.4 验收 ①                                                                                                                                                                                          | `core/contract/parity.test.ts`                                                                                                         | 随域增长，E4 后删                                      | —                                                                                                                                                       |

`pnpm check` 目标形态：`libs:build → format:check → lint → typecheck → repo:check → contract:check → ci:workflows → release:check → notices:check`；`pnpm test` 不变；knip 与 audit 在 nightly。CI 墙钟预计从 18 分钟到 20–22 分钟（lint 并入 linux 作业，三平台不重复跑）。

## 6. 分阶段落地

| 阶段                          | 工作包                                                                                                                                                                                                                                                                                                                                                     | 改动目录                                                                                                    | 验收                                                                                                                                                                        | 风险                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| E0 基线与守卫（1 周）         | E0-1 ESLint 配置 + 全 warn 基线；E0-2 knip 配置与入口；E0-3 新守卫（表单原语、dialog / sheet import、字面色、错误码注册表雏形）；E0-4 清 §4.1 的小尾巴（9 input、20 select、2 aria-label、8 alt、4 Loader2、11 card、5 dialog、1 `dark:`、5 重复实现）；E0-5 `lib/backoff.ts` 统一四套退避                                                                 | 根 `eslint.config.js`、`knip.json`、`apps/web/src/{panels,nodes,canvas,session,agent}`、`apps/web/src/lib/` | `pnpm check` 含 lint 全绿（warn 数记入基线）；§4.1 表中「换组件」各行归零；守卫测试各有一条「真的扫到了」用例                                                               | hooks `exhaustive-deps` 的修复可能改变行为——E0 只开 warn，修复放到各域迁移时顺手做                                    |
| E1 RPC 内核（2 周）           | E1-1 `shared/rpc/{define,errors,frames,index}.ts`；E1-2 core `http/rpc.ts` dispatcher + `POST /api/rpc/{name}` + `legacy` 绑定；E1-3 web `api/rpc.ts` + `Source`（`origin`、凭据、`http`、`ws` 占位）+ `createClient`；E1-4 `tools/contract/generate.mjs` + `--check`；E1-5 试点 `workspaces` / `settings`                                                 | `packages/shared/src/rpc/`、`apps/desktop/src/core/http/`、`apps/web/src/api/`、`tools/contract/`、契约 §34 | 试点域旧路径与 procedure 对偶测试通过；`shell-transport.ts` 改为给 `Source` 装凭据而不是改全局；文档生成无 diff；A 档不变                                                   | `Source` 替换全局 `fetch` 改写时，`assets.ts` 的 `blob:` 取图、`<img>`、编辑器下载这些绕开 `request()` 的点要逐个接上 |
| E2 控制面 WS（2 周）          | E2-1 core `/api/ws` 多路复用：hello、call、sub、ack、evt、end、ping；心跳、订阅上限、背压；E2-2 事件流作为第一个 `subscription` 迁入（旧 `/events` 路由保留）；E2-3 web `Source.ws` 客户端：换票、退避、前后台、续订；E2-4 终端连接加 `bufferedAmount` 暂停读；E2-5 关闭码表与 i18n 文案                                                                   | `apps/desktop/src/core/{http,events,terminal}/`、`apps/web/src/api/`、`apps/web/src/i18n/`                  | 两个浏览器上下文 + 杀 core 重启 + 断网 30 s 的 A 档探针 `ws-mux-e2e`：事件无丢失、续订缺口由 outbox 补齐、后台回前台 3 s 内恢复；服务端性能基线（30 终端 + 6 事件流）不退化 | 应用级心跳与 Gateway / 中继的空闲超时要一起调；手机真机行为只能 B / C 档验                                            |
| E3 按域迁移（4–6 周，可并行） | 每域一包，顺序见 §2.4 第 3 条：E3-1 boards；E3-2 files（JSON 部分）；E3-3 terminals（HTTP 部分）；E3-4 agents；E3-5 git（两次）；E3-6 forge / github（含错误码换拼法、33 个 schema 搬 shared）；E3-7 identity / security / accounts；E3-8 acp / workflows / push / coordinator / mail / credentials / gateway / diagnostics；E3-9 语言会话是否入控制面评估 | 各域的 `core/<域>/`、`web/src/api/<域>.ts`、`shared/rpc/<域>.ts`、契约对应 §                                | 每包：对偶测试、域内用例全绿、生成无 diff、A 档不变；E3-6 另加 `MESSAGE_BY_CODE` 两种拼法都能映射的用例                                                                     | git 域 35 条路径最大；identity 的匿名面与 OAuth 302 必须留 REST，不要为了「全迁」把它们硬塞进 RPC                     |
| E4 清理（1 周）               | E4-1 删旧路径与 `legacy`；E4-2 `route-scopes.ts` 只剩 REST 残留；E4-3 core 测试从路径 dispatch 改 `rpc.dispatch`；E4-4 契约文档各 § 的手写形状表删去只留生成块；E4-5 knip 基线归零                                                                                                                                                                         | `core/http/routes.ts`（目标 < 40 行条目）、`route-scopes.ts`、各域测试                                      | `routes.ts` 只有 REST 残留；knip 0 新增；`pnpm check` 全绿                                                                                                                  | 删路径是破坏性的：要在一个 minor 版本之后，并确认 hook 面、探针、`armadra.sh` 没有引用                                |
| E5 工具链收紧（持续）         | E5-1 ESLint 按目录转 error；E5-2 覆盖率门槛三处 80%；E5-3 knip 阻断；E5-4 audit 进 PR；E5-5 视觉回归评估                                                                                                                                                                                                                                                   | 配置文件                                                                                                    | 每步一条 PR，CI 时长记录在 [CI 与发布](../guides/ci-release.md)                                                                                                             | 收紧过快会让功能 PR 被无关 lint 卡住；每次只收一个目录                                                                |

与平台设计的依赖点：

| 平台设计里的事                    | 依赖本文                                                     | 说明                                                                      |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 多源挂载（一个客户端连多个 core） | **E1-3 `Source` + E2-3 控制面客户端**                        | 没有 `Source`，多源要改写全局 `fetch` 两次；没有控制面合一，每源 5 条连接 |
| SaaS 中转                         | E2-1 帧 envelope、§3.3 关闭码与心跳、§2.3.4 中继身份头       | 中继按 `t` / `sid` 路由与配额；数据面透传                                 |
| 各端登录                          | E3-7 identity procedures（匿名面仍 REST）                    | 登录流程本身不变；中继的 principal 形状由平台定，core 只认签名头          |
| 多人协同                          | 独立 Yjs 连接不变；评论、在线、租约走控制面订阅（E2 / E3-1） | 不需要等 E3 全完成                                                        |
| PostgreSQL / Redis                | 无直接依赖                                                   | core 的 SQLite 与迁移规则不在本文范围；若平台层要 core 换库，另起设计     |

## 7. 待拍板的决策

| #   | 决策                                                      | 推荐                                                      | 不选推荐的后果                                            |
| --- | --------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| F1  | 方案 (a) / (b) / (c)                                      | **(b)** 自研薄 procedure 层                               | (a) 要再做两次；(c) 把请求挂在最不稳的连接上              |
| F2  | 自研 vs 引开源 typed-RPC 库                               | **自研**（< 1000 行，全部定制点都在本仓库）               | 引库要核实 zod 4 与自定义 WS envelope 支持，绕不过票与 §N |
| F3  | WebSocket：控制面合一、数据面独立                         | **是**                                                    | 全合一：终端刷屏拖慢事件；全分开：多源时连接数 ×5         |
| F4  | 错误对象加可选 `details`                                  | **加**（替代 `RuntimeRequestError.body` 的原样透传）      | 409 的指纹、修订号继续走未声明形状                        |
| F5  | 错误码统一 snake_case，GitHub 面 UPPER_SNAKE 保留一个版本 | **是**                                                    | 两套拼法永久并存，注册表要双份                            |
| F6  | lint：ESLint vs Biome                                     | **ESLint**，Prettier 保留                                 | Biome 一次全仓 reformat，且无类型感知规则                 |
| F7  | 提交前钩子                                                | **可选安装，不强制**                                      | 强制会拖慢细粒度提交                                      |
| F8  | Playwright                                                | **不加**，CDP 探针三档保留                                | 双 harness                                                |
| F9  | 覆盖率门槛                                                | **先报告，再对 `core/http`、`shared/rpc`、`api/` 设 80%** | 全局门槛会被 UI 目录拉低成摆设                            |
| F10 | 语言会话 JSON-RPC 是否并入控制面                          | **E3 末按量决定**                                         | 现在并入可能让补全请求与事件抢同一条连接                  |
| F11 | 旧 REST 路径保留期                                        | **一个 minor 版本**                                       | 更短：探针与 hook 面来不及改；更长：双份代码拖 knip       |
| F12 | 契约文档：生成块嵌入现有 §N vs 另起生成文档               | **嵌入**，新域从 §34                                      | 另起文档会让 692 处「契约 §N」注释指向两份                |
| F13 | 组件分层是否新建 `composites/` 目录                       | **暂不**，只在设计系统 §3 登记边界                        | 目录搬迁会动 52 个 `ResponsiveDialog` 引用，收益小        |
| F14 | 生产环境是否校验 `output`                                 | **开发与测试必开，生产按环境变量默认关**                  | 全开：每个响应多一次 parse；全关：生产漂移发现得晚        |

## 附录 A：统计命令

全部在仓库根目录运行（zsh；`=` 开头的参数会被 zsh 展开，命令里已避开）。

```sh
# 路由表
node -e '
const s=require("fs").readFileSync("apps/desktop/src/core/http/routes.ts","utf8");
const e=[...s.matchAll(/\{\s*path:\s*"([^"]+)",\s*methods:\s*\[([^\]]*)\],\s*surface:\s*"(\w+)",(\s*implemented:\s*true,)?/g)];
console.log(e.length, e.reduce((n,m)=>n+m[2].split(",").filter(Boolean).length,0), e.filter(m=>m[4]).length, e.filter(m=>m[3]==="hook").length)'
grep -rhoE "\.handle\(" apps/desktop/src/core --include='*.ts' | grep -v test | wc -l            # 177
grep -rlE "router\.handle\(|\.handle\(\s*$|\.handle\(\"" apps/desktop/src/core --include='*.ts' | grep -v test | wc -l   # 30
grep -rn "\.raw(" apps/desktop/src/core --include='*.ts' | grep -v test | grep "context.server.raw"  # 3 个前缀
grep -nB1 -A3 '/ws"\|/events"\|/sync"\|/stream"' apps/desktop/src/core/http/routes.ts | grep "path:"  # 5 条 WS
grep -rnE "\.stream\(" apps/desktop/src/core --include='*.ts' | grep -v test | grep -v http/server.ts  # 5 处注册

# 契约与引用
grep -cE '^## ' docs/contracts/core-json-api.md; grep -cE '^### ' docs/contracts/core-json-api.md; wc -l docs/contracts/core-json-api.md
grep -rnoE "契约 §[0-9]+(\.[0-9]+)?" apps packages tools --include='*.ts' --include='*.tsx' --include='*.mjs' | grep -v node_modules | wc -l   # 692

# zod 与校验
grep -rhoE "export const \w+Schema\b" packages/shared/src | sort -u | wc -l     # 548
grep -rhoE "z\.(object|array|enum|union|discriminatedUnion|string|number|boolean|literal|record|tuple|unknown|any)\(" packages/shared/src | wc -l  # 2679
grep -rhoE "z\.(unknown|any)\(\)" packages/shared/src | wc -l                    # 14
grep -rn 'from "zod"' apps/desktop/src/core --include='*.ts' | grep -v test | wc -l   # 0
grep -rlE "typeof body|typeof payload" apps/desktop/src/core --include='*.ts' | grep -v test | wc -l   # 26
grep -rl "@armadra/shared" apps/desktop/src/core --include='*.ts' | grep -v test | wc -l   # 7

# 前端请求层
grep -rhoE "\brequest(<[^>]*>)?\(" apps/web/src/api/*.ts | grep -v test | wc -l   # 206
grep -cE "\brequest(<[^>]*>)?\(" apps/web/src/{coordinator,workflow,acp}/api.ts apps/web/src/realtime/comments/store.ts apps/web/src/diagnostics/report.ts apps/web/src/mobile/push-rotation.ts
grep -rhoE "z\.object\(" apps/web/src/api/*.ts | grep -v test | wc -l            # 72
grep -rhE "^export (interface|type) " apps/web/src/api/*.ts | grep -v test | wc -l   # 79

# 错误码
grep -rhoE "coreError\(\s*[0-9]+,\s*\"[a-zA-Z_]+\"" apps/desktop/src/core --include='*.ts' | grep -oE "\"[a-zA-Z_]+\"" | sort -u | wc -l   # 19
grep -rhoE "code: \"[a-zA-Z_]+\"" apps/desktop/src/core --include='*.ts' | grep -v test | sort -u | wc -l   # 119

# 组件审计（排除 ui/ 与测试）
grep -rn "<button" apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v "\.test\." | wc -l
grep -rn "<input" apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v "\.test\."
grep -rnE "<(select|textarea)\b" apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v "\.test\."
grep -rnE "<dialog|role=\"dialog\"" apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v "\.test\."
grep -rln 'ui/dialog"' apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v test | wc -l   # 5
grep -rln 'ui/sheet"' apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v test | wc -l    # 15
grep -rnE "<img\b" apps/web/src --include='*.tsx' | grep -v "\.test\." | grep -v "alt="
grep -rn "Loader2" apps/web/src --include='*.tsx' | grep -v test | wc -l
grep -rn "border bg-card" apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v test | wc -l
grep -rnE "(\"|'|\`)#[0-9a-fA-F]{3,8}\b" apps/web/src --include='*.tsx' --include='*.ts' | grep -v "\.test\." | cut -d: -f1 | sort | uniq -c | sort -rn
grep -rno "dark:[a-z-]*" apps/web/src --include='*.tsx' | grep -v "/ui/" | grep -v "\.test\." | wc -l
grep -rnE "style=\{\{" apps/web/src --include='*.tsx' | grep -v "\.test\." | wc -l
grep -rnoE "\[[0-9]+px\]" apps/web/src --include='*.tsx' | grep -v "\.test\." | wc -l
grep -rnoE "z-\[?[0-9]+\]?" apps/web/src --include='*.tsx' | grep -v "\.test\." | wc -l
# 图标 Button 多行标签内是否有 aria-label（见正文 §4.1，用 node 按正则 /<Button\b[^>]*?size="icon[^"]*"[^>]*?>/gs 扫）

# 测试规模
find apps/web/src -name "*.test.ts" -o -name "*.test.tsx" | wc -l; grep -rn "^\s*it(\|^\s*test(" apps/web/src --include='*.test.ts' --include='*.test.tsx' | wc -l
find apps/desktop/src apps/desktop/scripts -name "*.test.ts" -o -name "*.test.mjs" | wc -l; grep -rn "^\s*it(\|^\s*test(" apps/desktop/src --include='*.test.ts' | wc -l

# 工具
pnpm dlx knip@latest --no-progress --reporter compact --workspace apps/web
pnpm dlx knip@latest --no-progress --reporter compact --workspace apps/desktop
gh run view 37344131164 --json jobs --jq '.jobs[] | "\(.name): \(.startedAt) -> \(.completedAt)"'
```
