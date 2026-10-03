/**
 * `armadra-hook credential --ama` — the `run/ama` launcher's half of ama's
 * model keys (contract §12.4). Internal: only the launcher calls it, inside
 * `$( … )`.
 *
 * It presents this node's token to the local hook service and prints one
 * `AMA_API_KEY_<PROVIDER>=<key>` line per key the settings hold, for the
 * launcher to set on the ama process. It **fails closed** like
 * `credential`: any error is a non-zero exit with a line on stderr, and the
 * launcher refuses to start ama. No keys set is not an error: no lines.
 *
 * The values go to stdout and nowhere else — not stderr, not a file.
 */

import { canonicalJsonBytes } from "../../hook-client/json.js";
import { isSuccess, postJsonRequest } from "../../hook-client/http.js";
import { headersFor, loadSession, send } from "../../hook-client/session.js";

/** Only ama's own key variables; the launcher checks the names again. */
const NAME = /^AMA_API_KEY_[A-Z0-9_]+$/;

export async function run(): Promise<number> {
  const loaded = loadSession();
  if ("error" in loaded) return fail(loaded.error);
  const session = loaded.ok;
  const body = canonicalJsonBytes({ nodeId: session.nodeId });
  const outcome = await send(session, (current, candidate) =>
    postJsonRequest("/credential/ama", headersFor(current, candidate), body),
  );
  if ("error" in outcome) return fail(outcome.error);
  let parsed: { variables?: unknown; message?: unknown } | undefined;
  try {
    parsed = JSON.parse(outcome.ok.body) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (!isSuccess(outcome.ok)) {
    return fail(
      typeof parsed?.message === "string"
        ? parsed.message
        : `the core refused ama's keys (${outcome.ok.status})`,
    );
  }
  if (!Array.isArray(parsed?.variables)) {
    return fail("the core answered no key list");
  }
  const lines: string[] = [];
  for (const entry of parsed.variables as unknown[]) {
    const { variable, value } = (entry ?? {}) as {
      variable?: unknown;
      value?: unknown;
    };
    if (
      typeof variable !== "string" ||
      !NAME.test(variable) ||
      typeof value !== "string" ||
      value === "" ||
      /[\r\n\0]/.test(value)
    ) {
      return fail("the core answered an unusable key");
    }
    lines.push(`${variable}=${value}`);
  }
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function fail(message: string): number {
  process.stderr.write(`armadra: ama keys: ${message}\n`);
  return 1;
}
