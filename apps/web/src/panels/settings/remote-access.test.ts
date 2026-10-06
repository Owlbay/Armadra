import { describe, expect, it } from "vitest";

import { type AccessFacts, remoteAccessOf, sameOrigin } from "./remote-access";

const base: AccessFacts = {
  desktop: false,
  hostedIssuer: null,
  nativeApp: false,
  viaServerShell: false,
  localHttpBase: "http://127.0.0.1:43120",
  currentKind: "local",
  currentSourceId: "local",
};

describe("设置作用的 core 在不在眼前", () => {
  it("桌面窗口与开发服务器：本机", () => {
    expect(remoteAccessOf({ ...base, desktop: true })).toEqual({
      remote: false,
      via: null,
      relayIssuer: null,
      currentSourceId: "local",
    });
    expect(remoteAccessOf(base).remote).toBe(false);
  });

  it("桌面窗口里当前源是挂载的远程源：远端，但页面自己没走隧道", () => {
    const access = remoteAccessOf({
      ...base,
      desktop: true,
      currentKind: "relayed",
      currentSourceId: "s1",
    });
    expect(access).toEqual({
      remote: true,
      via: null,
      relayIssuer: null,
      currentSourceId: "s1",
    });
  });

  it("中继托管的页面：经中继，隧道就是签发方", () => {
    const access = remoteAccessOf({
      ...base,
      hostedIssuer: "https://relay.example/",
      // 页面来源是 HTTPS，托管前也会被认成同源托管；中继优先。
      viaServerShell: true,
      localHttpBase: "https://relay.example/s/abc",
    });
    expect(access.remote).toBe(true);
    expect(access.via).toBe("relayed");
    expect(access.relayIssuer).toBe("https://relay.example");
  });

  it("原生 App：地址在 /s/<源> 下是经中继，否则直连 Gateway", () => {
    expect(
      remoteAccessOf({
        ...base,
        nativeApp: true,
        localHttpBase: "https://relay.example:8443/s/abc",
      }),
    ).toMatchObject({
      remote: true,
      via: "relayed",
      relayIssuer: "https://relay.example:8443",
    });
    expect(
      remoteAccessOf({
        ...base,
        nativeApp: true,
        localHttpBase: "https://mac.local:8443",
      }),
    ).toMatchObject({ remote: true, via: "direct", relayIssuer: null });
  });

  it("经 Gateway / 服务器壳同源打开的网页：直连远端", () => {
    expect(
      remoteAccessOf({
        ...base,
        viaServerShell: true,
        localHttpBase: "https://mac.local:8443",
      }),
    ).toMatchObject({ remote: true, via: "direct", relayIssuer: null });
  });

  it("来源比较不计尾斜杠与缺省端口；空的、坏的不相等", () => {
    expect(
      sameOrigin("https://relay.test:8102", "https://relay.test:8102/"),
    ).toBe(true);
    expect(sameOrigin("https://relay.test:443", "https://relay.test")).toBe(
      true,
    );
    expect(sameOrigin("https://relay.test", "https://other.test")).toBe(false);
    expect(sameOrigin("https://relay.test", null)).toBe(false);
    expect(sameOrigin("not a url", "not a url")).toBe(false);
  });
});
