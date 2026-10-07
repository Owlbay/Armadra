import type { EventBus } from "../bus";
import type {
  BoardPresenceItem,
  BoardRealtimeStateWire,
  ProcedureResult,
  contract,
} from "@armadra/shared";
import { fail } from "../http/errors";
import { type DomainHandlers, registerProcedures } from "../http/rpc";
import type { RouteMatch } from "../http/router";
import type { CoreContext } from "../main";
import { audit } from "../identity/audit";
import {
  type RequestIdentity,
  accessGate,
  allows,
  onAccessChanged,
  requestIdentity,
  runAs,
} from "../identity/gate";
import { scope } from "../identity/scopes";
import { answered, workspaceId } from "../workspaces/routes";
import {
  badRequest,
  internalError,
  isUuid,
  jsonObject,
  optionalString,
} from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import {
  type Viewport,
  createBoard,
  getBoard,
  deleteBoard,
  listBoards,
  updateBoard,
} from "./boards";
import { parseContextLinks, putContextLinks } from "./context-links";
import type {
  BoardDocument,
  CanvasEdge,
  CanvasNode,
  SaveBoardRequest,
} from "./document-types";
import { loadBoard, saveBoard } from "./documents";
import {
  CanvasPresence,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_DEVICE,
  type PresenceSnapshot,
  type PresenceSource,
  deviceKey,
  parseClientId,
  parseDeviceName,
} from "./presence";

/**
 * `/api/workspaces/{id}/boards` — board records, the document load/save pair,
 * and the per-node context-link document.
 *
 * The `kanban` check is the first thing `PUT …/document` does, before the
 * board is even read: it is request validation, it has to answer the same way
 * whatever else is true, and a retired task-board write must be refused
 * explicitly rather than have its data silently discarded.
 */

let assembled: CanvasPresence | undefined;
let unsubscribe: (() => void) | undefined;

/** 运行中的 core 的在线表；测试与别的域用它看「谁在看这块画布」。 */
export function canvasPresence(): CanvasPresence | undefined {
  return assembled;
}

/** 一块板的实时状态怎么读（契约 §16.2）；实时域装配时登记，canvas 域不 import 它。 */
export type RealtimeStateReader = (
  workspaceId: string,
  boardId: string,
) => BoardRealtimeStateWire;

let realtimeStateReader: RealtimeStateReader | undefined;

/** 实时域登记「读一块板的实时状态」；返回撤销函数。 */
export function setRealtimeStateReader(
  reader: RealtimeStateReader,
): () => void {
  realtimeStateReader = reader;
  return () => {
    if (realtimeStateReader === reader) realtimeStateReader = undefined;
  };
}

/** 同一个客户端同时开着几条在线订阅（严格模式的双挂载、重订的交叠）：最后一条走才算离开。 */
const subscribed = new Map<string, number>();

