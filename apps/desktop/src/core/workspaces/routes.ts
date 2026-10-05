import type { DatabaseSync } from "node:sqlite";
import type { CoreContext } from "../main";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { registerProcedures } from "../http/rpc";
import { createRootDirectory, directorySource } from "./directory";
import {
  openRemoteWorkspace,
  switchExecutionHost,
  switchRequestOf,
} from "./execution";
import { canonicalDirectory } from "./roots";
import {
  DomainError,
  badRequest,
  internalError,
  jsonObject,
  optionalString,
} from "./support";
import {
  type WorkspacePermissions,
  createWorkspace,
  deleteWorkspace,
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  touchWorkspaceOpened,
  updateWorkspace,
  validWorkspaceName,
} from "./table";

/**
 * `/api/workspaces` — creating, importing, listing, patching and opening.
 *
 * The write-ownership gate each Rust handler opened with is gone: it asked
 * whether this process or the Go Host owned the canvas and the filesystem
 * domains, and with one process there is no second answer (design §6). Nothing
 * else about the order changed — in particular `createDirectory` still runs
 * before the row is written and after the name is validated, so a refused
 * request never leaves a folder behind that nothing then references.
 */

/**
 * Wraps a handler so a `DomainError` becomes its `{ code, message }` answer.
 *
 * Every refusal in these domains is thrown rather than returned, because the
 * checks sit four calls deep in the table modules and threading a result type
 * back up would put the interesting part of each function inside a match.
 */
export function answered(
  handle: (
    match: RouteMatch,
    request: CoreRequest,
  ) => HandlerResult | Promise<HandlerResult>,
): (
  match: RouteMatch,
  request: CoreRequest,
) => HandlerResult | Promise<HandlerResult> {
  return (match, request) => {
    try {
      const result = handle(match, request);
      // A handler that reaches another machine answers later; its refusal has
      // to take the same shape as one thrown before the first await.
      return result instanceof Promise ? result.catch(refusal) : result;
    } catch (error) {
      return refusal(error);
    }
  };
}

function refusal(error: unknown): HandlerResult {
  if (error instanceof DomainError) {
    const { status, body } = error.response();
    return { status, body };
  }
  if (error instanceof SyntaxError) {
    const { status, body } = badRequest(
      "Request body is not valid JSON",
    ).response();
    return { status, body };
  }
  throw error;
}

function permissionsOf(
  source: Record<string, unknown>,
): WorkspacePermissions | undefined {
  const value = source.permissions;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("permissions must be an object");
  }
  const permissions = value as Record<string, unknown>;
  for (const key of ["read", "write", "execute"]) {
    if (typeof permissions[key] !== "boolean") {
      throw badRequest("permissions must be an object of three booleans");
    }
  }
  return {
    read: permissions.read as boolean,
    write: permissions.write as boolean,
    execute: permissions.execute as boolean,
  };
}

/** 一次新建 / 打开要的字段，旧路径的体与 procedure 的入参都归成这个样子。 */
interface RootRequest {
  readonly name: string | undefined;
  readonly rootPath: string | undefined;
  readonly color?: string | undefined;
  readonly permissions?: WorkspacePermissions | undefined;
}

/**
 * 工作空间这几个动作本身。旧 REST 路径与契约 procedure（契约 §34.4）调的是同一份：
 * 两边只是把各自的入参归成同一个样子，拒绝在这里一次抛出。
 */
export function workspaceOperations(context: CoreContext) {
  const database = context.db.database;
  const nameOf = (request: RootRequest): string => {
    if (request.name === undefined) {
      throw badRequest("Workspace name is invalid");
    }
    return validWorkspaceName(request.name);
  };
  const rootOf = (request: RootRequest): string => {
    if (request.rootPath === undefined || request.rootPath === "") {
      throw badRequest("Workspace root is required");
    }
    return request.rootPath;
  };
  return {
    list: () => listWorkspaces(database),
    create(request: RootRequest & { readonly createDirectory?: boolean }) {
      const name = nameOf(request);
      const rootPath = rootOf(request);
      // Before `createDirectory` touches the disk: a refused request must not
      // leave a folder behind that nothing then references.
      if (request.createDirectory === true) createRootDirectory(rootPath);
      return createWorkspace(database, {
        name,
        rootPath: canonicalDirectory(rootPath),
        color: request.color,
        permissions: request.permissions,
      });
    },
    openDirectory(request: RootRequest) {
      const name = nameOf(request);
      return createWorkspace(database, {
        name,
        rootPath: directorySource(rootOf(request)),
        color: request.color,
        permissions: request.permissions,
      });
    },
    update(
      id: string,
      patch: {
        readonly name?: string | undefined;
        readonly color?: string | undefined;
        readonly permissions?: WorkspacePermissions | undefined;
      },
    ) {
      const updated = updateWorkspace(database, id, patch);
      // 授权一变就说一声：语言服务器这类按旧授权起的进程得立刻停，而不是等
      // 下一次空闲清扫。
      if (patch.permissions !== undefined) {
        context.bus.emit("workspace.grants", {
          workspaceId: updated.id,
          permissions: updated.permissions,
        });
      }
      return updated;
    },
    delete(id: string): void {
      // 404 before anything is torn down, so an unknown id is a no-op. The
      // terminal teardown the Rust handler did first belongs to R2; when it
      // lands it goes here, before the row and its cascades go.
      getWorkspace(database, id);
      deleteWorkspace(database, id);
      context.bus.emit("workspace.grants", {
        workspaceId: id,
        permissions: null,
      });
    },
    open: (id: string) => touchWorkspaceOpened(database, id),
    // Both execution-host routes prove the root on the machine that will hold
    // it — through that host's Worker, or this process for an empty id —
    // before a row may name it. A host that cannot be reached fails the
    // request; it never becomes a "remote" workspace reading this machine's
    // files.
    openRemote(request: RootRequest & { readonly executionHostId?: string }) {
      return openRemoteWorkspace(context, {
        name: nameOf(request),
        executionHostId: request.executionHostId,
        rootPath: rootOf(request),
        permissions: request.permissions,
      });
    },
  };
}

