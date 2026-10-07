import { describe, expect, it } from "vitest";

import { SourceError, type SourceDescriptor } from "../sources/types";
import {
  createMobileCredentialProvider,
  guestPrincipal,
  isGuestSlot,
  serviceIdOf,
} from "./credentials";
import {
  SESSION_A,
  SESSION_B,
  SESSION_C,
  fakeBridge,
  routedFetch,
} from "./testing";

const ISSUER = "https://relay.example.com";
const SOURCE = "a".repeat(32);
const RELAY_BASE = `${ISSUER}/s/${SOURCE}`;
const NOW = 1_000_000;

const descriptor = (over: Partial<SourceDescriptor>): SourceDescriptor => ({
  sourceId: SOURCE,
  kind: "relayed",
  label: "",
  baseUrl: "",
  relayOrigin: ISSUER,
  cloudIssuer: ISSUER,
  fingerprint: "",
  orderIndex: 0,
  ...over,
});

const cloudSession = (access: string, refresh: string) => ({
  session: {
    accessToken: access,
    refreshToken: refresh,
    accessExpiresAtMs: NOW + 900_000,
    expiresAtMs: NOW + 9_000_000,
  },
});

const assertionBody = (over: Record<string, unknown> = {}) => ({
  assertion: "jws.assertion",
  assertionExpiresAtMs: NOW + 300_000,
  relayToken: "relay.jwt.1",
  relayTokenExpiresAtMs: NOW + 3_600_000,
  relayOrigin: ISSUER,
  relayBaseUrl: RELAY_BASE,
  online: true,
  ...over,
});

const coreSession = (access: string, refresh: string) => ({
  hostId: SOURCE,
  expiresAtUnixMs: NOW + 900_000,
  native: { accessToken: access, refreshToken: refresh },
});

async function seeded() {
  const store = fakeBridge();
  await store.bridge.setRemote({
    serviceId: serviceIdOf(ISSUER),
    issuer: ISSUER,
    kind: "personal",
    refreshToken: "cloud-refresh-1",
    fingerprint: "",
  });
  await store.bridge.setSession({
    sourceId: SOURCE,
    origin: ISSUER,
    via: "relayed",
    accessToken: SESSION_A,
    refreshToken: SESSION_B,
    expiresAtMs: NOW + 600_000,
  });
  return store;
}

