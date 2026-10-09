/**
 * 终端程序自报的状态（契约 §53）：OSC 7501（Program Status Protocol，规范
 * 修订 0.3）、OSC 9;4 进度与 OSC 133;A 提示符。
 *
 * 这里只有纯函数与纯状态：一个跨分片的字节扫描器、一份报告解析器、一个按
 * 规范管记录的跟踪器。谁喂字节、谁回应查询、谁广播，由
 * `program-status-book.ts` 决定。
 *
 * 程序自报是**展示级提示**：pty 上的任何字节都能伪造它（`cat` 一个文件就
 * 够），所以它不写 `agent_status`，不满足任何空闲门或投递门；`msg` 与
 * `title` 只按规范校验、不保存也不外传——它们是终端输出的正文。
 */

/** 规范 §Limits：整条序列（含 `ESC ]` 与终止符）的上限。 */
export const MAX_SEQUENCE_BYTES = 4096;
/** 规范：每个终端的记录数上限。 */
export const MAX_RECORDS = 256;

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const BACKSLASH = 0x5c;

/** 我们关心的 OSC 正文前缀；其余的 OSC 只跳过，不攒字节。 */
const WANTED = ["7501;", "9;4", "133;"] as const;

export type ScanEvent =
  | { readonly type: "osc"; readonly body: string }
  | { readonly type: "reset" };

type Mode =
  | "ground"
  | "escape"
  | "osc"
  | "oscEscape"
  | "dcsHead"
  | "dcsSkip"
  | "dcsSkipEscape"
  | "passthrough"
  | "passthroughEscape";

/**
 * 输出流里的 OSC 扫描器。状态跨分片保留：一条序列可以在任何一个字节处被
 * 切开。只认 7 位的 `ESC ]`（UTF-8 流里 0x9D 是续字节，不是 C1 的 OSC）。
 *
 * - 终止符是 BEL 或 `ESC \`；中途来的别的 `ESC`、CAN、SUB 作废这一条。
 * - 超过 {@link MAX_SEQUENCE_BYTES} 的整条丢掉，一直跳到它的终止符。
 * - `ESC P tmux; … ESC \`（tmux 透传）解包后再扫一遍：内层的 `ESC ESC`
 *   是一个字面 `ESC`。
 * - `ESC c`（RIS）报一次 `reset`：规范要求全复位清掉所有记录。
 */
export class OscScanner {
  private mode: Mode = "ground";
  private body: number[] = [];
  /** 这一条已经确定不是我们要的（或超长），只等终止符。 */
  private skipping = false;
  private length = 0;
  private head: number[] = [];
  private inner: OscScanner | undefined;
  private readonly depth: number;

  constructor(depth = 0) {
    this.depth = depth;
  }

  feed(chunk: Uint8Array, out: ScanEvent[] = []): ScanEvent[] {
    let index = 0;
    const end = chunk.length;
    while (index < end) {
      if (this.mode === "ground") {
        const next = chunk.indexOf(ESC, index);
        if (next === -1) return out;
        index = next + 1;
        this.mode = "escape";
        continue;
      }
      const byte = chunk[index] as number;
      index += 1;
      this.step(byte, out);
    }
    return out;
  }

  private step(byte: number, out: ScanEvent[]): void {
    switch (this.mode) {
      case "escape":
        if (byte === 0x5d) {
          this.startOsc();
        } else if (byte === 0x50) {
          this.mode = "dcsHead";
          this.head = [];
        } else if (byte === 0x63) {
          out.push({ type: "reset" });
          this.mode = "ground";
        } else {
          this.mode = byte === ESC ? "escape" : "ground";
        }
        return;
      case "osc":
        if (byte === BEL) {
          this.finishOsc(out);
        } else if (byte === ESC) {
          this.mode = "oscEscape";
        } else if (byte === CAN || byte === SUB) {
          this.mode = "ground";
        } else {
          this.collect(byte);
        }
        return;
      case "oscEscape":
        if (byte === BACKSLASH) {
          this.finishOsc(out);
        } else {
          // 没终止就开了新序列：这一条作废，从这个 ESC 重新开始。
          this.mode = "escape";
          this.step(byte, out);
        }
        return;
      case "dcsHead":
        this.head.push(byte);
        if (byte === ESC) {
          this.mode = "dcsSkipEscape";
          return;
        }
        if (this.head.length === 5) {
          const tmux =
            this.depth === 0 && String.fromCharCode(...this.head) === "tmux;";
          if (tmux) {
            this.inner = new OscScanner(this.depth + 1);
            this.mode = "passthrough";
          } else {
            this.mode = "dcsSkip";
          }
        }
        return;
      case "dcsSkip":
        if (byte === ESC) this.mode = "dcsSkipEscape";
        else if (byte === CAN || byte === SUB) this.mode = "ground";
        return;
      case "dcsSkipEscape":
        if (byte === BACKSLASH) this.mode = "ground";
        else if (byte !== ESC) this.mode = "dcsSkip";
        return;
      case "passthrough":
        if (byte === ESC) this.mode = "passthroughEscape";
        else this.inner?.feed(Uint8Array.of(byte), out);
        return;
      case "passthroughEscape":
        if (byte === ESC) {
          this.inner?.feed(Uint8Array.of(ESC), out);
          this.mode = "passthrough";
        } else {
          // `ESC \` 结束透传；别的字节也按结束处理，不把半截内层带出去。
          this.inner = undefined;
          this.mode = "ground";
          if (byte !== BACKSLASH) {
            this.mode = "escape";
            this.step(byte, out);
          }
        }
        return;
      default:
        return;
    }
  }

