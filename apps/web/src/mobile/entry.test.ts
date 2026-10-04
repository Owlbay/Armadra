import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: false,
  served: false,
  compact: true,
  saved: null as string | null,
  restored: false,
  session: null as unknown,
  install: vi.fn(),
}));

vi.mock("./native-bridge", () => ({
  isNativeApp: () => mocks.app,
  installNativeTransport: (transport: unknown) => mocks.install(transport),
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
