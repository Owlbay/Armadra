import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceEvent } from "../bus";
import type { CoreContext } from "../main";
import type { CoreRequest, HandlerResult, RouteMatch } from "../http/router";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type {
  FileContent,
  FileEntryResult,
  FileIndex,
  FileList,
  FileSearchResult,
  FileVersion,
  ImportedFileInfo,
  TrashEntry,
  WriteFileResponse,
} from "@armadra/shared";
import { executeOn, isRemote } from "../remote/execute";
import {
  download as downloadChunked,
  transferUnsupported,
} from "../remote/transfer";
import { remoteWatches } from "../remote/watch";
import { answered, workspaceId } from "../workspaces/routes";
import {
  DomainError,
  badRequest,
  jsonObject,
  optionalString,
  requiredString,
} from "../workspaces/support";
import { type Workspace, getWorkspace } from "../workspaces/table";
import {
  type SearchProgress,
  type SearchRequest,
  searchContent,
} from "./search";
import { register, releaseWorkspace, unregister } from "./watch";
import { requestIdentity, routeGuard, runAs } from "../identity/gate";
import {
  MediaTickets,
  type MediaDisposition,
  byteHeaders,
  localFile,
  mediaTicketOf,
  parseRange,
  readLocalRange,
  writeBytes,
} from "./media";
import { MEDIA_PATH_PREFIX } from "../identity/transport";
import { install as installUploads } from "./upload-routes";

/**
 * The twelve `file*` routes: browsing, reading, writing, creating, renaming,
 * trashing, indexing, searching and watching workspace files.
 *
 * Every one of them starts from a workspace row, because the row is what says
 * where the files are and whether this canvas may read or write them. Two
 * things the Rust handlers did are gone and one is deferred:
 *
 *   * the write-ownership gate, which asked which process owned the filesystem
 *     domain — with one process there is no second answer (design §6, D4);
 *   * `spawn_blocking`, which existed to keep synchronous filesystem calls off
 *     an async runtime's worker threads. Here they are the handler;
 *
 * Where the work runs is not decided here: every route resolves its workspace,
 * checks the grant, and hands the operation to `remote/execute`, which runs it
 * in this process for a local workspace and on the execution host's Worker for
 * a remote one. A remote workspace is never answered from the controller's
 * disk.
 */

/** `executeOn` 的答案是 `unknown`；这里按操作的出参类型收窄。 */
function ran<T>(...args: Parameters<typeof executeOn>): Promise<T> {
  return executeOn(...args) as Promise<T>;
}