  private startOsc(): void {
    this.mode = "osc";
    this.body = [];
    this.skipping = false;
    // `ESC ]` 两个字节先算进整条的长度。
    this.length = 2;
  }

  private collect(byte: number): void {
    this.length += 1;
    if (this.skipping) return;
    // 留出终止符的位置：`ESC \` 两个字节。
    if (this.length + 2 > MAX_SEQUENCE_BYTES) {
      this.skipping = true;
      this.body = [];
      return;
    }
    this.body.push(byte);
    if (this.body.length <= 5 && !wantedPrefix(this.body)) {
      this.skipping = true;
      this.body = [];
    }
  }

  private finishOsc(out: ScanEvent[]): void {
    this.mode = "ground";
    if (this.skipping) return;
    const body = String.fromCharCode(...this.body);
    this.body = [];
    if (WANTED.some((prefix) => body.startsWith(prefix))) {
      out.push({ type: "osc", body });
    }
  }
}

function wantedPrefix(bytes: readonly number[]): boolean {
  return WANTED.some((prefix) => {
    const n = Math.min(prefix.length, bytes.length);
    for (let i = 0; i < n; i += 1) {
      if (prefix.charCodeAt(i) !== bytes[i]) return false;
    }
    return true;
  });
}

/* ------------------------------- 报告解析 -------------------------------- */

export const PROGRAM_STATES = [
  "idle",
  "working",
  "blocked",
  "done",
  "error",
] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];
export const PROGRAM_KINDS = ["permission", "question", "auth"] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

export type ProgramReport =
  | {
      readonly type: "report";
      readonly id: string;
      readonly state: ProgramState;
      readonly kind?: ProgramKind;
      readonly progress?: number;
      readonly app?: string;
    }
  | { readonly type: "clear"; readonly id: string | undefined }
  | { readonly type: "query" };

const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * `OSC 7501 ; …` 的正文（不含 `7501;`）→ 一份报告；规范要求忽略的返回
 * `undefined`。规则逐条照规范修订 0.3：
 *
 * - 坏的键值对跳过，其余照常；未知键忽略；重复键后者为准。
 * - `state` 缺失或不认识：整条忽略，绝不退回 `idle`。
 * - `id` 不合法：整条忽略，不落到根记录上。
 * - `kind` / `progress` / `app` 不合法当作缺席。
 * - `msg` / `title` 超限、base64 解不开、解出控制字符：整条丢弃。
 */
