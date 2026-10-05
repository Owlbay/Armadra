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
 *      契约上的域（`workspaces`、`settings`）由这里把本机客户端交给它们，域模块
 *      自己不 import 这个文件——它们被这里 import，反过来就是一个环。
 *
 * 传输层（zod 校验、连接失败与 Runtime 报错的分流）在 `request.ts`，WebSocket
 * 基址在 `sockets.ts`，每个领域的路径与 schema 在同名模块里。
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { type ContractClient, isDefinedCode } from "@armadra/shared";
import { t } from "../app/preferences-store";
import {
  RuntimeConnectionError,
  RuntimeRequestError,
  csrfRefusal,
} from "./request";
import { type Source, localSource } from "./source";
import { agentsApi } from "./agents";
import { systemApi } from "./system";
import { workspacesApiFor } from "./workspaces";
import { boardsApi } from "./boards";
export { isLeaseHeld } from "./boards";
import { filesApi } from "./files";
import { languageApi } from "./language";
import { searchApi } from "./search";
import { terminalsApi } from "./terminals";
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
  RUNTIME_URL,
  RUNTIME_VIA_SERVER_SHELL,
  RuntimeConnectionError,
  RuntimeRequestError,
  isConflict,
  isForbidden,
  isUnsupportedOnRemote,
} from "./request";
export {
  boardSyncUrl,
  initRuntimeSockets,
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
export { localSource } from "./source";

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

let local: ArmadraClient | null = null;

/** 本机源的客户端，第一次用时才造。 */
export function localClient(): ArmadraClient {
  local ??= createClient(localSource);
  return local;
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

export const runtimeApi = {
  ...agentsApi,
  ...systemApi,
  ...workspacesApiFor(localClient),
  ...boardsApi,
  ...filesApi,
  ...languageApi,
  ...searchApi,
  ...terminalsApi,
  ...resourcesApi,
  ...conversationsApi,
  ...handoffApi,
  ...gitApi,
  ...gitRepositoryApi,
  ...usageApi,
  ...settingsApiFor(localClient),
  ...githubApi,
  ...automationsApi,
};