export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server, bus } = context;
  const presence = new CanvasPresence({
    publish: (id, snapshot) => publishPresence(bus, id, snapshot),
  });
  presence.start();
  assembled?.stop();
  unsubscribe?.();
  assembled = presence;
  // 撤销共享、改成只读、停用账号、登出：在线表马上复判，被收权的那一方手里
  // 的租约当场释放并广播，而不是等它的心跳过期。
  unsubscribe = onAccessChanged(() => presence.recheck());

  /**
   * 画布域的动作。旧 REST 路径与契约 procedure（契约 §36）调的是同一份：两边只
   * 是把各自的入参归成同一个样子，拒绝在这里一次抛出，码与原话因此一样。
   */
  const operations = {
    save(id: string, board: string, body: Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(body, "kanban")) {
        throw badRequest(
          "Task-board writes are retired; historical records are available as read-only archives",
        );
      }
      const save = parseSaveRequest(body);
      // 租约先于 CAS（契约 §9）：别人正在写是 423，手里那份旧了才是 409。
      // 板子存不存在留给 `saveBoard` 判，它的 404 在租约之前也在之后都一样。
      getBoardOrThrow(database, id, board);
      presence.authorizeWrite(id, board, save.clientId, presenceSource());
      const document = saveBoard(database, id, board, save);
      publishBoardChanged(bus, id, document.board.id, document.board.updatedAt);
      return document;
    },
    heartbeat(
      id: string,
      rawBoard: string,
      input: { clientId: unknown; deviceName: unknown; active: unknown },
    ) {
      const board = getBoardOrThrow(database, id, rawBoard);
      if (input.active !== undefined && typeof input.active !== "boolean") {
        throw badRequest("active must be a boolean");
      }
      return beat(id, board, {
        clientId: input.clientId,
        deviceName: input.deviceName,
        active: input.active === true,
        source: presenceSource(),
        // 心跳只要读权限；能不能写在这里另判一次：租约只落在能写的人手里，
        // 回答里的 `writable` 让页面把只读共享的画布当只读画（契约 §9.1）。
        // 每次心跳都现判，改角色、撤销共享在下一拍就反映出来。
        writable: allows([scope("canvas:write", id)]),
      });
    },
    leave(id: string, rawBoard: string, clientId: unknown) {
      const board = getBoardOrThrow(database, id, rawBoard);
      return presenceView(presence.leave(id, board, parseClientId(clientId)));
    },
    acquire(
      id: string,
      rawBoard: string,
      input: { clientId: unknown; deviceName: unknown; takeover: unknown },
    ) {
      const board = getBoardOrThrow(database, id, rawBoard);
      if (input.takeover !== undefined && typeof input.takeover !== "boolean") {
        throw badRequest("takeover must be a boolean");
      }
      const clientId = parseClientId(input.clientId);
      const source = presenceSource();
      const before = presence.snapshot(board).lease;
      const snapshot = presence.acquire(id, board, {
        clientId,
        deviceName: parseDeviceName(input.deviceName),
        takeover: input.takeover === true,
        source,
      });
      // 从别人手里接过来的才记：那一刻对方没保存的改动会被丢掉，事后要查得到
      // 是谁、从哪台设备、在什么时候接的手（审计写入点「接管」）。
      if (before !== null && before.clientId !== clientId) {
        audit({
          action: "canvas.lease.takeover",
          target: board,
          workspaceId: id,
          detail: {
            from: before.deviceName,
            to: snapshot.lease?.deviceName ?? "",
            sameDevice:
              before.deviceKey !== "" &&
              before.deviceKey === deviceKey(source.deviceId),
          },
        });
      }
      return presenceView(snapshot, { deviceKey: deviceKey(source.deviceId) });
    },
  };

  /** 一次心跳，答「这个客户端看到的在线表」。 */
  const beat = (
    id: string,
    board: string,
    input: {
      clientId: unknown;
      deviceName: unknown;
      active: boolean;
      source: PresenceSource;
      writable: boolean;
    },
  ): BoardPresenceItem =>
    presenceView(
      presence.heartbeat(id, board, {
        clientId: parseClientId(input.clientId),
        deviceName: parseDeviceName(input.deviceName),
        active: input.active,
        writer: input.writable,
        source: input.source,
      }),
      {
        writable: input.writable,
        // 发心跳的这台设备的标识：页面拿它和租约持有者的比，同一台就是
        // 「本机另一个窗口」（契约 §9.1）。和 `writable` 一样因人而异，
        // 所以只在回答里、不在事件帧里。
        deviceKey: deviceKey(input.source.deviceId),
      },
    );

  /**
   * 契约 §36：同一份实现。`null` 的排序与缺席同义（旧路径一直这样读）；订阅
   * `presence` 见 {@link openPresence}。
   */
  const handlers = {
    list: ({ workspaceId: id }) =>
      listBoards(database, id).map((row) => ({ ...row })),
    create: ({ workspaceId: id, name }) => createBoard(database, id, name),
    update: ({ workspaceId: id, boardId: board, name, sortOrder }) =>
      updateBoard(database, id, board, {
        name,
        sortOrder: sortOrder ?? undefined,
      }),
    delete: ({ workspaceId: id, boardId: board }) =>
      deleteBoard(database, id, board),
    load: ({ workspaceId: id, boardId: board }) =>
      documentView(loadBoard(database, id, board)),
    save: ({ workspaceId: id, boardId: board, ...body }) =>
      documentView(operations.save(id, board, body)),
    realtime: ({ workspaceId: id, boardId: board }) => {
      if (realtimeStateReader === undefined) {
        throw fail("not_implemented", "这台 core 没有装实时协同域");
      }
      return realtimeStateReader(id, board);
    },
    heartbeat: ({ workspaceId: id, boardId: board, ...rest }) =>
      operations.heartbeat(id, board, {
        clientId: rest.clientId,
        deviceName: rest.deviceName,
        active: rest.active,
      }),
    leave: ({ workspaceId: id, boardId: board, clientId }) =>
      operations.leave(id, board, clientId),
    acquireLease: ({ workspaceId: id, boardId: board, ...rest }) =>
      operations.acquire(id, board, {
        clientId: rest.clientId,
        deviceName: rest.deviceName,
        takeover: rest.takeover,
      }),
    presence: ({ workspaceId: id, boardId: board, ...rest }, call) => {
      // 先决条件在这里判，拒绝是这次调用的错误，不是一条开了又断的订阅。
      const resolved = getBoardOrThrow(database, id, board);
      const clientId = parseClientId(rest.clientId);
      const deviceName = parseDeviceName(rest.deviceName);
      return openPresence({
        bus,
        presence,
        workspaceId: id,
        boardId: resolved,
        clientId,
        deviceName,
        identity: call.identity,
        signal: call.signal,
        view: (boardId, extra) =>
          presenceView(presence.snapshot(boardId), extra),
        beat,
      });
    },
  } satisfies Omit<
    DomainHandlers<"boards">,
    // 评论（§36.5）由实时域的 `installCommentRoutes` 登记。
    | "comments"
    | "createComment"
    | "updateComment"
    | "deleteComment"
    | "resolveComment"
  >;
  registerProcedures(
    server,
    "boards",
    handlers as unknown as DomainHandlers<"boards">,
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/boards",
    answered((match) => ({
      status: 200,
      body: listBoards(database, workspaceId(match)),
    })),
  );

  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const name = optionalString(body, "name");
      if (name === undefined) throw badRequest("Board name is invalid");
      return {
        status: 200,
        body: createBoard(database, workspaceId(match), name),
      };
    }),
  );

  server.router.handle(
    "PATCH",
    "/api/workspaces/{workspaceId}/boards/{boardId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      const sortOrder = body.sortOrder;
      if (
        sortOrder !== undefined &&
        sortOrder !== null &&
        typeof sortOrder !== "number"
      ) {
        throw badRequest("sortOrder must be a number");
      }
      return {
        status: 200,
        body: updateBoard(database, workspaceId(match), boardId(match), {
          name: optionalString(body, "name"),
          sortOrder: typeof sortOrder === "number" ? sortOrder : undefined,
        }),
      };
    }),
  );

  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/boards/{boardId}",
    answered((match) => {
      deleteBoard(database, workspaceId(match), boardId(match));
      return { status: 204, body: undefined };
    }),
  );

  server.router.handle(
    "GET",
    "/api/workspaces/{workspaceId}/boards/{boardId}/document",
    answered((match) => ({
      status: 200,
      body: loadBoard(database, workspaceId(match), boardId(match)),
    })),
  );

  server.router.handle(
    "PUT",
    "/api/workspaces/{workspaceId}/boards/{boardId}/document",
    answered((match, request) => ({
      status: 200,
      body: operations.save(
        workspaceId(match),
        boardId(match),
        jsonObject(request.body),
      ),
    })),
  );

  // 在线设备的心跳（契约 §9.1）。只读的客户端也要心跳，所以它和读同一档
  // 权限（`route-scopes.ts`）。
  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards/{boardId}/presence",
    answered((match, request) => {
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: operations.heartbeat(workspaceId(match), boardId(match), {
          clientId: body.clientId,
          deviceName: body.deviceName,
          active: body.active,
        }),
      };
    }),
  );

  // 显式离开：切走画布、关掉页面时页面用 `keepalive` 发这一条。没登记过的
  // 客户端离开不是错误——那正是「已经过期了」的样子。
  server.router.handle(
    "DELETE",
    "/api/workspaces/{workspaceId}/boards/{boardId}/presence/{clientId}",
    answered((match) => ({
      status: 200,
      body: operations.leave(
        workspaceId(match),
        boardId(match),
        match.params.clientId,
      ),
    })),
  );

  // 拿 / 接管写租约（契约 §9.2）。接管的二次确认在页面上。
  server.router.handle(
    "POST",
    "/api/workspaces/{workspaceId}/boards/{boardId}/lease",
    answered((match, request) => {
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: operations.acquire(workspaceId(match), boardId(match), {
          clientId: body.clientId,
          deviceName: body.deviceName,
          takeover: body.takeover,
        }),
      };
    }),
  );

  // 连线文档（上下文按连线读取的那份授权，契约 §39.4 `agents.putContextLinks`）：
  // 旧路径与 procedure 同一份实现。
  const putLinks = (
    id: string,
    nodeId: string | undefined,
    body: Record<string, unknown>,
  ) => {
    // The workspace read is the 404, and it happens before the node id is
    // even looked at: a document for a workspace nobody registered is not a
    // malformed request.
    getWorkspace(database, id);
    if (!isUuid(nodeId)) throw badRequest("Node id is invalid");
    return putContextLinks(database, id, nodeId, parseContextLinks(body));
  };
  registerProcedures(server, "agents", {
    putContextLinks: ({
      workspaceId: id,
      nodeId,
      links,
    }: {
      workspaceId: string;
      nodeId: string;
      links?: unknown;
    }) => putLinks(id, nodeId, links === undefined ? {} : { links }),
  } as unknown as DomainHandlers<"agents">);

  server.router.handle(
    "PUT",
    "/api/workspaces/{workspaceId}/context-links/{nodeId}",
    answered((match, request) => {
      const body = jsonObject(request.body);
      return {
        status: 200,
        body: putLinks(workspaceId(match), match.params.nodeId, body),
      };
    }),
  );
}

