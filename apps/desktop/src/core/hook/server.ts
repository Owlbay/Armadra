import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { type ListenSpec, bind, release } from "../listen";
import { ROUTES } from "../http/routes";
import { Router, type CoreRequest, type HandlerResult } from "../http/router";
import { readBody } from "../http/server";
import {
  CredentialError,
  credentialsDomain,
  persistedBinding,
} from "../agent/credentials";
import {
  amaCredentials,
  amaKeyScope,
  persistedAmaModel,
} from "../agent/ama-credentials";
import { audit } from "../identity/audit";
import { parseCustomAgents } from "../settings/custom-agents";
import { settingsDomain } from "../settings";
import { collabDispatcher } from "./collab";
import {
  CLIENT_REVISION_HEADER,
  HOOK_TOKEN_HEADER,
  NODE_TOKEN_HEADER,
  type HookRequest,
  type IngestContext,
  ingest,
} from "./ingest";
import { receiveModHello } from "./mod-hello";
import { answerOverlay } from "./overlay-route";
import type { HookService } from "./service";

/**
 * The loopback hook service — contract §5.2.
 *
 * Its own listener, its own credentials and its own body limit, and
 * deliberately **not** the core's main server: a browser has no business on
 * these routes, so there is no CORS layer here at all and the only transport a
 * desktop install advertises is a Unix socket nothing on the network can
 * reach.
 *
 * The client reads stdin into memory with the same cap; the server refuses
 * more.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface HookServerOptions extends IngestContext {
  /** Answers a Unix socket as well as (or instead of) a TCP port. */
  readonly socketPath?: string | undefined;
  /** Refuse every request while the core is shutting down. */
  readonly shuttingDown?: () => boolean;
}

export class HookServer {
  readonly router = new Router(ROUTES, "hook");
  private readonly servers: { server: Server; spec: ListenSpec }[] = [];

  constructor(private readonly options: HookServerOptions) {
    this.router.handle(
      "GET",
      "/verify",
      (_match, request) => this.requireBearer(request) ?? { status: 204 },
    );

    this.router.handle("POST", "/hook/{agentId}", (match, request) => {
      const refusal = this.requireBearer(request);
      if (refusal !== undefined) return refusal;
      let body: HookRequest;
      try {
        body = (request.json<HookRequest>() ?? {}) as HookRequest;
      } catch {
        return {
          status: 400,
          body: { code: "bad_request", message: "请求体不是 JSON" },
        };
      }
      return ingest(
        this.options,
        match.params.agentId ?? "",
        body,
        headerRecord(request),
      );
    });

    // Contract §57.3: a Claude Code mod says it loaded.
    this.router.handle("POST", "/node/mod", (_match, request) => {
      const refusal = this.requireBearer(request);
      if (refusal !== undefined) return refusal;
      let body: unknown;
      try {
        body = request.json<unknown>();
      } catch {
        return {
          status: 400,
          body: { code: "bad_request", message: "请求体不是 JSON" },
        };
      }
      return receiveModHello(
        this.options.hooks,
        body,
        single(request.headers[NODE_TOKEN_HEADER]),
        this.options.now,
      );
    });

    // Contract §57.4 / §58: the counts the mod's band draws.
    this.router.handle("GET", "/node/overlay", (_match, request) => {
      const refusal = this.requireBearer(request);
      if (refusal !== undefined) return refusal;
      return answerOverlay(this.options, {
        nodeId: request.query.get("nodeId") ?? "",
        nodeToken: single(request.headers[NODE_TOKEN_HEADER]),
        ifNoneMatch: single(request.headers["if-none-match"]),
      });
    });

    this.router.handle("POST", "/credential", (_match, request) =>
      this.credential(request),
    );
    this.router.handle("POST", "/credential/ama", (_match, request) =>
      this.amaKeys(request),
    );

    for (const family of ["context-link", "control", "browser"] as const) {
      this.router.handle("POST", `/${family}/{verb}`, async (match, request) =>
        this.collab(family, match.params.verb ?? "", request),
      );
    }
  }

  /**
   * The app bearer. `undefined` means the caller may proceed; anything else is
   * the answer to send.
   */
  private requireBearer(request: CoreRequest): HandlerResult | undefined {
    const presented = single(request.headers[HOOK_TOKEN_HEADER]);
    if (this.options.hooks.bearerMatches(presented)) return undefined;
    return {
      status: 403,
      body: { code: "forbidden", message: "The hook token is not valid" },
    };
  }

