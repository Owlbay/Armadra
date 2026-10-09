import { z } from "zod";

/**
 * `POST /api/workspaces/{id}/agent-uploads?name=<file name>` — contract §55.
 *
 * A file pasted or dropped onto an agent node. The body is the raw bytes with
 * the file's own `Content-Type`; the core that answers is the one the session
 * runs on, so the bytes land on the agent's host (a relayed source's core is
 * on the other machine), under that core's data directory, one folder per
 * workspace. Nothing is written into the workspace itself.
 *
 * `path` is absolute on that host: the terminal node pastes it, an ACP prompt
 * names the upload by `id`.
 */
export const MAX_AGENT_UPLOAD_BYTES = 25 * 1024 * 1024;

/** What an ACP prompt may carry inline as an `image` block. */
export const MAX_ACP_IMAGE_BYTES = 8 * 1024 * 1024;

/** At most this many attachments on one ACP prompt. */
export const MAX_ACP_ATTACHMENTS = 10;

export const agentUploadResponseSchema = z.object({
  /** 32 hex digits; what an ACP prompt's `attachments[].uploadId` names. */
  id: z.string(),
  /** The stored file name (sanitised; the extension is kept). */
  name: z.string(),
  /** Absolute path on the session's host. */
  path: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
});

export type AgentUploadResponse = z.infer<typeof agentUploadResponseSchema>;
