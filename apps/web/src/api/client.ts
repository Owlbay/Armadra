/**
 * Runtime 客户端的门面 —— docs/contracts/v3-agent-terminal-plan.md §7 / §15，
 * 工程规范化 §2.2.2。
 *
 * 两件事在这里：
 *
 *   1. **RPC 门面**：`@orpc/*` 在页面里只许出现在这个文件。{@link createClient}
 *      给一个源（`api/source.ts`）造一个按契约（`packages/shared/src/contract/`）
 *      类型化的客户端：`client.workspaces.list()`。失败一律抛
 *      `RuntimeRequestError` / `RuntimeConnectionError`，与 `request()` 同一套，
 *      所以 `isConflict` 这些判定两边通用。
 *   2. **`runtimeApi`**：把各领域模块拼起来，调用点的方法签名与从前一致。迁到
 *      契约上的域（`workspaces`、`settings`、`agents` 等）由这里把当前源的客户端交给它们，域模块
 *      自己不 import 这个文件——它们被这里 import，反过来就是一个环。
 *
 * 传输层（zod 校验、连接失败与 Runtime 报错的分流）在 `request.ts`，WebSocket
 * 基址在 `sockets.ts`，每个领域的路径与 schema 在同名模块里。
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ClientRetryPlugin } from "@orpc/client/plugins";
import { RPCLink as PeerRPCLink } from "@orpc/client/websocket";
import {
  type ContractClient,
  contractEntries,
  isDefinedCode,
} from "@armadra/shared";
import { t } from "../app/preferences-store";
import {
  RuntimeConnectionError,
  RuntimeRequestError,
  csrfRefusal,
} from "./request";
import { type Source, currentSource, localSource } from "./source";
import {
  type ControlChannel,
  type ControlSocketOpener,
  controlChannel,
} from "./ws";
import { agentsApiFor } from "./agents";
import { systemApi } from "./system";
import { workspacesApiFor } from "./workspaces";
import { boardsApiFor } from "./boards";
export { isLeaseHeld } from "./boards";
import { filesApiFor } from "./files";
import { languageApi } from "./language";
import { searchApiFor } from "./search";
import { terminalsApiFor } from "./terminals";
import { resourcesApi } from "./resources";
import { conversationsApi } from "./conversations";
import { handoffApi } from "./handoff";
import { gitApi } from "./git";
import { gitRepositoryApi } from "./git-repository";
import { usageApi } from "./usage";
import { settingsApiFor } from "./settings";
import { githubApi } from "./github";
import { automationsApi } from "./automations";

export {
  RUNTIME_VIA_SERVER_SHELL,
  RuntimeConnectionError,
  RuntimeRequestError,
  isConflict,
  isForbidden,
  isUnsupportedOnRemote,
} from "./request";
export {
  boardSyncUrl,
  languageSessionUrl,
  terminalWebSocketUrl,
  workspaceEventsUrl,
} from "./sockets";
export { executionHostRefusal, runtimeSettingsSchema } from "./settings";
// GitHub 与自动化两块面板的调用面（R7a）。类型与枚举从模块本身导出，这里只把
// 两个工厂挂进 `runtimeApi`——面板拿到的是一个绑定了工作空间的客户端对象，而不
// 是一把要在每个调用点重复传工作空间的自由函数。
export { GithubApi, GithubApiError, classifyGithubFailure } from "./github";
export {
  AutomationApi,
  AutomationApiError,
  classifyAutomationFailure,
} from "./automations";
export type { RuntimeSettings, RuntimeSettingsPatch } from "./settings";
export { dataBackupSchema, dataInfoSchema } from "./system";
export type { DataInfo } from "./system";

export type { Source, SourceCredentials } from "./source";
export { currentSource, localSource } from "./source";

/** 按契约类型化的客户端：`client.<域>.<动词>(input)`。 */
export type ArmadraClient = ContractClient;

