import type { DatabaseSync } from "node:sqlite";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { CoreServer } from "../http/server";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { canonicalDirectory, contains } from "../workspaces/roots";
import {
  DomainError,
  badRequest as workspaceBadRequest,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import {
  type Workspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  validWorkspaceName,
} from "../workspaces/table";
import { executeOn, isRemote } from "../remote/execute";
import { remoteGitOperations } from "../remote/git-operations";
import { cancelClone, cloneStatus, startClone } from "./clone";
import type { DiffScope } from "./diff";
import { invalidate } from "./discovery";
import type { GitHunkScope } from "./hunks";
import {
  type Capture,
  type GitMessageLanguage,
  type GitMessageRequest,
  type GitMessageSource,
  generate,
  generateFrom,
  providers,
} from "./message";
import { integrationStatus } from "./repository/integration";
import { startOperation } from "./repository/queue";
import { RepositoryService } from "./repository/service";
import type {
  ExpectedState,
  IntegrationSnapshot,
  LogRefKind,
  LogRequest,
  OperationSnapshot,
  RepositoryAction,
} from "./repository/types";
import { verifyWorktreeBinding } from "./repository/worktrees";
import type { RestoreSource } from "./stage";
import { badRequest, commaPaths, forbidden, requireExecution } from "./support";

/**
 * Every `git/*` route, and the permission gate each one opens with.
 *
 * The gates are the Rust handlers' own, in the same order: read for a read,
 * read **and** write for a write, then the execution grant. What is *not*
 * ported is the write-ownership check every Rust write began with — it asked
 * whether this process or the Go Host owned the git domain, and with one
 * process there is no second answer (TypeScript core design §6).
 *
 * Reads are deliberately not gated on write. A core that cannot write still
 * answers `status`, `diff` and `history`, because the panel has to keep showing
 * the repository it is not writing to.
 *
 * Where a command runs is the workspace's execution host. The reads and the
 * index / commit writes go through `remote/execute`, so a remote workspace's
 * repository is read and written by the Worker on that machine with the same
 * code. Repository operations queue on the Worker too; the ownership table
 * stays here, and the Worker pushes each operation's progress back
 * (`remote/git-operations.ts`). An AI commit message is split across the two
 * machines: the staged source is captured and redacted where the repository
 * is, the model runs here where its credentials are.
 */

/** 一次调用的入参：旧路径的查询串或体，或 procedure 解析好的入参。 */
type Args = Record<string, unknown>;

export interface GitRouteDeps {
  readonly server: CoreServer;
  readonly database: DatabaseSync;
  readonly service: RepositoryService;
  /** Which workspace started which operation; a controller-side fact. */
  readonly owners: Map<string, string>;
}

export function installRoutes(deps: GitRouteDeps): void {
  const { server } = deps;
  const handle = (
    method: string,
    path: string,
    handler: (
      match: RouteMatch,
      request: CoreRequest,
    ) => Promise<HandlerResult>,
  ): void => {
    server.router.handle(method, path, answered(handler));
  };

  /* ------------------------- `git.*`（契约 §40.1） ------------------------- */

  // 一份实现：路由表里的旧 handler 与 procedure 都调它，拒绝的码与原话因此一样。
  // 入参是一个取值函数而不是值：旧 handler 在权限门之后才解析请求体（体坏了
  // 而工作空间又不许写时答的是 403），procedure 的入参由门面先解析好。
  const operations = {
    status: async (workspaceId: string, input: () => Args) => {
      const workspace = workspaceById(deps, workspaceId);
      requireExecution(workspace.permissions.execute, "Git worktree status");
      return await on(deps, workspace, "git.status", {
        path: pathField(input()),
      });
    },

    diff: async (workspaceId: string, input: () => Args) => {
      const workspace = workspaceById(deps, workspaceId);
      const args = input();
      return await on(deps, workspace, "git.diff", {
        path: pathField(args),
        scope: diffScopeOf(args.scope),
        paths: pathListOf(args.paths),
        ignoreWhitespace:
          args.ignoreWhitespace === true || args.ignoreWhitespace === "true",
        execute: workspace.permissions.execute,
      });
    },

    headCommit: async (workspaceId: string, input: () => Args) => {
      const workspace = workspaceById(deps, workspaceId);
      requireExecution(workspace.permissions.execute, "Git commit inspection");
      return await on(deps, workspace, "git.headCommit", {
        path: pathField(input()),
      });
    },

    init: async (workspaceId: string) => {
      // Creating a repository is the one write with no repository to queue on,
      // so its permission check is inline.
      const workspace = workspaceById(deps, workspaceId);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow Git writes");
      }
      requireExecution(
        workspace.permissions.execute,
        "Git repository initialization",
      );
      return await on(deps, workspace, "git.init");
    },

    paths: async (
      operation: "git.stage" | "git.unstage" | "git.resolve",
      workspaceId: string,
      input: () => Args,
    ) => {
      const { workspace, body } = writeRequest(deps, workspaceId, input);
      return await on(deps, workspace, operation, {
        path: pathField(body),
        paths: pathsField(body),
      });
    },

    revert: async (workspaceId: string, input: () => Args) => {
      const { workspace, body } = writeRequest(deps, workspaceId, input);
      const source = body.source ?? "index";
      if (source !== "index" && source !== "head") {
        throw badRequest("Restore source must be `index` or `head`");
      }
      return await on(deps, workspace, "git.revert", {
        path: pathField(body),
        paths: pathsField(body),
        source: source as RestoreSource,
      });
    },

    commit: async (workspaceId: string, input: () => Args) => {
      const { workspace, body } = writeRequest(deps, workspaceId, input);
      const message = body.message;
      if (typeof message !== "string") {
        throw badRequest("Commit message is invalid");
      }
      const paths =
        body.paths === undefined || body.paths === null
          ? undefined
          : pathsField(body);
      const amend = amendOf(body);
      return await on(deps, workspace, "git.commit", {
        path: pathField(body),
        message,
        ...(paths === undefined ? {} : { paths }),
        ...(amend === undefined ? {} : { amend }),
      });
    },

    messageProviders: async (workspaceId: string) => {
      // Listing providers runs nothing in the workspace; reading it is enough.
      workspaceById(deps, workspaceId);
      return await providers();
    },

    messageSource: async (workspaceId: string) => {
      const workspace = workspaceById(deps, workspaceId);
      requireExecution(
        workspace.permissions.execute,
        "AI staged-source inspection",
      );
      return await on(deps, workspace, "git.messageSource", {
        execute: workspace.permissions.execute,
      });
    },

    messageGenerate: async (workspaceId: string, input: () => Args) => {
      const workspace = workspaceById(deps, workspaceId);
      requireExecution(workspace.permissions.execute, "AI generation");
      const body = input();
      const language = body.language ?? "en";
      if (language !== "en" && language !== "zh") {
        throw badRequest("Unsupported message language");
      }
      const draft: GitMessageRequest = {
        provider: requiredString(body, "provider"),
        expectedHead: optionalString(body, "expectedHead") ?? null,
        indexDigest: requiredString(body, "indexDigest"),
        language: language as GitMessageLanguage,
        conventional: body.conventional === true,
      };
      if (isRemote(workspace)) {
        // 两台机器各跑一半：采集与复核在仓库那边（Worker），模型在凭据这边。
        const execute = workspace.permissions.execute;
        return await generateFrom(
          {
            capture: async () =>
              (await on(deps, workspace, "git.messageCapture", {
                execute,
              })) as Capture,
            source: async () =>
              (await on(deps, workspace, "git.messageSource", {
                execute,
              })) as GitMessageSource,
          },
          draft,
        );
      }
      return await generate(
        deps.service.withExecution(workspace.permissions.execute),
        workspace.rootPath,
        draft,
      );
    },

    hunks: async (workspaceId: string, input: () => Args) => {
      const workspace = workspaceById(deps, workspaceId);
      requireExecution(
        workspace.permissions.execute,
        "Git hunk worktree validation",
      );
      const args = input();
      const file = args.file;
      if (typeof file !== "string") {
        throw badRequest("A hunk read names no file");
      }
      return await on(deps, workspace, "git.hunks", {
        path: pathField(args),
        file,
        scope: hunkScopeOf(args.scope),
        execute: workspace.permissions.execute,
      });
    },

    applyHunk: async (workspaceId: string, input: () => Args) => {
      const workspace = workspaceById(deps, workspaceId);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow this Git operation");
      }
      requireExecution(workspace.permissions.execute, "Git hunk writes");
      const body = input();
      const action = body.action;
      if (action !== "stage" && action !== "unstage" && action !== "revert") {
        throw badRequest("Hunk action, scope or identity is invalid");
      }
      return await on(deps, workspace, "git.applyHunk", {
        execute: workspace.permissions.execute,
        mutation: {
          path: optionalString(body, "path") ?? ".",
          file: requiredString(body, "file"),
          scope: hunkScopeOf(optionalString(body, "scope")),
          diffDigest: requiredString(body, "diffDigest"),
          hunkId: requiredString(body, "hunkId"),
          action,
        },
      });
    },

    cloneStart: (body: Args) => {
      // A new project has no grant yet. If its destination is inside existing
      // workspaces, every ancestor's restrictions are preserved rather than
      // bypassed through this global creation endpoint.
      const parent = canonicalDirectory(requiredString(body, "parent"));
      for (const summary of listWorkspaces(deps.database)) {
        let root: string;
        try {
          root = canonicalDirectory(summary.rootPath);
        } catch {
          continue;
        }
        if (!contains(root, parent)) continue;
        if (!summary.permissions.read || !summary.permissions.write) {
          throw forbidden(
            "An ancestor workspace does not allow cloning into this destination",
          );
        }
        requireExecution(
          summary.permissions.execute,
          "Cloning into an existing workspace",
        );
      }
      const started = startClone(
        requiredString(body, "url"),
        parent,
        optionalString(body, "name"),
      );
      return { jobId: started.jobId };
    },

    cloneStatus: (jobId: string) => {
      const status = cloneStatus(jobId);
      // `createWorkspace` is idempotent on the root path, so two polls landing
      // at the same time cannot produce two workspaces.
      const workspace =
        status.state === "done"
          ? createWorkspace(deps.database, {
              name: validWorkspaceName(status.name),
              rootPath: canonicalDirectory(status.target),
            })
          : undefined;
      return {
        state: status.state,
        lines: status.lines,
        ...(status.error === null ? {} : { error: status.error }),
        ...(workspace === undefined ? {} : { workspace }),
      };
    },

    cloneCancel: (jobId: string) => {
      cancelClone(jobId);
    },
  };

  type Input = Args & { workspaceId: string };
  const given = (input: Args) => () => input;
  const handlers = {
    status: (input: Input) =>
      operations.status(input.workspaceId, given(input)),
    diff: (input: Input) => operations.diff(input.workspaceId, given(input)),
    headCommit: (input: Input) =>
      operations.headCommit(input.workspaceId, given(input)),
    init: (input: Input) => operations.init(input.workspaceId),
    stage: (input: Input) =>
      operations.paths("git.stage", input.workspaceId, given(input)),
    unstage: (input: Input) =>
      operations.paths("git.unstage", input.workspaceId, given(input)),
    resolve: (input: Input) =>
      operations.paths("git.resolve", input.workspaceId, given(input)),
    revert: (input: Input) =>
      operations.revert(input.workspaceId, given(input)),
    commit: (input: Input) =>
      operations.commit(input.workspaceId, given(input)),
    hunks: (input: Input) => operations.hunks(input.workspaceId, given(input)),
    applyHunk: (input: Input) =>
      operations.applyHunk(input.workspaceId, given(input)),
    message: {
      providers: (input: Input) =>
        operations.messageProviders(input.workspaceId),
      source: (input: Input) => operations.messageSource(input.workspaceId),
      generate: (input: Input) =>
        operations.messageGenerate(input.workspaceId, given(input)),
    },
    // 克隆是长操作：`start` 只起任务、答 `jobId`，进度由页面轮询 `status`。
    clone: {
      start: (input: Args) => operations.cloneStart(input),
      status: ({ jobId }: { jobId: string }) => operations.cloneStatus(jobId),
      cancel: ({ jobId }: { jobId: string }) => operations.cloneCancel(jobId),
    },
  };
  registerProcedures(
    server,
    "git",
    handlers as unknown as DomainHandlers<"git">,
  );

  // 旧路径：查询串或体先变成同一份入参，再调同一份实现。
  const query =
    (request: CoreRequest, ...names: string[]) =>
    (): Args =>
      Object.fromEntries(
        names.flatMap((name) => {
          const value = request.query.get(name);
          return value === null ? [] : [[name, value]];
        }),
      );
  const body = (request: CoreRequest) => () => jsonObject(request.body);
  const at = (match: RouteMatch) => param(match, "workspaceId");

  /* --------------------------------- reads -------------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/status",
    async (match, request) =>
      ok(await operations.status(at(match), query(request, "path"))),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/diff",
    async (match, request) =>
      ok(
        await operations.diff(
          at(match),
          query(request, "path", "scope", "paths", "ignoreWhitespace"),
        ),
      ),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/head-commit",
    async (match, request) =>
      ok(await operations.headCommit(at(match), query(request, "path"))),
  );

  /* -------------------------------- writes -------------------------------- */

  handle("POST", "/api/workspaces/{workspaceId}/git/init", async (match) =>
    ok(await operations.init(at(match))),
  );

  for (const [verb, operation] of [
    ["stage", "git.stage"],
    ["unstage", "git.unstage"],
    ["resolve", "git.resolve"],
  ] as const) {
    handle(
      "POST",
      `/api/workspaces/{workspaceId}/git/${verb}`,
      async (match, request) =>
        ok(await operations.paths(operation, at(match), body(request))),
    );
  }

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/revert",
    async (match, request) =>
      ok(await operations.revert(at(match), body(request))),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/commit",
    async (match, request) =>
      ok(await operations.commit(at(match), body(request))),
  );

  /* ------------------------------- AI message ----------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/message/providers",
    async (match) => ok(await operations.messageProviders(at(match))),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/message/source",
    async (match) => ok(await operations.messageSource(at(match))),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/message/generate",
    async (match, request) =>
      ok(await operations.messageGenerate(at(match), body(request))),
  );

  /* ---------------------------------- hunks ------------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/hunks",
    async (match, request) =>
      ok(
        await operations.hunks(
          at(match),
          query(request, "path", "file", "scope"),
        ),
      ),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/hunks",
    async (match, request) =>
      ok(await operations.applyHunk(at(match), body(request))),
  );

  /* ---------------------------------- clone ------------------------------- */

  handle("POST", "/api/git/clone", async (_match, request) =>
    ok(operations.cloneStart(jsonObject(request.body))),
  );

  handle("GET", "/api/git/clone/{jobId}", async (match) =>
    ok(operations.cloneStatus(param(match, "jobId"))),
  );

  handle("DELETE", "/api/git/clone/{jobId}", async (match) => {
    operations.cloneCancel(param(match, "jobId"));
    return { status: 204 };
  });

  /* ----------------------------- workspace reads -------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repositories",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const workspaceId = param(match, "workspaceId");
      if (request.query.get("refresh") === "true") invalidate(workspaceId);
      const depth = request.query.get("maxDepth");
      return ok(
        await on(deps, workspace, "git.repositories", {
          workspaceId,
          ...(depth === null ? {} : { maxDepth: positive(depth, "maxDepth") }),
          execute: workspace.permissions.execute,
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/log",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      return ok(
        await on(deps, workspace, "git.log", {
          workspaceId: param(match, "workspaceId"),
          request: logRequest(jsonObject(request.body)),
          execute: workspace.permissions.execute,
        }),
      );
    },
  );

  handle("GET", "/api/workspaces/{workspaceId}/git/refs", async (match) => {
    const workspace = readWorkspace(deps, match);
    return ok(
      await on(deps, workspace, "git.refs", {
        workspaceId: param(match, "workspaceId"),
        execute: workspace.permissions.execute,
      }),
    );
  });

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/identity",
    async (match, request) =>
      remoteRead(deps, match, "git.identity", { path: pathOf(request) }),
  );

  /* ---------------------------- repository reads -------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/branches",
    async (match, request) =>
      remoteRead(deps, match, "git.branches", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/tags",
    async (match, request) =>
      remoteRead(deps, match, "git.tags", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/remotes",
    async (match, request) =>
      remoteRead(deps, match, "git.remotes", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/worktrees",
    async (match, request) =>
      remoteRead(deps, match, "git.worktrees", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/stashes",
    async (match, request) =>
      remoteRead(deps, match, "git.stashes", { path: pathOf(request) }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/stash-detail",
    async (match, request) =>
      remoteRead(deps, match, "git.stashDetail", {
        path: pathOf(request),
        oid: required(request, "oid"),
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/history",
    async (match, request) =>
      remoteRead(deps, match, "git.history", {
        path: pathOf(request),
        request: {
          reference: request.query.get("reference") ?? "HEAD",
          limit: limitOf(request),
          cursor: request.query.get("cursor"),
          paths: commaPaths(request.query.get("paths")),
        },
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/reflog",
    async (match, request) =>
      remoteRead(deps, match, "git.reflog", {
        path: pathOf(request),
        request: {
          reference: request.query.get("reference") ?? "HEAD",
          limit: limitOf(request),
          cursor: request.query.get("cursor"),
        },
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/commit",
    async (match, request) =>
      remoteRead(deps, match, "git.commitDetail", {
        path: pathOf(request),
        oid: required(request, "oid"),
        ...optionalQuery(request, "base"),
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/commit-file",
    async (match, request) =>
      remoteRead(deps, match, "git.commitFile", {
        path: pathOf(request),
        oid: required(request, "oid"),
        ...optionalQuery(request, "base"),
        file: required(request, "file"),
      }),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/cherry-pick-preview",
    async (match, request) => {
      const mainline = request.query.get("mainline");
      return remoteRead(deps, match, "git.cherryPickPreview", {
        path: pathOf(request),
        oid: required(request, "oid"),
        ...(mainline === null
          ? {}
          : { mainline: positive(mainline, "mainline") }),
      });
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/rebase-todo",
    async (match, request) =>
      remoteRead(deps, match, "git.rebaseTodo", {
        path: pathOf(request),
        onto: required(request, "onto"),
      }),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/status-batch",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      requireExecution(workspace.permissions.execute, "Git worktree status");
      const body = jsonObject(request.body);
      return ok(
        await on(deps, workspace, "git.statusBatch", {
          paths: stringList(body, "paths"),
          pathspecs:
            body.pathspecs === undefined ? [] : stringList(body, "pathspecs"),
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/worktree-binding",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const body = jsonObject(request.body);
      const binding = {
        worktreePath: requiredString(body, "worktreePath"),
        branch: optionalString(body, "branch") ?? null,
        repositoryId: optionalString(body, "repositoryId") ?? null,
      };
      if (isRemote(workspace)) {
        return ok(
          await on(deps, workspace, "git.worktreeBinding", {
            request: binding,
            execute: workspace.permissions.execute,
          }),
        );
      }
      return {
        status: 200,
        body: await verifyWorktreeBinding(
          deps.service.withExecution(workspace.permissions.execute),
          workspace.rootPath,
          binding,
        ),
      };
    },
  );

  /* ------------------------------- integration ---------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/integration",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const workspaceId = param(match, "workspaceId");
      // 集成状态在仓库那台机器上读；归属表是控制端的，在这里对照。
      const result: IntegrationSnapshot = isRemote(workspace)
        ? ((await on(deps, workspace, "git.integration", {
            path: pathOf(request),
            execute: workspace.permissions.execute,
          })) as IntegrationSnapshot)
        : await integrationStatus(
            deps.service.withExecution(workspace.permissions.execute),
            workspace.rootPath,
            pathOf(request),
          );
      // Decide ownership here: the map of which workspace started which session
      // is the controller's, so a session this workspace does not own is
      // redacted rather than offered as something it may continue.
      if (
        result.sessionId === null ||
        deps.owners.get(result.sessionId) !== workspaceId
      ) {
        result.owned = false;
        result.sessionId = null;
        result.canContinue = false;
        result.canSkip = false;
        result.mainline = null;
        result.originalHead = null;
      }
      return { status: 200, body: result };
    },
  );

  /* -------------------------------- operations ---------------------------- */

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/operations",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      const workspaceId = param(match, "workspaceId");
      if (isRemote(workspace)) {
        return ok(
          await remoteGitOperations.list(
            workspace,
            workspaceId,
            pathOf(request),
            workspace.permissions.execute,
          ),
        );
      }
      const all = await deps.service
        .withExecution(workspace.permissions.execute)
        .listOperations(workspace.rootPath, pathOf(request));
      return {
        status: 200,
        body: all.filter(
          (operation) => deps.owners.get(operation.id) === workspaceId,
        ),
      };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/operations",
    async (match, request) => {
      const workspace = readWorkspace(deps, match);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow this Git operation");
      }
      requireExecution(
        workspace.permissions.execute,
        "Git repository writes and synchronization",
      );
      const workspaceId = param(match, "workspaceId");
      const body = jsonObject(request.body);
      const action = body.action as RepositoryAction | undefined;
      if (action === undefined || typeof action.kind !== "string") {
        throw badRequest("A repository operation names no action");
      }
      if (
        action.kind === "continueIntegration" ||
        action.kind === "abortIntegration" ||
        action.kind === "skipIntegration"
      ) {
        scopedOperation(deps, workspaceId, action.sessionId);
      }
      if (isRemote(workspace)) {
        // 在执行主机的队列里排；进度随推送帧回来（`remote/git-operations.ts`）。
        const snapshot = await remoteGitOperations.start(
          workspace,
          workspaceId,
          {
            path: pathField(body),
            action,
            expected: expectedOf(body),
            execute: workspace.permissions.execute,
          },
        );
        deps.owners.set(snapshot.id, workspaceId);
        if (
          action.kind === "createWorktree" ||
          action.kind === "removeWorktree"
        ) {
          invalidate(workspaceId);
        }
        return { status: 200, body: snapshot };
      }
      const snapshot = await startOperation(
        deps.service.withExecution(workspace.permissions.execute),
        workspace.rootPath,
        pathField(body),
        action,
        expectedOf(body),
      );
      // Adding or removing a checkout changes the set of repositories under the
      // workspace, and nothing else observes a worktree appearing.
      if (
        action.kind === "createWorktree" ||
        action.kind === "removeWorktree"
      ) {
        invalidate(workspaceId);
      }
      // Only local records can be checked for liveness; forgetting an owner
      // would make its operation unreachable rather than tidy.
      for (const [id, owner] of [...deps.owners]) {
        if (
          owner === workspaceId &&
          deps.service.entry(id) === undefined &&
          !remoteGitOperations.owns(workspaceId, id)
        ) {
          deps.owners.delete(id);
        }
      }
      deps.owners.set(snapshot.id, workspaceId);
      return { status: 200, body: snapshot };
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/git/repository/operations/{operationId}",
    async (match) => {
      const workspaceId = param(match, "workspaceId");
      readWorkspace(deps, match);
      const snapshot = scopedOperation(
        deps,
        workspaceId,
        param(match, "operationId"),
      );
      // A worktree operation only changes the set of checkouts once it actually
      // finishes, and `start` fires before that.
      if (
        snapshot.state !== "queued" &&
        snapshot.state !== "running" &&
        (snapshot.action.kind === "createWorktree" ||
          snapshot.action.kind === "removeWorktree")
      ) {
        invalidate(workspaceId);
      }
      return { status: 200, body: snapshot };
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/git/repository/operations/{operationId}/cancel",
    async (match) => {
      const workspace = readWorkspace(deps, match);
      if (!workspace.permissions.write) {
        throw forbidden("Workspace does not allow this Git operation");
      }
      const operationId = param(match, "operationId");
      const workspaceId = param(match, "workspaceId");
      scopedOperation(deps, workspaceId, operationId);
      if (remoteGitOperations.owns(workspaceId, operationId)) {
        return {
          status: 200,
          body: await remoteGitOperations.cancel(workspaceId, operationId),
        };
      }
      return { status: 200, body: deps.service.cancel(operationId) };
    },
  );
}

