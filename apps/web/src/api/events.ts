/**
 * 工作空间事件流（§5.4 / §7 / §13.4）。
 *
 * 一个工作空间一条 WebSocket：`App` 里 `useWorkspaceEvents` 挂一次，
 * 其余模块通过 `onWorkspaceEvent(type, handler)` 订阅，不各自开连接。
 *
 * 每一帧都先 `workspaceEventSchema` 解析；解析失败只丢这一帧并告警，
 * 不断开连接（core 可能比前端新，多出来的事件类型不该让侧栏失效）。
 *
 * **断线续订**（R4c）。core 的事件与业务写入同事务，编号是一条单调的
 * durable sequence，所以「我看到哪儿了」就是一个数。收到的每一条业务帧后面
 * 跟着一条 `{"type":"cursor",…}` 控制帧——它不是第 22 个 `WorkspaceEvent`，
 * 只发给带了 `?cursor=` 的订阅——这里记下那个数，重连时从它之后续，于是断开
 * 的那一段会被补发，而不是被当成「什么都没发生」。
 *
 * 第一次连接不带游标：那时还没有可续的位置，从 0 订会把整段历史当成刚发生的
 * 改动重放一遍。
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceEventSchema, type WorkspaceEvent } from "@armadra/shared";

import { workspaceEventsUrl } from "./client";
import { useAgentStatusStore } from "../agent/status-store";
import { useDeliveryStore } from "../agent/delivery-store";
import { useDependencyStore } from "../agent/dependency-store";
import { useDriveStore } from "../agent/drive-store";
import { useLanguageStatusStore } from "../editor/language/status-store";
import { createBackoff, type Backoff } from "@/lib/backoff";
import { currentSource, type Source } from "./source";
import { scoped, srcKey, withSource } from "../sources/scope";

type EventType = WorkspaceEvent["type"];
type EventOf<T extends EventType> = Extract<WorkspaceEvent, { type: T }>;
type AnyHandler = (event: WorkspaceEvent, sourceId: string) => void;

const handlers = new Map<EventType, Set<AnyHandler>>();
type ConnectionHandler = (
  workspaceId: string,
  connected: boolean,
  sourceId: string,
) => void;
const connectionHandlers = new Set<ConnectionHandler>();
/** Transport lifecycle lets volatile read models discard a previous runtime's cache. */
export function onWorkspaceConnection(handler: ConnectionHandler): () => void {
  connectionHandlers.add(handler);
  return () => {
    connectionHandlers.delete(handler);
  };
}

/**
 * core 关事件流用的码：这个人对这块工作空间的读授权没了（服务器壳上撤销
 * 共享、停用账号，契约 §10）。
 */
export const ACCESS_REVOKED_CLOSE = 4403;
const accessLostHandlers = new Set<
  (workspaceId: string, sourceId: string) => void
>();
/** 事件流因为授权被收回而关闭（{@link ACCESS_REVOKED_CLOSE}）。 */
export function onWorkspaceAccessLost(
  handler: (workspaceId: string, sourceId: string) => void,
): () => void {
  accessLostHandlers.add(handler);
  return () => {
    accessLostHandlers.delete(handler);
  };
}

/**
 * 订阅一种事件；返回退订函数。
 *
 * 默认只收**当前源**的事件：订阅者大多在处理「眼前这块工作空间」，别的源
 * 的连接推来的同名帧与它们无关。要看全部源（按源记账的 store、按源失效
 * 查询键）的传 `{ allSources: true }`，第二个参数是事件所属的源。
 */
export function onWorkspaceEvent<T extends EventType>(
  type: T,
  handler: (event: EventOf<T>, sourceId: string) => void,
  options: { allSources?: boolean } = {},
): () => void {
  const bucket = handlers.get(type) ?? new Set<AnyHandler>();
  handlers.set(type, bucket);
  const wrapped: AnyHandler = (event, sourceId) => {
    if (!options.allSources && sourceId !== currentSource().sourceId) return;
    (handler as AnyHandler)(event, sourceId);
  };
  bucket.add(wrapped);
  return () => {
    bucket.delete(wrapped);
  };
}

