import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { OAuthBindings, OAuthProviders } from "./OAuthBindings";

installDomPolyfills();
beforeEach(() => usePreferencesStore.setState({ locale: "zh-CN" }));
afterEach(cleanup);

describe("OAuthBindings", () => {
  it("已绑的列出可解绑，没绑的给「绑定」，认不出的提供方照样能解", () => {
    const onBind = vi.fn();
    const onUnbind = vi.fn();
    const binding = {
      credentialId: "c1",
      providerId: "github",
      kind: "github" as const,
      createdAtMs: 1,
    };
    render(
      <OAuthBindings
        bindings={[
          binding,
          { credentialId: "c2", providerId: "", kind: "oidc", createdAtMs: 1 },
        ]}
        providers={[
          { id: "github", kind: "github" },
          { id: "dex", kind: "oidc" },
        ]}
        busy={null}
        onBind={onBind}
        onUnbind={onUnbind}
      />,
    );
    expect(screen.queryByRole("button", { name: "绑定 GitHub" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "绑定 dex" }));
    expect(onBind).toHaveBeenCalledWith({ id: "dex", kind: "oidc" });
    expect(screen.getByText("已移除的提供方")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "解绑 GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "解绑" }));
    expect(onUnbind).toHaveBeenCalledWith(binding);
  });

  it("没有提供方也没有绑定：整块不出现", () => {
    const { container } = render(
      <OAuthBindings
        bindings={[]}
        providers={[]}
        busy={null}
        onBind={vi.fn()}
        onUnbind={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("OAuthProviders", () => {
  it("状态、回调地址；设密钥走对话框，有密钥时可清除", () => {
    const onSetSecret = vi.fn();
    const onClearSecret = vi.fn();
    const github = {
      id: "github",
      kind: "github" as const,
      enabled: true,
      usable: false,
      hasClientSecret: false,
      callbackUrls: ["https://a.example/api/identity/oauth/github/callback"],
    };
    const dex = {
      id: "dex",
      kind: "oidc" as const,
      enabled: true,
      usable: true,
      hasClientSecret: true,
      callbackUrls: [],
    };
    render(
      <OAuthProviders
        providers={[github, dex]}
        busy={null}
        onSetSecret={onSetSecret}
        onClearSecret={onClearSecret}
      />,
    );
    expect(screen.getByText("不可用")).toBeTruthy();
    expect(screen.getByText(github.callbackUrls[0]!)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onClearSecret).toHaveBeenCalledWith(dex);
    fireEvent.click(screen.getByRole("button", { name: "设置 GitHub 的密钥" }));
    fireEvent.change(screen.getByLabelText("客户端密钥"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSetSecret).toHaveBeenCalledWith(github, "s3cret");
  });
});