/** 旧路径的查询串与 procedure 入参共用的缺省：缺省或空串是工作空间根。 */
function pathOrRoot(value: string | null | undefined): string {
  return value === undefined || value === null || value === "" ? "." : value;
}

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server, bus } = context;
  // 粘进 Agent 节点的文件（契约 §55）：落在数据目录，不在工作区里。
  installUploads(context);
  const publish = (id: string, event: WorkspaceEvent): void => {
    bus.emit("workspace.event", { workspaceId: id, event });
  };

  /*
   * 每个操作一份实现，路由表里的旧 handler（先把查询串与体解析成这里的入参）
   * 与契约 §37 的 procedure 都调它：拒绝的码与原话由这里决定，两条路一样。
   */
  const watchable = (id: string): Workspace => {
    const workspace = getWorkspace(database, id);
    if (!workspace.permissions.read) {
      // A workspace that lost read access must not keep an OS watcher alive
      // on a folder the canvas may no longer look at.
      releaseWorkspace(id);
      remoteWatches.releaseWorkspace(id);
      throw new DomainError(403, "forbidden", "This workspace is not readable");
    }
    return workspace;
  };

  const mediaTickets = new MediaTickets();

  const operations = {
    list: (id: string, path: string | null | undefined) =>
      ran<FileList>(workspaceOf(database, id), "files.list", {
        path: pathOrRoot(path),
      }),
    info: (id: string, path: string | null | undefined) =>
      ran<ImportedFileInfo>(workspaceOf(database, id), "files.info", {
        path: pathOrRoot(path),
      }),
    read: (id: string, path: string | null | undefined) =>
      ran<FileContent>(workspaceOf(database, id), "files.read", {
        path: pathOrRoot(path),
      }),
    write: (
      id: string,
      input: {
        path: string;
        content: string;
        expectedSize?: number | null | undefined;
        expectedSha256?: string | null | undefined;
        bom?: boolean | undefined;
      },
    ) => {
      const workspace = writable(database, id);
      const expected = input.expectedSha256 ?? undefined;
      // The legacy size-only overwrite is refused explicitly rather than
      // ignored: a client still sending it is a client whose save would
      // otherwise silently lose the protection it thinks it has.
      if (input.expectedSize !== undefined && input.expectedSize !== null) {
        if (expected === undefined) {
          throw badRequest(
            "Reload the file to obtain its content version before saving",
          );
        }
      }
      return ran<WriteFileResponse>(workspace, "files.write", {
        path: input.path,
        content: input.content,
        ...(expected === undefined ? {} : { expectedSha256: expected }),
        bom: input.bom === true,
      });
    },
    create: (id: string, path: string, kind: "file" | "directory") =>
      ran<FileEntryResult>(writable(database, id), "files.create", {
        path,
        kind,
      }),
    rename: (id: string, from: string, to: string) =>
      ran<FileEntryResult>(writable(database, id), "files.rename", {
        from,
        to,
      }),
    trash: (id: string, path: string) =>
      ran<TrashEntry>(writable(database, id), "files.trash", { path }),
    trashList: (id: string) =>
      ran<TrashEntry[]>(readable(database, id), "files.trashList"),
    restore: (id: string, entry: string) =>
      ran<FileEntryResult>(writable(database, id), "files.restore", {
        id: entry,
      }),
    index: (id: string, query: string, limit: number | undefined) =>
      ran<FileIndex>(readable(database, id), "files.index", {
        query,
        ...(limit === undefined ? {} : { limit }),
      }),
    search: async (
      id: string,
      parsed: SearchRequest,
      request: CoreRequest,
      signal: AbortSignal | undefined,
    ) => {
      const workspace = readable(database, id);
      // 远端由 Worker 扫，取消随连接断开时 Worker 那一轮自己跑完为止。
      if (isRemote(workspace)) {
        return ran<FileSearchResult>(workspace, "files.search", {
          request: parsed,
        });
      }
      // 页面换了查询、关了面板或点了「停止」就会掐断这次请求；连接一断就别再
      // 替它把整棵树读完。
      const connection = connectionSignal(request);
      const aborted = (): boolean =>
        connection.signal?.aborted === true || signal?.aborted === true;
      const progress: SearchProgress = { visited: 0 };
      try {
        return (await searchContent(
          workspace.rootPath,
          parsed,
          anySignal(connection.signal, signal),
          progress,
        )) as FileSearchResult;
      } catch (error) {
        if (aborted()) {
          // 记下停在第几个文件：这是「扫描真的停了」唯一看得见的证据。
          context.log.debug("文件搜索随连接断开中止", {
            workspaceId: workspace.id,
            visited: progress.visited,
          });
          throw new DomainError(499, "cancelled", "The search was cancelled");
        }
        throw error;
      } finally {
        connection.release();
      }
    },
    watch: async (id: string, path: string, nodeId: string) => {
      const workspace = watchable(id);
      if (isRemote(workspace)) {
        // No watcher reaches another machine: the controller polls the Worker
        // for the registered files instead, and says so with `mode: poll`.
        return remoteWatches.register(workspace, id, path, nodeId, publish);
      }
      return register(id, workspace.rootPath, path, nodeId, publish);
    },
    unwatch: (id: string, path: string, nodeId: string): void => {
      // Unknown registrations are a no-op, so a late close after a workspace
      // switch is not an error.
      unregister(id, path, nodeId);
      remoteWatches.unregister(id, path, nodeId);
    },
    version: (id: string, path: string | null | undefined) => {
      const workspace = getWorkspace(database, id);
      if (!workspace.permissions.read) {
        throw new DomainError(
          403,
          "forbidden",
          "This workspace is not readable",
        );
      }
      return ran<FileVersion>(workspace, "files.version", {
        path: pathOrRoot(path),
      });
    },
    /**
     * 契约 §37.4：给浏览器直接取一份文件的票。和下载一样不问 `read` 权限
     * （见 {@link downloadBytes} 上面那段），但文件得在、得是文件。
     */
    mediaTicket: async (
      id: string,
      path: string,
      disposition: MediaDisposition,
    ) => {
      const workspace = workspaceOf(database, id);
      const info = await ran<ImportedFileInfo>(workspace, "files.info", {
        path,
      });
      const issued = mediaTickets.issue({
        workspaceId: id,
        path: info.path,
        disposition,
        identity: requestIdentity(),
      });
      return {
        url: `${MEDIA_PATH_PREFIX}${issued.ticket}`,
        expiresAt: new Date(issued.expiresAtMs).toISOString(),
        size: info.size,
        mimeType: info.mimeType,
      };
    },
  };

  // 契约 §37：与下面的旧路径同一份实现。`reveal` 与 `importLocal` 由各自的
  // 模块登记（它们有自己的装配参数），不在这里。
  const handlers = {
    list: ({ workspaceId: id, path }) => operations.list(id, path),
    info: ({ workspaceId: id, path }) => operations.info(id, path),
    read: ({ workspaceId: id, path }) => operations.read(id, path),
    write: ({ workspaceId: id, ...input }) => operations.write(id, input),
    create: ({ workspaceId: id, path, kind }) =>
      operations.create(id, path, kind),
    rename: ({ workspaceId: id, from, to }) => operations.rename(id, from, to),
    trash: ({ workspaceId: id, path }) => operations.trash(id, path),
    trashList: ({ workspaceId: id }) => operations.trashList(id),
    restore: ({ workspaceId: id, id: entry }) => operations.restore(id, entry),
    index: ({ workspaceId: id, query, limit }) =>
      operations.index(id, query ?? "", checkedLimit(limit)),
    search: ({ workspaceId: id, ...request }, call) =>
      operations.search(
        id,
        searchRequestOf(request),
        call.request,
        call.signal,
      ),
    watch: ({ workspaceId: id, path, nodeId }) =>
      operations.watch(id, path, nodeId),
    unwatch: ({ workspaceId: id, path, nodeId }) =>
      operations.unwatch(id, path ?? "", nodeId ?? ""),
    version: ({ workspaceId: id, path }) => operations.version(id, path),
    mediaTicket: ({ workspaceId: id, path, disposition }) =>
      operations.mediaTicket(id, path, disposition ?? "inline"),
  } satisfies Omit<
    DomainHandlers<"files">,
    // 各自的模块登记：`files/reveal.ts`、`imports/routes.ts`、`assets/routes.ts`。
    "reveal" | "importLocal" | "exportText"
  >;
  registerProcedures(
    server,
    "files",
    handlers as unknown as DomainHandlers<"files">,
  );

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
  const ok = (body: unknown): HandlerResult => ({ status: 200, body });

  handle("GET", "/api/workspaces/{workspaceId}/files", async (match, request) =>
    ok(await operations.list(workspaceId(match), request.query.get("path"))),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-info",
    async (match, request) =>
      ok(await operations.info(workspaceId(match), request.query.get("path"))),
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-download",
    async (match, request) => {
      const workspace = workspaceOf(database, workspaceId(match));
      const requested = requestedPath(request);
      const rangeHeader = singleRange(request);
      // 本机工作空间带 `Range` 时只读那一段（契约 §37.2）：不把整份文件读进
      // 内存，也不受整份下载的 16 MiB 上限。远端照旧整份取回再切。
      if (!isRemote(workspace) && rangeHeader !== undefined) {
        const file = localFile(workspace.rootPath, requested);
        const range = parseRange(rangeHeader, file.size);
        if (range !== undefined) {
          return rangedAnswer(
            file.relative,
            file.size,
            range,
            range === "unsatisfiable"
              ? Buffer.alloc(0)
              : readLocalRange(file, range),
          );
        }
      }
      const { path, bytes } = await downloadBytes(workspace, requested);
      const range = parseRange(rangeHeader, bytes.byteLength);
      if (range !== undefined) {
        return rangedAnswer(
          path,
          bytes.byteLength,
          range,
          range === "unsatisfiable"
            ? Buffer.alloc(0)
            : bytes.subarray(range.start, range.end + 1),
        );
      }
      // Always an attachment, and never sniffed: an uploaded HTML or SVG file
      // must not be able to execute in the core's origin on the way out.
      return {
        status: 200,
        raw: bytes,
        headers: downloadHeaders(path),
      };
    },
  );

  // 契约 §37.4：`/api/media/<票>`。整段自己写响应：本机文件流式读盘、按
  // `Range` 回 206；任何失败都在这里答完，不让路径（里面有票）进日志。
  server.raw(MEDIA_PATH_PREFIX, async (request, response, cors) => {
    const fail = (status: number, code: string, message: string): void => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(status, {
        ...cors,
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ code, message }));
    };
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      fail(405, "method_not_allowed", "只接受 GET 与 HEAD");
      return;
    }
    const ticket = mediaTicketOf(request.path);
    const grant = ticket === "" ? undefined : mediaTickets.use(ticket);
    if (grant === undefined) {
      fail(404, "not_found", "媒体票不存在或已过期");
      return;
    }
    let identity = grant.identity;
    if (identity?.revalidate !== undefined) {
      const subject = identity.revalidate();
      if (subject === undefined) {
        fail(401, "unauthenticated", "签票的会话已失效");
        return;
      }
      identity = { ...identity, subject };
    }
    const serve = async (): Promise<void> => {
      // 按签票的文件所在的下载路由判：媒体路径本身在 `SELF_GUARDED` 里，拿它
      // 问路由门恒放行。
      const download = `/api/workspaces/${encodeURIComponent(grant.workspaceId)}/file-download`;
      const verdict = routeGuard()(
        { ...request, method: "GET", path: download },
        { permission: "files:read", workspaceId: grant.workspaceId },
      );
      if (!verdict.allowed) {
        fail(403, "forbidden", "没有这项权限");
        return;
      }
      const workspace = workspaceOf(database, grant.workspaceId);
      const headers = {
        ...cors,
        ...byteHeaders(grant.path, grant.disposition),
      };
      const range = singleRange(request);
      if (!isRemote(workspace)) {
        const file = localFile(workspace.rootPath, grant.path);
        writeBytes(response, {
          method,
          range,
          headers,
          size: file.size,
          body: file,
        });
        return;
      }
      const { bytes } = await downloadBytes(workspace, grant.path);
      writeBytes(response, {
        method,
        range,
        headers,
        size: bytes.byteLength,
        body: bytes,
      });
    };
    try {
      await (identity === undefined ? serve() : runAs(identity, serve));
    } catch (error) {
      const failure = error as { status?: unknown; code?: unknown };
      if (
        typeof failure.status === "number" &&
        typeof failure.code === "string"
      ) {
        fail(failure.status, failure.code, "取不到这个文件");
      } else {
        fail(500, "internal_error", "取不到这个文件");
      }
    }
  });

  handle("GET", "/api/workspaces/{workspaceId}/file", async (match, request) =>
    ok(await operations.read(workspaceId(match), request.query.get("path"))),
  );

  handle(
    "PUT",
    "/api/workspaces/{workspaceId}/file",
    async (match, request) => {
      const id = workspaceId(match);
      writable(database, id);
      const body = jsonObject(request.body);
      return ok(
        await operations.write(id, {
          expectedSha256: optionalString(body, "expectedSha256"),
          expectedSize: body.expectedSize as number | null | undefined,
          path: requiredString(body, "path"),
          content: requiredString(body, "content"),
          bom: body.bom === true,
        }),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries",
    async (match, request) => {
      const id = workspaceId(match);
      writable(database, id);
      const body = jsonObject(request.body);
      const kind = body.kind;
      if (kind !== "file" && kind !== "directory") {
        throw badRequest("kind must be file or directory");
      }
      return ok(
        await operations.create(id, requiredString(body, "path"), kind),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries/rename",
    async (match, request) => {
      const id = workspaceId(match);
      writable(database, id);
      const body = jsonObject(request.body);
      return ok(
        await operations.rename(
          id,
          requiredString(body, "from"),
          requiredString(body, "to"),
        ),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries/trash",
    async (match, request) => {
      const id = workspaceId(match);
      writable(database, id);
      const body = jsonObject(request.body);
      return ok(await operations.trash(id, requiredString(body, "path")));
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-entries/trash",
    async (match) => ok(await operations.trashList(workspaceId(match))),
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-entries/restore",
    async (match, request) => {
      const id = workspaceId(match);
      writable(database, id);
      const body = jsonObject(request.body);
      return ok(await operations.restore(id, requiredString(body, "id")));
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-index",
    async (match, request) => {
      const id = workspaceId(match);
      readable(database, id);
      const limit = request.query.get("limit");
      return ok(
        await operations.index(
          id,
          request.query.get("query") ?? "",
          limit === null || limit === "" ? undefined : numeric(limit, "limit"),
        ),
      );
    },
  );

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-search",
    async (match, request) => {
      const id = workspaceId(match);
      readable(database, id);
      return ok(
        await operations.search(id, searchRequest(request), request, undefined),
      );
    },
  );

  /* ------------------------------ file watching ---------------------------- */

  handle(
    "POST",
    "/api/workspaces/{workspaceId}/file-watch",
    async (match, request) => {
      const id = workspaceId(match);
      watchable(id);
      const body = jsonObject(request.body);
      return ok(
        await operations.watch(
          id,
          requiredString(body, "path"),
          requiredString(body, "nodeId"),
        ),
      );
    },
  );

  handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/file-watch",
    async (match, request) => {
      operations.unwatch(
        workspaceId(match),
        request.query.get("path") ?? "",
        request.query.get("nodeId") ?? "",
      );
      return { status: 204 };
    },
  );

  handle(
    "GET",
    "/api/workspaces/{workspaceId}/file-version",
    async (match, request) =>
      ok(
        await operations.version(workspaceId(match), request.query.get("path")),
      ),
  );
}

/** `#[serde(default = "default_path")]` — an absent `path` means the root. */
function requestedPath(request: CoreRequest): string {
  const value = request.query.get("path");
  return value === null || value === "" ? "." : value;
}

/** procedure 的 `limit`（已是数字）也要过旧路径那条非负整数的检查。 */
function checkedLimit(value: number | undefined): number | undefined {
  return value === undefined ? undefined : numeric(String(value), "limit");
}

/** 多个中止信号里任何一个触发就中止；都没有时是 `undefined`。 */
function anySignal(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** procedure 的搜索入参（可选项是 `null` 或缺席）→ 域的 {@link SearchRequest}。 */
function searchRequestOf(input: {
  query: string;
  regex?: boolean | null | undefined;
  caseSensitive?: boolean | null | undefined;
  wholeWord?: boolean | null | undefined;
  include?: string | null | undefined;
  exclude?: string | null | undefined;
  maxMatchesPerFile?: number | null | undefined;
  limit?: number | null | undefined;
  offset?: number | null | undefined;
}): SearchRequest {
  const present = <T>(name: string, value: T | null | undefined) =>
    optional(name, value ?? undefined);
  const count = (name: string, value: number | null | undefined) => {
    if (value === undefined || value === null) return {};
    if (!Number.isInteger(value) || value < 0) {
      throw badRequest(`${name} must be a non-negative integer`);
    }
    return { [name]: value };
  };
  return {
    query: input.query,
    ...present("regex", input.regex),
    ...present("caseSensitive", input.caseSensitive),
    ...present("wholeWord", input.wholeWord),
    ...present("include", input.include),
    ...present("exclude", input.exclude),
    ...count("maxMatchesPerFile", input.maxMatchesPerFile),
    ...count("limit", input.limit),
    ...count("offset", input.offset),
  };
}

function numeric(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw badRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function searchRequest(request: CoreRequest): SearchRequest {
  const body = jsonObject(request.body);
  const flag = (name: string): boolean | undefined => {
    const value = body[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean")
      throw badRequest(`${name} must be a boolean`);
    return value;
  };
  const count = (name: string): number | undefined => {
    const value = body[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw badRequest(`${name} must be a non-negative integer`);
    }
    return value;
  };
  return {
    query: requiredString(body, "query"),
    ...optional("regex", flag("regex")),
    ...optional("caseSensitive", flag("caseSensitive")),
    ...optional("wholeWord", flag("wholeWord")),
    ...optional("include", optionalString(body, "include")),
    ...optional("exclude", optionalString(body, "exclude")),
    ...optional("maxMatchesPerFile", count("maxMatchesPerFile")),
    ...optional("limit", count("limit")),
    ...optional("offset", count("offset")),
  };
}

/** Keeps an absent field absent rather than present-and-undefined. */
function optional<T>(name: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [name]: value };
}

/**
 * The four read routes the Runtime answers **without** asking about the read
 * permission — browsing, info, download and the editor's read. That is the
 * shape of the contract rather than an oversight to tidy up on the way past:
 * the canvas opens a file tree the moment a workspace is selected, and
 * `permissions.read` gates the watching surfaces, which is where the Runtime
 * does ask. Changing it here would be a behaviour change smuggled into a port.
 */
/**
 * A download's bytes. A remote file comes in chunks (`remote/transfer.ts`): a
 * 16 MiB file is 21 MiB of base64, more than one Worker frame carries. A
 * Worker too old for chunks answers the one-frame read, as before.
 */
async function downloadBytes(
  workspace: Workspace,
  path: string,
): Promise<{ path: string; bytes: Buffer }> {
  if (isRemote(workspace)) {
    try {
      return await downloadChunked(workspace, path);
    } catch (failure) {
      if (!transferUnsupported(failure)) throw failure;
    }
  }
  const { path: name, base64 } = (await executeOn(workspace, "files.download", {
    path,
  })) as { path: string; base64: string };
  return { path: name, bytes: Buffer.from(base64, "base64") };
}

function workspaceOf(database: DatabaseSync, id: string): Workspace {
  return getWorkspace(database, id);
}

function readable(database: DatabaseSync, id: string): Workspace {
  const workspace = getWorkspace(database, id);
  if (!workspace.permissions.read) {
    throw new DomainError(403, "forbidden", "This workspace is not readable");
  }
  return workspace;
}

function writable(database: DatabaseSync, id: string): Workspace {
  const workspace = getWorkspace(database, id);
  if (!workspace.permissions.write) {
    throw new DomainError(
      403,
      "forbidden",
      "This workspace is opened read-only",
    );
  }
  return workspace;
}

/**
 * An abort signal that fires when the client behind `request` goes away.
 *
 * The request's own `close` is no use here: the body has already been read,
 * and a fully read `IncomingMessage` closes right then. What outlives the
 * handler is the socket — a page that aborts its `fetch` drops it. The
 * listeners come off again once the handler is done, since a keep-alive socket
 * carries many requests. In-process calls (tests) have no socket and get no
 * signal.
 */
export function connectionSignal(request: CoreRequest): {
  readonly signal: AbortSignal | undefined;
  release(): void;
} {
  const raw = request.raw as CoreRequest["raw"] | undefined;
  const socket = raw?.socket;
  if (raw === undefined || socket === undefined || socket === null) {
    return { signal: undefined, release: () => {} };
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (socket.destroyed) abort();
  socket.once("close", abort);
  raw.once("aborted", abort);
  return {
    signal: controller.signal,
    release: () => {
      socket.off("close", abort);
      raw.off("aborted", abort);
    },
  };
}

/** 只认一条 `Range` 头；两条同名头当没有。 */
function singleRange(request: CoreRequest): string | undefined {
  const value = request.headers.range;
  return typeof value === "string" ? value : undefined;
}

function downloadHeaders(path: string): Record<string, string> {
  const { "content-type": type, "content-disposition": disposition } =
    byteHeaders(path, "attachment");
  return {
    "content-type": type as string,
    "content-disposition": disposition as string,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
}

function rangedAnswer(
  path: string,
  size: number,
  range: { start: number; end: number } | "unsatisfiable",
  bytes: Buffer,
): HandlerResult {
  if (range === "unsatisfiable") {
    return {
      status: 416,
      raw: Buffer.alloc(0),
      headers: { ...downloadHeaders(path), "content-range": `bytes */${size}` },
    };
  }
  return {
    status: 206,
    raw: bytes,
    headers: {
      ...downloadHeaders(path),
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    },
  };
}
