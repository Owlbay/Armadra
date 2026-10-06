import { describe, expect, it } from "vitest";

import * as pageScrub from "../../../../web/src/diagnostics/crash-scrub";
import { Router, emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { type RequestIdentity, runAs } from "../identity/gate";
import {
  ClientReports,
  GLOBAL_PER_MINUTE,
  PER_CALLER_PER_MINUTE,
  parseClientError,
  scrubClientError,
  stackFileNames,
} from "./client-report";
import { type ScrubContext, scrubContext, scrubText } from "./crash";
import { logError } from "../platform";
import { pageErrorsEnabled } from "./index";
import { CLIENT_ERROR_ROUTE, installRoutes } from "./routes";

/**
 * 页面错误上报（契约 §30）：请求体形状、栈只留文件名、服务端再剥离、限流、
 * 关着不收；页面那份剥离与 core 这份逐条一致。
 */

const SECRET = "sk-live-0123456789abcdefABCDEF";
const SESSION = `${"a1".repeat(16)}.${"Q".repeat(42)}A`;
const context: ScrubContext = scrubContext(
  { HOME: "/Users/alice", OPENAI_API_KEY: SECRET },
  "/Users/alice",
);

const CHROME_STACK = [
  "TypeError: Cannot read properties of undefined (reading 'x')",
  "    at render (http://127.0.0.1:5173/assets/index-abc123.js?v=9:12:34)",
  "    at https://gw.example.test:8443/assets/vendor-def.js:1:2",
  "    at load (/Users/alice/proj/src/canvas.ts:5:6)",
  "    at C:\\Users\\Dave\\app\\x.js:7:8",
].join("\n");

describe("stackFileNames", () => {
  it("栈帧里的地址与路径只留文件名，消息行不动", () => {
    expect(stackFileNames(CHROME_STACK)).toBe(
      [
        "TypeError: Cannot read properties of undefined (reading 'x')",
        "    at render (index-abc123.js:12:34)",
        "    at vendor-def.js:1:2",
        "    at load (canvas.ts:5:6)",
        "    at x.js:7:8",
      ].join("\n"),
    );
  });

  it("Firefox / Safari 的 `fn@地址` 形状", () => {
    expect(
      stackFileNames(
        "render@http://host:5173/src/app/App.tsx?t=17:3:4\n@file:///Users/x/a.js:1:1",
      ),
    ).toBe("render@App.tsx:3:4\n@a.js:1:1");
  });
});

describe("parseClientError", () => {
  const good = { kind: "error", name: "TypeError", message: "m", stack: "s" };

  it("只认四个键与两种 kind", () => {
    expect(parseClientError(good).ok).toBe(true);
    expect(parseClientError({ ...good, kind: "rejection" }).ok).toBe(true);
    expect(parseClientError({ ...good, kind: "log" }).ok).toBe(false);
    expect(parseClientError({ ...good, url: "http://x" }).ok).toBe(false);
    expect(parseClientError({ ...good, stack: 1 }).ok).toBe(false);
    expect(parseClientError([good]).ok).toBe(false);
    expect(parseClientError(null).ok).toBe(false);
  });

  it("超长拒绝而不是截断", () => {
    expect(parseClientError({ ...good, message: "x".repeat(2_001) }).ok).toBe(
      false,
    );
    expect(parseClientError({ ...good, stack: "x".repeat(8_001) }).ok).toBe(
      false,
    );
  });
});

describe("scrubClientError", () => {
  it("消息与栈过同一套剥离：家目录、环境变量、会话密钥、地址里的查询与片段", () => {
    const scrubbed = scrubClientError(
      {
        kind: "error",
        name: "Error",
        message: `failed ${SECRET} at /Users/alice/proj with ${SESSION} from https://u:p@h.test/x?token=1#pair=abc`,
        stack: CHROME_STACK,
      },
      context,
    );
    expect(scrubbed.message).toBe(
      "failed [env] at ~/proj with [redacted] from https://[redacted]@h.test/x?[redacted]#[redacted]",
    );
    expect(scrubbed.stack).not.toContain("alice");
    expect(scrubbed.stack).not.toContain("Dave");
    expect(scrubbed.stack).not.toContain("127.0.0.1");
    expect(scrubbed.stack).toContain("index-abc123.js:12:34");
  });

  it("消息截到 300 字", () => {
    const scrubbed = scrubClientError(
      { kind: "error", name: "", message: "y".repeat(1_000), stack: "" },
      context,
    );
    expect(scrubbed.message).toHaveLength(301);
    expect(scrubbed.name).toBe("Error");
  });
});

describe("页面那份剥离与 core 一致", () => {
  const empty = scrubContext({}, "");
  const samples = [
    "open /Users/bob/x.js and /home/carol/y and C:\\Users\\Dave\\z",
    "Authorization: Bearer abc.def.ghi-jkl token=xyz password: hunter22",
    "ghp_abcdefghijklmnopqrstuvwxyz0123 sk-ant-abcdefgh123 AKIAABCDEFGHIJKLMNOP",
    `session ${SESSION} next`,
    "https://user:pass@host.test/a/b?c=d#pair=e f",
    "\u001b[31mred\u001b[0m\u0007 bell",
    "z".repeat(400),
  ];

  it("scrubText", () => {
    for (const sample of samples) {
      expect(pageScrub.scrubText(sample)).toBe(scrubText(sample, empty));
    }
  });

  it("stackFileNames", () => {
    expect(pageScrub.stackFileNames(CHROME_STACK)).toBe(
      stackFileNames(CHROME_STACK),
    );
  });
});

describe("ClientReports", () => {
  const body = { kind: "error", name: "E", message: "boom", stack: "" };

  function reports(on = true) {
    const state = { on, now: 0, sent: [] as Error[] };
    const instance = new ClientReports({
      enabled: () => state.on,
      report: (error) => state.sent.push(error),
      scrub: () => context,
      now: () => state.now,
    });
    return { state, instance };
  }

  it("关着不收、不计数", () => {
    const { state, instance } = reports(false);
    expect(instance.accept("a", body).kind).toBe("disabled");
    expect(instance.accept("a", { nope: 1 }).kind).toBe("disabled");
    expect(state.sent).toHaveLength(0);
    state.on = true;
    for (let i = 0; i < PER_CALLER_PER_MINUTE; i += 1) {
      expect(instance.accept("a", body).kind).toBe("accepted");
    }
  });

  it("每个调用方每分钟 5 条，一分钟后回满", () => {
    const { state, instance } = reports();
    for (let i = 0; i < PER_CALLER_PER_MINUTE; i += 1) {
      expect(instance.accept("a", body).kind).toBe("accepted");
    }
    const limited = instance.accept("a", body);
    expect(limited.kind).toBe("limited");
    // 别的调用方不受影响。
    expect(instance.accept("b", body).kind).toBe("accepted");
    state.now += 60_000;
    expect(instance.accept("a", body).kind).toBe("accepted");
  });

  it("整台 core 有全局上限", () => {
    const { instance } = reports();
    let accepted = 0;
    for (let i = 0; i < GLOBAL_PER_MINUTE + 10; i += 1) {
      if (instance.accept(`c${i}`, body).kind === "accepted") accepted += 1;
    }
    expect(accepted).toBe(GLOBAL_PER_MINUTE);
  });

  it("交出去的是剥离过的 Error", () => {
    const { state, instance } = reports();
    instance.accept("a", { ...body, message: `key ${SECRET}` });
    expect(state.sent[0]?.message).toBe("key [env]");
  });

  it("形状不对不扣桶", () => {
    const { instance } = reports();
    for (let i = 0; i < 10; i += 1) {
      expect(instance.accept("a", { kind: "x" }).kind).toBe("invalid");
    }
    expect(instance.accept("a", body).kind).toBe("accepted");
  });
});

describe(`${CLIENT_ERROR_ROUTE}`, () => {
  function setup(on = true) {
    const sent: Error[] = [];
    const reports = new ClientReports({
      enabled: () => on,
      report: (error) => sent.push(error),
      scrub: () => context,
    });
    const router = new Router();
    installRoutes({ router } as unknown as CoreServer, reports);
    const call = async (
      who: RequestIdentity | undefined,
      method: string,
      body?: unknown,
    ) => {
      const request = {
        ...emptyRequest(method, CLIENT_ERROR_ROUTE),
        json: <T>() => {
          if (body === "not json") throw new SyntaxError("bad");
          return body as T;
        },
      };
      const run = () => router.dispatch(method, CLIENT_ERROR_ROUTE, request);
      return (await (who === undefined ? run() : runAs(who, run))) as {
        status: number;
        body: any;
        headers?: Record<string, string>;
      };
    };
    return { call, sent };
  }

  const member: RequestIdentity = {
    subject: { principalId: "p1", kind: "member", scopes: [] },
    device: { deviceId: "d1", deviceName: "x" },
  };
  const anonymous: RequestIdentity = {
    subject: { principalId: "", kind: "member", scopes: [] },
  };
  const body = { kind: "rejection", name: "E", message: "boom", stack: "" };

  it("GET 答 enabled", async () => {
    expect((await setup(true).call(member, "GET")).body).toEqual({
      enabled: true,
    });
    expect((await setup(false).call(undefined, "GET")).body).toEqual({
      enabled: false,
    });
  });

  it("匿名 401", async () => {
    const { call } = setup();
    expect((await call(anonymous, "GET")).status).toBe(401);
    expect((await call(anonymous, "POST", body)).status).toBe(401);
  });

  it("关着答 accepted false，不看请求体", async () => {
    const { call, sent } = setup(false);
    const answer = await call(member, "POST", "not json");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ accepted: false });
    expect(sent).toHaveLength(0);
  });

  it("开着收下、坏请求 400、超限 429 带 Retry-After", async () => {
    const { call, sent } = setup();
    expect((await call(member, "POST", "not json")).status).toBe(400);
    expect((await call(member, "POST", { kind: "error" })).status).toBe(400);
    for (let i = 0; i < PER_CALLER_PER_MINUTE; i += 1) {
      const answer = await call(member, "POST", body);
      expect(answer.status).toBe(202);
      expect(answer.body).toEqual({ accepted: true });
    }
    const limited = await call(member, "POST", body);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    expect(Number(limited.headers?.["retry-after"])).toBeGreaterThan(0);
    // 本机 owner（桌面壳，没有请求身份）是另一只桶。
    expect((await call(undefined, "POST", body)).status).toBe(202);
    expect(sent).toHaveLength(PER_CALLER_PER_MINUTE + 1);
  });
});

