/**
 * The adapter's half of the hook surface: the same endpoint discovery, tokens,
 * HTTP and `terminalBinding` sequence as `armadra-hook`, from the same source
 * (`src/hook-client/`, `cli/armadra-hook/binding.ts`). The core cannot tell
 * the adapter from the command client and gives it no extra authority
 * (docs/design/coordinator-agent.md §3, §6).
 *
 * Nothing here imports the core: the adapter runs inside ama's process and
 * reaches the core over HTTP only.
 */

import { loadBinding } from "../../cli/armadra-hook/binding.js";
import {
  browserTimeoutMs,
  controlBody,
  render,
  renderError,
} from "../../cli/armadra-hook/control.js";
import { type Endpoint, envVar } from "../../hook-client/endpoint.js";
import { isSuccess, postJsonRequest } from "../../hook-client/http.js";
import { canonicalJsonBytes, tryParseJson } from "../../hook-client/json.js";
import type { JsonValue } from "../../hook-client/json.js";
import {
  type Session,
  headersFor,
  loadSession,
  send,
} from "../../hook-client/session.js";
import type { VerbTool } from "../../hook-client/verbs.js";
import { toWireArgs } from "../../hook-client/verbs.js";

/** The hook protocol version every report carries. */
const HOOK_PROTOCOL_VERSION = 1;

/** The route ama's status reports go to: `stateSourceFor("ama")` = extension. */
export const AMA_HOOK_ROUTE = "/hook/ama";

export type CallOutcome = { ok: string } | { error: string };

/**
 * A control verb's answer as data, for the runners (`runners.ts`): the
 * success body, the refusal's `{code, message}`, or a transport failure that
 * never got an answer.
 */
export type ControlAnswer =
  | { readonly kind: "ok"; readonly body: Record<string, unknown> }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "unreachable"; readonly error: string };

/**
 * `sessionId` and `generation` for a `binding: "session"` verb, from the
 * terminal's environment exactly as `armadra-hook canvas` takes them — never
 * from the model.
 */
function sessionBinding():
  | { sessionId: string; generation: number }
  | undefined {
  const sessionId = envVar("ARMADRA_SESSION_ID");
  const raw = envVar("ARMADRA_SESSION_GENERATION");
  if (sessionId === undefined || raw === undefined || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const generation = Number(raw);
  return Number.isSafeInteger(generation)
    ? { sessionId, generation }
    : undefined;
}

/**
 * One tool call: `POST <tool.path>` with `{nodeId, args}`, the body the CLI
 * would have sent. The answer is the runtime's prose, rendered the way the CLI
 * prints it; a refusal is the runtime's own sentence.
 */
export async function callVerb(
  tool: VerbTool,
  input: unknown,
): Promise<CallOutcome> {
  const wire = toWireArgs(tool, input);
  if ("error" in wire) return { error: wire.error };
  const args: Record<string, JsonValue> = { ...wire.ok };
  if (tool.binding === "session") {
    const binding = sessionBinding();
    if (binding !== undefined) {
      args.sessionId = binding.sessionId;
      args.generation = binding.generation;
    } else if (tool.verb === "handoff-read") {
      return {
        error:
          "A current terminal session binding is required; restart an older terminal.",
      };
    }
  }
  const loaded = loadSession();
  if ("error" in loaded) return { error: loaded.error };
  const body = controlBody(loaded.ok.nodeId, args);
  const outcome = await send(
    loaded.ok,
    (current, candidate) =>
      postJsonRequest(tool.path, headersFor(current, candidate), body),
    tool.long === true ? browserTimeoutMs() : undefined,
  );
  if ("error" in outcome) return { error: outcome.error };
  if (!isSuccess(outcome.ok)) return { error: renderError(outcome.ok) };
  return { ok: render(outcome.ok) };
}

/**
 * `POST /control/<verb>` with raw `args`, answered as data. `totalMs` is the
 * per-candidate budget: `wait` holds the request for up to its `--timeout`.
 */
export async function callControl(
  verb: string,
  args: Record<string, JsonValue>,
  totalMs?: number,
): Promise<ControlAnswer> {
  const loaded = loadSession();
  if ("error" in loaded) return { kind: "unreachable", error: loaded.error };
  const body = controlBody(loaded.ok.nodeId, args);
  const outcome = await send(
    loaded.ok,
    (current, candidate) =>
      postJsonRequest(
        `/control/${encodeURIComponent(verb)}`,
        headersFor(current, candidate),
        body,
      ),
    totalMs,
  );
  if ("error" in outcome) return { kind: "unreachable", error: outcome.error };
  const parsed = tryParseJson(outcome.ok.body);
  const object =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (isSuccess(outcome.ok)) return { kind: "ok", body: object };
  return {
    kind: "refused",
    status: outcome.ok.status,
    code: typeof object.code === "string" ? object.code : "error",
    message:
      typeof object.message === "string"
        ? object.message
        : renderError(outcome.ok),
  };
}

/** `POST /context-link/<verb>`: the prose the CLI would print, or `undefined`. */
export async function callContext(
  verb: string,
  args: Record<string, JsonValue>,
): Promise<string | undefined> {
  const loaded = loadSession();
  if ("error" in loaded) return undefined;
  const body = controlBody(loaded.ok.nodeId, args);
  const outcome = await send(loaded.ok, (current, candidate) =>
    postJsonRequest(
      `/context-link/${encodeURIComponent(verb)}`,
      headersFor(current, candidate),
      body,
    ),
  );
  if ("error" in outcome || !isSuccess(outcome.ok)) return undefined;
  return render(outcome.ok);
}

/**
 * One status report: `POST /hook/ama` with the payload, the node id and — when
 * the terminal has a session binding — the next `sourceRevision` of the same
 * sequence file the command client advances. Best effort: never throws.
 */
export async function report(
  payload: Record<string, JsonValue>,
): Promise<number | undefined> {
  return (await reportTo(payload))?.status;
}

/**
 * {@link report} with the extra envelope fields of a permission request
 * (`pendingId`, contract §5.5) and a `prepare` step run for each candidate
 * just before the request goes out — where the approval broker writes its
 * request file, next to the runtime that will answer it. Answers the status
 * and the candidate that answered.
 */
export async function reportTo(
  payload: Record<string, JsonValue>,
  options: {
    readonly pendingId?: string;
    readonly prepare?: (candidate: Endpoint) => void;
  } = {},
): Promise<{ status: number; candidate: Endpoint } | undefined> {
  try {
    const binding = loadBinding();
    let session: Session;
    let terminalBinding: JsonValue | undefined;
    if (binding !== undefined) {
      session = binding.session;
      terminalBinding = {
        sessionId: binding.sessionId,
        generation: binding.generation,
        sourceRevision: String(binding.revision),
      };
    } else {
      const loaded = loadSession();
      if ("error" in loaded) return undefined;
      session = loaded.ok;
    }
    const body = canonicalJsonBytes({
      nodeId: session.nodeId,
      version: HOOK_PROTOCOL_VERSION,
      payload,
      terminalBinding,
      ...(options.pendingId === undefined
        ? {}
        : { pendingId: options.pendingId }),
    });
    const outcome = await send(session, (current, candidate) => {
      options.prepare?.(candidate);
      return postJsonRequest(
        AMA_HOOK_ROUTE,
        headersFor(current, candidate),
        body,
      );
    });
    return "error" in outcome
      ? undefined
      : { status: outcome.ok.status, candidate: outcome.candidate };
  } catch {
    return undefined;
  }
}
