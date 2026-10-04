import { describe, expect, it, vi } from "vitest";

import { IdentityRequestError, IdentityTransportError } from "../api/identity";
import {
  connectNative,
  connectWeb,
  connectWithCode,
  failureOf,
} from "./connect";
import type { NativeBridge } from "./native-bridge";

const FP = "ab".repeat(32);
const LINK = `https://192.168.1.8:8443/#pair=tk.secret&fp=${FP}`;

function deps(overrides: Partial<NativeBridge> = {}) {
  const bridge = {
    available: true,
    canScan: true,
    loadSession: vi.fn(),
    saveSession: vi.fn(),
    clearSession: vi.fn(),
    pin: vi.fn(async () => undefined),
    scan: vi.fn(),
    pushRegistration: vi.fn(),
    ...overrides,
  } as unknown as NativeBridge;
  return {
    bridge,
    pair: vi.fn(async () => ({}) as never),
    save: vi.fn(),
    reload: vi.fn(),
  };
}

describe("原生 App 连接", () => {
  it("钉扎 → 配对 → 记下来源 → 重载，顺序不能乱", async () => {
    const order: string[] = [];
    const d = deps({
      pin: vi.fn(async () => {
        order.push("pin");
      }),
    });
    d.pair.mockImplementation(async () => {
      order.push("pair");
      return {} as never;
    });
    d.save.mockImplementation(() => order.push("save"));
    d.reload.mockImplementation(() => order.push("reload"));
    await expect(connectNative(LINK, d)).resolves.toBeNull();
    expect(order).toEqual(["pin", "pair", "save", "reload"]);
    expect(d.bridge.pin).toHaveBeenCalledWith("https://192.168.1.8:8443", FP);
    expect(d.pair).toHaveBeenCalledWith(
      "https://192.168.1.8:8443",
      "tk.secret",
    );
    expect(d.save).toHaveBeenCalledWith("https://192.168.1.8:8443");
  });

  it("深链同样认", async () => {
    const d = deps();
    await connectNative(
      `armadra://pair?host=10.0.0.2:9000&ticket=abc&fp=${FP}`,
      d,
    );
    expect(d.pair).toHaveBeenCalledWith("https://10.0.0.2:9000", "abc");
  });

  it("认不出、缺指纹、钉不上、过期、连不上各有各的原因", async () => {
    expect(await connectNative("hello", deps())).toBe("invalid");
    expect(await connectNative("https://h:1/#pair=abc", deps())).toBe(
      "noFingerprint",
    );
    expect(
      await connectNative(
        LINK,
        deps({ pin: vi.fn(async () => Promise.reject(new Error("x"))) }),
      ),
    ).toBe("pin");
    const expired = deps();
    expired.pair.mockRejectedValue(new IdentityRequestError(401, "x", ""));
    expect(await connectNative(LINK, expired)).toBe("expired");
    expect(expired.save).not.toHaveBeenCalled();
    expect(expired.reload).not.toHaveBeenCalled();
    const offline = deps();
    offline.pair.mockRejectedValue(new IdentityTransportError());
    expect(await connectNative(LINK, offline)).toBe("unreachable");
  });
});

describe("手机浏览器连接", () => {
  it("用地址栏带来的票配对", async () => {
    const pair = vi.fn(async () => ({}) as never);
    await expect(connectWeb("tk.secret", pair)).resolves.toBeNull();
    expect(pair).toHaveBeenCalledWith("tk.secret");
  });

  it("票没了或被拒是「已失效」", async () => {
    expect(await connectWeb("", vi.fn())).toBe("expired");
    const pair = vi.fn(async () => {
      throw new IdentityRequestError(403, "x", "");
    });
    expect(await connectWeb("t", pair)).toBe("expired");
    expect(failureOf(new Error("?"))).toBe("failed");
  });
});

describe("配对码连接（契约 §24）", () => {
  const ORIGIN = "https://192.168.1.8:8443";
  const payload = {
    origin: ORIGIN,
    ticket: "tk.secret",
    fingerprint: FP,
    expiresAt: "2026-10-03T08:02:00.000Z",
    webUrl: `${ORIGIN}/#pair=tk.secret&fp=${FP}`,
    deepLink: `armadra://pair?host=192.168.1.8%3A8443&ticket=tk.secret&fp=${FP}`,
  };

  it("手机浏览器：换票后用票配对", async () => {
    const exchange = vi.fn(async () => payload);
    const pairWeb = vi.fn(async () => ({}) as never);
    await expect(
      connectWithCode("3F7K9Q2M", { mode: "web" }, { exchange, pairWeb }),
    ).resolves.toBeNull();
    expect(exchange).toHaveBeenCalledWith("3F7K9Q2M");
    expect(pairWeb).toHaveBeenCalledWith("tk.secret");
  });

  it("原生 App：对记下的来源换票，再钉指纹、配对、记下、重载", async () => {
    const d = deps();
    const exchange = vi.fn(async () => payload);
    await expect(
      connectWithCode(
        "3F7K9Q2M",
        { mode: "native", origin: ORIGIN },
        { exchange, native: d },
      ),
    ).resolves.toBeNull();
    expect(exchange).toHaveBeenCalledWith("3F7K9Q2M", ORIGIN);
    expect(d.bridge.pin).toHaveBeenCalledWith(ORIGIN, FP);
    expect(d.pair).toHaveBeenCalledWith(ORIGIN, "tk.secret");
    expect(d.save).toHaveBeenCalledWith(ORIGIN);
    expect(d.reload).toHaveBeenCalled();
  });

  it("票绑的来源与记下的不同：不钉不配", async () => {
    const d = deps();
    await expect(
      connectWithCode(
        "3F7K9Q2M",
        { mode: "native", origin: "https://other:8443" },
        { exchange: async () => payload, native: d },
      ),
    ).resolves.toBe("failed");
    expect(d.bridge.pin).not.toHaveBeenCalled();
  });

  it("换票的拒绝各有原因", async () => {
    const cases: [unknown, string][] = [
      [
        new IdentityRequestError(404, "pairing_code_invalid", ""),
        "codeInvalid",
      ],
      [
        new IdentityRequestError(403, "pairing_code_disabled", ""),
        "codeDisabled",
      ],
      [new IdentityRequestError(409, "origin_mismatch", ""), "codeOrigin"],
      [new IdentityRequestError(429, "rate_limited", "", 30), "rateLimited"],
      [new IdentityTransportError(), "unreachable"],
    ];
    for (const [error, reason] of cases) {
      await expect(
        connectWithCode(
          "3F7K9Q2M",
          { mode: "web" },
          {
            exchange: async () => {
              throw error;
            },
          },
        ),
      ).resolves.toBe(reason);
    }
  });
});