/**
 * 派发一条已解析的事件：先喂状态镜像，再通知订阅者。
 * 导出是为了让不接 WebSocket 的测试与本地回放也能走同一条路径。
 */
export function dispatchWorkspaceEvent(
  event: WorkspaceEvent,
  sourceId: string = currentSource().sourceId,
): void {
  // 状态镜像按 `${sourceId}:${id}` 记（`sources/scope.ts`）：同步派发期间
  // 默认源就是这条连接所属的源。
  withSource(sourceId, () => dispatchInSource(event, sourceId));
}

function dispatchInSource(event: WorkspaceEvent, sourceId: string): void {
  useAgentStatusStore.getState().handleEvent(event);
  // 语言会话与服务器状态走同一条流（语言服务设计 §2.9）：状态栏和设置页
  // 因此不必为了看一眼状态就开一条会话 socket。
  useLanguageStatusStore.getState().handleEvent(event);
  // 投递的痕迹（连线闪动、「排队 N」、被拦下的那一条）也是一份易失镜像，
  // 与上面两个同一档：订阅者不必为了看一眼就各自记一份。
  useDeliveryStore.getState().handleEvent(event);
  // 谁在驱动哪个终端，同一档：节点头的徽标与命令面板读同一个答案。
  useDriveStore.getState().handleEvent(event);
  // 依赖等待：帧里没有等待本身，只有「该重读了」（Agent 自动化设计 §6）。
  useDependencyStore.getState().handleEvent(event);
  for (const handler of handlers.get(event.type) ?? [])
    handler(event, sourceId);
}

/* ------------------------------- 重连退避 -------------------------------- */

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 10_000;

/* -------------------------------- 连接管理 ------------------------------- */

interface Connection {
  workspaceId: string;
  /** 这条连接发往哪个源。 */
  source: Source;
  socket: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  backoff: Backoff;
  refs: number;
  stopped: boolean;
  /** 最后一条控制帧报的位置；`null` 表示还没读到过任何位置。 */
  cursor: number | null;
  /**
   * 还要不要带游标订阅。
   *
   * core 在升级**之前**就拒绝一个掉出保留下限或超出水位的游标（409），
   * 那条连接根本不会打开。继续拿同一个数重连只会撞上同一堵墙，而重连是
   * 按秒退避的——所以拒绝一次就回到实时订阅，那一段缺口由调用方照常重读
   * 补上，而不是把一次拒绝变成一个重连风暴。
   */
  resuming: boolean;
  /** 这一次连接有没有真的打开过。用来分辨「被拒绝」和「断开了」。 */
  opened: boolean;
}

/** 每个源里的每个工作空间一条（键 `${sourceId}:${workspaceId}`）。 */
const connections = new Map<string, Connection>();

function connectionKey(sourceId: string, workspaceId: string): string {
  return scoped(workspaceId, sourceId);
}

/** core 的游标控制帧。只有带 `?cursor=` 的订阅才会收到。 */
interface CursorFrame {
  cursor: number;
  floor: number;
  watermark: number;
}

function parseFrame(
  raw: unknown,
): { event: WorkspaceEvent } | { cursor: CursorFrame } | null {
  if (typeof raw !== "string") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const control = payload as Partial<CursorFrame> & { type?: unknown };
  if (
    control?.type === "cursor" &&
    typeof control.cursor === "number" &&
    typeof control.floor === "number" &&
    typeof control.watermark === "number"
  ) {
    return {
      cursor: {
        cursor: control.cursor,
        floor: control.floor,
        watermark: control.watermark,
      },
    };
  }
  const parsed = workspaceEventSchema.safeParse(payload);
  if (!parsed.success) return null;
  return { event: parsed.data };
}

