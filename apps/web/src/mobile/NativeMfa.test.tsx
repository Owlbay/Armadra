import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { IdentityRequestError } from "../api/identity";

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("../api/security", async (original) => ({
  ...(await original<typeof import("../api/security")>()),
  verifyMfa: (...args: never[]) => mocks.verify(...args),
  oauthProviders: async () => ({ configured: false, providers: [] }),
}));
// 画布本体与推送细节不在这条路上：只看第二步之后进没进画布。
vi.mock("../app/App", () => ({ App: () => <p>canvas</p> }));
vi.mock("./PushPermission", () => ({ PushPermission: () => null }));
vi.mock("./push-open", () => ({ usePushOpen: () => undefined }));
vi.mock("./push-rotation", () => ({ usePushRotation: () => undefined }));
vi.mock("./native-bridge", async (original) => ({
  ...(await original<typeof import("./native-bridge")>()),
  nativeBridge: () => ({ canScan: false, scan: async () => null }),
}));

import { usePreferencesStore } from "../app/preferences-store";
import { installDomPolyfills } from "../app/test-harness";
import { useCanvasStore } from "../store/canvas-store";
import { MobileRoot } from "./MobileRoot";

const SESSION = {
  hostId: "h",
  device: {
    deviceId: "d",
    principalId: "p".repeat(32),
    displayName: "",
    role: "member",
    createdAtUnixMs: 0,
    revision: 0,
  },
  scopes: [],
  expiresAtUnixMs: 0,
};

const entry = {
  kind: "mfa" as const,
  origin: "https://h:8443",
  challengeId: "ch-native",
};

installDomPolyfills();
beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mocks.verify.mockReset();
});
afterEach(cleanup);

describe("原生 App · OAuth 登录的第二步（G5-22 残项）", () => {
  it("直接停在两步验证，码对了换出会话进画布；要求登记时打开「安全」", async () => {
    mocks.verify.mockRejectedValueOnce(
      new IdentityRequestError(401, "mfa_invalid_code", ""),
    );
    mocks.verify.mockResolvedValueOnce({
      kind: "session",
      session: SESSION,
      mfaEnrollmentRequired: true,
    });
    render(<MobileRoot entry={entry} />);
    expect(
      await screen.findByRole("heading", { name: "两步验证" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "111111" },
    });
    expect(await screen.findByText("验证码不对")).toBeTruthy();
    expect(screen.queryByText("canvas")).toBeNull();

    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "222222" },
    });
    expect(await screen.findByText("canvas")).toBeTruthy();
    expect(mocks.verify).toHaveBeenNthCalledWith(1, "ch-native", "111111");
    expect(mocks.verify).toHaveBeenNthCalledWith(2, "ch-native", "222222");
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("security");
    expect(useCanvasStore.getState().panels.settings).toBe(true);
  });

  it("「返回连接页」回到这台 Gateway 的连接页，不发验证请求", async () => {
    render(<MobileRoot entry={entry} />);
    fireEvent.click(await screen.findByRole("button", { name: "返回连接页" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "连接到 Armadra" }),
      ).toBeTruthy(),
    );
    // 记下过来源：配对码入口在。
    expect(screen.getByRole("button", { name: "输入配对码" })).toBeTruthy();
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
