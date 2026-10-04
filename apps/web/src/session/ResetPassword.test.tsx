import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityRequestError } from "../api/identity";

const mocks = vi.hoisted(() => ({ open: vi.fn(), complete: vi.fn() }));

vi.mock("../api/security", async (original) => {
  const actual = await original<typeof import("../api/security")>();
  return {
    ...actual,
    openPasswordReset: (...args: never[]) => mocks.open(...args),
    completePasswordReset: (...args: never[]) => mocks.complete(...args),
  };
});

import { usePreferencesStore } from "../app/preferences-store";
import { installDomPolyfills } from "../app/test-harness";
import { ResetPassword } from "./ResetPassword";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 先挂一个空处理器：spy 记结果时派生出的那条 promise 不算未处理的拒绝。 */
function rejecting(error: unknown): Promise<never> {
  const promise = Promise.reject(error);
  promise.catch(() => {});
  return promise;
}

const TOKEN = `${"a".repeat(32)}.${"B".repeat(43)}`;

function fill(password: string, repeat = password) {
  fireEvent.change(screen.getByLabelText("新口令"), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText("再输一次"), {
    target: { value: repeat },
  });
  fireEvent.click(screen.getByRole("button", { name: "设置口令" }));
}

describe("ResetPassword：认不出", () => {
  it("认不出的令牌只说链接已失效", async () => {
    mocks.open.mockImplementation(() =>
      rejecting(new IdentityRequestError(404, "password_reset_invalid", "")),
    );
    const onSignIn = vi.fn();
    render(<ResetPassword token={TOKEN} onSignIn={onSignIn} />);
    expect(
      await screen.findByRole("heading", { name: "链接已失效" }),
    ).toBeTruthy();
    expect(screen.getByText("请联系管理员重新签发")).toBeTruthy();
    expect(screen.queryByLabelText("新口令")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "去登录" }));
    expect(onSignIn).toHaveBeenCalledWith("");
  });
});

describe("ResetPassword", () => {
  beforeEach(() =>
    mocks.open.mockResolvedValue({
      displayName: "同事",
      expiresAtMs: Date.UTC(2026, 9, 5, 12),
    }),
  );

  it("两次不一样不发请求", async () => {
    render(<ResetPassword token={TOKEN} onSignIn={vi.fn()} />);
    await screen.findByText("同事");
    fill("correct horse battery", "correct horse");
    expect(await screen.findByText("两次输入不一样")).toBeTruthy();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["password_too_short", "口令太短"],
    ["password_too_long", "口令太长"],
    ["password_contains_name", "口令里不能有名字或账号"],
    ["password_too_common", "这个口令太常见"],
    ["password_breached", "这个口令出现在已知泄露里，换一个"],
  ])("策略拒绝 %s 显示在字段下面", async (code, text) => {
    mocks.complete.mockRejectedValue(new IdentityRequestError(400, code, ""));
    render(<ResetPassword token={TOKEN} onSignIn={vi.fn()} />);
    await screen.findByText("同事");
    fill("password");
    expect(await screen.findByText(text)).toBeTruthy();
    // 表单还在，可以换一个再试。
    expect(screen.getByLabelText("新口令")).toBeTruthy();
  });

  it("设好后 warn 档命中给一条 Alert，去登录带上 principalId", async () => {
    mocks.complete.mockResolvedValue({
      principalId: "p".repeat(32),
      revokedSessions: 1,
      passwordBreached: true,
    });
    const onSignIn = vi.fn();
    render(<ResetPassword token={TOKEN} onSignIn={onSignIn} />);
    await screen.findByText("同事");
    fill("correct horse battery");
    expect(
      await screen.findByRole("heading", { name: "口令已设置" }),
    ).toBeTruthy();
    expect(screen.getByText("这个口令出现在已知泄露里")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "去登录" }));
    expect(onSignIn).toHaveBeenCalledWith("p".repeat(32));
  });

  it("用的时候才发现失效（别人先用了）也转到失效", async () => {
    mocks.complete.mockRejectedValue(
      new IdentityRequestError(404, "password_reset_invalid", ""),
    );
    render(<ResetPassword token={TOKEN} onSignIn={vi.fn()} />);
    await screen.findByText("同事");
    fill("correct horse battery");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "链接已失效" })).toBeTruthy(),
    );
  });
});