/**
 * 这次请求来自哪台设备、授权变了之后怎么再问一次。
 *
 * 桌面壳没有请求身份：它的每个窗口都在本机，算同一台设备，也不需要复判。
 * 服务器壳上是会话绑着的身份域设备；复判先重新认证会话（登出、撤销设备、
 * 停用账号都在这一步失效），再按那块画布上的授权判能看、能写还是都不能。
 */
function presenceSource(
  identity: RequestIdentity | undefined = requestIdentity(),
): PresenceSource {
  if (identity === undefined) {
    return { deviceId: LOCAL_DEVICE, deviceName: "" };
  }
  return {
    deviceId: identity.device?.deviceId ?? "",
    deviceName: identity.device?.deviceName ?? "",
    recheck: (workspace) => {
      const subject =
        identity.revalidate === undefined
          ? identity.subject
          : identity.revalidate();
      if (subject === undefined) return "none";
      const gate = accessGate();
      if (!gate.permits(subject, [scope("canvas:read", workspace)])) {
        return "none";
      }
      return gate.permits(subject, [scope("canvas:write", workspace)])
        ? "write"
        : "read";
    },
  };
}

type BoardDocumentView = ProcedureResult<typeof contract.boards.load>;

/** 文档 → 线上的样子。节点的 `data` 是各类型自己的 JSON，core 不看里面。 */
function documentView(document: BoardDocument): BoardDocumentView {
  return {
    board: { ...document.board },
    nodes: document.nodes.map((node) => ({
      ...node,
      labels: [...node.labels],
    })) as unknown as BoardDocumentView["nodes"],
    edges: document.edges.map((edge) => ({ ...edge })),
  };
}

