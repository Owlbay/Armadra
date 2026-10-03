/**
 * ama's permission requests, answerable from the canvas (contract §5.5, §15.5;
 * completion architecture §5.2).
 *
 * The same round trip `armadra-hook` runs for Claude: write the request to
 * `<pending>/<id>.json` next to the runtime that will answer, report the
 * request with that `pendingId` (`/hook/ama` → `agent_approvals` → the card on
 * the canvas), then poll for `<id>.answer`. A person answers on the canvas and
 * the core writes the file; nothing here ever decides.
 *
 * The broker is the first answerer in ama's chain (host → terminal dialog →
 * unattended deny). It waits `ARMADRA_PERM_WAIT_SECS` — the variable the core
 * only sets when `hooks.replyApprovals` is on — and then steps aside: no
 * answer is `undefined`, and ama opens its own dialog in the node's terminal.
 * Without the variable there is no broker at all.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
  HostApi,
} from "@armadra/agent/host";
import { type Endpoint, pendingDir } from "../../hook-client/endpoint.js";
import { canonicalJsonBytes } from "../../hook-client/json.js";
import type { JsonValue } from "../../hook-client/json.js";
import { reportTo } from "./client.js";
import { payloadOf } from "./events.js";

/** How often the answer file is checked. */
export const POLL_INTERVAL_MS = 200;

/** The wait budget the core gave this terminal, or `undefined` for none. */
export function waitSeconds(
  env: Readonly<NodeJS.ProcessEnv>,
): number | undefined {
  const raw = env.ARMADRA_PERM_WAIT_SECS?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return seconds === 0 || seconds > 3600 ? undefined : seconds;
}

/** `<nodeId>-<epochMs>-<pid>`, the hook client's shape, plus a random tail. */
export function pendingIdFor(nodeId: string, now: number): string | undefined {
  const id = `${nodeId}-${now}-${process.pid}-${randomUUID().slice(0, 8)}`;
  return /^[A-Za-z0-9._-]{1,200}$/.test(id) && !id.includes("..")
    ? id
    : undefined;
}

/** The answer file's content as a decision; anything else is "not yet". */
export function parseAnswer(text: string): "allow" | "deny" | undefined {
  const word = text.trim().toLowerCase();
  return word === "allow" || word === "deny" ? word : undefined;
}

export interface BrokerDeps {
  readonly nodeId: string;
  readonly seconds: number;
  readonly session: HostApi["session"];
  /** Report with the pending id; answers the candidate that took it. */
  readonly report: typeof reportTo;
  readonly now?: () => number;
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Already gone; the core's sweep takes what is left.
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function poll(
  file: string,
  budgetMs: number,
  signal: AbortSignal,
): Promise<"allow" | "deny" | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const decision = parseAnswer(fs.readFileSync(file, "utf8"));
      if (decision !== undefined) return decision;
    } catch {
      // Not answered yet.
    }
    const left = deadline - Date.now();
    if (left <= 0 || signal.aborted) return undefined;
    await delay(Math.min(POLL_INTERVAL_MS, left), signal);
  }
}

/** The request as the canvas card shows it: the tool and why, no input. */
export function requestPayload(
  request: ApprovalRequest,
  session: HostApi["session"],
): Record<string, JsonValue> {
  // The tool's input stays out: a write's input is file content, and the
  // pending file and the approval record are not where file bodies go.
  return {
    ...payloadOf(
      "tool_approval_requested",
      { toolName: request.toolName },
      session,
    ),
    reason: request.reason,
  };
}

export function createBroker(deps: BrokerDeps): ApprovalBroker {
  return {
    async ask(
      request: ApprovalRequest,
      signal: AbortSignal,
    ): Promise<ApprovalDecision | undefined> {
      const id = pendingIdFor(deps.nodeId, (deps.now ?? Date.now)());
      if (id === undefined) return undefined;
      const payload = requestPayload(request, deps.session);
      const written: string[] = [];
      const reported = await deps.report(payload, {
        pendingId: id,
        prepare: (candidate: Endpoint) => {
          const directory = pendingDir(candidate);
          const file = path.join(directory, `${id}.json`);
          try {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            fs.writeFileSync(file, canonicalJsonBytes(payload), {
              mode: 0o600,
            });
            written.push(file);
          } catch {
            // No request file: the core answers by keys instead, and this
            // broker steps aside below.
          }
        },
      });
      // Only the candidate that answered watches its directory.
      const answered =
        reported !== undefined && reported.status < 300
          ? path.join(pendingDir(reported.candidate), `${id}.json`)
          : undefined;
      const keep =
        answered !== undefined && written.includes(answered)
          ? answered
          : undefined;
      for (const file of written) if (file !== keep) removeQuietly(file);
      if (keep === undefined) return undefined;
      const answerFile = keep.replace(/\.json$/, ".answer");
      const decision = await poll(answerFile, deps.seconds * 1000, signal);
      removeQuietly(answerFile);
      removeQuietly(keep);
      return decision;
    },
  };
}

/**
 * Installs the broker when the core asked for canvas answers (the variable)
 * and ama runs with a terminal of its own; under ACP the client answers.
 */
export function installBroker(
  api: Pick<HostApi, "env" | "mode" | "approvals" | "session">,
  report: typeof reportTo = reportTo,
): boolean {
  const nodeId = api.env.ARMADRA_NODE_ID?.trim();
  const seconds = waitSeconds(api.env);
  if (nodeId === undefined || nodeId === "" || seconds === undefined) {
    return false;
  }
  if (api.mode !== "interactive" && api.mode !== "line") return false;
  api.approvals.setBroker(
    createBroker({ nodeId, seconds, session: api.session, report }),
  );
  return true;
}
