/**
 * `/api/forge/*`（契约 §29）。
 *
 * 权限由路由门判（`http/route-scopes.ts`：读 `github:read`、写 `github:write`），
 * `POST /api/forge/resolve` 只是读，登记时声明成 `github:read`。这里只解析参数、
 * 调服务、把 {@link ForgeError} 翻成 `{ code, message }`；远端原话不往外传。
 *
 * 一份实现（契约 §41.2）：{@link operations} 是每个动作的实现，路由表里的旧 handler
 * 与 `registerProcedures(server, "forge", …)` 调同一份，拒绝的码与原话因此一样。
 * 入参是一个键值表：旧 handler 把路径参数、查询串与体并成它，procedure 的入参
 * 就是它。令牌只在 `configure` 里经过一次，不留在入参上，也不进错误细节。
 */

import { CoreFailure, fail } from "../http/errors";
import { registerProcedures } from "../http/rpc";
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
  pullBranch: `${REPO}/pulls/{number}/branch`,
} as const;

const MERGE_METHODS: readonly ForgeMergeMethod[] = [
  "merge",
  "squash",
  "rebase",
];

/** 一次调用的入参：旧路径的路径参数、查询串与体并成的表，或 procedure 的入参。 */
type Args = Record<string, unknown>;

function bad(message: string): never {
  throw fail("bad_request", message);
}

/**
 * 远端拒绝 → 抛出的拒绝。不用 401：那会让页面以为自己的会话过期了。
 */
export function forgeProblem(error: unknown): CoreFailure {
  if (error instanceof CoreFailure) return error;
  if (!(error instanceof ForgeError)) {
    return fail("internal", "托管平台请求失败");
  }
  switch (error.kind) {
    case "invalid":
      return fail("bad_request", `请求不对（${error.reason || "invalid"}）`);
    case "notFound":
      return fail("not_found", "没有这个仓库、issue、PR 或配置");
    case "notConfigured":
      return fail("forge_not_configured", "这个仓库没有配置托管平台或令牌");
    case "credentialRejected":
      return fail("forge_credential_rejected", "托管平台不认这个令牌");
    case "remoteForbidden":
      return fail("forge_forbidden", "这个令牌没有这项权限");
    case "scopeMissing":
      return fail("forge_scope", "这个令牌缺少所需的范围");
    case "conflict":
      if (error.reason === "REBASE_STARTED") {
        return fail(
          "rebase_started",
          "已开始变基，没有合并；等新的 head 出来、核对后再合",
        );
      }
      return fail(
        "conflict",
        `远端或存着的版本变了，重新读一遍（${error.reason || "conflict"}）`,
      );
    case "rateLimited":
      return fail("rate_limited", "托管平台限流了，稍后再试");
    case "unknownOutcome":
      return fail(
        "unknown_outcome",
        "写已发出但没读到结果；重新读一遍再决定，不要直接重试",
      );
    default:
      return fail("forge_unavailable", "托管平台暂时连不上");
  }
}

/** 旧路径的答法：拒绝换成 `{ code, message }`。 */
export function forgeFailure(error: unknown): HandlerResult {
  return forgeProblem(error).response();
}

/** 路径里的一段，或 procedure 入参里的同名字段。 */
function text(args: Args, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function repoOf(args: Args): ForgeRepo {
  return forgeRepo(text(args, "host"), text(args, "owner"), text(args, "name"));
}

/** 编号：旧路径是路径段（字符串），procedure 是数字。 */
function numberOf(args: Args): number {
  const given = args.number;
  const raw =
    typeof given === "number"
      ? String(given)
      : typeof given === "string"
        ? given
        : "";
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

/** 删除要带的版本：旧路径在查询串里（字符串），procedure 是数字，且至少是 1。 */
function removalRevision(value: unknown): number {
  const raw =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) bad("expectedRevision 不对");
  return Number(raw);
}

function listOptions(args: Args) {
  const state = args.state === undefined ? "open" : text(args, "state");
  if (state !== "open" && state !== "closed" && state !== "all") {
    bad("state 只能是 open、closed 或 all");
  }
  const cursor = args.cursor === undefined ? "" : text(args, "cursor");
  let page = 1;
  if (cursor !== "") {
    if (!/^[0-9]{1,4}$/.test(cursor)) bad("cursor 不对");
    page = Number(cursor);
    if (page < 2 || page > MAX_PAGE) bad("cursor 不对");
  }
  const rawLimit =
    typeof args.limit === "number"
      ? String(args.limit)
      : args.limit === undefined
        ? ""
        : text(args, "limit");
  let limit = 0;
  if (rawLimit !== "") {
    if (!/^[0-9]{1,3}$/.test(rawLimit)) bad("limit 不对");
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) bad("limit 不对");
  }
  return { state: state as "open" | "closed" | "all", page, limit };
}

