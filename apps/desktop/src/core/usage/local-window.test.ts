import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScanState } from "./cost";
import {
  estimateLocalWindows,
  hourStartMs,
  type ScannedBuckets,
} from "./local-window";

/** 本地时间 2026-10-04 14:30。窗口按本地整点与本地日算，所以夹具也用本地时间。 */
const NOW = new Date(2026, 9, 4, 14, 30).getTime();

function local(day: number, hour: number, minute = 0): string {
  return new Date(2026, 9, day, hour, minute).toISOString();
}

function line(
  id: string,
  timestamp: string,
  usage: Record<string, number>,
  model = "claude-opus-5",
): string {
  return JSON.stringify({
    type: "assistant",
    requestId: id,
    timestamp,
    message: { model, usage },
  });
}

describe("Claude 本地额度窗口估算", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "armadra-local-window-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(relative: string, lines: readonly string[]): void {
    const path = join(home, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);
  }

  async function scan(): Promise<ScannedBuckets> {
    const result = await new ScanState(() => NOW).scan(
      [
        ["claude", join(home, "claude/projects")],
        ["codex", join(home, "codex/sessions")],
      ],
      [],
    );
    return { buckets: result.buckets, hourBuckets: result.hourBuckets };
  }

  it("夹具转录：5 小时窗口从窗口外第一条活动的整点开始，缓存读不计", async () => {
    write("claude/projects/demo/a.jsonl", [
      // 早上 06:10 开过一个窗口，11:00 已经过期。
      line("r1", local(4, 6, 10), { input_tokens: 1000, output_tokens: 1000 }),
      // 12:20 开新窗口，整点 12:00 起算，17:00 结束。
      line("r2", local(4, 12, 20), {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 99_999,
        cache_creation_input_tokens: 50,
      }),
      line("r3", local(4, 14, 5), { input_tokens: 10, output_tokens: 20 }),
    ]);
    // 别家的 token 不算进 Claude。
    write("codex/sessions/2026/10/04/rollout.jsonl", []);
    const estimate = estimateLocalWindows(await scan(), "claude", NOW);
    expect(estimate.source).toBe("local");
    const [five, seven] = estimate.windows;
    expect(five).toEqual({
      key: "five_hour",
      label: "5h",
      windowStartMs: new Date(2026, 9, 4, 12).getTime(),
      resetsAtMs: new Date(2026, 9, 4, 17).getTime(),
      used: 380,
    });
    expect(seven?.used).toBe(2380);
    expect(seven).not.toHaveProperty("limit");
  });

  it("窗口边界：恰好 5 小时后的活动开新窗口，7 天按含今天的 7 个本地日", async () => {
    write("claude/projects/demo/b.jsonl", [
      line("e1", local(4, 9, 0), { input_tokens: 5 }),
      // 09:00 + 5h = 14:00，这一条落在新窗口的第一个整点上。
      line("e2", local(4, 14, 0), { input_tokens: 7 }),
      // 9 月 28 日是 7 天窗口的第一天，算；27 日不算。
      line("e3", new Date(2026, 8, 28, 0, 1).toISOString(), {
        output_tokens: 11,
      }),
      line("e4", new Date(2026, 8, 27, 23, 59).toISOString(), {
        output_tokens: 1000,
      }),
    ]);
    const [five, seven] = estimateLocalWindows(
      await scan(),
      "claude",
      NOW,
    ).windows;
    expect(five?.windowStartMs).toBe(new Date(2026, 9, 4, 14).getTime());
    expect(five?.used).toBe(7);
    expect(seven?.windowStartMs).toBe(new Date(2026, 8, 28).getTime());
    expect(seven?.used).toBe(5 + 7 + 11);
  });

  it("最近的窗口已经结束：报从当前整点起、用量为零、没有结束时刻的窗口", async () => {
    write("claude/projects/demo/c.jsonl", [
      line("o1", local(4, 6, 0), { input_tokens: 40 }),
    ]);
    const [five, seven] = estimateLocalWindows(
      await scan(),
      "claude",
      NOW,
    ).windows;
    expect(five?.used).toBe(0);
    expect(five?.windowStartMs).toBe(new Date(2026, 9, 4, 14).getTime());
    expect(five).not.toHaveProperty("resetsAtMs");
    expect(seven?.used).toBe(40);
  });

  it("没有目录额度只报用量；给了额度才带 limit", async () => {
    write("claude/projects/demo/d.jsonl", [
      line("l1", local(4, 14, 0), { input_tokens: 300 }),
    ]);
    const scanned = await scan();
    const none = estimateLocalWindows(scanned, "claude", NOW, {});
    for (const window of none.windows)
      expect(window).not.toHaveProperty("limit");
    const some = estimateLocalWindows(scanned, "claude", NOW, {
      five_hour: 1000,
      seven_day: 0,
    });
    expect(some.windows[0]?.limit).toBe(1000);
    // 0 不是额度。
    expect(some.windows[1]).not.toHaveProperty("limit");
  });

  it("没有转录时两个窗口都是零", async () => {
    const estimate = estimateLocalWindows(await scan(), "claude", NOW);
    expect(estimate.windows.map((window) => window.used)).toEqual([0, 0]);
  });

  it("小时键按本地时间解析，坏键是 undefined", () => {
    expect(hourStartMs("2026-10-04T09")).toBe(
      new Date(2026, 9, 4, 9).getTime(),
    );
    expect(hourStartMs("2026-10-04")).toBeUndefined();
  });
});
