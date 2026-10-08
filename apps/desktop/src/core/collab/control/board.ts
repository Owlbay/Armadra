import {
  DEFAULT_LAYOUT_DIRECTION,
  dispatchPlacement,
  type LayoutDirection,
  type PlacementBox,
} from "@armadra/shared";

import type { Board } from "../../canvas/boards";
import type {
  BoardDocument,
  CanvasNode,
  Position,
} from "../../canvas/document-types";
import { loadBoard, saveBoard } from "../../canvas/documents";
import { settingsDomain } from "../../settings";
import { completionSettings } from "../../settings/schema";
import { DomainError, rfc3339, uuidV7 } from "../../workspaces/support";
import type { Caller } from "../nodes";
import { Refusal, collapseNewlines } from "../refusals";
import type { CollabContext } from "../service";

/**
 * Loading and saving the board document, plus the placement and naming rules
 * every control verb shares.
 *
 * Ported from the pre-merge implementation. Every mutating verb
 * goes through the ordinary board document — load, edit, save with the same
 * CAS the web app uses — and then publishes `board.changed` so the canvas
 * reloads. The agent never touches the front end, and the front end never has
 * to trust the agent: it re-reads the board it already knows how to read.
 */

export const DEFAULT_NODE_COLOR = "#0a84ff";

/**
 * The 7 node colours a control verb may set — mirrors `NODE_COLORS` in
 * `packages/shared/src/domain.ts`.
 */
export const NODE_PALETTE = [
  "#0a84ff",
  "#32d74b",
  "#ffd60a",
  "#ff453a",
  "#bf5af2",
  "#6ac4dc",
  "#ff9f0a",
] as const;

/** New nodes are placed to the right of the node that asked for them. */
export const PLACEMENT_GAP = 60;

/**
 * How far down to step when the spot picked for a new node is already taken.
 *
 * Deliberately **not** a per-type size table. The one table of default node
 * geometry lives in the front end (`apps/web/src/nodes/registry.ts`), because
 * that is where a default size means something — it is the size the node is
 * drawn at. A second table here is what made an agent-created terminal come
 * out 640×440 while the one a person adds from the menu is 960×600, so the
 * control verbs no longer write a size at all: they leave `size` absent and
 * the page fills it in from that single table when it projects the document
 * (`canvas/sync/project.ts`). Placement only needs somewhere to stand, and a
 * constant step is enough for that.
 */
export const PLACEMENT_STEP = 640;

/** Width assumed for an anchor node that has never been resized. */
export const ANCHOR_FALLBACK_WIDTH = 960;

export function load(context: CollabContext, caller: Caller): BoardDocument {
  try {
    return loadBoard(
      context.database,
      caller.node.workspaceId,
      caller.node.boardId,
    );
  } catch (error) {
    throw asRefusal(error);
  }
}

/**
 * Saves through the same optimistic-concurrency path the canvas uses and tells
 * every client to reload. A conflict means a human moved something in the last
 * instant; asking the agent to retry is the honest answer.
 */
export function save(
  context: CollabContext,
  caller: Caller,
  document: BoardDocument,
  created?: CanvasNode,
): void {
  let saved: BoardDocument;
  try {
    saved = saveBoard(
      context.database,
      caller.node.workspaceId,
      caller.node.boardId,
      {
        expectedUpdatedAt: document.board.updatedAt,
        nodes: document.nodes,
        edges: document.edges,
        viewport: document.board.viewport,
        // The control verbs add and move nodes; the whiteboard is not theirs
        // to touch, so it is carried through untouched.
      },
    );
  } catch (error) {
    if (error instanceof DomainError && error.status === 409) {
      throw Refusal.badRequest("画布刚刚被改动过，请再试一次。");
    }
    throw asRefusal(error);
  }
  context.publish(caller.node.workspaceId, {
    type: "board.changed",
    boardId: saved.board.id,
    updatedAt: saved.board.updatedAt,
  });
  // `board.changed` says the board is a version newer; it does not say a node
  // appeared, and it cannot say which. A page that is looking at this board
  // wants to be taken to the new node the same way it is when a person adds
  // one from the menu, so the verb names it. `originNodeId` is the node that
  // asked — it is what lets a client tell an arrival on the board it is
  // watching from one on a board nobody has open.
  if (created !== undefined) {
    context.publish(caller.node.workspaceId, {
      type: "node.created",
      boardId: saved.board.id,
      nodeId: created.id,
      nodeType: created.type,
      originNodeId: caller.node.id,
    });
  }
}

