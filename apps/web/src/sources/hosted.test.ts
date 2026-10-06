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

function hosted() {
  const net = relayNet();
  let stream: RemoteStreamOptions | null = null;
  const wake = vi.fn();
  const relay = createHostedRelay({
    issuer: ISSUER,
    cloud: { fetch: net.fetch },
    enter: fakeEnter,
    wake,
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
