/**
 * The ceilings and the stable reason keys — the pre-merge implementation
 * top half, kept in its own module so `jsonrpc` and `registry` can share them
 * without importing each other.
 */

/** Stable reason keys. The interface localises them; the core never invents
 * prose here, because a reason a client cannot match is a reason it cannot
 * explain. */
export const reason = {
  SERVER_NOT_FOUND: "server_not_found",
  SERVER_PROBE_FAILED: "server_probe_failed",
  EXECUTION_NOT_GRANTED: "execution_not_granted",
  DISABLED: "disabled",
  LANGUAGE_UNKNOWN: "language_unknown",
  TOO_MANY_SERVERS: "too_many_servers",
  CONTAINMENT_UNAVAILABLE: "containment_unavailable",
  RESOURCE_EXHAUSTED: "resource_exhausted",
  IDLE: "idle",
  USER: "user",
  CRASHED: "crashed",
  /**
   * The server started, read `initialize`, and refused it. That is not a
   * crash: the process was fine and it said exactly what was wrong — a
   * missing toolchain, an unreadable project — so the answer carries its own
   * message instead of the word "crashed".
   */
  INITIALIZE_FAILED: "initialize_failed",
  RESTART_BUDGET_EXHAUSTED: "restart_budget_exhausted",
  WORKSPACE_CLOSED: "workspace_closed",
  /** The remote execution host's language link went away. */
  LINK_LOST: "link_lost",
  /** Why a server's own `workspace/applyEdit` was not applied. */
  READ_ONLY: "read_only",
  EDIT_NOT_APPLICABLE: "edit_not_applicable",
  UNSAVED_CHANGES: "unsaved_changes",
  /** No language server runs on another machine yet (see `index.ts`). */
  UNSUPPORTED_REMOTE: "unsupported_remote",
} as const;

/* --------------------------------- limits --------------------------------- */

/** Matches the editor's own preview ceiling. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** Per execution host. */
export const MAX_SESSIONS = 32;
/** One JSON-RPC message. */
export const MAX_MESSAGE_BYTES = 960 * 1024;
/**
 * Backpressure (platform spec, core packages §3.3): `pause`, 256 frames,
 * 2 MiB. Past the mark the hub stops reading its server's stdout until the
 * socket drains; a queue that still fills — a peer that stopped reading
 * entirely — closes the socket with 1013 rather than dropping an answer.
 */
export const SESSION_MAX_FRAMES = 256;
export const SESSION_HIGH_WATER_BYTES = 2 * 1024 * 1024;

/**
 * The largest frame the editor may send. A message over
 * `MAX_MESSAGE_BYTES` is answered with a JSON-RPC error by the session, so
 * the socket's own ceiling sits above it: a document at the 1 MiB preview
 * limit, JSON-escaped, still arrives and is refused in words rather than by a
 * 1009 close.
 */
export const SESSION_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** In-flight requests per session; beyond this the session is told `-32803`. */
export const MAX_IN_FLIGHT = 32;
/** One request, in seconds. On expiry the server is sent `$/cancelRequest`. */
export const REQUEST_TIMEOUT_SECONDS = 30;
/** stderr kept per server, tail only, in memory. */
export const STDERR_TAIL_BYTES = 64 * 1024;
/** Crashes tolerated inside {@link RESTART_WINDOW_SECONDS}. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_SECONDS = 600;
/** Back-off before each restart, in seconds. */
export const RESTART_BACKOFF_SECONDS = [1, 5, 20] as const;

/** The ceilings a client must respect, as `language.proto` states them. */
export function capabilityLimits(): readonly [number, number, number] {
  return [MAX_DOCUMENT_BYTES, MAX_SESSIONS, MAX_MESSAGE_BYTES];
}
