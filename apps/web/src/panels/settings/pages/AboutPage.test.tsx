import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type {
  ShellOffer,
  ShellUpdateState,
} from "../../../updates/shell-updater";

const store = vi.hoisted(() => ({
  panels: { settings: true },
  setPanel: vi.fn(),
}));

const health = vi.hoisted(() => ({ version: "0.1.0" as string | undefined }));

/** The two halves the page merges, driven directly. */
const updates = vi.hoisted(() => ({
  host: { kind: "notAsked" } as Record<string, unknown>,
  shell: { state: "idle" } as Record<string, unknown>,
  restart: null as Record<string, unknown> | null,
  start: vi.fn(() => () => undefined),
  check: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
  install: vi.fn(async () => {}),
  dismiss: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  acknowledgeRestart: vi.fn(),
}));

const settings = vi.hoisted(() => ({
  data: {
    updates: {
      channel: "stable",
      autoCheck: true,
      autoDownload: false,
      notify: true,
    },
  },
}));
const save = vi.hoisted(() => ({ mutate: vi.fn() }));

const opened = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock("../../../store/canvas-store", () => {
  const useCanvasStore = <T,>(selector: (state: typeof store) => T) =>
    selector(store);
  useCanvasStore.getState = () => store;
  return { useCanvasStore };
});

vi.mock("../../../api/client", () => ({
  runtimeApi: { health: async () => ({ version: health.version }) },
}));

vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({ settings, save }),
}));

vi.mock("../../../platform", () => ({
  openExternal: async (url: string) => {
    opened.urls.push(url);
  },
  isDesktop: () => true,
}));

vi.mock("../../../updates/use-update-state", () => {
  const useUpdateState = <T,>(selector: (state: typeof updates) => T) =>
    selector(updates);
  useUpdateState.getState = () => updates;
  return {
    useUpdateState,
    CHECK_INTERVAL_MS: 21_600_000,
    FIRST_CHECK_DELAY_MS: 30_000,
  };
});

const access = vi.hoisted(() => ({ remote: false, member: false }));
vi.mock("../remote-access", () => ({ useRemoteAccess: () => access }));
vi.mock("../../../app/use-access", () => ({
  useAccess: () => ({ member: access.member }),
}));

const native = vi.hoisted(() => ({
  available: false,
  info: null as { version: string; build: string } | null,
  protocol: { major: 1, minor: 26 },
}));
vi.mock("../../../mobile/native-bridge", () => ({
  nativeBridge: () => ({
    available: native.available,
    appInfo: async () => native.info,
  }),
}));
vi.mock("../../../api/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/identity")>()),
  identityHello: async () => ({
    protocol: native.protocol,
    sourceId: "h1",
    hostInstanceId: "",
    capabilities: [],
    maxFrameBytes: 0,
  }),
}));

import { AboutPage, loadThirdPartyNotices } from "./AboutPage";
import { usePreferencesStore } from "../../../app/preferences-store";
import { SETTINGS_SECTIONS } from "../nav";

const offer: ShellOffer = {
  version: "0.2.0",
  target: "darwin-aarch64",
  manifestUrl: "https://releases.invalid/download/v0.2.0/latest.json",
  packageUrl:
    "https://releases.invalid/download/v0.2.0/Armadra_0.2.0_darwin-aarch64.app.tar.gz",
  sha256: "a".repeat(64),
  sizeBytes: 4_194_304,
  signed: true,
  notesUrl: "https://releases.invalid/v0.2.0",
};

function draw(shell: ShellUpdateState, host?: Record<string, unknown>) {
  updates.shell = shell as unknown as Record<string, unknown>;
  if (host) updates.host = host;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AboutPage />
    </QueryClientProvider>,
  );
}

function answered(verdict: string, reasonCode = "") {
  return {
    kind: "answered",
    verdict,
    reasonCode,
    retryAfterMs: 0,
    checkedAtMs: 1,
    release: null,
  };
}

