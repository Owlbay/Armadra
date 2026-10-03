import { create } from "zustand";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { boardSyncUrl, runtimeApi } from "../api/client";
import { useCanvasStore } from "../store/canvas-store";
import { presenceClientId, presenceDeviceName } from "../store/canvas/presence";
import {
  peersOf,
  startLocalPresence,
  type LocalPresence,
  type Peer,
} from "./awareness";
import { bindStore, type Binding } from "./binding";
import {
  RealtimeClient,
  type ClientStatus,
  type SocketFactory,
} from "./client";
import { installUndo, type RealtimeUndo } from "./undo";

/**
 * 一块实时板的生命周期（补全架构 §6.4）：开板时问 core 这块板走不走实时
 * （`GET …/realtime`），走就建 `Y.Doc`、连 `…/sync`、绑 store、装撤销与
 * awareness；换板、关页面时全部拆掉。页面其余部分只读 `useRealtimeStore`。
 *
 *   * 第一次同步完成之前画布只读：空文档的投影会把画布清空，在它之前落下的
 *     本地编辑也没有可对的基线。
 *   * `4403`：换一份全新的文档以只读重连（本地写不回去的改动作废）。
 *   * 一直连不上时复核状态：core 说这块板不是实时板、设置也关着（升级被
 *     `409 realtime_disabled` 拒了），就退回租约模式。
 */

export type RealtimeStatus = ClientStatus | "off";

export interface RealtimeView {
  /** 正在实时协同的板；`null` = 当前板走租约 + CAS。 */
  boardId: string | null;
  status: RealtimeStatus;
  readOnly: boolean;
  /** 别人（已校验），按 clientID 排。 */
  peers: Peer[];
  /** 自己的成员色序号（2..8）；画别人看到的颜色用，自己的光标不画。 */
  selfColor: number | null;
  /** 正在跟随谁的光标（awareness clientID）。 */
  following: number | null;
  follow: (clientId: number | null) => void;
}

const IDLE = {
  boardId: null,
  status: "off" as RealtimeStatus,
  readOnly: false,
  peers: [] as Peer[],
  selfColor: null,
  following: null,
};

export const useRealtimeStore = create<RealtimeView>((set) => ({
  ...IDLE,
  follow: (following) => set({ following }),
}));

/** 当前板在走实时协同吗（非 React 的调用方用）。 */
export function realtimeActive(boardId?: string | null): boolean {
  const view = useRealtimeStore.getState();
  if (view.boardId === null) return false;
  return boardId === undefined || boardId === view.boardId;
}

/** 断开了但本地照常编辑：顶部显示「离线编辑」。 */
export function useRealtimeOffline(): boolean {
  return useRealtimeStore((view) => view.status === "offline");
}

interface Live {
  doc: Y.Doc;
  awareness: Awareness;
  client: RealtimeClient;
  binding: Binding;
  undo: RealtimeUndo | null;
  presence: LocalPresence | null;
  offStore: () => void;
}

let live: Live | null = null;

/** 自己的光标（画布坐标）；`null` = 指针离开了画布。 */
export function broadcastCursor(cursor: { x: number; y: number } | null): void {
  live?.presence?.setCursor(cursor);
}

export interface StartOptions {
  workspaceId: string;
  boardId: string;
  readOnly?: boolean;
  /** 测试用：不连真的 WebSocket。 */
  createSocket?: SocketFactory;
  /** 测试用：复核状态的请求。 */
  checkState?: () => Promise<{ realtime: boolean; enabled?: boolean }>;
}

/** 连不上几次之后复核一次「这块板还走不走实时」。 */
const REFUSALS_BEFORE_RECHECK = 2;

/**
 * 开始一块板的实时协同，返回停止函数。同一时刻只有一块板在实时：再开一块
 * 会先把上一块拆掉。
 */
