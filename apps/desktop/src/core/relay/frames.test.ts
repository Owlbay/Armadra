import { describe, expect, it } from "vitest";

import {
  listFixtures,
  readFixture,
  splitSequence,
} from "@armadra/platform-protocol/fixtures";
import { decodeFrame, encodeFrame } from "@armadra/platform-protocol/tunnel";

/**
 * 协议包的隧道黄金字节在 core 这一侧也跑一遍（契约 §32）：守住钉住的协议包版本——
 * core 解出来再编回去必须逐字节相同，帧序列里的每一帧同样。
 */

describe("隧道帧黄金字节", () => {
  const names = listFixtures("tunnel").filter((name) => name.endsWith(".bin"));

  it("夹具齐全", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "tunnel/open-http.bin",
        "tunnel/data-64k.bin",
        "tunnel/goaway.bin",
        "tunnel/sequence-http-roundtrip.bin",
      ]),
    );
  });

  for (const name of names) {
    it(`${name} 解码再编码逐字节相同`, () => {
      const bytes = readFixture(name);
      const frames = name.includes("sequence-")
        ? splitSequence(bytes)
        : [bytes];
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(Buffer.from(encodeFrame(decodeFrame(frame)))).toEqual(
          Buffer.from(frame),
        );
      }
    });
  }
});
