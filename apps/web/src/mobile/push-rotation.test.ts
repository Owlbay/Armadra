import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("../api/push", () => ({
  pushApi: { register: (...args: unknown[]) => mocks.register(...args) },
}));

import type { NativeBridge } from "./native-bridge";
import { markNativePushRegistered, reregisterIfRotated } from "./push-rotation";

function bridge(rotated: boolean): NativeBridge {
  return {
    available: true,
    pushRotated: vi.fn(async () => rotated),
    pushRegistration: vi.fn(async () => ({
      platform: "android",
      transport: "direct",
      token: "new-token",
      publicKey: "pk",
    })),
    ackPushRotation: vi.fn(async () => undefined),
  } as unknown as NativeBridge;
}

beforeEach(() => {
  localStorage.clear();
  mocks.register.mockReset();
});

describe("推送令牌轮换后重新登记（R-54）", () => {
  it("开过推送、令牌换过：登记新令牌，成功后清标记", async () => {
    markNativePushRegistered();
    mocks.register.mockResolvedValue({ device: {} });
    const native = bridge(true);
    await expect(reregisterIfRotated("en", native)).resolves.toBe(true);
    expect(mocks.register.mock.calls[0]![0]).toMatchObject({
      token: "new-token",
      locale: "en",
    });
    expect(native.ackPushRotation).toHaveBeenCalledTimes(1);
  });

  it("没开过推送、没换过：什么都不发", async () => {
    const native = bridge(true);
    await expect(reregisterIfRotated("en", native)).resolves.toBe(false);
    expect(native.pushRotated).not.toHaveBeenCalled();
    markNativePushRegistered();
    await expect(reregisterIfRotated("en", bridge(false))).resolves.toBe(false);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("登记失败不清标记；并发的几次合成一次", async () => {
    markNativePushRegistered();
    const native = bridge(true);
    mocks.register.mockRejectedValueOnce(new Error("offline"));
    await expect(reregisterIfRotated("en", native)).resolves.toBe(false);
    expect(native.ackPushRotation).not.toHaveBeenCalled();
    mocks.register.mockResolvedValue({ device: {} });
    const both = await Promise.all([
      reregisterIfRotated("en", native),
      reregisterIfRotated("en", native),
    ]);
    expect(both).toEqual([true, true]);
    expect(mocks.register).toHaveBeenCalledTimes(2);
  });
});
