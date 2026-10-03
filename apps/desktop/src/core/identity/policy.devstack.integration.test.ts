/**
 * 泄露检查对 dev-stack 的 `hibp` 容器（`pnpm dev-stack up hibp`，端口见
 * `tools/dev-stack/services.mjs`）跑一遍：与进程内 fixture 是同一份代码，这里
 * 验的是容器里那份也按真服务的形状答（带填充、CRLF、次数）。
 *
 * `ARMADRA_DEV_STACK=1` 才跑；否则 skipped。地址可用 `ARMADRA_HIBP_BASE` 换。
 */

import { describe, expect, it } from "vitest";
import { checkBreach } from "./policy";

const enabled = process.env.ARMADRA_DEV_STACK === "1";
const base = process.env.ARMADRA_HIBP_BASE?.trim() || "http://127.0.0.1:8092";

describe.skipIf(!enabled)("dev-stack：hibp（§18.1）", () => {
  it("夹具口令命中、别的不命中", async () => {
    for (const password of ["password", "123456", "armadra-pwned-fixture"]) {
      await expect(
        checkBreach(password, { mode: "block", base }),
        password,
      ).resolves.toBe("breached");
    }
    await expect(
      checkBreach("a distinctly unbreached phrase 42", { mode: "warn", base }),
    ).resolves.toBe("clean");
  });
});