/** 旧路径的体 → {@link RootRequest}；形状不对的字段在这里就拒。 */
function rootRequest(body: Record<string, unknown>): RootRequest {
  return {
    name: optionalString(body, "name"),
    rootPath: optionalString(body, "rootPath"),
    color: optionalString(body, "color"),
    permissions: permissionsOf(body),
  };
}

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server } = context;

  // The project a fresh installation opens into. Created here rather than in
  // `main` so that the decision lives with the table that makes it, and so a
  // core assembled without this domain does not quietly mint a workspace.
  try {
    const created = ensureDefaultWorkspace(database, context.dataDir);
    if (created !== undefined) {
      context.log.info("created the default workspace", {
        root: created.rootPath,
      });
    }
  } catch (error) {
    // A first launch on a read-only data directory is a bad first launch, not
    // a core that must not start: everything else still works.
    context.log.warn("could not create the default workspace", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const operations = workspaceOperations(context);

  // 契约 §34.4：同一份实现，`null` 的授权与缺席同义（旧路径一直这样读）。
  registerProcedures(server, "workspaces", {
    list: () =>
      operations.list().map((row) => ({ ...row, boards: [...row.boards] })),
    create: (input) =>
      operations.create({
        ...input,
        permissions: input.permissions ?? undefined,
      }),
    openDirectory: (input) =>
      operations.openDirectory({
        ...input,
        permissions: input.permissions ?? undefined,
      }),
    openRemote: (input) =>
      operations.openRemote({
        ...input,
        permissions: input.permissions ?? undefined,
      }),
    update: ({ workspaceId: id, ...patch }) =>
      operations.update(id, {
        ...patch,
        permissions: patch.permissions ?? undefined,
      }),
    delete: ({ workspaceId: id }) => operations.delete(id),
    open: ({ workspaceId: id }) => operations.open(id),
  });

  server.router.handle(
    "GET",
    "/api/workspaces",
    answered(() => ({ status: 200, body: operations.list() })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces",
    answered((_match, request) => {
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: operations.create({
          ...rootRequest(body),
          createDirectory: body.createDirectory === true,
        }),
      };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/open-directory",
    answered((_match, request) => ({
      status: 200,
      body: operations.openDirectory(rootRequest(jsonObject(request.body))),
    })),
  );

  server.router.handle(
    "PATCH",
    "/api/workspaces/{workspaceId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: operations.update(workspaceId(match), {
          name: optionalString(body, "name"),
          color: optionalString(body, "color"),
          permissions: permissionsOf(body),
        }),
      };
    }),
  );

  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}",
    answered((match) => {
      operations.delete(workspaceId(match));
      return { status: 204, body: undefined };
    }),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/open",
    answered((match) => ({
      status: 200,
      body: operations.open(workspaceId(match)),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/remote",
    answered(async (_match, request) => {
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: await operations.openRemote({
          name: optionalString(body, "name"),
          executionHostId: optionalString(body, "executionHostId"),
          rootPath: optionalString(body, "rootPath"),
          permissions: permissionsOf(body),
        }),
      };
    }),
  );
  server.router.handle(
    "PATCH",
    "/api/workspaces/{workspaceId}/execution-host",
    answered(async (match, request) => {
      const id = workspaceId(match);
      const before = getWorkspace(database, id);
      const outcome = await switchExecutionHost(
        context,
        id,
        switchRequestOf(jsonObject(request.body)),
      );
      // A refusal is structured rather than `{ code, message }` alone: a person
      // can only act on *which* directories differ or *what* is still open.
      if (outcome.kind === "refused") {
        return { status: 409, body: outcome.refusal };
      }
      // 真的换了主机或根目录才说：授权没变，但按旧根起的进程（语言服务器）
      // 看的已经不是这个工作空间了。原样返回的「无变化」不发。
      const after = outcome.workspace;
      const toHost = after.executionHostId ?? "";
      if (
        toHost !== (before.executionHostId ?? "") ||
        after.rootPath !== before.rootPath
      ) {
        context.bus.emit("workspace.grants", {
          workspaceId: after.id,
          permissions: after.permissions,
          executionHostId: toHost,
        });
      }
      return { status: 200, body: after };
    }),
  );
}

export function workspaceId(match: RouteMatch): string {
  const id = match.params.workspaceId;
  if (id === undefined) throw internalError("workspaceId is not in the path");
  return id;
}

/** Exposed for the sibling domains, which all start from a workspace row. */
export function workspaceOf(
  database: DatabaseSync,
  id: string,
): ReturnType<typeof getWorkspace> {
  return getWorkspace(database, id);
}