export function parseProgramReport(rest: string): ProgramReport | undefined {
  if (rest.trim() === "?") return { type: "query" };
  const pairs = new Map<string, string>();
  for (const pair of rest.split(":")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (key.length > 16 || !KEY.test(key) || !VALUE.test(value)) continue;
    pairs.set(key, value);
  }

  const state = pairs.get("state");
  if (state === undefined) return undefined;
  if (
    state !== "clear" &&
    !(PROGRAM_STATES as readonly string[]).includes(state)
  )
    return undefined;

  const rawId = pairs.get("id");
  let id = "";
  if (rawId !== undefined) {
    if (!validId(rawId)) return undefined;
    id = rawId;
  }

  if (!textAllowed(pairs.get("msg"), 2732, 2048)) return undefined;
  if (!textAllowed(pairs.get("title"), 256, 192)) return undefined;

  if (state === "clear") {
    return { type: "clear", id: rawId === undefined ? undefined : id };
  }
  const typed = state as ProgramState;
  const kindValue = pairs.get("kind");
  const kind =
    typed === "blocked" &&
    kindValue !== undefined &&
    (PROGRAM_KINDS as readonly string[]).includes(kindValue)
      ? (kindValue as ProgramKind)
      : undefined;
  const progressValue = pairs.get("progress");
  const progress =
    (typed === "working" || typed === "blocked") &&
    progressValue !== undefined &&
    /^[0-9]{1,3}$/.test(progressValue) &&
    Number(progressValue) <= 100
      ? Number(progressValue)
      : undefined;
  const appValue = pairs.get("app");
  const app =
    appValue !== undefined && APP.test(appValue) ? appValue : undefined;
  return {
    type: "report",
    id,
    state: typed,
    ...(kind === undefined ? {} : { kind }),
    ...(progress === undefined ? {} : { progress }),
    ...(app === undefined ? {} : { app }),
  };
}

function validId(id: string): boolean {
  if (id.length > 128) return false;
  const segments = id.split("/");
  return segments.length <= 8 && segments.every((part) => SEGMENT.test(part));
}

/**
 * `msg` / `title` 是否可以接受。先看编码长度再解码（规范要求），解出来必须
 * 是合法 UTF-8 且不含 C0 / C1 控制字符或 DEL。解出的文字随即丢掉。
 */
function textAllowed(
  encoded: string | undefined,
  maxEncoded: number,
  maxDecoded: number,
): boolean {
  if (encoded === undefined) return true;
  if (encoded.length > maxEncoded) return false;
  if (!BASE64.test(encoded) || encoded.length % 4 === 1) return false;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxDecoded) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f))
      return false;
  }
  return true;
}

/* -------------------------------- 跟踪器 --------------------------------- */

interface ProgramRecord {
  readonly state: ProgramState;
  readonly kind?: ProgramKind;
  readonly progress?: number;
  readonly app?: string;
  readonly seq: number;
}

/** 一个终端此刻的状态摘要：所有记录里最急的那一条。 */
export interface ProgramSummary {
  readonly state: ProgramState;
  readonly kind?: ProgramKind;
  readonly progress?: number;
  readonly app?: string;
  /** 这一条从哪个序列来：`osc7501` 或映射到根记录的 `osc9`（9;4）。 */
  readonly source: "osc7501" | "osc9";
}

/** 摘要挑记录的顺序：需要人 > 出错 > 在跑 > 已完成 > 空闲。 */
const URGENCY: Record<ProgramState, number> = {
  blocked: 5,
  error: 4,
  working: 3,
  done: 2,
  idle: 1,
};

/**
 * 一个终端的记录表，规范的 Records / Lifetime / OSC 9;4 三节。
 *
 * - 每条报告整条替换它的记录；`clear` 删掉自己与所有子记录，不带 `id` 清空。
 * - 进程退出或新提示符（OSC 133;A）丢掉 `working`、`blocked` 与 `idle`；
 *   `done`、`error` 留下。
 * - OSC 9;4 映射到根记录，直到收到第一条 OSC 7501 为止（RIS 复位）。
 * - 超过 {@link MAX_RECORDS} 时淘汰最久没更新的那条。
 */
export class ProgramStatusTracker {
  private readonly records = new Map<string, ProgramRecord>();
  private readonly mapped = new Set<string>();
  private sawReport = false;
  private seq = 0;

  /** 一条 OSC 7501 报告（查询由调用方回应，这里不管）。 */
  apply(report: ProgramReport): void {
    if (report.type === "query") return;
    this.sawReport = true;
    if (report.type === "clear") {
      if (report.id === undefined) {
        this.records.clear();
      } else {
        const prefix = `${report.id}/`;
        for (const id of [...this.records.keys()]) {
          if (id === report.id || id.startsWith(prefix))
            this.records.delete(id);
        }
      }
      this.mapped.clear();
      return;
    }
    this.mapped.delete(report.id);
    this.put(report.id, {
      state: report.state,
      ...(report.kind === undefined ? {} : { kind: report.kind }),
      ...(report.progress === undefined ? {} : { progress: report.progress }),
      ...(report.app === undefined ? {} : { app: report.app }),
      seq: 0,
    });
  }

