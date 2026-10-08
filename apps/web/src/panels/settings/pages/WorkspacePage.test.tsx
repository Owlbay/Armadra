import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "@/app/preferences-store";
import { useCanvasStore } from "@/store/canvas-store";

const api = vi.hoisted(() => ({
  executionHosts: vi.fn(),
  switchExecutionHost: vi.fn(),
}));
const refusal = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/api/client", () => ({
  runtimeApi: api,
  executionHostRefusal: refusal,
}));
vi.mock("../../../api/client", () => ({
  runtimeApi: api,
  executionHostRefusal: refusal,
}));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: {} },
    save: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("../../../app/use-agents", () => ({
  useAgentsQuery: () => ({ data: [] }),
}));
// 这几块各有自己的测试；这里只看它们挂在这一页上。
vi.mock("./WorkspaceExecution", () => ({
  WorkspaceExecution: () => <div data-testid="execution" />,
}));
vi.mock("./LanguageServicePanel", () => ({
  LanguageServicePanel: () => <div data-testid="language" />,
}));
vi.mock("../../../realtime/RealtimeSetting", () => ({
  RealtimeSetting: () => <div data-testid="realtime" />,
}));

import { WorkspacePage } from "./WorkspacePage";

const local = {
  executionHostId: "",
  name: "",
  kind: "local" as const,
  workerConfigured: true,
  workspaceCount: 1,
};
const box = {
  executionHostId: "build-box",
  name: "Build box",
  kind: "ssh" as const,
  ssh: { id: "build-box", name: "Build box", host: "build.example" },
  workerConfigured: true,
  workspaceCount: 0,
};

function mount(withWorkspace = true) {
  usePreferencesStore.setState({ locale: "en", settingsSubpage: null });
  useCanvasStore.setState({
    workspace: withWorkspace
      ? ({
          id: "w1",
          name: "Project",
          rootPath: "/srv/project",
          color: "#fff",
          permissions: { read: true, write: true, execute: true },
          executionHostId: "",
          lastOpenedAt: "",
          createdAt: "",
          updatedAt: "",
          boards: [],
        } as never)
      : null,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WorkspacePage />
    </QueryClientProvider>,
  );
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => api.executionHosts.mockResolvedValue([local, box]));
afterEach(() => {
  cleanup();
  for (const spy of Object.values(api)) spy.mockReset();
  for (const spy of Object.values(toasts)) spy.mockReset();
  refusal.mockReset();
});

describe("设置 → 工作空间", () => {
  it("执行权限、运行主机、默认 Agent、语言服务与实时协同都在这一页", async () => {
    mount();
    expect(screen.getByTestId("execution")).toBeTruthy();
    expect(screen.getByText("Runs on")).toBeTruthy();
    expect(await screen.findByText("This machine")).toBeTruthy();
    expect(screen.getByTestId("language")).toBeTruthy();
    expect(screen.getByTestId("realtime")).toBeTruthy();
  });

  it("没有工作空间时一句话，实时协同照常在", () => {
    mount(false);
    expect(screen.queryByText("Runs on")).toBeNull();
    expect(screen.getByTestId("realtime")).toBeTruthy();
  });

  it("切换列出阻塞项，只对进程给「停止并切换」", async () => {
    api.switchExecutionHost.mockRejectedValue(new Error("blocked"));
    refusal.mockReturnValue({
      code: "switch_blocked",
      message: "blocked",
      blockers: [
        { kind: "terminal", detail: "node-1" },
        { kind: "browser", detail: "node-2" },
      ],
      stopped: [],
    });
    mount();
    await click(await screen.findByRole("button", { name: "Switch" }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe(
      "executionHosts:switch",
    );
    await click(await screen.findByRole("button", { name: "Switch" }));
    expect(await screen.findByText("Terminal session")).toBeTruthy();
    expect(screen.getByText("Browser session")).toBeTruthy();
    const stop = screen.getByRole("button", { name: "Stop and switch" });
    api.switchExecutionHost.mockResolvedValue({
      id: "w1",
      executionHostId: "",
      rootPath: "/srv/project",
    });
    await click(stop);
    await waitFor(() =>
      expect(api.switchExecutionHost).toHaveBeenLastCalledWith("w1", {
        executionHostId: "",
        rootPath: "/srv/project",
        stopBlockers: true,
      }),
    );
  });

  it("编辑器草稿挡着时不给「停止并切换」", async () => {
    api.switchExecutionHost.mockRejectedValue(new Error("blocked"));
    refusal.mockReturnValue({
      code: "switch_blocked",
      message: "blocked",
      blockers: [{ kind: "editorDraft", detail: "README.md" }],
      stopped: [],
    });
    mount();
    await click(await screen.findByRole("button", { name: "Switch" }));
    await click(await screen.findByRole("button", { name: "Switch" }));
    expect(await screen.findByText("Editor draft")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Stop and switch" }),
    ).toBeNull();
  });

  it("切换仍失败时也说清已经停掉了什么", async () => {
    api.switchExecutionHost.mockRejectedValue(new Error("blocked"));
    refusal.mockReturnValue({
      code: "switch_blocked",
      message: "blocked",
      blockers: [{ kind: "gitOperation", detail: "op-1" }],
      stopped: [{ kind: "terminal", detail: "node-1" }],
    });
    mount();
    await click(await screen.findByRole("button", { name: "Switch" }));
    await click(await screen.findByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(toasts.warning).toHaveBeenCalledWith("Stopped 1"),
    );
  });
});
