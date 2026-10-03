import { describe, expect, it } from "vitest";
import { gatewayPairingPayloadSchema } from "@armadra/shared";

import { encodeQr, pairingQrText, parsePairingQr, qrPath } from "./qr";

const FP = "5f1c".padEnd(64, "0");
const TICKET =
  "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOpQrStUvWxYz012345678";

const payload = gatewayPairingPayloadSchema.parse({
  origin: "https://192.168.1.20:8443",
  ticket: TICKET,
  fingerprint: FP,
  expiresAt: "2026-10-03T08:02:00.000Z",
  webUrl: `https://192.168.1.20:8443/#pair=${TICKET}&fp=${FP}`,
  deepLink: `armadra://pair?host=192.168.1.20%3A8443&ticket=${TICKET}&fp=${FP}`,
});

/** 三个定位图形：7×7 外框深、内圈浅、3×3 实心。 */
function finderAt(modules: boolean[][], left: number, top: number): boolean {
  for (let dy = 0; dy < 7; dy += 1) {
    for (let dx = 0; dx < 7; dx += 1) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (modules[top + dy]![left + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe("encodeQr", () => {
  it("encodes a full pairing link, which the old version-6 encoder could not hold", () => {
    const text = pairingQrText(payload);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(134);
    const code = encodeQr(text);
    expect(code).not.toBeNull();
    // 版本 v 的边长是 17 + 4v。
    expect((code!.size - 17) % 4).toBe(0);
    expect(code!.modules).toHaveLength(code!.size);
    expect(finderAt(code!.modules, 0, 0)).toBe(true);
    expect(finderAt(code!.modules, code!.size - 7, 0)).toBe(true);
    expect(finderAt(code!.modules, 0, code!.size - 7)).toBe(true);
  });

  it("is deterministic and empty text has no code", () => {
    const text = pairingQrText(payload, "app");
    expect(qrPath(encodeQr(text)!)).toBe(qrPath(encodeQr(text)!));
    expect(encodeQr("")).toBeNull();
  });

  it("merges a row of dark modules into one path segment", () => {
    const path = qrPath({
      size: 3,
      modules: [
        [true, true, false],
        [false, false, false],
        [false, true, true],
      ],
    });
    expect(path).toBe("M0 0h2v1h-2zM1 2h2v1h-2z");
  });
});

describe("pairing QR payload", () => {
  it("phones' cameras get the web link, the app scanner the deep link", () => {
    expect(pairingQrText(payload)).toBe(payload.webUrl);
    expect(pairingQrText(payload, "app")).toBe(payload.deepLink);
  });

  it("reads both shapes back to the same pairing", () => {
    const expected = {
      origin: "https://192.168.1.20:8443",
      ticket: TICKET,
      fingerprint: FP,
    };
    expect(parsePairingQr(payload.webUrl)).toEqual(expected);
    expect(parsePairingQr(payload.deepLink)).toEqual(expected);
    // 服务器壳打印的链接没有指纹。
    expect(parsePairingQr(`https://mac.local:8443/#pair=${TICKET}`)).toEqual({
      origin: "https://mac.local:8443",
      ticket: TICKET,
      fingerprint: "",
    });
  });

  it("refuses anything else instead of guessing", () => {
    for (const text of [
      "",
      "not a url",
      `http://192.168.1.20:8443/#pair=${TICKET}`,
      `https://192.168.1.20:8443/other#pair=${TICKET}`,
      `https://192.168.1.20:8443/#pair=${TICKET}&fp=XYZ`,
      `armadra://pair?host=192.168.1.20%3A8443&ticket=${TICKET}`,
      `armadra://pair?host=a/b&ticket=${TICKET}&fp=${FP}`,
      `armadra://other?host=h%3A1&ticket=${TICKET}&fp=${FP}`,
    ]) {
      expect(parsePairingQr(text), text).toBeNull();
    }
  });
});
