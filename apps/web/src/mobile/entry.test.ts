import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: false,
  served: false,
  compact: true,
  saved: null as string | null,
  restored: false,
  session: null as unknown,
  install: vi.fn(),
  complete: vi.fn(),
  route: vi.fn(),
  refresh: vi.fn(),
  attach: vi.fn(
    (..._args: unknown[]) =>
      () =>
        undefined,
  ),
}));

vi.mock("./native-bridge", () => ({
  isNativeApp: () => mocks.app,
}));
vi.mock("../api/source", async (original) => ({
  ...(await original<typeof import("../api/source")>()),
  installLocalTransport: (transport: unknown) => mocks.install(transport),
}));
vi.mock("../sources/routing", async (original) => ({
  ...(await original<typeof import("../sources/routing")>()),
  pickRoute: (...args: unknown[]) => mocks.route(...args),
}));
vi.mock("./credentials", async (original) => ({
  ...(await original<typeof import("./credentials")>()),
  mobileCredentialProvider: () => ({
    getAccess: vi.fn(),
    refresh: (...args: unknown[]) => mocks.refresh(...args),
    invalidate: vi.fn(),
    cloudAuth: { access: vi.fn(), invalidate: vi.fn() },
  }),
}));
vi.mock("../sources/remote-stream", async (original) => ({
  ...(await original<typeof import("../sources/remote-stream")>()),
  attachRemoteStreams: (...args: unknown[]) => mocks.attach(...args),
}));
vi.mock("./native-oauth", async (original) => ({
  ...(await original<typeof import("./native-oauth")>()),
  completeNativeOAuth: (link: string) => mocks.complete(link),
}));
vi.mock("../platform/layout", () => ({
  isCompactLayout: () => mocks.compact,
}));
vi.mock("../api/runtime-url", async (original) => ({
  ...(await original<typeof import("../api/runtime-url")>()),
  savedRuntimeOrigin: () => mocks.saved,
}));
vi.mock("../api/request", async (original) => ({
  ...(await original<typeof import("../api/request")>()),
  get RUNTIME_VIA_SERVER_SHELL() {
    return mocks.served;
  },
}));
vi.mock("../api/identity", async (original) => ({
  ...(await original<typeof import("../api/identity")>()),
  restoreNativeCredentials: async () => mocks.restored,
  resumeIdentity: async () => {
    if (mocks.session instanceof Error) throw mocks.session;
    return mocks.session;
  },
}));

import { IdentityRequestError } from "../api/identity";
import { resetLocalRuntime } from "../api/local-runtime";
import { resolveRuntimeUrl, setNativeRuntimeBase } from "../api/runtime-url";
import { hostedRelay, resetHostedRelay } from "../sources/hosted";
import { resetSourceRegistry, sourceRegistry } from "../sources/registry";
import { SourceError } from "../sources/types";
import { setActiveConnection, upsertConnection } from "./connections";
import { prepareEntry, ticketWithRefresh } from "./entry";
import { memoryStorage } from "./testing";

beforeEach(() => {
  Object.assign(mocks, {
    app: false,
    served: false,
    compact: true,
    saved: null,
    restored: false,
    session: null,
  });
  mocks.install.mockReset();
  mocks.complete.mockReset();
  mocks.route.mockReset();
  mocks.refresh.mockReset();
  mocks.attach.mockClear();
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  history.replaceState(null, "", "/");
  setNativeRuntimeBase(null);
  resetLocalRuntime();
  resetSourceRegistry();
  vi.unstubAllGlobals();
});

