import { readKey, signHello } from "./auth";
import { Link, endpointFor } from "./link";

/**
 * Asks this user's session host of one data directory to leave if it holds no
 * live session (`shutdownIfIdle`).
 *
 * Two callers, both on the way out: the desktop shell after its core has
 * stopped (an orderly quit), and the installer's helper
 * (`session-host/shutdown-if-idle.ts`) before an uninstall or upgrade has to
 * replace the `Armadra.exe` the host runs on. Neither may be held up by it, so
 * every step is bounded and nothing here throws: a host that is absent,
 * unreachable or refusing is an outcome, not an error.
 *
 * A host that still owns a session answers `busy` and stays — this request
 * never ends a session. What happens to it then is the installer's own
 * "the app is running" handling, unchanged.
 */

export type ShutdownOutcome =
  /** Nothing to ask: no key file, or nothing listening on the pipe. */
  | { readonly kind: "absent"; readonly reason: string }
  /** The host owns a live session and stays. */
  | { readonly kind: "busy"; readonly pid: number }
  /** The host agreed and its process was seen to end within the wait. */
  | { readonly kind: "left"; readonly pid: number }
  /** The host agreed; its process was still there when the wait ran out. */
  | { readonly kind: "leaving"; readonly pid: number }
  /** Reached, but the conversation failed (timeout, refusal, old host). */
  | { readonly kind: "failed"; readonly reason: string };

export interface ShutdownRequest {
  readonly dataDir: string;
  /** What this caller calls itself in `hello`; shows up in the host's log. */
  readonly client: string;
  /** Derived from `dataDir` when absent (needs `whoami` on Windows). */
  readonly endpoint?: string;
  /** How long to wait for the host's process to end after it agreed. */
  readonly waitMs?: number;
  /** Bound on the whole conversation before the wait. */
  readonly timeoutMs?: number;
  /** Injected by the tests. */
  readonly isAlive?: (pid: number) => boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const POLL_MS = 100;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export async function requestShutdownIfIdle(
  request: ShutdownRequest,
): Promise<ShutdownOutcome> {
  let key: Buffer;
  try {
    // Read, never create: a missing key means no host was ever started for
    // this directory, and creating one here would leave a file behind for an
    // uninstall to trip over.
    key = readKey(request.dataDir);
  } catch (error) {
    return { kind: "absent", reason: message(error) };
  }
  let endpoint: string;
  try {
    endpoint = request.endpoint ?? endpointFor(request.dataDir);
  } catch (error) {
    return { kind: "failed", reason: message(error) };
  }
  let link: Link;
  try {
    link = await bounded(
      Link.connect(endpoint, () => {}),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "connect",
    );
  } catch (error) {
    return { kind: "absent", reason: message(error) };
  }
  let pid: number;
  let leaving: boolean;
  try {
    const answer = await bounded(
      (async () => {
        const greeting = await link.handshake(
          request.client,
          signHello(key, endpoint),
        );
        const reply = await link.request(1, { type: "shutdownIfIdle", id: 1 });
        return { greeting, reply };
      })(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "shutdownIfIdle",
    );
    if (answer.reply.type === "error") {
      return {
        kind: "failed",
        reason: `${answer.reply.code}: ${answer.reply.message}`,
      };
    }
    if (answer.reply.type !== "ok" || answer.reply.leaving === undefined) {
      // A host from before this request existed answers nothing useful.
      return { kind: "failed", reason: `unexpected ${answer.reply.type}` };
    }
    pid = answer.greeting.pid;
    leaving = answer.reply.leaving;
  } catch (error) {
    return { kind: "failed", reason: message(error) };
  } finally {
    link.close();
  }
  if (!leaving) return { kind: "busy", pid };
  const alive = request.isAlive ?? processAlive;
  const deadline = Date.now() + (request.waitMs ?? 0);
  for (;;) {
    if (!alive(pid)) return { kind: "left", pid };
    if (Date.now() >= deadline) return { kind: "leaving", pid };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
