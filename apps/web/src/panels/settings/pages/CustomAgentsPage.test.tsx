import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { usePreferencesStore } from "../../../app/preferences-store";

const runtime = vi.hoisted(() => ({
  custom: [] as unknown[],
  mutate: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ runtimeApi: {} }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: { agents: { custom: runtime.custom } } },
    save: { mutate: runtime.mutate, isPending: false },
  }),
}));
vi.mock("../../../app/use-agents", () => ({
  useAgentsQuery: () => ({ data: [] }),
}));

import { TestProviders, installDomPolyfills } from "../../../app/test-harness";
import { CustomAgentsPage } from "./CustomAgentsPage";

installDomPolyfills();

function draw() {
  render(
    <TestProviders>
      <CustomAgentsPage />
    </TestProviders>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN", settingsSubpage: null });
  runtime.custom = [];
  runtime.mutate.mockReset();
});
afterEach(cleanup);

describe("设置 → 自定义 Agent", () => {
  it("空态一句话加「添加」，点了推入新建子页", () => {
    draw();
    expect(screen.getByText("还没有自定义 Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe("agent:new");
  });

  it("一条一行，点一行进编辑子页，删除放在子页页尾", () => {
    runtime.custom = [
      {
        id: "custom:abc",
        label: "我的 Agent",
        launchCmd: "my-agent",
        args: [],
        baseAgent: "claude",
      },
    ];
    draw();
    expect(screen.getByText("my-agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /我的 Agent/ }));
    expect(usePreferencesStore.getState().settingsSubpage).toBe(
      "agent:custom:abc",
    );
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(
      "我的 Agent",
    );
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
  });
});
