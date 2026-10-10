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
  shareLinkUrl: vi.fn(),
  relayPending: vi.fn(),
  retryRelayCleanup: vi.fn(),
  dismissRelayCleanup: vi.fn(),
  renameShareLink: vi.fn(),
  renameSource: vi.fn(),
  renameRemote: vi.fn(),
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
vi.mock("../../../agent/sessions", async (original) => ({
  ...(await original<typeof import("../../../agent/sessions")>()),
  sessionsQuery: (workspaceId: string | null) => ({
    queryKey: ["test-sessions", workspaceId],
    queryFn: async () =>
      workspaceId === "w1" ? [{ sessionId: "s-build", title: "build" }] : [],
  }),
}));
/** 设置作用的 core 在不在眼前（缺省本机）。 */
const access = vi.hoisted(() => ({
  remote: false,
  via: null as "direct" | "relayed" | null,
  relayIssuer: null as string | null,
  currentSourceId: "local",
}));
vi.mock("../remote-access", async (original) => ({
  ...(await original<typeof import("../remote-access")>()),
  useRemoteAccess: () => access,
}));

import { RemoteAccessPage } from "./RemoteAccessPage";
import { offerJoinLink } from "../../../sources/join-intent";
import { useShowingStore } from "../RemoteShare";
import { dispatchWorkspaceEvent } from "../../../api/events";
import { localSource } from "../../../api/source";

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
  Object.assign(access, {
    remote: false,
    via: null,
    relayIssuer: null,
    currentSourceId: "local",
  });
  cleanup();
  for (const spy of [...Object.values(api), ...Object.values(toasts)])
    spy.mockReset();
  boot.reloadIntoSettings.mockReset();
  useShowingStore.setState({ byService: {} });
  delete (window as { armadra?: unknown }).armadra;
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RemoteAccessPage />
    </QueryClientProvider>,
  );
}

