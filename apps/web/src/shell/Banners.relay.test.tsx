import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import type { HostedRelay, HostedStatus } from "../sources/hosted";

/**
 * 中继托管的页面：中继自己停了要有专门的一条（不是「主机等待上线」，也不是
 * 「本地服务已断开」），中继回来就消失；不给刷新（凭据只在内存）。
 */

const health = vi.hoisted(() => ({ fail: false }));

vi.mock("../api/client", () => ({
  runtimeApi: {
    health: () =>
      health.fail
        ? Promise.reject(new Error("down"))
        : Promise.resolve({ ok: true }),
    terminalBackend: () => Promise.resolve({ kind: "direct" }),
    agentIntegration: () => Promise.resolve({ legacy: { found: [] } }),
    agents: () => Promise.resolve([]),
  },
}));

const { resetHostedRelay } = await import("../sources/hosted");
const { resetMobileRelayStatus } = await import("../mobile/relay-status");
const { installDomPolyfills, TestProviders } = await import(
  "../app/test-harness"
);
const { usePreferencesStore } = await import("../app/preferences-store");
const { Banners } = await import("./Banners");

installDomPolyfills();

function fakeRelay(initial: HostedStatus) {
  let status = initial;
  const listeners = new Set<() => void>();
  const relay = {
    issuer: "https://relay.example",
    get status() {
      return status;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostedRelay;
  return {
    relay,
    set(next: Partial<HostedStatus>) {
      status = { ...status, ...next };
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  health.fail = false;
});

afterEach(() => {
  cleanup();
  resetHostedRelay();
  resetMobileRelayStatus();
});

describe("中继托管页面的通知条", () => {
  it("中继停了：专门一条，盖过主机等待与运行时断开，没有刷新钮；回来就消失", async () => {
    health.fail = true;
    const fake = fakeRelay({
      state: "waitingForSource",
      lastError: { code: "source_offline", message: "" },
      relayDown: true,
    });
    resetHostedRelay(fake.relay);
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    expect(await screen.findByText("中转服务不可用，正在重连")).toBeTruthy();
    expect(screen.queryByText("等待上线")).toBeNull();
    expect(screen.queryByText("本地服务已断开")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    health.fail = false;
    act(() => fake.set({ relayDown: false, state: "ready", lastError: null }));
    expect(screen.queryByText("中转服务不可用，正在重连")).toBeNull();
  });

  it("只是主机下线：仍是「等待上线」", async () => {
    resetHostedRelay(
      fakeRelay({
        state: "waitingForSource",
        lastError: { code: "source_offline", message: "" },
        relayDown: false,
      }).relay,
    );
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    expect(await screen.findByText("等待上线")).toBeTruthy();
    expect(screen.queryByText("中转服务不可用，正在重连")).toBeNull();
  });
});

describe("手机经中继的连接", () => {
  const RELAY = "https://relay.example";

  it("运行时断开、中继也连不上：同一条「中转服务不可用」，盖过运行时断开", async () => {
    health.fail = true;
    const probe = vi.fn(async () => false);
    resetMobileRelayStatus({ origin: RELAY, probe });
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    expect(await screen.findByText("中转服务不可用，正在重连")).toBeTruthy();
    expect(screen.queryByText("本地服务已断开")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(probe).toHaveBeenCalledWith(RELAY);
  });

  it("中继还答话（主机下线等）：仍是运行时断开，不说中继", async () => {
    health.fail = true;
    resetMobileRelayStatus({ origin: RELAY, probe: async () => true });
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    expect(await screen.findByText("本地服务已断开")).toBeTruthy();
    expect(screen.queryByText("中转服务不可用，正在重连")).toBeNull();
  });

  it("直连或运行时正常：不去问中继", async () => {
    const probe = vi.fn(async () => false);
    resetMobileRelayStatus({ origin: RELAY, probe });
    render(
      <TestProviders>
        <Banners />
      </TestProviders>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe).not.toHaveBeenCalled();
    expect(screen.queryByText("中转服务不可用，正在重连")).toBeNull();
  });
});