  /**
   * `OSC 9 ; 4 ; st ; pr`：0 移除，1 设进度，2 出错，3 不定进度，4 暂停 /
   * 警告（仍在跑）。收到过 OSC 7501 之后不再映射，免得盖掉 `kind`。
   */
  progress(body: string): void {
    if (this.sawReport) return;
    const [, , st = "0", pr = ""] = body.split(";");
    const value = /^[0-9]{1,3}$/.test(pr)
      ? Math.min(100, Number(pr))
      : undefined;
    const withValue = value === undefined ? {} : { progress: value };
    switch (st.trim()) {
      case "0":
      case "":
        this.records.delete("");
        this.mapped.delete("");
        return;
      case "1":
      case "4":
        this.mapped.add("");
        this.put("", { state: "working", ...withValue, seq: 0 });
        return;
      case "2":
        this.mapped.add("");
        this.put("", { state: "error", seq: 0 });
        return;
      case "3":
        this.mapped.add("");
        this.put("", { state: "working", seq: 0 });
        return;
      default:
        return;
    }
  }

  /** OSC 133;A：新提示符开始了，前一个程序已经不在前台。 */
  promptStarted(): void {
    this.dropLive();
  }

  /** 终端里的进程退出了。 */
  processExited(): void {
    this.dropLive();
  }

  /** RIS：全部清掉，OSC 9;4 的映射恢复。 */
  reset(): void {
    this.records.clear();
    this.mapped.clear();
    this.sawReport = false;
  }

  get size(): number {
    return this.records.size;
  }

  summary(): ProgramSummary | undefined {
    let best: [string, ProgramRecord] | undefined;
    for (const entry of this.records) {
      if (
        best === undefined ||
        URGENCY[entry[1].state] > URGENCY[best[1].state] ||
        (URGENCY[entry[1].state] === URGENCY[best[1].state] &&
          entry[1].seq > best[1].seq)
      ) {
        best = entry;
      }
    }
    if (best === undefined) return undefined;
    const [id, record] = best;
    const app = record.app ?? this.inheritedApp(id);
    return {
      state: record.state,
      ...(record.kind === undefined ? {} : { kind: record.kind }),
      ...(record.progress === undefined ? {} : { progress: record.progress }),
      ...(app === undefined ? {} : { app }),
      source: this.mapped.has(id) ? "osc9" : "osc7501",
    };
  }

  private put(id: string, record: ProgramRecord): void {
    this.seq += 1;
    this.records.delete(id);
    this.records.set(id, { ...record, seq: this.seq });
    while (this.records.size > MAX_RECORDS) {
      // Map 按插入顺序，而每次更新都先删后插：第一条就是最久没更新的。
      const oldest = this.records.keys().next().value as string;
      this.records.delete(oldest);
      this.mapped.delete(oldest);
    }
  }

  private dropLive(): void {
    for (const [id, record] of [...this.records]) {
      if (
        record.state === "working" ||
        record.state === "blocked" ||
        record.state === "idle"
      ) {
        this.records.delete(id);
        this.mapped.delete(id);
      }
    }
  }

  /** 记录没写 `app` 时继承最近的祖先（规范 §Keys）。 */
  private inheritedApp(id: string): string | undefined {
    let path = id;
    while (path !== "") {
      const cut = path.lastIndexOf("/");
      path = cut === -1 ? "" : path.slice(0, cut);
      const app = this.records.get(path)?.app;
      if (app !== undefined) return app;
    }
    return undefined;
  }
}

/** 查询的回应：与查询同一个正文 `?`（规范 §Feature detection）。 */
export const QUERY_REPLY = "\u001b]7501;?\u001b\\";

/**
 * 一条扫描事件交给跟踪器。返回 `"query"` 表示程序在问支不支持，调用方该回应；
 * 其余返回 `undefined`。
 */
export function applyScanEvent(
  tracker: ProgramStatusTracker,
  event: ScanEvent,
): "query" | undefined {
  if (event.type === "reset") {
    tracker.reset();
    return undefined;
  }
  const { body } = event;
  if (body.startsWith("7501;")) {
    const report = parseProgramReport(body.slice(5));
    if (report === undefined) return undefined;
    if (report.type === "query") return "query";
    tracker.apply(report);
    return undefined;
  }
  if (body === "9;4" || body.startsWith("9;4;")) {
    tracker.progress(body);
    return undefined;
  }
  if (body.startsWith("133;")) {
    const mark = body.slice(4).split(";")[0];
    if (mark === "A") tracker.promptStarted();
  }
  return undefined;
}