describe("pageErrorsEnabled", () => {
  const dsn = "https://key@glitchtip.test/1";

  it("设置关着一律不收", () => {
    expect(
      pageErrorsEnabled(
        { crashReportDsn: dsn, reportPageErrors: false },
        { crashReportingActive: () => true },
      ),
    ).toBe(false);
  });

  it("壳回答时以壳为准（服务器壳的 DSN 可能来自环境变量）", () => {
    const on = { crashReportDsn: "", reportPageErrors: true };
    expect(pageErrorsEnabled(on, { crashReportingActive: () => true })).toBe(
      true,
    );
    expect(
      pageErrorsEnabled(
        { ...on, crashReportDsn: dsn },
        { crashReportingActive: () => false },
      ),
    ).toBe(false);
  });

  it("壳不回答时看设置里的 DSN 合不合格", () => {
    expect(
      pageErrorsEnabled({ crashReportDsn: dsn, reportPageErrors: true }, {}),
    ).toBe(true);
    expect(
      pageErrorsEnabled(
        { crashReportDsn: "https://no-key/1", reportPageErrors: true },
        {},
      ),
    ).toBe(false);
  });
});

describe("本机日志", () => {
  it("页面错误的正文不进日志，别的来源照旧", () => {
    const lines: [string, string, Record<string, unknown> | undefined][] = [];
    const log = {
      debug: (m: string, f?: Record<string, unknown>) =>
        lines.push(["debug", m, f]),
      info: (m: string, f?: Record<string, unknown>) =>
        lines.push(["info", m, f]),
      warn: (m: string, f?: Record<string, unknown>) =>
        lines.push(["warn", m, f]),
      error: (m: string, f?: Record<string, unknown>) =>
        lines.push(["error", m, f]),
    };
    logError(log, new Error("page secret body"), { source: "page" });
    expect(JSON.stringify(lines)).not.toContain("page secret body");
    logError(log, new Error("core failure"), { source: "http" });
    expect(JSON.stringify(lines)).toContain("core failure");
  });
});
