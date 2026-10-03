import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readMasterKey, rotateMasterKey } from "../../desktop/src/core/secrets";
import { MASTER_KEY_ENV, masterKeyFile, serverSecrets } from "./secrets";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "armadra-server-secrets-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("服务器壳的密钥后端", () => {
  it("首启在数据目录里生成 0600 的 master key，条目加密", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, {});
    expect(backend.kind).toBe("file-encrypted");
    const key = join(dir, "secrets", "master.key");
    expect(existsSync(key)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(key).mode & 0o777).toBe(0o600);
    }
    await backend.set("armadra-copilot", "gho_server_token");
    const raw = readFileSync(
      join(dir, "secrets", "armadra-copilot.sealed"),
      "utf8",
    );
    expect(raw).not.toContain("gho_server_token");
    // 重启：同一把钥匙，读得回来。
    expect(await serverSecrets(dir, {}).get("armadra-copilot")).toBe(
      "gho_server_token",
    );
  });

  it(`${MASTER_KEY_ENV} 指到别处：缺了就拒绝启动，不另生成`, () => {
    const dir = dataDir();
    const elsewhere = join(dir, "credentials", "master.key");
    const env = { [MASTER_KEY_ENV]: elsewhere };
    expect(masterKeyFile(dir, env)).toEqual({
      path: elsewhere,
      configured: true,
    });
    expect(() => serverSecrets(dir, env)).toThrow();
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("轮换之后服务器后端照样读得回来", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, {});
    await backend.set("armadra-a", "value-a");
    const keyFile = join(dir, "secrets", "master.key");
    const before = readMasterKey(keyFile);
    expect(rotateMasterKey({ directory: join(dir, "secrets"), keyFile })).toBe(
      1,
    );
    expect(readMasterKey(keyFile)?.equals(before!)).toBe(false);
    expect(await serverSecrets(dir, {}).get("armadra-a")).toBe("value-a");
  });

  it("ARMADRA_SECRET_BACKEND=file 强制明文 0600，不生成钥匙", async () => {
    const dir = dataDir();
    const backend = serverSecrets(dir, { ARMADRA_SECRET_BACKEND: "file" });
    expect(backend.kind).toBe("file");
    await backend.set("armadra-a", "plain");
    expect(existsSync(join(dir, "secrets", "master.key"))).toBe(false);
    expect(readFileSync(join(dir, "secrets", "armadra-a.token"), "utf8")).toBe(
      "plain",
    );
  });
});
