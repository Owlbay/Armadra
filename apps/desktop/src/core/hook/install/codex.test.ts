import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configPath, hooksPath, uninstall } from "./codex";
import { stateKeys } from "./toml-state";
import { tempDir } from "../../testing/temp-dir";

function home(): string {
  return tempDir("armadra-codex-");
}

function readHooks(path: string): {
  hooks?: Record<string, { hooks: { command: string }[] }[]>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    hooks?: Record<string, { hooks: { command: string }[] }[]>;
  };
}

describe("removing the old global Codex install", () => {
  it("takes out our handlers and their trust, and keeps the user's", () => {
    const directory = home();
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      hooksPath(directory),
      JSON.stringify({
        version: 1,
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "/usr/local/bin/theirs.sh" }],
            },
            {
              hooks: [
                { type: "command", command: "/opt/armadra/armadra-hook codex" },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                { type: "command", command: "/opt/armadra/armadra-hook codex" },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    const source = realpathSync(hooksPath(directory));
    // 键是 TOML 基本字符串，要像 Codex 写的那样转义：Windows 路径里的 `\U`、`\A`
    // 原样写进去就成了转义序列，读回来已经不是这个路径。
    const header = (key: string) => `[hooks.state.${JSON.stringify(key)}]`;
    writeFileSync(
      configPath(directory),
      [
        "# my config",
        'model = "gpt-5"',
        "",
        header(`${source}:stop:0:0`),
        'trusted_hash = "sha256:theirs"',
        "",
        header(`${source}:stop:1:0`),
        "enabled = true",
        'trusted_hash = "sha256:ours"',
        "",
        header(`${source}:session_start:0:0`),
        "enabled = true",
        'trusted_hash = "sha256:ours"',
        "",
      ].join("\n"),
      "utf8",
    );

    uninstall(directory);

    const hooks = readHooks(hooksPath(directory));
    expect(Object.keys(hooks.hooks ?? {})).toEqual(["Stop"]);
    expect(hooks.hooks?.Stop).toHaveLength(1);
    expect(hooks.hooks?.Stop?.[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/theirs.sh",
    );
    // A top-level key Codex would reject is dropped on the way.
    expect(readFileSync(hooksPath(directory), "utf8")).not.toContain("version");
    const config = readFileSync(configPath(directory), "utf8");
    expect(config).toContain("# my config");
    expect(stateKeys(config)).toEqual([`${source}:stop:0:0`]);
  });

  it("is not an error when there was never an install", () => {
    const directory = home();
    expect(() => uninstall(directory)).not.toThrow();
  });
});
