import { z } from "zod";

/**
 * Real-time collaboration (contract §16, docs/design/completion-architecture.md
 * §6). Skeleton: G1-9 fills in sync frames and materialisation, G2-5 / G2-6
 * comments and awareness.
 */

/** Whether a board has moved to a live `Y.Doc`, and how far it is materialised. */
export const boardRealtimeStateSchema = z.looseObject({
  realtime: z.boolean(),
  materializedSeq: z.number().int().nonnegative(),
});

export type BoardRealtimeState = z.infer<typeof boardRealtimeStateSchema>;
