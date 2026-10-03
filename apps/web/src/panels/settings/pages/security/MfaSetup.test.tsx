import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { groupSecret, MfaSetup, type MfaStage } from "./MfaSetup";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

const OFF = {
  enrolled: false,
  pending: false,
  enrolledAtMs: 0,
  verifiedAtMs: 0,
  recoveryCodesRemaining: 0,
  requireFor: "members" as const,
  required: true,
};

function mount(stage: MfaStage, status = OFF, error = "") {
  const handlers = {
    onEnable: vi.fn(),
    onConfirm: vi.fn(),
    onVerify: vi.fn(),
    onRequest: vi.fn(),
    onCancel: vi.fn(),
  };
  render(
    <MfaSetup
      status={status}
      stage={stage}
      busy={false}
      error={error}
      {...handlers}
    />,
  );
  return handlers;
}

describe("MfaSetup", () => {
  it("策略要求而没开：Alert 带「现在设置」", () => {
    const handlers = mount({ kind: "idle" });
    expect(screen.getByText("需要开启两步验证")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "现在设置" }));
    expect(handlers.onEnable).toHaveBeenCalled();
  });

  it("登记：二维码是 otpauth 地址，六位码填满即确认", () => {
    const handlers = mount({
      kind: "enrolling",
      enrollment: {
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/Armadra:me?secret=JBSWY3DPEHPK3PXP",
      },
    });
    expect(
      screen
        .getByRole("img", { name: "验证器二维码" })
        .getAttribute("data-qr-text"),
    ).toContain("otpauth://totp/");
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "123456" },
    });
    expect(handlers.onConfirm).toHaveBeenCalledWith("123456");
  });

  it("恢复码只在这一次出现；已开启时可重新生成或停用", () => {
    const codes = Array.from(
      { length: 10 },
      (_, index) => `aaaa${index}-bbbbb`,
    );
    const handlers = mount({ kind: "codes", codes });
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(handlers.onCancel).toHaveBeenCalled();

    cleanup();
    const on = mount(
      { kind: "idle" },
      { ...OFF, enrolled: true, recoveryCodesRemaining: 7 },
    );
    expect(screen.getByText("已开启")).toBeTruthy();
    expect(screen.getByText("剩 7 个恢复码")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    expect(on.onRequest).toHaveBeenCalledWith("disable");
  });

  it("停用要当前的码；码不对显示在下面", () => {
    const handlers = mount(
      { kind: "verify", purpose: "disable" },
      { ...OFF, enrolled: true },
      "验证码不对",
    );
    expect(screen.getByText("验证码不对")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "654321" },
    });
    expect(handlers.onVerify).toHaveBeenCalledWith("disable", "654321");
  });

  it("密钥四个一组", () => {
    expect(groupSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});
