import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "../../../app/preferences-store";

const api = vi.hoisted(() => ({
  dataInfo: vi.fn(),
  refreshConversations: vi.fn(),
}));
vi.mock("../../../api/client", () => ({ runtimeApi: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: {} },
    save: { mutate: vi.fn(), isPending: false },
  }),
}));

import { SessionsPage } from "./SessionsPage";

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN", autoTitle: true });
  api.dataInfo.mockResolvedValue({
    dataDir: "/tmp",
    dbBytes: 1,
    conversations: 7,
    boardLogRetentionDays: 30,
  });
  api.refreshConversations.mockResolvedValue({ total: 7 });
});
afterEach(cleanup);

describe("设置 → 会话", () => {
  it("自动命名（本设备）、索引范围、已索引条数与重建", async () => {
    draw();
    const name = screen.getByRole("switch", { name: "为占位标题自动生成名称" });
    expect(document.querySelector("[data-settings-scope=device]")).toBeTruthy();
    fireEvent.click(name);
    expect(usePreferencesStore.getState().autoTitle).toBe(false);
    expect(screen.getByText("会话索引")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "索引范围" })).toBeTruthy();
    expect(await screen.findByText("7 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重建" }));
    await waitFor(() => expect(api.refreshConversations).toHaveBeenCalled());
  });
});
