import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrationsDir } from "../agent/fixture";
import { openFreshDatabase } from "./fresh.fixture";
import { openDatabase } from "./open";

/** A copied template has to be the same database a fresh migration makes. */
describe("a fixture database from the template", () => {
  const directories: string[] = [];
  const scratch = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "armadra-fresh-"));
    directories.push(directory);
    return directory;
  };
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  const schema = (
    file: string,
    open: (file: string) => ReturnType<typeof openDatabase>,
  ) => {
    const opened = open(file);
    const rows = opened.database
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const applied = opened.database
      .prepare("SELECT version FROM _sqlx_migrations ORDER BY version")
      .all();
    opened.close();
    return { rows, applied };
  };

  it("has the schema and ledger a fresh migration gives", () => {
    const dir = migrationsDir();
    const fresh = schema(join(scratch(), "a.db"), (file) =>
      openDatabase({ file, migrationsDir: dir }),
    );
    const copied = schema(join(scratch(), "b.db"), (file) =>
      openFreshDatabase(file, dir),
    );
    expect(copied).toEqual(fresh);
  });

  it("gives every fixture a database of its own", () => {
    const dir = migrationsDir();
    const one = openFreshDatabase(join(scratch(), "one.db"), dir);
    const two = openFreshDatabase(join(scratch(), "two.db"), dir);
    one.database.exec("CREATE TABLE only_in_one (x INTEGER)");
    const seen = two.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'only_in_one'")
      .all();
    expect(seen).toEqual([]);
    one.close();
    two.close();
  });
});
