/**
 * 工作空间事件流（§5.4 / §7 / §13.4，契约 §35.4）。
 *
 * 每个源里一个工作空间一条订阅（键 `${sourceId}:${workspaceId}`）：`App` 里
 * `useWorkspaceEvents` 挂一次，其余模块通过 `onWorkspaceEvent(type, handler)`
 * 订阅，不各自开连接。事件带上所属的源：`onWorkspaceEvent` 缺省只收当前源的，
 * 传 `{ allSources: true }` 收所有源。
 *
 * 订阅走控制面 `/api/ws`（`client.workspaces.events`，工程规范化 §3）：一个源
 * 一条连接，事件流与别的调用、订阅多路复用在上面。每一项先 `workspaceEventSchema`
 * 解析；解析失败只丢这一项（core 可能比前端新，多出来的事件类型不该让侧栏失效）。
 *
 * **断线续订**。core 的事件与业务写入同事务，编号是一条单调的 outbox 序号，就是
 * 每一项的事件 `id`。连接断了由 `api/ws.ts` 退避重连，订阅由上游的重试插件带着
 * 最后一个 `id`（`lastEventId`）重订，core 先补发断开的那一段再接实时——这里什么
 * 都不用记。每次（重新）订上，core 先发一帧位置帧 `{ type: "cursor" }`：它不是
 * 事件，不派发，只当作「订上了」的上升沿。
 *
 * 续不上（位置掉出保留下限、或这台 core 换了库）时 core 答 `snapshot_required` /
 * `cursor_ahead`：落下连接状态再从现在重订，订阅者（会话列表、Agent 镜像）在
 * 上升沿上整份重读，缺口由读补上。
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceEventSchema, type WorkspaceEvent } from "@armadra/shared";

import {
  controlClient,
  controlClosedWith,
  errorCode,
  onControlDrop,
} from "./client";
import { useAgentStatusStore } from "../agent/status-store";
import { useProgramStatusStore } from "../agent/program-status-store";
import { useDeliveryStore } from "../agent/delivery-store";
import { useDependencyStore } from "../agent/dependency-store";
import { useDriveStore } from "../agent/drive-store";
import { useLanguageStatusStore } from "../editor/language/status-store";
import { currentSource, localSource, type Source } from "./source";
import { scoped, srcKey, withSource } from "../sources/scope";
import { createLocalConnection } from "../sources/connection";
import { sourceRegistry } from "../sources/registry";
import { CLOSE_REVOKED, type ControlSocketOpener } from "./ws";

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
 * 授权被收回的关闭码（服务器壳上撤销共享、停用账号，契约 §10、§35.2）。控制面
 * 整条以它关闭时，与这块工作空间的订阅以 `forbidden` 结束同样对待。
 */
export const ACCESS_REVOKED_CLOSE = CLOSE_REVOKED;
const accessLostHandlers = new Set<
  (workspaceId: string, sourceId: string) => void
>();
/** 这块工作空间的读授权被收回（订阅以 `forbidden` 结束，或控制面以 4403 关）。 */
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
  // 程序自报的状态（契约 §53）：另一张表，不让它冒充上报。
  useProgramStatusStore.getState().handleEvent(event);
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

/* -------------------------------- 订阅来源 -------------------------------- */

/**
 * 订阅从哪来。缺省是每个源各自的控制面（一个源一条 `/api/ws`）；测试换成假的
 * （不必起一条 WebSocket）。
 */
