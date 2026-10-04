import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

/**
 * 桌面壳签不出票时说清楚原因（契约 §3.2）：Windows 上接管了上一个 core 或外接
 * Runtime 时没有 IPC 取票路，每个请求都会 401——不能静默。
 */

const mocks = vi.hoisted(() => ({
  ticket: vi.fn<() => Promise<string>>(),
}));

vi.mock("../api/client", () => ({
  runtimeApi: {
    health: () => Promise.resolve({ ok: true }),
    terminalBackend: () => Promise.resolve({ kind: "direct" }),
    agentIntegration: () => Promise.resolve({ legacy: { found: [] } }),
    agents: () => Promise.resolve([]),
  },
}));

vi.mock("../host/native-session", async (original) => {
  const actual = await original<typeof import("../host/native-session")>();
  return {
    ...actual,
    isNativeShell: () => true,
    fetchNativeTicket: () => mocks.ticket(),
  };
});

const { HostNativeSessionError } = await import("../host/native-session");
const { resetIdentityCredentials, shellBearer, shellSessionFailure } =
  await import("../api/identity");
const { installDomPolyfills, TestProviders } = await import(
  "../app/test-harness"
);
const { usePreferencesStore } = await import("../app/preferences-store");
const { Banners } = await import("./Banners");

installDomPolyfills();

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  resetIdentityCredentials();
  mocks.ticket.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        hostId: "h",
        device: { deviceId: "d" },
        scopes: [],
        expiresAtUnixMs: Date.now() + 900_000,
        native: { accessToken: "A", refreshToken: "R" },
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetIdentityCredentials();
});

describe("桌面壳取不到会话", () => {
  it("壳拿不到票时挂一条通知条说原因；重试配上对就消失", async () => {
    mocks.ticket.mockRejectedValueOnce(
      new HostNativeSessionError("channelUnavailable"),
    );
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    await act(async () => {
      expect(await shellBearer()).toBe("");
    });
    expect(shellSessionFailure()).toBe("channelUnavailable");
    expect(await screen.findByText(/请退出 Armadra 后重新打开/)).toBeTruthy();

    mocks.ticket.mockResolvedValueOnce("ticket");
    await act(async () => {
      screen.getByRole("button", { name: "重连" }).click();
      await vi.waitFor(() => expect(shellSessionFailure()).toBe(null));
    });
    expect(screen.queryByText(/请退出 Armadra 后重新打开/)).toBeNull();
  });
});
