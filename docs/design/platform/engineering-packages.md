# 工程规范化工作包 E1–E6：实现规格

> 状态：目标设计（2026-10-06）。本文把[工程规范化](../engineering-standardization.md) §2–§3、§6 的 E1–E6 细化到文件、函数签名与测试清单，供[落地总计划](../platform-implementation-plan.md)派发。E0 已派出（ESLint、knip、repo-check 的 oRPC 规则、守卫、组件小尾巴、`lib/backoff.ts`），不在本文。
> 规矩：`@orpc/*` 只许出现在 `packages/shared/src/contract/`、`apps/desktop/src/core/http/rpc.ts`、`apps/web/src/api/client.ts`、`tools/contract/`；线上形状 `{ code, message, requestId?, details? }`；契约 §1–§30 编号不动，新域从 §34。

## §0 契约章节预分配（§34 起）

| §   | 域 / 内容                                                                                                             | 包   |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---- |
| §34 | RPC 内核：`/api/rpc/{procedure}` 传输、错误 envelope、`system.hello` / `system.ping`、`workspaces` 与 `settings` 试点 | E1   |
| §35 | 控制面 WebSocket `/api/ws`：升级层、子协议、关闭码、心跳、事件订阅 `workspaces.events`、背压                          | E2   |
| §36 | `boards`                                                                                                              | E3-1 |
| §37 | `files`（JSON 部分；上传下载留 REST 并在本节登记）                                                                    | E3-2 |
| §38 | `terminals`（HTTP 部分）                                                                                              | E3-3 |
| §39 | `agents`                                                                                                              | E3-4 |
| §40 | `git` + `gitRepository`                                                                                               | E3-5 |
| §41 | `forge` / `github`（错误码换 snake_case）                                                                             | E3-6 |
| §42 | `identity` / `security` / `accounts` 的 procedure 化（§31–§33 由平台包直接按契约写，本节只登记）                      | E3-7 |
| §43 | `acp`、`workflows`、`push`、`coordinator`、`mail`、`credentials`、`gateway`、`diagnostics`                            | E3-8 |

## §1 E1 契约内核

### 1.1 依赖（精确版本）

`packages/shared`：`@orpc/contract 1.15.4`、`@orpc/zod 1.15.4`；`apps/desktop`：`@orpc/server 1.15.4`、`@orpc/openapi 1.15.4`；`apps/web`：`@orpc/client 1.15.4`；`tools/contract`：`@orpc/openapi`（根 devDependency）。`pnpm-workspace.yaml` `minimumReleaseAge` 已覆盖；repo-check 的 oRPC 规则（E0-6）守一致与非 beta。`node tools/notices.mjs` 更新 THIRD_PARTY_NOTICES。

### 1.2 `packages/shared/src/contract/`

```text
contract/
├── index.ts     export const contract = { system, workspaces, settings, /* E3 逐域加 */ } ; export type Contract
├── meta.ts      defineMeta<{ scope: Scope | null; workspaceKey?: string; since: string; contract: `§${number}.${number}`; legacy?: { method; path }; deprecated?: string }>()
├── errors.ts    ERRORS 注册表（code → { status, i18n?, data?: ZodType }）、errors.pick()、isDefinedCode()
├── system.ts    system.hello / system.ping
├── workspaces.ts、settings.ts   试点
└── contract.test.ts  路径唯一、meta.contract 唯一、errors 全在注册表、每条有 scope、output 无 z.unknown/any
```

```ts
// system.ts
export const system = {
  hello: oc
    .input(z.object({ trace: z.boolean().optional() }))
    .output(
      z.object({
        protocol: z.object({
          major: z.number().int(),
          minor: z.number().int(),
        }),
        procedures: z.array(z.string()),
        capabilities: z.array(z.string()),
        heartbeatMs: z.number().int(),
        maxFrameBytes: z.number().int(),
        sessionExpiresAtMs: z.number().int().nullable(),
        instanceId: z.string(),
        sourceId: z.string(),
        version: z.string(),
      }),
    )
    .meta(meta({ scope: "identity:read", since: "1.3", contract: "§34.2" })),
  ping: oc
    .input(z.object({ ts: z.number() }))
    .output(z.object({ ts: z.number(), serverTs: z.number() }))
    .meta(meta({ scope: "identity:read", since: "1.3", contract: "§34.3" })),
};
```

