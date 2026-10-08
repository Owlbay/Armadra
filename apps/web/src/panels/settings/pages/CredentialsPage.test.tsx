import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getSettings = vi.fn();
const copilotAuth = vi.fn();
const copilotLogin = vi.fn();
const copilotPoll = vi.fn();
const copilotLogout = vi.fn();
vi.mock("../../../api/client", () => ({
  runtimeApi: {
    settings: () => getSettings(),
    updateSettings: vi.fn(),
    copilotAuth: () => copilotAuth(),
    copilotLogin: () => copilotLogin(),
    copilotPoll: () => copilotPoll(),
    copilotLogout: () => copilotLogout(),
  },
}));
// 节点凭据与模型密钥各有自己的测试；这里只看它们挂在这一页上。
vi.mock("./AgentCredentials", () => ({
  AgentCredentials: () => <div data-testid="node-credentials" />,
}));
vi.mock("./AmaKeys", () => ({
  AmaKeys: () => <div data-testid="ama-keys" />,
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { usePreferencesStore } from "../../../app/preferences-store";
import { CredentialsPage } from "./CredentialsPage";

installDomPolyfills();
afterEach(cleanup);

function renderPage() {
  return render(
    <TestProviders>
      <CredentialsPage />
    </TestProviders>,
  );
}

describe("CredentialsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ locale: "zh-CN" });
    getSettings.mockResolvedValue({ usage: { enabled: true } });
    copilotAuth.mockResolvedValue({ signedIn: false, backend: "keychain" });
  });

  it("节点凭据、模型密钥与 Copilot 登录都在这一页", async () => {
    renderPage();
    expect(screen.getByTestId("node-credentials")).toBeTruthy();
    expect(screen.getByTestId("ama-keys")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "登录" })).toBeTruthy();
  });

  it("用量页的 Copilot 开关关着时不能开始登录", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, copilotUsage: false },
    });
    renderPage();
    const signIn = await screen.findByRole("button", { name: "登录" });
    await waitFor(() =>
      expect((signIn as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("Copilot 登录显示用户码，且不显示任何 device code", async () => {
    getSettings.mockResolvedValue({
      usage: { enabled: true, copilotUsage: true },
    });
    copilotLogin.mockResolvedValue({
      signedIn: false,
      backend: "keychain",
      pending: {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
    renderPage();
    const signIn = await screen.findByRole("button", { name: "登录" });
    await waitFor(() =>
      expect((signIn as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(signIn);
    await screen.findByText("WDJB-MJHT");
    expect(screen.getByText(/github\.com\/login\/device/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "登出" })).toBeNull();
  });

  it("Copilot 一行只说令牌存在哪儿", async () => {
    copilotAuth.mockResolvedValue({ signedIn: true, backend: "dpapi" });
    renderPage();
    await screen.findByText("令牌经 Windows DPAPI 加密保存。");
  });

  it("已登录时提供登出，文件后端会说明这是降级", async () => {
    copilotAuth.mockResolvedValue({ signedIn: true, backend: "file" });
    copilotLogout.mockResolvedValue({ signedIn: false, backend: "file" });
    renderPage();
    const signOut = await screen.findByRole("button", { name: "登出" });
    await waitFor(() =>
      expect((signOut as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(signOut);
    await waitFor(() => expect(copilotLogout).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText("本平台没有可用的钥匙串，令牌存在权限 0600 的文件里。"),
    ).toBeTruthy();
  });
});