export function asRefusal(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  if (error instanceof DomainError) {
    return new Refusal(
      error.status,
      error.status >= 500 ? `画布操作失败：${error.message}` : error.message,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return Refusal.internal(`画布操作失败：${message}`);
}

/**
 * A node with no `size`: see {@link PLACEMENT_STEP}. The page supplies the
 * default for the type, so a node a verb creates and a node a person adds from
 * the menu come out the same size, and stay that way when that table changes.
 */
export function newNode(
  boardId: string,
  nodeType: string,
  title: string,
  position: Position,
  data: unknown,
): CanvasNode {
  const now = rfc3339();
  return {
    id: uuidV7(),
    boardId,
    type: nodeType,
    title,
    color: DEFAULT_NODE_COLOR,
    position,
    labels: [],
    note: "",
    data,
    createdAt: now,
    updatedAt: now,
  };
}

/** Height assumed for a node that has never been resized (the terminal default). */
export const NODE_FALLBACK_HEIGHT = 600;

/**
 * `canvas.layoutDirection`（契约 §50）。读不到设置（测试里没装设置域）按缺省
 * 纵向。
 */
export function layoutDirection(): LayoutDirection {
  const settings = settingsDomain()?.settings.snapshot();
  return settings === undefined
    ? DEFAULT_LAYOUT_DIRECTION
    : completionSettings(settings).canvas.layoutDirection;
}

function boxOf(node: CanvasNode): PlacementBox {
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: node.size?.width ?? ANCHOR_FALLBACK_WIDTH,
    height: node.size?.height ?? NODE_FALLBACK_HEIGHT,
  };
}

/**
 * Where a node the caller dispatches goes: the shared `dispatchPlacement` rule
 * (契约 §50) — under the caller in a vertical layout, to its right in a
 * horizontal one, after the subordinates it already has, stepping along the row
 * (or column) while the spot overlaps something. Existing nodes never move.
 *
 * Sizes are not known here (see {@link PLACEMENT_STEP}); a node without one is
 * taken to be a default terminal.
 */
export function placement(
  document: BoardDocument,
  callerId: string,
  direction: LayoutDirection = layoutDirection(),
): Position {
  const anchor = document.nodes.find((node) => node.id === callerId);
  if (anchor === undefined) return { x: PLACEMENT_GAP, y: PLACEMENT_GAP };
  // Same coordinate space as the caller: a member of a frame only competes
  // with the other members of that frame.
  const boxes = document.nodes
    .filter((node) => (node.parentId ?? null) === (anchor.parentId ?? null))
    .map(boxOf);
  const children = document.edges
    .filter((edge) => edge.role === "supervises" && edge.source === callerId)
    .map((edge) => edge.target);
  return (
    dispatchPlacement(
      boxes,
      callerId,
      { width: ANCHOR_FALLBACK_WIDTH, height: NODE_FALLBACK_HEIGHT },
      direction,
      children,
    ) ?? { x: PLACEMENT_GAP, y: PLACEMENT_GAP }
  );
}

/**
 * `--node` / `--to` against the board itself, for the verbs that edit what is
 * already there.
 *
 * Unlike {@link import("../addressing").resolveLink} this does not require a
 * context link: renaming or colouring a node on your own board is not reaching
 * into somebody else's context. Ambiguity is still refused rather than
 * guessed.
 */
export function resolveOnBoard(
  document: BoardDocument,
  wanted: string,
): CanvasNode {
  const needle = wanted.trim();
  const byId = document.nodes.find((node) => node.id === needle);
  if (byId !== undefined) return byId;
  const lowered = needle.toLowerCase();
  const exact = document.nodes.filter(
    (node) => node.title.toLowerCase() === lowered,
  );
  if (exact.length === 1) return exact[0] as CanvasNode;
  if (exact.length > 1) throw ambiguous(needle, exact.length);
  const partial = document.nodes.filter((node) =>
    node.title.toLowerCase().includes(lowered),
  );
  if (partial.length === 1) return partial[0] as CanvasNode;
  if (partial.length > 1) throw ambiguous(needle, partial.length);
  throw Refusal.notFound(`这块画布上没有叫「${needle}」的节点。`);
}

function ambiguous(wanted: string, count: number): Refusal {
  return Refusal.badRequest(
    `「${wanted}」同时匹配 ${count} 个节点，请改用节点 ID。`,
  );
}

export function cleanTitle(title: string): string {
  const cleaned = collapseNewlines(title);
  if (cleaned === "") throw Refusal.badRequest("标题不能是空的。");
  if ([...cleaned].length > 160) {
    throw Refusal.badRequest("标题最长 160 个字符。");
  }
  return cleaned;
}

export type { Board, BoardDocument, CanvasNode };