`Scope` 类型 = `route-scopes.ts` 现有词表（`workspaces:read` 等）；`null` = 匿名（只经 legacy 路径，必须在 `/api/identity/` 或 `/health` 下，`contract.test.ts` 断言）。

### 1.3 core 门面 `apps/desktop/src/core/http/rpc.ts`

```ts
export interface RpcInstallOptions {
  validateOutput: boolean /* ARMADRA_RPC_VALIDATE_OUTPUT；dev/test 默认 true */;
}
export function installContract(
  server: CoreServer,
  impl: ContractImplementation,
  options: RpcInstallOptions,
): RpcHandle;
// 内部：
//  - router = implement(contract).router(impl)（每域的 install() 返回自己那部分 impl，core/main.ts 合并）
//  - rpcHandler = new RPCHandler(router, { interceptors: [scopeGate, errorEnvelope, timing], plugins: [] })
//  - openapiHandler = new OpenAPIHandler(router, { ... })，路由来自 meta.legacy（method, path）
//  - 路由表 routes.ts 加一行 `/api/rpc/{procedure}`（surface runtime, implemented true）；`server.raw("/api/rpc/")` 交给 rpcHandler；legacy 路径：在现有 Router 分派之前先问 openapiHandler.handle()，{ matched: false } 时回落现有 handler（迁移期并存）
//  - context: { identity: 当前 runAs 身份, requestId, remoteIp, origin }
//  - scopeGate：读 procedure meta.scope / workspaceKey → accessGate().permits；不满足 → ORPCError("forbidden")
//  - errorEnvelope：ORPCError → { code, message, requestId, details?: data }；zod 入参失败 → bad_request + details.issues
//  - timing：meta.trace 或 ARMADRA_RPC_TRACE=1 时记耗时日志
```

`coreError(status, code, message)` → 新 `fail(code, message, details?)`（状态查注册表），旧函数留一层转发到 E4 删。

### 1.4 web 门面 `apps/web/src/api/client.ts`

```ts
export interface Source {
  sourceId: string;
  httpBase: string;
  wsBase: string;
  credentials: {
    access(): Promise<string | null>;
    renew(): Promise<void>;
    csrf(): string | null;
    mode: "bearer" | "cookie";
  };
}
export function createClient(source: Source): ArmadraClient; // createORPCClient(new RPCLink({ url: httpBase + "/api/rpc", headers: async () => …, fetch: source 的 fetch（401 续期一次重放） }))
export type ArmadraClient = ContractRouterClient<Contract>;
export function isDefinedError(e, code?): boolean;
export function isConflict(e);
export function isForbidden(e); // 从 envelope 解析
export const localSource: Source; // 桌面：回环 + 壳票；服务器壳页面：同源 Cookie
```

`shell-transport.ts` 改为给 `localSource.credentials` 装票与续期；全局 `fetch` / `WebSocket` 补丁保留到 A1-1 删除。`api/workspaces.ts`、`api/settings.ts` 改为 `client.workspaces.list()` 等，函数签名不变。

### 1.5 `tools/contract/generate.mjs`

`OpenAPIGenerator` + `ZodToJsonSchemaConverter`（`@orpc/zod/zod4`）→ `docs/contracts/core-openapi.json`；再按 `meta.contract` 把每条渲染进 `core-json-api.md` 的 `<!-- rpc:begin contract=§N.M -->…<!-- rpc:end -->` 块（表列：procedure、kind、input、output、errors、scope、自、原路径；嵌套展开两层）；`--check` 比对；进 `pnpm check`（`contract:check`）。

### 1.6 契约 §34

§34.1 传输与 envelope（`/api/rpc/{procedure}`，POST JSON；错误 envelope；`ARMADRA_RPC_VALIDATE_OUTPUT`）；§34.2 `system.hello`；§34.3 `system.ping`；§34.4 `workspaces.*`；§34.5 `settings.*`（生成块）。