  /**
   * The three collaboration families. Authentication is this surface's; the
   * verb table belongs to the domain that registered a dispatcher.
   *
   * `context-link` and `browser` answer prose because the client prints the
   * body verbatim into the calling agent's stdout; `control` answers JSON
   * unless the caller asked for text.
   */
  private async collab(
    family: "context-link" | "control" | "browser",
    verb: string,
    request: CoreRequest,
  ): Promise<HandlerResult> {
    const prose = family !== "control" || wantsText(request);
    const refusal = this.requireBearer(request);
    if (refusal !== undefined) {
      return prose
        ? text(refusal.status, `${(refusal.body as CoreError).message}\n`)
        : refusal;
    }
    let body: { nodeId?: unknown; args?: unknown };
    try {
      body = (request.json<{ nodeId?: unknown; args?: unknown }>() ?? {}) as {
        nodeId?: unknown;
        args?: unknown;
      };
    } catch {
      body = {};
    }
    const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
    const verdict = this.options.hooks.verdict(
      nodeId,
      single(request.headers[NODE_TOKEN_HEADER]),
    );
    if (verdict === "forged") {
      const message =
        "The node token was minted by this core but does not match the node";
      return prose
        ? text(403, `${message}\n`)
        : { status: 403, body: { code: "forbidden", message } };
    }
    const dispatcher = collabDispatcher(family);
    if (dispatcher === undefined) {
      const message = `协作动词 ${family}/${verb} 尚未接入（R3）`;
      return prose
        ? text(501, `${message}\n`)
        : { status: 501, body: { code: "not_implemented", message } };
    }
    const args =
      typeof body.args === "object" && body.args !== null
        ? (body.args as Record<string, unknown>)
        : {};
    const answer = await dispatcher({
      verb,
      caller: { nodeId, verified: verdict === "verified" },
      args,
      wantsText: prose,
    });
    return answer.kind === "text"
      ? text(answer.status, answer.body)
      : { status: answer.status, body: answer.body };
  }

  /**
   * 画布启动器兑换节点凭据（契约 §20.4）。值只走这一条本机回环通道：要应用
   * bearer，且节点 token 必须**验过**（`legacy` 没 token 的不行），只答这个节点
   * 此刻绑定的那一条。答复与失败都不记日志。
   */
  private async credential(request: CoreRequest): Promise<HandlerResult> {
    const refusal = this.requireBearer(request);
    if (refusal !== undefined) return refusal;
    let body: { nodeId?: unknown; ref?: unknown };
    try {
      body = (request.json<{ nodeId?: unknown; ref?: unknown }>() ?? {}) as {
        nodeId?: unknown;
        ref?: unknown;
      };
    } catch {
      body = {};
    }
    const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
    const ref = typeof body.ref === "string" ? body.ref : "";
    const verdict = this.options.hooks.verdict(
      nodeId,
      single(request.headers[NODE_TOKEN_HEADER]),
    );
    if (nodeId === "" || ref === "" || verdict !== "verified") {
      return {
        status: 403,
        body: { code: "forbidden", message: "The node token is not valid" },
      };
    }
    const domain = credentialsDomain();
    if (domain === undefined) {
      return {
        status: 503,
        body: {
          code: "credential_unavailable",
          message: "Node credentials are not assembled",
        },
      };
    }
    try {
      const redeemed = await domain.redeem(
        nodeId,
        ref,
        persistedBinding(this.options.database, nodeId),
      );
      return {
        status: 200,
        body: redeemed,
        headers: { "cache-control": "no-store" },
      };
    } catch (failure) {
      if (failure instanceof CredentialError) {
        return {
          status: failure.status,
          body: { code: failure.code, message: failure.message },
        };
      }
      return {
        status: 500,
        body: { code: "internal", message: "Could not redeem the credential" },
      };
    }
  }