function stringField(
  input: Args,
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

function mergeInput(args: Args) {
  const method = args.method ?? "merge";
  if (!MERGE_METHODS.includes(method as ForgeMergeMethod)) {
    bad("method 只能是 merge、squash 或 rebase");
  }
  return {
    method: method as ForgeMergeMethod,
    headSha: stringField(args, "headSha", { required: true, max: 64 }),
  };
}

function configKeyOf(args: Args): string {
  return configKey(
    text(args, "host"),
    args.owner === undefined ? undefined : text(args, "owner"),
    args.name === undefined ? undefined : text(args, "name"),
  );
}

/** 列表不带正文：详情请求把整份拿回来。 */
function withoutBodies<T extends { body: string }>(page: {
  items: readonly T[];
  nextCursor: string | null;
}) {
  return {
    items: page.items.map((item) => ({ ...item, body: "" })),
    nextCursor: page.nextCursor,
  };
}

/** 每个动作的实现；旧 handler 与 procedure 都调它。 */
function operations(service: ForgeService) {
  return {
    configs: () => ({ configs: service.configs() }),

    async configure(args: Args) {
      try {
        const token = args.token;
        if (token !== undefined && typeof token !== "string")
          bad("token 要是字符串");
        return await service.configure(configKeyOf(args), {
          forge: stringField(args, "forge", { required: true, max: 32 }),
          apiBase: stringField(args, "apiBase", { required: true, max: 2048 }),
          ...(token === undefined ? {} : { token: token as string }),
          expectedRevision: revisionOf(args.expectedRevision),
        });
      } finally {
        // 令牌只在这一次请求里经过；不留在解析出来的对象上。
        if (typeof args.token === "string") args.token = "";
      }
    },

    async removeConfig(args: Args) {
      await service.remove(
        configKeyOf(args),
        removalRevision(args.expectedRevision),
      );
      return { removed: true };
    },

    // 读：地址在请求体里而不在查询串里，远端地址可能带着凭据。
    resolve(args: Args) {
      const remoteUrl = stringField(args, "remoteUrl", {
        required: true,
        max: 2048,
      });
      return service.resolve(remoteUrl);
    },

    detect: (args: Args) => service.detect(repoOf(args)),

    async issues(args: Args) {
      const repo = repoOf(args);
      const options = listOptions(args);
      return withoutBodies(
        await service.forgeFor(repo).listIssues(repo, options),
      );
    },

    async issue(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      return await service.forgeFor(repo).getIssue(repo, number);
    },

    async setIssueState(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      const state = args.state;
      if (state !== "open" && state !== "closed")
        bad("state 只能是 open 或 closed");
      return await service
        .forgeFor(repo)
        .setIssueState(repo, number, state as "open" | "closed");
    },

    async pulls(args: Args) {
      const repo = repoOf(args);
      const options = listOptions(args);
      return withoutBodies(
        await service.forgeFor(repo).listPulls(repo, options),
      );
    },

    async createPull(args: Args) {
      const repo = repoOf(args);
      const draft = args.draft;
      if (draft !== undefined && typeof draft !== "boolean")
        bad("draft 要是布尔值");
      return await service.forgeFor(repo).createPull(repo, {
        title: stringField(args, "title", { required: true, max: MAX_TITLE }),
        body: stringField(args, "body", { required: false, max: MAX_BODY }),
        head: stringField(args, "head", { required: true, max: 255 }),
        base: stringField(args, "base", { required: true, max: 255 }),
        draft: draft === true,
      });
    },

    async pull(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      return await service.forgeFor(repo).getPull(repo, number);
    },

    async pullFiles(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      return { files: await service.forgeFor(repo).pullFiles(repo, number) };
    },

    async pullChecks(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      return await service.forgeFor(repo).checks(repo, number);
    },

    // 流水线 / 检查通过后合并（GitLab、Gitea，§29.6）：没有这个能力的平台答 400。
    async autoMerge(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      const input = mergeInput(args);
      const forge = service.forgeFor(repo);
      if (forge.autoMerge === undefined) bad("这个平台没有流水线通过后合并");
      return await forge.autoMerge(repo, number, input);
    },

    async cancelAutoMerge(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      const forge = service.forgeFor(repo);
      if (forge.cancelAutoMerge === undefined) {
        bad("这个平台没有流水线通过后合并");
      }
      await forge.cancelAutoMerge(repo, number);
      return { cancelled: true };
    },

    // 合并后删源分支（Gitea / GitLab；GitHub 走 §5 的 `delete-branch`）。
    async deleteBranch(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      const headSha = args.headSha === undefined ? "" : text(args, "headSha");
      if (headSha === "") bad("headSha 不能为空");
      const forge = service.forgeFor(repo);
      if (forge.deleteBranch === undefined) bad("这个平台在这里不删分支");
      return await forge.deleteBranch(repo, number, headSha);
    },

    async mergeOptions(args: Args) {
      const repo = repoOf(args);
      return await service.forgeFor(repo).mergeOptions(repo);
    },

    async merge(args: Args) {
      const repo = repoOf(args);
      const number = numberOf(args);
      return await service.forgeFor(repo).merge(repo, number, mergeInput(args));
    },
  };
}

function bodyOf(request: CoreRequest): Args {
  let parsed: unknown;
  try {
    parsed = request.body.byteLength === 0 ? {} : request.json();
  } catch {
    return bad("请求体不是合法的 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return bad("请求体要是一个对象");
  }
  return parsed as Args;
}

/** 旧路径的入参表：体（只有写才解析）、查询串、路径参数，后者盖过前者。 */
function argsOf(
  request: CoreRequest,
  match: RouteMatch,
  options: { body: boolean; query: boolean },
): Args {
  const args: Args = options.body ? { ...bodyOf(request) } : {};
  if (options.query) {
    for (const [key, value] of request.query) args[key] = value;
  }
  return { ...args, ...match.params };
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

export function installRoutes(server: CoreServer, service: ForgeService): void {
  const { router } = server;
  const run = operations(service);
  const route = (
    method: string,
    path: string,
    options: { body?: boolean; query?: boolean; status?: number },
    work: (args: Args) => unknown,
    scope?: { scope: "github:read" },
  ) =>
    router.handle(
      method,
      path,
      guarded(async (match, request) => ({
        status: options.status ?? 200,
        body: await work(
          argsOf(request, match, {
            body: options.body ?? false,
            query: options.query ?? false,
          }),
        ),
      })),
      scope,
    );

  route("GET", FORGE_ROUTES.configs, {}, () => run.configs());
  route("PUT", FORGE_ROUTES.hostConfig, { body: true }, run.configure);
  route("DELETE", FORGE_ROUTES.hostConfig, { query: true }, run.removeConfig);
  route("PUT", FORGE_ROUTES.repoConfig, { body: true }, run.configure);
  route("DELETE", FORGE_ROUTES.repoConfig, { query: true }, run.removeConfig);
  route("POST", FORGE_ROUTES.resolve, { body: true }, run.resolve, {
    scope: "github:read",
  });
  route("GET", FORGE_ROUTES.repo, {}, run.detect);
  route("GET", FORGE_ROUTES.issues, { query: true }, run.issues);
  route("GET", FORGE_ROUTES.issue, {}, run.issue);
  route("PATCH", FORGE_ROUTES.issue, { body: true }, run.setIssueState);
  route("GET", FORGE_ROUTES.pulls, { query: true }, run.pulls);
  route(
    "POST",
    FORGE_ROUTES.pulls,
    { body: true, status: 201 },
    run.createPull,
  );
  route("GET", FORGE_ROUTES.pull, {}, run.pull);
  route("GET", FORGE_ROUTES.pullFiles, {}, run.pullFiles);
  route("GET", FORGE_ROUTES.pullChecks, {}, run.pullChecks);
  route("POST", FORGE_ROUTES.pullAutoMerge, { body: true }, run.autoMerge);
  route("DELETE", FORGE_ROUTES.pullAutoMerge, {}, run.cancelAutoMerge);
  route("DELETE", FORGE_ROUTES.pullBranch, { query: true }, run.deleteBranch);
  route("GET", FORGE_ROUTES.mergeOptions, {}, run.mergeOptions);
  route("POST", FORGE_ROUTES.pullMerge, { body: true }, run.merge);

  // procedure：入参已由门面按契约解析，拒绝抛 `CoreFailure`，答案原样交回。
  const procedure =
    (work: (args: Args) => unknown) =>
    async (input: unknown): Promise<never> => {
      try {
        return (await work(input as Args)) as never;
      } catch (error) {
        throw forgeProblem(error);
      }
    };
  registerProcedures(server, "forge", {
    configs: procedure(() => run.configs()),
    putHostConfig: procedure(run.configure),
    removeHostConfig: procedure(run.removeConfig),
    putRepoConfig: procedure(run.configure),
    removeRepoConfig: procedure(run.removeConfig),
    resolve: procedure(run.resolve),
    detect: procedure(run.detect),
    issues: procedure(run.issues),
    issue: procedure(run.issue),
    setIssueState: procedure(run.setIssueState),
    pulls: procedure(run.pulls),
    createPull: procedure(run.createPull),
    pull: procedure(run.pull),
    pullFiles: procedure(run.pullFiles),
    pullChecks: procedure(run.pullChecks),
    mergeOptions: procedure(run.mergeOptions),
    merge: procedure(run.merge),
    autoMerge: procedure(run.autoMerge),
    cancelAutoMerge: procedure(run.cancelAutoMerge),
    deleteBranch: procedure(run.deleteBranch),
  });
}
