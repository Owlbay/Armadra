import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { usePreferencesStore } from "../../../app/preferences-store";

const access = vi.hoisted(() => ({ remote: false }));
vi.mock("../remote-access", () => ({ useRemoteAccess: () => access }));
vi.mock("../../../api/client", () => ({
  runtimeApi: {
    dataInfo: async () => ({
      dataDir: "/Users/dev/Library/Application Support/Armadra",
      dbBytes: 1024,
      conversations: 3,
      boardLogRetentionDays: 30,
    }),
    refreshConversations: vi.fn(),
    backupData: vi.fn(),
  },
}));
vi.mock("../use-runtime-settings", () => ({
  useRuntimeSettings: () => ({
    settings: { data: {} },
    save: { mutate: vi.fn() },
  }),
}));
vi.mock("../../../platform", () => ({ revealPath: vi.fn() }));

import { DataPage } from "./DataPage";

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DataPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(() => {
  access.remote = false;
  cleanup();
});

describe("设置 → 数据", () => {
  it("本机：数据目录旁有「在访达中打开」", async () => {
    draw();
    expect(await screen.findByText(/Application Support/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "在访达中打开" })).toBeTruthy();
  });

  it("远端主机：路径照常显示，不给打开（那是别的机器上的路径）", async () => {
    access.remote = true;
    draw();
    expect(await screen.findByText(/Application Support/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "在访达中打开" })).toBeNull();
    // 备份、重建索引作用在那台 core 上，照常可用。
    expect(screen.getByRole("button", { name: "重建" })).toBeTruthy();
  });
});