function open(connection: Connection): void {
  if (connection.stopped) return;
  connection.opened = false;
  // 经本机源：桌面壳里先换票再升级（`api/source.ts`）。
  const Socket = globalThis.WebSocket ? connection.source.WebSocket : undefined;
  if (!Socket) return;

  let socket: WebSocket;
  try {
    socket = new Socket(
      workspaceEventsUrl(
        connection.workspaceId,
        connection.resuming ? (connection.cursor ?? "now") : undefined,
        connection.source,
      ),
    );
  } catch {
    schedule(connection);
    return;
  }
  connection.socket = socket;

  socket.onopen = () => {
    if (connection.socket !== socket || connection.stopped) return;
    connection.opened = true;
    connection.backoff.reset();
    for (const handler of connectionHandlers)
      handler(connection.workspaceId, true, connection.source.sourceId);
  };
  socket.onmessage = (event: MessageEvent) => {
    const parsed = parseFrame(event.data);
    if (!parsed) return;
    if ("event" in parsed) {
      dispatchWorkspaceEvent(parsed.event, connection.source.sourceId);
      return;
    }
    // 游标只准前进：往回退等于把已经应用过的改动当成没发生。
    const { cursor } = parsed;
    if (connection.cursor === null || cursor.cursor > connection.cursor)
      connection.cursor = cursor.cursor;
  };
  socket.onclose = (event?: CloseEvent) => {
    if (connection.socket !== socket || connection.stopped) return;
    // 没打开过就关了 = core 在升级之前拒绝了这个游标。放弃续订，回到实时。
    if (!connection.opened && connection.resuming) {
      connection.resuming = false;
      connection.cursor = null;
    }
    for (const handler of connectionHandlers)
      handler(connection.workspaceId, false, connection.source.sourceId);
    connection.socket = null;
    // 授权被收回：重连的升级只会再被 403 拒。不再重连，告诉页面重取工作空间
    // 列表——这块画布会从列表里消失，而不是停在一份再也存不进去的旧文档上。
    if (event?.code === ACCESS_REVOKED_CLOSE) {
      connection.stopped = true;
      // 下一次订阅同一块工作空间（重新共享之后）要开一条新的，而不是复用这条。
      forget(connection);
      for (const handler of [...accessLostHandlers])
        handler(connection.workspaceId, connection.source.sourceId);
      return;
    }
    schedule(connection);
  };
  // `onerror` 之后浏览器一定会再发 `onclose`，重连只挂在 close 上，避免排两次。
  socket.onerror = () => {};
}

function schedule(connection: Connection): void {
  if (connection.stopped || connection.timer) return;
  connection.timer = setTimeout(() => {
    connection.timer = null;
    open(connection);
  }, connection.backoff.next());
}

/**
 * 源回来了（中继托管的页面收到 `me.stream` 的 `sourceOnline`）：在退避里等着的
 * 事件流不再等，立刻重连一次。给了源只叫醒那个源的。
 */
export function wakeWorkspaceEvents(sourceId?: string): void {
  for (const connection of connections.values()) {
    if (connection.stopped || connection.timer === null) continue;
    if (sourceId !== undefined && connection.source.sourceId !== sourceId)
      continue;
    clearTimeout(connection.timer);
    connection.timer = null;
    connection.backoff.reset();
    open(connection);
  }
}

function teardown(connection: Connection): void {
  for (const handler of connectionHandlers)
    handler(connection.workspaceId, false, connection.source.sourceId);
  connection.stopped = true;
  if (connection.timer) clearTimeout(connection.timer);
  connection.timer = null;
  const socket = connection.socket;
  connection.socket = null;
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }
  forget(connection);
}

function forget(connection: Connection): void {
  const key = connectionKey(connection.source.sourceId, connection.workspaceId);
  if (connections.get(key) === connection) connections.delete(key);
}