/* --------------------------------- helpers -------------------------------- */

function answered(
  handle: (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult>,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  return async (match, request) => {
    try {
      return await handle(match, request);
    } catch (error) {
      if (error instanceof DomainError) {
        const { status, body } = error.response();
        return { status, body };
      }
      if (error instanceof SyntaxError) {
        const { status, body } = workspaceBadRequest(
          "Request body is not valid JSON",
        ).response();
        return { status, body };
      }
      throw error;
    }
  };
}

function param(match: RouteMatch, name: string): string {
  const value = match.params[name];
  if (value === undefined) throw badRequest(`${name} is required`);
  return value;
}

function readWorkspace(deps: GitRouteDeps, match: RouteMatch): Workspace {
  return workspaceById(deps, param(match, "workspaceId"));
}

function workspaceById(deps: GitRouteDeps, workspaceId: string): Workspace {
  const workspace = getWorkspace(deps.database, workspaceId);
  if (!workspace.permissions.read) {
    throw forbidden("Workspace does not allow Git reads");
  }
  return workspace;
}

/**
 * The permission gate every legacy Git write shares: read, write and the
 * execution grant, in that order.
 */
function writeRequest(
  deps: GitRouteDeps,
  workspaceId: string,
  input: () => Args,
): { workspace: Workspace; body: Args } {
  const workspace = workspaceById(deps, workspaceId);
  if (!workspace.permissions.write) {
    throw forbidden("Workspace does not allow Git writes");
  }
  requireExecution(
    workspace.permissions.execute,
    "Git index, worktree, and commit writes",
  );
  return { workspace, body: input() };
}

function ok(body: unknown): HandlerResult {
  return { status: 200, body };
}

/**
 * 在工作空间所在的机器上执行一个 Git 操作：本机用这个 core 的仓库服务（它的
 * 队列就是本机写入的串行点），远端交给那台主机上 Worker 自己的服务。
 */
async function on(
  deps: GitRouteDeps,
  workspace: Workspace,
  operation: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return await executeOn(workspace, operation, args, {
    service: deps.service,
    freshDiscovery: true,
  });
}

/** 只读的仓库查询：读权限之后，执行授权随请求一起交给执行的那一侧。 */
async function remoteRead(
  deps: GitRouteDeps,
  match: RouteMatch,
  operation: string,
  args: Record<string, unknown>,
): Promise<HandlerResult> {
  const workspace = readWorkspace(deps, match);
  return ok(
    await on(deps, workspace, operation, {
      ...args,
      execute: workspace.permissions.execute,
    }),
  );
}

function optionalQuery(
  request: CoreRequest,
  name: string,
): Record<string, string> {
  const value = request.query.get(name);
  return value === null ? {} : { [name]: value };
}

/** An operation this workspace started, having proved that it did. */
function scopedOperation(
  deps: GitRouteDeps,
  workspaceId: string,
  operationId: string,
): OperationSnapshot {
  if (deps.owners.get(operationId) !== workspaceId) {
    throw notFoundInWorkspace();
  }
  // 远端发起的操作答镜像：Worker 推来的最新一帧。
  if (remoteGitOperations.owns(workspaceId, operationId)) {
    return remoteGitOperations.snapshot(workspaceId, operationId);
  }
  const snapshot = deps.service.operationSnapshot(operationId);
  return snapshot;
}

function notFoundInWorkspace(): DomainError {
  return new DomainError(
    404,
    "not_found",
    "Git operation not found in this workspace",
  );
}

function pathOf(request: CoreRequest): string {
  return request.query.get("path") ?? ".";
}

function pathField(body: Record<string, unknown>): string {
  return optionalString(body, "path") ?? ".";
}

function pathsField(body: Record<string, unknown>): string[] {
  return stringList(body, "paths");
}

function stringList(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw badRequest(`${name} must be an array of strings`);
  }
  return value as string[];
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = optionalString(body, name);
  if (value === undefined) throw badRequest(`${name} is required`);
  return value;
}

