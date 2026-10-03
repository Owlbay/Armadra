import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityRefusal, identityFailure } from "./errors";
import { type HibpFixture, startHibp } from "./hibp.fixture";
import {
  checkBreach,
  resolveBreachMode,
  commonPasswords,
  effectiveMinLength,
  enforcePasswordPolicy,
  passwordViolation,
} from "./policy";

describe("口令策略", () => {
  it("随包的常见口令表有一万条，注释行不算", () => {
    const list = commonPasswords();
    expect(list.size).toBe(10_000);
    expect(list.has("password123")).toBe(true);
    expect([...list].some((entry) => entry.startsWith("#"))).toBe(false);
  });

  it("长度按码点数，下限可配 10–64、越界夹回", () => {
    expect(effectiveMinLength(undefined)).toBe(12);
    expect(effectiveMinLength(4)).toBe(10);
    expect(effectiveMinLength(99)).toBe(64);
    expect(effectiveMinLength(12.5)).toBe(12);
    expect(passwordViolation("短短短短短短短短短短短", {})).toBe(
      "password_too_short",
    );
    expect(passwordViolation("长长长长长长长长长长长长", {})).toBeUndefined();
    expect(passwordViolation("ten chars!", { minLength: 10 })).toBeUndefined();
    expect(passwordViolation("ten chars!", {})).toBe("password_too_short");
  });

  it("不得含账号名，不分大小写；三个字符以下的名字不参与", () => {
    expect(passwordViolation("my-Alice-is-long", { names: ["alice"] })).toBe(
      "password_contains_name",
    );
    expect(
      passwordViolation("ab-is-long-enough", { names: ["ab"] }),
    ).toBeUndefined();
  });

  it("常见口令按小写精确比对", () => {
    expect(passwordViolation("Password123", { minLength: 10 })).toBe(
      "password_too_common",
    );
    expect(passwordViolation("QwertyUIOP", { minLength: 10 })).toBe(
      "password_too_common",
    );
    expect(passwordViolation("correct horse battery", {})).toBeUndefined();
  });

  it("拒绝是 400，code 就是规则名", () => {
    let caught: unknown;
    try {
      enforcePasswordPolicy("password1234", { minLength: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityRefusal);
    expect(identityFailure(caught)).toMatchObject({
      status: 400,
      code: "password_too_common",
    });
  });
});

describe("泄露检查（HIBP k-匿名）", () => {
  let fixture: HibpFixture;
  const requests: { url: string; padding: string | null }[] = [];
  const recording: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), padding: headers.get("add-padding") });
    return fetch(input, init);
  };

  beforeAll(async () => {
    fixture = await startHibp();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it("关着时不发请求", async () => {
    requests.length = 0;
    await expect(
      checkBreach("password", {
        mode: "off",
        base: fixture.base,
        fetch: recording,
      }),
    ).resolves.toBe("skipped");
    expect(requests).toEqual([]);
  });

  it("只发 SHA-1 前 5 位、带 Add-Padding；命中与未命中", async () => {
    requests.length = 0;
    await expect(
      checkBreach("armadra-pwned-fixture", {
        mode: "warn",
        base: fixture.base,
        fetch: recording,
      }),
    ).resolves.toBe("breached");
    await expect(
      checkBreach("a distinctly unbreached phrase 42", {
        mode: "block",
        base: fixture.base,
        fetch: recording,
      }),
    ).resolves.toBe("clean");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.padding).toBe("true");
      expect(request.url).toMatch(/\/range\/[0-9A-F]{5}$/);
      // 请求里没有口令，也没有完整哈希。
      expect(request.url).not.toContain("pwned");
    }
  });

  it("填充行（次数 0）不算命中", async () => {
    const body = Array.from(
      { length: 3 },
      (_, index) => `${String(index).padStart(35, "0")}:0`,
    ).join("\r\n");
    const padded: typeof fetch = async () => new Response(body);
    // 找一个后缀恰好是 0…0 的口令不现实；直接造一份只有填充行的答案，再让
    // 命中的那行次数为 0。
    const suffixOf = async (password: string) => {
      const { createHash } = await import("node:crypto");
      return createHash("sha1")
        .update(password)
        .digest("hex")
        .toUpperCase()
        .slice(5);
    };
    const suffix = await suffixOf("zero count padding line");
    const zero: typeof fetch = async () =>
      new Response(`${suffix}:0\r\n${body}`);
    await expect(
      checkBreach("zero count padding line", { mode: "warn", fetch: zero }),
    ).resolves.toBe("clean");
    await expect(
      checkBreach("zero count padding line", { mode: "warn", fetch: padded }),
    ).resolves.toBe("clean");
  });

  it("离线、超时、非 200、认不出的答案都是 unknown", async () => {
    await expect(
      checkBreach("password", { mode: "block", base: "http://127.0.0.1:9" }),
    ).resolves.toBe("unknown");
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      });
    await expect(
      checkBreach("password", { mode: "warn", fetch: hang, timeoutMs: 20 }),
    ).resolves.toBe("unknown");
    const failing: typeof fetch = async () =>
      new Response("busy", { status: 503 });
    await expect(
      checkBreach("password", { mode: "warn", fetch: failing }),
    ).resolves.toBe("unknown");
    const garbage: typeof fetch = async () => new Response("<html></html>");
    await expect(
      checkBreach("password", { mode: "warn", fetch: garbage }),
    ).resolves.toBe("unknown");
  });

  it("auto：服务器壳与开了 Gateway 的桌面按 warn，其余 off", () => {
    expect(resolveBreachMode("auto", true)).toBe("warn");
    expect(resolveBreachMode("auto", false)).toBe("off");
    expect(resolveBreachMode("block", false)).toBe("block");
    expect(resolveBreachMode("off", true)).toBe("off");
    expect(resolveBreachMode("bogus", true)).toBe("warn");
  });
});
