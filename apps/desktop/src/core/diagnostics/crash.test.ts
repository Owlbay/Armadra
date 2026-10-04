import { describe, expect, it } from "vitest";

import {
  CRASH_REPORT_MESSAGE,
  type ScrubContext,
  crashReportMessage,
  dsnFromSettings,
  errorFromMessage,
  isCrashReportMessage,
  pageErrorsFromSettings,
  parseDsn,
  scrubBreadcrumb,
  scrubContext,
  scrubEvent,
  scrubText,
} from "./crash";

const SECRET = "sk-live-0123456789abcdefABCDEF";
const context: ScrubContext = scrubContext(
  {
    HOME: "/Users/alice",
    OPENAI_API_KEY: SECRET,
    SHORT: "1",
    CUSTOM_TOKEN: "plain-but-long-value",
  },
  "/Users/alice",
);

describe("scrubText", () => {
  it("家目录换成 ~，其它用户名段换成 ~", () => {
    expect(scrubText("open /Users/alice/proj/a.ts failed", context)).toBe(
      "open ~/proj/a.ts failed",
    );
    expect(scrubText("at /Users/bob/x.js:1:2", context)).toBe(
      "at /Users/~/x.js:1:2",
    );
    expect(scrubText("at /home/carol/x.js", context)).toBe("at /home/~/x.js");
    expect(scrubText("at C:\\Users\\Dave\\app\\x.js", context)).toBe(
      "at C:\\Users\\~\\app\\x.js",
    );
    expect(scrubText('"C:\\\\Users\\\\Dave\\\\x"', context)).toBe(
      '"C:\\\\Users\\\\~\\\\x"',
    );
  });

  it("环境变量的值替换掉，短值不动", () => {
    expect(scrubText(`key ${SECRET} rejected`, context)).toBe(
      "key [env] rejected",
    );
    expect(scrubText("value plain-but-long-value here", context)).toBe(
      "value [env] here",
    );
    expect(scrubText("exit 1", context)).toBe("exit 1");
  });

  it("令牌形状、地址里的账号与查询串都换掉", () => {
    const empty = scrubContext({}, "");
    expect(scrubText("ghp_abcdefghijklmnopqrstuvwxyz0123", empty)).toBe(
      "[redacted]",
    );
    expect(scrubText("Authorization: Bearer abc.def.ghi-jkl", empty)).toBe(
      "Authorization: [redacted]",
    );
    expect(scrubText("Bearer abcdefghijkl", empty)).toBe("Bearer [redacted]");
    expect(scrubText("password=hunter22 next", empty)).toBe(
      "password=[redacted] next",
    );
    expect(scrubText("GET https://u:p@host.dev/x?token=1&a=2 ok", empty)).toBe(
      "GET https://[redacted]@host.dev/x?[redacted] ok",
    );
    expect(
      scrubText(
        "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2Q",
        empty,
      ),
    ).toBe("jwt [redacted]");
  });

  it("去掉 ANSI 转义与控制字符，并截断", () => {
    const empty = scrubContext({}, "");
    expect(scrubText("\u001b[31mred\u001b[0m\u0007!", empty)).toBe("red!");
    const long = "x".repeat(1000);
    expect(scrubText(long, empty)).toHaveLength(301);
    expect(scrubText(long, empty, 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("scrubEvent", () => {
  const event = {
    event_id: "abc",
    environment: "production",
    server_name: "alices-macbook",
    user: { id: "1", ip_address: "10.0.0.2" },
    request: { url: "http://x/", headers: { cookie: "a" }, data: "body" },
    extra: { terminal: "$ cat secret.txt" },
    modules: { left: "1.0.0" },
    tags: { source: "http", note: `has ${SECRET}` },
    contexts: {
      os: { name: "macOS", version: "15" },
      runtime: { name: "node", version: "v22" },
      process: { env: { OPENAI_API_KEY: SECRET }, argv: ["node", "x"] },
      app: { cwd: "/Users/alice/proj", app_name: "Armadra" },
    },
    exception: {
      values: [
        {
          type: "Error",
          value: `ENOENT: open '/Users/alice/notes/${"y".repeat(500)}'`,
          stacktrace: {
            frames: [
              {
                filename: "/Users/alice/Armadra/out/main/index.js",
                abs_path: "/Users/alice/Armadra/out/main/index.js",
                function: "load",
                lineno: 3,
                vars: { content: "file body" },
                pre_context: ["const a = 1;"],
                context_line: "throw new Error()",
                post_context: ["}"],
              },
            ],
          },
        },
      ],
    },
    breadcrumbs: [
      { category: "console", message: "$ npm test\nPASS", timestamp: 1 },
      { category: "http", data: { url: "https://x/?t=1" }, timestamp: 2 },
      {
        category: "electron",
        message: "app.ready /Users/alice",
        data: { title: "secret window" },
        level: "info",
        timestamp: 3,
      },
    ],
  };

  const out = scrubEvent(event, context) as unknown as Record<string, unknown>;
  const text = JSON.stringify(out);

  it("整段删掉用户、请求、extra、主机名、模块与环境变量", () => {
    for (const key of ["user", "request", "extra", "server_name", "modules"]) {
      expect(out, key).not.toHaveProperty(key);
    }
    const contexts = out.contexts as Record<string, Record<string, unknown>>;
    expect(contexts.process).toEqual({});
    expect(contexts.app).toEqual({ app_name: "Armadra" });
    expect(contexts.os).toEqual({ name: "macOS", version: "15" });
    expect(out.environment).toBe("production");
  });

  it("栈帧没有局部变量与源码行，路径里没有用户名", () => {
    const frame = (
      out.exception as {
        values: { stacktrace: { frames: Record<string, unknown>[] } }[];
      }
    ).values[0]!.stacktrace.frames[0]!;
    expect(frame).toEqual({
      filename: "~/Armadra/out/main/index.js",
      abs_path: "~/Armadra/out/main/index.js",
      function: "load",
      lineno: 3,
    });
  });

  it("异常值截断，面包屑去掉控制台 / 网络两类与全部 data", () => {
    const value = (out.exception as { values: { value: string }[] }).values[0]!
      .value;
    expect(value.length).toBeLessThanOrEqual(301);
    expect(value.startsWith("ENOENT: open '~/notes/")).toBe(true);
    expect(out.breadcrumbs).toEqual([
      {
        category: "electron",
        level: "info",
        timestamp: 3,
        message: "app.ready ~",
      },
    ]);
  });

  it("任何地方都不剩秘密、家目录与终端输出", () => {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("npm test");
    expect(text).not.toContain("file body");
    expect(text).not.toContain("secret.txt");
    // 原对象不被改动。
    expect(event.user).toBeDefined();
  });

  it("单条面包屑：网络类整条丢掉", () => {
    expect(scrubBreadcrumb({ category: "fetch", message: "x" }, context)).toBe(
      null,
    );
    expect(scrubBreadcrumb({ type: "http", category: "x" }, context)).toBe(
      null,
    );
  });
});

describe("DSN", () => {
  it("只认 http(s)://公钥@主机/项目", () => {
    expect(parseDsn("http://abc@127.0.0.1:8000/1")).toBe(
      "http://abc@127.0.0.1:8000/1",
    );
    expect(parseDsn(" https://k@sentry.example.com/api/2 ")).toBe(
      "https://k@sentry.example.com/api/2",
    );
    for (const bad of [
      "",
      "not a url",
      "https://sentry.example.com/1",
      "ftp://k@host/1",
      "https://k@host/",
      "https://k@host/1?x=1",
    ]) {
      expect(parseDsn(bad), bad).toBe(null);
    }
  });

  it("从设置文档读，坏文档与空值都是 null", () => {
    expect(
      dsnFromSettings(
        JSON.stringify({ diagnostics: { crashReportDsn: "http://k@h/1" } }),
      ),
    ).toBe("http://k@h/1");
    expect(dsnFromSettings(JSON.stringify({ diagnostics: {} }))).toBe(null);
    expect(dsnFromSettings("{not json")).toBe(null);
    expect(dsnFromSettings(null)).toBe(null);
  });
});

describe("core → 壳的消息", () => {
  it("剥离后再交出去，重建出的错误保留名字与栈", () => {
    const error = new TypeError(`bad ${SECRET} in /Users/alice/x`);
    const message = crashReportMessage(error, "http", context);
    expect(message.type).toBe(CRASH_REPORT_MESSAGE);
    expect(message.message).toBe("bad [env] in ~/x");
    expect(message.stack).not.toContain(SECRET);
    expect(isCrashReportMessage(message)).toBe(true);
    const rebuilt = errorFromMessage(message);
    expect(rebuilt.name).toBe("TypeError");
    expect(rebuilt.message).toBe("bad [env] in ~/x");
  });

  it("非 Error 也能报；来源不在表里的消息不认", () => {
    expect(crashReportMessage("boom", "uncaught", context).message).toBe(
      "boom",
    );
    expect(
      isCrashReportMessage({
        ...crashReportMessage("x", "http", context),
        source: "other",
      }),
    ).toBe(false);
    expect(isCrashReportMessage({ type: "secrets" })).toBe(false);
  });
});

describe("Armadra 自己的形状（安全审查 L6）", () => {
  const empty = scrubContext({}, "");
  const session = `${"0f".repeat(16)}.${"AbC_-x".repeat(7)}Z`;

  it("会话 / 刷新 / 配对票 `<32 位十六进制>.<43 位 base64url>` 整段换掉", () => {
    expect(session).toHaveLength(76);
    expect(scrubText(`refresh ${session} expired`, empty)).toBe(
      "refresh [redacted] expired",
    );
    expect(scrubText(`"${session}"`, empty)).toBe('"[redacted]"');
    // 不是这个形状的不动：短一位、十六进制段不是小写十六进制。
    const shorter = session.slice(0, -1);
    expect(scrubText(shorter, empty)).toBe(shorter);
    const upper = `${"0F".repeat(16)}.${"A".repeat(43)}`;
    expect(scrubText(upper, empty)).toBe(upper);
  });

  it("地址片段（`#pair=` 配对票）换掉", () => {
    expect(
      scrubText("open https://gw.test:8443/#pair=abc&fp=def now", empty),
    ).toBe("open https://gw.test:8443/#[redacted] now");
  });

  it("页面来源是一个合法的错误来源", () => {
    const message = crashReportMessage(new Error("x"), "page", empty);
    expect(isCrashReportMessage(message)).toBe(true);
  });
});

describe("pageErrorsFromSettings", () => {
  it("只有字面量 true 算开", () => {
    expect(
      pageErrorsFromSettings(
        JSON.stringify({ diagnostics: { reportPageErrors: true } }),
      ),
    ).toBe(true);
    expect(
      pageErrorsFromSettings(
        JSON.stringify({ diagnostics: { reportPageErrors: "true" } }),
      ),
    ).toBe(false);
    expect(pageErrorsFromSettings("{}")).toBe(false);
    expect(pageErrorsFromSettings("not json")).toBe(false);
    expect(pageErrorsFromSettings(null)).toBe(false);
  });
});
