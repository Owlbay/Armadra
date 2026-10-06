import type { SourceDescriptor } from "../sources/types";

/**
 * 手机的连接表（客户端包 §4）：每个连接一行 {@link SourceDescriptor}，没有任何
 * 凭据——凭据在原生钥匙串里（`native-bridge.ts`），一个连接一份。表本身是
 * 页面的本地存储（`armadra.sources`），当前选中的连接另存一个键。
 *
 * 键是源的标识（core `system.hello` 的 `sourceId`，直连 Gateway 时是 `hostId`）：
 * 同一个源从两条路到达（局域网配对、个人中转）合并成一行——有直连地址又有中继
 * 来源的行同时给选路两条路。
 */
const TABLE_KEY = "armadra.sources";
const ACTIVE_KEY = "armadra.sources.active";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function descriptorOf(value: unknown): SourceDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const sourceId = text(row.sourceId);
  if (sourceId === "") return null;
  const baseUrl = text(row.baseUrl);
  const relayOrigin = text(row.relayOrigin);
  if (baseUrl === "" && relayOrigin === "") return null;
  return {
    sourceId,
    kind: relayOrigin === "" ? "direct" : "relayed",
    label: text(row.label),
    baseUrl,
    relayOrigin,
    cloudIssuer: text(row.cloudIssuer),
    fingerprint: text(row.fingerprint),
    orderIndex: typeof row.orderIndex === "number" ? row.orderIndex : 0,
  };
}

/** 读连接表；损坏的行丢掉，整张读不出来是空表。 */
export function loadConnections(): SourceDescriptor[] {
  try {
    const raw = storage()?.getItem(TABLE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((row) => {
        const descriptor = descriptorOf(row);
        return descriptor === null ? [] : [descriptor];
      })
      .sort((a, b) => a.orderIndex - b.orderIndex);
  } catch {
    return [];
  }
}

function save(rows: readonly SourceDescriptor[]): void {
  storage()?.setItem(TABLE_KEY, JSON.stringify(rows));
}

/**
 * 加一个连接；同一个源已有就合并成一行（新到的路补进去，标签以新的为准，
 * 顺序不变）。返回合并后的行。
 */
export function upsertConnection(
  incoming: Omit<SourceDescriptor, "kind" | "orderIndex">,
): SourceDescriptor {
  const rows = loadConnections();
  const existing = rows.find((row) => row.sourceId === incoming.sourceId);
  const baseUrl = incoming.baseUrl || existing?.baseUrl || "";
  const relayOrigin = incoming.relayOrigin || existing?.relayOrigin || "";
  const merged: SourceDescriptor = {
    sourceId: incoming.sourceId,
    kind: relayOrigin === "" ? "direct" : "relayed",
    label: incoming.label || existing?.label || "",
    baseUrl,
    relayOrigin,
    cloudIssuer: incoming.cloudIssuer || existing?.cloudIssuer || "",
    fingerprint: incoming.fingerprint || existing?.fingerprint || "",
    orderIndex:
      existing?.orderIndex ??
      rows.reduce((top, row) => Math.max(top, row.orderIndex), -1) + 1,
  };
  save(
    existing === undefined
      ? [...rows, merged]
      : rows.map((row) => (row.sourceId === merged.sourceId ? merged : row)),
  );
  return merged;
}

/** 从表里去掉一个连接（它的凭据由调用方另行清掉）。 */
export function removeConnection(sourceId: string): void {
  save(loadConnections().filter((row) => row.sourceId !== sourceId));
  if (activeConnectionId() === sourceId) storage()?.removeItem(ACTIVE_KEY);
}

export function activeConnectionId(): string | null {
  try {
    return storage()?.getItem(ACTIVE_KEY) || null;
  } catch {
    return null;
  }
}

export function setActiveConnection(sourceId: string): void {
  storage()?.setItem(ACTIVE_KEY, sourceId);
}

/** 当前连接：选中的那个，没有（或已删）就是表里第一个。 */
export function activeConnection(): SourceDescriptor | null {
  const rows = loadConnections();
  const id = activeConnectionId();
  return rows.find((row) => row.sourceId === id) ?? rows[0] ?? null;
}