function required(request: CoreRequest, name: string): string {
  const value = request.query.get(name);
  if (value === null) throw badRequest(`${name} is required`);
  return value;
}

function limitOf(request: CoreRequest): number {
  const value = request.query.get("limit");
  return value === null ? 50 : positive(value, "limit");
}

function positive(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

/** 旧路径的查询串里是逗号拼成的一个字符串，JSON 体里是数组。 */
function pathListOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return commaPaths(typeof value === "string" ? value : undefined);
}

function diffScopeOf(scope: unknown): DiffScope {
  const value = scope ?? "worktree";
  if (value !== "worktree" && value !== "staged") {
    throw badRequest("Diff scope must be `worktree` or `staged`");
  }
  return value;
}

function hunkScopeOf(value: unknown): GitHunkScope {
  if (value !== "worktree" && value !== "staged") {
    throw badRequest("Hunk scope must be `worktree` or `staged`");
  }
  return value;
}

function amendOf(
  body: Record<string, unknown>,
): { expectedHead: string; allowPublished: boolean } | undefined {
  const value = body.amend;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("amend must be an object");
  }
  const amend = value as Record<string, unknown>;
  return {
    expectedHead: requiredString(amend, "expectedHead"),
    allowPublished: amend.allowPublished === true,
  };
}

