import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import {
  TestProviders,
  installDomPolyfills,
} from "../../../../app/test-harness";
import { GatewayDevicesSection } from "./GatewaySection";

/**
 * 设备表的「取消在路上的那一次」：配对成功的那一刻会话换了，还在路上的设备
 * 请求带的是旧凭据（会答 401）。组件先取消它、再重取——只作废的话，还没有
 * 数据的查询会沿用那一次的答案。
 */

const mocks = vi.hoisted(() => ({
  sessionListeners: new Set<() => void>(),
  listIdentityDevices: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../../../../api/identity", async (original) => ({
  ...(await original<typeof import("../../../../api/identity")>()),
  onIdentitySessionChange: (listener: () => void) => {
    mocks.sessionListeners.add(listener);
    return () => mocks.sessionListeners.delete(listener);
  },
}));

vi.mock("../../../../api/security", async (original) => ({
  ...(await original<typeof import("../../../../api/security")>()),
  listIdentityDevices: mocks.listIdentityDevices,
}));

vi.mock("../../../../api/gateway", async (original) => {
  const actual = await original<typeof import("../../../../api/gateway")>();
  return {
    ...actual,
    gatewayApi: { ...actual.gatewayApi, status: mocks.status },
  };
});

installDomPolyfills();
beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  mocks.sessionListeners.clear();
  mocks.listIdentityDevices.mockReset();
  // 读不到对外服务的状态（成员会 403）：只剩设备表，与配置无关。
  mocks.status.mockReset().mockRejectedValue(new Error("forbidden"));
});
afterEach(cleanup);

const page = (name: string) => ({
  devices: [
    {
      deviceId: "d".repeat(32),
      principalId: "p".repeat(32),
      name,
      role: "owner",
      epoch: 1,
      createdAtMs: Date.UTC(2026, 9, 1),
      revokedAtMs: 0,
    },
  ],
  nextId: "",
  hasMore: false,
});

/** 像 fetch 一样：信号一中止，这次请求以 AbortError 结束。 */
function pending(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });
}

describe("GatewayDevicesSection：会话换了就取消在路上的设备请求", () => {
  it("第一次请求被中止，重取的那一次的答案上屏", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    mocks.listIdentityDevices.mockImplementation(
      (_after: string, _limit: number, signal?: AbortSignal) => {
        signals.push(signal);
        return signals.length === 1
          ? pending(signal)
          : Promise.resolve(page("新手机"));
      },
    );
    render(
      <TestProviders>
        <GatewayDevicesSection />
      </TestProviders>,
    );
    await vi.waitFor(() =>
      expect(mocks.listIdentityDevices).toHaveBeenCalledTimes(1),
    );
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
    expect(mocks.sessionListeners.size).toBe(1);

    await act(async () => {
      for (const listener of mocks.sessionListeners) listener();
    });

    await vi.waitFor(() =>
      expect(mocks.listIdentityDevices).toHaveBeenCalledTimes(2),
    );
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(await screen.findByText("新手机")).toBeTruthy();
  });

  it("卸载之后不再听会话变化", async () => {
    mocks.listIdentityDevices.mockResolvedValue(page("手机"));
    const view = render(
      <TestProviders>
        <GatewayDevicesSection />
      </TestProviders>,
    );
    expect(await screen.findByText("手机")).toBeTruthy();
    expect(mocks.sessionListeners.size).toBe(1);
    view.unmount();
    expect(mocks.sessionListeners.size).toBe(0);
  });
});
