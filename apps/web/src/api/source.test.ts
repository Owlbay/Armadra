import { describe, expect, it } from "vitest";

import { type Source, sourceForUrl } from "./source";

function source(sourceId: string, httpBase: string): Source {
  return {
    sourceId,
    httpBase,
    wsBase: httpBase.replace(/^http/, "ws"),
    credentials: {
      mode: "bearer",
      access: async () => null,
      renew: async () => false,
      csrf: async () => null,
      renewCsrf: async () => null,
    },
    fetch: (input, init) => globalThis.fetch(input, init),
    WebSocket: globalThis.WebSocket,
  };
}

describe("sourceForUrl", () => {
  const RELAY = "https://relay.example:8443";
  const a = source("a", `${RELAY}/s/${"a".repeat(32)}`);
  const b = source("b", `${RELAY}/s/${"b".repeat(32)}`);
  const local = source("local", "http://127.0.0.1:4100");
  const all = [a, b, local];

  it("同一个中继上的两个源按路径前缀分开（多源并存经中继）", () => {
    expect(
      sourceForUrl(`${RELAY}/s/${"b".repeat(32)}/api/media/T`, all)?.sourceId,
    ).toBe("b");
    expect(
      sourceForUrl(`wss://relay.example:8443/s/${"a".repeat(32)}/api/ws`, all)
        ?.sourceId,
    ).toBe("a");
    expect(sourceForUrl(`${RELAY}/s/${"c".repeat(32)}/api/x`, all)).toBeNull();
    // 前缀要按段比：`…/s/aaaa…x` 不是 `…/s/aaaa…` 的。
    expect(sourceForUrl(`${RELAY}/s/${"a".repeat(32)}x/api`, all)).toBeNull();
  });

  it("源地址没有路径时按来源比；来源不同不算", () => {
    expect(
      sourceForUrl("http://127.0.0.1:4100/api/health", all)?.sourceId,
    ).toBe("local");
    expect(sourceForUrl("ws://127.0.0.1:4100/api/ws", all)?.sourceId).toBe(
      "local",
    );
    expect(sourceForUrl("http://127.0.0.1:4200/api/health", all)).toBeNull();
    expect(sourceForUrl("not a url", all)).toBeNull();
  });

  it("中继自己的托管页面与挂在它上面的源都对得上时取前缀最长的", () => {
    const hosted = source("hosted", RELAY);
    expect(
      sourceForUrl(`${RELAY}/s/${"b".repeat(32)}/api/x`, [hosted, b])?.sourceId,
    ).toBe("b");
    expect(sourceForUrl(`${RELAY}/v1/me`, [hosted, b])?.sourceId).toBe(
      "hosted",
    );
  });
});
