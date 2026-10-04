/**
 * `/api/forge/*`（契约 §29）。
 *
 * 权限由路由门判（`http/route-scopes.ts`：读 `github:read`、写 `github:write`），
 * `POST /api/forge/resolve` 只是读，登记时声明成 `github:read`。这里只解析参数、
 * 调服务、把 {@link ForgeError} 翻成 `{ code, message }`；远端原话不往外传。
 */

import { coreError } from "../http/errors";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import type { CoreServer } from "../http/server";
import type { ForgeService } from "./service";
import { configKey, forgeRepo } from "./service";
import {
  ForgeError,
  type ForgeMergeMethod,
  type ForgeRepo,
  MAX_BODY,
  MAX_LIMIT,
  MAX_NUMBER,
  MAX_PAGE,
  MAX_TITLE,
} from "./types";

const REPO = "/api/forge/repos/{host}/{owner}/{name}";

export const FORGE_ROUTES = {
  configs: "/api/forge/configs",
  hostConfig: "/api/forge/configs/{host}",
  repoConfig: "/api/forge/configs/{host}/{owner}/{name}",
  resolve: "/api/forge/resolve",
  repo: REPO,
  issues: `${REPO}/issues`,
  issue: `${REPO}/issues/{number}`,
  pulls: `${REPO}/pulls`,
  pull: `${REPO}/pulls/{number}`,
  pullFiles: `${REPO}/pulls/{number}/files`,
  pullChecks: `${REPO}/pulls/{number}/checks`,
  pullMerge: `${REPO}/pulls/{number}/merge`,
  mergeOptions: `${REPO}/merge-options`,
  pullAutoMerge: `${REPO}/pulls/{number}/auto-merge`,
} as const;

const MERGE_METHODS: readonly ForgeMergeMethod[] = [
  "merge",
  "squash",
  "rebase",
];

class BadRequest extends Error {}

function bad(message: string): never {
  throw new BadRequest(message);
}

/** 远端拒绝 → 线上的拒绝。不用 401：那会让页面以为自己的会话过期了。 */
export function forgeFailure(error: unknown): HandlerResult {
  if (error instanceof BadRequest)
    return coreError(400, "bad_request", error.message);
  if (!(error instanceof ForgeError)) {
    return coreError(500, "internal_error", "托管平台请求失败");
  }
  switch (error.kind) {
    case "invalid":
      return coreError(
        400,
        "bad_request",
        `请求不对（${error.reason || "invalid"}）`,
      );
    case "notFound":
      return coreError(404, "not_found", "没有这个仓库、issue、PR 或配置");
    case "notConfigured":
      return coreError(
        409,
        "forge_not_configured",
        "这个仓库没有配置托管平台或令牌",
      );
    case "credentialRejected":
      return coreError(
        502,
        "forge_credential_rejected",
        "托管平台不认这个令牌",
      );
    case "remoteForbidden":
      return coreError(403, "forge_forbidden", "这个令牌没有这项权限");
    case "scopeMissing":
      return coreError(403, "forge_scope", "这个令牌缺少所需的范围");
    case "conflict":
      if (error.reason === "REBASE_STARTED") {
        return coreError(
          409,
          "rebase_started",
          "已开始变基，没有合并；等新的 head 出来、核对后再合",
        );
      }
      return coreError(
        409,
        "conflict",
        `远端或存着的版本变了，重新读一遍（${error.reason || "conflict"}）`,
      );
    case "rateLimited":
      return coreError(429, "rate_limited", "托管平台限流了，稍后再试");
    case "unknownOutcome":
      return coreError(
        504,
        "unknown_outcome",
        "写已发出但没读到结果；重新读一遍再决定，不要直接重试",
      );
    default:
      return coreError(502, "forge_unavailable", "托管平台暂时连不上");
  }
}

function body(request: CoreRequest): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = request.body.byteLength === 0 ? {} : request.json();
  } catch {
    return bad("请求体不是合法的 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return bad("请求体要是一个对象");
  }
  return parsed as Record<string, unknown>;
}

function repoOf(match: RouteMatch): ForgeRepo {
  const { host = "", owner = "", name = "" } = match.params;
  return forgeRepo(host, owner, name);
}

function numberOf(match: RouteMatch): number {
  const raw = match.params.number ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) bad("number 不对");
  const value = Number(raw);
  if (value > MAX_NUMBER) bad("number 不对");
  return value;
}

function revisionOf(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return bad("expectedRevision 不对");
  }
  return value;
}

