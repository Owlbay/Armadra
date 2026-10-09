import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROGRAM_EMIT_INTERVAL_MS,
  ProgramStatusBook,
  type ProgramStatusWire,
} from "./program-status-book";

const chunk = (text: string) => Buffer.from(text, "latin1");

function book() {
  let clock = 1_000;
  const frames: (ProgramStatusWire | undefined)[] = [];
  const answers: string[] = [];
  const instance = new ProgramStatusBook({
    clock: () => clock,
    now: () => "2026-10-09T00:00:00.000Z",
    emit: (_sessionId, status) => frames.push(status),
    answer: (sessionId) => answers.push(sessionId),
  });
  return {
    instance,
    frames,
    answers,
    advance(ms: number) {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProgramStatusBook", () => {
  it("emits the first change at once and coalesces a burst into one trailing frame", () => {
    vi.useFakeTimers();
    const { instance, frames, advance } = book();
    instance.feed("s", 1, chunk("\u001b]7501;state=working:progress=1\u0007"));
    expect(frames.map((frame) => frame?.progress)).toEqual([1]);
    for (let p = 2; p <= 30; p += 1)
      instance.feed(
        "s",
        1,
        chunk(`\u001b]7501;state=working:progress=${p}\u0007`),
      );
    expect(frames).toHaveLength(1);
    advance(PROGRAM_EMIT_INTERVAL_MS);
    expect(frames.map((frame) => frame?.progress)).toEqual([1, 30]);
    expect(instance.status("s")).toMatchObject({
      state: "working",
      progress: 30,
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
  });

  it("does not emit when the summary did not change", () => {
    vi.useFakeTimers();
    const { instance, frames, advance } = book();
    instance.feed("s", 1, chunk("\u001b]7501;state=idle\u0007"));
    advance(1_000);
    instance.feed("s", 1, chunk("\u001b]7501;state=idle\u0007"));
    advance(1_000);
    expect(frames).toHaveLength(1);
  });

  it("answers the feature query, rate-limited", () => {
    vi.useFakeTimers();
    const { instance, answers, advance } = book();
    instance.feed("s", 1, chunk("\u001b]7501;?\u001b\\\u001b]7501;?\u0007"));
    expect(answers).toEqual(["s"]);
    advance(1_000);
    instance.feed("s", 1, chunk("\u001b]7501;?\u0007"));
    expect(answers).toEqual(["s", "s"]);
  });

  it("on exit drops the live records, sends the remainder and forgets the session", () => {
    const { instance, frames } = book();
    instance.feed("s", 1, chunk("\u001b]7501;state=working\u0007"));
    instance.exited("s");
    expect(frames).toEqual([
      expect.objectContaining({ state: "working" }),
      undefined,
    ]);
    expect(instance.status("s")).toBeUndefined();

    const kept = book();
    kept.instance.feed("s", 1, chunk("\u001b]7501;state=error:app=tf\u0007"));
    kept.instance.exited("s");
    // `error` survives the exit, so there is nothing new to say.
    expect(kept.frames).toEqual([
      expect.objectContaining({ state: "error", app: "tf" }),
    ]);
  });

  it("starts over when the session comes back as a new generation", () => {
    const { instance } = book();
    instance.feed("s", 1, chunk("\u001b]7501;state=blocked\u0007"));
    instance.feed("s", 2, chunk("plain output"));
    expect(instance.status("s")).toBeUndefined();
  });

  it("keeps a sequence split across reads", () => {
    const { instance, frames } = book();
    instance.feed("s", 1, chunk("\u001b]7501;state=bl"));
    instance.feed("s", 1, chunk("ocked:kind=permission\u001b"));
    instance.feed("s", 1, chunk("\\"));
    expect(frames).toEqual([
      expect.objectContaining({ state: "blocked", kind: "permission" }),
    ]);
  });
});
