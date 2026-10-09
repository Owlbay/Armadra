import type { HandlerResult } from "../http/router";
import { validNodeId } from "./auth";
import type { HookService, ModHello } from "./service";

/**
 * `POST /node/mod` on the hook surface — the hello of a Claude Code mod
 * (contract §57.3).
 *
 * The mod sends it at `session.start`, and again when its reports start
 * going another way (the host refused a fetch and the hook client took
 * over). It is the only sign that the mod loaded at all: a mod the host
 * refused sends nothing, and the settings page names the sessions it heard
 * from. Kept in memory per node, the latest one only; never stored, never
 * logged.
 *
 * Same gates as `/credential`: the app bearer (checked by the caller) and a
 * node token that verifies — an unverified hello would let any process name
 * any node.
 */

const TRANSPORTS = ["socket", "tcp", "process"] as const;
const PROFILES = ["terminal", "acp"] as const;
const SURFACES = ["terminal", "desktop", "mobile", "vscode"] as const;

/** A short printable value, or `undefined`. */
function short(value: unknown, limit = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > limit) return undefined;
  return /\p{Cc}/u.test(trimmed) ? undefined : trimmed;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** The body as a hello, or why not. */
export function parseModHello(
  raw: unknown,
  reportedAt: string,
): ModHello | { readonly error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "body is not an object" };
  }
  const body = raw as Record<string, unknown>;
  const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
  if (!validNodeId(nodeId)) return { error: "nodeId is not a node id" };
  const engine = short(body.engine);
  const version = short(body.version);
  const transport = oneOf(body.transport, TRANSPORTS);
  const profile = oneOf(body.profile, PROFILES) ?? "terminal";
  const modRevision = body.modRevision;
  if (
    engine === undefined ||
    version === undefined ||
    transport === undefined
  ) {
    return { error: "engine, version and transport are required" };
  }
  if (
    typeof modRevision !== "number" ||
    !Number.isSafeInteger(modRevision) ||
    modRevision < 1
  ) {
    return { error: "modRevision is not a positive integer" };
  }
  return {
    nodeId,
    engine,
    version,
    base: short(body.base) ?? null,
    surface: oneOf(body.surface, SURFACES) ?? null,
    isInteractive: body.isInteractive === true,
    profile,
    transport,
    modRevision,
    reportedAt,
  };
}

/** The route's answer, once the bearer has been checked. */
export function receiveModHello(
  hooks: HookService,
  body: unknown,
  nodeToken: string | undefined,
  now: () => Date = () => new Date(),
): HandlerResult {
  const hello = parseModHello(body, now().toISOString());
  if ("error" in hello) {
    return {
      status: 400,
      body: { code: "bad_request", message: hello.error },
    };
  }
  if (hooks.verdict(hello.nodeId, nodeToken) !== "verified") {
    return {
      status: 403,
      body: { code: "forbidden", message: "The node token is not valid" },
    };
  }
  hooks.recordModHello(hello);
  return { status: 204 };
}
