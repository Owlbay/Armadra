import type { Readable, Writable } from "node:stream";

import { CdpRefusal, DRIVE_CODES } from "../cdp/codes";

/**
 * The minimal CDP client: JSON documents, NUL-separated, over a pair of pipes.
 *
 * Chromium is started with `--remote-debugging-pipe`, so the protocol runs on
 * file descriptors 3 and 4 of the child and **no port is ever opened**. That is
 * the whole reason to prefer the pipe: a debugging port on loopback is an
 * unauthenticated door into a browser holding somebody's logged-in sessions,
 * and anything else on the machine can walk through it. Descriptors belong to
 * this process and to its child, and to nothing else.
 *
 * Sessions are flat (`Target.attachToTarget { flatten: true }`): one pipe
 * carries every target, and each message names its session. A connection per
 * target would be a second transport to keep alive, and Chromium has not
 * needed one since flat mode.
 */

/** A message off the wire: a reply, or an event. */
interface Incoming {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export type CdpEventHandler = (
  method: string,
  params: unknown,
  sessionId: string,
) => void;

/** Longest one CDP command may take. A page that has not answered in this
 * long is a page a verb has lost, and every verb above has its own bound. */
export const CALL_TIMEOUT_MS = 30_000;

interface Waiter {
  settle: (value: unknown) => void;
  fail: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  sessionId: string;
  sentAt: number;
}

/**
 * Turns on the wire trace below. Off by default; the live tests set it so a
 * stall on a CI runner leaves something to read.
 */
export const CDP_TRACE_ENV = "ARMADRA_CDP_TRACE";
/** How many wire entries the trace keeps. */
export const CDP_TRACE_LENGTH = 300;

/**
 * One line of the wire trace: direction, id, method, session — and nothing
 * else. Params and results carry page text, URLs and typed values, none of
 * which belongs in a diagnostic.
 */
export interface CdpTraceEntry {
  readonly at: number;
  /** `>` sent, `<` answered, `!` refused by the browser, `~` event, `x` timed out. */
  readonly kind: ">" | "<" | "!" | "~" | "x";
  readonly id?: number;
  readonly method: string;
  readonly sessionId: string;
  /**
   * For `Target.attachedToTarget` / `detachedFromTarget` only: the child
   * session and (on attach) its target type, so a stalled command on a child
   * session can be traced to what it was. Never a URL.
   */
  readonly child?: string;
}

/** A command still waiting for its answer. */
export interface CdpPending {
  readonly id: number;
  readonly method: string;
  readonly sessionId: string;
  readonly ageMs: number;
}

export class CdpConnection {
  private readonly write: Writable;
  private readonly waiters = new Map<number, Waiter>();
  private readonly handlers: CdpEventHandler[] = [];
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private closeReason = "the browser went away";
  private readonly trace: CdpTraceEntry[] | undefined;