### 1.7 测试

`contract/contract.test.ts`；`core/http/rpc.test.ts`（挂载、scope 拒绝、envelope、bad_request issues、legacy 并存回落）；`core/contract/parity.test.ts`（试点域：旧路径 vs procedure 对同一夹具 `canonicalJson` 相等，含错误）；`web/api/client.test.ts`（headers 异步、401 重放一次、`isDefinedError`）；`tools/contract/generate.test.mjs`（`--check` 无 diff；改 schema 有 diff）；A 档不变；ESLint 守 `@orpc/*` 边界（E0 已配规则，本包把三处门面加进白名单）。

## §2 E2 控制面 WebSocket `/api/ws`

### 2.1 core 升级层（`core/http/server.ts` + `core/http/ws-control.ts`）

- 路由表加 `/api/ws`（stream）。升级：子协议必须含 `armadra-rpc.v1`（否则 4409）与 `armadra-ticket.<t>`（回环 Bearer 来源 / Gateway Bearer 模式）或 Cookie（浏览器 Gateway 来源）；票 / Cookie 认好身份 → `wsHandler.upgrade(ws, { context: { identity, requestId } })`（`@orpc/server/ws` 的 `RPCHandler`）。
- `ws` 层 ping 每 `heartbeatMs`（25 s），两次无 pong `terminate()`；`maxPayload = MAX_FRAME_BYTES`。
- iterator 上限：每连接 256（门面计数，超 → `ORPCError("limit_reached")` + 关 4429）；背压：每个 iterator 经 `SendQueue`（A3-0）包装的有界队列——策略按 meta `backpressure: "drop-oldest" | "coalesce" | "resubscribe"`；`resubscribe` 时抛 `overflow` 结束 iterator。
- `onAccessChanged` → 4403；令牌到期 → 4401（与现有五条流同一复核）。

### 2.2 事件流迁入（`core/events/`）

`workspaces.events` procedure：`async function*`，`withEventMeta(frame, { id: String(seq) })`；入参 `cursor`（兼容）或 `lastEventId`（oRPC 重连自动交回）；掉出保留下限抛 `snapshot_required`；旧 `/events` 路由保留到 E4。

### 2.3 web（`api/client.ts` 扩展 + `api/ws.ts`）

`Source.ws`：`TicketedWebSocket` 工厂（先换票再 `new WebSocket(wsBase + "/api/ws", ["armadra-ticket." + t, "armadra-rpc.v1"])`）；oRPC `RPCLink` 的 `websocket` 选项用它；重连由本仓库做（`lib/backoff.ts`，前台 cap 10 s 后台 30 s；`online` 跳过退避；可见时 `system.ping` 3 s 无回应即重连），不用 oRPC 内建 `reconnect`；`lastEventId` 续订由 oRPC 做。`api/events.ts` 改为对 `client.workspaces.events` 的订阅，对外 API（`onWorkspaceEvent` 等）不变。

### 2.4 契约 §35 与 i18n

§35.1 升级层与子协议；§35.2 关闭码表（`1000/1001/4400/4401/4403/4409/4413/4429`）；§35.3 心跳；§35.4 `workspaces.events`（生成块）；§35.5 背压策略。关闭码文案 `i18n/connection.ts`（中英）。

### 2.5 测试与探针

`ws-control.test.ts`（子协议缺 4409、票错 401、iterator 超限 4429、心跳超时、4401 / 4403 复核）；`events/procedure.test.ts`（续订缺口由 outbox 补、`snapshot_required`）；web `api/ws.test.ts`（换票重连、退避、可见性 ping）；A 档探针 `ws-mux-e2e.mjs`：两个浏览器上下文 + 杀 core 重启 + 断网 30 s（用 CDP `Network.emulateNetworkConditions`）：事件无丢失、续订补齐、后台回前台 3 s 内恢复；`server-perf` 基线不退化。

## §3 E3 按域迁移（每域一包，做法固定）

