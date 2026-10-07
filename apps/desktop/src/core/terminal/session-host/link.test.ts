import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { currentSid, systemWhoami } from "./link";

/**
 * The SID behind the session host's pipe name comes from Windows' own
 * `whoami.exe`. A bare `whoami` found Git for Windows' GNU one first on a
 * GitHub Actions bash step (`extra operand '/user'`), and the core could not
 * reach any session host.
 */
describe("this user's SID", () => {
  const scrap: (() => void)[] = [];
  afterEach(() => {
    for (const undo of scrap.splice(0).reverse()) undo();
  });

  it("names whoami.exe under the system root, not whatever PATH finds", () => {
    expect(systemWhoami({ SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\whoami.exe",
    );
    expect(systemWhoami({ windir: "E:\\W" })).toBe(
      "E:\\W\\System32\\whoami.exe",
    );
    expect(systemWhoami({})).toBe("C:\\Windows\\System32\\whoami.exe");
  });

  it.runIf(process.platform === "win32")(
    "is read even with another whoami first on PATH",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "armadra-whoami-"));
      writeFileSync(
        join(directory, "whoami.cmd"),
        "@echo whoami: extra operand '/user'\r\n@exit /b 1\r\n",
      );
      writeFileSync(join(directory, "whoami.exe"), "not a program");
      const path = process.env.PATH;
      process.env.PATH = `${directory}${delimiter}${path ?? ""}`;
      scrap.push(() => {
        process.env.PATH = path;
        rmSync(directory, { recursive: true, force: true });
      });
      expect(currentSid()).toMatch(/^S-1-5-/);
    },
  );
});