export function startRealtime(options: StartOptions): () => void {
  stopLive();
  const { workspaceId, boardId } = options;
  const readOnly = options.readOnly ?? false;
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // 同步完成、知道谁在场之后才写自己的那份（颜色按加入顺序挑）。
  awareness.setLocalState(null);

  useCanvasStore.getState().setRealtime({ boardId, writable: false });
  useRealtimeStore.setState({
    ...IDLE,
    boardId,
    status: "connecting",
    readOnly,
  });

  let stopped = false;
  const check =
    options.checkState ??
    (() => runtimeApi.boardRealtime(workspaceId, boardId));

  const onStatus = (status: ClientStatus) => {
    if (stopped || live?.client !== client) return;
    if (status === "forbidden") {
      // 没有写权限：换一份全新的文档以只读重连。
      startRealtime({ ...options, readOnly: true });
      return;
    }
    if (status === "online" && !current.synced) {
      current.synced = true;
      onFirstSync();
    }
    useRealtimeStore.setState({ status });
  };

  const onRefused = (failures: number) => {
    if (failures < REFUSALS_BEFORE_RECHECK || current.synced) return;
    void check()
      .then((state) => {
        if (stopped || live?.client !== client) return;
        if (!state.realtime && state.enabled === false) stopRealtime(boardId);
      })
      .catch(() => undefined);
  };

  const current = { synced: false };
  const client = new RealtimeClient({
    url: boardSyncUrl(workspaceId, boardId),
    doc,
    awareness,
    readOnly,
    ...(options.createSocket ? { createSocket: options.createSocket } : {}),
    onStatus,
    onRefused,
  });
  const binding = bindStore({ doc, boardId, ready: () => current.synced });

  const onAwareness = () => {
    const self = awareness.getLocalState() as { color?: number } | null;
    useRealtimeStore.setState({
      peers: peersOf(awareness, doc.clientID),
      selfColor: typeof self?.color === "number" ? self.color : null,
    });
  };
  awareness.on("change", onAwareness);

  // 选区与正在看的节点随 store 写进 awareness。
  const offStore = useCanvasStore.subscribe((state, previous) => {
    const presence = live?.presence;
    if (!presence || state.boardId !== boardId) return;
    if (
      state.selectedNodeIds !== previous.selectedNodeIds ||
      state.selectedItemIds !== previous.selectedItemIds
    ) {
      presence.setSelection([
        ...state.selectedNodeIds,
        ...state.selectedItemIds,
      ]);
    }
    if (state.focusNodeId !== previous.focusNodeId) {
      presence.setFocus(state.focusNodeId);
    }
  });

  live = {
    doc,
    awareness,
    client,
    binding,
    undo: null,
    presence: null,
    offStore,
  };
  const mine = live;

  function onFirstSync() {
    binding.flush();
    if (!readOnly) mine.undo = installUndo(doc, binding.origin);
    const state = useCanvasStore.getState();
    mine.presence = startLocalPresence(awareness, {
      deviceId: presenceClientId(),
      name: presenceDeviceName(),
    });
    mine.presence.setSelection([
      ...state.selectedNodeIds,
      ...state.selectedItemIds,
    ]);
    if (state.focusNodeId) mine.presence.setFocus(state.focusNodeId);
    state.setRealtime({ boardId, writable: !readOnly });
    onAwareness();
  }

  return () => {
    stopped = true;
    stopRealtime(boardId);
  };
}

function stopLive(): void {
  const current = live;
  live = null;
  if (!current) return;
  current.offStore();
  current.presence?.destroy();
  current.client.destroy();
  current.binding.destroy();
  current.undo?.destroy();
  current.awareness.destroy();
  current.doc.destroy();
}

/** 停掉这块板的实时协同（换板、关页面、退回租约模式）。 */
export function stopRealtime(boardId: string): void {
  if (useRealtimeStore.getState().boardId !== boardId) return;
  stopLive();
  useRealtimeStore.setState({ ...IDLE });
  const store = useCanvasStore.getState();
  if (store.realtime?.boardId === boardId) store.setRealtime(null);
}

/** 仅测试用：当前这块板的文档与绑定。 */
export function liveForTest(): { doc: Y.Doc; awareness: Awareness } | null {
  return live ? { doc: live.doc, awareness: live.awareness } : null;
}