function listOptions(request: CoreRequest) {
  const state = request.query.get("state") ?? "open";
  if (state !== "open" && state !== "closed" && state !== "all") {
    bad("state 只能是 open、closed 或 all");
  }
  const cursor = request.query.get("cursor") ?? "";
  let page = 1;
  if (cursor !== "") {
    if (!/^[0-9]{1,4}$/.test(cursor)) bad("cursor 不对");
    page = Number(cursor);
    if (page < 2 || page > MAX_PAGE) bad("cursor 不对");
  }
  const rawLimit = request.query.get("limit") ?? "";
  let limit = 0;
  if (rawLimit !== "") {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) bad("limit 不对");
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) bad("limit 不对");
  }
  return { state: state as "open" | "closed" | "all", page, limit };
}

function stringField(
  input: Record<string, unknown>,
  key: string,
  options: { required: boolean; max: number },
): string {
  const value = input[key];
  if (value === undefined && !options.required) return "";
  if (typeof value !== "string") return bad(`${key} 要是字符串`);
  if (options.required && value.trim() === "") return bad(`${key} 不能为空`);
  if (value.length > options.max) return bad(`${key} 太长`);
  return value;
}

type Work = (
  match: RouteMatch,
  request: CoreRequest,
) => Promise<HandlerResult> | HandlerResult;

function guarded(work: Work): Work {
  return async (match, request) => {
    try {
      return await work(match, request);
    } catch (error) {
      return forgeFailure(error);
    }
  };
}

function configRoutes(service: ForgeService) {
  const keyOf = (match: RouteMatch): string => {
    const { host = "", owner, name } = match.params;
    return configKey(host, owner, name);
  };
  const put = guarded(async (match, request) => {
    const input = body(request);
    const token = input.token;
    if (token !== undefined && typeof token !== "string")
      bad("token 要是字符串");
    try {
      const saved = await service.configure(keyOf(match), {
        forge: stringField(input, "forge", { required: true, max: 32 }),
        apiBase: stringField(input, "apiBase", { required: true, max: 2048 }),
        ...(token === undefined ? {} : { token: token as string }),
        expectedRevision: revisionOf(input.expectedRevision),
      });
      return { status: 200, body: saved };
    } finally {
      // 令牌只在这一次请求里经过；不留在解析出来的对象上。
      if (typeof input.token === "string") input.token = "";
    }
  });
  const remove = guarded(async (match, request) => {
    const raw = request.query.get("expectedRevision") ?? "";
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) bad("expectedRevision 不对");
    await service.remove(keyOf(match), Number(raw));
    return { status: 200, body: { removed: true } };
  });
  return { put, remove };
}

