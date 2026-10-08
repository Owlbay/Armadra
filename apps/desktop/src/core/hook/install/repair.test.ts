import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isOwnCommand, repairIn, scanIn } from "./repair";
import { SKILLS_ROOT } from "./skills";
import { tempDir } from "../../testing/temp-dir";

function home(): string {
  return tempDir("armadra-repair-");
}

function readJson(path: string): Record<string, never> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, never>;
}

/**
 * The name this product had before it was Armadra. Nothing under it is
 * recognised any more: another tool may use it today, so entries that carry
 * it are treated as that tool's.
 */
const FORMER = "aicc";

/** Another tool that installs into the same CLI files. */
const OTHER_HOOK = "sh '/Users/dev/.othertool/agent-hooks/claude.sh'";

describe("recognising what is ours", () => {
  it("counts a command only when its program is our hook client", () => {
    expect(isOwnCommand("/opt/armadra/armadra-hook claude")).toBe(true);
    expect(isOwnCommand('"/a b/armadra-hook" codex')).toBe(true);
    expect(isOwnCommand("/repo/target/debug/armadra-hook claude")).toBe(true);
    expect(
      isOwnCommand(String.raw`C:\repo\target\debug\armadra-hook.exe claude`),
    ).toBe(true);
    expect(isOwnCommand("armadra-hook context-usage")).toBe(true);
    // Another tool's commands, however they are spelled.
    expect(isOwnCommand(OTHER_HOOK)).toBe(false);
    expect(isOwnCommand("~/.othertool/bin/hook codex")).toBe(false);
    expect(isOwnCommand("/repo/target/debug/othertool-hook claude")).toBe(
      false,
    );
    expect(isOwnCommand("sh '/x/armadra-hook/claude.sh'")).toBe(false);
    // A name this product never had today is not ours, whatever it looks like.
    expect(isOwnCommand(`/usr/local/bin/${FORMER}-hook claude`)).toBe(false);
    expect(isOwnCommand("/usr/local/bin/notify.sh")).toBe(false);
  });
});

describe("repairing an instruction file", () => {
  it("removes only the blocks we fenced", () => {
    const directory = home();
    const path = join(directory, "AGENTS.md");
    const text =
      "# Mine\n\nkeep this line\n\n" +
      "<!-- armadra:skills:start -->\nsh armadra-hook canvas list\n<!-- armadra:skills:end -->\n\n" +
      "<!-- othertool:manage-canvas:start -->\ntheirs\n<!-- othertool:manage-canvas:end -->\n\n" +
      "<!-- armadra:dangling:start -->\nno end marker\n";
    writeFileSync(path, text, "utf8");

    const found = scanIn("codex", directory);
    expect(found.map((one) => one.detail)).toEqual(["armadra:skills"]);

    const report = repairIn("codex", directory);
    const after = readFileSync(path, "utf8");
    expect(after, after).toContain("keep this line");
    expect(after, after).toContain(
      "<!-- othertool:manage-canvas:start -->\ntheirs\n<!-- othertool:manage-canvas:end -->",
    );
    expect(after, after).toContain("<!-- armadra:dangling:start -->");
    expect(after, after).not.toContain("armadra:skills");
    expect(after, after).not.toContain("\n\n\n");
    expect(JSON.stringify(report)).not.toContain("othertool:");
    expect(readFileSync(report.backup as string, "utf8")).toBe(text);
    expect(scanIn("codex", directory)).toEqual([]);
  });

  it("does not touch a file holding only another tool's blocks", () => {
    const directory = home();
    const path = join(directory, "AGENTS.md");
    const text =
      "<!-- othertool:get-context:start -->\ntheirs\n<!-- othertool:get-context:end -->\n";
    writeFileSync(path, text, "utf8");
    expect(scanIn("codex", directory)).toEqual([]);
    const report = repairIn("codex", directory);
    expect(report.removed).toEqual([]);
    expect(report.backups).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(directory)).toEqual(["AGENTS.md"]);
  });
});

