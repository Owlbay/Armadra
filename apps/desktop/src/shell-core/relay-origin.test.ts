import { describe, expect, it } from "vitest";

import { NATIVE_APP_ORIGINS } from "../core/gateway/admission";
import {
  DESKTOP_RELAY_ORIGIN,
  relayOriginOf,
  rewriteRelayRequest,
  rewriteRelayResponse,
} from "./relay-origin";
import { trustFromSourceTable } from "./remote-trust";

/**
 * 桌面页面经中继访问源：只改源表里中继主机的请求的 `Origin`，响应的 CORS 头
 * 回显页面来源。
 */

const PAGE = "http://127.0.0.1:53111";
const RELAY = "https://relay.test:8102";
const relays = trustFromSourceTable({
  sources: [
    { sourceId: "local", kind: "local" },
    { sourceId: "far", kind: "relayed", relayOrigin: RELAY },
    { sourceId: "peer", kind: "direct", baseUrl: "https://10.0.0.2:8443" },
  ],
}).relayOrigins;

describe("改写 Origin", () => {
  it("源表里只有中继来源进改写名单", () => {
    expect(relays).toEqual([RELAY]);
  });

  it("桌面的原生来源就是 core 已认的原生 App 来源之一", () => {
    expect(NATIVE_APP_ORIGINS).toContain(DESKTOP_RELAY_ORIGIN);
  });

  it("发往中继主机（HTTP 与 WebSocket）的请求换成原生来源，记下页面来源", () => {
    for (const url of [
      `${RELAY}/s/abc/api/workspaces`,
      "wss://relay.test:8102/s/abc/api/ws",
    ]) {
      const rewritten = rewriteRelayRequest(
        url,
        { origin: PAGE, Authorization: "Bearer t" },
        relays,
      );
      expect(rewritten).toEqual({
        headers: { Origin: DESKTOP_RELAY_ORIGIN, Authorization: "Bearer t" },
        pageOrigin: PAGE,
      });
    }
  });

  it("别处一律不动：别的主机、别的端口、直连的源、没带 Origin 的", () => {
    for (const url of [
      "https://relay.test/s/abc/api/workspaces",
      "https://relay.test:9999/s/abc",
      "https://10.0.0.2:8443/api/workspaces",
      "http://127.0.0.1:43120/api/workspaces",
      "https://example.com/",
    ])
      expect(rewriteRelayRequest(url, { Origin: PAGE }, relays)).toBeNull();
    expect(
      rewriteRelayRequest(`${RELAY}/s/abc`, { accept: "*/*" }, relays),
    ).toBeNull();
    expect(
      rewriteRelayRequest(`${RELAY}/s/abc`, { Origin: PAGE }, []),
    ).toBeNull();
  });

  it("源表变了：名单跟着换", () => {
    const next = trustFromSourceTable({ sources: [] }).relayOrigins;
    expect(
      rewriteRelayRequest(`${RELAY}/s/abc`, { Origin: PAGE }, next),
    ).toBeNull();
  });

  it("地址到来源：wss 当 https，别的协议不认", () => {
    expect(relayOriginOf("wss://relay.test:8102/s/x")).toBe(RELAY);
    expect(relayOriginOf("http://relay.test:8102/")).toBe("");
    expect(relayOriginOf("not a url")).toBe("");
  });
});

describe("回 CORS 头", () => {
  it("允许来源换回页面来源，补 Vary: Origin（不重复）", () => {
    expect(
      rewriteRelayResponse(
        {
          "access-control-allow-origin": [DESKTOP_RELAY_ORIGIN],
          vary: ["accept-encoding"],
          "content-type": ["application/json"],
        },
        PAGE,
      ),
    ).toEqual({
      "Access-Control-Allow-Origin": [PAGE],
      Vary: ["accept-encoding, Origin"],
      "content-type": ["application/json"],
    });
    expect(
      rewriteRelayResponse(
        { "Access-Control-Allow-Origin": "x", Vary: "origin" },
        PAGE,
      ),
    ).toEqual({ "Access-Control-Allow-Origin": [PAGE], Vary: ["origin"] });
  });

  it("对端没放行（没有允许来源）就不替它放行", () => {
    expect(
      rewriteRelayResponse({ "content-type": ["text/plain"] }, PAGE),
    ).toBeNull();
  });
});