describe("入口分支", () => {
  it("远程服务托管的页面打开在 /j/<linkId>：分享链接落地页；原生 App 不认", async () => {
    history.replaceState(null, "", "/j/0123456789abcdef#secret.token");
    await expect(prepareEntry()).resolves.toEqual({
      kind: "join",
      linkId: "0123456789abcdef",
    });
    expect(mocks.install).not.toHaveBeenCalled();
    history.replaceState(null, "", "/j/short");
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    mocks.app = true;
    history.replaceState(null, "", "/j/0123456789abcdef");
    await expect(prepareEntry()).resolves.not.toMatchObject({ kind: "join" });
  });

  it("个人中转托管（/app/ 下、同源平台信息是 personal）→ 中继登录；别处不问", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            mode: "personal",
            issuer: location.origin,
            capabilities: [],
            webApp: `${location.origin}/app/`,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    expect(fetch).not.toHaveBeenCalled();
    history.replaceState(null, "", "/app/");
    await expect(prepareEntry()).resolves.toEqual({
      kind: "relay",
      issuer: location.origin,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${location.origin}/.well-known/armadra-platform`,
    );
    expect(hostedRelay()?.issuer).toBe(location.origin);
    resetHostedRelay();
  });

  it("桌面与普通网页直接是画布，不装任何传输", async () => {
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    history.replaceState(null, "", "/#pair=abc");
    // 不是经 Gateway 打开的页面，配对片段归设置页。
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("经 Gateway、窄屏、带配对票 → 网页连接页；票留在地址栏", async () => {
    mocks.served = true;
    history.replaceState(null, "", "/#pair=abc");
    await expect(prepareEntry()).resolves.toMatchObject({
      kind: "connect",
      mode: "web",
      via: "ticket",
    });
    expect(location.hash).toBe("#pair=abc");
    mocks.compact = false;
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
  });

  it("经 Gateway、窄屏、没带票：没有会话 → 配对码；有会话或问不到 → 画布", async () => {
    mocks.served = true;
    await expect(prepareEntry()).resolves.toMatchObject({
      kind: "connect",
      mode: "web",
      via: "code",
    });
    mocks.session = { principalId: "p" };
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    mocks.session = new Error("offline");
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    mocks.session = null;
    mocks.compact = false;
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
  });

  it("原生 App：没有来源 → 连接页；有来源有会话 → 装传输进画布", async () => {
    mocks.app = true;
    await expect(prepareEntry()).resolves.toEqual({
      kind: "connect",
      mode: "native",
    });
    expect(mocks.install).not.toHaveBeenCalled();

    mocks.saved = "https://h:8443";
    await expect(prepareEntry()).resolves.toEqual({
      kind: "connect",
      mode: "native",
      origin: "https://h:8443",
    });
    mocks.restored = true;
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://h:8443" }),
    );
  });

  it("原生 App：配对深链（#link=）→ 连接页预填链接，片段随即抹掉", async () => {
    mocks.app = true;
    mocks.saved = "https://h:8443";
    mocks.restored = true;
    const link = "armadra://pair?host=192.168.1.20%3A8443&ticket=t&fp=f";
    history.replaceState(null, "", `/#link=${encodeURIComponent(link)}`);
    await expect(prepareEntry()).resolves.toEqual({
      kind: "connect",
      mode: "native",
      origin: "https://h:8443",
      link,
    });
    expect(location.hash).toBe("");
    expect(mocks.install).not.toHaveBeenCalled();

    // 别的链接不当配对链接用：照常进画布。
    history.replaceState(
      null,
      "",
      `/#link=${encodeURIComponent("https://evil.example/#pair=x")}`,
    );
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
  });
});

describe("原生 OAuth 的深链（R-56）", () => {
  const link = "armadra://oauth?state=s&code=c";
  const open = () =>
    history.replaceState(null, "", `/#link=${encodeURIComponent(link)}`);

  it("有会话：装传输、收尾，结果写成 #oauth= 片段，进画布", async () => {
    mocks.app = true;
    mocks.saved = "https://h:8443";
    mocks.restored = true;
    mocks.complete.mockResolvedValueOnce({
      result: "bound",
      code: "",
      challengeId: "",
    });
    open();
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://h:8443" }),
    );
    expect(mocks.complete).toHaveBeenCalledWith(link);
    expect(location.hash).toBe("#oauth=bound");
  });

  it("没会话：登录成功进画布，失败回连接页；没有来源不收尾", async () => {
    mocks.app = true;
    mocks.saved = "https://h:8443";
    mocks.complete.mockResolvedValueOnce({
      result: "signedIn",
      code: "",
      challengeId: "",
    });
    open();
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });

    mocks.complete.mockResolvedValueOnce({
      result: "error",
      code: "oauth_not_bound",
      challengeId: "",
    });
    open();
    await expect(prepareEntry()).resolves.toEqual({
      kind: "connect",
      mode: "native",
      origin: "https://h:8443",
    });
    expect(location.hash).toBe("#oauth=error&code=oauth_not_bound");

    // 没会话而走到第二因素：入口接着做第二步，中间票不进地址栏。
    history.replaceState(null, "", "/");
    mocks.complete.mockResolvedValueOnce({
      result: "mfa",
      code: "",
      challengeId: "ch-1",
    });
    open();
    await expect(prepareEntry()).resolves.toEqual({
      kind: "mfa",
      origin: "https://h:8443",
      challengeId: "ch-1",
    });
    expect(location.hash).toBe("");

    // 有会话时走到第二因素仍交给「安全」页（片段照写）。
    mocks.restored = true;
    mocks.complete.mockResolvedValueOnce({
      result: "mfa",
      code: "",
      challengeId: "ch-2",
    });
    open();
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    expect(location.hash).toBe("#oauth=mfa&challengeId=ch-2");
    mocks.restored = false;

    mocks.saved = null;
    mocks.complete.mockClear();
    open();
    await expect(prepareEntry()).resolves.toEqual({
      kind: "connect",
      mode: "native",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

describe("ticketWithRefresh", () => {
  const expired = () => new IdentityRequestError(401, "UNAUTHENTICATED", "", 0);

  it("访问密钥过期时轮转一次再换票", async () => {
    const fetchTicket = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(expired())
      .mockResolvedValueOnce("T2");
    const refresh = vi.fn(async () => true);
    await expect(ticketWithRefresh(fetchTicket, refresh)).resolves.toBe("T2");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
  });

  it("刷新不成、或不是 401，原样抛出", async () => {
    const refresh = vi.fn(async () => false);
    await expect(
      ticketWithRefresh(() => Promise.reject(expired()), refresh),
    ).rejects.toBeInstanceOf(IdentityRequestError);
    const other = new IdentityRequestError(403, "PERMISSION_DENIED", "", 0);
    const untouched = vi.fn(async () => true);
    await expect(
      ticketWithRefresh(() => Promise.reject(other), untouched),
    ).rejects.toBe(other);
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe("原生 App：多连接", () => {
  const GATEWAY = "https://192.168.1.8:8443";
  const ISSUER = "https://relay.example.com";
  const HOST = "a".repeat(32);
  const RELAY_BASE = `${ISSUER}/s/${HOST}`;

  /** 原生 App 里页面打在包里：本机源的地址按这次选定的连接算。 */
  const runtimeBase = () => {
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    return resolveRuntimeUrl(undefined, "capacitor://localhost/");
  };

  const addDirect = () =>
    upsertConnection({
      sourceId: HOST,
      label: "",
      baseUrl: GATEWAY,
      relayOrigin: "",
      cloudIssuer: "",
      fingerprint: "ab".repeat(32),
    });
  const addRelayed = () =>
    upsertConnection({
      sourceId: HOST,
      label: "MacBook",
      baseUrl: "",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
      fingerprint: "",
    });

  it("当前连接走直连：选路 → 本机源指向 Gateway，传输不带中继头", async () => {
    mocks.app = true;
    mocks.restored = true;
    addDirect();
    mocks.route.mockResolvedValue({
      via: "direct",
      access: {
        accessToken: "t",
        expiresAtMs: 0,
        httpBase: GATEWAY,
        wsBase: "wss://192.168.1.8:8443",
      },
    });
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    const transport = mocks.install.mock.calls[0]![0] as {
      origin: string;
      extraHeaders?: () => Record<string, string>;
    };
    expect(transport.origin).toBe(GATEWAY);
    expect(transport.extraHeaders).toBeUndefined();
    expect(runtimeBase()).toBe(GATEWAY);
  });

  it("当前连接经中继：本机源指向 relayBaseUrl，每个请求与流都带中继令牌", async () => {
    mocks.app = true;
    mocks.restored = true;
    addRelayed();
    mocks.route.mockResolvedValue({
      via: "relayed",
      access: {
        accessToken: "t",
        expiresAtMs: 0,
        httpBase: RELAY_BASE,
        wsBase: RELAY_BASE.replace("https", "wss"),
        relayToken: "relay.jwt",
      },
    });
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    const transport = mocks.install.mock.calls[0]![0] as {
      origin: string;
      extraHeaders: () => Record<string, string>;
      extraProtocols: () => string[];
    };
    expect(transport.origin).toBe(ISSUER);
    expect(transport.extraHeaders()).toEqual({
      "armadra-relay-token": "relay.jwt",
    });
    expect(transport.extraProtocols()).toEqual(["armadra-relay.relay.jwt"]);
    expect(runtimeBase()).toBe(RELAY_BASE);
  });

  it("表里不止一个连接：选中的装成本机源，其余同时挂进页面源表，经中继的开 me.stream", async () => {
    mocks.app = true;
    mocks.restored = true;
    addDirect();
    const OTHER = "b".repeat(32);
    upsertConnection({
      sourceId: OTHER,
      label: "Studio",
      baseUrl: "",
      relayOrigin: ISSUER,
      cloudIssuer: ISSUER,
      fingerprint: "",
    });
    setActiveConnection(HOST);
    mocks.route.mockImplementation(() => new Promise(() => undefined));
    mocks.route.mockResolvedValueOnce({
      via: "direct",
      access: {
        accessToken: "t",
        expiresAtMs: 0,
        httpBase: GATEWAY,
        wsBase: "wss://192.168.1.8:8443",
      },
    });
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    const ids = sourceRegistry()
      .list()
      .map((row) => row.descriptor.sourceId);
    expect(ids).toEqual(["local", OTHER]);
    expect(sourceRegistry().get(OTHER)?.descriptor.label).toBe("Studio");
    expect(mocks.attach).toHaveBeenCalledTimes(1);
  });

  it("只有一个连接：页面源表不动，与单源时一样", async () => {
    mocks.app = true;
    mocks.restored = true;
    addDirect();
    mocks.route.mockResolvedValue({
      via: "direct",
      access: {
        accessToken: "t",
        expiresAtMs: 0,
        httpBase: GATEWAY,
        wsBase: "wss://192.168.1.8:8443",
      },
    });
    await expect(prepareEntry()).resolves.toEqual({ kind: "app" });
    expect(sourceRegistry().list()).toHaveLength(1);
    expect(sourceRegistry().local().descriptor.label).toBe("");
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("选中的连接连不上：回连接页，带着连接表与原因，其余连接可选", async () => {
    mocks.app = true;
    addDirect();
    mocks.route.mockRejectedValue(new SourceError("source_offline"));
    await expect(prepareEntry()).resolves.toMatchObject({
      kind: "connect",
      mode: "native",
      failure: "offline",
      activeId: HOST,
      connections: [expect.objectContaining({ sourceId: HOST })],
    });
    mocks.route.mockRejectedValue(new SourceError("source_unauthorized"));
    await expect(prepareEntry()).resolves.toMatchObject({ failure: "expired" });
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("续期经凭据来源，换来的中继令牌立刻生效", async () => {
    mocks.app = true;
    mocks.restored = true;
    addRelayed();
    mocks.route.mockResolvedValue({
      via: "relayed",
      access: {
        accessToken: "t",
        expiresAtMs: 0,
        httpBase: RELAY_BASE,
        wsBase: RELAY_BASE.replace("https", "wss"),
        relayToken: "relay.old",
      },
    });
    await prepareEntry();
    const transport = mocks.install.mock.calls[0]![0] as {
      refresh: () => Promise<boolean>;
      extraHeaders: () => Record<string, string>;
    };
    mocks.refresh.mockResolvedValue({
      accessToken: "t2",
      expiresAtMs: 0,
      httpBase: RELAY_BASE,
      wsBase: RELAY_BASE.replace("https", "wss"),
      relayToken: "relay.new",
    });
    await expect(transport.refresh()).resolves.toBe(true);
    expect(mocks.refresh).toHaveBeenCalledWith(HOST, "relayed");
    expect(transport.extraHeaders()["armadra-relay-token"]).toBe("relay.new");
  });

  it("分享深链：连接页直接挂载；#connections：管理页；两者都不选路", async () => {
    mocks.app = true;
    addDirect();
    setActiveConnection(HOST);
    const join = `armadra://join?link=${"0".repeat(32)}&issuer=${encodeURIComponent(ISSUER)}&s=x`;
    history.replaceState(null, "", `/#link=${encodeURIComponent(join)}`);
    await expect(prepareEntry()).resolves.toMatchObject({
      kind: "connect",
      link: join,
      join: true,
      connections: [expect.objectContaining({ sourceId: HOST })],
    });
    history.replaceState(null, "", "/#connections");
    await expect(prepareEntry()).resolves.toMatchObject({
      kind: "connect",
      manage: true,
      activeId: HOST,
    });
    expect(location.hash).toBe("");
    expect(mocks.route).not.toHaveBeenCalled();
  });
});
