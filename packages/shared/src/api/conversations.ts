import { z } from "zod";
import { AGENT_IDS } from "../agents.js";

/**
 * Which CLI wrote the transcript a conversation row was read from. Every
 * built-in agent is allowed: which of them actually produce rows is decided by
 * the core's history adapters, and a narrower enum here would reject a row the
 * moment one more adapter is registered.
 */
export const CONVERSATION_PROVIDERS = AGENT_IDS;
export const conversationProviderSchema = z.enum(CONVERSATION_PROVIDERS);

/**
 * `GET /api/conversations?q=&limit=` — one row per transcript found on this
 * machine, newest first (plan §16/§17).
 *
 * `path` is deliberately not exposed: the palette shows a title, a directory
 * and a time, and resuming needs only `provider` + `sessionId`. Keeping the
 * absolute transcript path out of the response keeps the browser side of the
 * app from growing an opinion about the user's disk.
 */
export const conversationSchema = z.object({
  provider: conversationProviderSchema,
  sessionId: z.string().min(1),
  title: z.string(),
  /** Working directory the session ran in; empty when the CLI does not record one. */
  cwd: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
  bytes: z.number().int().nonnegative(),
});

export const conversationsResponseSchema = z.array(conversationSchema);

/** `POST /api/conversations/refresh` — what the forced rescan did. */
export const conversationRefreshResponseSchema = z.object({
  /** Transcript files looked at, across all providers. */
  scanned: z.number().int().nonnegative(),
  /** Rows inserted or updated because the file was new or its mtime moved. */
  indexed: z.number().int().nonnegative(),
  /** Rows dropped because their file is gone. */
  removed: z.number().int().nonnegative(),
  /** Rows in the index afterwards. */
  total: z.number().int().nonnegative(),
});

export type ConversationProvider = z.infer<typeof conversationProviderSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationRefreshResponse = z.infer<
  typeof conversationRefreshResponseSchema
>;
