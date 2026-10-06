import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentAccessToken,
  resetIdentityCredentials,
  setHostedSession,
} from "../api/identity";
import { setHostedRuntimeBase } from "../api/runtime-url";
import { routedFetch } from "../mobile/testing";
import {
  createHostedRelay,
  detectRelayHost,
  hostedFailureOf,
  underRelayAppPath,
} from "./hosted";
import type { SourceConnection } from "./connection";
import { type SiblingMountOptions, mountSiblingSources } from "./mounts";
import { createSourceRegistry } from "./registry";
import type { RemoteStreamOptions } from "./remote-stream";
import type { EnterRouteOptions } from "./route-entry";
import { SourceError } from "./types";

/**
 * 中继托管的页面（客户端包 §5）：认出自己、口令登录、挑主机装成本机源、
 * `me.stream` 驱动等待 / 恢复 / 撤销。
 */

const ISSUER = "https://relay.example";
const SOURCE = "a".repeat(32);
const NOW = Date.now();

const platform = (over: Record<string, unknown> = {}) => ({
  mode: "personal",
  issuer: ISSUER,
  protocol: { major: 0, minor: 1 },
  capabilities: ["auth.password", "me.stream"],
  relay: { addressing: "path" },
  webApp: `${ISSUER}/app/`,
  ...over,
});

afterEach(() => {
  setHostedSession(null);
  setHostedRuntimeBase(null);
  resetIdentityCredentials();
});

describe("认出中继托管的页面", () => {
  it("只在 /app/ 下问一次同源的平台信息", async () => {
    expect(underRelayAppPath("/app/")).toBe(true);
    expect(underRelayAppPath("/app")).toBe(true);
    expect(underRelayAppPath("/apps")).toBe(false);
    expect(underRelayAppPath("/")).toBe(false);

    const net = routedFetch({
      "GET /.well-known/armadra-platform": () => ({ body: platform() }),
    });
    expect(
      await detectRelayHost(
        { origin: ISSUER, pathname: "/" },
        { fetch: net.fetch },
      ),
    ).toBeNull();
    expect(net.calls).toHaveLength(0);
    expect(
      await detectRelayHost(
        { origin: ISSUER, pathname: "/app/" },
        { fetch: net.fetch },
      ),
    ).toEqual({ issuer: ISSUER });
    expect(net.calls.map((call) => call.key)).toEqual([
      "GET /.well-known/armadra-platform",
    ]);
  });

  it("不是 personal、签发方不是页面来源、问不到：都不是", async () => {
    const detect = (body: unknown, status = 200) =>
      detectRelayHost(
        { origin: ISSUER, pathname: "/app/" },
        {
          fetch: routedFetch({
            "GET /.well-known/armadra-platform": () => ({ status, body }),
          }).fetch,
        },
      );
    expect(await detect(platform({ mode: "saas" }))).toBeNull();
    expect(
      await detect(platform({ issuer: "https://other.example" })),
    ).toBeNull();
    expect(await detect({ code: "not_found" }, 404)).toBeNull();
  });
});

function relayNet() {
  return routedFetch({
    "POST /v1/auth/login": (init) => {
      const body = JSON.parse(String(init.body)) as {
        password: string;
        device: unknown;
      };
      if (body.password !== "pw")
        return {
          status: 401,
          body: { code: "credentials_invalid", message: "" },
        };
      return {
        body: {
          session: {
            accessToken: "cloud-a",
            refreshToken: "cloud-r",
            accessExpiresAtMs: NOW + 900_000,
            expiresAtMs: NOW + 9_000_000,
          },
        },
      };
    },
    "GET /v1/me/sources": () => ({
      body: {
        sources: [{ sourceId: SOURCE, name: "laptop", online: true }],
      },
    }),
    [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
      body: {
        assertion: "jws",
        relayToken: "relay.jwt",
        relayTokenExpiresAtMs: NOW + 3_600_000,
        relayOrigin: ISSUER,
        relayBaseUrl: `${ISSUER}/s/${SOURCE}`,
        online: true,
      },
    }),
    [`POST /s/${SOURCE}/api/identity/cloud/login`]: () => ({
      body: {
        session: {
          hostId: SOURCE,
          expiresAtUnixMs: NOW + 900_000,
          csrfToken: "c".repeat(43),
          native: { accessToken: "core-a", refreshToken: "core-r" },
        },
      },
    }),
  });
}

/** 不碰真本机源：取访问、记下这一路，就当装好了。 */
const fakeEnter = async (options: EnterRouteOptions) => {
  const access = await options.provider.getAccess(
    options.descriptor.sourceId,
    "relayed",
  );
  const route = { via: "relayed" as const, access };
  options.useRoute(route);
  return { route, renew: async () => true, dispose: () => undefined };
};

function hosted(mount?: (options: SiblingMountOptions) => unknown) {
  const net = relayNet();
  let stream: RemoteStreamOptions | null = null;
  const wake = vi.fn();
  const relay = createHostedRelay({
    issuer: ISSUER,
    cloud: { fetch: net.fetch },
    enter: fakeEnter,
    wake,
    ...(mount === undefined
      ? {}
      : { mount: mount as typeof mountSiblingSources }),
    createStream: (options) => {
      stream = options;
      return { issuer: ISSUER, state: "open", close: () => undefined };
    },
  });
  return { relay, net, wake, stream: () => stream! };
}

