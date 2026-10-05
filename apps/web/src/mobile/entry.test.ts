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
}));

vi.mock("./native-bridge", () => ({
  isNativeApp: () => mocks.app,
}));
vi.mock("../api/source", async (original) => ({
  ...(await original<typeof import("../api/source")>()),
  installLocalTransport: (transport: unknown) => mocks.install(transport),
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
import { prepareEntry, ticketWithRefresh } from "./entry";

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
});
afterEach(() => {
  history.replaceState(null, "", "/");
});

describe("入口分支", () => {
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
