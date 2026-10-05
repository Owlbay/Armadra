import { afterEach, describe, expect, it, vi } from "vitest";

import { localSource } from "../api/source";
import {
  ACCESS_RENEW_LEAD_MS,
  createCachedCredentialProvider,
  createDesktopCredentialProvider,
  exchangeViaLocalCore,
} from "./credentials";
import { createSessionTokens } from "./session-tokens";
import type { SourceAccess, Via } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

const access = (token: string, expiresAtMs = 0): SourceAccess => ({
  accessToken: token,
  expiresAtMs,
  httpBase: "https://a.example",
  wsBase: "wss://a.example",
});

describe("按源缓存的凭据来源", () => {
  it("同一个源同一条路：复用；并发只换一次；refresh 不看缓存", async () => {
    let n = 0;
    const exchange = vi.fn(async (_id: string, _via: Via) => access(`t${++n}`));
    const provider = createCachedCredentialProvider(exchange);
    const [a, b] = await Promise.all([
      provider.getAccess("s", "direct"),
      provider.getAccess("s", "direct"),
    ]);
    expect(a.accessToken).toBe("t1");
    expect(b.accessToken).toBe("t1");
    await expect(provider.getAccess("s", "direct")).resolves.toMatchObject({
      accessToken: "t1",
    });
    expect(exchange).toHaveBeenCalledTimes(1);
    await expect(provider.refresh("s", "direct")).resolves.toMatchObject({
      accessToken: "t2",
    });
    // 换了路就不是同一份。
    await expect(provider.getAccess("s", "relayed")).resolves.toMatchObject({
      accessToken: "t3",
    });
    provider.invalidate("s");
    await expect(provider.getAccess("s", "relayed")).resolves.toMatchObject({
      accessToken: "t4",
    });
    // 别的源各是各的。
    await expect(provider.getAccess("other", "direct")).resolves.toMatchObject({
      accessToken: "t5",
    });
  });

  it("快到期的先换", async () => {
    let clock = 1_000_000;
    let n = 0;
    const provider = createCachedCredentialProvider(
      async () => access(`t${++n}`, clock + 60_000),
      () => clock,
    );
    await provider.getAccess("s", "direct");
    clock += 60_000 - ACCESS_RENEW_LEAD_MS + 1;
    await expect(provider.getAccess("s", "direct")).resolves.toMatchObject({
      accessToken: "t2",
    });
  });

  it("换失败不留缓存，下次再试", async () => {
    const exchange = vi
      .fn<(id: string, via: Via) => Promise<SourceAccess>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(access("t"));
    const provider = createCachedCredentialProvider(exchange);
    await expect(provider.getAccess("s", "direct")).rejects.toThrow("offline");
    await expect(provider.getAccess("s", "direct")).resolves.toMatchObject({
      accessToken: "t",
    });
  });
});

describe("桌面：经本机 core 换票", () => {
  it("POST /api/sources/{id}/session { via }，经本机源发；只拿访问令牌", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            accessToken: "A",
            accessExpiresAtMs: 5,
            httpBase: "https://relay.example/s/x/",
            wsBase: "wss://relay.example/s/x/",
            via: "relayed",
            relayToken: "RT",
            relayTokenExpiresAtMs: 9,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = createDesktopCredentialProvider();
    await expect(provider.getAccess("x/1", "relayed")).resolves.toEqual({
      accessToken: "A",
      expiresAtMs: 5,
      httpBase: "https://relay.example/s/x",
      wsBase: "wss://relay.example/s/x",
      relayToken: "RT",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${localSource.httpBase}/api/sources/x%2F1/session`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ via: "relayed" });
  });

  it("core 拒了（source_unauthorized）照原样抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "source_unauthorized", message: "no" }),
            { status: 401 },
          ),
      ),
    );
    await expect(exchangeViaLocalCore("x", "direct")).rejects.toMatchObject({
      status: 401,
      code: "source_unauthorized",
    });
  });
});

describe("会话令牌", () => {
  it("每个源一份，清掉只清自己", () => {
    const a = createSessionTokens();
    const b = createSessionTokens();
    a.access = "A";
    a.refresh = "R";
    a.accessExpiresAt = 1;
    b.access = "B";
    a.clear();
    expect(a).toMatchObject({ access: "", refresh: "", accessExpiresAt: 0 });
    expect(b.access).toBe("B");
  });
});
