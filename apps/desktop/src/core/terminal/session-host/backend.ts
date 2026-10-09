import { StringDecoder } from "node:string_decoder";
import {
  type AdoptableBackend,
  type Attachment,
  type BackendCapabilities,
  type BackendKind,
  type BackendNotice,
  type BackendRef,
  type ForegroundInfo,
  type ProgramTap,
  PASTE_END,
  PASTE_START,
  REPLAY_CHUNKS,
  type SessionKey,
  type TerminalHandle,
  type TerminalSize,
  type TerminalSpec,
  type TerminateMode,
  TerminalError,
  conflict,
  internal,
  notFound,
  sanitizePaste,
  sessionKey as asSessionKey,
  tailLines,
  trimCaptured,
} from "../backend";
import {
  type ClientMessage,
  type HostErrorCode,
  type HostMessage,
  type SessionSummary,
  RequestIds,
  START_TIMEOUT_MS,
  clampSize,
  createMessage,
  hostReference,
  keyOfReference,
  resizeMessage,
} from "./protocol";
import {
  type EventSink,
  type LinkEvent,
  Link,
  endpointFor,
  hostLaunch,
  startHost,
  waitForHost,
} from "./link";
import { type HelloAuth, ensureKey, signHello } from "./auth";
import { ReplayScreen } from "../replay-screen";
import { type EnvPairs, childEnvironment } from "../environment";

/**
 * The Windows backend: terminals owned by `armadra-session-host`.
 *
 * What makes this different from `DirectBackend` is a process boundary. The
 * pseudo console belongs to the session host, not to the core, so:
 *
 *   * `create` is a request, not a spawn. Two cores racing to start a host
 *     end up with one, because only one can own the first pipe instance.
 *   * `attach` opens **its own** pipe connection, so a slow socket cannot
 *     delay a control request — and closing that connection is a detach and
 *     never an end.
 *   * `detachAll` closes connections and leaves the host alone. Core shutdown
 *     must not take a user's agents with it; that is the whole point.
 *
 * ## Which host is on the other end
 *
 * 两端都是 TypeScript。host 是 `apps/desktop/src/session-host/` 里那个守护进程，
 * 打包成 `out/session-host/host.cjs`，由这个进程自己的可执行文件带
 * `ELECTRON_RUN_AS_NODE=1` 起来。
 *
 * Two facts are written down rather than discovered:
 *
 *   * **No machine in this project's CI is a Windows developer machine.** The
 *     protocol, the pipe name, the replay trimming, the generation fence and
 *     the handshake are pure functions and are tested exactly; create /
 *     attach / detach / re-attach / restart against a real ConPTY runs only
 *     in the Windows CI job (`session-host/windows.integration.test.ts`).
 *   * **The peer is authenticated, not identified.** `node:net` exposes
 *     neither the pipe's security descriptor nor the peer's SID, so the DACL
 *     and the per-connection SID check of the Rust host are replaced by a
 *     one-time HMAC over a `0600` key file. `auth.ts` states the residual
 *     risk in full.
 */

/** Everything this core remembers about one host session. */
interface Remembered {
  generation: number;
  pid: number | undefined;
  /**
   * The bytes this core has seen since the last replay: the escaped form of
   * `capture`, which is the replay itself.
   */
  replay: Buffer[];
  /**
   * The same bytes laid out on a screen of the session's size
   * (`replay-screen.ts`): what the plain `capture` reads. The host keeps
   * bytes, not a screen, so a full-screen CLI that draws with cursor moves
   * would otherwise read as one run-on line or a tail of redraw fragments —
   * the approximation `DirectBackend` already makes, now made here too.
   */
  screen: ReplayScreen;
  /** UTF-8 that a chunk boundary split stays here until the next chunk. */
  decoder: StringDecoder;
  size: TerminalSize;
  /**
   * The attachments that may feed {@link screen}, newest last; only the
   * newest does. Every attachment of a session receives the same live output,
   * so feeding the screen from all of them would draw each byte twice. The
   * newest one started from the host's full replay; when it goes, the next
   * one takes over without a gap, having seen the same frames.
   */
  feeders: object[];
}

/** The size a session is assumed to have until an attach or resize says. */
const ASSUMED_SIZE: TerminalSize = { cols: 80, rows: 24 };

function remember(
  generation: number,
  pid: number | undefined,
  size: TerminalSize,
): Remembered {
  return {
    generation,
    pid,
    replay: [],
    screen: new ReplayScreen(size.cols, size.rows),
    decoder: new StringDecoder("utf8"),
    size,
    feeders: [],
  };
}

