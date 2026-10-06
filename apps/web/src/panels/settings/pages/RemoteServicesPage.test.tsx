import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { installDomPolyfills } from "@/app/test-harness";

const api = vi.hoisted(() => ({
  listSources: vi.fn(),
  addPersonalRelay: vi.fn(),
  addDirectSource: vi.fn(),
  logoutRemote: vi.fn(),
  removeRemote: vi.fn(),
  removeSource: vi.fn(),
  forgetSource: vi.fn(),
  remoteSources: vi.fn(),
  mountRemoteSource: vi.fn(),
  mountSourceByLink: vi.fn(),
  stopSharing: vi.fn(),
  notifyShellSourcesChanged: vi.fn(),
  shareStatus: vi.fn(),
  shareThisMachine: vi.fn(),
  createShareLink: vi.fn(),
  listShareLinks: vi.fn(),
  revokeShareLink: vi.fn(),
  relayPending: vi.fn(),
  retryRelayCleanup: vi.fn(),
}));
const boot = vi.hoisted(() => ({
  applySourceTable: vi.fn(async () => undefined),
  reloadIntoSettings: vi.fn(),
}));
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("../../../api/remote-services", async (original) => ({
  ...(await original<typeof import("../../../api/remote-services")>()),
  ...api,
}));
vi.mock("../../../sources/bootstrap", () => boot);
vi.mock("../../../app/workspaces-query", () => ({
  useWorkspacesQuery: () => ({ data: [{ id: "w1", name: "Project" }] }),
}));
vi.mock("sonner", () => ({ toast: toasts }));

import { RemoteServicesPage } from "./RemoteServicesPage";
import { offerJoinLink } from "../../../sources/join-intent";

const FP = "ab".repeat(32);
const ISSUER = "https://relay.test:8102";
const local = {
  sourceId: "h".repeat(32),
  kind: "local",
  label: "this-mac",
  baseUrl: "",
  relayOrigin: "",
  fingerprint: "",
  cloudIssuer: "",
  principalHint: "owner",
  addedAtMs: 1,
  lastOkAtMs: 1,
  orderIndex: 0,
  hasCredentials: true,
};
const relay = {
  serviceId: "svc",
  kind: "personal",
  issuer: ISSUER,
  label: "relay.test:8102",
  accountHint: "dev",
  fingerprint: FP,
  addedAtMs: 1,
  lastOkAtMs: 1,
  registered: false,
  hasCredentials: true,
};

beforeEach(() => {
  installDomPolyfills();
  usePreferencesStore.setState({ locale: "en" });
  api.notifyShellSourcesChanged.mockResolvedValue(false);
  api.relayPending.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  for (const spy of [...Object.values(api), ...Object.values(toasts)])
    spy.mockReset();
  boot.reloadIntoSettings.mockReset();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RemoteServicesPage />
    </QueryClientProvider>,
  );
}

