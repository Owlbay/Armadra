import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationDir } from "./inject";
import {
  type MigrationRecord,
  migrateGlobalInstalls,
  migrationPath,
  readMigration,
} from "./migrate";
import { tempDir } from "../../testing/temp-dir";

const OURS = "/opt/armadra/bin/armadra-hook";
const SKILL =
  "---\nname: armadra\n---\nbody\n<!-- armadra:skill-revision 11 -->\n";

function put(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every file under `root`, relative path → bytes. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return files;
}

/**
 * A home carrying an old global install of ours beside another tool's hooks,
 * skills and instruction blocks.
 */
function oldMachine(): { home: string; dataDir: string } {
  const root = tempDir("armadra-migrate-");
  const home = join(root, "home");
  put(
    join(home, ".claude", "settings.json"),
    json({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: `${OURS} claude` }] },
          {
            hooks: [
              {
                type: "command",
                command: "sh '/Users/dev/.othertool/agent-hooks/claude.sh'",
              },
            ],
          },
        ],
      },
    }),
  );
  put(join(home, ".claude", "skills", "armadra", "SKILL.md"), SKILL);
  put(
    join(home, ".claude", "skills", "othertool-linked-context", "SKILL.md"),
    "---\nname: othertool-linked-context\n---\n",
  );
  put(
    join(home, ".codex", "hooks.json"),
    json({ version: 1, hooks: { Stop: [{ hooks: [{ command: OURS }] }] } }),
  );
  put(
    join(home, ".codex", "config.toml"),
    '[hooks.state."/<session-flags>/config.toml:stop:0:0"]\nenabled = true\n',
  );
  put(
    join(home, ".copilot", "hooks", "othertool-status.json"),
    json({
      version: 1,
      hooks: {
        sessionStart: [{ type: "command", bash: "sh ~/.othertool/c.sh" }],
      },
    }),
  );
  put(
    join(home, ".config", "opencode", "AGENTS.md"),
    "<!-- othertool:manage-canvas:start -->\nx\n<!-- othertool:manage-canvas:end -->\n",
  );
  return { home, dataDir: join(root, "data") };
}

describe("the start-up migration", () => {
  it("changes nothing under the user's home, ours or anyone else's", () => {
    const { home, dataDir } = oldMachine();
    const before = snapshot(home);
    const record = migrateGlobalInstalls({
      dataDir,
      now: () => new Date("2026-10-08T01:02:03Z"),
    });
    expect(snapshot(home)).toEqual(before);
    expect(record).toEqual({
      version: 3,
      migratedAt: "2026-10-08T01:02:03.000Z",
      agents: {},
    });
    expect(readMigration(dataDir)).toEqual(record);
  });

  it("removes the old installer's marker from our own data directory", () => {
    const { dataDir } = oldMachine();
    const marker = join(integrationDir(dataDir, "claude"), "installed.json");
    put(marker, "{}\n");
    migrateGlobalInstalls({ dataDir });
    expect(existsSync(marker)).toBe(false);
  });

  it("does not run twice", () => {
    const { dataDir } = oldMachine();
    const first = migrateGlobalInstalls({ dataDir });
    const marker = join(integrationDir(dataDir, "pi"), "installed.json");
    put(marker, "{}\n");
    expect(migrateGlobalInstalls({ dataDir })).toEqual(first);
    expect(existsSync(marker)).toBe(true);
  });

  it("answers an earlier build's record as it is", () => {
    const { home, dataDir } = oldMachine();
    const v1: MigrationRecord = {
      version: 1,
      migratedAt: "2026-09-26T00:00:00.000Z",
      agents: {
        codex: {
          removed: ["/somewhere/hooks.json: armadra-hook"],
          backups: [],
        },
      },
    };
    put(migrationPath(dataDir), json(v1));
    const before = snapshot(home);
    expect(migrateGlobalInstalls({ dataDir })).toEqual(v1);
    expect(readMigration(dataDir)).toEqual(v1);
    expect(snapshot(home)).toEqual(before);
  });
});
