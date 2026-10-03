/**
 * `armadra-hook credential` — the canvas launcher's half of node credentials
 * (contract §20.4). Internal: only `run/<cli>` calls it, inside `$( … )`.
 *
 * It presents this node's token and the entry name in `ARMADRA_CREDENTIAL_REF`
 * to the local hook service and prints `NAME=value` on stdout for the
 * launcher to set on the CLI process. Unlike hook mode this **fails closed**:
 * any error is a non-zero exit with a line on stderr, and the launcher then
 * refuses to start the CLI — starting it under the default login would be
 * running it as the wrong account.
 *
 * The value is never written anywhere else: not to stderr, not to a file.
 */

import { canonicalJsonBytes } from "../../hook-client/json.js";
import { envVar } from "../../hook-client/endpoint.js";
import { isSuccess, postJsonRequest } from "../../hook-client/http.js";
import { headersFor, loadSession, send } from "../../hook-client/session.js";

/** The launcher accepts nothing that does not look like a variable name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function run(): Promise<number> {
  const ref = envVar("ARMADRA_CREDENTIAL_REF");
  if (ref === undefined) return fail("ARMADRA_CREDENTIAL_REF is not set");
  const loaded = loadSession();
  if ("error" in loaded) return fail(loaded.error);
  const session = loaded.ok;
  const body = canonicalJsonBytes({ nodeId: session.nodeId, ref });
  const outcome = await send(session, (current, candidate) =>
    postJsonRequest("/credential", headersFor(current, candidate), body),
  );
  if ("error" in outcome) return fail(outcome.error);
  const parsed = parse(outcome.ok.body);
  if (!isSuccess(outcome.ok)) {
    return fail(
      parsed?.message ??
        `the core refused the credential (${outcome.ok.status})`,
    );
  }
  const variable = parsed?.variable;
  const value = parsed?.value;
  if (
    typeof variable !== "string" ||
    !NAME.test(variable) ||
    typeof value !== "string" ||
    value === "" ||
    /[\r\n\0]/.test(value)
  ) {
    return fail("the core answered an unusable credential");
  }
  process.stdout.write(`${variable}=${value}`);
  return 0;
}

function parse(
  body: string,
): { variable?: unknown; value?: unknown; message?: string } | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (typeof value !== "object" || value === null) return undefined;
    return {
      variable: value.variable,
      value: value.value,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  } catch {
    return undefined;
  }
}

function fail(message: string): number {
  process.stderr.write(`armadra: node credential: ${message}\n`);
  return 1;
}
