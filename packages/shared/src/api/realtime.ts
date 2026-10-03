import { z } from "zod";

/**
 * Real-time collaboration (contract §16, docs/design/completion-architecture.md
 * §6). §16.1–§16.2 (sync frames, materialisation) are filled in by G1-9;
 * comments (§16.3) and the awareness shape (§16.4) by G2-6 / G2-5.
 */

/** Hello capability: this core speaks the `…/sync` protocol (§16.1). */
export const REALTIME_CAPABILITY = "canvas.realtime.v1";

/**
 * Outer message type of a `…/sync` binary frame (a lib0 varUint), the same
 * framing `y-websocket` uses. `sync` carries a y-protocols sync message
 * (step1 / step2 / update); `awareness` an awareness update.
 */
export const REALTIME_MESSAGE = {
  sync: 0,
  awareness: 1,
  queryAwareness: 3,
} as const;

/** Close codes of the `…/sync` socket (§16.1). */
export const REALTIME_CLOSE = {
  /** The core is stopping, or the board's document was evicted. Reconnect. */
  goingAway: 1001,
  /** One frame exceeded {@link REALTIME_MAX_FRAME_BYTES}. */
  tooLarge: 1009,
  /** A frame could not be decoded, or was a text frame. */
  badFrame: 4400,
  /**
   * An update from a connection without `canvas:write`, or write/read access
   * was revoked. Do not reconnect as a writer; treat the board as read-only.
   */
  forbidden: 4403,
} as const;

export const REALTIME_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * `GET /api/workspaces/{id}/boards/{boardId}/realtime` (§16.2): whether a
 * board has moved to a live `Y.Doc`, how far the tables are materialised, and
 * whether the setting `collab.realtime` lets a board switch.
 *
 * A page opens `…/sync` when `realtime || enabled`; otherwise it stays on the
 * lease + CAS path.
 */
export const boardRealtimeStateSchema = z.looseObject({
  realtime: z.boolean(),
  materializedSeq: z.number().int().nonnegative(),
  enabled: z.boolean().optional(),
});

export type BoardRealtimeState = z.infer<typeof boardRealtimeStateSchema>;

/** Error codes the realtime domain adds (§16.2). */
export const REALTIME_ERROR_CODES = {
  /** `PUT …/document` on a realtime board: edits go through `…/sync`. */
  active: "realtime_active",
  /** `…/sync` upgrade refused: setting off and the board is not realtime. */
  disabled: "realtime_disabled",
} as const;
