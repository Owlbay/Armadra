import { describe, expect, it } from "vitest";

import {
  configuredHostName,
  effectiveHostName,
  systemHostName,
} from "./host-name";

describe("主机名称（契约 §61）", () => {
  it("设置里的优先，没设是系统主机名", () => {
    expect(effectiveHostName({ host: { name: "书房" } }, "mbp")).toBe("书房");
    expect(effectiveHostName({ host: { name: "  " } }, "mbp")).toBe("mbp");
    expect(effectiveHostName({}, "mbp")).toBe("mbp");
    expect(effectiveHostName(undefined, "mbp")).toBe("mbp");
    expect(configuredHostName({ host: "x" })).toBe("");
  });

  it("系统主机名取不到时是 Armadra，超长截到 128", () => {
    expect(systemHostName("  ")).toBe("Armadra");
    expect(systemHostName("x".repeat(200))).toHaveLength(128);
  });
});
