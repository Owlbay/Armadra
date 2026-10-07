import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  open: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("../api/identity", async (original) => {
  const actual = await original<typeof import("../api/identity")>();
  return {
    ...actual,
    resumeIdentity: (...args: never[]) => mocks.resume(...args),
  };
});

vi.mock("../api/security", async (original) => {
  const actual = await original<typeof import("../api/security")>();
  return {
    ...actual,
    oauthProviders: async () => ({ configured: false, providers: [] }),
    openPasswordReset: (...args: never[]) => mocks.open(...args),
    completePasswordReset: (...args: never[]) => mocks.complete(...args),
  };
});

import { usePreferencesStore } from "./preferences-store";
import { installDomPolyfills } from "./test-harness";
import { IdentityGate, forgetPendingReset } from "./IdentityGate";

installDomPolyfills();

const PRINCIPAL = "p".repeat(32);
const SESSION = {
  hostId: "h",
  device: {
    deviceId: "d",
    principalId: PRINCIPAL,
    displayName: "",
    role: "member",
    createdAtUnixMs: 0,
    revision: 0,
  },
  scopes: [],
  expiresAtUnixMs: 0,
};

function mount(server = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IdentityGate server={server}>
        <div>画布</div>
      </IdentityGate>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  forgetPendingReset();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IdentityGate", () => {
  it("桌面窗口直接是壳，不问会话", () => {
    mount(false);
    expect(screen.getByText("画布")).toBeTruthy();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("服务器壳没有会话：整页登录，没有壳", async () => {
    mocks.resume.mockResolvedValue(null);
    const { container } = mount();
    expect(await screen.findByRole("heading", { name: "登录" })).toBeTruthy();
    expect(screen.queryByText("画布")).toBeNull();
    expect(container.querySelector('[data-slot="identity-page"]')).toBeTruthy();
  });

  it("有会话或问不到会话时照常进壳", async () => {
    mocks.resume.mockResolvedValue(SESSION);
    mount();
    expect(await screen.findByText("画布")).toBeTruthy();
    cleanup();
    mocks.resume.mockRejectedValue(new Error("offline"));
    mount();
    expect(await screen.findByText("画布")).toBeTruthy();
  });

  it("带着邀请、配对或 OAuth 片段时进壳，由设置页接手", async () => {
    for (const hash of [
      `#invite=${"e".repeat(32)}.x`,
      "#pair=ticket",
      "#oauth=error&code=oauth_denied",
    ]) {
      history.replaceState(null, "", `/${hash}`);
      mount();
      expect(screen.getByText("画布")).toBeTruthy();
      cleanup();
    }
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("#reset=：整页设新口令，取走片段；设好后去登录且账号已填", async () => {
    const token = `${"a".repeat(32)}.${"B".repeat(43)}`;
    history.replaceState(null, "", `/#reset=${token}`);
    mocks.open.mockResolvedValue({
      displayName: "同事",
      expiresAtMs: Date.UTC(2026, 9, 5, 12),
    });
    mocks.complete.mockResolvedValue({
      principalId: PRINCIPAL,
      revokedSessions: 2,
    });
    mocks.resume.mockResolvedValue(null);
    mount();
    expect(
      await screen.findByRole("heading", { name: "设置新口令" }),
    ).toBeTruthy();
    expect(location.hash).toBe("");
    expect(mocks.open).toHaveBeenCalledWith(token);
    expect(screen.getByText("同事")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("新口令"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("再输一次"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "设置口令" }));
    await waitFor(() =>
      expect(mocks.complete).toHaveBeenCalledWith(
        token,
        "correct horse battery",
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "去登录" }));
    // 直接到口令步，账号是刚设好口令的那个人。
    expect(await screen.findByRole("heading", { name: "登录" })).toBeTruthy();
    expect(screen.getByLabelText("口令")).toBeTruthy();
    expect(
      (document.querySelector('input[name="username"]') as HTMLInputElement)
        .value,
    ).toBe(PRINCIPAL);
  });

  it("已经开着的页面里贴进重置链接（只改片段）也会转到重置页", async () => {
    mocks.resume.mockResolvedValue(SESSION);
    mocks.open.mockResolvedValue({
      displayName: "同事",
      expiresAtMs: Date.UTC(2026, 9, 5, 12),
    });
    mount();
    expect(await screen.findByText("画布")).toBeTruthy();
    const token = `${"c".repeat(32)}.${"D".repeat(43)}`;
    history.replaceState(null, "", `/#reset=${token}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(
      await screen.findByRole("heading", { name: "设置新口令" }),
    ).toBeTruthy();
    expect(mocks.open).toHaveBeenCalledWith(token);
    expect(location.hash).toBe("");
  });
});