/** 在线表快照 → 线上的样子（可变数组、可选的因人而异字段）。 */
function presenceView(
  snapshot: PresenceSnapshot,
  extra: { writable?: boolean; deviceKey?: string } = {},
): BoardPresenceItem {
  return {
    boardId: snapshot.boardId,
    clients: snapshot.clients.map((client) => ({ ...client })),
    lease: snapshot.lease === null ? null : { ...snapshot.lease },
    ...extra,
  };
}

interface OpenPresenceOptions {
  readonly bus: EventBus;
  readonly presence: CanvasPresence;
  readonly workspaceId: string;
  readonly boardId: string;
  readonly clientId: string;
  readonly deviceName: string;
  readonly identity: RequestIdentity | undefined;
  readonly signal: AbortSignal | undefined;
  /** 读一眼现在的在线表（不算心跳，不发事件）。 */
  readonly view: (
    boardId: string,
    extra: { writable: boolean; deviceKey: string },
  ) => BoardPresenceItem;
  readonly beat: (
    workspaceId: string,
    boardId: string,
    input: {
      clientId: unknown;
      deviceName: unknown;
      active: boolean;
      source: PresenceSource;
      writable: boolean;
    },
  ) => BoardPresenceItem;
}

/**
 * `boards.presence`：一个客户端在一块画布上的在线订阅（契约 §36.4）。
 *
 * 订上就是第一次心跳；连接着的时候 core 每 {@link HEARTBEAT_INTERVAL_MS} 替
 * 页面续一次期（`active` 是页面经 `boards.heartbeat` 报的，这里续期不带，也就
 * 不会让一个开着没人动的窗口一直占着租约）；订阅结束就是离开。每次这块板的
 * 在线表或租约变了发一项：内容是这个客户端看到的那份（`writable`、`deviceKey`
 * 因人而异，所以不能是广播的事件帧），与上一项相同的不重复发。
 *
 * 授权在每次醒来时复核：不再能读这块画布了以 `forbidden` 结束订阅，由此也不会
 * 再替一个被收权的人续期。
 */
