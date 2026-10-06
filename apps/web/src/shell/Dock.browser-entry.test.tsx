import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Workspace } from "@armadra/shared";

// `/api/health` 还有别的读者（core 身份），这里只看答案有没有落进可用性。
const health = vi.fn();
vi.mock("@/api/system", () => ({ systemApi: { health: () => health() } }));
vi.mock("../api/client", () => ({
  runtimeApi: { agents: async () => [] },
}));

import { installDomPolyfills, TestProviders } from "../app/test-harness";
import {
  resetBrowserAvailability,
  useHeadlessBrowser,
} from "../nodes/browser/availability";
import { useCanvasStore } from "../store/canvas-store";
import { Dock } from "./Dock";

installDomPolyfills();

/** 只读已知的答案，自己不发请求。 */
function Known() {
  return (
    <output data-testid="known">{String(useHeadlessBrowser(false))}</output>
  );
}

const now = new Date().toISOString();
const workspace: Workspace = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "alpha",
  rootPath: "/tmp/alpha",
  color: "#5B5BD6",
  permissions: { read: true, write: true, execute: true },
  executionHostId: "",
  lastOpenedAt: now,
  createdAt: now,
  updatedAt: now,
};

/**
 * 服务器壳上的「新建浏览器」（core 带 headless 浏览器时才有）：菜单向上展开、
 * 按展开那一刻的高度定位。这一项要是展开之后才冒出来，菜单长高一行，底边盖住
 * `+`，按住再松开就选中了底部那一项。所以 Dock 一挂上就问，展开时项已经齐了。
 */
describe("Dock 的新建菜单：浏览器入口", () => {
  beforeEach(() => {
    act(() => resetBrowserAvailability());
    health.mockReset().mockResolvedValue({
      status: "ok",
      version: "1",
      capabilities: { headlessBrowser: true },
    });
    useCanvasStore.setState({ workspace, saveState: "saved" });
  });
  afterEach(() => {
    cleanup();
    act(() => resetBrowserAvailability());
  });

  it("Dock 挂上就问 core 带不带浏览器，不等菜单展开", async () => {
    render(
      <TestProviders>
        <Dock />
        <Known />
      </TestProviders>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("known").textContent).toBe("true"),
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("答案回来之后第一次展开，菜单里一开始就有「新建浏览器」", async () => {
    render(
      <TestProviders>
        <Dock />
        <Known />
      </TestProviders>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("known").textContent).toBe("true"),
    );
    fireEvent.keyDown(screen.getByLabelText("新建"), { key: "Enter" });
    // 同步取：展开的那一次渲染里就要有，而不是等一次往返之后补上。
    expect(screen.getByText("新建浏览器")).toBeTruthy();
  });
});
