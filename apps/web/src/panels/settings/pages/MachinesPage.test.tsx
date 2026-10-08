import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";

const api = vi.hoisted(() => ({
  executionHosts: vi.fn(),
  validateExecutionHost: vi.fn(),
  exportExecutionHosts: vi.fn(),
  importExecutionHosts: vi.fn(),
  resyncExecutionHost: vi.fn(),
  scanSshHostKeys: vi.fn(),
}));
const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  });
  return toast;
});
const runtime = vi.hoisted(() => ({
  hosts: [] as unknown[],
  mutate: vi.fn(),
}));
const compact = vi.hoisted(() => ({ value: false }));
vi.mock("@/api/client", () => ({ runtimeApi: api }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/platform/layout", async (original) => ({
  ...(await original<typeof import("@/platform/layout")>()),
  useCompactLayout: () => compact.value,
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: { ssh: { hosts: runtime.hosts } } },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));

import { MachinesPage } from "./MachinesPage";

const boxSsh = { id: "build-box", name: "Build box", host: "build.example" };
const box = {
  executionHostId: "build-box",
  name: "Build box",
  kind: "ssh" as const,
  ssh: { ...boxSsh, user: "ci", port: 2222 },
  workerConfigured: true,
  workspaceCount: 2,
};
const worker = {
  version: "0.1.0",
  capabilities: [],
  outdated: false,
  connected: true,
  checkedAt: "2026-10-03T00:00:00Z",
};

beforeEach(() => {
  usePreferencesStore.setState({ locale: "en", settingsSubpage: null });
  runtime.hosts = [{ ...boxSsh, worker: { path: "/opt/armadra" } }];
  compact.value = false;
});
afterEach(() => {
  cleanup();
  for (const spy of Object.values(api)) spy.mockReset();
  for (const spy of [toasts, toasts.success, toasts.error, toasts.warning])
    spy.mockReset();
  runtime.mutate.mockReset();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MachinesPage />
    </QueryClientProvider>,
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("设置 → 远程机器", () => {
  it("一张表：名称 · 地址 · Worker · 工作区数 · 验证；本机不列", async () => {
    api.executionHosts.mockResolvedValue([
      {
        executionHostId: "",
        name: "",
        kind: "local",
        workerConfigured: true,
        workspaceCount: 1,
      },
      { ...box, worker },
    ]);
    mount();
    const table = await screen.findByRole("table");
    const row = (await within(table).findByText("Build box")).closest("tr")!;
    expect(within(row).getByText("ci@build.example:2222")).toBeTruthy();
    expect(within(row).getByText("0.1.0")).toBeTruthy();
    expect(within(row).getByText("2")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Validate" })).toBeTruthy();
    expect(within(table).queryByText("This machine")).toBeNull();
  });

  it("验证一步问完：只跑终端的机器连得上就是答案，Worker 握手成功说版本", async () => {
    api.executionHosts.mockResolvedValue([box]);
    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: false,
      capabilities: [],
      reason: "noWorkerConfigured",
      detail: "",
    });
    mount();
    await click(await screen.findByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Reachable, no Worker"),
    );

    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: false,
      workerOk: false,
      capabilities: [],
      reason: "unreachable",
      detail: "ssh: connect timed out",
    });
    await click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Unreachable", {
        description: "ssh: connect timed out",
      }),
    );

    api.validateExecutionHost.mockResolvedValue({
      executionHostId: "build-box",
      reachable: true,
      workerOk: true,
      platform: "linux",
      architecture: "aarch64",
      runtimeVersion: "0.1.0",
      capabilities: [],
      detail: "",
    });
    await click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith(
        "Worker 0.1.0 · linux/aarch64",
      ),
    );
  });

  it("Worker 过期用 destructive 徽标，没配置用 outline 徽标", async () => {
    runtime.hosts = [
      { ...boxSsh, worker: { path: "/opt/armadra" } },
      { id: "bare", name: "Bare", host: "bare.example" },
    ];
    api.executionHosts.mockResolvedValue([
      { ...box, worker: { ...worker, version: "0.0.9", outdated: true } },
      {
        ...box,
        executionHostId: "bare",
        name: "Bare",
        workerConfigured: false,
      },
    ]);
    mount();
    const outdated = await screen.findByText("Worker outdated");
    expect(outdated.getAttribute("data-variant")).toBe("destructive");
    expect(
      screen.getByText("No Worker configured").getAttribute("data-variant"),
    ).toBe("outline");
  });

  it("全部重新同步逐台来，说清哪几台没成；只有一台时不给", async () => {
    runtime.hosts = [
      { ...boxSsh, worker: { path: "/opt/armadra" } },
      { id: "far", name: "Far", host: "far.example", worker: { path: "/w" } },
    ];
    api.executionHosts.mockResolvedValue([
      { ...box, worker },
      { ...box, executionHostId: "far", name: "Far", worker },
    ]);
    api.resyncExecutionHost.mockImplementation(async (id: string) => {
      if (id === "far") throw new Error("unavailable");
      return { ...box, worker };
    });
    mount();
    await click(await screen.findByRole("button", { name: "Resync all" }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("1 hosts did not resync", {
        description: "Far",
      }),
    );
    expect(api.resyncExecutionHost.mock.calls.map((call) => call[0])).toEqual([
      "build-box",
      "far",
    ]);

    cleanup();
    runtime.hosts = [{ ...boxSsh, worker: { path: "/opt/armadra" } }];
    api.executionHosts.mockResolvedValue([{ ...box, worker }]);
    mount();
    await screen.findByText("Build box");
    expect(screen.queryByRole("button", { name: "Resync all" })).toBeNull();
  });

  it("点名称进子页：连接参数、重新同步、在那台机器上打开项目、健康记录", async () => {
    api.executionHosts.mockResolvedValue([
      {
        ...box,
        worker,
        health: [
          {
            at: "2026-10-03T00:00:00Z",
            event: "handshake",
            ok: true,
            version: "0.1.0",
          },
          {
            at: "2026-10-03T00:02:00Z",
            event: "failed",
            ok: false,
            code: "unreachable",
          },
        ],
      },
    ]);
    api.resyncExecutionHost.mockResolvedValue({ ...box, worker });
    mount();
    await click(await screen.findByRole("button", { name: "Build box" }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe(
      "ssh:build-box",
    );
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "build.example",
    );
    expect(screen.getByLabelText("Remote project path")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Host key" })).toBeTruthy();
    expect(await screen.findByText("Health history")).toBeTruthy();
    expect(screen.getByText("Handshake")).toBeTruthy();
    expect(screen.getByText("Unreachable")).toBeTruthy();
    await click(screen.getByRole("button", { name: "Resync" }));
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Resynced Build box"),
    );
  });

  it("没有机器：一句话加「添加」；导入 / 导出收在对话框里", async () => {
    runtime.hosts = [];
    api.executionHosts.mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No hosts yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Import / export" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("窄屏：一台一张条目，不画表格", async () => {
    compact.value = true;
    api.executionHosts.mockResolvedValue([{ ...box, worker }]);
    mount();
    expect(await screen.findByText("Build box")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      await screen.findByText(/ci@build\.example:2222 · 0\.1\.0/),
    ).toBeTruthy();
  });
});
