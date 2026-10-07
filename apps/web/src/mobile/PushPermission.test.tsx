import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  compact: true,
  config: vi.fn(),
  devices: vi.fn(),
  register: vi.fn(),
  setKinds: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../platform/layout", () => ({
  useCompactLayout: () => mocks.compact,
  isCompactLayout: () => mocks.compact,
}));
vi.mock("../api/push", () => ({
  pushApi: {
    config: (...args: unknown[]) => mocks.config(...args),
    devices: (...args: unknown[]) => mocks.devices(...args),
    register: (...args: unknown[]) => mocks.register(...args),
    setKinds: (...args: unknown[]) => mocks.setKinds(...args),
  },
}));
vi.mock("../push/service-worker", async (original) => ({
  ...(await original<typeof import("../push/service-worker")>()),
  subscribeToPush: (...args: unknown[]) => mocks.subscribe(...args),
}));

import { usePreferencesStore } from "../app/preferences-store";
import { useCanvasStore } from "../store/canvas-store";
import type { NativeBridge } from "./native-bridge";
import {
  enablePush,
  PushPermission,
  SERVICE_WORKER_URL,
  shouldAsk,
} from "./PushPermission";

const CONFIG = {
  webpush: { enabled: true, publicKey: "BPk" },
  native: { transport: "log", status: "notConfigured", platforms: [] },
} as const;

const WEB = { available: false } as NativeBridge;