/**
 * 连接（或复用）某个工作空间的事件流，返回释放函数。
 * 引用计数保证 StrictMode 的双次挂载不会来回开关连接。
 */
export function connectWorkspaceEvents(
  workspaceId: string,
  source: Source = currentSource(),
): () => void {
  const key = connectionKey(source.sourceId, workspaceId);
  // 同一个源里同一时刻只订一个工作空间（与加源之前一样）；别的源各有各的一条。
  for (const other of [...connections.values()]) {
    if (
      other.source.sourceId === source.sourceId &&
      other.workspaceId !== workspaceId
    )
      teardown(other);
  }
  let connection = connections.get(key);
  if (!connection) {
    connection = {
      workspaceId,
      source,
      socket: null,
      timer: null,
      backoff: createBackoff({
        baseMs: RECONNECT_MIN_MS,
        capMs: RECONNECT_MAX_MS,
      }),
      refs: 0,
      stopped: false,
      cursor: null,
      resuming: true,
      opened: false,
    };
    connections.set(key, connection);
    open(connection);
  }
  const held = connection;
  held.refs += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs <= 0) teardown(held);
  };
}

/** 现在有几条事件连接（测试用）。 */
export function openEventConnections(): readonly {
  sourceId: string;
  workspaceId: string;
}[] {
  return [...connections.values()].map((connection) => ({
    sourceId: connection.source.sourceId,
    workspaceId: connection.workspaceId,
  }));
}

/** 测试与热重载用：断开全部连接并清空订阅者。 */
export function resetWorkspaceEvents(): void {
  for (const connection of [...connections.values()]) teardown(connection);
  handlers.clear();
  connectionHandlers.clear();
  accessLostHandlers.clear();
}

/* --------------------------------- Hook ---------------------------------- */

/**
 * App 挂一次。除了维持连接，还负责把服务端事件翻译成查询失效：
 * 会话列表与 Git 状态都是「服务端为准」的读模型，事件到了就重取。
 */
export function useWorkspaceEvents(
  workspaceId: string | null,
  source: Source = currentSource(),
): void {
  const queryClient = useQueryClient();
  const sourceId = source.sourceId;

  useEffect(() => {
    if (!workspaceId) return;
    const release = connectWorkspaceEvents(workspaceId, source);
    const invalidate = () => {
      void queryClient.invalidateQueries({
        queryKey: srcKey(sourceId, "sessions", workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: srcKey(sourceId, "git-status", workspaceId),
      });
      void queryClient.invalidateQueries({
        queryKey: srcKey(sourceId, "git-diff", workspaceId),
      });
    };
    const mine = (from: string) => from === sourceId;
    const all = { allSources: true };
    const offExit = onWorkspaceEvent(
      "terminal.exit",
      (_event, from) => {
        if (mine(from)) invalidate();
      },
      all,
    );
    const offBoard = onWorkspaceEvent(
      "board.changed",
      (_event, from) => {
        if (mine(from)) invalidate();
      },
      all,
    );
    // 改绑执行主机之后，工作空间的每一条路径都指向另一台机器了。事件本身
    // 不带任何字段，就是要求整份重取，而不是往手里这份上打补丁。
    const offUpdated = onWorkspaceEvent(
      "workspace.updated",
      (event, from) => {
        if (event.workspaceId !== workspaceId || !mine(from)) return;
        void queryClient.invalidateQueries({
          queryKey: srcKey(sourceId, "workspaces"),
        });
        invalidate();
      },
      all,
    );
    const offLost = onWorkspaceAccessLost((lost, from) => {
      if (lost !== workspaceId || !mine(from)) return;
      void queryClient.invalidateQueries({
        queryKey: srcKey(sourceId, "workspaces"),
      });
    });
    return () => {
      offExit();
      offBoard();
      offUpdated();
      offLost();
      release();
    };
  }, [workspaceId, queryClient, source, sourceId]);
}