export interface SessionHostBackendOptions {
  readonly dataDir: string;
  readonly version: string;
  /** Injected by the tests; production derives it from the user's SID. */
  readonly endpoint?: string | undefined;
}

export class SessionHostBackend implements AdoptableBackend {
  readonly kind: BackendKind = "sessionHost";
  private readonly sessions = new Map<SessionKey, Remembered>();
  private readonly sinks: ((notice: BackendNotice) => void)[] = [];
  private readonly programListeners: ((
    key: SessionKey,
    generation: number,
    chunk: Buffer,
  ) => void)[] = [];

  /**
   * Live output of the attachment that feeds the screen (contract §53). The
   * pseudo console belongs to the host, so a session nobody has attached is
   * not seen here; a replay is never delivered.
   */
  readonly programTap: ProgramTap = {
    subscribe: (listener) => {
      this.programListeners.push(listener);
    },
    answer: (key, bytes) => this.input(key, bytes),
  };
  private readonly ids = new RequestIds();
  /** One pipe connection per attachment; closing it is the detach. */
  private readonly attachments = new Map<number, Link>();
  /**
   * Per attachment: what a deliberate detach does before it closes the
   * connection — stop feeding the screen, and end the stream **silently**.
   * Closing the link raises `closed`, and an unsilenced `end` would tell the
   * socket layer the session exited: the row was marked `exited` the moment
   * the page let go of a terminal (G3-2 acceptance run).
   */
  private readonly releases = new Map<number, () => void>();
  private readonly options: SessionHostBackendOptions;
  /** The one long-lived connection every control request goes through. */
  private control: Link | undefined;
  private connecting: Promise<Link> | undefined;
  /**
   * Identifies the host process this core is talking to. A change means the
   * host restarted and the sessions it held are gone — a fact worth reporting,
   * not one to infer from an empty list.
   */
  private instance: string | undefined;

  constructor(options: SessionHostBackendOptions) {
    this.options = options;
  }

  getCapabilities(): BackendCapabilities {
    const windows = process.platform === "win32";
    return {
      kind: "sessionHost",
      persistent: true,
      // The host sends its own replay down the attach connection, as ordinary
      // output frames, so this side owes the socket no `snapshot` of its own.
      // The bytes this backend keeps are for `capture`, not for redrawing.
      redrawsOnAttach: true,
      usable: windows,
      ...(windows ? {} : { reason: "会话宿主只在 Windows 上存在" }),
    };
  }

  notices(listener: (notice: BackendNotice) => void): void {
    this.sinks.push(listener);
  }

  private announce(notice: BackendNotice): void {
    for (const sink of this.sinks) sink(notice);
  }

  /**
   * Reaches the host, starting it if needed, so a failure is reported before
   * the first terminal rather than inside it.
   */
  async probe(): Promise<void> {
    await this.link();
  }

  /* -------------------------------- transport ----------------------------- */

  private endpoint(): string {
    return this.options.endpoint ?? endpointFor(this.options.dataDir);
  }

  /**
   * The proof this core presents with every `hello`.
   *
   * A **fresh** proof per connection, never a cached one: the nonce is
   * single-use and the host refuses a repeat, so a cached proof would work
   * exactly once and then look like an authentication failure.
   */
  private proof(): HelloAuth {
    return signHello(ensureKey(this.options.dataDir), this.endpoint());
  }

  /**
   * The control connection, opened or reopened as needed.
   *
   * Reconnecting is normal — the host may have been upgraded, or this core may
   * have been asleep. What must not happen is silently moving to a *different*
   * host instance, so the instance id is compared and a change clears what
   * this core thought it knew.
   */
  private async link(): Promise<Link> {
    const held = this.control;
    if (held !== undefined && held.alive) return held;
    // One connect at a time: two terminals created in the same tick would
    // otherwise each start a host.
    this.connecting ??= this.openControl().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openControl(): Promise<Link> {
    const endpoint = this.endpoint();
    const sink = this.controlSink();
    let link: Link;
    try {
      link = await Link.connect(endpoint, sink);
    } catch (first) {
      startHost(hostLaunch(this.options.dataDir));
      try {
        link = await waitForHost(endpoint, sink, START_TIMEOUT_MS);
      } catch {
        throw internal(
          `会话宿主没有起来（${first instanceof Error ? first.message : String(first)}）；终端将无法在重启后存活`,
        );
      }
    }
    const greeting = await link.handshake(
      `armadra-core/${this.options.version}`,
      this.proof(),
    );
    if (this.instance !== undefined && this.instance !== greeting.instanceId) {
      // The host restarted: everything this core remembered about its sessions
      // describes consoles that no longer exist.
      for (const [key, remembered] of this.sessions) {
        this.announce({
          type: "exited",
          key,
          generation: remembered.generation,
        });
      }
      this.sessions.clear();
    }
    this.instance = greeting.instanceId;
    this.control = link;
    return link;
  }

  /** Turns control-connection events into the notices the manager understands. */
  private controlSink(): EventSink {
    return (event: LinkEvent) => {
      if (event.type !== "exit") return;
      this.announce({
        type: "exited",
        key: asSessionKey(event.sessionKey),
        generation: event.generation,
        ...(event.exitCode === null ? {} : { exitCode: event.exitCode }),
      });
    };
  }

  /** Sends one control request and waits for its answer. */
  private async request(
    build: (id: number) => ClientMessage,
  ): Promise<HostMessage> {
    const id = this.ids.issue();
    const message = build(id);
    // One reconnect, then give up: retrying forever would hide a host that is
    // refusing rather than absent.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const link = await this.link();
      try {
        return await link.request(id, message);
      } catch (error) {
        if (attempt === 1) {
          throw internal(
            error instanceof Error ? error.message : String(error),
          );
        }
        this.control = undefined;
      }
    }
    throw internal("会话宿主不再应答");
  }

