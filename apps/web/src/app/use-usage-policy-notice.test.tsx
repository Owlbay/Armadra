import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Usage } from "@armadra/shared";

const info = vi.fn();
vi.mock("sonner", () => ({
  toast: { info: (...args: unknown[]) => info(...args) },
}));

const usage = vi.fn();
vi.mock("../api/client", () => ({ runtimeApi: { usage: () => usage() } }));

import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import {
  USAGE_POLICY_NOTICE_KEY,
  policyOffProviders,
  useUsagePolicyNotice,
} from "./use-usage-policy-notice";

function Probe() {
  useUsagePolicyNotice();
  return null;
}

function renderWith(data: Usage | undefined) {
  const client = new QueryClient();
  if (data !== undefined) client.setQueryData(["usage"], data);
  return render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
}

const policyOff: Usage = {
  providers: [
    {
      id: "claude",
      status: "unavailable",
      reason: "policy_off",
      windows: [],
      fetchedAt: null,
    },
    { id: "codex", status: "unavailable", windows: [], fetchedAt: null },
    {
      id: "copilot",
      status: "unavailable",
      reason: "policy_off",
      windows: [],
      fetchedAt: null,
    },
  ],
  refreshAvailableAt: null,
};

describe("额度读取改为默认关的一次性提示", () => {
  beforeEach(() => {
    info.mockReset();
    localStorage.removeItem(USAGE_POLICY_NOTICE_KEY);
    usePreferencesStore.setState({ locale: "zh-CN" });
  });
  afterEach(cleanup);

  it("只挑出 policy_off 的那几家", () => {
    expect(policyOffProviders(policyOff)).toEqual(["claude", "copilot"]);
    expect(policyOffProviders(undefined)).toEqual([]);
  });

  it("第一次看到时提示一次，按钮直达账号与用量", async () => {
    renderWith(policyOff);
    await waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    const [message, options] = info.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Claude、Copilot 的额度读取现已默认关闭");
    expect(options.action.label).toBe("打开设置");
    options.action.onClick();
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("account");
    expect(useCanvasStore.getState().panels.settings).toBe(true);

    cleanup();
    renderWith(policyOff);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("没有 policy_off 时不提示，也不自己发请求", async () => {
    renderWith({
      providers: [
        { id: "claude", status: "unavailable", windows: [], fetchedAt: null },
      ],
      refreshAvailableAt: null,
    });
    renderWith(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(info).not.toHaveBeenCalled();
    expect(usage).not.toHaveBeenCalled();
    expect(localStorage.getItem(USAGE_POLICY_NOTICE_KEY)).toBeNull();
  });
});
