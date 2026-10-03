import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreferencesStore } from "../../../../app/preferences-store";
import { installDomPolyfills } from "../../../../app/test-harness";
import { OAuthBindings } from "./OAuthBindings";

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