  /** A request whose only interesting outcome is success or the refusal. */
  private async call(
    build: (id: number) => ClientMessage,
  ): Promise<SessionSummary | undefined> {
    const answer = await this.request(build);
    if (answer.type === "ok") return answer.session;
    if (answer.type === "error") throw hostError(answer.code, answer.message);
    throw internal(`会话宿主给了意料之外的回复：${answer.type}`);
  }

  private remembered(key: SessionKey): Remembered {
    const session = this.sessions.get(key);
    if (session === undefined) {
      throw notFound("Terminal session is not running");
    }
    return session;
  }

  /* -------------------------------- lifecycle ----------------------------- */

  async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const summary = await this.call((id) =>
      createMessage(id, {
        sessionKey: spec.sessionKey,
        generation: spec.generation,
        workspaceId: spec.workspaceId,
        cwd: spec.cwd,
        shell: spec.shell,
        command: spec.command ?? null,
        args: spec.args,
        // Built here, as the direct and tmux backends build theirs: the host
        // starts the console with exactly this block and inherits nothing, so
        // without the base a Windows shell had no `SystemRoot` (PowerShell 5.1
        // would not start) and no `TEMP`. The caller's variables last.
        env: sessionHostEnvironment(spec.env),
        size: spec.size,
      }),
    );
    if (summary === undefined) throw internal("会话宿主什么都没创建");
    const pid = summary.pid ?? undefined;
    this.sessions.set(
      spec.sessionKey,
      remember(spec.generation, pid, spec.size),
    );
    return {
      sessionKey: spec.sessionKey,
      generation: spec.generation,
      // The host addresses sessions by key; the generation makes the reference
      // unique across a recycle, as the tmux name does.
      backendRef: hostReference(summary.sessionKey, summary.generation),
      ...(pid === undefined ? {} : { pid }),
    };
  }

  /**
   * Takes a session the host still holds back under management after a core
   * restart, and reports the pid behind it. The console was never this
   * process', so coming back is bookkeeping and the CLI sees nothing at all.
   */
  async adopt(
    key: SessionKey,
    _reference: string,
    generation: number,
  ): Promise<number | undefined> {
    let pid: number | undefined;
    try {
      const answer = await this.request((id) => ({ type: "list", id }));
      if (answer.type === "ok") {
        pid =
          answer.sessions?.find(
            (summary) =>
              summary.sessionKey === key && summary.generation === generation,
          )?.pid ?? undefined;
      }
    } catch {
      // The host is unreachable. The row stays as it is — see `reconcile`,
      // which does not call this at all unless the probe succeeded.
    }
    this.sessions.set(key, remember(generation, pid, ASSUMED_SIZE));
    return pid;
  }

  async attach(
    key: SessionKey,
    generation: number,
    size: TerminalSize,
  ): Promise<Attachment> {
    const remembered = this.remembered(key);
    if (remembered.generation !== generation) {
      throw conflict(
        `Terminal generation ${generation} is stale; the session is at ${remembered.generation}`,
      );
    }

    const dataListeners: ((chunk: Buffer) => void)[] = [];
    const exitListeners: ((exitCode: number | undefined) => void)[] = [];
    const buffered: Buffer[] = [];
    let subscribed = false;
    let ended = false;
    /** Set once the first frame of this attach's replay (or output) arrived. */
    let replayed = false;
    const feeder = {};

    // The replay arrives at the size this attach asks for.
    remembered.size = clampSize(size);
    const stopFeeding = (): void => {
      remembered.feeders = remembered.feeders.filter(
        (other) => other !== feeder,
      );
    };
    /**
     * The first frame of an attach — normally its replay, which the host
     * sends as one or more snapshot frames — is the session's past being
     * redrawn: this attachment starts the screen over and feeds it from now
     * on. Live output appends.
     */
    const takeOver = (): void => {
      if (replayed) return;
      replayed = true;
      remembered.feeders = [
        ...remembered.feeders.filter((other) => other !== feeder),
        feeder,
      ];
      remembered.replay.length = 0;
      remembered.screen = new ReplayScreen(
        remembered.size.cols,
        remembered.size.rows,
      );
      remembered.decoder = new StringDecoder("utf8");
    };
    const deliver = (payload: Buffer, live = false): void => {
      if (remembered.feeders.at(-1) === feeder) {
        if (live) {
          for (const listener of this.programListeners)
            listener(key, generation, payload);
        }
        remembered.replay.push(payload);
        while (remembered.replay.length > REPLAY_CHUNKS)
          remembered.replay.shift();
        remembered.screen.write(remembered.decoder.write(payload));
      }
      if (!subscribed) {
        buffered.push(payload);
        return;
      }
      for (const listener of dataListeners) listener(payload);
    };
    /**
     * A gap or a stale generation must resolve into a fresh attach with a
     * fresh replay, never into misaligned bytes on screen. Ending the stream
     * is how the socket layer is told to clear and reconnect — the same path
     * tmux and direct already use.
     */
    const end = (exitCode: number | undefined): void => {
      if (ended) return;
      ended = true;
      stopFeeding();
      for (const listener of exitListeners) listener(exitCode);
    };

    // Its own connection, so a slow socket delays only itself. It never starts
    // a host: if the host is gone the session is gone, and a fresh empty host
    // would look like the session had merely ended.
    let link: Link;
    try {
      link = await Link.connect(this.endpoint(), (event) => {
        switch (event.type) {
          case "snapshot":
            // A long replay comes as several snapshot frames: only the first
            // one starts the screen over.
            takeOver();
            deliver(event.payload);
            return;
          case "snapshotEnd":
            takeOver();
            return;
          case "output":
            takeOver();
            deliver(event.payload, true);
            return;
          case "exit":
            end(event.exitCode ?? undefined);
            return;
          case "gap":
          case "stale":
          case "closed":
            end(undefined);
        }
      });
    } catch (error) {
      throw notFound(
        `会话宿主没有在运行：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await link.handshake(
      `armadra-core-attach/${this.options.version}`,
      this.proof(),
    );
    // Registered before the request goes out, so no frame can arrive unchecked.
    link.expectOutput(generation);

    const id = this.ids.issue();
    const answer = await link.request(id, {
      type: "attach",
      id,
      sessionKey: key,
      generation,
      size: clampSize(size),
    });
    if (answer.type === "error") {
      stopFeeding();
      link.close();
      throw hostError(answer.code, answer.message);
    }
    this.attachments.set(id, link);
    this.releases.set(id, () => {
      ended = true;
      stopFeeding();
    });

    return {
      attachmentId: id,
      generation,
      onData: (listener) => {
        dataListeners.push(listener);
        if (subscribed) return;
        subscribed = true;
        for (const chunk of buffered.splice(0)) listener(chunk);
      },
      onExit: (listener) => exitListeners.push(listener),
      // One host connection per attachment: not reading it is the pause.
      pause: () => link.pause(),
      resume: () => link.resume(),
    };
  }

  async detach(_key: SessionKey, attachmentId: number): Promise<void> {
    const link = this.attachments.get(attachmentId);
    if (link === undefined) return;
    this.attachments.delete(attachmentId);
    this.releases.get(attachmentId)?.();
    this.releases.delete(attachmentId);
    // Closing the connection is the detach. The host keeps the session; only
    // `destroy` ends one.
    link.close();
  }

  /* ---------------------------------- io ---------------------------------- */

  async input(key: SessionKey, bytes: Buffer): Promise<void> {
    await this.call((id) => ({
      type: "write",
      id,
      sessionKey: key,
      data: bytes.toString("base64"),
    }));
  }

  /**
   * ConPTY has no paste buffer, so bracketed paste is written straight into
   * the console. A CLI that does not understand the brackets sees multi-line
   * text as separate lines — a real difference from tmux, and not one this
   * side can work around.
   */
  async paste(
    key: SessionKey,
    text: string,
    pressEnter: boolean,
  ): Promise<void> {
    const payload = `${PASTE_START}${sanitizePaste(text)}${PASTE_END}${pressEnter ? "\r" : ""}`;
    await this.input(key, Buffer.from(payload, "utf8"));
  }

  async resize(key: SessionKey, size: TerminalSize): Promise<void> {
    await this.call((id) => resizeMessage(id, key, size));
    const remembered = this.sessions.get(key);
    if (remembered !== undefined) {
      remembered.size = clampSize(size);
      remembered.screen.resize(remembered.size.cols, remembered.size.rows);
    }
  }

  /**
   * The host keeps bytes, not a screen. The plain capture reads the screen
   * this core lays them out on ({@link Remembered.screen}), the same way the
   * direct backend does; the escaped form is the replay itself.
   */
  async capture(
    key: SessionKey,
    lines: number,
    withEscapes: boolean,
  ): Promise<string> {
    const remembered = this.remembered(key);
    const text = withEscapes
      ? Buffer.concat(remembered.replay).toString("utf8").replaceAll("\r", "")
      : remembered.screen.text();
    return tailLines(trimCaptured(text), lines);
  }

  async signal(key: SessionKey, _signal: "interrupt"): Promise<void> {
    await this.call((id) => ({ type: "interrupt", id, sessionKey: key }));
  }

  /**
   * The host reports the session's own pid. Walking the tree needs a process
   * snapshot this core does not take on Windows, so the children are honestly
   * empty rather than guessed at.
   */
  async getForeground(key: SessionKey): Promise<ForegroundInfo> {
    const remembered = this.remembered(key);
    return {
      ...(remembered.pid === undefined ? {} : { pid: remembered.pid }),
      children: [],
    };
  }

  async terminate(key: SessionKey, mode: TerminateMode): Promise<void> {
    if (mode === "interrupt") {
      await this.signal(key, "interrupt");
      return;
    }
    await this.call((id) => ({ type: "kill", id, sessionKey: key }));
    if (mode !== "session") return;
    try {
      await this.call((id) => ({ type: "destroy", id, sessionKey: key }));
    } finally {
      this.sessions.delete(key);
    }
  }

  async list(): Promise<BackendRef[]> {
    const answer = await this.request((id) => ({ type: "list", id }));
    if (answer.type !== "ok" || answer.sessions === undefined) return [];
    return answer.sessions
      .filter((summary) => !summary.exited)
      .map((summary) => ({
        name: hostReference(summary.sessionKey, summary.generation),
        attached: summary.subscribers > 0,
      }));
  }

  async destroyByReference(reference: string): Promise<void> {
    await this.call((id) => ({
      type: "destroy",
      id,
      sessionKey: keyOfReference(reference),
    }));
  }

  /** The host owns the console's history; there is no second one to move. */
  async scroll(_key: SessionKey, _lines: number): Promise<void> {}

  /**
   * Back pressure this connection owns, which is the host's own name for the
   * same idea: a dormant session's subscriber stops asking for frames. It is
   * idempotent by connection and released unconditionally when the connection
   * goes away, so a core that crashes while paused cannot freeze the CLI.
   */
  async setDormant(key: SessionKey, dormant: boolean): Promise<void> {
    this.remembered(key);
    await this.call((id) => ({
      type: "flow",
      id,
      sessionKey: key,
      paused: dormant,
    }));
  }

  /**
   * Core shutdown. Connections go, sessions stay — the whole reason this
   * backend exists.
   */
  async detachAll(): Promise<void> {
    for (const release of this.releases.values()) release();
    this.releases.clear();
    for (const link of this.attachments.values()) link.close();
    this.attachments.clear();
    this.control?.close();
    this.control = undefined;
  }
}

/** The child environment every backend starts from, with the caller's pairs over it. */
export function sessionHostEnvironment(
  env: TerminalSpec["env"],
  base: EnvPairs = childEnvironment(),
): [string, string][] {
  const merged = new Map<string, [string, string]>();
  // Windows names are case-insensitive: one entry per name, the last spelling wins.
  const key = (name: string): string =>
    process.platform === "win32" ? name.toUpperCase() : name;
  for (const [name, value] of [...base, ...env])
    merged.set(key(name), [name, value]);
  return [...merged.values()];
}

function hostError(code: HostErrorCode, message: string): TerminalError {
  switch (code) {
    case "notFound":
      return notFound(message);
    case "stale":
    case "conflict":
    case "draining":
      return conflict(message);
    case "badRequest":
      return new TerminalError(400, "bad_request", message);
    default:
      return internal(message);
  }
}
