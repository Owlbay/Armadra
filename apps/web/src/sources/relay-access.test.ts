import { describe, expect, it } from "vitest";

import { routedFetch } from "../mobile/testing";
import { createMemoryRelayVault } from "./hosted";
import { createRelayedAccess } from "./relay-access";

/**
 * 经中继取访问（手机与中继托管的页面共用）：远程服务会话旋转写回、源会话先
 * 轮换（带 CSRF）再退回断言登录、拒绝码映射到源层的码。
 */

const ISSUER = "https://relay.example";
const SOURCE = "a".repeat(32);
const BASE = `${ISSUER}/s/${SOURCE}`;
const NOW = 1_000_000;
const device = () => ({ platform: "browser" as const, name: "Armadra Web" });

const cloudSession = (access: string, refresh: string) => ({
  session: {
    accessToken: access,
    refreshToken: refresh,
    accessExpiresAtMs: NOW + 900_000,
    expiresAtMs: NOW + 9_000_000,
  },
});

const assertion = (over: Record<string, unknown> = {}) => ({
  assertion: "jws.assertion",
  relayToken: "relay.jwt",
  relayTokenExpiresAtMs: NOW + 3_600_000,
  relayOrigin: ISSUER,
  relayBaseUrl: BASE,
  online: true,
  ...over,
});

const coreLogin = (access: string, refresh: string, csrf: string) => ({
  session: {
    hostId: SOURCE,
    expiresAtUnixMs: NOW + 900_000,
    csrfToken: csrf,
    native: { accessToken: access, refreshToken: refresh },
  },
});

async function vaultWithCloud() {
  const vault = createMemoryRelayVault();
  await vault.saveCloudRefreshToken(ISSUER, "cloud-r1");
  return vault;
}

describe("经中继取访问", () => {
  it("第一次：云会话旋转写回 → 断言 → cloud/login，会话连同 CSRF 存进保管处", async () => {
    const vault = await vaultWithCloud();
    const net = routedFetch({
      "POST /v1/auth/refresh": () => ({
        body: cloudSession("cloud-a", "cloud-r2"),
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({ body: assertion() }),
      [`POST /s/${SOURCE}/api/identity/cloud/login`]: () => ({
        body: coreLogin("core-a", "core-r", "c".repeat(43)),
      }),
    });
    const relay = createRelayedAccess({
      vault,
      device,
      cloud: { fetch: net.fetch },
      now: () => NOW,
    });
    const access = await relay.access(ISSUER, SOURCE, false);
    expect(access).toEqual({
      accessToken: "core-a",
      expiresAtMs: NOW + 900_000,
      httpBase: BASE,
      wsBase: `wss://relay.example/s/${SOURCE}`,
      relayToken: "relay.jwt",
    });
    expect(await vault.cloudRefreshToken(ISSUER)).toBe("cloud-r2");
    expect(await vault.session(SOURCE)).toMatchObject({
      refreshToken: "core-r",
      csrfToken: "c".repeat(43),
    });
    const login = net.calls.find((call) => call.key.endsWith("cloud/login"))!;
    expect(new Headers(login.init.headers).get("armadra-relay-token")).toBe(
      "relay.jwt",
    );
    const assertCall = net.calls.find((call) =>
      call.key.endsWith("/assertion"),
    )!;
    expect(JSON.parse(String(assertCall.init.body))).toEqual({
      device: device(),
    });
  });

  it("被拒之后：用刷新令牌 + 会话的 CSRF 经中继轮换，不重新登录", async () => {
    const vault = await vaultWithCloud();
    await vault.saveSession(SOURCE, ISSUER, {
      accessToken: "old",
      refreshToken: "core-r",
      expiresAtMs: NOW + 600_000,
      csrfToken: "x".repeat(43),
    });
    const net = routedFetch({
      "POST /v1/auth/refresh": () => ({
        body: cloudSession("cloud-a", "cloud-r2"),
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({ body: assertion() }),
      [`POST /s/${SOURCE}/api/identity/session/refresh`]: () => ({
        body: {
          hostId: SOURCE,
          expiresAtUnixMs: NOW + 900_000,
          csrfToken: "y".repeat(43),
          native: { accessToken: "new", refreshToken: "core-r2" },
        },
      }),
    });
    const relay = createRelayedAccess({
      vault,
      device,
      cloud: { fetch: net.fetch },
      now: () => NOW,
    });
    expect((await relay.access(ISSUER, SOURCE, true)).accessToken).toBe("new");
    const refresh = net.calls.find((call) =>
      call.key.endsWith("session/refresh"),
    )!;
    const headers = new Headers(refresh.init.headers);
    expect(headers.get("authorization")).toBe("Bearer core-r");
    expect(headers.get("x-armadra-csrf")).toBe("x".repeat(43));
    expect(headers.get("armadra-relay-token")).toBe("relay.jwt");
    expect(net.calls.some((call) => call.key.endsWith("cloud/login"))).toBe(
      false,
    );
    expect(await vault.session(SOURCE)).toMatchObject({
      accessToken: "new",
      csrfToken: "y".repeat(43),
    });
  });

  it("拒绝码：源不在线 → source_offline；撤销 → source_revoked；未关联照原码", async () => {
    const run = async (routes: Parameters<typeof routedFetch>[0]) => {
      const relay = createRelayedAccess({
        vault: await vaultWithCloud(),
        device,
        cloud: { fetch: routedFetch(routes).fetch },
        now: () => NOW,
      });
      return relay.access(ISSUER, SOURCE, false).catch((error) => error);
    };
    const cloud = {
      "POST /v1/auth/refresh": () => ({ body: cloudSession("a", "r") }),
    };
    expect(
      await run({
        ...cloud,
        [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
          body: assertion({ online: false }),
        }),
      }),
    ).toMatchObject({ code: "source_offline" });
    expect(
      await run({
        ...cloud,
        [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
          status: 410,
          body: { code: "source_revoked", message: "" },
        }),
      }),
    ).toMatchObject({ code: "source_revoked" });
    expect(
      await run({
        ...cloud,
        [`POST /v1/sources/${SOURCE}/assertion`]: () => ({ body: assertion() }),
        [`POST /s/${SOURCE}/api/identity/cloud/login`]: () => ({
          status: 401,
          body: { code: "cloud_account_unlinked", message: "" },
        }),
      }),
    ).toMatchObject({ code: "cloud_account_unlinked" });
    expect(
      await run({
        ...cloud,
        [`POST /v1/sources/${SOURCE}/assertion`]: () => ({ body: assertion() }),
        [`POST /s/${SOURCE}/api/identity/cloud/login`]: () => ({
          status: 503,
          body: { code: "source_offline", message: "" },
        }),
      }),
    ).toMatchObject({ code: "source_offline" });
  });

  it("远程服务的刷新令牌失效：忘掉它，答 source_unauthorized", async () => {
    const vault = await vaultWithCloud();
    const relay = createRelayedAccess({
      vault,
      device,
      cloud: {
        fetch: routedFetch({
          "POST /v1/auth/refresh": () => ({
            status: 401,
            body: { code: "session_revoked", message: "" },
          }),
        }).fetch,
      },
      now: () => NOW,
    });
    await expect(relay.access(ISSUER, SOURCE, false)).rejects.toMatchObject({
      code: "source_unauthorized",
    });
    expect(await vault.cloudRefreshToken(ISSUER)).toBeNull();
  });
});
