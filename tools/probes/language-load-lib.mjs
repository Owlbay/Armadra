// 语言会话负载探针（E3-9）的纯函数部分：统计、编辑器的打字模型、共享瓶颈链路。
//
// 不起进程、不开端口，任何平台都能导入；测试在同目录的 language-load.test.mjs
// （`pnpm release:test` 里跑）。

/** 第 p 百分位（最近秩，p 取 0–100）；空数组答 0。 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export const round1 = (value) => Math.round(value * 10) / 10;

/** `{ count, p50, p95, max, total }`。 */
export function distribution(values) {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? 0 : Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

/**
 * 滑动窗口里的峰值：`frames` 是 `{ at, bytes }`（at 毫秒），答任意 `windowMs`
 * 宽的窗口里最多的帧数与字节数。两个峰值各自取最大，不一定落在同一个窗口。
 */
export function burstPeak(frames, windowMs) {
  const sorted = [...frames].sort((a, b) => a.at - b.at);
  let start = 0;
  let bytes = 0;
  let peakFrames = 0;
  let peakBytes = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    bytes += sorted[end].bytes;
    while (sorted[end].at - sorted[start].at >= windowMs) {
      bytes -= sorted[start].bytes;
      start += 1;
    }
    peakFrames = Math.max(peakFrames, end - start + 1);
    peakBytes = Math.max(peakBytes, bytes);
  }
  return { frames: peakFrames, bytes: peakBytes };
}

/**
 * 一组帧的汇总：按方向与种类（请求的方法、响应对应的方法、通知的方法）分组，
 * 给频率、单帧体积分布与 100 ms / 1 s 突发峰值。`seconds` 是这段负载的时长。
 */
export function summarizeFrames(frames, seconds) {
  const groups = new Map();
  for (const frame of frames) {
    const key = `${frame.direction} ${frame.kind}`;
    const list = groups.get(key) ?? [];
    list.push(frame);
    groups.set(key, list);
  }
  const byKind = {};
  for (const [key, list] of [...groups.entries()].sort()) {
    byKind[key] = {
      perSecond: round1(list.length / seconds),
      bytes: distribution(list.map((frame) => frame.bytes)),
    };
  }
  const direction = (name) => {
    const list = frames.filter((frame) => frame.direction === name);
    return {
      frames: list.length,
      perSecond: round1(list.length / seconds),
      bytesPerSecond: Math.round(
        list.reduce((sum, frame) => sum + frame.bytes, 0) / seconds,
      ),
      bytes: distribution(list.map((frame) => frame.bytes)),
      burst100ms: burstPeak(list, 100),
      burst1s: burstPeak(list, 1000),
    };
  };
  return {
    seconds: round1(seconds),
    down: direction("down"),
    up: direction("up"),
    byKind,
  };
}

/* ------------------------------ 编辑器的打字模型 ------------------------------ */

/** 打字用的正文：标识符、`.` 成员访问与空白交替，像在写 TypeScript。 */
export const TYPING_TEXT =
  "const result = await client.fetchValue(options.timeout); " +
  "if (result.status === 200) logger.info(result.body.items.length); " +
  "for (const item of result.body.items) cache.store(item.id, item); ";

const WORD = /[\w$]/;

/**
 * 页面里 CodeMirror 语言客户端在一次按键之后会发什么（`apps/web/src/editor/
 * language/`）：
 *
 * - `editor`：补全只在一个词的第一个字符（输入后 100 ms，`activateOnTypingDelay`）
 *   与 `.` 之后请求，词内后续字符在本地按 `validFor` 过滤；每次请求之前先
 *   `sync()`，即一条 `didChange`；停手 150 ms 再 `sync()` 一次（`DID_CHANGE_DEBOUNCE_MS`）。
 * - `stress`：服务器答 `isIncomplete`（大列表被截断的服务器都这样）时每个
 *   字符都重新请求补全，并且每个字符都发 `didChange`——这是上限。
 *
 * 答 `{ change: boolean, completion: boolean }`：这次按键要不要立刻发
 * didChange、要不要发补全请求（`editor` 的补全有 100 ms 延迟，由调用方排）。
 */
export function keystrokeActions(profile, previous, char) {
  const isWord = WORD.test(char);
  if (profile === "stress")
    return { change: true, completion: isWord || char === "." };
  const wordStart = isWord && !WORD.test(previous ?? " ");
  return { change: false, completion: wordStart || char === "." };
}

/* ------------------------------ 共享瓶颈链路 ------------------------------ */