describe("中继托管页面的源", () => {
  it("登录 → 目录 → 进主机：会话进身份面，设备登记为浏览器", async () => {
    const { relay, net } = hosted();
    const sources = await relay.signIn("dev", "pw");
    expect(sources).toMatchObject([{ sourceId: SOURCE, online: true }]);
    const login = net.calls.find((call) => call.key === "POST /v1/auth/login")!;
    expect(JSON.parse(String(login.init.body)).device).toMatchObject({
      platform: "browser",
    });
    await relay.enter(sources[0]!);
    expect(relay.status.state).toBe("ready");
    expect(currentAccessToken()).toBe("core-a");
  });

  it("口令不对：按码给原因", async () => {
    const { relay } = hosted();
    const error = await relay.signIn("dev", "nope").catch((e: unknown) => e);
    expect(hostedFailureOf(error)).toBe("credentials");
    expect(hostedFailureOf(new SourceError("source_offline"))).toBe("offline");
    expect(hostedFailureOf(new SourceError("cloud_account_unlinked"))).toBe(
      "unlinked",
    );
  });

  it("me.stream：下线 → 等待；上线 → 就绪并叫醒流；撤销 → unauthorized", async () => {
    const { relay, wake, stream } = hosted();
    await relay.enter((await relay.signIn("dev", "pw"))[0]!);
    const seen: string[] = [];
    relay.subscribe(() => seen.push(relay.status.state));

    stream().onEvent({ type: "sourceOffline", sourceId: SOURCE });
    expect(relay.status).toMatchObject({
      state: "waitingForSource",
      lastError: { code: "source_offline" },
    });
    stream().onEvent({ type: "sourceOnline", sourceId: "b".repeat(32) });
    expect(relay.status.state).toBe("waitingForSource");
    stream().onEvent({ type: "sourceOnline", sourceId: SOURCE });
    await Promise.resolve();
    expect(relay.status.state).toBe("ready");
    expect(wake).toHaveBeenCalledTimes(1);

    stream().onEvent({ type: "accessRevoked", sourceId: SOURCE });
    expect(relay.status).toMatchObject({
      state: "unauthorized",
      lastError: { code: "source_access_denied" },
    });
    expect(seen).toEqual(["waitingForSource", "ready", "unauthorized"]);
  });

  it("流重开时对一次目录：主机离线就等，回来了就叫醒", async () => {
    const { relay, net, wake, stream } = hosted();
    await relay.enter((await relay.signIn("dev", "pw"))[0]!);
    let online = false;
    const routes = net.fetch as unknown as ReturnType<
      typeof vi.fn<typeof fetch>
    >;
    const original = routes.getMockImplementation()!;
    routes.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/v1/me/sources"))
        return new Response(
          JSON.stringify({ sources: [{ sourceId: SOURCE, online }] }),
        );
      return original(input, init);
    });
    stream().onOpen?.();
    await vi.waitFor(() => expect(relay.status.state).toBe("waitingForSource"));
    online = true;
    stream().onOpen?.();
    await vi.waitFor(() => expect(relay.status.state).toBe("ready"));
    expect(wake).toHaveBeenCalledTimes(1);
    // 中继重启：页面一直以为就绪，流重开时主机在线也叫醒一次（经中继的流以 4404 收了尾）。
    stream().onOpen?.();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
  });
});

