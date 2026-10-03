/**
 * ama's events → `POST /hook/ama`, in Pi's vocabulary and payload shape
 * (`core/hook/install/extension-template.ts`'s `armadraPayload`), so the
 * core's `normalize/pi.ts` reads them without a line of translation
 * (docs/design/coordinator-agent.md §2.3).
 *
 * Every report is best effort and fire-and-forget, so a slow socket never
 * adds latency to a turn — except `session_shutdown`, which ama awaits: the
 * process is on its way out and an unawaited report would be lost.
 */

import type { AgentEventName, HostApi } from "@armadra/agent/host";
import type { JsonValue } from "../../hook-client/json.js";
import { report } from "./client.js";

/**
 * Every event the core's ama adapter normalises: Pi's list plus ama's two
 * approval events. Mirrors `AMA_HOOK_EVENTS` in `core/hook/install/events.ts`
 * and `packages/shared` (restated: the adapter may not import the core);
 * `events.test.ts` holds the three together.
 */
export const AMA_EVENTS = [
  "session_start",
  "before_agent_start",
  "agent_start",
  "tool_call",
  "tool_result",
  "agent_end",
  "agent_settled",
  "session_compact",
  "model_select",
  "session_shutdown",
  "tool_approval_requested",
  "tool_approval_resolved",
] as const satisfies readonly AgentEventName[];

const MAX_TEXT = 2000;
const MAX_PATH = 4096;

/** The core caps short strings at 200 characters and refuses control bytes. */
function shortText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 200) return undefined;
  return /[\u0000-\u001f\u007f]/.test(trimmed) ? undefined : trimmed;
}

function pathText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= MAX_PATH
    ? value
    : undefined;
}

/** What the session is now: ama's own accessors, read at the event. */
export interface SessionView {
  id(): string;
  file(): string | undefined;
  cwd(): string;
}

/** One event as the payload the core expects. */
export function payloadOf(
  name: string,
  event: Record<string, unknown>,
  session: SessionView,
): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    hookEventName: name,
    provider: "ama",
  };
  const sessionId = shortText(event.sessionId) ?? shortText(safe(session.id));
  if (sessionId !== undefined) payload.sessionId = sessionId;
  const file = pathText(event.sessionFile) ?? pathText(safe(session.file));
  if (file !== undefined) payload.transcriptPath = file;
  const cwd = pathText(event.cwd) ?? pathText(safe(session.cwd));
  if (cwd !== undefined) payload.cwd = cwd;
  const toolName = shortText(event.toolName);
  if (toolName !== undefined) payload.toolName = toolName;
  if (name === "before_agent_start" && typeof event.prompt === "string") {
    payload.prompt = event.prompt.slice(0, MAX_TEXT);
  }
  if (name === "model_select") {
    const model = event.model as { id?: unknown } | undefined;
    const modelId = shortText(model?.id);
    if (modelId !== undefined) payload.modelId = modelId;
  }
  return payload;
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export type Reporter = (
  payload: Record<string, JsonValue>,
) => Promise<unknown>;

/** Subscribes every event in {@link AMA_EVENTS}; answers the unsubscribers. */
export function subscribeEvents(
  api: Pick<HostApi, "events" | "session">,
  send: Reporter = report,
): (() => void)[] {
  return AMA_EVENTS.map((name) =>
    api.events.on(name, (event) => {
      let reported: Promise<unknown>;
      try {
        reported = send(
          payloadOf(name, (event ?? {}) as Record<string, unknown>, api.session),
        ).catch(() => undefined);
      } catch {
        return undefined;
      }
      if (name === "session_shutdown") return reported.then(() => undefined);
      return undefined;
    }),
  );
}
