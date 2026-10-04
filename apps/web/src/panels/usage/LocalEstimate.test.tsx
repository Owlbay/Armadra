import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Usage, UsageProvider } from "@armadra/shared";

const fetchUsage = vi.fn();
vi.mock("../../api/client", () => ({
  runtimeApi: {
    usage: () => fetchUsage(),
    refreshUsage: () => fetchUsage(),
    providerStatus: () => Promise.resolve({ enabled: false, providers: [] }),
  },
}));

import { installDomPolyfills, TestProviders } from "../../app/test-harness";
import { usePreferencesStore } from "../../app/preferences-store";
import { ClusterUsage } from "../../shell/ClusterUsage";
import { ProviderDetail } from "../../shell/ProviderDetail";
import { ProviderCard } from "./ProviderCard";

installDomPolyfills();
afterEach(cleanup);

const NOW = Date.now();

function claude(limit?: number): UsageProvider {
  return {
    id: "claude",
    status: "unavailable",
    reason: "policy_off",
    credentialSource: "none",
    windows: [],
    fetchedAt: null,
    estimate: {
      source: "local",
      windows: [
        {
          key: "five_hour",
          label: "5h",
          windowStartMs: NOW - 3600_000,
          resetsAtMs: NOW + 4 * 3600_000,
          used: 1_250_000,
          ...(limit === undefined ? {} : { limit }),
        },
        { key: "seven_day", label: "7d", windowStartMs: NOW, used: 4200 },
      ],
    },
  };
}

describe("Claude 本地估算", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ showUsage: true, locale: "zh-CN" });
  });

  it("用量卡标「本地估算」，没有额度只报 token、不画进度条", () => {
    render(
      <TestProviders>
        <ProviderCard provider={claude()} now={NOW} />
      </TestProviders>,
    );
    expect(screen.getByText("本地估算")).toBeTruthy();
    expect(screen.getByText("1.3M token")).toBeTruthy();
    expect(screen.getByText("4.2K token")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    // 不再说「未找到可用的登录凭据」：凭据在，是政策关着。
    expect(screen.queryByText("未找到可用的登录凭据")).toBeNull();
  });

  it("知道额度时画百分比与进度条", () => {
    render(
      <TestProviders>
        <ProviderCard provider={claude(2_500_000)} now={NOW} />
      </TestProviders>,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(bar.getAttribute("aria-label")).toContain("本地估算");
    expect(screen.getByText("已用 50%")).toBeTruthy();
  });

  it("账号页那份明细同样标出来，英文也有", () => {
    usePreferencesStore.setState({ locale: "en" });
    render(
      <TestProviders>
        <ProviderDetail provider={claude()} now={NOW} />
      </TestProviders>,
    );
    expect(screen.getByText("Local estimate")).toBeTruthy();
    expect(screen.getByText("1.3M tokens")).toBeTruthy();
  });

  it("没有估算的 policy_off 照旧只有一句原因", () => {
    const { estimate: _estimate, ...plain } = claude();
    render(
      <TestProviders>
        <ProviderDetail provider={plain} now={NOW} />
      </TestProviders>,
    );
    expect(screen.queryByText("本地估算")).toBeNull();
  });

  it("用量环把带估算的那家算进来，无障碍名里写明本地估算", async () => {
    const usage: Usage = { providers: [claude()] };
    fetchUsage.mockReset().mockResolvedValue(usage);
    render(
      <TestProviders>
        <ClusterUsage />
      </TestProviders>,
    );
    const button = await screen.findByRole("button", { name: /^用量/ });
    // 没有额度就没有百分比。
    expect(button.textContent).toBe("—");
    expect(button.getAttribute("aria-label")).toContain("本地估算");
    expect(button.getAttribute("aria-label")).toContain("1.3M token");
  });
});
