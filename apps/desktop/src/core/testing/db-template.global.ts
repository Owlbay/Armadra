import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

import { openDatabase } from "../db/open";

/**
 * The migrated template every fixture database is copied from, built ONCE per
 * test run (vitest `globalSetup`) instead of once per test file.
 *
 * Every test file is its own module graph, so the per-process template in
 * `db/fresh.fixture.ts` was rebuilt for each of the ~80 files that open a
 * fixture database. On the Windows runner a template build measured 190 ms at
 * the median and 3.2 s at the worst under the whole suite's I/O, and it lands
 * in the first `beforeEach` of the file — the hook that kept crossing the
 * 10 s limit. `fresh.fixture.ts` falls back to building its own when this was
 * not provided (another config, a single file run from an editor).
 */

declare module "vitest" {
  export interface ProvidedContext {
    armadraDbTemplate: { migrationsDir: string; file: string } | null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export default function setup(project: TestProject): () => void {
  const migrationsDir = resolve(here, "../db/migrations");
  const directory = mkdtempSync(join(tmpdir(), "armadra-db-template-run-"));
  const file = join(directory, "template.db");
  openDatabase({ file, migrationsDir }).close();
  // Closing the last connection checkpoints the WAL into the main file; with a
  // side file left over, a copy of the main file alone would miss pages.
  const usable = !existsSync(`${file}-wal`) && !existsSync(`${file}-shm`);
  project.provide("armadraDbTemplate", usable ? { migrationsDir, file } : null);
  return () => {
    rmSync(directory, { recursive: true, force: true });
  };
}
