import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("../../../../api/identity", async (original) => {
  const actual = await original<typeof import("../../../../api/identity")>();
  return {
    ...actual,
    resumeIdentity: (...args: never[]) => mocks.resume(...args),
    renewCsrf: async () => "",
  };
});

vi.mock("../../../../api/security", async (original) => {
  const actual = await original<typeof import("../../../../api/security")>();
  return {
    ...actual,
    mfaStatus: async () => ({
      enrolled: false,
      pending: false,
      enrolledAtMs: 0,
      verifiedAtMs: 0,
      recoveryCodesRemaining: 0,
      requireFor: "all",
      required: true,
    }),
    listPasskeys: async () => ({
      available: false,
      rpId: "",
      reason: "passkey_unavailable_on_ip_host",
      passkeys: [],
    }),
    oauthProviders: async () => ({ configured: false, providers: [] }),
    oauthBindings: async () => [],
    listSessions: async () => [
      {
        sessionId: "s1",
        principalId: "p".repeat(32),
        deviceId: "d1",
        deviceName: "这台",
        createdAtMs: 1,
        lastSeenAtMs: 2,
        expiresAtMs: 3,
        remoteIp: "127.0.0.1",
        userAgent: "",
        current: true,
      },
    ],
    listLockouts: async () => [],
    listMembers: async () => [],
    readAudit: async () => ({ entries: [], nextBeforeId: 0 }),
  };
});

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { LoginSessions } from "./LoginSessions";

installDomPolyfills();

function session(scopes: string[]) {
  return {
    hostId: "h",
    device: {
      deviceId: "d1",
      principalId: "p".repeat(32),
      displayName: "",
      role: "member",
      createdAtUnixMs: 0,
      revision: 0,
    },
    scopes: scopes.map((permission) => ({
      permission,
      workspaceId: "",
      executionHostId: "",
    })),
    expiresAtUnixMs: 0,
  };
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LoginSessions />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(cleanup);

describe("LoginSessions", () => {
  it("有会话时列出登录会话；成员看不到「所有成员」", async () => {
    mocks.resume.mockResolvedValue(session(["canvas:read"]));
    mount();
    expect(await screen.findByText("这台")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "所有成员" })).toBeNull();
  });

  it("有管理权时可以看所有成员的会话", async () => {
    mocks.resume.mockResolvedValue(session(["identity:manage"]));
    mount();
    expect(
      await screen.findByRole("switch", { name: "所有成员" }),
    ).toBeTruthy();
  });

  it("没有会话时整块不出现", async () => {
    mocks.resume.mockResolvedValue(null);
    const view = mount();
    await waitFor(() => expect(mocks.resume).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });
});