describe("远程访问页", () => {
  it("零配置：只有本机一行与两个添加入口，没有 SaaS 入口", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    await screen.findByText("this-mac");
    // 三段：谁能连进来（经中转一行的动作是添加中转账号）· 我连接的其他 Armadra；
    // 没有中转账号时不单列一张空的账号卡。
    expect(
      screen.getByText("Let other devices reach this machine"),
    ).toBeTruthy();
    expect(screen.getByText("Via relay")).toBeTruthy();
    expect(screen.getByText("Other Armadra hosts")).toBeTruthy();
    expect(screen.queryByText("Relay accounts")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add relay account" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add self-hosted" }),
    ).toBeTruthy();
    expect(screen.queryByText(/saas|cloud/i)).toBeNull();
    // 没登录任何远程服务时没有「从远程服务添加」。
    expect(screen.queryByRole("button", { name: "Add from relay" })).toBeNull();
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
      await screen.findByRole("button", { name: "Add relay account" }),
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
      expect(boot.reloadIntoSettings).toHaveBeenCalledWith("remoteAccess"),
    );
  });

  it("远程服务要求人机验证：升起挑战面板，令牌到了带着重提交（契约 §62）", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.addPersonalRelay
      .mockResolvedValueOnce({ kind: "challenge", siteKey: "0xSITE" })
      .mockResolvedValueOnce({ kind: "done", value: {} });
    api.notifyShellSourcesChanged.mockResolvedValue(true);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add relay account" }),
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
    // 页面不在中继来源上：内嵌中继的挑战页，令牌经 postMessage 回来。
    const frame = await waitFor(() => {
      const found = document.querySelector("iframe");
      if (found === null) throw new Error("no frame");
      return found;
    });
    const url = new URL(frame.getAttribute("src")!);
    expect(url.origin).toBe(new URL(ISSUER).origin);
    expect(url.searchParams.get("siteKey")).toBe("0xSITE");
    expect(api.addPersonalRelay).toHaveBeenCalledTimes(1);
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "armadra-challenge", token: "tk-1" },
        origin: new URL(ISSUER).origin,
      }),
    );
    await waitFor(() =>
      expect(api.addPersonalRelay).toHaveBeenLastCalledWith({
        issuer: ISSUER,
        account: "dev",
        password: "pw",
        challengeToken: "tk-1",
      }),
    );
  });

  it("错误按 code 的文案显示在表单里，不关对话框", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.addPersonalRelay.mockRejectedValue(
      new Error("Wrong account or password"),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add relay account" }),
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

  it("分享区直接展开：开关分享本机 → 新建可多次使用的链接 → 二维码 → 列表里再复制、撤销要确认", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [relay] });
    const registered = {
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
    };
    api.shareStatus
      .mockResolvedValueOnce({ sourceId: local.sourceId, registrations: [] })
      .mockResolvedValue(registered);
    api.shareThisMachine.mockResolvedValue({ sourceId: local.sourceId });
    const url = `${ISSUER}/j/L#S.inv.tok`;
    const link = {
      linkId: "L",
      label: "Project",
      role: "viewer",
      workspaceId: "w1",
      createdAtMs: Date.parse("2026-10-06T00:00:00Z"),
      expiresAtMs: Date.parse("2026-10-13T00:00:00Z"),
      uses: 2,
      maxUses: 1000,
      revokedAtMs: null,
      state: "active",
      copyable: true,
    };
    api.listShareLinks.mockResolvedValue([]);
    api.createShareLink.mockResolvedValue({ link: { ...link, uses: 0 }, url });
    api.shareLinkUrl.mockResolvedValue(url);
    api.revokeShareLink.mockResolvedValue(undefined);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mount();
    const toggle = await screen.findByRole("switch", {
      name: "Via relay",
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.shareThisMachine).toHaveBeenCalledWith({
        serviceId: "svc",
        issuer: ISSUER,
        label: "this-mac",
      }),
    );
    expect(await screen.findByText("Connecting")).toBeTruthy();
    expect(await screen.findByText("No active links")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    const form = await screen.findByRole("dialog");
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenCalledWith({
        serviceId: "svc",
        target: "workspace",
        workspaceId: "w1",
        readOnly: false,
        role: "viewer",
        ttlMs: 7 * 24 * 60 * 60 * 1000,
        maxUses: 1000,
        label: "Project",
      }),
    );
    const qr = await screen.findByRole("img", { name: "Share link QR code" });
    expect(qr.getAttribute("data-qr-text")).toBe(url);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Share link QR code" }),
      ).toBeNull(),
    );

    // 列表：生效的一条可再复制、再看二维码；失效的折进历史。
    api.listShareLinks.mockResolvedValue([
      link,
      {
        ...link,
        linkId: "OLD",
        label: "old",
        state: "revoked",
        copyable: false,
        revokedAtMs: link.createdAtMs,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText("Used 2/1000", { exact: false }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "History · 1" })).toBeTruthy();
    expect(screen.queryByText("old")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
    expect(api.shareLinkUrl).toHaveBeenCalledWith("svc", "L");
    fireEvent.click(screen.getByRole("button", { name: "QR code" }));
    expect(
      (
        await screen.findByRole("img", { name: "Share link QR code" })
      ).getAttribute("data-qr-text"),
    ).toBe(url);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Share link QR code" }),
      ).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Revoke “Project”?")).toBeTruthy();
    expect(api.revokeShareLink).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(api.revokeShareLink).toHaveBeenCalledWith("svc", "L"),
    );
  });
});