describe("手机的凭据来源 · 经中继", () => {
  it("钥匙串里的会话还新：只取云会话与断言，不动源的会话；中继令牌随访问给出", async () => {
    const { bridge, remotes } = await seeded();
    const net = routedFetch({
      "POST /v1/auth/refresh": () => ({
        body: cloudSession("cloud-access-1", "cloud-refresh-2"),
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
        body: assertionBody(),
      }),
    });
    const provider = createMobileCredentialProvider({
      bridge,
      describe: () => descriptor({}),
      cloud: { fetch: net.fetch },
      now: () => NOW,
    });
    const access = await provider.getAccess(SOURCE, "relayed");
    expect(access).toMatchObject({
      accessToken: SESSION_A,
      httpBase: RELAY_BASE,
      wsBase: RELAY_BASE.replace("https", "wss"),
      relayToken: "relay.jwt.1",
    });
    // 访问到期取两者里早的，免得中继令牌先过期。
    expect(access.expiresAtMs).toBe(NOW + 600_000);
    // 云刷新令牌旋转后写回钥匙串，用的是新的，不留旧的。
    expect(remotes.get(serviceIdOf(ISSUER))?.refreshToken).toBe(
      "cloud-refresh-2",
    );
    expect(net.calls.map((call) => call.key)).toEqual([
      "POST /v1/auth/refresh",
      `POST /v1/sources/${SOURCE}/assertion`,
    ]);
    // 断言请求带的是刚换来的云访问令牌。
    expect(
      (net.calls[1]!.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer cloud-access-1");
  });

  it("续期：用存着的刷新令牌经中继轮换，新会话写回钥匙串，且带中继令牌", async () => {
    const { bridge, sessions } = await seeded();
    const net = routedFetch({
      "POST /v1/auth/refresh": () => ({
        body: cloudSession("cloud-access-1", "cloud-refresh-2"),
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
        body: assertionBody(),
      }),
      [`POST /s/${SOURCE}/api/identity/session/refresh`]: () => ({
        body: coreSession(SESSION_C, SESSION_A),
      }),
    });
    const provider = createMobileCredentialProvider({
      bridge,
      describe: () => descriptor({}),
      cloud: { fetch: net.fetch },
      now: () => NOW,
    });
    await provider.getAccess(SOURCE, "relayed");
    const renewed = await provider.refresh(SOURCE, "relayed");
    expect(renewed.accessToken).toBe(SESSION_C);
    expect(sessions.get(`${SOURCE}|relayed`)).toMatchObject({
      accessToken: SESSION_C,
      refreshToken: SESSION_A,
    });
    const refreshCall = net.calls.find((call) =>
      call.key.endsWith("/session/refresh"),
    )!;
    const headers = refreshCall.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SESSION_B}`);
    expect(headers["Armadra-Relay-Token"]).toBe("relay.jwt.1");
    // 没有重新 cloud/login：旋转够了。
    expect(net.calls.some((call) => call.key.endsWith("/cloud/login"))).toBe(
      false,
    );
  });

  it("核心拒绝了刷新令牌：用断言 cloud/login 重新登录，写回钥匙串", async () => {
    const { bridge, sessions } = await seeded();
    const net = routedFetch({
      "POST /v1/auth/refresh": () => ({
        body: cloudSession("cloud-access-1", "cloud-refresh-2"),
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
        body: assertionBody(),
      }),
      [`POST /s/${SOURCE}/api/identity/session/refresh`]: () => ({
        status: 401,
        body: { code: "unauthenticated", message: "" },
      }),
      [`POST /s/${SOURCE}/api/identity/cloud/login`]: (init) => {
        expect(JSON.parse(String(init.body))).toEqual({
          assertion: "jws.assertion",
        });
        return {
          body: { session: coreSession(SESSION_C, SESSION_B) },
        };
      },
    });
    const provider = createMobileCredentialProvider({
      bridge,
      describe: () => descriptor({}),
      cloud: { fetch: net.fetch },
      now: () => NOW,
    });
    const access = await provider.refresh(SOURCE, "relayed");
    expect(access.accessToken).toBe(SESSION_C);
    expect(sessions.get(`${SOURCE}|relayed`)?.accessToken).toBe(SESSION_C);
  });

  it("源不在线答 source_offline；云会话失效答 source_unauthorized", async () => {
    const { bridge } = await seeded();
    const offline = routedFetch({
      "POST /v1/auth/refresh": () => ({
        body: cloudSession("cloud-access-1", "cloud-refresh-2"),
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
        body: assertionBody({ online: false }),
      }),
    });
    const make = (fetchImpl: typeof fetch) =>
      createMobileCredentialProvider({
        bridge,
        describe: () => descriptor({}),
        cloud: { fetch: fetchImpl },
        now: () => NOW,
      });
    await expect(
      make(offline.fetch).getAccess(SOURCE, "relayed"),
    ).rejects.toMatchObject({ code: "source_offline" });

    const expired = routedFetch({
      "POST /v1/auth/refresh": () => ({
        status: 401,
        body: { code: "session_expired", message: "" },
      }),
    });
    const error = await make(expired.fetch)
      .getAccess(SOURCE, "relayed")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe("source_unauthorized");
  });

  it("没有远程服务的登录：source_unauthorized，不发任何请求", async () => {
    const { bridge } = fakeBridge();
    const net = routedFetch({});
    const provider = createMobileCredentialProvider({
      bridge,
      describe: () => descriptor({}),
      cloud: { fetch: net.fetch },
    });
    await expect(provider.getAccess(SOURCE, "relayed")).rejects.toMatchObject({
      code: "source_unauthorized",
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("手机的凭据来源 · 同一个中继下按主体分槽", () => {
  const GUEST_SOURCE = "c".repeat(32);
  const OWNER_SLOT = serviceIdOf(ISSUER, "acct-1");
  const GUEST_SLOT = serviceIdOf(ISSUER, guestPrincipal(GUEST_SOURCE));

  async function twoPrincipals() {
    const store = fakeBridge();
    for (const [serviceId, refreshToken] of [
      [OWNER_SLOT, "owner-refresh"],
      [GUEST_SLOT, "guest-refresh"],
    ] as const)
      await store.bridge.setRemote({
        serviceId,
        issuer: ISSUER,
        kind: "personal",
        refreshToken,
        fingerprint: "",
      });
    for (const sourceId of [SOURCE, GUEST_SOURCE])
      await store.bridge.setSession({
        sourceId,
        origin: ISSUER,
        via: "relayed",
        accessToken: SESSION_A,
        refreshToken: SESSION_B,
        expiresAtMs: NOW + 600_000,
      });
    return store;
  }

  /** 云刷新按用的那把刷新令牌答不同的访问令牌，好看出走的是哪一槽。 */
  const net = () =>
    routedFetch({
      "POST /v1/auth/refresh": (init) => {
        const { refreshToken } = JSON.parse(String(init.body)) as {
          refreshToken: string;
        };
        const who = refreshToken.split("-")[0];
        return { body: cloudSession(`${who}-access`, `${who}-refresh-2`) };
      },
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
        body: assertionBody(),
      }),
      [`POST /v1/sources/${GUEST_SOURCE}/assertion`]: () => ({
        body: assertionBody({
          relayBaseUrl: `${ISSUER}/s/${GUEST_SOURCE}`,
        }),
      }),
    });

  it("槽名：主人按账号、访客按源，与旧单槽互不相同；只用钥匙串认的字符", () => {
    expect(serviceIdOf(ISSUER)).toBe("personal:relay.example.com");
    expect(OWNER_SLOT).toBe("personal:relay.example.com:acct-1");
    expect(GUEST_SLOT).toBe(`personal:relay.example.com:guest.${GUEST_SOURCE}`);
    expect(serviceIdOf(ISSUER, "a b/c")).toBe(
      "personal:relay.example.com:a_b_c",
    );
    expect(serviceIdOf(ISSUER, "x".repeat(300))).toHaveLength(128);
    expect(isGuestSlot(GUEST_SLOT)).toBe(true);
    expect(isGuestSlot(OWNER_SLOT)).toBe(false);
    expect(isGuestSlot(serviceIdOf(ISSUER))).toBe(false);
  });

  it("主人与访客各用各的远程服务登录，旋转后写回各自那一槽", async () => {
    const { bridge, remotes } = await twoPrincipals();
    const fetcher = net();
    const slots: Record<string, string> = {
      [SOURCE]: OWNER_SLOT,
      [GUEST_SOURCE]: GUEST_SLOT,
    };
    const provider = createMobileCredentialProvider({
      bridge,
      describe: (sourceId) => descriptor({ sourceId }),
      slotOf: (sourceId) => slots[sourceId] ?? null,
      connections: () => [],
      cloud: { fetch: fetcher.fetch },
      now: () => NOW,
    });
    await provider.getAccess(GUEST_SOURCE, "relayed");
    await provider.getAccess(SOURCE, "relayed");
    const auth = (key: string) =>
      (
        fetcher.calls.find((call) => call.key === key)!.init.headers as Record<
          string,
          string
        >
      ).Authorization;
    expect(auth(`POST /v1/sources/${GUEST_SOURCE}/assertion`)).toBe(
      "Bearer guest-access",
    );
    expect(auth(`POST /v1/sources/${SOURCE}/assertion`)).toBe(
      "Bearer owner-access",
    );
    expect(remotes.get(OWNER_SLOT)?.refreshToken).toBe("owner-refresh-2");
    expect(remotes.get(GUEST_SLOT)?.refreshToken).toBe("guest-refresh-2");
  });

  it("旧连接没有槽的记录：照旧读签发方原来的单槽（迁移不丢）", async () => {
    const { bridge, remotes } = await seeded();
    const fetcher = net();
    const provider = createMobileCredentialProvider({
      bridge,
      describe: () => descriptor({}),
      slotOf: () => null,
      connections: () => [],
      cloud: { fetch: fetcher.fetch },
      now: () => NOW,
    });
    await expect(provider.getAccess(SOURCE, "relayed")).resolves.toMatchObject({
      accessToken: SESSION_A,
    });
    expect(remotes.get(serviceIdOf(ISSUER))?.refreshToken).toBe(
      "cloud-refresh-2",
    );
  });

  it("记的那一槽在钥匙串里没有：source_unauthorized，不借别的主体的登录", async () => {
    const { bridge } = await twoPrincipals();
    const fetcher = net();
    const provider = createMobileCredentialProvider({
      bridge,
      describe: () => descriptor({}),
      slotOf: () => serviceIdOf(ISSUER, "someone-else"),
      connections: () => [],
      cloud: { fetch: fetcher.fetch },
      now: () => NOW,
    });
    await expect(provider.getAccess(SOURCE, "relayed")).rejects.toMatchObject({
      code: "source_unauthorized",
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("me.stream 用主人那一槽；只有访客时才用访客的", async () => {
    const { bridge } = await twoPrincipals();
    const fetcher = net();
    const slots: Record<string, string> = {
      [SOURCE]: OWNER_SLOT,
      [GUEST_SOURCE]: GUEST_SLOT,
    };
    let rows = [
      descriptor({ sourceId: GUEST_SOURCE, orderIndex: 0 }),
      descriptor({ sourceId: SOURCE, orderIndex: 1 }),
    ];
    const provider = createMobileCredentialProvider({
      bridge,
      describe: (sourceId) => descriptor({ sourceId }),
      slotOf: (sourceId) => slots[sourceId] ?? null,
      connections: () => rows,
      cloud: { fetch: fetcher.fetch },
      now: () => NOW,
    });
    await expect(provider.cloudAuth.access(ISSUER)).resolves.toBe(
      "owner-access",
    );
    rows = [descriptor({ sourceId: GUEST_SOURCE })];
    provider.cloudAuth.invalidate(ISSUER);
    await expect(provider.cloudAuth.access(ISSUER)).resolves.toBe(
      "guest-access",
    );
  });
});

describe("手机的凭据来源 · 直连", () => {
  const GATEWAY = "https://192.168.1.8:8443";

  it("还新的直接用；快到期的向 Gateway 轮换并写回，每个源各一份", async () => {
    const store = fakeBridge();
    await store.bridge.setSession({
      sourceId: SOURCE,
      origin: GATEWAY,
      via: "direct",
      accessToken: SESSION_A,
      refreshToken: SESSION_B,
      expiresAtMs: NOW + 5_000,
    });
    await store.bridge.setSession({
      sourceId: "other",
      origin: "https://10.0.0.2:8443",
      via: "direct",
      accessToken: SESSION_B,
      refreshToken: SESSION_A,
      expiresAtMs: 0,
    });
    const net = routedFetch({
      "POST /api/identity/session/refresh": () => ({
        body: coreSession(SESSION_C, SESSION_A),
      }),
    });
    const provider = createMobileCredentialProvider({
      bridge: store.bridge,
      describe: (id) =>
        id === SOURCE
          ? descriptor({ kind: "direct", baseUrl: GATEWAY, relayOrigin: "" })
          : undefined,
      cloud: { fetch: net.fetch },
      now: () => NOW,
    });
    const access = await provider.getAccess(SOURCE, "direct");
    expect(access).toMatchObject({
      accessToken: SESSION_C,
      httpBase: GATEWAY,
      wsBase: "wss://192.168.1.8:8443",
    });
    expect(store.sessions.get(`${SOURCE}|direct`)?.refreshToken).toBe(
      SESSION_A,
    );
    // 另一个源的会话原样不动。
    expect(store.sessions.get("other|direct")?.accessToken).toBe(SESSION_B);
    const headers = net.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SESSION_B}`);
    expect(headers["Armadra-Relay-Token"]).toBeUndefined();
  });

  it("钥匙串里没有这个源的会话：source_unauthorized", async () => {
    const provider = createMobileCredentialProvider({
      bridge: fakeBridge().bridge,
      describe: () => descriptor({ kind: "direct", baseUrl: GATEWAY }),
    });
    await expect(provider.getAccess(SOURCE, "direct")).rejects.toMatchObject({
      code: "source_unauthorized",
    });
  });
});
