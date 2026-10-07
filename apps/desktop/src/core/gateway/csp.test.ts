import { describe, expect, it } from "vitest";
import {
  GATEWAY_API_HEADERS,
  GATEWAY_RESPONSE_HEADERS,
  contentSecurityPolicy,
  nativeAppContentSecurityPolicy,
  serverContentSecurityPolicy,
} from "./csp";

describe("服务器壳的 CSP", () => {
  it("与桌面壳同一个来源：指令集合逐条相同", () => {
    const desktop = contentSecurityPolicy()
      .split("; ")
      .map((directive) => directive.split(" ")[0]);
    const server = serverContentSecurityPolicy()
      .split("; ")
      .map((directive) => directive.split(" ")[0]);
    // 指令一条不多一条不少：桌面壳那边收紧什么，这边自动跟着收紧。
    expect(server).toEqual(desktop);
  });

  it("只摘掉回环授权", () => {
    const policy = serverContentSecurityPolicy();
    expect(policy).not.toContain("127.0.0.1");
    expect(policy).not.toContain("localhost");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("img-src 'self' data: blob:");
  });

  it("其余每一条逐字继承", () => {
    const policy = serverContentSecurityPolicy();
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
  });
});

describe("桌面壳的 CSP", () => {
  it("媒体票地址（§37.4）：图片与音视频可取本机 core 与按源追加的 https 来源，wss 不进", () => {
    const policy = contentSecurityPolicy({
      connect: ["https://relay.example:8443", "wss://relay.example:8443"],
    });
    const directive = (name: string) =>
      policy.split("; ").find((entry) => entry.startsWith(`${name} `)) ?? "";
    for (const name of ["media-src", "img-src"]) {
      expect(directive(name)).toContain("http://127.0.0.1:*");
      expect(directive(name)).toContain("https://relay.example:8443");
      expect(directive(name)).not.toContain("wss://");
    }
    expect(directive("media-src")).toContain("blob:");
    // 没有追加授权时只有回环。
    expect(contentSecurityPolicy()).toContain(
      "media-src 'self' blob: http://127.0.0.1:* http://localhost:*",
    );
  });
});

describe("原生 App（Capacitor）的 CSP", () => {
  it("指令集合与桌面壳相同，只多出连 Gateway 的 https / wss", () => {
    const names = (policy: string) =>
      policy.split("; ").map((directive) => directive.split(" ")[0]);
    const policy = nativeAppContentSecurityPolicy();
    expect(names(policy)).toEqual(names(contentSecurityPolicy()));
    expect(policy).toContain("connect-src 'self' https: wss:");
    expect(policy).toContain("img-src 'self' data: blob: https:");
    // 手机上的回环端口不是 Armadra；连接只走 TLS。
    expect(policy).not.toContain("127.0.0.1");
    expect(policy).not.toContain("localhost");
    const connect = policy
      .split("; ")
      .find((directive) => directive.startsWith("connect-src"));
    expect(connect).not.toMatch(/\shttp:|\sws:/);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
  });
});

describe("Gateway 的响应头", () => {
  it("每个答案都有 HSTS 与 nosniff；接口再加沙箱 CSP 与缺省不缓存", () => {
    expect(GATEWAY_RESPONSE_HEADERS["strict-transport-security"]).toMatch(
      /max-age=\d{8,}/,
    );
    expect(GATEWAY_RESPONSE_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(GATEWAY_API_HEADERS["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(GATEWAY_API_HEADERS["content-security-policy"]).toContain("sandbox");
    expect(GATEWAY_API_HEADERS["cache-control"]).toBe("no-store");
  });
});