async function* openPresence(
  options: OpenPresenceOptions,
): AsyncGenerator<BoardPresenceItem, void, void> {
  const { bus, workspaceId, boardId, clientId, identity, signal } = options;
  const within = <T>(fn: () => T): T =>
    identity === undefined ? fn() : runAs(identity, fn);
  const source = within(() => presenceSource(identity));
  const canRead = (): boolean => {
    if (identity === undefined) {
      return allows([scope("canvas:read", workspaceId)]);
    }
    const subject =
      identity.revalidate === undefined
        ? identity.subject
        : identity.revalidate();
    if (subject === undefined) return false;
    return accessGate().permits(subject, [scope("canvas:read", workspaceId)]);
  };
  const writable = (): boolean =>
    within(() => allows([scope("canvas:write", workspaceId)]));
  /** 续期：一次心跳，答这个客户端看到的在线表。 */
  const renew = (): BoardPresenceItem =>
    options.beat(workspaceId, boardId, {
      clientId,
      deviceName: options.deviceName,
      active: false,
      source,
      writable: writable(),
    });
  /**
   * 只读一眼，不心跳：在线表变了（别人的事件）时用它。若这里也心跳，两个订阅
   * 会你一拍我一拍地互相触发下去（心跳自己也会发事件）。
   */
  const look = (): BoardPresenceItem =>
    options.view(boardId, {
      writable: writable(),
      deviceKey: deviceKey(source.deviceId),
    });

  const key = `${boardId}:${clientId}`;
  let wake: (() => void) | undefined;
  const poke = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  let dirty = false;
  const off = bus.on("workspace.event", (frame) => {
    if (
      frame.workspaceId === workspaceId &&
      frame.event.type === "canvas.presence" &&
      frame.event.boardId === boardId
    ) {
      dirty = true;
      poke();
    }
  });
  let due = false;
  const timer = setInterval(() => {
    due = true;
    poke();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  signal?.addEventListener("abort", poke);
  subscribed.set(key, (subscribed.get(key) ?? 0) + 1);
  const aborted = (): boolean => signal?.aborted === true;
  // 续期只刷新 `lastSeenAt`，不算「变了」：比较时不看它。
  const fingerprint = (value: BoardPresenceItem): string =>
    JSON.stringify({
      ...value,
      clients: value.clients.map(({ lastSeenAt: _seen, ...rest }) => rest),
    });
  let last = "";
  try {
    if (!canRead()) throw fail("forbidden", "没有这块画布的读授权了");
    let item = renew();
    last = fingerprint(item);
    yield item;
    while (!aborted()) {
      if (!dirty && !due) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const renewing = due;
      dirty = false;
      due = false;
      if (aborted()) break;
      if (!canRead()) throw fail("forbidden", "没有这块画布的读授权了");
      item = renewing ? renew() : look();
      // 续期自己发的事件也算：下一轮读到同样的内容，指纹相同，不重复发。
      const text = fingerprint(item);
      if (text === last) continue;
      last = text;
      yield item;
    }
  } finally {
    clearInterval(timer);
    off();
    signal?.removeEventListener("abort", poke);
    const left = (subscribed.get(key) ?? 1) - 1;
    if (left > 0) subscribed.set(key, left);
    else {
      subscribed.delete(key);
      // 最后一条订阅走了才算离开；板子被删了就没有什么可离开的。
      try {
        options.presence.leave(workspaceId, boardId, clientId);
      } catch {
        // 离开从不该让订阅的收尾失败。
      }
    }
  }
}

/** `board.changed` — the frame every other window rebases its unsaved edits on. */
function publishBoardChanged(
  bus: EventBus,
  workspaceId: string,
  boardId: string,
  updatedAt: string,
): void {
  bus.emit("workspace.event", {
    workspaceId,
    event: { type: "board.changed", boardId, updatedAt },
  });
}

/**
 * `canvas.presence`：谁在看、谁在写（契约 §9.4）。不进 outbox——那是给断线
 * 续订补发用的，而补发一帧过去的在线表只会让页面短暂地看见已经走了的设备；
 * 重连后的第一次心跳自己就带回当前的那一份。
 */
function publishPresence(
  bus: EventBus,
  workspaceId: string,
  snapshot: PresenceSnapshot,
): void {
  bus.emit("workspace.event", {
    workspaceId,
    event: { type: "canvas.presence", ...snapshot },
  });
}

/** 板子在不在这个工作空间里；不在就是 404。回的是规范化后的板 id。 */
function getBoardOrThrow(
  database: CoreContext["db"]["database"],
  workspace: string,
  board: string,
): string {
  return getBoard(database, workspace, board).id;
}

function boardId(match: RouteMatch): string {
  const id = match.params.boardId;
  if (id === undefined) throw internalError("boardId is not in the path");
  return id;
}

/**
 * The save body, with the defaults serde applies.
 *
 * Nothing here decides whether the document is *valid* — that is
 * `validation.ts`, and it runs against the board it claims. This only turns
 * JSON into the shape that check reads, and refuses a body that is not even
 * shaped like a document.
 */
export function parseSaveRequest(
  body: Record<string, unknown>,
): SaveBoardRequest {
  const expectedUpdatedAt = optionalString(body, "expectedUpdatedAt");
  if (expectedUpdatedAt === undefined) {
    throw badRequest("expectedUpdatedAt is required");
  }
  const whiteboard = body.whiteboard;
  if (
    whiteboard !== undefined &&
    whiteboard !== null &&
    typeof whiteboard !== "string"
  ) {
    throw badRequest("whiteboard must be a string");
  }
  const clientId = body.clientId;
  return {
    expectedUpdatedAt,
    // 写者是谁（契约 §9.3）。缺席是没有身份的旧写者，在租约空着时放行。
    clientId:
      clientId === undefined || clientId === null
        ? undefined
        : parseClientId(clientId),
    nodes: array(body.nodes, "nodes").map(parseNode),
    edges: array(body.edges, "edges").map(parseEdge),
    viewport: parseViewport(body.viewport),
    // An absent snapshot preserves the stored one; an explicit `null` is the
    // same as absent, which is what `Option<String>` means on the Rust side.
    whiteboard: typeof whiteboard === "string" ? whiteboard : undefined,
  };
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw badRequest(`${name} must be an array`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseViewport(value: unknown): Viewport {
  const source = object(value, "viewport");
  for (const key of ["x", "y", "zoom"]) {
    if (typeof source[key] !== "number") {
      throw badRequest("Board viewport is invalid");
    }
  }
  return {
    x: source.x as number,
    y: source.y as number,
    zoom: source.zoom as number,
  };
}

/** `#0a84ff` is `default_node_color`; `labels` and `note` default likewise. */
const DEFAULT_NODE_COLOR = "#0a84ff";

function parseNode(value: unknown): CanvasNode {
  const source = object(value, "node");
  const node: Record<string, unknown> = {
    id: text(source, "id"),
    boardId: text(source, "boardId"),
    type: text(source, "type"),
    title: text(source, "title"),
    color: optionalString(source, "color") ?? DEFAULT_NODE_COLOR,
    position: parsePosition(source.position),
    labels: parseLabels(source.labels),
    note: optionalString(source, "note") ?? "",
    data: source.data,
    createdAt: text(source, "createdAt"),
    updatedAt: text(source, "updatedAt"),
  };
  const size = source.size;
  if (size !== undefined && size !== null) {
    const parsed = object(size, "size");
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      throw badRequest("Board contains an invalid node");
    }
    node.size = { width: parsed.width, height: parsed.height };
  }
  if (typeof source.collapsed === "boolean") node.collapsed = source.collapsed;
  if (typeof source.expandedHeight === "number") {
    node.expandedHeight = source.expandedHeight;
  }
  const parentId = optionalString(source, "parentId");
  if (parentId !== undefined) node.parentId = parentId;
  return node as unknown as CanvasNode;
}

function parseEdge(value: unknown): CanvasEdge {
  const source = object(value, "edge");
  return {
    id: text(source, "id"),
    boardId: text(source, "boardId"),
    source: text(source, "source"),
    target: text(source, "target"),
    kind: optionalString(source, "kind") ?? "link",
    createdAt: text(source, "createdAt"),
    updatedAt: text(source, "updatedAt"),
  };
}

function parsePosition(value: unknown): { x: number; y: number } {
  const source = object(value, "position");
  if (typeof source.x !== "number" || typeof source.y !== "number") {
    throw badRequest("Board contains an invalid node");
  }
  return { x: source.x, y: source.y };
}

function parseLabels(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return array(value, "labels").map((entry) => {
    if (typeof entry !== "string") {
      throw badRequest("Board contains an invalid node");
    }
    return entry;
  });
}

function text(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string") {
    throw badRequest(`Board contains an invalid node: ${name} is missing`);
  }
  return value;
}
