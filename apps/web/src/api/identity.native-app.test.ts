import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 原生 App（Capacitor）上的身份传输：Bearer + 钥匙串（架构 §7、§10）。 */
const mocks = vi.hoisted(() => ({
  app: true,
  stored: null as null | {
    origin: string;
    accessToken: string;
    refreshToken: string;
  },
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../mobile/native-bridge", () => ({
  isNativeApp: () => mocks.app,
  nativeBridge: () => ({
    available: mocks.app,
    loadSession: async () => mocks.stored,
    saveSession: async (session: unknown) => mocks.saveSession(session),
    clearSession: async () => mocks.clearSession(),
  }),
}));

import {
  currentAccessToken,
  fetchWsTicket,
  logoutIdentity,
  pairWithGateway,
  resetIdentityCredentials,
  resumeIdentity,
  sessionCapability,
  NATIVE_SESSION_CAPABILITY,
} from "./identity";
import { localSource } from "./source";

const LOCAL_BASE = localSource.httpBase;

const ACCESS = "a".repeat(43);
const REFRESH = "r".repeat(43);
const GATEWAY = "https://192.168.1.8:8443";

const session = {
  hostId: "h1",
  device: { deviceId: "d1" },
  native: { accessToken: ACCESS, refreshToken: REFRESH },
};

let calls: { url: string; init: RequestInit }[];

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  mocks.app = true;
  mocks.stored = null;
  mocks.saveSession.mockReset();
  mocks.clearSession.mockReset();
  resetIdentityCredentials();
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("原生 App 的身份传输", () => {
  it("对还没记下的 Gateway 配对：密钥进内存与钥匙串，绑着这个来源", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer(200, session);
      }),
    );
    await pairWithGateway(GATEWAY, "tk.secret");
    expect(calls[0]!.url).toBe(`${GATEWAY}/api/identity/pair`);
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      ticket: "tk.secret",
    });
    expect(currentAccessToken()).toBe(ACCESS);
    expect(mocks.saveSession).toHaveBeenCalledWith({
      origin: GATEWAY,
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    expect(sessionCapability()).toBe(NATIVE_SESSION_CAPABILITY);
  });

  it("重开 App：从钥匙串读回会话；来源换了就不用", async () => {
    mocks.stored = {
      origin: LOCAL_BASE,
      accessToken: ACCESS,
      refreshToken: REFRESH,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer(200, { ...session, native: undefined });
      }),
    );
    await expect(resumeIdentity()).resolves.toMatchObject({ hostId: "h1" });
    expect(
      (calls[0]!.init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${ACCESS}`);

    resetIdentityCredentials();
    calls = [];
    mocks.stored = { ...mocks.stored, origin: "https://other:1" };
    await expect(resumeIdentity()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("刷新密钥也被拒：钥匙串作废，回连接页", async () => {
    mocks.stored = {
      origin: LOCAL_BASE,
      accessToken: ACCESS,
      refreshToken: REFRESH,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(401, { code: "unauthenticated" })),
    );
    await expect(resumeIdentity()).resolves.toBeNull();
    expect(mocks.clearSession).toHaveBeenCalled();
    expect(currentAccessToken()).toBe("");
  });

  it("WebSocket 票用访问密钥换；登出清钥匙串", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/pair")) return answer(200, session);
        if (url.endsWith("/ws-ticket"))
          return answer(200, { ticket: "T", expiresAt: "x" });
        return answer(200, { closed: true });
      }),
    );
    await pairWithGateway(LOCAL_BASE, "t");
    await expect(fetchWsTicket()).resolves.toBe("T");
    const ticketCall = calls.find((call) => call.url.endsWith("/ws-ticket"))!;
    expect(ticketCall.init.method).toBe("POST");
    expect(
      (ticketCall.init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${ACCESS}`);
    await logoutIdentity();
    expect(mocks.clearSession).toHaveBeenCalled();
  });
});