export function installRoutes(server: CoreServer, service: ForgeService): void {
  const { router } = server;
  const { put, remove } = configRoutes(service);

  router.handle("GET", FORGE_ROUTES.configs, () => ({
    status: 200,
    body: { configs: service.configs() },
  }));
  router.handle("PUT", FORGE_ROUTES.hostConfig, put);
  router.handle("DELETE", FORGE_ROUTES.hostConfig, remove);
  router.handle("PUT", FORGE_ROUTES.repoConfig, put);
  router.handle("DELETE", FORGE_ROUTES.repoConfig, remove);

  // 读：地址在请求体里而不在查询串里，远端地址可能带着凭据。
  router.handle(
    "POST",
    FORGE_ROUTES.resolve,
    guarded((_match, request) => {
      const input = body(request);
      const remoteUrl = stringField(input, "remoteUrl", {
        required: true,
        max: 2048,
      });
      return { status: 200, body: service.resolve(remoteUrl) };
    }),
    { scope: "github:read" },
  );

  router.handle(
    "GET",
    FORGE_ROUTES.repo,
    guarded((match) => ({ status: 200, body: service.detect(repoOf(match)) })),
  );

  router.handle(
    "GET",
    FORGE_ROUTES.issues,
    guarded(async (match, request) => {
      const repo = repoOf(match);
      const options = listOptions(request);
      const page = await service.forgeFor(repo).listIssues(repo, options);
      // 列表不带正文：详情请求把整份拿回来。
      return {
        status: 200,
        body: {
          items: page.items.map((issue) => ({ ...issue, body: "" })),
          nextCursor: page.nextCursor,
        },
      };
    }),
  );
  router.handle(
    "GET",
    FORGE_ROUTES.issue,
    guarded(async (match) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      return {
        status: 200,
        body: await service.forgeFor(repo).getIssue(repo, number),
      };
    }),
  );
  router.handle(
    "PATCH",
    FORGE_ROUTES.issue,
    guarded(async (match, request) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      const state = body(request).state;
      if (state !== "open" && state !== "closed")
        bad("state 只能是 open 或 closed");
      const issue = await service
        .forgeFor(repo)
        .setIssueState(repo, number, state as "open" | "closed");
      return { status: 200, body: issue };
    }),
  );

  router.handle(
    "GET",
    FORGE_ROUTES.pulls,
    guarded(async (match, request) => {
      const repo = repoOf(match);
      const options = listOptions(request);
      const page = await service.forgeFor(repo).listPulls(repo, options);
      return {
        status: 200,
        body: {
          items: page.items.map((pull) => ({ ...pull, body: "" })),
          nextCursor: page.nextCursor,
        },
      };
    }),
  );
  router.handle(
    "POST",
    FORGE_ROUTES.pulls,
    guarded(async (match, request) => {
      const repo = repoOf(match);
      const input = body(request);
      const draft = input.draft;
      if (draft !== undefined && typeof draft !== "boolean")
        bad("draft 要是布尔值");
      const pull = await service.forgeFor(repo).createPull(repo, {
        title: stringField(input, "title", { required: true, max: MAX_TITLE }),
        body: stringField(input, "body", { required: false, max: MAX_BODY }),
        head: stringField(input, "head", { required: true, max: 255 }),
        base: stringField(input, "base", { required: true, max: 255 }),
        draft: draft === true,
      });
      return { status: 201, body: pull };
    }),
  );
  router.handle(
    "GET",
    FORGE_ROUTES.pull,
    guarded(async (match) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      return {
        status: 200,
        body: await service.forgeFor(repo).getPull(repo, number),
      };
    }),
  );
  router.handle(
    "GET",
    FORGE_ROUTES.pullFiles,
    guarded(async (match) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      const files = await service.forgeFor(repo).pullFiles(repo, number);
      return { status: 200, body: { files } };
    }),
  );
  router.handle(
    "GET",
    FORGE_ROUTES.pullChecks,
    guarded(async (match) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      return {
        status: 200,
        body: await service.forgeFor(repo).checks(repo, number),
      };
    }),
  );
  // 流水线通过后合并（GitLab，§29.6）：没有这个能力的平台答 400。
  router.handle(
    "POST",
    FORGE_ROUTES.pullAutoMerge,
    guarded(async (match, request) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      const input = body(request);
      const method = input.method ?? "merge";
      if (!MERGE_METHODS.includes(method as ForgeMergeMethod)) {
        bad("method 只能是 merge、squash 或 rebase");
      }
      const headSha = stringField(input, "headSha", {
        required: true,
        max: 64,
      });
      const forge = service.forgeFor(repo);
      if (forge.autoMerge === undefined) bad("这个平台没有流水线通过后合并");
      const result = await forge.autoMerge(repo, number, {
        method: method as ForgeMergeMethod,
        headSha,
      });
      return { status: 200, body: result };
    }),
  );
  router.handle(
    "DELETE",
    FORGE_ROUTES.pullAutoMerge,
    guarded(async (match) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      const forge = service.forgeFor(repo);
      if (forge.cancelAutoMerge === undefined) {
        bad("这个平台没有流水线通过后合并");
      }
      await forge.cancelAutoMerge(repo, number);
      return { status: 200, body: { cancelled: true } };
    }),
  );
  router.handle(
    "GET",
    FORGE_ROUTES.mergeOptions,
    guarded(async (match) => {
      const repo = repoOf(match);
      return {
        status: 200,
        body: await service.forgeFor(repo).mergeOptions(repo),
      };
    }),
  );
  router.handle(
    "POST",
    FORGE_ROUTES.pullMerge,
    guarded(async (match, request) => {
      const repo = repoOf(match);
      const number = numberOf(match);
      const input = body(request);
      const method = input.method ?? "merge";
      if (!MERGE_METHODS.includes(method as ForgeMergeMethod)) {
        bad("method 只能是 merge、squash 或 rebase");
      }
      const headSha = stringField(input, "headSha", {
        required: true,
        max: 64,
      });
      const merged = await service.forgeFor(repo).merge(repo, number, {
        method: method as ForgeMergeMethod,
        headSha,
      });
      return { status: 200, body: merged };
    }),
  );
}
