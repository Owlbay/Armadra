import { describe, expect, it } from "vitest";

import { nativeShareAvailable, shareRequest } from "./share-request";

describe("系统分享面板收的请求", () => {
  it("收 http / https，整条链接（含 # 片段）原样保留，标题截短", () => {
    const url = "https://relay.example/j/abc#secret.invite";
    expect(shareRequest({ title: "评审", url })).toEqual({
      title: "评审",
      url,
    });
    expect(
      shareRequest({ title: "x".repeat(300), url: "http://127.0.0.1:8131/j/a" })
        ?.title,
    ).toHaveLength(256);
    expect(shareRequest({ url })).toEqual({ title: "", url });
  });

  it("别的协议、带账号口令、过长、不是对象的一律不收", () => {
    for (const value of [
      null,
      "https://a.example",
      { url: "file:///etc/passwd" },
      { url: "javascript:alert(1)" },
      { url: "armadra://join?link=a" },
      { url: "https://user:pw@a.example/j/a" },
      { url: `https://a.example/${"x".repeat(4100)}` },
      { url: "not a url" },
      { url: 42 },
    ]) {
      expect(shareRequest(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("系统分享菜单只在 macOS", () => {
    expect(nativeShareAvailable("darwin")).toBe(true);
    expect(nativeShareAvailable("win32")).toBe(false);
    expect(nativeShareAvailable("linux")).toBe(false);
  });
});
