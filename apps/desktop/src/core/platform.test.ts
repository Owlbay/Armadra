import { describe, expect, it } from "vitest";
import { CRASH_REPORT_ENV, CRASH_REPORT_MESSAGE } from "./diagnostics/crash";
import { createLog, logLevel, nodePlatform, reportError } from "./platform";

describe("the log", () => {
  it("defaults to info and refuses to be silenced by a typo", () => {
    expect(logLevel(undefined)).toBe("info");
    expect(logLevel("")).toBe("info");
    expect(logLevel("quiet")).toBe("info");
    expect(logLevel("DEBUG")).toBe("debug");
    expect(logLevel(" warn ")).toBe("warn");
  });

  it("prints at and above the level and nothing below it", () => {
    const lines: string[] = [];
    const log = createLog("warn", (line) => lines.push(line));
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("WARN w");
    expect(lines[1]).toContain("ERROR e");
  });

  it("puts structured fields on the same line as JSON", () => {
    const lines: string[] = [];
    createLog("debug", (line) => lines.push(line)).info("bound", { port: 1 });
    expect(lines[0]).toContain('INFO bound {"port":1}');
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });
});

describe("the platform seam", () => {
  it("carries only what a shell knows and the core cannot find out", () => {
    const platform = nodePlatform({ dataDir: "/data", appVersion: "0.1.0" });
    expect(platform.dataDir).toBe("/data");
    expect(platform.appVersion).toBe("0.1.0");
    expect(platform.isPackaged).toBe(false);
    expect(typeof platform.openExternal).toBe("function");
    expect(typeof platform.notify).toBe("function");
  });

  it("notifies without a shell by logging, rather than throwing", () => {
    const lines: string[] = [];
    const platform = nodePlatform({
      dataDir: "/data",
      appVersion: "0.1.0",
      log: createLog("debug", (line) => lines.push(line)),
    });
    platform.notify("tray", { text: "hello" });
    expect(lines[0]).toContain("notify");
  });

  it("opens only the schemes a person could have meant", async () => {
    const platform = nodePlatform({ dataDir: "/data", appVersion: "0.1.0" });
    await expect(platform.openExternal("file:///etc/passwd")).rejects.toThrow(
      /refusing to open/,
    );
    await expect(platform.openExternal("javascript:alert(1)")).rejects.toThrow(
      /refusing to open/,
    );
    await expect(platform.openExternal("not a url")).rejects.toThrow(
      /not a URL/,
    );
  });
});

describe("reportError（外部服务 §11.2）", () => {
  it("壳没给 reportError 时只写一行本地日志，消息已剥离", () => {
    const lines: string[] = [];
    const log = createLog("debug", (line) => lines.push(line));
    const key = process.env.HOME ?? "/nonexistent-home";
    reportError({ log }, new Error(`failed in ${key}/x`), { source: "http" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("unhandled error");
    expect(lines[0]).toContain('"source":"http"');
    expect(lines[0]).not.toContain(`${key}/x`);
  });

  it("壳给了就交给壳；壳自己抛也不往外抛", () => {
    const seen: unknown[] = [];
    const log = createLog("error", () => {});
    reportError(
      { log, reportError: (error, context) => seen.push([error, context]) },
      "x",
      { source: "uncaught" },
    );
    expect(seen).toEqual([["x", { source: "uncaught" }]]);
    expect(() =>
      reportError(
        {
          log,
          reportError: () => {
            throw new Error("sdk down");
          },
        },
        "x",
        { source: "http" },
      ),
    ).not.toThrow();
  });

  it("nodePlatform 只在壳设了通道变量且有 IPC 时转发", () => {
    const sent: unknown[] = [];
    const original = {
      send: process.send,
      connected: Object.getOwnPropertyDescriptor(process, "connected"),
      flag: process.env[CRASH_REPORT_ENV],
    };
    process.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as typeof process.send;
    Object.defineProperty(process, "connected", {
      value: true,
      configurable: true,
    });
    try {
      const platform = nodePlatform({
        dataDir: "/tmp/x",
        appVersion: "0",
        log: createLog("error", () => {}),
      });
      delete process.env[CRASH_REPORT_ENV];
      platform.reportError?.(new Error("a"), { source: "http" });
      expect(sent).toEqual([]);
      process.env[CRASH_REPORT_ENV] = "1";
      platform.reportError?.(new Error("b"), { source: "uncaught" });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: CRASH_REPORT_MESSAGE,
        source: "uncaught",
        name: "Error",
        message: "b",
      });
    } finally {
      process.send = original.send;
      if (original.connected) {
        Object.defineProperty(process, "connected", original.connected);
      } else {
        delete (process as { connected?: boolean }).connected;
      }
      if (original.flag === undefined) delete process.env[CRASH_REPORT_ENV];
      else process.env[CRASH_REPORT_ENV] = original.flag;
    }
  });
});
