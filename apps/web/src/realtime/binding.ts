import * as Y from "yjs";

import { hasDrafts, subscribeDrafts } from "../canvas/flow/drafts";
import { useCanvasStore, type CanvasStore } from "../store/canvas-store";
import { readRemote, writeLocal, type LocalSnapshot } from "./doc";

/**
 * `canvas-store` ↔ `Y.Doc` 的双向绑定（补全架构 §6.4）。
 *
 *   * **本地 → 文档**：store 的每一次结构性变化（节点、连线、白板，按对象身份
 *     认）镜像成一次 Y 事务，`origin` 是这块绑定自己的本地来源。
 *   * **文档 → 本地**：只处理 origin **不是**本地来源的事务（别的客户端、core
 *     的写者、撤销管理器），经 `applyRealtimeState` 灌进 store。视口不在文档里，
 *     天然留本地；手势进行中先攒着，手势结束再一次灌进来。
 *
 * 回声环靠 origin 断开：灌进 store 的那次写不再镜像回文档（`applying`），本地
 * 事务的 `afterTransaction` 也不回灌。
 *
 * 文档就是保存：本地编辑置的 `dirty` 当场改回 `saved`，自动保存那条路对实时板
 * 什么都不做。
 */

export interface Binding {
  /** 本地事务用的 origin；撤销管理器按它认「这是我做的」。 */
  readonly origin: object;
  /** 文档里攒着、还没灌进 store 的远端改动现在灌进来。 */
  flush(): void;
  destroy(): void;
}

export interface BindingOptions {
  doc: Y.Doc;
  boardId: string;
  /** 有手势在进行吗（缺省读 `canvas/flow/drafts`）。 */
  gestureActive?: () => boolean;
  /** 手势开始 / 结束时回调（缺省订 `canvas/flow/drafts`）。 */
  onGestureChange?: (listener: () => void) => () => void;
  /**
   * 远端灌入要不要先等一等：还没完成第一次同步时，空文档的投影会把整块画布
   * 清空，所以同步完成之前一律不灌（`session.ts` 给）。
   */
  ready?: () => boolean;
}

function snapshotOf(state: CanvasStore): LocalSnapshot | null {
  if (!state.document) return null;
  return {
    nodes: state.document.nodes,
    edges: state.document.edges,
    whiteboard: state.whiteboard,
  };
}

export function bindStore(options: BindingOptions): Binding {
  const { doc, boardId } = options;
  const origin = { binding: boardId };
  const gestureActive = options.gestureActive ?? hasDrafts;
  const onGestureChange = options.onGestureChange ?? subscribeDrafts;
  const ready = options.ready ?? (() => true);
  let applying = false;
  let pending = false;
  let destroyed = false;

  const sameBoard = (state: CanvasStore) =>
    state.boardId === boardId && state.document?.board.id === boardId;

  const flush = () => {
    if (destroyed || !pending || !ready()) return;
    if (gestureActive()) return;
    const state = useCanvasStore.getState();
    if (!sameBoard(state)) return;
    const local = snapshotOf(state);
    if (!local) return;
    pending = false;
    const remote = readRemote(doc, boardId, local);
    applying = true;
    try {
      state.applyRealtimeState(remote);
    } finally {
      applying = false;
    }
  };

  const onTransaction = (transaction: Y.Transaction) => {
    if (transaction.origin === origin) return;
    if (transaction.changed.size === 0) return;
    pending = true;
    flush();
  };
  doc.on("afterTransaction", onTransaction);

  const unsubscribeStore = useCanvasStore.subscribe((state, previous) => {
    if (applying || destroyed) return;
    if (!sameBoard(state) || !sameBoard(previous)) return;
    const before = snapshotOf(previous);
    const after = snapshotOf(state);
    if (!before || !after) return;
    if (
      before.nodes !== after.nodes ||
      before.edges !== after.edges ||
      before.whiteboard !== after.whiteboard
    ) {
      // 还没同步完（或只读）时本地本来就落不下编辑（`isReadOnly`），这里
      // 只是兜底：不往一份还没对上的文档里写。
      if (ready()) writeLocal(doc, before, after, origin);
    }
    if (state.saveState === "dirty") {
      useCanvasStore.setState({ saveState: "saved", saveError: null });
    }
  });

  const offGesture = onGestureChange(() => {
    if (!gestureActive()) flush();
  });

  return {
    origin,
    flush: () => {
      pending = true;
      flush();
    },
    destroy: () => {
      destroyed = true;
      doc.off("afterTransaction", onTransaction);
      unsubscribeStore();
      offGesture();
    },
  };
}
