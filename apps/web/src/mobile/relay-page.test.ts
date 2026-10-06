import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentAccessToken,
  identityHello,
  resetIdentityCredentials,
} from "../api/identity";
import { resetLocalRuntime } from "../api/local-runtime";
import { setRelayPageBase } from "../api/runtime-url";
import { installLocalTransport, localSource } from "../api/source";
import { enterRelayPage } from "./relay-page";
import { routedFetch } from "./testing";

/**
 * 托管页面加入之后的装法（客户端包 §6.1）：本机源指到 `relayBaseUrl`，Bearer +
 * 中继令牌；中继令牌快到期时用访客会话换新。
 */

const ISSUER = "https://relay.example.com";
const HOST = "a".repeat(32);
const BASE = `${ISSUER}/s/${HOST}`;

afterEach(() => {
  setRelayPageBase(null);
  resetLocalRuntime();
  installLocalTransport(null);
  resetIdentityCredentials();
  vi.unstubAllGlobals();
});

function join(relayTokenExpiresAtMs: number) {
  return {
    issuer: ISSUER,
    accepted: {
      sourceId: HOST,
      relayOrigin: ISSUER,
      relayBaseUrl: BASE,
      assertion: "jws",
      relayToken: "relay-1",
      relayTokenExpiresAtMs,
      guestSession: {
        accessToken: "guest-access",
        refreshToken: "guest-refresh-1",
        accessExpiresAtMs: 0,
        expiresAtMs: 0,
      },
    },
    core: {
      hostId: HOST,
      expiresAtUnixMs: Date.now() + 900_000,
      native: { accessToken: "core-access", refreshToken: "core-refresh" },
    },
  };
}

describe("enterRelayPage", () => {
  it("本机源指到中继那一路，请求带 Bearer 与中继令牌", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({
            hostId: HOST,
            protocol: { major: 1, minor: 3 },
            capabilities: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    enterRelayPage(join(Date.now() + 3_600_000));
    expect(localSource.httpBase).toBe(BASE);
    expect(localSource.credentials.mode).toBe("bearer");
    expect(currentAccessToken()).toBe("core-access");
    await localSource.fetch(`${BASE}/api/workspaces`);
    expect(seen[0]?.get("authorization")).toBe("Bearer core-access");
    expect(seen[0]?.get("armadra-relay-token")).toBe("relay-1");
    // 身份面同样经中继、带令牌。
    await identityHello().catch(() => undefined);
    expect(seen[1]?.get("armadra-relay-token")).toBe("relay-1");
  });

  it("中继令牌快到期：用访客会话换一枚新的再发", async () => {
    const cloud = routedFetch({
      "POST /v1/auth/refresh": (init) => {
        expect(JSON.parse(String(init.body))).toEqual({
          refreshToken: "guest-refresh-1",
        });
        return {
          body: {
            session: {
              accessToken: "guest-access-2",
              refreshToken: "guest-refresh-2",
              accessExpiresAtMs: Date.now() + 900_000,
            },
          },
        };
      },
      [`POST /v1/sources/${HOST}/assertion`]: () => ({
        body: {
          assertion: "jws-2",
          relayToken: "relay-2",
          relayTokenExpiresAtMs: Date.now() + 3_600_000,
          relayBaseUrl: BASE,
        },
      }),
    });
    const seen: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return new Response("[]", { status: 200 });
      }),
    );
    enterRelayPage(join(Date.now() + 10_000), {
      cloud: { fetch: cloud.fetch },
    });
    await localSource.fetch(`${BASE}/api/workspaces`);
    expect(cloud.calls.map((call) => call.key)).toEqual([
      "POST /v1/auth/refresh",
      `POST /v1/sources/${HOST}/assertion`,
    ]);
    expect(seen[0]?.get("armadra-relay-token")).toBe("relay-2");
  });
});
