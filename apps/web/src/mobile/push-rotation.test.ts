import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../api/request", async (original) => ({
  ...(await original<typeof import("../api/request")>()),
  request: mocks.request,
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
  mocks.request.mockReset();
});

describe("推送令牌轮换后重新登记（R-54）", () => {
  it("开过推送、令牌换过：PUT 新登记，成功后清标记", async () => {
    markNativePushRegistered();
    mocks.request.mockResolvedValue({ device: {} });
    const native = bridge(true);
    await expect(reregisterIfRotated("en", native)).resolves.toBe(true);
    const [path, , init] = mocks.request.mock.calls[0]!;
    expect(path).toBe("/api/push/devices");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toMatchObject({
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
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("登记失败不清标记；并发的几次合成一次", async () => {
    markNativePushRegistered();
    const native = bridge(true);
    mocks.request.mockRejectedValueOnce(new Error("offline"));
    await expect(reregisterIfRotated("en", native)).resolves.toBe(false);
    expect(native.ackPushRotation).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue({ device: {} });
    const both = await Promise.all([
      reregisterIfRotated("en", native),
      reregisterIfRotated("en", native),
    ]);
    expect(both).toEqual([true, true]);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
