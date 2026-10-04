import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  adopt: vi.fn(),
}));

vi.mock("../api/identity", async (original) => ({
  ...(await original<typeof import("../api/identity")>()),
  identityRequest: mocks.request,
  adoptIdentitySession: mocks.adopt,
}));

import { IdentityRequestError } from "../api/identity";
import type { NativeBridge } from "./native-bridge";
import {
  completeNativeOAuth,
  oauthFragment,
  parseNativeOAuthLink,
  readPendingNativeOAuth,
  startNativeOAuth,
} from "./native-oauth";

const STATE = "s".repeat(43);
const AUTHORIZE = `https://idp.example/authorize?client_id=c&state=${STATE}`;
const SESSION = {
  hostId: "h",
  device: {
    deviceId: "d",
    principalId: "p",
    displayName: "n",
    role: "owner",
    createdAtUnixMs: 1,
  },
  scopes: [],
  expiresAtUnixMs: 2,
  native: { accessToken: "a", refreshToken: "r" },
};

function bridge(opened: boolean): NativeBridge {
  return {
    openExternal: vi.fn(async () => opened),
  } as unknown as NativeBridge;
}

async function begin(mode: "login" | "bind" = "login") {
  mocks.request.mockResolvedValueOnce({
    authorizeUrl: AUTHORIZE,
    expiresAtMs: Date.now() + 600_000,
    nativeState: "n".repeat(43),
  });
  const native = bridge(true);
  await startNativeOAuth("corp", mode, "Armadra · iPhone", native);
  return native;
}

beforeEach(() => {
  localStorage.clear();
  mocks.request.mockReset();
  mocks.adopt.mockReset();
});
afterEach(() => localStorage.clear());

describe("原生 OAuth：发起", () => {
  it("要 native=1 的授权地址，记下 state 与 nativeState，交给系统浏览器", async () => {
    const native = await begin("bind");
    expect(mocks.request).toHaveBeenCalledWith(
      "oauth/corp/start?native=1",
      expect.anything(),
      expect.objectContaining({
        method: "POST",
        anonymous: false,
        body: { mode: "bind", deviceName: "Armadra · iPhone" },
      }),
    );
    expect(native.openExternal).toHaveBeenCalledWith(AUTHORIZE);
    expect(readPendingNativeOAuth()).toMatchObject({
      providerId: "corp",
      state: STATE,
      nativeState: "n".repeat(43),
    });
  });

  it("插件旧（打不开浏览器）或 core 旧（没给 nativeState）：oauth_browser_required，不留记录", async () => {
    mocks.request.mockResolvedValueOnce({
      authorizeUrl: AUTHORIZE,
      expiresAtMs: Date.now() + 1000,
      nativeState: "n",
    });
    await expect(
      startNativeOAuth("corp", "login", "x", bridge(false)),
    ).rejects.toMatchObject({ code: "oauth_browser_required" });
    expect(readPendingNativeOAuth()).toBeNull();
    mocks.request.mockResolvedValueOnce({
      authorizeUrl: AUTHORIZE,
      expiresAtMs: Date.now() + 1000,
    });
    await expect(
      startNativeOAuth("corp", "login", "x", bridge(true)),
    ).rejects.toMatchObject({ code: "oauth_browser_required" });
  });
});

describe("原生 OAuth：收尾", () => {
  it("深链只认 armadra://oauth?state=…&code=|error=", () => {
    expect(parseNativeOAuthLink(`armadra://oauth?state=a&code=b`)).toEqual({
      state: "a",
      code: "b",
    });
    expect(
      parseNativeOAuthLink(`armadra://oauth?state=a&error=access_denied`),
    ).toEqual({ state: "a", error: "access_denied" });
    expect(parseNativeOAuthLink("armadra://oauth?state=a")).toBeNull();
    expect(parseNativeOAuthLink("armadra://pair?state=a&code=b")).toBeNull();
  });

  it("登录：带 nativeState 收尾，会话交给身份层；记录用过即删", async () => {
    await begin();
    mocks.request.mockResolvedValueOnce({
      result: "signedIn",
      session: SESSION,
    });
    const outcome = await completeNativeOAuth(
      `armadra://oauth?state=${STATE}&code=c0de`,
    );
    expect(outcome).toEqual({ result: "signedIn", code: "", challengeId: "" });
    expect(mocks.request).toHaveBeenLastCalledWith(
      "oauth/corp/native",
      expect.anything(),
      expect.objectContaining({
        anonymous: true,
        body: { state: STATE, nativeState: "n".repeat(43), code: "c0de" },
      }),
    );
    expect(mocks.adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        native: { accessToken: "a", refreshToken: "r" },
      }),
    );
    expect(readPendingNativeOAuth()).toBeNull();
    expect(oauthFragment(outcome)).toBe("#oauth=signedIn");
  });

  it("别处塞来的深链（state 对不上）不碰记录、不发请求", async () => {
    await begin();
    const calls = mocks.request.mock.calls.length;
    await expect(
      completeNativeOAuth("armadra://oauth?state=attacker&code=x"),
    ).resolves.toMatchObject({ result: "error", code: "oauth_state_invalid" });
    expect(mocks.request.mock.calls.length).toBe(calls);
    expect(readPendingNativeOAuth()).not.toBeNull();
  });

  it("提供方拒绝、core 拒绝、过期：结果是 error 带码", async () => {
    await begin();
    mocks.request.mockRejectedValueOnce(
      new IdentityRequestError(403, "oauth_denied", ""),
    );
    const denied = await completeNativeOAuth(
      `armadra://oauth?state=${STATE}&error=access_denied`,
    );
    expect(denied).toEqual({
      result: "error",
      code: "oauth_denied",
      challengeId: "",
    });
    expect(mocks.request).toHaveBeenLastCalledWith(
      "oauth/corp/native",
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({ error: "access_denied" }),
      }),
    );
    expect(oauthFragment(denied)).toBe("#oauth=error&code=oauth_denied");

    await begin();
    const calls = mocks.request.mock.calls.length;
    await expect(
      completeNativeOAuth(
        `armadra://oauth?state=${STATE}&code=c`,
        () => Date.now() + 3_600_000,
      ),
    ).resolves.toMatchObject({ code: "oauth_state_invalid" });
    expect(mocks.request.mock.calls.length).toBe(calls);
  });

  it("第二因素：带中间票，不动会话", async () => {
    await begin();
    mocks.request.mockResolvedValueOnce({ result: "mfa", challengeId: "c1" });
    const outcome = await completeNativeOAuth(
      `armadra://oauth?state=${STATE}&code=c`,
    );
    expect(outcome).toEqual({ result: "mfa", code: "", challengeId: "c1" });
    expect(mocks.adopt).not.toHaveBeenCalled();
    expect(oauthFragment(outcome)).toBe("#oauth=mfa&challengeId=c1");
  });
});