function expectedOf(body: Record<string, unknown>): ExpectedState {
  const value = body.expected;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("expected must be an object");
  }
  const expected = value as Record<string, unknown>;
  return {
    headOid: optionalString(expected, "headOid") ?? null,
    branch: optionalString(expected, "branch") ?? null,
  };
}

function logRequest(body: Record<string, unknown>): LogRequest {
  const refs = (body.refs ?? {}) as Record<string, unknown>;
  const kind = (refs.kind ?? "head") as LogRefKind;
  if (kind !== "head" && kind !== "all" && kind !== "named") {
    throw badRequest("A log ref filter must be `head`, `all` or `named`");
  }
  const text = body.text as Record<string, unknown> | undefined | null;
  return {
    repositories:
      body.repositories === undefined || body.repositories === null
        ? null
        : stringList(body, "repositories"),
    refs: {
      kind,
      names: refs.names === undefined ? [] : stringList(refs, "names"),
    },
    authors: body.authors === undefined ? [] : stringList(body, "authors"),
    since: optionalString(body, "since") ?? null,
    until: optionalString(body, "until") ?? null,
    paths: body.paths === undefined ? [] : stringList(body, "paths"),
    text:
      text === undefined || text === null
        ? null
        : {
            query: requiredString(text, "query"),
            regex: text.regex === true,
            matchCase: text.matchCase === true,
          },
    cursor: optionalString(body, "cursor") ?? null,
    limit: body.limit === undefined ? 100 : Number(body.limit),
  };
}
