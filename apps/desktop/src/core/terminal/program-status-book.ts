import type { BackendKind, SessionKey, TerminalBackend } from "./backend";
import type { TerminalManagerOptions } from "./manager-types";
import {
  OscScanner,
  ProgramStatusTracker,
  QUERY_REPLY,
  applyScanEvent,
  type ProgramKind,
  type ProgramState,
  type ProgramSummary,
} from "./program-status";

/**
 * 每个终端会话一份程序状态（契约 §53），喂字节、回应查询、节流广播。
 *
 * 只在内存里：重启之后程序要自己再报一次，这和规范「记录属于终端」一致——
 * 一个新的 core 就是一个新的终端。
 */

/** `terminal.program` 帧与会话列表里的 `programStatus`。 */
export interface ProgramStatusWire {
  readonly state: ProgramState;
  readonly kind?: ProgramKind;
  readonly progress?: number;
  readonly app?: string;
  readonly source: ProgramSummary["source"];
  readonly updatedAt: string;
}

/** 两帧之间的最小间隔：进度条每秒刷几十次也只出这么多帧。 */
export const PROGRAM_EMIT_INTERVAL_MS = 250;
/** 两次查询回应之间的最小间隔：防止回应与程序互相触发。 */
export const PROGRAM_ANSWER_INTERVAL_MS = 250;

interface Entry {
  generation: number;
  readonly scanner: OscScanner;
  readonly tracker: ProgramStatusTracker;
  /** 上一次发出去的摘要（不含时间戳），用来判断有没有变。 */
  sent: string;
  wire: ProgramStatusWire | undefined;
  lastEmitAt: number;
  lastAnswerAt: number;
  timer: NodeJS.Timeout | undefined;
}

export interface ProgramStatusBookOptions {
  /** 摘要变了；`undefined` 表示这个终端不再有任何记录。 */
  readonly emit: (
    sessionId: string,
    status: ProgramStatusWire | undefined,
  ) => void;
  /** 程序发了 `OSC 7501 ; ?`，该往它的输入里写回应了。 */
  readonly answer: (sessionId: string) => void;
  readonly clock?: () => number;
  readonly now?: () => string;
}

export class ProgramStatusBook {
  private readonly entries = new Map<string, Entry>();
  private readonly options: ProgramStatusBookOptions;
  private readonly clock: () => number;
  private readonly now: () => string;

  constructor(options: ProgramStatusBookOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => Date.now());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 一段程序输出。`generation` 变了说明是同一个会话的新一代进程，记录重来。 */
  feed(sessionId: string, generation: number, chunk: Uint8Array): void {
    let entry = this.entries.get(sessionId);
    if (entry !== undefined && entry.generation !== generation) {
      this.forget(sessionId);
      entry = undefined;
    }
    // 绝大多数输出里一个 ESC 都没有：不为它建表。
    if (entry === undefined && chunk.indexOf(0x1b) === -1) return;
    if (entry === undefined) {
      entry = {
        generation,
        scanner: new OscScanner(),
        tracker: new ProgramStatusTracker(),
        sent: "",
        wire: undefined,
        lastEmitAt: 0,
        lastAnswerAt: Number.NEGATIVE_INFINITY,
        timer: undefined,
      };
      this.entries.set(sessionId, entry);
    }
    const events = entry.scanner.feed(chunk);
    if (events.length === 0) return;
    for (const event of events) {
      if (applyScanEvent(entry.tracker, event) !== "query") continue;
      const now = this.clock();
      if (now - entry.lastAnswerAt < PROGRAM_ANSWER_INTERVAL_MS) continue;
      entry.lastAnswerAt = now;
      this.options.answer(sessionId);
    }
    this.changed(sessionId, entry);
  }

  /** 进程退出：`working` / `blocked` / `idle` 作废，立刻发出去，然后忘掉。 */
  exited(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    entry.tracker.processExited();
    this.flush(sessionId, entry);
    this.forget(sessionId);
  }

  /** 会话没了（或换了一代）。不发帧：`terminal.exit` 已经告诉了页面。 */
  forget(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    this.entries.delete(sessionId);
  }

  status(sessionId: string): ProgramStatusWire | undefined {
    return this.entries.get(sessionId)?.wire;
  }

  dispose(): void {
    for (const sessionId of [...this.entries.keys()]) this.forget(sessionId);
  }

  /**
   * 节流：距上一帧够久就立刻发（状态变化不被拖慢），否则排一个尾帧，
   * 尾帧发的是那一刻最新的摘要。
   */
  private changed(sessionId: string, entry: Entry): void {
    if (key(entry.tracker.summary()) === entry.sent) {
      return;
    }
    if (entry.timer !== undefined) return;
    const wait = PROGRAM_EMIT_INTERVAL_MS - (this.clock() - entry.lastEmitAt);
    if (wait <= 0) {
      this.flush(sessionId, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(sessionId) === entry) this.flush(sessionId, entry);
    }, wait);
    entry.timer.unref?.();
  }

  private flush(sessionId: string, entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const summary = entry.tracker.summary();
    const next = key(summary);
    if (next === entry.sent) return;
    entry.sent = next;
    entry.lastEmitAt = this.clock();
    entry.wire =
      summary === undefined ? undefined : { ...summary, updatedAt: this.now() };
    this.options.emit(sessionId, entry.wire);
  }
}

function key(summary: ProgramSummary | undefined): string {
  return summary === undefined ? "" : JSON.stringify(summary);
}

/** 管理器里一个会话记录，接线只读这几样。 */
export interface ProgramSessionView {
  readonly workspaceId: string;
  readonly ownerNodeId: string | null;
  readonly kind: BackendKind;
  readonly key: SessionKey;
  readonly generation: number;
  readonly exited: boolean;
}

/**
 * 把每个后端的 `programTap` 接到一本账上（契约 §53）：字节按会话、按代喂进去，
 * 查询的回应经同一个后端写回，摘要变了交给 `onProgramStatus`。
 */
export function connectProgramStatus(options: {
  readonly backends: ReadonlyMap<BackendKind, TerminalBackend>;
  readonly record: (sessionId: string) => ProgramSessionView | undefined;
  readonly sessionOf: (key: SessionKey) => string | undefined;
  readonly clock: () => number;
  readonly now: () => string;
  readonly onProgramStatus?: TerminalManagerOptions["onProgramStatus"];
}): ProgramStatusBook {
  const book = new ProgramStatusBook({
    clock: options.clock,
    now: options.now,
    emit: (sessionId, status) => {
      const record = options.record(sessionId);
      if (record === undefined) return;
      options.onProgramStatus?.({
        workspaceId: record.workspaceId,
        sessionId,
        nodeId: record.ownerNodeId,
        status,
      });
    },
    answer: (sessionId) => {
      const record = options.record(sessionId);
      if (record === undefined || record.exited) return;
      void options.backends
        .get(record.kind)
        ?.programTap?.answer(record.key, Buffer.from(QUERY_REPLY, "utf8"))
        .catch(() => undefined);
    },
  });
  for (const backend of options.backends.values()) {
    backend.programTap?.subscribe((key, generation, chunk) => {
      const sessionId = options.sessionOf(key);
      const record =
        sessionId === undefined ? undefined : options.record(sessionId);
      if (
        sessionId === undefined ||
        record === undefined ||
        record.exited ||
        record.generation !== generation
      )
        return;
      book.feed(sessionId, generation, chunk);
    });
  }
  return book;
}