export interface WorkspaceEventTransport {
  /** 订一个源里的一块工作空间：交回逐项的迭代器；断线续订由它自己做。 */
  subscribe(
    source: Source,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>>;
  /** 这个源的连接断了（订阅在重订，期间不算「已连上」）。 */
  onDrop(source: Source, listener: () => void): () => void;
  /** 这个源的连接因致命关闭码停下了（4403 / 4409 / 4429）；还在连的是 `null`。 */
  closedWith(source: Source): number | null;
}

const fallbackConnections = new WeakMap<Source, ControlSocketOpener>();

/**
 * 一个源在源层的连接（`sources/registry.ts`）：控制面的流由它托管。源表里
 * 没有的（测试、还没登记的源）按本机源的做法包一个——流经源自己的
 * `WebSocket`。
 */
export function connectionOf(source: Source): ControlSocketOpener {
  const registry = sourceRegistry();
  const known =
    source === localSource ? registry.local() : registry.get(source.sourceId);
  if (known !== undefined && known.source === source) return known;
  let made = fallbackConnections.get(source);
  if (made === undefined) {
    made = createLocalConnection({ source });
    fallbackConnections.set(source, made);
  }
  return made;
}

const controlTransport: WorkspaceEventTransport = {
  subscribe: (source, workspaceId, signal) =>
    controlClient(connectionOf(source)).workspaces.events(
      { workspaceId },
      { signal },
    ),
  onDrop: (source, listener) => onControlDrop(connectionOf(source), listener),
  closedWith: (source) => controlClosedWith(connectionOf(source)),
};

let transport: WorkspaceEventTransport = controlTransport;

/** 测试用：换掉订阅来源；`null` 换回控制面。 */
export function setWorkspaceEventTransport(
  next: WorkspaceEventTransport | null,
): void {
  transport = next ?? controlTransport;
}

/** 续不上就从现在重订之前缓一下，免得一块坏库把订阅转成忙循环。 */
export const RESUBSCRIBE_DELAY_MS = 1_000;

/* -------------------------------- 连接管理 ------------------------------- */

interface Connection {
  workspaceId: string;
  /** 这条订阅发往哪个源。 */
  source: Source;
  refs: number;
  stopped: boolean;
  /** 订上了：收到过这一轮的位置帧，之后没断过。 */
  connected: boolean;
  readonly abort: AbortController;
  offDrop: () => void;
}

/** 每个源里的每个工作空间一条订阅（键 `${sourceId}:${workspaceId}`）。 */
const connections = new Map<string, Connection>();

function connectionKey(sourceId: string, workspaceId: string): string {
  return scoped(workspaceId, sourceId);
}

function announce(connection: Connection, connected: boolean): void {
  if (connection.connected === connected) return;
  connection.connected = connected;
  for (const handler of [...connectionHandlers])
    handler(connection.workspaceId, connected, connection.source.sourceId);
}

function lose(connection: Connection): void {
  connection.stopped = true;
  // 下一次订阅同一块工作空间（重新共享之后）要开一条新的，而不是复用这条。
  forget(connection);
  connection.abort.abort();
  connection.offDrop();
  announce(connection, false);
  for (const handler of [...accessLostHandlers])
    handler(connection.workspaceId, connection.source.sourceId);
}

/** 一轮订阅：一直读，直到被拒、被取消，或连接停下。 */
async function pump(connection: Connection): Promise<void> {
  const { source } = connection;
  while (!connection.stopped) {
    try {
      const items = await transport.subscribe(
        source,
        connection.workspaceId,
        connection.abort.signal,
      );
      for await (const item of items) {
        if (connection.stopped) return;
        if ((item as { type?: unknown } | null)?.type === "cursor") {
          announce(connection, true);
          continue;
        }
        const parsed = workspaceEventSchema.safeParse(item);
        if (parsed.success)
          dispatchWorkspaceEvent(parsed.data, source.sourceId);
      }
    } catch (error) {
      if (connection.stopped) return;
      const code = errorCode(error);
      if (
        code === "forbidden" ||
        transport.closedWith(source) === CLOSE_REVOKED
      ) {
        lose(connection);
        return;
      }
      if (transport.closedWith(source) !== null) {
        // 4409 / 4429：页面另有提示（`app/use-control-notices.ts`），不再订。
        connection.stopped = true;
        announce(connection, false);
        return;
      }
      // `snapshot_required` / `cursor_ahead`：从现在重订，订阅者在上升沿上重读。
      // 其余（没装事件域、工作空间刚被删）同样缓一下再试。
      announce(connection, false);
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_DELAY_MS));
      continue;
    }
    // core 主动结束了这一轮（不该发生）：缓一下再订。
    announce(connection, false);
    await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_DELAY_MS));
  }
}

function teardown(connection: Connection): void {
  connection.stopped = true;
  connection.abort.abort();
  connection.offDrop();
  for (const handler of [...connectionHandlers])
    handler(connection.workspaceId, false, connection.source.sourceId);
  connection.connected = false;
  forget(connection);
}

function forget(connection: Connection): void {
  const key = connectionKey(connection.source.sourceId, connection.workspaceId);
  if (connections.get(key) === connection) connections.delete(key);
}

/**
 * 订阅（或复用）某个源里某个工作空间的事件流，返回释放函数。
 * 引用计数保证 StrictMode 的双次挂载不会来回开关订阅。
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
    const made: Connection = {
      workspaceId,
      source,
      refs: 0,
      stopped: false,
      connected: false,
      abort: new AbortController(),
      offDrop: () => {},
    };
    made.offDrop = transport.onDrop(source, () => announce(made, false));
    connections.set(key, made);
    connection = made;
    void pump(made);
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

/** 现在有几条事件订阅（测试用）。 */
export function openEventConnections(): readonly {
  sourceId: string;
  workspaceId: string;
}[] {
  return [...connections.values()].map((connection) => ({
    sourceId: connection.source.sourceId,
    workspaceId: connection.workspaceId,
  }));
}

/** 测试与热重载用：断开全部订阅并清空订阅者。 */
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
