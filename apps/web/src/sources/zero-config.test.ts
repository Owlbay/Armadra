import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runtimeApi } from "../api/client";
import { request } from "../api/request";
import { terminalWebSocketUrl, workspaceEventsUrl } from "../api/sockets";
import {
  currentSource,
  installLocalTransport,
  knownSources,
  localSource,
} from "../api/source";
import { resetSourceRegistry, sourceRegistry } from "./registry";

/**
 * 零配置（平台设计 §17.6）：没挂任何远程源时，页面的行为与没有源层时逐字
 * 相同——只连本机、不多发一个请求、不改写全局的 `fetch` / `WebSocket`。
 */

let fetch: ReturnType<typeof vi.fn>;
const NativeWebSocket = globalThis.WebSocket;

beforeEach(() => {
  fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, json: { workspaces: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  installLocalTransport(null);
  resetSourceRegistry();
});

describe("零配置", () => {
  it("当前源就是本机源；建页面源表不发请求、不换当前源", async () => {
    expect(currentSource()).toBe(localSource);
    const registry = sourceRegistry();
    expect(registry.list()).toHaveLength(1);
    expect(registry.current().source).toBe(localSource);
    expect(currentSource()).toBe(localSource);
    await registry.local().connect();
    expect(fetch).not.toHaveBeenCalled();
    expect(knownSources()).toEqual([localSource]);
  });

  it("request() 发往本机地址，浏览器里不带凭据", async () => {
    sourceRegistry();
    await request("/api/settings", z.object({ ok: z.boolean() }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${localSource.httpBase}/api/settings`);
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("RPC 门面发往本机 /api/rpc", async () => {
    sourceRegistry();
    await runtimeApi.listWorkspaces().catch(() => undefined);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `${localSource.httpBase}/api/rpc/workspaces/list`,
    );
  });

  it("流的地址取本机源的 wsBase", () => {
    expect(terminalWebSocketUrl("t1")).toBe(
      `${localSource.wsBase.replace(/^http/, "ws")}/api/terminals/t1/ws`,
    );
    expect(workspaceEventsUrl("w", "now")).toBe(
      `${localSource.wsBase.replace(/^http/, "ws")}/api/workspaces/w/events?cursor=now`,
    );
  });

  it("本机源装 Bearer（桌面壳、原生 App）不改写全局 fetch / WebSocket", async () => {
    const before = globalThis.fetch;
    const origin = new URL(localSource.httpBase).origin;
    installLocalTransport({
      origin,
      authorization: () => "TOKEN",
      wsTicket: async () => "T",
      refresh: async () => false,
    });
    expect(globalThis.fetch).toBe(before);
    expect(globalThis.WebSocket).toBe(NativeWebSocket);
    await localSource.fetch(`${localSource.httpBase}/api/x`);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer TOKEN");
    await globalThis.fetch(`${localSource.httpBase}/api/x`);
    expect(fetch.mock.calls[1]![1]).toBeUndefined();
  });
});