  constructor(
    write: Writable,
    read: Readable,
    options: { trace?: boolean } = {},
  ) {
    this.write = write;
    this.trace =
      (options.trace ?? process.env[CDP_TRACE_ENV] === "1") ? [] : undefined;
    read.on("data", (chunk: Buffer | string) => {
      this.receive(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    read.on("close", () => this.fail());
    read.on("error", () => this.fail());
    write.on("error", () => this.fail());
  }

  isOpen(): boolean {
    return !this.closed;
  }

  on(handler: CdpEventHandler): void {
    this.handlers.push(handler);
  }

  /** Commands sent and not yet answered, oldest first. */
  pending(): CdpPending[] {
    const now = Date.now();
    return [...this.waiters.entries()].map(([id, waiter]) => ({
      id,
      method: waiter.method,
      sessionId: waiter.sessionId,
      ageMs: now - waiter.sentAt,
    }));
  }

  /** The wire trace, oldest first; empty unless tracing is on. */
  traced(): CdpTraceEntry[] {
    return [...(this.trace ?? [])];
  }

  private note(entry: Omit<CdpTraceEntry, "at">): void {
    if (this.trace === undefined) return;
    this.trace.push({ at: Date.now(), ...entry });
    if (this.trace.length > CDP_TRACE_LENGTH) this.trace.shift();
  }

  /**
   * Sends one command. `sessionId` names the target; omitted, it is a
   * browser-level command (`Target.*`, `Browser.*`).
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      throw new CdpRefusal(DRIVE_CODES.unavailable, this.closeReason);
    }
    const id = this.nextId;
    this.nextId += 1;
    const envelope: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) envelope.sessionId = sessionId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        this.note({ kind: "x", id, method, sessionId: sessionId ?? "" });
        reject(
          new CdpRefusal(
            DRIVE_CODES.timeout,
            `${method} did not answer in time`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, {
        settle: resolve,
        fail: reject,
        timer,
        method,
        sessionId: sessionId ?? "",
        sentAt: Date.now(),
      });
      this.note({ kind: ">", id, method, sessionId: sessionId ?? "" });
      try {
        this.write.write(`${JSON.stringify(envelope)}\0`);
      } catch (error) {
        this.waiters.delete(id);
        clearTimeout(timer);
        reject(
          new CdpRefusal(
            DRIVE_CODES.unavailable,
            error instanceof Error ? error.message : this.closeReason,
          ),
        );
      }
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\0");
    while (index >= 0) {
      const document = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (document.length > 0) this.dispatch(document);
      index = this.buffer.indexOf("\0");
    }
  }

  private dispatch(document: string): void {
    let message: Incoming;
    try {
      message = JSON.parse(document) as Incoming;
    } catch {
      // A frame this process cannot parse is not a frame it can act on, and
      // there is nobody to complain to: the peer is Chromium.
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.waiters.get(message.id);
      if (waiter === undefined) return;
      this.waiters.delete(message.id);
      clearTimeout(waiter.timer);
      this.note({
        kind: message.error ? "!" : "<",
        id: message.id,
        method: waiter.method,
        sessionId: waiter.sessionId,
      });
      if (message.error) {
        // Chromium's own refusal, carried as one of ours. `browser_failed`
        // rather than `browser_refused`: the allowlist already ran, so this is
        // the page or the browser saying no, not a policy.
        waiter.fail(
          new CdpRefusal(
            DRIVE_CODES.failed,
            `${waiter.method}: ${message.error.message ?? "the browser refused"}`,
          ),
        );
        return;
      }
      waiter.settle(message.result ?? null);
      return;
    }
    // Events stop at close. Chromium keeps writing until the pipe drains — a
    // screencast frame can still be in the buffer after the node stopped — and
    // a handler that answers it would be talking to a browser that is gone.
    if (typeof message.method === "string")
      this.note({
        kind: "~",
        method: message.method,
        sessionId: message.sessionId ?? "",
        ...childOf(message.method, message.params),
      });
    if (typeof message.method === "string" && !this.closed) {
      for (const handler of this.handlers) {
        // This runs inside the pipe's `data` listener: a handler that threw
        // would escape as an uncaught exception and take the whole core down,
        // not just this node. One bad event is dropped instead.
        try {
          handler(message.method, message.params, message.sessionId ?? "");
        } catch {
          // Nothing to tell: the event was the browser's, not a caller's.
        }
      }
    }
  }

  /** Everything in flight becomes a named absence rather than a hang. */
  private fail(reason = this.closeReason): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const waiting = [...this.waiters.values()];
    this.waiters.clear();
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.fail(new CdpRefusal(DRIVE_CODES.unavailable, reason));
    }
  }

  close(reason = "the browser was closed"): void {
    this.fail(reason);
    try {
      this.write.end();
    } catch {
      // Already gone.
    }
  }
}

/** The child a target event names, for the trace: session id and type only. */
function childOf(method: string, params: unknown): { child?: string } {
  if (
    method !== "Target.attachedToTarget" &&
    method !== "Target.detachedFromTarget"
  )
    return {};
  const event = params as {
    sessionId?: unknown;
    targetInfo?: { type?: unknown };
  } | null;
  const session = typeof event?.sessionId === "string" ? event.sessionId : "";
  const type =
    typeof event?.targetInfo?.type === "string"
      ? `:${event.targetInfo.type}`
      : "";
  return { child: `${session}${type}` };
}
