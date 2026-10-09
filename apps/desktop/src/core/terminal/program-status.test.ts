import { describe, expect, it } from "vitest";
import {
  MAX_RECORDS,
  MAX_SEQUENCE_BYTES,
  OscScanner,
  ProgramStatusTracker,
  applyScanEvent,
  parseProgramReport,
  type ScanEvent,
} from "./program-status";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const bytes = (text: string) => Buffer.from(text, "latin1");

function scanAll(chunks: readonly string[]): ScanEvent[] {
  const scanner = new OscScanner();
  const out: ScanEvent[] = [];
  for (const chunk of chunks) scanner.feed(bytes(chunk), out);
  return out;
}

/** 喂一串原始输出给一个跟踪器，返回摘要与查询次数。 */
function run(chunks: readonly string[]) {
  const scanner = new OscScanner();
  const tracker = new ProgramStatusTracker();
  let queries = 0;
  for (const chunk of chunks) {
    for (const event of scanner.feed(bytes(chunk))) {
      if (applyScanEvent(tracker, event) === "query") queries += 1;
    }
  }
  return { summary: tracker.summary(), tracker, queries };
}

describe("OscScanner", () => {
  it("finds an OSC 7501 report terminated by ST or by BEL", () => {
    expect(
      scanAll([
        "hello \u001b]7501;state=working\u001b\\ and \u001b]7501;state=done\u0007",
      ]),
    ).toEqual([
      { type: "osc", body: "7501;state=working" },
      { type: "osc", body: "7501;state=done" },
    ]);
  });

  it("reassembles a sequence cut at every possible byte", () => {
    const raw = "x\u001b]7501;state=blocked:kind=question\u001b\\y";
    for (let cut = 1; cut < raw.length; cut += 1) {
      expect(scanAll([raw.slice(0, cut), raw.slice(cut)])).toEqual([
        { type: "osc", body: "7501;state=blocked:kind=question" },
      ]);
    }
    // 一个字节一片。
    expect(scanAll([...raw])).toEqual([
      { type: "osc", body: "7501;state=blocked:kind=question" },
    ]);
  });

  it("ignores OSC strings it does not care about without collecting them", () => {
    expect(
      scanAll([
        "\u001b]0;window title\u0007\u001b]8;;https://x\u001b\\link\u001b]52;c;aGk=\u0007",
      ]),
    ).toEqual([]);
  });

  it("drops an over-long sequence and recovers on the next one", () => {
    const long = `\u001b]7501;state=working:msg=${"A".repeat(MAX_SEQUENCE_BYTES)}\u0007`;
    expect(scanAll([long, "\u001b]7501;state=idle\u0007"])).toEqual([
      { type: "osc", body: "7501;state=idle" },
    ]);
  });

  it("abandons a sequence interrupted by CAN, SUB or a new escape", () => {
    expect(
      scanAll([
        "\u001b]7501;state=working\u0018",
        "\u001b]7501;state=error\u001a",
        "\u001b]7501;state=blocked\u001b[0m",
        "\u001b]7501;state=done\u0007",
      ]),
    ).toEqual([{ type: "osc", body: "7501;state=done" }]);
  });

  it("unwraps tmux DCS passthrough", () => {
    const inner = "\u001b]7501;state=working:progress=5\u001b\\";
    const wrapped = `\u001bPtmux;${inner.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
    expect(scanAll([wrapped.slice(0, 9), wrapped.slice(9)])).toEqual([
      { type: "osc", body: "7501;state=working:progress=5" },
    ]);
  });

  it("skips other DCS strings, even ones that contain an OSC lookalike", () => {
    expect(scanAll(["\u001bPq#0;2;0;0;0\u001b]7501;x\u001b\\after"])).toEqual(
      [],
    );
  });

  it("reports RIS, OSC 9;4 and OSC 133", () => {
    expect(
      scanAll([
        "\u001bc\u001b]9;4;1;40\u0007\u001b]133;A\u0007\u001b]9;hi\u0007",
      ]),
    ).toEqual([
      { type: "reset" },
      { type: "osc", body: "9;4;1;40" },
      { type: "osc", body: "133;A" },
    ]);
  });
});

describe("parseProgramReport", () => {
  it("parses every key the spec defines", () => {
    expect(
      parseProgramReport(
        `state=blocked:kind=permission:progress=40:app=claude-code:id=build/test:msg=${b64("Allow rm?")}:title=${b64("Build")}`,
      ),
    ).toEqual({
      type: "report",
      id: "build/test",
      state: "blocked",
      kind: "permission",
      progress: 40,
      app: "claude-code",
    });
  });

  it("answers the feature query", () => {
    expect(parseProgramReport("?")).toEqual({ type: "query" });
  });

  it("ignores a report with a missing or unknown state, never falling back to idle", () => {
    expect(parseProgramReport("app=x")).toBeUndefined();
    expect(parseProgramReport("state=sleeping")).toBeUndefined();
    expect(parseProgramReport("")).toBeUndefined();
  });

  it("skips malformed pairs, ignores unknown keys, last value wins, trims whitespace", () => {
    expect(
      parseProgramReport(
        " state = idle :garbage: Bad=1 :weird=a;b:future=yes:state=working",
      ),
    ).toEqual({ type: "report", id: "", state: "working" });
  });

  it("drops invalid optional values but keeps the report", () => {
    expect(
      parseProgramReport(
        "state=working:progress=101:kind=permission:app=has space",
      ),
    ).toEqual({ type: "report", id: "", state: "working" });
    expect(parseProgramReport("state=done:progress=50")).toEqual({
      type: "report",
      id: "",
      state: "done",
    });
    expect(parseProgramReport("state=blocked:kind=coffee")).toEqual({
      type: "report",
      id: "",
      state: "blocked",
    });
  });

  it("ignores the whole report when the id is invalid", () => {
    expect(parseProgramReport("state=working:id=a//b")).toBeUndefined();
    expect(
      parseProgramReport(`state=working:id=${"x".repeat(33)}`),
    ).toBeUndefined();
    expect(
      parseProgramReport(`state=working:id=${Array(9).fill("a").join("/")}`),
    ).toBeUndefined();
  });

  it("discards a report whose msg or title breaks a limit or decodes to control characters", () => {
    expect(
      parseProgramReport(`state=working:msg=${b64("line\nbreak")}`),
    ).toBeUndefined();
    expect(
      parseProgramReport(`state=working:msg=${b64("\u0085c1")}`),
    ).toBeUndefined();
    // 合法的值字符、却不是 base64：整条丢弃。
    expect(parseProgramReport("state=working:msg=a,b")).toBeUndefined();
    // 值里出现不允许的字符是坏键值对，跳过它，报告照常。
    expect(parseProgramReport("state=working:msg=!!!")).toMatchObject({
      state: "working",
    });
    expect(
      parseProgramReport(`state=working:title=${b64("t".repeat(193))}`),
    ).toBeUndefined();
    expect(
      parseProgramReport(`state=working:msg=${b64("m".repeat(2049))}`),
    ).toBeUndefined();
    // 无填充的 base64 是允许的。
    expect(
      parseProgramReport(`state=working:msg=${b64("ok!").replace(/=+$/, "")}`),
    ).toMatchObject({ state: "working" });
  });

  it("recognises clear, with and without an id", () => {
    expect(parseProgramReport("state=clear")).toEqual({
      type: "clear",
      id: undefined,
    });
    expect(parseProgramReport("state=clear:id=build")).toEqual({
      type: "clear",
      id: "build",
    });
  });
});

describe("ProgramStatusTracker", () => {
  it("replaces a record completely on each report", () => {
    const { summary } = run([
      "\u001b]7501;state=working:app=tool:progress=40\u0007",
      "\u001b]7501;state=working\u0007",
    ]);
    expect(summary).toEqual({ state: "working", source: "osc7501" });
  });

  it("summarises the most urgent record and inherits app from the nearest ancestor", () => {
    const { summary } = run([
      "\u001b]7501;state=working:app=make\u0007",
      "\u001b]7501;state=working:id=a\u0007",
      "\u001b]7501;state=blocked:id=a/b:kind=question\u0007",
      "\u001b]7501;state=done:id=c\u0007",
    ]);
    expect(summary).toEqual({
      state: "blocked",
      kind: "question",
      app: "make",
      source: "osc7501",
    });
  });

  it("clears a record and everything beneath it, or everything without an id", () => {
    const partial = run([
      "\u001b]7501;state=working:id=a\u0007",
      "\u001b]7501;state=blocked:id=a/b\u0007",
      "\u001b]7501;state=done:id=ab\u0007",
      "\u001b]7501;state=clear:id=a\u0007",
    ]);
    expect(partial.summary?.state).toBe("done");
    expect(partial.tracker.size).toBe(1);
    const all = run([
      "\u001b]7501;state=working:id=a\u0007",
      "\u001b]7501;state=clear\u0007",
    ]);
    expect(all.summary).toBeUndefined();
  });

  it("drops working, blocked and idle on exit or a new prompt, and keeps done and error", () => {
    const { tracker } = run([
      "\u001b]7501;state=working:id=w\u0007",
      "\u001b]7501;state=blocked:id=b\u0007",
      "\u001b]7501;state=idle:id=i\u0007",
      "\u001b]7501;state=error:id=e\u0007",
      "\u001b]7501;state=done:id=d\u0007",
      "\u001b]133;A\u0007",
    ]);
    expect(tracker.size).toBe(2);
    expect(tracker.summary()?.state).toBe("error");
    tracker.processExited();
    expect(tracker.size).toBe(2);
  });

  it("maps OSC 9;4 to the root record until the first OSC 7501", () => {
    expect(run(["\u001b]9;4;1;55\u0007"]).summary).toEqual({
      state: "working",
      progress: 55,
      source: "osc9",
    });
    expect(run(["\u001b]9;4;3\u0007"]).summary).toEqual({
      state: "working",
      source: "osc9",
    });
    expect(run(["\u001b]9;4;2;10\u0007"]).summary?.state).toBe("error");
    expect(run(["\u001b]9;4;1;55\u0007", "\u001b]9;4;0\u0007"]).summary).toBe(
      undefined,
    );
    // 收到过 OSC 7501 之后，9;4 不再覆盖 kind。
    expect(
      run([
        "\u001b]7501;state=blocked:kind=auth\u0007",
        "\u001b]9;4;1;80\u0007",
      ]).summary,
    ).toEqual({ state: "blocked", kind: "auth", source: "osc7501" });
    // RIS 之后 9;4 又生效。
    expect(
      run(["\u001b]7501;state=idle\u0007", "\u001bc", "\u001b]9;4;1;20\u0007"])
        .summary,
    ).toEqual({ state: "working", progress: 20, source: "osc9" });
  });

  it("counts feature queries", () => {
    expect(run(["\u001b]7501;?\u001b\\\u001b[c"]).queries).toBe(1);
  });

  it("caps the record table, evicting the least recently updated record", () => {
    const tracker = new ProgramStatusTracker();
    for (let index = 0; index <= MAX_RECORDS; index += 1) {
      tracker.apply({
        type: "report",
        id: `r${index}`,
        state: index === 0 ? "blocked" : "idle",
      });
    }
    expect(tracker.size).toBe(MAX_RECORDS);
    // r0 was the oldest and is gone, so nothing is blocked any more.
    expect(tracker.summary()?.state).toBe("idle");
  });
});
