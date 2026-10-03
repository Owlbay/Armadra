/**
 * Armadra's host adapter for `ama` — the module the profile's `host` names,
 * built to `out/agent-host/ama-armadra.cjs` (docs/design/coordinator-agent.md
 * §3, completion-architecture §5.2).
 *
 * Outside a canvas node (`ARMADRA_NODE_ID` unset) `create` returns
 * `undefined` and ama runs as a plain standalone agent: the same profile, no
 * canvas tools, no reports. Inside one it registers the canvas, context and
 * browser verbs as tools, adds the tool note and the trust rule to the system
 * prompt, and reports every status event to `/hook/ama`.
 *
 * It also provides `HostApi.runners` — `task(agent=<cli>)` becomes a node on
 * the board, followed with the `wait` verb (`runners.ts`, contract §15.5) —
 * and, when the core set `ARMADRA_PERM_WAIT_SECS`, an approval broker that
 * lets a person answer ama's permission requests on the canvas
 * (`approvals.ts`). Neither ever answers an approval itself.
 */

// Types only: the bundle carries none of ama's code, and ama refuses a
// mismatched `hostApi` itself (`host-api.test.ts` pins the number).
import type {
  HOST_API_VERSION,
  HostAdapter,
  HostApi,
} from "@armadra/agent/host";
import { installBroker } from "./approvals.js";
import { subscribeEvents } from "./events.js";
import { addInstructions } from "./instructions.js";
import { provideRunners } from "./runners.js";
import { registerTools } from "./tools.js";

/** The adapter's id in ama's status line and logs. */
export const ADAPTER_ID = "armadra";

/** The host API this adapter is written against; ama refuses any other. */
export const hostApi = 1 as const satisfies typeof HOST_API_VERSION;

export function create(api: HostApi): HostAdapter | undefined {
  const nodeId = api.env.ARMADRA_NODE_ID;
  if (typeof nodeId !== "string" || nodeId.trim() === "") return undefined;
  registerTools(api);
  addInstructions(api);
  const unsubscribe = subscribeEvents(api);
  unsubscribe.push(provideRunners(api));
  installBroker(api);
  return {
    id: ADAPTER_ID,
    dispose() {
      for (const off of unsubscribe.splice(0)) {
        try {
          off();
        } catch {
          // Already gone.
        }
      }
    },
  };
}

export default { hostApi, create };
