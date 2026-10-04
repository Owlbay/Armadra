import { describe, expect, it } from "vitest";
import type { PairingTicket } from "./pairing";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_GLOBAL_CAPACITY,
  PAIRING_CODE_LIMIT,
  PairingCodes,
  formatPairingCode,
  newPairingCode,
  normalizePairingCode,
  pairingCodesOpen,
} from "./pairing-code";

function ticket(expiresAtMs: number, origin = "https://192.168.1.20:8443") {
  return {
    ticket: `${"a".repeat(32)}.${"b".repeat(43)}`,
    expiresAtMs,
    origin,
    fingerprint: "f".repeat(64),
    webUrl: `${origin}/#pair=x`,
    deepLink: "armadra://pair?host=x&ticket=x&fp=x",
  } satisfies PairingTicket;
}

describe("配对短码", () => {
  it("字母表是 [A-Z2-9]，8 位，显示成 XXXX-XXXX", () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(34);
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01]/);
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const code = newPairingCode();
      expect(code).toMatch(/^[A-Z2-9]{8}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(500);
    expect(formatPairingCode("3F7K9Q2M")).toBe("3F7K-9Q2M");
  });

  it("输入时大小写、连字符与空格都不算；0 / 1 / 长度不对是无效", () => {
    expect(normalizePairingCode("3f7k-9q2m")).toBe("3F7K9Q2M");
    expect(normalizePairingCode(" 3F7K 9Q2M ")).toBe("3F7K9Q2M");
    expect(normalizePairingCode("3F7K9Q20")).toBeUndefined();
    expect(normalizePairingCode("3F7K9Q21")).toBeUndefined();
    expect(normalizePairingCode("3F7K9Q2")).toBeUndefined();
    expect(normalizePairingCode("3F7K9Q2MM")).toBeUndefined();
  });

  it("一次性：兑过一次再兑是 invalid", () => {
    const now = 1_000;
    const codes = new PairingCodes(() => now);
    const code = codes.issue(ticket(now + 120_000));
    const first = codes.exchange(formatPairingCode(code), "10.0.0.2");
    expect(first.ok).toBe(true);
    expect(codes.exchange(code, "10.0.0.2")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("过期：与票同一时刻失效", () => {
    let now = 1_000;
    const codes = new PairingCodes(() => now);
    const code = codes.issue(ticket(now + 120_000));
    now += 120_000;
    expect(codes.exchange(code, "10.0.0.2").ok).toBe(false);
  });

  it("票已被扫码兑掉：短码跟着作废", () => {
    const codes = new PairingCodes(() => 0);
    const code = codes.issue(ticket(120_000));
    expect(codes.exchange(code, "10.0.0.2", () => "dead")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(codes.exchange(code, "10.0.0.2").ok).toBe(false);
  });

  it("来源对不上：短码留着，换对的来源还能兑", () => {
    const codes = new PairingCodes(() => 0);
    const code = codes.issue(ticket(120_000));
    expect(codes.exchange(code, "10.0.0.2", () => "origin_mismatch")).toEqual({
      ok: false,
      reason: "origin_mismatch",
      origin: "https://192.168.1.20:8443",
    });
    expect(codes.exchange(code, "10.0.0.2").ok).toBe(true);
  });

  it("限流：同一来源猜错 20 次后 429，别的来源不受影响；猜对不扣", () => {
    let now = 0;
    const codes = new PairingCodes(() => now);
    for (let index = 0; index < 20; index += 1) {
      expect(codes.exchange("AAAAAAAA", "10.0.0.9").ok).toBe(false);
    }
    const limited = codes.exchange("AAAAAAAA", "10.0.0.9");
    expect(limited).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((limited as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(
      0,
    );
    // 桶空着时连对的码也不看：撒网的人拿不到「对了」这个信号。
    const code = codes.issue(ticket(120_000));
    expect(codes.exchange(code, "10.0.0.9")).toMatchObject({
      reason: "rate_limited",
    });
    expect(codes.exchange(code, "10.0.0.3").ok).toBe(true);
    now += 60_000;
    expect(codes.exchange("AAAAAAAA", "10.0.0.9")).toMatchObject({
      reason: "invalid",
    });
  });

  it("全局桶：分散来源的撒网也有上限", () => {
    const codes = new PairingCodes(() => 0);
    for (let index = 0; index < PAIRING_CODE_GLOBAL_CAPACITY; index += 1) {
      codes.exchange("AAAAAAAA", `10.1.${index >> 8}.${index & 255}`);
    }
    expect(codes.exchange("AAAAAAAA", "10.9.9.9")).toMatchObject({
      reason: "rate_limited",
    });
  });

  it("同时活着的短码有上限，满了最老的让位", () => {
    const codes = new PairingCodes(() => 0);
    const first = codes.issue(ticket(120_000));
    for (let index = 0; index < PAIRING_CODE_LIMIT; index += 1) {
      codes.issue(ticket(120_000));
    }
    expect(codes.size).toBe(PAIRING_CODE_LIMIT);
    expect(codes.exchange(first, "10.0.0.2").ok).toBe(false);
  });

  it("生成器撞上活着的码时重抽", () => {
    const queue = ["AAAAAAAA", "AAAAAAAA", "BBBBBBBB"];
    const codes = new PairingCodes(
      () => 0,
      () => queue.shift() as string,
    );
    expect(codes.issue(ticket(120_000))).toBe("AAAAAAAA");
    expect(codes.issue(ticket(120_000))).toBe("BBBBBBBB");
  });
});

describe("档位", () => {
  it("私网与回环档开，公网 all 档关；配了对外来源一律关", () => {
    expect(
      pairingCodesOpen({ mode: "private", host: "0.0.0.0", publicOrigins: [] }),
    ).toBe(true);
    expect(
      pairingCodesOpen({
        mode: "loopback",
        host: "127.0.0.1",
        publicOrigins: [],
      }),
    ).toBe(true);
    expect(
      pairingCodesOpen({ mode: "all", host: "0.0.0.0", publicOrigins: [] }),
    ).toBe(false);
    expect(
      pairingCodesOpen({
        mode: "private",
        host: "0.0.0.0",
        publicOrigins: ["https://armadra.example"],
      }),
    ).toBe(false);
    // 服务器壳（缺省 all）绑在私网或回环字面量上时开。
    expect(
      pairingCodesOpen({
        mode: "all",
        host: "192.168.1.20",
        publicOrigins: [],
      }),
    ).toBe(true);
    expect(
      pairingCodesOpen({ mode: "all", host: "127.0.0.1", publicOrigins: [] }),
    ).toBe(true);
    expect(
      pairingCodesOpen({ mode: "all", host: "203.0.113.5", publicOrigins: [] }),
    ).toBe(false);
  });
});