function status() {
  return screen.getByRole("status").textContent;
}

beforeEach(() => {
  store.setPanel.mockClear();
  save.mutate.mockClear();
  updates.check.mockClear();
  updates.refresh.mockClear();
  updates.download.mockClear();
  updates.install.mockClear();
  updates.dismiss.mockClear();
  updates.cancel.mockClear();
  updates.host = { kind: "notAsked" };
  updates.restart = null;
  settings.data = {
    updates: {
      channel: "stable",
      autoCheck: true,
      autoDownload: false,
      notify: true,
    },
  };
  opened.urls.length = 0;
  health.version = "0.1.0";
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(() => {
  access.remote = false;
  access.member = false;
  native.available = false;
  native.info = null;
  native.protocol = { major: 1, minor: 26 };
  cleanup();
});

describe("设置 → 关于：手机 / 平板 App", () => {
  it("App 自己的版本与构建号、主机版本与协议并列；没有桌面的更新动作", async () => {
    native.available = true;
    native.info = { version: "1.0.0", build: "3185" };
    health.version = "0.2.5";
    updates.start.mockClear();
    draw({ state: "idle" });
    expect(await screen.findByText("1.0.0（3185）")).toBeTruthy();
    expect(screen.getByText("App 版本")).toBeTruthy();
    expect(await screen.findByText("0.2.5")).toBeTruthy();
    expect(await screen.findByText("1.26")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(updates.start).not.toHaveBeenCalled();
  });

  it("主机协议低于 App 的要求：提示更新主机", async () => {
    native.available = true;
    native.info = { version: "1.0.0", build: "1" };
    native.protocol = { major: 1, minor: 13 };
    draw({ state: "idle" });
    expect(await screen.findByText("主机版本过旧")).toBeTruthy();
    expect(
      screen.getByText(
        "主机协议 1.13，App 需要 1.14 或更新。请更新电脑端或服务器端。",
      ),
    ).toBeTruthy();
  });

  it("主机的协议主版本更新：提示更新 App（英文）", async () => {
    usePreferencesStore.setState({ locale: "en" });
    native.available = true;
    native.protocol = { major: 2, minor: 0 };
    draw({ state: "idle" });
    expect(await screen.findByText("Update the app")).toBeTruthy();
    // 旧安装包的插件没有 appInfo：版本写「未知」，不猜。
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });
});

describe("设置 → 关于：版本与更新", () => {
  it("remote host: its version, read-only; no checks, no channel, no actions", async () => {
    access.remote = true;
    updates.start.mockClear();
    health.version = "0.3.1";
    draw({ state: "idle" });
    expect(await screen.findByText("0.3.1")).toBeTruthy();
    expect(screen.getByText("主机版本")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    // 只剩开源许可那一个按钮。
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(updates.start).not.toHaveBeenCalled();
  });

  it("member: the version only; the update preferences live in the host settings", async () => {
    access.member = true;
    updates.start.mockClear();
    draw({ state: "idle" });
    expect(await screen.findByText("0.1.0")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(updates.start).not.toHaveBeenCalled();
  });

  it("lives on the about page, shows the version once and stays idle until asked", async () => {
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === "about");
    expect(section?.groupKey).toBe("settings.group.about");
    expect(SETTINGS_SECTIONS.some((entry) => entry.id === "updates")).toBe(
      false,
    );
    draw({ state: "idle" });
    expect(await screen.findAllByText("0.1.0")).toHaveLength(1);
    await waitFor(() => expect(status()).toBe("尚未检查更新"));
    expect(updates.check).not.toHaveBeenCalled();
  });

  it("only reads the shell's state back on its timer; the shell runs the check", async () => {
    vi.useFakeTimers();
    try {
      draw({ state: "idle" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(updates.refresh).toHaveBeenCalledTimes(1);
      expect(updates.check).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** One rendering assertion per state of design §4.1. */
  it("renders each of the eleven states with its own sentence", async () => {
    const cases: [ShellUpdateState, Record<string, unknown>, string][] = [
      [
        { state: "notConfigured", missing: { pubkey: true, endpoints: true } },
        answered("upToDate"),
        "未配置",
      ],
      [{ state: "localBuild" }, answered("upToDate"), "本地构建"],
      [
        { state: "unsupported", reason: "notDesktop" },
        answered("available"),
        "此环境不能自动更新",
      ],
      [{ state: "idle" }, { kind: "notAsked" }, "尚未检查更新"],
      [{ state: "checking" }, { kind: "checking" }, "正在检查…"],
      [
        { state: "upToDate", checkedAtMs: 1 },
        answered("upToDate"),
        "已是最新版本",
      ],
      [
        {
          state: "unavailable",
          reason: "sourceUnreachable",
          retryAfterMs: 900_000,
          checkedAtMs: 1,
        },
        answered("unavailable", "SOURCE_UNREACHABLE"),
        "无法确认",
      ],
      [{ state: "available", offer }, answered("available"), "有新版本可用"],
      [
        {
          state: "downloading",
          offer,
          receivedBytes: 1_048_576,
          totalBytes: 4_194_304,
        },
        answered("available"),
        "正在下载",
      ],
      [
        { state: "downloaded", offer, phase: "ready", problem: null },
        answered("available"),
        "已下载，重启后生效",
      ],
      [
        { state: "failed", reason: "digestMismatch", offer },
        answered("available"),
        "更新失败",
      ],
    ];
    for (const [shell, host, expected] of cases) {
      draw(shell, host);
      await waitFor(() => expect(status()).toBe(expected));
      cleanup();
    }
  });

  // The whole point of the contract: a check nobody completed must never be
  // rendered as "up to date".
  it("never says 已是最新 when only one side answered", async () => {
    draw(
      { state: "upToDate", checkedAtMs: 1 },
      answered("unavailable", "SOURCE_UNREACHABLE"),
    );
    await waitFor(() => expect(status()).toBe("无法确认"));
    expect(screen.queryByText("已是最新版本")).toBeNull();
    expect(screen.getByText("后台服务未给出结果。")).toBeTruthy();
    expect(screen.getByText("无法读取发布来源，请稍后重试。")).toBeTruthy();
  });

  it("says which half of the updater configuration is missing", async () => {
    draw(
      { state: "notConfigured", missing: { pubkey: true, endpoints: false } },
      answered("upToDate"),
    );
    await waitFor(() => expect(status()).toBe("未配置"));
    expect(
      screen.getByText("此构建没有内置签名公钥，无法验证任何安装包。"),
    ).toBeTruthy();
    expect(screen.queryByText(/没有内置发布地址/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "前往本机服务设置" }));
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("service");
  });

  it("routes a blocked release side to the background service settings", async () => {
    draw({ state: "idle" }, { kind: "blocked", reason: "signedOut" });
    expect(await screen.findByText("此设备尚未登录后台服务。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
  });

  it("downloads, skips and restarts through the shell", async () => {
    draw({ state: "available", offer }, answered("available"));
    await waitFor(() => expect(status()).toBe("有新版本可用"));
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(updates.download).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "跳过此版本" }));
    expect(updates.dismiss).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看发布说明" }));
    await waitFor(() =>
      expect(opened.urls).toEqual(["https://releases.invalid/v0.2.0"]),
    );

    cleanup();
    draw(
      { state: "downloaded", offer, phase: "ready", problem: null },
      answered("available"),
    );
    await waitFor(() => expect(status()).toBe("已下载，重启后生效"));
    expect(screen.getByText(/终端会话会保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重启并更新" }));
    expect(updates.install).toHaveBeenCalled();
  });

  it("offers nothing to press while the restart is under way", async () => {
    draw(
      { state: "downloaded", offer, phase: "installing", problem: null },
      answered("available"),
    );
    await waitFor(() => expect(status()).toBe("已下载，重启后生效"));
    expect(screen.queryByRole("button", { name: "重启并更新" })).toBeNull();
  });

  it("cancels a transfer and keeps the offer to restart it from", async () => {
    draw(
      {
        state: "downloading",
        offer,
        receivedBytes: 1_048_576,
        totalBytes: 4_194_304,
      },
      answered("available"),
    );
    await waitFor(() => expect(status()).toBe("正在下载"));
    // Downloading again is not on offer: it would start a second transfer.
    expect(screen.queryByRole("button", { name: "下载" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(updates.cancel).toHaveBeenCalled();
  });

  it("cancels a check that is still in flight", async () => {
    draw({ state: "checking" }, { kind: "checking" });
    await waitFor(() => expect(status()).toBe("正在检查…"));
    // Every other button is disabled while checking; this one has to work,
    // or the state would be a dead end until the request times out.
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(cancel.hasAttribute("disabled")).toBe(false);
    fireEvent.click(cancel);
    expect(updates.cancel).toHaveBeenCalled();
  });

  it("draws the transfer as a progress bar beside the byte count", async () => {
    draw(
      {
        state: "downloading",
        offer,
        receivedBytes: 1_048_576,
        totalBytes: 4_194_304,
      },
      answered("available"),
    );
    expect(
      await screen.findByRole("progressbar", { name: "已下载" }),
    ).toBeTruthy();
  });

  it("puts a failed install in a destructive alert with retry", async () => {
    draw(
      { state: "failed", reason: "digestMismatch", offer },
      answered("available"),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("更新失败");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("shows the transfer as bytes rather than a fraction of nothing", async () => {
    draw(
      { state: "downloading", offer, receivedBytes: 1_048_576, totalBytes: 0 },
      answered("available"),
    );
    await waitFor(() => expect(screen.getByText("1.0 MB")).toBeTruthy());
  });

  it("persists the two switches; the download notification moved to notifications", async () => {
    draw({ state: "idle" });
    const auto = await screen.findByRole("switch", { name: "自动检查更新" });
    fireEvent.click(auto);
    expect(save.mutate).toHaveBeenCalledWith({ updates: { autoCheck: false } });
    fireEvent.click(screen.getByRole("switch", { name: "自动下载更新" }));
    expect(save.mutate).toHaveBeenCalledWith({
      updates: { autoDownload: true },
    });
    expect(screen.queryByRole("switch", { name: "更新下载完成" })).toBeNull();
  });

  it("reports a restart that did not deliver what it promised", async () => {
    updates.restart = {
      outcome: "incomplete",
      mismatched: ["host"],
      expectedVersion: "0.2.0",
      previousVersion: "0.1.0",
      previousPackageUrl:
        "https://releases.invalid/download/v0.1.0/Armadra.dmg",
    };
    draw({ state: "idle" });
    expect(
      await screen.findByText(/更新未完成：后台服务 没有报告新版本/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "0.1.0" }));
    await waitFor(() =>
      expect(opened.urls).toEqual([
        "https://releases.invalid/download/v0.1.0/Armadra.dmg",
      ]),
    );
  });
});

describe("设置 → 关于：开源许可", () => {
  it("第三方声明是生成文件的全文，带 Electron/Chromium 的随包声明", async () => {
    const text = await loadThirdPartyNotices();
    expect(text.startsWith("# Third-party notices\n")).toBe(true);
    expect(text).toContain("LICENSES.chromium.html");
    expect(text).toContain("### react@");
  });

  it("打开许可对话框才加载并显示声明正文", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <AboutPage />
      </QueryClientProvider>,
    );
    expect(client.getQueryState(["third-party-notices"])?.status).not.toBe(
      "success",
    );
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    await waitFor(() =>
      expect(screen.getByText(/# Third-party notices/)).toBeTruthy(),
    );
  });
});