describe("远程服务页", () => {
  it("零配置：只有本机一行与两个添加入口，没有 SaaS 入口", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    await screen.findByText("this-mac");
    expect(
      screen.getByRole("button", { name: "Add remote service" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add self-hosted" }),
    ).toBeTruthy();
    expect(screen.queryByText(/saas|cloud/i)).toBeNull();
    // 没登录任何远程服务时没有「从远程服务添加」。
    expect(
      screen.queryByRole("button", { name: "Add from remote service" }),
    ).toBeNull();
    await waitFor(() =>
      expect(boot.applySourceTable).toHaveBeenCalledWith([local]),
    );
  });

  it("添加个人中转：首次答出指纹 → 核对 → 带指纹重调；壳要重载就回到这一页", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.addPersonalRelay
      .mockResolvedValueOnce({ kind: "confirm", fingerprint: FP })
      .mockResolvedValueOnce({ kind: "done", value: {} });
    api.notifyShellSourcesChanged.mockResolvedValue(true);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add remote service" }),
    );
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: ISSUER },
    });
    fireEvent.change(screen.getByLabelText("Account"), {
      target: { value: "dev" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Verify certificate fingerprint");
    expect(api.addPersonalRelay).toHaveBeenLastCalledWith({
      issuer: ISSUER,
      account: "dev",
      password: "pw",
    });
    // 指纹按两位一组显示，供与中转打印的那一行对照。
    expect(screen.getByText(/^AB:AB:AB/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Fingerprint matches, continue" }),
    );
    await waitFor(() =>
      expect(api.addPersonalRelay).toHaveBeenLastCalledWith({
        issuer: ISSUER,
        account: "dev",
        password: "pw",
        fingerprint: FP,
      }),
    );
    await waitFor(() =>
      expect(boot.reloadIntoSettings).toHaveBeenCalledWith("remote"),
    );
  });

  it("错误按 code 的文案显示在表单里，不关对话框", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.addPersonalRelay.mockRejectedValue(
      new Error("Wrong account or password"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add remote service" }),
    );
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: ISSUER },
    });
    fireEvent.change(screen.getByLabelText("Account"), {
      target: { value: "dev" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong account or password")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("已登出的一行：「登录」只问口令，地址与指纹沿用", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...relay, hasCredentials: false }],
    });
    api.addPersonalRelay.mockResolvedValue({ kind: "done", value: {} });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      (within(dialog).getByLabelText("Address") as HTMLInputElement).readOnly,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Password"), {
      target: { value: "pw" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(api.addPersonalRelay).toHaveBeenCalledWith({
        issuer: ISSUER,
        account: "dev",
        password: "pw",
        fingerprint: FP,
      }),
    );
  });

  it("分享本机：开始分享 → 生成链接与二维码 → 停用", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.shareStatus
      .mockResolvedValueOnce({ sourceId: local.sourceId, registrations: [] })
      .mockResolvedValue({
        sourceId: local.sourceId,
        registrations: [
          {
            issuer: ISSUER,
            mode: "personal",
            tunnel: {
              state: "connecting",
              node: null,
              since: null,
              streams: 0,
              lastError: null,
            },
          },
        ],
      });
    api.shareThisMachine.mockResolvedValue({ sourceId: local.sourceId });
    api.listShareLinks.mockResolvedValue([]);
    const url = `${ISSUER}/j/L#S.inv.tok`;
    api.createShareLink.mockResolvedValue({
      linkId: "L",
      invitationId: "inv",
      url,
      expiresAtMs: Date.parse("2026-10-13T00:00:00Z"),
    });
    api.revokeShareLink.mockResolvedValue(undefined);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Share this machine" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Start sharing" }),
    );
    await waitFor(() =>
      expect(api.shareThisMachine).toHaveBeenCalledWith({
        serviceId: "svc",
        issuer: ISSUER,
        label: "this-mac",
      }),
    );
    expect(await screen.findByText("Connecting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenCalledWith({
        serviceId: "svc",
        sourceId: local.sourceId,
        workspaceId: "w1",
        role: "viewer",
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        label: "Project",
      }),
    );
    const qr = await screen.findByRole("img", { name: "Share link QR code" });
    expect(qr.getAttribute("data-qr-text")).toBe(url);
    expect(
      (screen.getByRole("textbox", { name: "Share link" }) as HTMLInputElement)
        .value,
    ).toBe(url);
    fireEvent.click(screen.getByRole("button", { name: "Disable link" }));
    await waitFor(() =>
      expect(api.revokeShareLink).toHaveBeenCalledWith({
        serviceId: "svc",
        linkId: "L",
        invitationId: "inv",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Share link QR code" }),
      ).toBeNull(),
    );
  });
});

