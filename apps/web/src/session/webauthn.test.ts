import { describe, expect, it } from "vitest";

import { fromBase64url, toBase64url, webauthnCancelled } from "./webauthn";

describe("webauthn 的 JSON 转换", () => {
  it("base64url 往返，不带填充", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1, 2]);
    const text = toBase64url(bytes.buffer);
    expect(text).toBe("APv_Pj8BAg");
    expect([...new Uint8Array(fromBase64url(text))]).toEqual([...bytes]);
  });

  it("取消与超时不算错误", () => {
    expect(webauthnCancelled(new DOMException("x", "NotAllowedError"))).toBe(
      true,
    );
    expect(webauthnCancelled(new DOMException("x", "AbortError"))).toBe(true);
    expect(webauthnCancelled(new DOMException("x", "SecurityError"))).toBe(
      false,
    );
    expect(webauthnCancelled(new Error("x"))).toBe(false);
  });
});
