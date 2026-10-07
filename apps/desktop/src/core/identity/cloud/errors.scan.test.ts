import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ERRORS } from "@armadra/platform-protocol/errors";
import { ERROR_CODES } from "@armadra/shared";

/**
 * 协议包设计 §7：`core/identity/cloud/` 源码里给出的每个码都在协议包的错误码注册表
 * 里，而且 core 的注册表给它的 HTTP 状态与协议包相同——两仓读同一张表。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("云登录域的错误码", () => {
  it('fail("…") 的码都在协议包注册表里，状态一致', () => {
    const found = new Set<string>();
    for (const name of readdirSync(HERE)) {
      if (
        !name.endsWith(".ts") ||
        name.includes(".test.") ||
        name.includes(".fixture.")
      ) {
        continue;
      }
      const source = readFileSync(join(HERE, name), "utf8");
      for (const match of source.matchAll(/\bfail\(\s*"([a-z0-9_]+)"/g)) {
        found.add(match[1] as string);
      }
    }
    expect(found.size).toBeGreaterThan(8);
    const protocol = ERRORS as Record<string, { status: number }>;
    const core = ERROR_CODES as Record<string, { status: number }>;
    for (const code of found) {
      expect(protocol[code], code).toBeDefined();
      expect(core[code]?.status, code).toBe(protocol[code]?.status);
    }
  });
});
