import { describe, expect, it } from "vitest";

import { scrubReport, scrubText, stackFileNames } from "./crash-scrub";

/**
 * 页面这一侧的剥离（契约 §30）。与 core 那份逐条一致由桌面的
 * `core/diagnostics/client-report.test.ts` 对照；这里钉住页面最常见的几种输入。
 */

describe("crash-scrub", () => {
  it("路径里的用户名、令牌、地址的账号 / 查询 / 片段", () => {
    expect(
      scrubText(
        "read /Users/alice/proj/.env with ghp_abcdefghijklmnopqrstuvwxyz0123 via https://u:p@h.test/a?k=v#pair=t",
      ),
    ).toBe(
      "read /Users/~/proj/.env with [redacted] via https://[redacted]@h.test/a?[redacted]#[redacted]",
    );
  });

  it("Armadra 会话密钥形状", () => {
    const token = `${"9a".repeat(16)}.${"B".repeat(43)}`;
    expect(scrubText(`Bearer-less ${token}`)).toBe("Bearer-less [redacted]");
  });

  it("栈只留文件名，消息截断", () => {
    expect(
      stackFileNames(
        "Error: x\n    at f (https://gw.test:8443/assets/index-1.js?x=1:2:3)",
      ),
    ).toBe("Error: x\n    at f (index-1.js:2:3)");
    const report = scrubReport({
      kind: "rejection",
      name: "",
      message: "m".repeat(500),
      stack: "",
    });
    expect(report.name).toBe("Error");
    expect(report.message).toHaveLength(301);
  });
});
