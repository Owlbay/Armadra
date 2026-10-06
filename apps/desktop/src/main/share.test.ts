import { beforeEach, describe, expect, it, vi } from "vitest";

/** `app:share` 对着假的 `ShareMenu`：不像样的请求与没有菜单的平台从不碰 Electron。 */

const popped: { urls: string[]; window: unknown }[] = [];
let throwOnPopup = false;

vi.mock("electron", () => ({
  ShareMenu: class {
    constructor(private readonly item: { urls: string[] }) {}
    popup(options: { window: unknown }) {
      if (throwOnPopup) throw new Error("no menu");
      popped.push({ urls: this.item.urls, window: options.window });
    }
  },
}));

import { shareUrl } from "./share";

const window = { id: 1 } as never;
const url = "https://relay.example/j/abc#secret.invite";

beforeEach(() => {
  popped.length = 0;
  throwOnPopup = false;
});

describe("app:share", () => {
  it("macOS 上弹分享菜单，整条链接原样交给它", () => {
    expect(shareUrl({ title: "评审", url }, window, "darwin")).toEqual({
      shared: true,
    });
    expect(popped).toEqual([{ urls: [url], window }]);
  });

  it("别的平台、坏请求、没有窗口、菜单弹不出：答 false，页面退回复制", () => {
    expect(shareUrl({ url }, window, "win32")).toEqual({ shared: false });
    expect(shareUrl({ url: "file:///x" }, window, "darwin")).toEqual({
      shared: false,
    });
    expect(shareUrl({ url }, null, "darwin")).toEqual({ shared: false });
    expect(popped).toEqual([]);
    throwOnPopup = true;
    expect(shareUrl({ url }, window, "darwin")).toEqual({ shared: false });
  });
});
