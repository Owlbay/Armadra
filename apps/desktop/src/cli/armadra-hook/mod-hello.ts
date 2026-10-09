/**
 * `armadra-hook mod-hello` — the Claude Code mod's hello when the host
 * refused the mod's own fetch (contract §57.3). Internal: only the mod runs
 * it, with the hello's JSON on stdin.
 *
 * Hook mode's rules: it never prints, always exits 0, and gives up quietly —
 * a lost hello costs the settings page one line, never the user's session.
 * The node id is this process's own `ARMADRA_NODE_ID`, whatever the body
 * says, and the transport is always `process`: that is the way it came.
 */

import { canonicalJsonBytes, parseJson } from "../../hook-client/json.js";
import type { JsonValue } from "../../hook-client/json.js";
import { postJsonRequest } from "../../hook-client/http.js";
import { headersFor, loadSession, send } from "../../hook-client/session.js";
import { debug, readStdinCapped } from "./hook.js";

export async function run(): Promise<number> {
  const { bytes, truncated } = await readStdinCapped();
  if (truncated) return 0;
  let hello: JsonValue;
  try {
    hello = parseJson(bytes.toString("utf8").trim());
  } catch {
    return 0;
  }
  if (hello === null || typeof hello !== "object" || Array.isArray(hello)) {
    return 0;
  }
  const loaded = loadSession();
  if ("error" in loaded) {
    debug(loaded.error);
    return 0;
  }
  const session = loaded.ok;
  const body = canonicalJsonBytes({
    ...hello,
    nodeId: session.nodeId,
    transport: "process",
  });
  const outcome = await send(session, (current, candidate) =>
    postJsonRequest("/node/mod", headersFor(current, candidate), body),
  );
  if ("error" in outcome) debug(outcome.error);
  return 0;
}