describe("通过链接加入（A4-3p）", () => {
  const SHARE = `${ISSUER}/j/0123456789abcdef#${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;
  const joined = { ...local, sourceId: "s".repeat(32), kind: "relayed" };

  beforeEach(() => sessionStorage.clear());

  it("粘贴链接：首次核对签发方指纹 → 带指纹重调 → 记下要打开的源、收尾", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.mountSourceByLink
      .mockResolvedValueOnce({ kind: "confirm", fingerprint: FP })
      .mockResolvedValueOnce({ kind: "done", value: joined });
    api.notifyShellSourcesChanged.mockResolvedValue(true);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Join with link" }),
    );
    fireEvent.change(screen.getByLabelText("Share link"), {
      target: { value: SHARE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await screen.findByText("Verify certificate fingerprint");
    expect(screen.getByText("relay.test:8102")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Fingerprint matches, continue" }),
    );
    await waitFor(() =>
      expect(api.mountSourceByLink).toHaveBeenLastCalledWith({
        url: SHARE,
        fingerprint: FP,
      }),
    );
    await waitFor(() =>
      expect(boot.reloadIntoSettings).toHaveBeenCalledWith("remote"),
    );
    expect(sessionStorage.getItem("armadra.sources.openAfterJoin")).toBe(
      joined.sourceId,
    );
    expect(toasts.success).toHaveBeenCalledWith("Joined");
  });

  it("失败按码说明：过期的链接", async () => {
    const { RuntimeRequestError } = await import("../../../api/request");
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.mountSourceByLink.mockRejectedValue(
      new RuntimeRequestError(410, "已过期", "link_expired"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Join with link" }),
    );
    fireEvent.change(screen.getByLabelText("Share link"), {
      target: { value: SHARE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(await screen.findByText("This link has expired")).toBeTruthy();
    expect(sessionStorage.getItem("armadra.sources.openAfterJoin")).toBeNull();
  });

  it("深链交来的链接：打开对话框并预填，人点了才挂载", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    await screen.findByText("this-mac");
    offerJoinLink(SHARE);
    const field = (await screen.findByLabelText(
      "Share link",
    )) as HTMLInputElement;
    expect(field.value).toBe(SHARE);
    expect(api.mountSourceByLink).not.toHaveBeenCalled();
  });

  it("访客的远程服务行（没有账号）不给「分享本机」", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...relay, accountHint: "" }],
    });
    mount();
    await screen.findByText(relay.label);
    expect(
      screen.queryByRole("button", { name: "Share this machine" }),
    ).toBeNull();
  });
});

describe("中继侧待清理（契约 §31.4）", () => {
  function openMenu(name: string) {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: `Actions for ${name}` }),
      { button: 0, ctrlKey: false },
    );
  }

  it("停用分享时中继侧没删掉：提示待清理与按码的原因", async () => {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...relay, registered: true }],
    });
    api.stopSharing.mockResolvedValue("source_unreachable");
    mount();
    await screen.findByText("Sharing");
    openMenu(relay.label);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Stop sharing" }),
    );
    await waitFor(() =>
      expect(toasts.warning).toHaveBeenCalledWith("Sharing stopped", {
        description: "Relay cleanup pending · Cannot reach this remote service",
      }),
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("远程服务行上标出待清理，菜单里重试；清掉了提示", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    api.relayPending.mockResolvedValue([
      { issuer: ISSUER, revokedAtMs: 1, code: "source_unauthorized" },
    ]);
    api.retryRelayCleanup.mockResolvedValue(null);
    mount();
    expect(await screen.findByText("Relay cleanup pending")).toBeTruthy();
    openMenu(relay.label);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Retry cleanup" }),
    );
    await waitFor(() =>
      expect(api.retryRelayCleanup).toHaveBeenCalledWith(ISSUER),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Relay cleaned up"),
    );
  });

  it("远程服务已删、中继侧还欠着：单独一行，重试失败按码说明", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.relayPending.mockResolvedValue([
      { issuer: ISSUER, revokedAtMs: 1, code: "source_unauthorized" },
    ]);
    api.retryRelayCleanup.mockResolvedValue("source_unauthorized");
    mount();
    expect(await screen.findByText("relay.test:8102")).toBeTruthy();
    expect(
      screen.getByText("Sign in to this remote service, then retry"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        "Sign in to this remote service, then retry",
      ),
    );
  });
});