beforeEach(() => {
  mocks.compact = true;
  mocks.config.mockReset();
  mocks.devices.mockReset();
  mocks.register.mockReset();
  mocks.setKinds.mockReset();
  mocks.subscribe.mockReset();
  localStorage.clear();
  useCanvasStore.setState({ focusNodeId: null });
  usePreferencesStore.setState({ locale: "zh-CN" });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Notification", { permission: "default" });
  Object.defineProperty(navigator, "serviceWorker", {
    value: {},
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("该不该问", () => {
  it("浏览器要 Web Push 开着且权限没定过；原生 App 只要配置答得出", () => {
    expect(shouldAsk(CONFIG as never, WEB, true)).toBe(true);
    expect(shouldAsk(CONFIG as never, WEB, false)).toBe(false);
    expect(
      shouldAsk(
        { ...CONFIG, webpush: { enabled: false, publicKey: null } } as never,
        WEB,
        true,
      ),
    ).toBe(false);
    expect(
      shouldAsk(
        { ...CONFIG, webpush: { enabled: false, publicKey: null } } as never,
        { available: true } as NativeBridge,
        false,
      ),
    ).toBe(true);
  });
});

describe("开启", () => {
  it("浏览器走 Web Push，worker 挂在站点根", async () => {
    mocks.subscribe.mockResolvedValue({ ok: true, deviceId: "d" });
    await expect(enablePush("en", WEB)).resolves.toBe("ok");
    expect(mocks.subscribe).toHaveBeenCalledWith(SERVICE_WORKER_URL, "en");
    expect(SERVICE_WORKER_URL).toBe("/sw.js");
    mocks.subscribe.mockResolvedValue({ ok: false, reason: "denied" });
    await expect(enablePush("en", WEB)).resolves.toBe("denied");
  });

  it("原生 App 把插件给的令牌与公钥登记给 core", async () => {
    const bridge = {
      available: true,
      pushRegistration: vi.fn(async () => ({
        platform: "android",
        transport: "relay",
        token: "relay-token",
        publicKey: "pk",
      })),
      ackPushRotation: vi.fn(async () => undefined),
    } as unknown as NativeBridge;
    mocks.register.mockResolvedValue({ device: {} });
    await expect(enablePush("zh-CN", bridge)).resolves.toBe("ok");
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.register.mock.calls[0]![0]).toEqual({
      platform: "android",
      transport: "relay",
      token: "relay-token",
      publicKey: "pk",
      locale: "zh-CN",
    });
    // 一份新的登记就是当前的令牌：「换过」的标记清掉，之后轮换由页面自己补登记。
    expect(bridge.ackPushRotation).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("armadra.push.native")).toBe("1");
    (bridge.pushRegistration as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
    await expect(enablePush("zh-CN", bridge)).resolves.toBe("failed");
  });
});

describe("提示条", () => {
  it("手机布局登录后出现，「以后」之后不再问", async () => {
    mocks.config.mockResolvedValue(CONFIG);
    const { unmount } = render(<PushPermission />);
    await waitFor(() =>
      expect(screen.getByText("接收审批与完成通知")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "以后" }));
    expect(screen.queryByText("接收审批与完成通知")).toBeNull();
    unmount();
    mocks.config.mockClear();
    render(<PushPermission />);
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it("焦点页打开时让开，退回画布再出来", async () => {
    mocks.config.mockResolvedValue(CONFIG);
    useCanvasStore.setState({ focusNodeId: "n1" });
    render(<PushPermission />);
    await waitFor(() => expect(mocks.config).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByText("接收审批与完成通知")).toBeNull();
    act(() => useCanvasStore.setState({ focusNodeId: null }));
    expect(screen.getByText("接收审批与完成通知")).toBeTruthy();
  });

  it("「开启」订阅后收起", async () => {
    mocks.config.mockResolvedValue(CONFIG);
    mocks.subscribe.mockResolvedValue({ ok: true, deviceId: "d" });
    render(<PushPermission />);
    fireEvent.click(await screen.findByRole("button", { name: "开启" }));
    await waitFor(() =>
      expect(screen.queryByText("接收审批与完成通知")).toBeNull(),
    );
    expect(mocks.subscribe).toHaveBeenCalled();
  });

  it("开启之后换成「收哪些」开关，关掉一种就 PATCH 这台设备，完成后收起", async () => {
    const ALL = [
      "approval",
      "agentDone",
      "agentError",
      "deliveryFailed",
      "schedule",
      "resources",
      "comment",
      "workflowGate",
    ];
    mocks.config.mockResolvedValue(CONFIG);
    mocks.devices.mockResolvedValue({
      devices: [
        { deviceId: "other", current: false, kinds: ALL },
        { deviceId: "d1", current: true, kinds: ALL },
      ],
    });
    mocks.setKinds.mockImplementation(
      async (deviceId: string, kinds: string[]) => ({
        device: { deviceId, kinds },
      }),
    );
    mocks.subscribe.mockResolvedValue({ ok: true, deviceId: "d1" });
    render(<PushPermission />);
    fireEvent.click(await screen.findByRole("button", { name: "开启" }));
    const agentDone = await screen.findByRole("switch", { name: "Agent 完成" });
    expect(agentDone.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(agentDone);
    await waitFor(() => expect(mocks.setKinds).toHaveBeenCalled());
    expect(mocks.setKinds.mock.calls[0]).toEqual([
      "d1",
      ALL.filter((kind) => kind !== "agentDone"),
    ]);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Agent 完成" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.queryByRole("switch", { name: "Agent 完成" })).toBeNull();
    // 问过了：下次不再出。
    expect(localStorage.getItem("armadra.push.asked")).toBe("1");
  });

  it("保存失败退回原样并提示", async () => {
    mocks.config.mockResolvedValue(CONFIG);
    mocks.devices.mockResolvedValue({
      devices: [{ deviceId: "d1", current: true }],
    });
    mocks.setKinds.mockRejectedValue(new Error("500"));
    mocks.subscribe.mockResolvedValue({ ok: true, deviceId: "d1" });
    render(<PushPermission />);
    fireEvent.click(await screen.findByRole("button", { name: "开启" }));
    const approval = await screen.findByRole("switch", { name: "等待审批" });
    fireEvent.click(approval);
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "等待审批" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("宽屏、没登录（配置取不到）或权限已定时都不出", async () => {
    mocks.compact = false;
    render(<PushPermission />);
    expect(mocks.config).not.toHaveBeenCalled();
    cleanup();
    mocks.compact = true;
    mocks.config.mockRejectedValue(new Error("401"));
    render(<PushPermission />);
    await waitFor(() => expect(mocks.config).toHaveBeenCalled());
    expect(screen.queryByText("接收审批与完成通知")).toBeNull();
    cleanup();
    vi.stubGlobal("Notification", { permission: "granted" });
    mocks.config.mockResolvedValue(CONFIG);
    render(<PushPermission />);
    await waitFor(() => expect(mocks.config).toHaveBeenCalledTimes(2));
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByText("接收审批与完成通知")).toBeNull();
  });
});
