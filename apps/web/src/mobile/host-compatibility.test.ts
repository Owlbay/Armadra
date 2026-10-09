import { describe, expect, it } from "vitest";

import {
  formatProtocol,
  hostCompatibility,
  MINIMUM_HOST_PROTOCOL,
} from "./host-compatibility";

describe("App 与主机的兼容只看协议", () => {
  const minimum = { major: 1, minor: 14 };

  it("同一 major、minor 够就能用，主机更新的 minor 也行", () => {
    expect(hostCompatibility({ major: 1, minor: 14 }, minimum)).toBe(
      "compatible",
    );
    expect(hostCompatibility({ major: 1, minor: 26 }, minimum)).toBe(
      "compatible",
    );
  });

  it("minor 不够或 major 更小：更新主机", () => {
    expect(hostCompatibility({ major: 1, minor: 13 }, minimum)).toBe(
      "updateHost",
    );
    expect(hostCompatibility({ major: 0, minor: 0 }, minimum)).toBe("unknown");
    expect(
      hostCompatibility({ major: 1, minor: 99 }, { major: 2, minor: 0 }),
    ).toBe("updateHost");
  });

  it("主机的 major 更新：更新 App", () => {
    expect(hostCompatibility({ major: 2, minor: 0 }, minimum)).toBe(
      "updateApp",
    );
  });

  it("没问到是 unknown", () => {
    expect(hostCompatibility(null, minimum)).toBe("unknown");
    expect(hostCompatibility(undefined, minimum)).toBe("unknown");
  });

  it("已发布的主机（0.2.0 起协议 1.18）都兼容缺省要求", () => {
    expect(hostCompatibility({ major: 1, minor: 18 })).toBe("compatible");
    expect(formatProtocol(MINIMUM_HOST_PROTOCOL)).toBe("1.14");
  });
});