describe("添加时的地址提示", () => {
  async function openPersonal(address: string) {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add relay account" }),
    );
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: address },
    });
    fireEvent.change(screen.getByLabelText("Account"), {
      target: { value: "dev" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  }

  it("没写协议：按 https:// 提交", async () => {
    api.addPersonalRelay.mockResolvedValue({ kind: "done" });
    await openPersonal("192.168.0.107:8443");
    await waitFor(() =>
      expect(api.addPersonalRelay).toHaveBeenCalledWith(
        expect.objectContaining({ issuer: "https://192.168.0.107:8443" }),
      ),
    );
  });

  it("http:// 且不是回环：提交前提示，不调 core", async () => {
    await openPersonal("http://192.168.0.107:8443");
    expect(
      await screen.findByText(
        "Use https:// — http:// only works on this machine",
      ),
    ).toBeTruthy();
    expect(api.addPersonalRelay).not.toHaveBeenCalled();
  });

  it("http:// 回环地址放行", async () => {
    api.addPersonalRelay.mockResolvedValue({ kind: "done" });
    await openPersonal("http://127.0.0.1:8443");
    await waitFor(() =>
      expect(api.addPersonalRelay).toHaveBeenCalledWith(
        expect.objectContaining({ issuer: "http://127.0.0.1:8443" }),
      ),
    );
  });

  it("自托管：没写协议同样补 https://，http:// 非回环被拦", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.addDirectSource.mockResolvedValue({ kind: "done" });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add self-hosted" }),
    );
    const address = screen.getByLabelText("Address or pairing link");
    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: "123456" },
    });
    fireEvent.change(address, { target: { value: "http://10.0.0.5:8443" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(
      await screen.findByText(
        "Use https:// — http:// only works on this machine",
      ),
    ).toBeTruthy();
    expect(api.addDirectSource).not.toHaveBeenCalled();
    fireEvent.change(address, { target: { value: "10.0.0.5:8443" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(api.addDirectSource).toHaveBeenCalledWith(
        expect.objectContaining({ origin: "https://10.0.0.5:8443" }),
      ),
    );
  });

  it.each([
    ["address_invalid", "That address isn't valid"],
    ["address_https_only", "The address must start with https://"],
    [
      "address_plaintext_loopback_only",
      "Use https:// — http:// only works on this machine",
    ],
    ["address_has_credentials", "The address can't contain a login"],
    [
      "fingerprint_invalid",
      "The certificate fingerprint must be 64 hex characters",
    ],
    [
      "source_unreachable",
      "Cannot connect — check the address, that the service is running, and the firewall",
    ],
    [
      "fingerprint_mismatch",
      "The certificate fingerprint does not match — connection refused",
    ],
    ["credentials_invalid", "Wrong account or password"],
  ])("core 答 %s：按码显示文案", async (code, text) => {
    const { RuntimeRequestError } = await import("../../../api/request");
    api.addPersonalRelay.mockRejectedValue(
      new RuntimeRequestError(400, "中文原话", code),
    );
    await openPersonal("https://relay.example.com");
    expect(await screen.findByText(text)).toBeTruthy();
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
      expect(boot.reloadIntoSettings).toHaveBeenCalledWith("remoteAccess"),
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
    expect(screen.queryByRole("switch", { name: "Via relay" })).toBeNull();
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
    api.shareStatus.mockResolvedValue({
      sourceId: local.sourceId,
      registrations: [
        {
          issuer: ISSUER,
          mode: "personal",
          tunnel: {
            state: "ready",
            node: null,
            since: null,
            streams: 0,
            lastError: null,
          },
        },
      ],
    });
    api.listShareLinks.mockResolvedValue([]);
    mount();
    await screen.findByText("Sharing");
    const toggle = await screen.findByRole("switch", {
      name: "Via relay",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(toggle);
    const confirm = await screen.findByRole("alertdialog");
    expect(api.stopSharing).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Stop sharing" }),
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

  it("重命名（§61）：中转账号与本机一行都能改，占位是缺省名；清空即恢复", async () => {
    api.listSources.mockResolvedValue({
      sources: [{ ...local, defaultLabel: "this-mac" }],
      remotes: [{ ...relay, label: "Home", defaultLabel: "home-relay" }],
    });
    api.renameRemote.mockResolvedValue({});
    api.renameSource.mockResolvedValue({});
    mount();
    await screen.findByText("Home");
    openMenu("Home");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Name" });
    expect((input as HTMLInputElement).value).toBe("Home");
    expect(input.getAttribute("placeholder")).toBe("home-relay");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.renameRemote).toHaveBeenCalledWith("svc", ""),
    );
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Renamed"));

    openMenu("this-mac");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: " Studio " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.renameSource).toHaveBeenCalledWith(local.sourceId, "Studio"),
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

describe("分享收尾（P4）", () => {
  const tunnel = (state: string) => ({
    sourceId: local.sourceId,
    registrations: [
      {
        issuer: ISSUER,
        mode: "personal",
        tunnel: { state, node: null, since: null, streams: 0, lastError: null },
      },
    ],
  });
  const link = {
    linkId: "L",
    label: "",
    role: "viewer",
    workspaceId: "w1",
    createdAtMs: Date.parse("2026-10-06T00:00:00Z"),
    expiresAtMs: Date.parse("2026-10-13T00:00:00Z"),
    uses: 0,
    maxUses: 1000,
    revokedAtMs: null,
    state: "active",
    copyable: true,
  };
  const url = `${ISSUER}/j/L#S.inv.tok`;

  function sharing() {
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...relay, registered: true }],
    });
  }

  it("隧道状态跟着本机的 cloud.tunnel 事件重读，不轮询；别的源的事件不管", async () => {
    sharing();
    api.shareStatus.mockResolvedValue(tunnel("connecting"));
    api.listShareLinks.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("Connecting")).toBeTruthy();
    const reads = api.shareStatus.mock.calls.length;
    api.shareStatus.mockResolvedValue(tunnel("ready"));
    dispatchWorkspaceEvent(
      { type: "cloud.tunnel", issuer: ISSUER, state: "ready" },
      "someone-else",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.shareStatus.mock.calls.length).toBe(reads);
    dispatchWorkspaceEvent(
      { type: "cloud.tunnel", issuer: ISSUER, state: "ready" },
      localSource.sourceId,
    );
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(api.shareStatus.mock.calls.length).toBe(reads + 1);
  });

  it("分享范围：整台可选只读，会话只读且不给角色；列表标出范围", async () => {
    sharing();
    api.shareStatus.mockResolvedValue(tunnel("ready"));
    api.listShareLinks.mockResolvedValue([
      {
        ...link,
        label: "build",
        target: "session",
        sessionId: "s-build",
        readOnly: true,
      },
    ]);
    api.createShareLink.mockResolvedValue({ link, url });
    const choose = (form: HTMLElement, trigger: string, option: string) => {
      fireEvent.pointerDown(
        within(form).getByRole("combobox", { name: trigger }),
        { button: 0, ctrlKey: false, pointerType: "mouse" },
      );
      fireEvent.click(screen.getByRole("option", { name: option }));
    };
    mount();
    const row = await screen.findByText("build");
    expect(
      within(row.closest("[data-link-id]") as HTMLElement).getByText("Session"),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "New link" }));
    let form = await screen.findByRole("dialog");
    choose(form, "Scope", "Whole host");
    expect(within(form).queryByRole("combobox", { name: "Workspace" })).toBe(
      null,
    );
    fireEvent.click(within(form).getByRole("switch", { name: "Read-only" }));
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: "host",
          readOnly: true,
          role: "viewer",
          label: "Whole host",
        }),
      ),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Share link QR code" }),
      ).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    form = await screen.findByRole("dialog");
    choose(form, "Scope", "Session");
    expect(within(form).queryByRole("combobox", { name: "Role" })).toBe(null);
    expect(within(form).queryByRole("switch", { name: "Read-only" })).toBe(
      null,
    );
    await waitFor(() =>
      expect(
        within(form)
          .getByRole("combobox", { name: "Session" })
          .textContent?.includes("build"),
      ).toBe(true),
    );
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createShareLink).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: "session",
          workspaceId: "w1",
          sessionId: "s-build",
          readOnly: true,
          role: "viewer",
        }),
      ),
    );
  });

  it("刚建好的链接：设置框重新挂载（窄屏 / 宽屏切换）后二维码与整条链接还在", async () => {
    sharing();
    api.shareStatus.mockResolvedValue(tunnel("ready"));
    api.listShareLinks.mockResolvedValue([]);
    api.createShareLink.mockResolvedValue({ link, url });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "New link" }));
    const form = await screen.findByRole("dialog");
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));
    await screen.findByRole("img", { name: "Share link QR code" });
    cleanup();
    mount();
    const qr = await screen.findByRole("img", { name: "Share link QR code" });
    expect(qr.getAttribute("data-qr-text")).toBe(url);
    expect(api.shareLinkUrl).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(useShowingStore.getState().byService).toEqual({}),
    );
  });

  it("改备注：预填当前备注，保存后经 core 改、提示并重读列表", async () => {
    sharing();
    api.shareStatus.mockResolvedValue(tunnel("ready"));
    api.listShareLinks.mockResolvedValue([{ ...link, label: "Old" }]);
    api.renameShareLink.mockResolvedValue({ ...link, label: "Design review" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit note" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Note");
    expect((input as HTMLInputElement).value).toBe("Old");
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "Design review" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.renameShareLink).toHaveBeenCalledWith(
        "svc",
        "L",
        "Design review",
      ),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Note updated"),
    );
    await waitFor(() => expect(api.listShareLinks).toHaveBeenCalledTimes(2));
  });

  it("桌面壳有系统分享菜单：交给它；壳不接就退回复制", async () => {
    sharing();
    api.shareStatus.mockResolvedValue(tunnel("ready"));
    api.listShareLinks.mockResolvedValue([{ ...link, label: "Review" }]);
    api.shareLinkUrl.mockResolvedValue(url);
    const share = vi.fn(async () => ({ shared: true }));
    (window as { armadra?: unknown }).armadra = {
      share: { available: true, url: share },
    };
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Share…" }));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({ title: "Review", url }),
    );
    expect(writeText).not.toHaveBeenCalled();
    share.mockResolvedValue({ shared: false });
    fireEvent.click(screen.getByRole("button", { name: "Share…" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
  });

  it("远程服务已删、中继侧还欠着：菜单里放弃清理，确认后只清本机的登记", async () => {
    api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
    api.relayPending.mockResolvedValue([
      { issuer: ISSUER, revokedAtMs: 1, code: "source_unauthorized" },
    ]);
    api.dismissRelayCleanup.mockResolvedValue(undefined);
    mount();
    await screen.findByText("relay.test:8102");
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for relay.test:8102" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Dismiss cleanup" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Dismiss cleanup for “relay.test:8102”?"),
    ).toBeTruthy();
    expect(api.dismissRelayCleanup).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Dismiss cleanup" }),
    );
    await waitFor(() =>
      expect(api.dismissRelayCleanup).toHaveBeenCalledWith(ISSUER),
    );
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Cleanup dismissed"),
    );
  });
});

