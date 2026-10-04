import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdentityRequestError } from "../api/identity";

const mocks = vi.hoisted(() => ({
  password: vi.fn(),
  verify: vi.fn(),
  start: vi.fn(),
  options: vi.fn(),
  loginVerify: vi.fn(),
  assertion: vi.fn(),
}));

vi.mock("../api/security", async (original) => {
  const actual = await original<typeof import("../api/security")>();
  return {
    ...actual,
    signInWithPassword: (...args: never[]) => mocks.password(...args),
    verifyMfa: (...args: never[]) => mocks.verify(...args),
    startOAuth: (...args: never[]) => mocks.start(...args),
    passkeyLoginOptions: (...args: never[]) => mocks.options(...args),
    passkeyLoginVerify: (...args: never[]) => mocks.loginVerify(...args),
    oauthProviders: async () => ({ configured: false, providers: [] }),
  };
});

vi.mock("./webauthn", async (original) => {
  const actual = await original<typeof import("./webauthn")>();
  return {
    ...actual,
    getAssertion: (...args: never[]) => mocks.assertion(...args),
  };
});

import { usePreferencesStore } from "../app/preferences-store";
import { installDomPolyfills } from "../app/test-harness";
import { ipLiteral, SignIn } from "./SignIn";

const SESSION = {
  hostId: "h",
  device: {
    deviceId: "d",
    principalId: "p".repeat(32),
    displayName: "",
    role: "member",
    createdAtUnixMs: 0,
    revision: 0,
  },
  scopes: [],
  expiresAtUnixMs: 0,
};

