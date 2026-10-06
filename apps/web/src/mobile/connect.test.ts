import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityRequestError, IdentityTransportError } from "../api/identity";
import {
  connectNative,
  connectWeb,
  connectWithCode,
  failureOf,
} from "./connect";
import {
  activeConnectionId,
  loadConnections,
  upsertConnection,
} from "./connections";
import { serviceIdOf } from "./credentials";
import {
  createRelayEnrollment,
  forgetConnection,
  openConnection,
  recordDirectConnection,
} from "./connect";
import type { NativeBridge } from "./native-bridge";
import {
  SESSION_A,
  SESSION_B,
  fakeBridge,
  memoryStorage,
  routedFetch,
} from "./testing";

const FP = "ab".repeat(32);
const LINK = `https://192.168.1.8:8443/#pair=tk.secret&fp=${FP}`;

function deps(overrides: Partial<NativeBridge> = {}) {
  const bridge = {
    available: true,
    canScan: true,
    getSessions: vi.fn(),
    setSession: vi.fn(),
    removeSession: vi.fn(),
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

/* ------------------------------ 多连接：三种添加 ------------------------------ */

const ISSUER = "https://relay.example.com";
const HOST = "a".repeat(32);
const HOST_B = "b".repeat(32);
const RELAY_FP = "9b".repeat(32);

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

const login = () => ({
  body: {
    session: {
      accessToken: "cloud-access",
      refreshToken: "cloud-refresh",
      accessExpiresAtMs: Date.now() + 900_000,
      expiresAtMs: Date.now() + 9_000_000,
    },
  },
});

const sourceList = () => ({
  body: {
    sources: [
      {
        sourceId: HOST,
        name: "MacBook",
        online: true,
        owner: true,
        via: "owner",
      },
      {
        sourceId: HOST_B,
        name: "Studio",
        online: false,
        owner: true,
        via: "owner",
      },
    ],
  },
});

const assertion = (id: string) => () => ({
  body: {
    assertion: `jws.${id}`,
    assertionExpiresAtMs: Date.now() + 300_000,
    relayToken: `relay.${id}`,
    relayTokenExpiresAtMs: Date.now() + 3_600_000,
    relayOrigin: ISSUER,
    relayBaseUrl: `${ISSUER}/s/${id}`,
    online: true,
  },
});

const coreLogin = () => ({
  body: {
    session: {
      hostId: HOST,
      expiresAtUnixMs: Date.now() + 900_000,
      native: { accessToken: SESSION_A, refreshToken: SESSION_B },
    },
    principal: { principalId: "p", kind: "owner", displayName: "o" },
    created: false,
  },
});

describe("添加连接 · 局域网（现有方式）记进连接表", () => {
  it("配对成功：以 core 的 hostId 记一行直连并设为当前", async () => {
    const d = deps();
    d.pair.mockResolvedValue({ hostId: HOST } as never);
    const record = vi.fn();
    await connectNative(LINK, { ...d, record });
    expect(record).toHaveBeenCalledWith({
      sourceId: HOST,
      origin: "https://192.168.1.8:8443",
      fingerprint: FP,
    });
  });
});

describe("添加连接 · 个人中转", () => {
  it("自签中转：先问指纹，确认后钉住，再登录；勾选的在线主机逐个挂载，凭据只进钥匙串", async () => {
    const { bridge, sessions, remotes, pins } = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: false, pinned: false },
    });
    const net = routedFetch({
      "POST /v1/auth/login": (init) => {
        expect(JSON.parse(String(init.body))).toMatchObject({
          account: "owner",
          password: "hunter2hunter2",
          device: { platform: "ios" },
        });
        return login();
      },
      "GET /v1/me/sources": sourceList,
      [`POST /v1/sources/${HOST}/assertion`]: assertion(HOST),
      [`POST /s/${HOST}/api/identity/cloud/login`]: (init) => {
        expect(
          (init.headers as Record<string, string>)["Armadra-Relay-Token"],
        ).toBe(`relay.${HOST}`);
        return coreLogin();
      },
    });
    const reload = vi.fn();
    const enroll = createRelayEnrollment({
      bridge,
      cloud: { fetch: net.fetch },
      reload,
    });
    const first = await enroll.begin({
      issuer: "relay.example.com",
      account: "owner",
      password: "hunter2hunter2",
    });
    expect(first).toEqual({ kind: "fingerprint", fingerprint: RELAY_FP });
    // 钉住之前不能有任何发往中转的请求：自签证书在钉住前连 TLS 都过不了。
    expect(net.calls).toHaveLength(0);
    expect(pins).toHaveLength(0);

    const second = await enroll.trust();
    expect(pins).toEqual([{ origin: ISSUER, fingerprint: RELAY_FP }]);
    expect(second).toEqual({
      kind: "sources",
      sources: [
        { sourceId: HOST, name: "MacBook", online: true },
        { sourceId: HOST_B, name: "Studio", online: false },
      ],
    });

    await expect(enroll.mount([HOST])).resolves.toEqual({ kind: "done" });
    expect(reload).toHaveBeenCalledOnce();
    expect(sessions.get(`${HOST}|relayed`)).toMatchObject({
      origin: ISSUER,
      accessToken: SESSION_A,
    });
    expect(remotes.get(serviceIdOf(ISSUER))).toMatchObject({
      issuer: ISSUER,
      kind: "personal",
      refreshToken: "cloud-refresh",
      fingerprint: RELAY_FP,
    });
    const rows = loadConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: HOST,
      label: "MacBook",
      kind: "relayed",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
    });
    // 用户配置（连接表）里没有口令与令牌。
    expect(localStorage.getItem("armadra.sources")).not.toMatch(
      /hunter2|cloud-refresh|relay\.a{8}/,
    );
  });

  it("系统本来就信的证书（或已钉过同一枚）不再问指纹，直接登录", async () => {
    const trusted = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: true, pinned: false },
    });
    const net = routedFetch({
      "POST /v1/auth/login": login,
      "GET /v1/me/sources": sourceList,
    });
    const enroll = createRelayEnrollment({
      bridge: trusted.bridge,
      cloud: { fetch: net.fetch },
      reload: vi.fn(),
    });
    const outcome = await enroll.begin({
      issuer: ISSUER,
      account: "owner",
      password: "pw-pw-pw-pw-pw",
    });
    expect(outcome.kind).toBe("sources");
    expect(trusted.pins).toHaveLength(0);
  });

  it("口令错、账号锁定、地址不对、连不上、没有主机各有各的原因", async () => {
    const pinned = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: false, pinned: true },
    });
    const make = (routes: Parameters<typeof routedFetch>[0]) =>
      createRelayEnrollment({
        bridge: pinned.bridge,
        cloud: { fetch: routedFetch(routes).fetch },
        reload: vi.fn(),
      });
    const input = { issuer: ISSUER, account: "owner", password: "x" };
    await expect(
      make({
        "POST /v1/auth/login": () => ({
          status: 401,
          body: { code: "credentials_invalid", message: "" },
        }),
      }).begin(input),
    ).resolves.toEqual({ kind: "failure", failure: "credentials" });
    await expect(
      make({
        "POST /v1/auth/login": () => ({
          status: 429,
          body: {
            code: "account_locked",
            message: "",
            details: { retryAfterMs: 60000 },
          },
        }),
      }).begin(input),
    ).resolves.toEqual({ kind: "failure", failure: "locked" });
    await expect(
      make({
        "POST /v1/auth/login": login,
        "GET /v1/me/sources": () => ({ body: { sources: [] } }),
      }).begin(input),
    ).resolves.toEqual({ kind: "failure", failure: "noSources" });
    await expect(
      make({}).begin({ ...input, issuer: "https://relay.example.com/app" }),
    ).resolves.toEqual({ kind: "failure", failure: "address" });
    const down = fakeBridge({ peek: null });
    await expect(
      createRelayEnrollment({
        bridge: down.bridge,
        reload: vi.fn(),
      }).begin(input),
    ).resolves.toEqual({ kind: "failure", failure: "unreachable" });
  });

  it("钉扎失败不往下登录", async () => {
    const store = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: false, pinned: false },
      pin: vi.fn(async () => Promise.reject(new Error("mismatch"))),
    });
    const net = routedFetch({ "POST /v1/auth/login": login });
    const enroll = createRelayEnrollment({
      bridge: store.bridge,
      cloud: { fetch: net.fetch },
      reload: vi.fn(),
    });
    await enroll.begin({ issuer: ISSUER, account: "a", password: "b" });
    await expect(enroll.trust()).resolves.toEqual({
      kind: "failure",
      failure: "fingerprint",
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("添加连接 · 分享链接 / 二维码", () => {
  const LINK_ID = "0123456789abcdef0123456789abcdef";
  const SECRET = "S".repeat(43);
  const INVITE = `${"c".repeat(32)}.${"D".repeat(43)}`;
  const SHARE = `${ISSUER}/j/${LINK_ID}#${SECRET}.${INVITE}`;

  it("扫到分享二维码：接受链接、用断言与邀请令牌向源 core 登录、直接挂载", async () => {
    const { bridge, sessions, remotes } = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: false, pinned: true },
    });
    const net = routedFetch({
      [`POST /v1/links/${LINK_ID}/accept`]: (init) => {
        expect(JSON.parse(String(init.body))).toMatchObject({ secret: SECRET });
        return {
          body: {
            sourceId: HOST,
            relayOrigin: ISSUER,
            relayBaseUrl: `${ISSUER}/s/${HOST}`,
            assertion: "jws.guest",
            relayToken: "relay.guest",
            guestSession: {
              accessToken: "guest-access",
              refreshToken: "guest-refresh",
              accessExpiresAtMs: Date.now() + 900_000,
              expiresAtMs: Date.now() + 9_000_000,
            },
          },
        };
      },
      [`POST /s/${HOST}/api/identity/cloud/login`]: (init) => {
        expect(JSON.parse(String(init.body))).toEqual({
          assertion: "jws.guest",
          invitationToken: INVITE,
        });
        return coreLogin();
      },
      "GET /v1/me/sources": () => ({
        body: {
          sources: [
            {
              sourceId: HOST,
              name: "MacBook",
              online: true,
              owner: false,
              via: "link",
            },
          ],
        },
      }),
    });
    const reload = vi.fn();
    const enroll = createRelayEnrollment({
      bridge,
      cloud: { fetch: net.fetch },
      reload,
    });
    await expect(enroll.join(SHARE)).resolves.toEqual({ kind: "done" });
    expect(reload).toHaveBeenCalledOnce();
    expect(sessions.get(`${HOST}|relayed`)?.refreshToken).toBe(SESSION_B);
    expect(remotes.get(serviceIdOf(ISSUER))?.refreshToken).toBe(
      "guest-refresh",
    );
    expect(loadConnections()[0]).toMatchObject({
      sourceId: HOST,
      label: "MacBook",
    });
    // 邀请令牌与秘密不进连接表。
    expect(localStorage.getItem("armadra.sources")).not.toContain(SECRET);
    // 重载进画布后打开链接指向的工作空间（本机源就是这条连接）。
    expect(sessionStorage.getItem("armadra.sources.openAfterJoin")).toBe(
      "local",
    );
  });

  it("深链形式同样挂载；新的自签中转要先核对指纹；失效的链接说明原因", async () => {
    const deep = `armadra://join?link=${LINK_ID}&issuer=${encodeURIComponent(ISSUER)}&s=${encodeURIComponent(`${SECRET}.${INVITE}`)}`;
    const fresh = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: false, pinned: false },
    });
    const net = routedFetch({
      [`POST /v1/links/${LINK_ID}/accept`]: () => ({
        status: 410,
        body: { code: "link_expired", message: "" },
      }),
    });
    const enroll = createRelayEnrollment({
      bridge: fresh.bridge,
      cloud: { fetch: net.fetch },
      reload: vi.fn(),
    });
    await expect(enroll.join(deep)).resolves.toEqual({
      kind: "fingerprint",
      fingerprint: RELAY_FP,
    });
    await expect(enroll.trust()).resolves.toEqual({
      kind: "failure",
      failure: "linkExpired",
    });
    await expect(enroll.join("https://relay.example.com/j/x")).resolves.toEqual(
      {
        kind: "failure",
        failure: "invalid",
      },
    );
  });

  it("同一个源先局域网、后经个人中转：连接表仍是一行，两条路都在", async () => {
    const d = deps();
    d.pair.mockResolvedValue({ hostId: HOST } as never);
    await connectNative(LINK, { ...d, record: recordDirectConnection });
    const { bridge } = fakeBridge({
      peek: { fingerprint: RELAY_FP, trusted: false, pinned: true },
    });
    const net = routedFetch({
      "POST /v1/auth/login": login,
      "GET /v1/me/sources": () => ({
        body: {
          sources: [
            {
              sourceId: HOST,
              name: "MacBook",
              online: true,
              owner: true,
              via: "owner",
            },
          ],
        },
      }),
      [`POST /v1/sources/${HOST}/assertion`]: assertion(HOST),
      [`POST /s/${HOST}/api/identity/cloud/login`]: coreLogin,
    });
    const enroll = createRelayEnrollment({
      bridge,
      cloud: { fetch: net.fetch },
      reload: vi.fn(),
    });
    await enroll.begin({ issuer: ISSUER, account: "o", password: "p" });
    await enroll.mount([HOST]);
    const rows = loadConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      baseUrl: "https://192.168.1.8:8443",
      relayOrigin: ISSUER,
      kind: "relayed",
      label: "MacBook",
    });
  });
});

