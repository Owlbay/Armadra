/**
 * 旧名字下的密钥一次性搬到 `armadra-*` 名字下。
 *
 * 搬过的条目记在数据目录 `secrets/migrated.json` 里，下次启动不再去敲旧位置（在
 * macOS 上那是一次钥匙串访问）。每一步都可以重来：
 *
 * 1. 新位置已经有值 → 新的为准，只清旧的；
 * 2. 旧位置有值 → 写新位置、**读回确认**、再删旧的；
 * 3. 旧位置没有 → 什么都不做。
 *
 * 只有三步都走完才记下，所以中途失败（钥匙串不可用、壳断开）下次启动会再试，
 * 而一个已经记下的条目永远不会被搬第二次。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SecretBackend } from "./backend";
import { writePrivateFile } from "./file";

/** 一个旧位置上的密钥。 */
export interface LegacySecret {
  /** 稳定的迁移 id，进记录文件。 */
  readonly id: string;
  /** 新名字（`armadra-*`）。 */
  readonly to: string;
  /** 旧位置的值；不在时 `undefined`，读失败时抛。 */
  read(): Promise<string | undefined>;
  /** 删掉旧位置；不在是成功。 */
  remove(): Promise<void>;
}

export function migrationRecordFile(dataDir: string): string {
  return join(dataDir, "secrets", "migrated.json");
}

function readRecord(file: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      migrated?: unknown;
    };
    return new Set(
      Array.isArray(parsed.migrated)
        ? parsed.migrated.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

/** 同一份记录文件上的迁移串行，免得两个域同时启动时互相覆盖。 */
const chains = new Map<string, Promise<unknown>>();

export interface MigrationResult {
  /** 这一次真正搬了值的条目。 */
  readonly moved: readonly string[];
  /** 这一次失败、留到下次再试的条目。 */
  readonly failed: readonly string[];
}

export function migrateLegacySecrets(
  backend: SecretBackend,
  items: readonly LegacySecret[],
  recordFile: string,
): Promise<MigrationResult> {
  const previous = chains.get(recordFile) ?? Promise.resolve();
  const run = previous.then(
    () => migrate(backend, items, recordFile),
    () => migrate(backend, items, recordFile),
  );
  chains.set(
    recordFile,
    run.catch(() => undefined),
  );
  return run;
}

async function migrate(
  backend: SecretBackend,
  items: readonly LegacySecret[],
  recordFile: string,
): Promise<MigrationResult> {
  const done = readRecord(recordFile);
  const moved: string[] = [];
  const failed: string[] = [];
  let changed = false;
  for (const item of items) {
    if (done.has(item.id)) continue;
    try {
      const legacy = await item.read();
      if (legacy !== undefined) {
        const current = await backend.get(item.to);
        if (current === undefined) {
          await backend.set(item.to, legacy);
          if ((await backend.get(item.to)) !== legacy) {
            throw new Error("read-back mismatch");
          }
          moved.push(item.id);
        }
        await item.remove();
      }
      done.add(item.id);
      changed = true;
    } catch {
      failed.push(item.id);
    }
  }
  if (changed) {
    writePrivateFile(
      recordFile,
      `${JSON.stringify({ migrated: [...done].sort() }, null, 2)}\n`,
    );
  }
  return { moved, failed };
}
