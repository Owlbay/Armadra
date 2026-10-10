import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { usePreferencesStore } from "../app/preferences-store";
import { ChallengeSheet } from "../mobile/ChallengeSheet";
import { ChallengeFrame } from "./ChallengeFrame";
import { ChallengePage, isChallengePath } from "./ChallengePage";
import {
  CHALLENGE_MESSAGE,
  challengeFrameUrl,
  isChallengeMessage,
  type TurnstileApi,
} from "./turnstile";

const ISSUER = "https://relay.example";

/** 假的 Turnstile：记下 render 的参数，测试里手动「通过」。 */
function fakeTurnstile() {
  const state: { callbacks: Array<(token: string) => void> } = {
    callbacks: [],
  };
  const api: TurnstileApi = {
    render: vi.fn((_el, options) => {
      state.callbacks.push(options.callback);
      return `w${state.callbacks.length}`;
    }),
    remove: vi.fn(),
  };
  return {
    api,
    load: async () => api,
    pass: (token: string) => state.callbacks.at(-1)!(token),
  };
}

beforeEach(() => {
  usePreferencesStore.setState({ locale: "zh-CN" });
});
afterEach(cleanup);

describe("挑战面板内容", () => {
  it("页面就在中继来源上：直接渲染 Turnstile，令牌交给调用方", async () => {
    const fake = fakeTurnstile();
    const onToken = vi.fn();
    render(
      <ChallengeFrame
        issuer={`${ISSUER}/`}
        origin={ISSUER}
        siteKey="0xSITE"
        onToken={onToken}
        load={fake.load}
      />,
    );
    await waitFor(() => expect(fake.api.render).toHaveBeenCalled());
    expect(vi.mocked(fake.api.render).mock.calls[0]![1]).toMatchObject({
      sitekey: "0xSITE",
    });
    fake.pass("tk-1");
    expect(onToken).toHaveBeenCalledWith("tk-1");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("别的来源：内嵌中继的挑战页，只认来自中继来源的令牌消息", () => {
    const onToken = vi.fn();
    render(
      <ChallengeFrame
        issuer={ISSUER}
        origin="capacitor://localhost"
        siteKey="0xSITE"
        onToken={onToken}
      />,
    );
    const frame = document.querySelector("iframe")!;
    const url = new URL(frame.getAttribute("src")!);
    expect(url.origin).toBe(ISSUER);
    expect(url.pathname).toBe("/app/challenge");
    expect(url.searchParams.get("siteKey")).toBe("0xSITE");
    expect(url.searchParams.get("parent")).toBe("capacitor://localhost");
    const message = { type: CHALLENGE_MESSAGE, token: "tk-2" };
    fireEvent(
      window,
      new MessageEvent("message", {
        data: message,
        origin: "https://evil.example",
      }),
    );
    expect(onToken).not.toHaveBeenCalled();
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "x", token: "t" },
        origin: ISSUER,
      }),
    );
    expect(onToken).not.toHaveBeenCalled();
    fireEvent(
      window,
      new MessageEvent("message", { data: message, origin: ISSUER }),
    );
    expect(onToken).toHaveBeenCalledWith("tk-2");
  });

  it("组件载不进来：给重试，重试重新渲染", async () => {
    const fake = fakeTurnstile();
    const load = vi
      .fn<() => Promise<TurnstileApi>>()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockImplementation(fake.load);
    render(
      <ChallengeFrame
        issuer={ISSUER}
        origin={ISSUER}
        siteKey="k"
        onToken={vi.fn()}
        load={load}
      />,
    );
    await screen.findByText("验证没能加载");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(fake.api.render).toHaveBeenCalled());
  });
});

describe("ChallengeSheet", () => {
  it("底部面板里放着挑战；取消（Esc）通知调用方", async () => {
    const fake = fakeTurnstile();
    const onToken = vi.fn();
    const onCancel = vi.fn();
    render(
      <ChallengeSheet
        open
        issuer={ISSUER}
        origin={ISSUER}
        siteKey="k"
        onToken={onToken}
        onCancel={onCancel}
        load={fake.load}
      />,
    );
    expect(screen.getByText("人机验证")).toBeTruthy();
    await waitFor(() => expect(fake.api.render).toHaveBeenCalled());
    fake.pass("tk-3");
    expect(onToken).toHaveBeenCalledWith("tk-3");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("挑战页 /app/challenge", () => {
  it("令牌只发给 parent 指明的来源", async () => {
    const fake = fakeTurnstile();
    window.turnstile = fake.api;
    const post = vi.fn();
    render(
      <ChallengePage
        search="?siteKey=0xSITE&parent=capacitor%3A%2F%2Flocalhost"
        post={post}
      />,
    );
    await waitFor(() => expect(fake.api.render).toHaveBeenCalled());
    fake.pass("tk-4");
    expect(post).toHaveBeenCalledWith(
      { type: CHALLENGE_MESSAGE, token: "tk-4" },
      "capacitor://localhost",
    );
    delete window.turnstile;
  });

  it("缺 siteKey 或 parent：什么也不渲染", () => {
    const { container } = render(
      <ChallengePage search="?siteKey=k" post={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("小工具", () => {
  it("路径、地址与消息形状", () => {
    expect(isChallengePath("/app/challenge")).toBe(true);
    expect(isChallengePath("/app/")).toBe(false);
    expect(challengeFrameUrl(ISSUER, "k 1", "https://a.b")).toBe(
      `${ISSUER}/app/challenge?siteKey=k+1&parent=https%3A%2F%2Fa.b`,
    );
    expect(isChallengeMessage({ type: CHALLENGE_MESSAGE, token: "t" })).toBe(
      true,
    );
    expect(isChallengeMessage({ type: CHALLENGE_MESSAGE, token: "" })).toBe(
      false,
    );
    expect(isChallengeMessage(null)).toBe(false);
  });
});
