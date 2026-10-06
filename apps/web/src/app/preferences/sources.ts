/**
 * 按源记的偏好（客户端包 §2）：已打开 / 收起 / 置顶的工作空间、置顶的画布与
 * 上次打开的位置，落盘时都是 `{ sourceId, workspaceId | boardId }`；内存里
 * 是 `${sourceId}:${id}`（`sources/scope.ts` 的 `scoped`）。
 *
 * 旧版本只记裸 id：{@link migrateSourceScopedPreferences} 第一次读到时把它们
 * 一次性迁到本机源下，写回新格式。
 */
import { LOCAL_SOURCE_ID } from "../../api/source";
import { scoped, unscoped } from "../../sources/scope";
import { readStored, writeStored } from "./storage";

export const OPEN_WORKSPACES_KEY = "armadra.openWorkspaces";
export const COLLAPSED_WORKSPACES_KEY = "armadra.collapsedWorkspaces";
export const PINNED_WORKSPACES_KEY = "armadra.pinnedWorkspaces";
export const PINNED_BOARDS_KEY = "armadra.pinnedBoards";
export const LAST_WORKSPACE_KEY = "armadra.workspace";
export const LAST_BOARD_KEY = "armadra.board";

export interface WorkspaceRef {
  readonly sourceId: string;
  readonly workspaceId: string;
}

export interface BoardRef {
  readonly sourceId: string;
  readonly boardId: string;
}

type IdField = "workspaceId" | "boardId";

const LISTS: readonly { key: string; field: IdField }[] = [
  { key: OPEN_WORKSPACES_KEY, field: "workspaceId" },
  { key: COLLAPSED_WORKSPACES_KEY, field: "workspaceId" },
  { key: PINNED_WORKSPACES_KEY, field: "workspaceId" },
  { key: PINNED_BOARDS_KEY, field: "boardId" },
];

function parse(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRef(
  value: unknown,
  field: IdField,
): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sourceId === "string" && typeof record[field] === "string"
  );
}

/** 旧值（裸 id 数组、裸 id 字符串）一次性迁到本机源；已是新格式的不动。 */
export function migrateSourceScopedPreferences(): void {
  for (const { key, field } of LISTS) {
    const parsed = parse(readStored(key));
    if (!Array.isArray(parsed)) continue;
    if (!parsed.some((item) => typeof item === "string")) continue;
    const migrated = parsed
      .filter((item): item is string => typeof item === "string")
      .map((id) => ({ sourceId: LOCAL_SOURCE_ID, [field]: id }));
    writeStored(key, JSON.stringify(migrated));
  }
  for (const { key, field } of [
    { key: LAST_WORKSPACE_KEY, field: "workspaceId" as const },
    { key: LAST_BOARD_KEY, field: "boardId" as const },
  ]) {
    const raw = readStored(key);
    if (raw === null || raw.trim().startsWith("{")) continue;
    writeStored(
      key,
      JSON.stringify({ sourceId: LOCAL_SOURCE_ID, [field]: raw }),
    );
  }
}

/** 读一张按源记的列表，返回内存里的键（`${sourceId}:${id}`）。 */
export function storedScopedIds(key: string, field: IdField): string[] {
  const parsed = parse(readStored(key));
  if (!Array.isArray(parsed)) return [];
  const keys: string[] = [];
  for (const item of parsed) {
    if (isRef(item, field)) keys.push(scoped(item[field]!, item.sourceId));
  }
  return keys;
}

/** 把内存里的键写成 `{ sourceId, … }[]`。 */
export function writeScopedIds(
  key: string,
  field: IdField,
  keys: readonly string[],
): void {
  writeStored(
    key,
    JSON.stringify(
      keys.map((entry) => {
        const { sourceId, id } = unscoped(entry);
        return { sourceId, [field]: id };
      }),
    ),
  );
}

/** 某个源里的 id（保持顺序）。 */
export function idsInSource(
  keys: readonly string[],
  sourceId: string,
): string[] {
  const ids: string[] = [];
  for (const entry of keys) {
    const parsed = unscoped(entry);
    if (parsed.sourceId === sourceId) ids.push(parsed.id);
  }
  return ids;
}

/** 上次记下的一个位置（工作空间或画布）；旧的裸字符串当作本机源。 */
export function storedLast(
  key: string,
  field: IdField,
): { sourceId: string; id: string } | null {
  const raw = readStored(key);
  if (raw === null) return null;
  const parsed = parse(raw);
  if (isRef(parsed, field))
    return { sourceId: parsed.sourceId!, id: parsed[field]! };
  return typeof parsed === "string" || parsed === undefined
    ? { sourceId: LOCAL_SOURCE_ID, id: raw }
    : null;
}
