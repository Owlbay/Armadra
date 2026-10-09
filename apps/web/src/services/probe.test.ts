import { describe, expect, it, vi } from "vitest";

import { createServiceProbe } from "./probe";
import type { ServiceRow } from "./rows";

const ISSUER = "https://relay.example.com";
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function direct(sourceId: string): ServiceRow {
  return {
    sourceId,
    name: sourceId,
    local: false,
    routes: [{ via: "direct", issuer: "", serviceName: "" }],
    lastUsedAt: null,
  };
}

function relayed(sourceId: string, issuer = ISSUER): ServiceRow {
  return {
    sourceId,
    name: sourceId,
    local: false,
    routes: [{ via: "relayed", issuer, serviceName: "relay" }],
    lastUsedAt: null,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("选择页的在线探测", () => {
  it("直连：hello 答的是这台算在线；答别的、超时都是离线", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://a.lan")) return json({ hostId: A });
        if (url.startsWith("https://b.lan")) return json({ hostId: "other" });
        // c 永远不答：等到超时被取消。
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      });
      const bases: Record<string, string> = {
        [A]: "https://a.lan",
        [B]: "https://b.lan",
        [C]: "https://c.lan",
      };
      const probe = createServiceProbe((id) => bases[id] ?? "", {
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      const pending = probe.probe([direct(A), direct(B), direct(C)]);
      await vi.advanceTimersByTimeAsync(1600);
      const result = await pending;
      expect(result.statuses).toEqual({
        [A]: "online",
        [B]: "offline",
        [C]: "offline",
      });
      expect(fetch.mock.calls[0]![0]).toBe("https://a.lan/api/identity/hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("中继：每个远程服务只问一次目录，online 覆盖这个服务下的全部源", async () => {
    const fetch = vi.fn(async () =>
      json({
        sources: [
          { sourceId: A, name: "a", online: true },
          { sourceId: B, name: "b", online: false },
        ],
      }),
    );
    const access = vi.fn(async () => "token");
    const probe = createServiceProbe(() => "", {
      fetch: fetch as unknown as typeof globalThis.fetch,
      cloudAuth: { access },
    });
    const result = await probe.probe([relayed(A), relayed(B), relayed(C)]);
    expect(result.statuses).toEqual({
      [A]: "online",
      [B]: "offline",
      [C]: "offline",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledWith(ISSUER);
    expect(result.signedOut).toEqual([]);
  });

  it("中继登录失效：那一组已登出，组里的行状态未知；网络断了只是未知", async () => {
    const OTHER = "https://other.example.com";
    const access = vi.fn(async (issuer: string) => {
      if (issuer === ISSUER)
        throw Object.assign(new Error("denied"), { status: 401 });
      throw new TypeError("network down");
    });
    const probe = createServiceProbe(() => "", { cloudAuth: { access } });
    const result = await probe.probe([relayed(A), relayed(B, OTHER)]);
    expect(result.statuses).toEqual({ [A]: "unknown", [B]: "unknown" });
    expect(result.signedOut).toEqual([ISSUER]);
  });

  it("一台有两条路：任一条在线就在线", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/api/identity/hello")
        ? json({ hostId: "nope" })
        : json({ sources: [{ sourceId: A, name: "a", online: true }] }),
    );
    const probe = createServiceProbe(() => "https://a.lan", {
      fetch: fetch as unknown as typeof globalThis.fetch,
      cloudAuth: { access: async () => "token" },
    });
    const row: ServiceRow = {
      ...direct(A),
      routes: [
        { via: "direct", issuer: "", serviceName: "" },
        { via: "relayed", issuer: ISSUER, serviceName: "relay" },
      ],
    };
    expect((await probe.probe([row])).statuses[A]).toBe("online");
  });

  it("最多三个并发", async () => {
    let running = 0;
    let peak = 0;
    const fetch = vi.fn(async (url: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return json({ hostId: new URL(url).hostname.split(".")[0] });
    });
    const ids = ["h1", "h2", "h3", "h4", "h5", "h6"];
    const probe = createServiceProbe((id) => `https://${id}.lan`, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const result = await probe.probe(ids.map(direct));
    expect(peak).toBe(3);
    expect(Object.values(result.statuses)).toEqual(ids.map(() => "online"));
  });

  it("结果缓存 30 秒；过期后再问", async () => {
    let now = 1_000;
    const fetch = vi.fn(async () => json({ hostId: A }));
    const probe = createServiceProbe(() => "https://a.lan", {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
    });
    await probe.probe([direct(A)]);
    now += 29_000;
    await probe.probe([direct(A)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 2_000;
    await probe.probe([direct(A)]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("没给远程服务的访问：中继的行未知，不发请求", async () => {
    const fetch = vi.fn();
    const probe = createServiceProbe(() => "", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect((await probe.probe([relayed(A)])).statuses[A]).toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});