function wrap(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

installDomPolyfills();

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(cleanup);

async function enterPassword(onSignedIn = vi.fn()) {
  render(
    wrap(<SignIn onSignedIn={onSignedIn} providers={[]} passkey={false} />),
  );
  fireEvent.change(screen.getByLabelText("账号标识"), {
    target: { value: "  acct  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  fireEvent.change(await screen.findByLabelText("口令"), {
    target: { value: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  return onSignedIn;
}

describe("SignIn", () => {
  it("账号 → 口令 → 会话；带回 mfaEnrollmentRequired", async () => {
    mocks.password.mockResolvedValue({
      kind: "session",
      session: SESSION,
      mfaEnrollmentRequired: true,
    });
    const onSignedIn = await enterPassword();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(SESSION, true));
    expect(mocks.password).toHaveBeenCalledWith("acct", "secret");
  });

  it("口令对了而登记过 TOTP：进第二步，六位码填满自动提交；可改用恢复码", async () => {
    mocks.password.mockResolvedValue({
      kind: "mfa",
      challenge: {
        mfaRequired: true,
        challengeId: "ch1",
        expiresAtMs: 1,
        methods: ["totp", "recovery"],
      },
    });
    mocks.verify.mockRejectedValueOnce(
      new IdentityRequestError(401, "mfa_invalid_code", ""),
    );
    mocks.verify.mockResolvedValueOnce({
      kind: "session",
      session: SESSION,
      mfaEnrollmentRequired: false,
    });
    const onSignedIn = await enterPassword();
    expect(
      await screen.findByRole("heading", { name: "两步验证" }),
    ).toBeTruthy();
    // 六格占满整行宽，格子组居中而不是贴左。
    const slots = document.querySelector('[data-slot="input-otp-group"]');
    expect(slots?.parentElement?.className).toContain("justify-center");
    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "123456" },
    });
    await waitFor(() =>
      expect(mocks.verify).toHaveBeenCalledWith("ch1", "123456"),
    );
    expect(await screen.findByText("验证码不对")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "使用恢复码" }));
    fireEvent.change(screen.getByLabelText("恢复码"), {
      target: { value: "abcde-fghij" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证" }));
    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith(SESSION, false),
    );
    expect(mocks.verify).toHaveBeenLastCalledWith("ch1", "abcde-fghij");
  });

  it("口令步「忘记口令」只给一句：找管理员签发重置链接", async () => {
    render(
      wrap(<SignIn onSignedIn={vi.fn()} providers={[]} passkey={false} />),
    );
    // 账号步没有这个入口。
    expect(screen.queryByRole("button", { name: "忘记口令" })).toBeNull();
    fireEvent.change(screen.getByLabelText("账号标识"), {
      target: { value: "acct" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(await screen.findByRole("button", { name: "忘记口令" }));
    expect(screen.getByRole("status").textContent).toBe(
      "请联系管理员为你签发重置链接",
    );
    expect(screen.queryByRole("button", { name: "忘记口令" })).toBeNull();
    expect(mocks.password).not.toHaveBeenCalled();
  });

  it("从重置页过来：直接口令步，账号已填", async () => {
    render(
      wrap(
        <SignIn
          onSignedIn={vi.fn()}
          providers={[]}
          passkey={false}
          initial={{ step: "password", account: "p".repeat(32) }}
        />,
      ),
    );
    expect(screen.getByLabelText("口令")).toBeTruthy();
    expect(
      (document.querySelector('input[name="username"]') as HTMLInputElement)
        .value,
    ).toBe("p".repeat(32));
  });

  it("口令错：字段下一行，不区分账号不存在", async () => {
    mocks.password.mockRejectedValue(
      new IdentityRequestError(401, "UNAUTHENTICATED", "nope"),
    );
    await enterPassword();
    expect(await screen.findByText("账号或口令不对")).toBeTruthy();
  });

  it("锁定：Alert 写分钟数，按钮禁用", async () => {
    mocks.password.mockRejectedValue(
      new IdentityRequestError(429, "account_locked", "", 125),
    );
    await enterPassword();
    expect(await screen.findByText("尝试次数过多，3 分钟后再试")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "登录" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("中间票过期：回到第一步并说明", async () => {
    mocks.verify.mockRejectedValue(
      new IdentityRequestError(401, "mfa_challenge_expired", ""),
    );
    render(
      wrap(
        <SignIn
          onSignedIn={vi.fn()}
          providers={[]}
          passkey={false}
          initial={{ challengeId: "ch9" }}
        />,
      ),
    );
    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "654321" },
    });
    expect(await screen.findByText("验证已过期，请重新登录")).toBeTruthy();
    expect(screen.getByLabelText("账号标识")).toBeTruthy();
  });

  it("通行密钥与第三方账号按钮；取消系统对话框不报错", async () => {
    mocks.options.mockResolvedValue({ challengeId: "c", options: {} });
    mocks.assertion.mockRejectedValueOnce(
      new DOMException("cancelled", "NotAllowedError"),
    );
    mocks.assertion.mockResolvedValueOnce({ id: "x" });
    mocks.loginVerify.mockResolvedValue({
      kind: "session",
      session: SESSION,
      mfaEnrollmentRequired: false,
    });
    mocks.start.mockResolvedValue(undefined);
    const onSignedIn = vi.fn();
    render(
      wrap(
        <SignIn
          onSignedIn={onSignedIn}
          passkey
          providers={[
            { id: "github", kind: "github" },
            { id: "corp", kind: "oidc" },
          ]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "使用 corp 登录" }));
    expect(mocks.start).toHaveBeenCalledWith("corp", "login");
    expect(
      screen.getByRole("button", { name: "使用 GitHub 登录" }),
    ).toBeTruthy();

    cleanup();
    render(wrap(<SignIn onSignedIn={onSignedIn} passkey providers={[]} />));
    const passkey = screen.getByRole("button", { name: "使用通行密钥" });
    await act(async () => {
      fireEvent.click(passkey);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "使用通行密钥" }));
    });
    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith(SESSION, false),
    );
    expect(mocks.loginVerify).toHaveBeenCalledWith("c", { id: "x" });
  });

  it("IP 字面量主机上不摆通行密钥", () => {
    expect(ipLiteral("127.0.0.1")).toBe(true);
    expect(ipLiteral("[::1]")).toBe(true);
    expect(ipLiteral("localhost")).toBe(false);
    expect(ipLiteral("armadra.example.com")).toBe(false);
  });
});
