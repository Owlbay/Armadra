import { afterEach, describe, expect, it, vi } from "vitest";

import { probeRelay } from "./relay-status";

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (status: number, body: unknown) =>
  vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  }));

describe("中继还连得上吗", () => {
  it("平台信息答了、或中继自己拒了：连得上", async () => {
    vi.stubGlobal(
      "fetch",
      answer(200, { mode: "personal", issuer: "https://relay.example" }),
    );
    await expect(probeRelay("https://relay.example")).resolves.toBe(true);
    vi.stubGlobal("fetch", answer(404, { code: "not_found", message: "" }));
    await expect(probeRelay("https://relay.example")).resolves.toBe(true);
  });

  it("连不上、或前面的代理答 502–504：中继停了", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(probeRelay("https://relay.example")).resolves.toBe(false);
    vi.stubGlobal("fetch", answer(502, null));
    await expect(probeRelay("https://relay.example")).resolves.toBe(false);
  });
});