/**
 * 一条共享瓶颈的下行链路：几条连接的字节在这里排队，按带宽一段一段送出，
 * 再加单程延迟交付。
 *
 * - `fair`：每条连接一个队列，轮转取段——几条独立的 TCP 连接在同一瓶颈上
 *   大致平分带宽，某一条积压不挡别的连接的小帧。这是「保持独立连接」。
 * - `fifo`：所有连接的字节进同一个队列，按 core 写出的先后送——一条连接上的
 *   帧只能排在前面的字节后面（队头阻塞）。这是「并进同一条控制面连接」。
 *
 * `clock()` 与 `schedule(fn, ms)` 可替换，测试用假时钟。`deliver(connection,
 * chunk)` 在交付时刻被调用。
 */
export class SharedLink {
  constructor({
    bytesPerSecond,
    delayMs,
    mode,
    segmentBytes = 4096,
    clock = () => performance.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    deliver,
  }) {
    if (mode !== "fair" && mode !== "fifo") throw new Error(`mode ${mode}`);
    this.bytesPerSecond = bytesPerSecond;
    this.delayMs = delayMs;
    this.mode = mode;
    this.segmentBytes = segmentBytes;
    this.clock = clock;
    this.schedule = schedule;
    this.deliver = deliver;
    /** fair：连接 → 队列；fifo：只用 `fifo`。 */
    this.queues = new Map();
    this.fifo = [];
    this.order = [];
    this.turn = 0;
    this.busy = false;
    this.freeAt = 0;
    this.queued = new Map();
    /** 已送出、等单程延迟走完的段；按到达时刻排好（链路串行，后送的后到）。 */
    this.inFlight = [];
    this.armed = false;
  }

  /** 这条连接还有多少字节在链路上排队（给调用方做背压）。 */
  backlog(connection) {
    return this.queued.get(connection) ?? 0;
  }

  push(connection, chunk) {
    if (chunk.length === 0) return;
    this.queued.set(connection, this.backlog(connection) + chunk.length);
    if (this.mode === "fifo") this.fifo.push({ connection, chunk });
    else {
      if (!this.queues.has(connection)) {
        this.queues.set(connection, []);
        this.order.push(connection);
      }
      this.queues.get(connection).push(chunk);
    }
    if (!this.busy) this.pump();
  }

  /** 链路上什么都没有：没有排队的，也没有在路上的。 */
  idle() {
    return !this.busy && this.inFlight.length === 0;
  }

  /** 连接关了：丢掉它还在排的字节。 */
  forget(connection) {
    this.queued.delete(connection);
    this.queues.delete(connection);
    this.order = this.order.filter((entry) => entry !== connection);
    this.fifo = this.fifo.filter((entry) => entry.connection !== connection);
  }

  next() {
    if (this.mode === "fifo") {
      const head = this.fifo[0];
      if (head === undefined) return undefined;
      const segment = head.chunk.subarray(0, this.segmentBytes);
      head.chunk = head.chunk.subarray(segment.length);
      if (head.chunk.length === 0) this.fifo.shift();
      return { connection: head.connection, segment };
    }
    for (let tried = 0; tried < this.order.length; tried += 1) {
      const connection = this.order[this.turn % this.order.length];
      this.turn = (this.turn + 1) % Math.max(1, this.order.length);
      const queue = this.queues.get(connection);
      if (queue === undefined || queue.length === 0) continue;
      const segment = queue[0].subarray(0, this.segmentBytes);
      queue[0] = queue[0].subarray(segment.length);
      if (queue[0].length === 0) queue.shift();
      return { connection, segment };
    }
    return undefined;
  }

  pump() {
    const picked = this.next();
    if (picked === undefined) {
      this.busy = false;
      return;
    }
    this.busy = true;
    const { connection, segment } = picked;
    const now = this.clock();
    this.freeAt =
      Math.max(now, this.freeAt) +
      (segment.length / this.bytesPerSecond) * 1000;
    const left = this.backlog(connection) - segment.length;
    if (this.queued.has(connection))
      this.queued.set(connection, Math.max(0, left));
    this.inFlight.push({ at: this.freeAt + this.delayMs, connection, segment });
    this.arm();
    this.schedule(() => this.pump(), this.freeAt - now);
  }

  /**
   * 交付只用一个定时器、按送出的先后：每段各挂一个定时器时，不同时长的定时器
   * 在同一毫秒到期的先后没有保证，同一条连接的字节会乱序。
   */
  arm() {
    if (this.armed || this.inFlight.length === 0) return;
    this.armed = true;
    this.schedule(
      () => {
        this.armed = false;
        const now = this.clock();
        while (this.inFlight.length > 0 && this.inFlight[0].at <= now + 0.5) {
          const { connection, segment } = this.inFlight.shift();
          this.deliver(connection, segment);
        }
        this.arm();
      },
      Math.max(0, this.inFlight[0].at - this.clock()),
    );
  }
}