/**
 * The shapes users actually reported, written here rather than read off a real
 * machine: a fixture that reads `~/.claude` would repair the developer's own
 * configuration the first time somebody ran the suite.
 */
function claudeFixture(): [string, string] {
  const directory = home();
  const path = join(directory, "settings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        model: "opus",
        statusLine: {
          type: "command",
          command: "/usr/local/bin/armadra-hook context-usage",
        },
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/usr/local/bin/armadra-hook claude",
                },
              ],
            },
            {
              hooks: [{ type: "command", command: "/usr/local/bin/notify.sh" }],
            },
            { hooks: [{ type: "command", command: OTHER_HOOK }] },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/Users/dev/src/target/debug/armadra-hook claude",
                },
              ],
            },
          ],
          SessionEnd: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/Users/dev/othertool/target/debug/othertool-hook",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return [directory, path];
}

describe("repairing a hook file", () => {
  it("backs a Claude file up and removes only our entries", () => {
    const [directory, path] = claudeFixture();
    const found = scanIn("claude", directory);
    expect(found, JSON.stringify(found)).toHaveLength(3);
    expect(found.some((one) => one.kind === "status_line")).toBe(true);
    expect(found.filter((one) => one.kind === "hook_entry")).toHaveLength(2);
    expect(JSON.stringify(found)).not.toContain("othertool");

    const report = repairIn("claude", directory);
    const backup = report.backup as string;
    expect(backup).toContain(".armadra-backup-");
    // The backup is the file as it was.
    expect(readFileSync(backup, "utf8")).toContain("armadra-hook");
    // Another tool's entries are neither removed nor reported.
    expect(JSON.stringify(report)).not.toContain("othertool");
    expect(JSON.stringify(report)).not.toContain("notify.sh");

    const settings = readJson(path) as unknown as {
      model: string;
      statusLine?: unknown;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.model).toBe("opus");
    expect(settings.statusLine).toBeUndefined();
    expect(
      settings.hooks.Stop?.map((group) => group.hooks[0]?.command),
    ).toEqual(["/usr/local/bin/notify.sh", OTHER_HOOK]);
    expect(settings.hooks.SessionStart).toBeUndefined();
    expect(settings.hooks.SessionEnd?.[0]?.hooks[0]?.command).toBe(
      "/Users/dev/othertool/target/debug/othertool-hook",
    );

    // Repairing twice finds nothing and writes no second backup.
    const again = repairIn("claude", directory);
    expect(again.found, JSON.stringify(again.found)).toHaveLength(0);
    expect(again.backup).toBeUndefined();
  });

  /**
   * The reported Codex failure: the top-level `version` our installer wrote
   * makes Codex reject the whole file, so nobody's hooks run.
   */
  it("drops the version key our Codex installer wrote, beside our entry", () => {
    const directory = home();
    const path = join(directory, "hooks.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          description: "hooks",
          hooks: {
            session_start: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "/usr/local/bin/armadra-hook codex",
                  },
                ],
              },
              { hooks: [{ type: "command", command: "/opt/audit.sh" }] },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const found = scanIn("codex", directory);
    expect(
      found.some(
        (one) => one.kind === "codex_unknown_key" && one.detail === "version",
      ),
    ).toBe(true);

    const report = repairIn("codex", directory);
    expect(report.backup).toBeDefined();
    const document = readJson(path) as unknown as {
      version?: unknown;
      description: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(document.version).toBeUndefined();
    expect(document.description).toBe("hooks");
    expect(document.hooks.session_start).toHaveLength(1);
    expect(document.hooks.session_start?.[0]?.hooks[0]?.command).toBe(
      "/opt/audit.sh",
    );
  });

  it("leaves a Codex file with no entry of ours exactly as it is", () => {
    const directory = home();
    const path = join(directory, "hooks.json");
    const text = JSON.stringify({
      version: 1,
      othertool: { enabled: true },
      hooks: { stop: [{ hooks: [{ type: "command", command: OTHER_HOOK }] }] },
    });
    writeFileSync(path, text, "utf8");
    expect(scanIn("codex", directory)).toEqual([]);
    const report = repairIn("codex", directory);
    expect(report.removed).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(directory)).toEqual(["hooks.json"]);
  });

  it("removes a Copilot file that was only ours and never touches another tool's", () => {
    const directory = home();
    const hooks = join(directory, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(
      join(hooks, "armadra.json"),
      JSON.stringify(
        {
          version: 1,
          hooks: {
            sessionStart: [
              {
                type: "command",
                exec: "/usr/local/bin/armadra-hook",
                args: ["copilot"],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const theirs = JSON.stringify(
      {
        version: 1,
        hooks: {
          sessionStart: [
            {
              type: "command",
              bash: "sh '/Users/dev/.othertool/agent-hooks/copilot.sh'",
            },
            { type: "command", exec: "/opt/mine.sh" },
          ],
        },
      },
      null,
      2,
    );
    writeFileSync(join(hooks, "othertool-status.json"), theirs, "utf8");

    expect(scanIn("copilot", directory)).toHaveLength(1);
    const report = repairIn("copilot", directory);
    expect(existsSync(join(hooks, "armadra.json"))).toBe(false);
    expect(readFileSync(join(hooks, "othertool-status.json"), "utf8")).toBe(
      theirs,
    );
    expect(
      readdirSync(hooks).filter((name) => name.startsWith("othertool")),
    ).toEqual(["othertool-status.json"]);
    expect(report.backups, JSON.stringify(report.backups)).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("othertool");
  });

  it("never rewrites a file it cannot parse", () => {
    const directory = home();
    const path = join(directory, "settings.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(scanIn("claude", directory)).toHaveLength(0);
    const report = repairIn("claude", directory);
    expect(report.removed).toHaveLength(0);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});

describe("repairing skills and generated modules", () => {
  it("removes our skill directories by signature and nothing else", () => {
    const directory = home();
    const root = join(directory, SKILLS_ROOT);
    const skill = (name: string, body: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), body, "utf8");
    };
    skill(
      "armadra-canvas",
      "---\nname: armadra-canvas\n---\narmadra-hook canvas list\n",
    );
    skill(
      "armadra",
      "---\nname: armadra\n---\n<!-- armadra:skill-revision 9 -->\n",
    );
    // Another tool's skills, and one of our names without our signature.
    skill("othertool-canvas", "---\nname: othertool-canvas\n---\n");
    skill("othertool-linked-context", "sh othertool.sh context\n");
    skill("armadra-linked-context", "---\nname: armadra-linked-context\n---\n");
    // Something of the user's, in a directory that is otherwise ours.
    writeFileSync(join(root, "armadra-canvas", "notes.md"), "mine", "utf8");

    const found = scanIn("claude", directory);
    expect(
      found
        .filter((one) => one.kind === "skill_dir")
        .map((one) => one.detail)
        .sort(),
    ).toEqual(["armadra", "armadra-canvas"]);

    const report = repairIn("claude", directory);
    expect(existsSync(join(root, "armadra"))).toBe(false);
    expect(existsSync(join(root, "armadra-canvas", "SKILL.md"))).toBe(false);
    expect(readFileSync(join(root, "armadra-canvas", "notes.md"), "utf8")).toBe(
      "mine",
    );
    expect(report.kept.some((entry) => entry.includes("armadra-canvas"))).toBe(
      true,
    );
    for (const name of [
      "othertool-canvas",
      "othertool-linked-context",
      "armadra-linked-context",
    ]) {
      expect(statSync(join(root, name, "SKILL.md")).isFile(), name).toBe(true);
    }
    expect(JSON.stringify(report)).not.toContain("othertool");
  });

  it("deletes a generated module of ours and not a stranger's", () => {
    const directory = home();
    const extensions = join(directory, "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(
      join(extensions, "armadra-status.ts"),
      'const CLIENT = "/usr/local/bin/armadra-hook";\n',
      "utf8",
    );
    writeFileSync(
      join(extensions, "othertool-status.ts"),
      'const HOOK = "/Users/dev/.othertool/agent-hooks/pi.sh";\n',
      "utf8",
    );

    expect(scanIn("pi", directory)).toHaveLength(1);
    repairIn("pi", directory);
    expect(existsSync(join(extensions, "armadra-status.ts"))).toBe(false);
    expect(statSync(join(extensions, "othertool-status.ts")).isFile()).toBe(
      true,
    );
  });
});

/**
 * Entries under the old product name, as a stranger would write them today:
 * not listed, not rewritten, not deleted, not backed up — for every CLI, in
 * every place a scan looks.
 */
describe("entries under the former name", () => {
  function snapshot(root: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        if (statSync(path).isDirectory()) walk(path);
        else out[path] = readFileSync(path, "utf8");
      }
    };
    walk(root);
    return out;
  }

  function write(path: string, text: string) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
  }

  it("are neither shown nor changed, wherever they sit", () => {
    const client = `/usr/local/bin/${FORMER}-hook`;
    const grouped = (event: string, agent: string) =>
      JSON.stringify(
        {
          version: 1,
          statusLine: { type: "command", command: `${client} context-usage` },
          hooks: {
            [event]: [
              { hooks: [{ type: "command", command: `${client} ${agent}` }] },
            ],
          },
        },
        null,
        2,
      );
    const block =
      "# Mine\n\n" +
      `<!-- ${FORMER}:skills:start -->\n${client} canvas list\n<!-- ${FORMER}:skills:end -->\n`;
    const skillBody = (name: string) =>
      `---\nname: ${name}\n---\n${client} canvas list\n<!-- armadra:skill-revision 9 -->\n`;

    for (const agentId of [
      "claude",
      "codex",
      "opencode",
      "pi",
      "omp",
      "copilot",
    ]) {
      const directory = home();
      if (agentId === "claude") {
        write(join(directory, "settings.json"), grouped("Stop", agentId));
        write(join(directory, "CLAUDE.md"), block);
      }
      if (agentId === "codex") {
        write(join(directory, "hooks.json"), grouped("stop", agentId));
      }
      if (agentId === "copilot") {
        write(
          join(directory, "hooks", `${FORMER}.json`),
          JSON.stringify({
            version: 1,
            hooks: { sessionStart: [{ type: "command", exec: client }] },
          }),
        );
        // A file of another tool's that calls our client is still theirs.
        write(
          join(directory, "hooks", "othertool.json"),
          JSON.stringify({
            version: 1,
            hooks: {
              sessionStart: [{ type: "command", exec: "/opt/armadra-hook" }],
            },
          }),
        );
      }
      const modules = {
        opencode: "plugins",
        pi: "extensions",
        omp: "extensions",
      }[agentId as "opencode"];
      if (modules !== undefined) {
        write(
          join(directory, modules, `${FORMER}-status.ts`),
          `const CLIENT = "${client}";\n`,
        );
        write(
          join(directory, modules, "othertool-status.js"),
          'const CLIENT = "/opt/armadra-hook";\n',
        );
      }
      write(join(directory, "AGENTS.md"), block);
      for (const name of [`${FORMER}-canvas`, `${FORMER}-linked-context`]) {
        write(join(directory, SKILLS_ROOT, name, "SKILL.md"), skillBody(name));
      }

      const before = snapshot(directory);
      expect(scanIn(agentId, directory), agentId).toEqual([]);
      const report = repairIn(agentId, directory);
      expect(report.found, agentId).toEqual([]);
      expect(report.removed, agentId).toEqual([]);
      expect(report.kept, agentId).toEqual([]);
      expect(report.backups, agentId).toEqual([]);
      expect(snapshot(directory), agentId).toEqual(before);
    }
  });
});