const CSRF_HEADER = "x-armadra-csrf";

/**
 * 发一次 RPC：经源的 `fetch`（凭据、401 换一枚重发一次），Cookie 模式下 CSRF
 * 被拒换一枚重发一次；失败在这里就变成 `RuntimeRequestError`，上游的错误解码
 * 不参与——线上的错误是 `{ code, message, requestId?, details? }`（契约 §34.1），
 * 不是上游的形状。
 */
async function sendRpc(
  source: Source,
  request: Request,
  init: { redirect?: RequestRedirect } | undefined,
): Promise<Response> {
  // 体先读成字符串：401 / CSRF 重发时还要再发一次，流只能读一次。
  const body = request.method === "GET" ? undefined : await request.text();
  const headers = new Headers(request.headers);
  const send = () =>
    source.fetch(request.url, {
      method: request.method,
      headers: new Headers(headers),
      body,
      signal: request.signal,
      ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    });
  let response: Response;
  try {
    response = await send();
    const used = headers.get(CSRF_HEADER);
    if (
      used !== null &&
      response.status === 403 &&
      (await csrfRefusal(response))
    ) {
      const renewed = await source.credentials.renewCsrf(used);
      if (renewed !== null) {
        headers.set(CSRF_HEADER, renewed);
        response = await send();
      }
    }
  } catch (cause) {
    throw new RuntimeConnectionError(source.httpBase, cause);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const failure =
      payload && typeof payload === "object"
        ? (payload as { message?: unknown; code?: unknown })
        : null;
    throw new RuntimeRequestError(
      response.status,
      failure?.message !== undefined
        ? String(failure.message)
        : t("app.runtimeFailed", { status: response.status }),
      failure?.code !== undefined ? String(failure.code) : undefined,
      payload,
    );
  }
  // 交回给上游解码的是一份规范的响应：调用方（与测试）给的 `fetch` 不一定答
  // 一个真的 `Response`。
  return new Response(JSON.stringify(payload ?? {}), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

/** 给一个源造一个 RPC 客户端（`POST <httpBase>/api/rpc/<域>/<动词>`）。 */
export function createClient(source: Source): ArmadraClient {
  const link = new RPCLink({
    url: () => `${source.httpBase}/api/rpc`,
    headers: async () => {
      if (source.credentials.mode !== "cookie") return {};
      const csrf = await source.credentials.csrf();
      return csrf === null ? {} : { [CSRF_HEADER]: csrf };
    },
    fetch: (request, init) => sendRpc(source, request, init),
  });
  return createORPCClient<ArmadraClient>(link);
}

const clients = new WeakMap<Source, ArmadraClient>();

/** 这个源的客户端，第一次用时才造，之后同一个源同一个。 */
export function clientFor(source: Source): ArmadraClient {
  let client = clients.get(source);
  if (client === undefined) {
    client = createClient(source);
    clients.set(source, client);
  }
  return client;
}

/** 本机源的客户端。 */
export function localClient(): ArmadraClient {
  return clientFor(localSource);
}

/** 当前源的客户端：`runtimeApi` 里迁到契约上的域经它发。 */
export function currentClient(): ArmadraClient {
  return clientFor(currentSource());
}

/* -------------------------------- 控制面 --------------------------------- */

/** 订阅（契约里写了背压策略的那些）：断线后由重试插件带 `lastEventId` 重订。 */
const SUBSCRIPTIONS: ReadonlySet<string> = new Set(
  contractEntries()
    .filter((entry) => entry.meta.backpressure !== undefined)
    .map((entry) => entry.name),
);

/**
 * 重订也没用的拒绝：要调用方自己决定（整份重读、离开工作空间、提示）。`overflow`
 * 不在这里——它就是「带 `lastEventId` 再订一次」的意思。
 */
const FINAL_CODES: ReadonlySet<string> = new Set([
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "not_implemented",
  "snapshot_required",
  "cursor_ahead",
  "limit_reached",
]);

/**
 * 一个错误的码：HTTP 上是 `RuntimeRequestError.code`，控制面上是上游错误的
 * `code`（core 已经换成注册表里的码，契约 §35.1）。连接断了之类答 `undefined`。
 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

const controlClients = new WeakMap<ControlChannel, ArmadraClient>();

/**
 * 一个源的控制面客户端（契约 §35）：调用与订阅走同一条 `/api/ws`。`connection`
 * 是源层的连接（`sourceRegistry().get(…)` / `.current()`），控制面的那条流由它
 * 托管（换票、中继、退避，`sources/managed-socket.ts`）。订阅断线后由上游的
 * 重试插件重订并交回 `lastEventId`（续订由 core 从 outbox 补）；不用上游内建的
 * 重连。
 */
export function controlClient(connection: ControlSocketOpener): ArmadraClient {
  const channel = controlChannel(connection);
  const known = controlClients.get(channel);
  if (known !== undefined) return known;
  const link = new PeerRPCLink({
    websocket: channel,
    plugins: [
      new ClientRetryPlugin({
        default: {
          retry: ({ path }) =>
            SUBSCRIPTIONS.has(path.join(".")) ? Number.POSITIVE_INFINITY : 0,
          // 断线时立刻重订：那一帧要等连接重新打开才发得出去，等多久由
          // `api/ws.ts` 的退避定。连着却被拒（`overflow` 之外）才缓一秒。
          retryDelay: ({ error }) =>
            channel.readyState !== channel.OPEN ||
            errorCode(error) === "overflow"
              ? 0
              : 1_000,
          shouldRetry: ({ error, signal }) =>
            signal?.aborted !== true &&
            channel.closedWith === null &&
            !FINAL_CODES.has(errorCode(error) ?? ""),
        },
      }),
    ],
  });
  const client = createORPCClient<ArmadraClient>(link);
  channel.setPing(() => client.system.ping({ ts: Date.now() }));
  controlClients.set(channel, client);
  return client;
}

/** 这个源的控制面停下的原因（4403 / 4409 / 4429）；还在连的是 `null`。 */
export function controlClosedWith(
  connection: ControlSocketOpener,
): number | null {
  return controlChannel(connection).closedWith;
}

/** 控制面的「连接断了」：订阅据此把「已连上」的状态落下。 */
export function onControlDrop(
  connection: ControlSocketOpener,
  listener: () => void,
): () => void {
  const channel = controlChannel(connection);
  channel.addEventListener("close", listener);
  return () => channel.removeEventListener("close", listener);
}

/**
 * 这是 core 用登记过的码拒绝的（`packages/shared/src/contract/errors.ts`）；给了
 * `code` 就还要是这一个。连不上、或 core 答了一个没登记的码，都不算。
 */
export function isDefinedError(error: unknown, code?: string): boolean {
  if (!(error instanceof RuntimeRequestError) || error.code === undefined) {
    return false;
  }
  if (!isDefinedCode(error.code)) return false;
  return code === undefined || error.code === code;
}

/** 迁到契约上的域交 `source` 的客户端；缺省是当前源。 */
function sourceClient(source?: Source): ArmadraClient {
  return source === undefined ? currentClient() : clientFor(source);
}

export const runtimeApi = {
  ...agentsApiFor(sourceClient),
  ...systemApi,
  ...workspacesApiFor(currentClient),
  ...boardsApiFor(sourceClient),
  ...filesApiFor(currentClient),
  ...languageApi,
  ...searchApiFor(currentClient),
  ...terminalsApiFor(currentClient),
  ...resourcesApi,
  ...conversationsApi,
  ...handoffApi,
  ...gitApi,
  ...gitRepositoryApi,
  ...usageApi,
  ...settingsApiFor(currentClient),
  ...githubApi,
  ...automationsApi,
};
