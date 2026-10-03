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
import { SecurityPage } from "./SecurityPage";

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
      <SecurityPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", window.location.pathname);
});

describe("SecurityPage", () => {
  it("成员：两步验证要求排第一，会话列出，审计不出现", async () => {
    mocks.resume.mockResolvedValue(session(["canvas:read"]));
    mount();
    expect(await screen.findByText("需要开启两步验证")).toBeTruthy();
    expect(await screen.findByText("这台")).toBeTruthy();
    expect(
      screen.getByText("用 IP 地址访问时无法使用通行密钥，请改用域名"),
    ).toBeTruthy();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent);
    expect(headings[0]).toBe("两步验证");
    expect(headings).not.toContain("审计");
  });

  it("owner 看得到审计", async () => {
    mocks.resume.mockResolvedValue(session(["identity:manage"]));
    mount();
    expect(await screen.findByRole("heading", { name: "审计" })).toBeTruthy();
    expect(
      await screen.findByRole("switch", { name: "所有成员" }),
    ).toBeTruthy();
  });

  it("没登录：登录表单；OAuth 回调的 mfa 片段直接进第二步并抹掉地址栏", async () => {
    mocks.resume.mockResolvedValue(null);
    window.history.replaceState(null, "", "#oauth=mfa&challengeId=ch1");
    mount();
    expect(
      await screen.findByRole("heading", { name: "两步验证" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("验证码")).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("OAuth 错误：没登录时写在表单里，登录了弹一条", async () => {
    mocks.resume.mockResolvedValue(null);
    window.history.replaceState(null, "", "#oauth=error&code=oauth_not_bound");
    mount();
    expect(await screen.findByText("这个账号还没有绑定")).toBeTruthy();

    cleanup();
    mocks.resume.mockResolvedValue(session([]));
    window.history.replaceState(null, "", "#oauth=bound");
    mount();
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("已绑定"),
    );
  });
});