describe("管理连接", () => {
  it("移除一个连接只删它的会话；远程服务的登录没人用了才一并删", async () => {
    const { bridge, sessions, remotes } = fakeBridge();
    for (const id of [HOST, HOST_B]) {
      upsertConnection({
        sourceId: id,
        label: id,
        baseUrl: "",
        relayOrigin: ISSUER,
        cloudIssuer: ISSUER,
        fingerprint: "",
      });
      await bridge.setSession({
        sourceId: id,
        origin: ISSUER,
        via: "relayed",
        accessToken: SESSION_A,
        refreshToken: SESSION_B,
        expiresAtMs: 0,
      });
    }
    await bridge.setRemote({
      serviceId: serviceIdOf(ISSUER),
      issuer: ISSUER,
      kind: "personal",
      refreshToken: "r",
      fingerprint: "",
    });
    await forgetConnection(HOST, bridge);
    expect([...sessions.keys()]).toEqual([`${HOST_B}|relayed`]);
    expect(remotes.size).toBe(1);
    await forgetConnection(HOST_B, bridge);
    expect(sessions.size).toBe(0);
    expect(remotes.size).toBe(0);
    expect(loadConnections()).toEqual([]);
  });

  it("点一个连接：记为当前再重载", async () => {
    const reload = vi.fn();
    openConnection(HOST_B, reload);
    expect(activeConnectionId()).toBe(HOST_B);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("分享链接的失败按码说明（A4-3p）", () => {
  it("过期、撤销、用尽、秘密不对、邀请被拒各有各的原因", async () => {
    const { cloudFailureOf } = await import("./connect");
    const { CloudError } = await import("./cloud-client");
    expect(cloudFailureOf(new CloudError(410, "link_expired"))).toBe(
      "linkExpired",
    );
    expect(cloudFailureOf(new CloudError(404, "link_invalid"))).toBe(
      "linkInvalid",
    );
    expect(cloudFailureOf(new CloudError(410, "link_exhausted"))).toBe(
      "linkExhausted",
    );
    expect(cloudFailureOf(new CloudError(403, "link_secret_invalid"))).toBe(
      "linkSecret",
    );
    expect(cloudFailureOf(new CloudError(401, "invitation_invalid"))).toBe(
      "invitation",
    );
  });
});