每包：① `shared/contract/<域>.ts`（`meta.legacy` 指旧路径，`contract` 指新 §）；② core 域 `install()` 改 `implement(contract.<域>)`，旧路径经 `OpenAPIHandler` 同一实现；③ web `api/<域>.ts` 改 `client.<域>.<verb>()`，签名不变；④ 验收：`parity.test.ts` 该域夹具相等（含错误）、域内用例全绿、`contract:check` 无 diff、A 档不变。

| 包   | 域                                                                         | 调用数 / 路径数（现状） | 特别说明                                                                                                                             | 模型   |
| ---- | -------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| E3-1 | boards（含 presence / lease / 快照）                                       | 10 / 11                 | `presence` 心跳改订阅 `boards.presence`（控制面）；Yjs 连接不动                                                                      | Sonnet |
| E3-2 | files（JSON 部分）                                                         | —                       | 上传 / 下载 / `Range` / `<img src>` 留 REST，§37 登记                                                                                | Sonnet |
| E3-3 | terminals（HTTP 部分）                                                     | —                       | 终端 WS 不动                                                                                                                         | Sonnet |
| E3-4 | agents                                                                     | 27                      | 投递门（§22 / §25）语义不变，scope 从 route-scopes 搬到 meta                                                                         | Opus   |
| E3-5 | git + gitRepository（分两次）                                              | 40 / 35                 | 最大的一批；长操作（clone、rebase）保留现有 job 模型，procedure 只起 job 并返回 id                                                   | Opus   |
| E3-6 | forge / github                                                             | 33 个本地 schema        | 33 个 schema 搬 shared；错误码 snake_case，`MESSAGE_BY_CODE` 两种拼法保留一个 minor                                                  | Sonnet |
| E3-7 | identity / security / accounts                                             | ~16 路径                | hello、配对、ws-ticket、OAuth start/callback、password-reset 链接、`cloud/login` 留 REST 匿名面；§31–§33 已是契约，本包只在 §42 登记 | Opus   |
| E3-8 | acp、workflows、push、coordinator、mail、credentials、gateway、diagnostics | —                       | 可拆 2–3 个 PR                                                                                                                       | Sonnet |
| E3-9 | 语言会话是否入控制面                                                       | —                       | 量补全请求频率与体积（探针 `mock-lsp`）后决定；默认保持独立连接                                                                      | Opus   |

## §4 E4 清理

E4-1 删 `meta.legacy`、旧路由行、`OpenAPIHandler` 退场（保留一个 minor 版本之后）；E4-2 `route-scopes.ts` 只剩 REST 残留（约 25–30 行）；E4-3 core 测试从路径 dispatch 改 `createRouterClient(router)` 直调；E4-4 契约各 § 手写形状表删去只留生成块；E4-5 knip 基线归零。验收：`routes.ts` 只有 REST 残留；`armadra.sh`、探针、hook 面无旧路径引用（grep 测试）；`pnpm check` 全绿。

## §5 E5 工具链收紧（每步一条 PR）

E5-1 ESLint 按目录转 error（顺序：`ui/` → `api/` → `shared/` → `core/http` → 各域）；E5-2 覆盖率门槛 `core/http`、`shared/contract`、`api/` 80%；E5-3 knip `--max-issues` 基线阻断新增 → 归零；E5-4 `pnpm audit --prod --audit-level=high` 进 PR；E5-5 展示页视觉回归（nightly，`pixelmatch` 0.5%，不阻断）。CI 时长记录进 `docs/guides/ci-release.md`。

## §6 E6 上游大版本升级（触发：`@orpc/*` 2.x 稳定且 ≥ 2 个 patch）

E6-1 三处门面升级（`defineMeta`、`openapi()` 元数据、`errorStatusMap`、`@orpc/server/websocket`）；E6-2 子协议 `armadra-rpc.v2`；E6-3 对偶测试与 A 档全过；E6-4 repo-check 版本规则改 2.x。验收：业务代码零改动；两端同一版本发布；经中继的旧客户端连新 core 答 4409 且页面整页提示更新（E2 已有）。cloud 仓同步升级（`platform-protocol` 的 `cloud-api` 契约与 cloud 门面），协议包 major 不变（线上 `/v1` 形状不变）。