describe("经远端访问时不自断", () => {
  function openMenu(name: string) {
    fireEvent.pointerDown(
      screen.getByRole("button", { name: `Actions for ${name}` }),
      { button: 0, ctrlKey: false },
    );
  }

  it("页面正经这个中继到达主机：标出来，登出、移除与停用分享都不给", async () => {
    Object.assign(access, {
      remote: true,
      via: "relayed",
      relayIssuer: "https://relay.test:8102/",
    });
    api.listSources.mockResolvedValue({
      sources: [local],
      remotes: [{ ...relay, registered: true }],
    });
    api.shareStatus.mockResolvedValue({
      sourceId: local.sourceId,
      registrations: [
        {
          issuer: ISSUER,
          mode: "personal",
          tunnel: {
            state: "ready",
            node: null,
            since: null,
            streams: 1,
            lastError: null,
          },
        },
      ],
    });
    api.listShareLinks.mockResolvedValue([]);
    mount();
    expect(
      await screen.findByText(/This page connects through it/),
    ).toBeTruthy();
    const toggle = await screen.findByRole("switch", {
      name: "Via relay",
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(toggle.hasAttribute("disabled")).toBe(true);
    openMenu(relay.label);
    const signOut = await screen.findByRole("menuitem", { name: "Sign out" });
    const remove = screen.getByRole("menuitem", { name: "Remove" });
    expect(signOut.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(remove);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.logoutRemote).not.toHaveBeenCalled();
  });

  it("别的中继照常；当前源是挂载的远程源：那一行不给忘掉凭据与移除", async () => {
    const mounted = {
      ...local,
      sourceId: "r".repeat(32),
      kind: "direct",
      label: "studio",
      baseUrl: "https://studio.test:8443",
    };
    Object.assign(access, {
      remote: true,
      via: null,
      relayIssuer: null,
      currentSourceId: mounted.sourceId,
    });
    api.listSources.mockResolvedValue({
      sources: [local, mounted],
      remotes: [relay],
    });
    api.shareStatus.mockResolvedValue({
      sourceId: local.sourceId,
      registrations: [],
    });
    mount();
    expect(await screen.findByText(/In use/)).toBeTruthy();
    openMenu("studio");
    expect(
      (await screen.findByRole("menuitem", { name: "Remove" })).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    expect(
      screen
        .getByRole("menuitem", { name: "Disconnect" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    openMenu(relay.label);
    expect(
      (await screen.findByRole("menuitem", { name: "Sign out" })).getAttribute(
        "aria-disabled",
      ),
    ).toBeNull();
  });

  it("中继托管的页面：不拿主机的源表覆盖页面源表", async () => {
    const { resetHostedRelay } = await import("../../../sources/hosted");
    resetHostedRelay({ issuer: ISSUER } as never);
    boot.applySourceTable.mockClear();
    try {
      api.listSources.mockResolvedValue({ sources: [local], remotes: [] });
      mount();
      await screen.findByText("this-mac");
      await waitFor(() => expect(api.listSources).toHaveBeenCalled());
      expect(boot.applySourceTable).not.toHaveBeenCalled();
    } finally {
      resetHostedRelay(null);
    }
  });
});