  /**
   * ama 的模型密钥（契约 §12.4），给画布启动器 `run/ama` 兑换：与 `/credential`
   * 同一道门——应用 bearer、节点 token 必须**验过**——外加节点在画布上就是 ama
   * （或以它为基础的自定义 Agent），别的节点拿不到。答已设的那几家，变量名是
   * ama 自己读的 `AMA_API_KEY_<供应商>`。答复与失败都不记日志。
   */
  private async amaKeys(request: CoreRequest): Promise<HandlerResult> {
    const refusal = this.requireBearer(request);
    if (refusal !== undefined) return refusal;
    let nodeId = "";
    try {
      const body = request.json<{ nodeId?: unknown }>();
      if (typeof body?.nodeId === "string") nodeId = body.nodeId;
    } catch {
      nodeId = "";
    }
    const verdict = this.options.hooks.verdict(
      nodeId,
      single(request.headers[NODE_TOKEN_HEADER]),
    );
    if (nodeId === "" || verdict !== "verified") {
      return {
        status: 403,
        body: { code: "forbidden", message: "The node token is not valid" },
      };
    }
    const agentId = persistedBinding(this.options.database, nodeId).agentId;
    const base =
      agentId === undefined
        ? undefined
        : (parseCustomAgents(settingsDomain()?.settings.snapshot() ?? {}).find(
            (custom) => custom.id === agentId,
          )?.baseAgent ?? agentId);
    if (base !== "ama") {
      return {
        status: 403,
        body: { code: "forbidden", message: "This node is not an ama node" },
      };
    }
    const keys = amaCredentials();
    if (keys === undefined) {
      return {
        status: 503,
        body: {
          code: "credential_unavailable",
          message: "ama's model keys are not assembled",
        },
      };
    }
    // 只答节点模型那一家（安全审查 L10）；没设模型时 ama 从已设的里挑缺省，
    // 只能答全部，记一条审计。
    const scope = amaKeyScope(persistedAmaModel(this.options.database, nodeId));
    if (scope.kind === "unscoped") {
      audit({
        action: "ama.credential.unscoped",
        target: nodeId,
        detail: { reason: "no_model" },
      });
    }
    try {
      return {
        status: 200,
        body: {
          variables: await keys.variables(
            scope.kind === "provider" ? scope.providers : undefined,
          ),
        },
        headers: { "cache-control": "no-store" },
      };
    } catch {
      return {
        status: 503,
        body: {
          code: "secret_unavailable",
          message: "The secret store is unavailable",
        },
      };
    }
  }

  /** One listener per address; the router is shared. */
  private createListener(): Server {
    return createServer((request, response) => {
      void this.serve(request, response);
    });
  }

  private async serve(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.options.shuttingDown?.() === true) {
      send(response, 503, { code: "unavailable", message: "核心正在退出" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://hook");
    let answer: HandlerResult;
    try {
      const body = await readBody(request, MAX_BODY_BYTES);
      if (!body.ok) {
        answer = body.tooLarge
          ? {
              status: 413,
              body: { code: "payload_too_large", message: body.reason },
            }
          : {
              status: 400,
              body: { code: "bad_request", message: body.reason },
            };
      } else {
        answer = (await this.router.dispatch(
          request.method ?? "GET",
          url.pathname,
          {
            method: (request.method ?? "GET").toUpperCase(),
            path: url.pathname,
            query: url.searchParams,
            headers: request.headers,
            body: body.body,
            raw: request,
            json: <T>() =>
              JSON.parse(body.body.toString("utf8") || "null") as T,
          },
        )) as HandlerResult;
      }
    } catch (error) {
      this.options.log.warn("hook request failed", {
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      answer = {
        status: 500,
        body: { code: "internal", message: "核心处理 hook 请求时失败" },
      };
    }
    send(
      response,
      answer.status,
      answer.body,
      answer.headers,
      "raw" in answer ? answer.raw : undefined,
    );
  }

  /** Binds one address. Failures are the caller's to report. */
  async listen(spec: ListenSpec): Promise<ListenSpec> {
    const server = this.createListener();
    const bound = await bind(server, spec);
    this.servers.push({ server, spec: bound });
    return bound;
  }

  async close(): Promise<void> {
    await Promise.all(
      this.servers.map(
        ({ server }) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    for (const { spec } of this.servers) release(spec);
    this.servers.length = 0;
  }
}

interface CoreError {
  readonly code: string;
  readonly message: string;
}

function text(status: number, body: string): HandlerResult {
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    raw: Buffer.from(body, "utf8"),
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function wantsText(request: CoreRequest): boolean {
  const accept = single(request.headers.accept) ?? "";
  return accept.includes("text/plain");
}

/** The three headers the ingest path reads, lower-cased and de-duplicated. */
function headerRecord(
  request: CoreRequest,
): Record<string, string | undefined> {
  return {
    [HOOK_TOKEN_HEADER]: single(request.headers[HOOK_TOKEN_HEADER]),
    [NODE_TOKEN_HEADER]: single(request.headers[NODE_TOKEN_HEADER]),
    [CLIENT_REVISION_HEADER]: single(request.headers[CLIENT_REVISION_HEADER]),
  };
}

function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  raw?: Buffer,
): void {
  const empty = status === 204 || status === 304;
  const payload = empty
    ? Buffer.alloc(0)
    : (raw ?? Buffer.from(JSON.stringify(body ?? null), "utf8"));
  response.writeHead(status, {
    ...(empty || raw !== undefined
      ? {}
      : { "content-type": "application/json" }),
    ...headers,
    ...(empty ? {} : { "content-length": String(payload.byteLength) }),
  });
  response.end(payload);
}