describe("一个标签页同时挂多台主机", () => {
  const OTHER = "b".repeat(32);

  /** 目录里两台：选中的装成本机源，另一台挂进（测试用的）源表。 */
  function twoHosts() {
    const connections = new Map<
      string,
      { connect: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn> }
    >();
    const mounted: SiblingMountOptions[] = [];
    const parts = hosted((options) => {
      mounted.push(options);
      return mountSiblingSources({
        ...options,
        install: (registryOptions) =>
          createSourceRegistry({
            ...registryOptions,
            connect: (descriptor) => {
              const spies = {
                connect: vi.fn(async () => undefined),
                revoke: vi.fn(),
              };
              connections.set(descriptor.sourceId, spies);
              return {
                descriptor,
                status: {
                  state: "waitingForSource",
                  via: null,
                  since: 0,
                  lastError: null,
                },
                subscribe: () => () => undefined,
                disconnect: () => undefined,
                ...spies,
              } as unknown as SourceConnection;
            },
          }),
      });
    });
    const routes = parts.net.fetch as unknown as ReturnType<
      typeof vi.fn<typeof fetch>
    >;
    const original = routes.getMockImplementation()!;
    routes.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/v1/me/sources"))
        return new Response(
          JSON.stringify({
            sources: [
              { sourceId: SOURCE, name: "laptop", online: true },
              { sourceId: OTHER, name: "studio", online: false },
            ],
          }),
        );
      return original(input, init);
    });
    return { ...parts, connections, mounted };
  }

  it("登录目录里的其余主机作为远程源挂上，选中的那台仍是本机源", async () => {
    const { relay, connections, mounted } = twoHosts();
    const listed = await relay.signIn("dev", "pw");
    await relay.enter(listed[0]!);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.primary).toMatchObject({
      sourceId: SOURCE,
      label: "laptop",
    });
    expect(mounted[0]!.cloudAuth).toBeUndefined();
    expect([...connections.keys()]).toEqual([OTHER]);
    expect(relay.status.state).toBe("ready");
  });

  it("me.stream 里其余主机的上线与撤销落到各自的连接上，不动选中那台", async () => {
    const { relay, connections, stream } = twoHosts();
    await relay.enter((await relay.signIn("dev", "pw"))[0]!);
    const other = connections.get(OTHER)!;
    // 挂上时源表在后台连过一次。
    expect(other.connect).toHaveBeenCalledTimes(1);
    stream().onEvent({ type: "sourceOnline", sourceId: OTHER });
    expect(other.connect).toHaveBeenCalledTimes(2);
    stream().onEvent({ type: "sourceOffline", sourceId: OTHER });
    expect(relay.status.state).toBe("ready");
    stream().onEvent({ type: "accessRevoked", sourceId: OTHER });
    expect(other.revoke).toHaveBeenCalledWith({
      code: "source_access_denied",
      message: "",
    });
    expect(relay.status.state).toBe("ready");
    // 流重开：在等的那台补叫一次。
    stream().onOpen?.();
    expect(other.connect).toHaveBeenCalledTimes(3);
  });

  it("只有一台：页面源表不换", async () => {
    const mount = vi.fn((options: SiblingMountOptions) =>
      mountSiblingSources({
        ...options,
        install: () => {
          throw new Error("不该换源表");
        },
      }),
    );
    const { relay } = hosted(mount);
    await relay.enter((await relay.signIn("dev", "pw"))[0]!);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.results[0]!.value).toBeNull();
  });
});

describe("按分享链接以访客加入（A4-3p）", () => {
  const LINK = {
    linkId: "0123456789abcdef",
    secret: "S".repeat(43),
    invitationToken: `${"c".repeat(32)}.${"D".repeat(43)}`,
  };

  function joining(accept: () => { status?: number; body: unknown }) {
    const net = routedFetch({
      [`POST /v1/links/${LINK.linkId}/accept`]: accept,
      "GET /v1/me/sources": () => ({
        body: { sources: [{ sourceId: SOURCE, name: "studio", online: true }] },
      }),
      [`POST /v1/sources/${SOURCE}/assertion`]: () => ({
        body: {
          assertion: "jws",
          relayToken: "relay.jwt",
          relayTokenExpiresAtMs: NOW + 3_600_000,
          relayOrigin: ISSUER,
          relayBaseUrl: `${ISSUER}/s/${SOURCE}`,
          online: true,
        },
      }),
      [`POST /s/${SOURCE}/api/identity/cloud/login`]: (init) => {
        expect(JSON.parse(String(init.body))).toEqual({
          assertion: "jws.guest",
          invitationToken: LINK.invitationToken,
        });
        return {
          body: {
            session: {
              hostId: SOURCE,
              expiresAtUnixMs: NOW + 900_000,
              native: { accessToken: "core-guest", refreshToken: "core-gr" },
            },
          },
        };
      },
    });
    const relay = createHostedRelay({
      issuer: ISSUER,
      cloud: { fetch: net.fetch },
      enter: fakeEnter,
      wake: vi.fn(),
      createStream: () => ({
        issuer: ISSUER,
        state: "open",
        close: () => undefined,
      }),
    });
    return { relay, net };
  }

  it("accept → 访客会话进保管处 → cloud/login 带邀请令牌 → 装成本机源，不再重登", async () => {
    const { relay, net } = joining(() => ({
      body: {
        sourceId: SOURCE,
        relayOrigin: ISSUER,
        relayBaseUrl: `${ISSUER}/s/${SOURCE}`,
        assertion: "jws.guest",
        relayToken: "relay.guest",
        guestSession: {
          accessToken: "guest-a",
          refreshToken: "guest-r",
          accessExpiresAtMs: NOW + 900_000,
        },
      },
    }));
    await expect(relay.join(LINK)).resolves.toBe(SOURCE);
    expect(relay.status.state).toBe("ready");
    expect(currentAccessToken()).toBe("core-guest");
    const accept = net.calls.find((call) => call.key.endsWith("/accept"))!;
    expect(JSON.parse(String(accept.init.body))).toMatchObject({
      secret: LINK.secret,
      device: { platform: "browser" },
    });
    // 进主机时用的是刚换来的源会话：只登录一次。
    expect(
      net.calls.filter((call) => call.key.endsWith("/cloud/login")),
    ).toHaveLength(1);
    relay.dispose();
  });

  it("链接过期：远程服务的码原样抛出，不装源", async () => {
    const { relay } = joining(() => ({
      status: 410,
      body: { code: "link_expired", message: "" },
    }));
    const error = await relay.join(LINK).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("link_expired");
    expect(relay.status.state).toBe("idle");
  });
});
