import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePreferencesStore } from "./preferences-store";
import { useCanvasStore } from "@/store/canvas-store";
import { useLinkFragments } from "./use-link-fragments";
import { takeJoinLink } from "../sources/join-intent";

/**
 * 服务器壳的两种链接：`#invite=` 与 `#pair=`。
 *
 * 此前这段判断写在设置对话框里，而对话框挂在闸门后面（`Overlays.tsx`）——
 * 只有设置已经打开才会挂载，于是两条链接打开后什么都不会发生。钩子挂在闸门
 * 之外，这里验证它自己把设置开到对应的一页。
 */

const original = window.location.hash;

beforeEach(() => {
  useCanvasStore.getState().setPanel("settings", false);
  usePreferencesStore.getState().setLastSettingsSection("general");
});
afterEach(() => {
  window.history.replaceState(null, "", original || window.location.pathname);
});

describe("useLinkFragments", () => {
  it("邀请链接打开到「账号与共享」", () => {
    window.history.replaceState(null, "", "#invite=tok.en");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("accounts");
  });

  it("配对链接打开到「设备与会话」", () => {
    window.history.replaceState(null, "", "#pair=abc.def");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("devices");
  });

  it("OAuth 回调打开到「安全」", () => {
    window.history.replaceState(null, "", "#oauth=mfa&challengeId=c1");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("security");
  });

  it("原生 App 只认 OAuth 回调（原生 OAuth 收尾后的片段）", () => {
    window.history.replaceState(null, "", "#pair=abc.def");
    renderHook(() => useLinkFragments(false, true));
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    window.history.replaceState(null, "", "#oauth=bound");
    renderHook(() => useLinkFragments(false, true));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("security");
  });

  it("不是服务器壳、或者没有片段，什么都不做", () => {
    window.history.replaceState(null, "", "#pair=abc.def");
    renderHook(() => useLinkFragments(false));
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    window.history.replaceState(null, "", "#other");
    renderHook(() => useLinkFragments(true));
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe("general");
  });
});

describe("分享链接（A4-3p）", () => {
  const SHARE = `https://relay.example.com/j/0123456789abcdef#${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`;

  afterEach(() => {
    takeJoinLink();
    delete (window as { armadra?: unknown }).armadra;
  });

  it("#join=<链接>：打开到「远程服务」并交出链接，片段从地址栏抹掉", () => {
    window.history.replaceState(null, "", `#join=${encodeURIComponent(SHARE)}`);
    renderHook(() => useLinkFragments(true, false, false));
    expect(useCanvasStore.getState().panels.settings).toBe(true);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe(
      "remoteAccess",
    );
    expect(window.location.hash).toBe("");
    expect(takeJoinLink()).toBe(SHARE);
  });

  it("认不出的 #join= 不打开设置", () => {
    window.history.replaceState(null, "", "#join=hello");
    renderHook(() => useLinkFragments(true, false, false));
    expect(useCanvasStore.getState().panels.settings).toBe(false);
    expect(takeJoinLink()).toBeNull();
  });

  it("桌面壳：启动时那条深链与之后推来的深链都交出", async () => {
    const deep = `armadra://join?link=0123456789abcdef&issuer=${encodeURIComponent("https://relay.example.com")}&s=${encodeURIComponent(`${"S".repeat(43)}.${"c".repeat(32)}.${"D".repeat(43)}`)}`;
    let push: ((url: string) => void) | undefined;
    (window as { armadra?: unknown }).armadra = {
      sources: {
        changed: async () => ({ reload: false }),
        takeJoinLink: async () => deep,
        onJoinLink: (listener: (url: string) => void) => {
          push = listener;
          return () => undefined;
        },
      },
    };
    renderHook(() => useLinkFragments(false, false, true));
    await Promise.resolve();
    await Promise.resolve();
    expect(takeJoinLink()).toBe(deep);
    expect(usePreferencesStore.getState().lastSettingsSection).toBe(
      "remoteAccess",
    );
    push?.("https://not-a-link.example.com/");
    expect(takeJoinLink()).toBeNull();
    push?.(deep);
    expect(takeJoinLink()).toBe(deep);
  });
});
