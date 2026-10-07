import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inject } from "vitest";

import { type OpenedDatabase, openDatabase } from "./open";

/**
 * A freshly migrated database for a test fixture, without running every
 * migration again for every test.
 *
 * The migrations run once per test run into a template file
 * (`testing/db-template.global.ts`; once per test file where a run has none);
 * each fixture
 * gets a byte copy of it and opens that the ordinary way — the preflight still
 * runs and finds every migration applied. On the Windows runner a fresh
 * migration costs ~140 ms per open (2–6 s under the load of the whole suite)
 * against ~10 ms for copy-and-open, and the collab suites open one per test:
 * their `beforeEach` kept crossing the 10 s hook timeout there.
 *
 * Tests about migrating itself (`db/*.test.ts`) keep calling `openDatabase`
 * on an empty file; this is only for fixtures that want "a database at the
 * current schema".
 */
const templates = new Map<string, string>();

export function openFreshDatabase(
  file: string,
  migrationsDir: string,
): OpenedDatabase {
  const template = templateFor(migrationsDir);
  if (template !== undefined) copyFileSync(template, file);
  const opened = openDatabase({ file, migrationsDir });
  // A fixture database is thrown away with its test: nothing in it has to
  // survive a power cut. With the default `synchronous` every commit is an
  // fsync, and on the Windows runner two commits measured 35 ms at the median
  // and over a second at the tail under the suite's I/O — a fixture plus its
  // nodes and links is a dozen commits. The same two commits with this off
  // measured 0 ms. Production connections are untouched (`db/open.ts`).
  opened.database.exec("PRAGMA synchronous = OFF");
  return opened;
}

function templateFor(migrationsDir: string): string | undefined {
  // The run-wide template from `testing/db-template.global.ts`, when this run
  // has one for these migrations.
  const shared = inject("armadraDbTemplate");
  if (
    shared != null &&
    resolve(shared.migrationsDir) === resolve(migrationsDir) &&
    existsSync(shared.file)
  )
    return shared.file;
  const known = templates.get(migrationsDir);
  if (known !== undefined && existsSync(known)) return known;
  const directory = mkdtempSync(join(tmpdir(), "armadra-db-template-"));
  const file = join(directory, "template.db");
  openDatabase({ file, migrationsDir }).close();
  process.once("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  // Closing the last connection checkpoints the WAL into the main file. If a
  // side file survived anyway, a copy of the main file alone would be missing
  // pages: fall back to migrating each fixture's own file.
  if (existsSync(`${file}-wal`) || existsSync(`${file}-shm`)) return undefined;
  templates.set(migrationsDir, file);
  return file;
}
