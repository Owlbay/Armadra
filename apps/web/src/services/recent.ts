/**
 * 最近使用的服务（A7-1，`armadra.sources.recent`）：每次进入成功前插去重，
 * 带时刻（选择页第二行的「上次使用」）。选择页的「最近使用」取前
 * {@link RECENT_LIMIT} 个；表里多记几条只为给其余行留时刻。
 *
 * 另有一个只活一次重载的「进入意图」（会话存储）：选择页点一行 = 记意图 + 重载，
 * 入口读到它就直接进那一个（原生源地址一次加载只算一次）。
 */

const RECENT_KEY = "armadra.sources.recent";
const ENTER_KEY = "armadra.services.enter";

export const RECENT_LIMIT = 3;
/** 记时刻的上限：比连接表大多了，超出的最旧几条丢掉。 */
const KEEP = 32;

export interface RecentEntry {
  readonly sourceId: string;
  /** 上次进入成功的时刻（毫秒）。 */
  readonly at: number;
}

function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function session(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** 全部记录，新的在前；损坏的行丢掉。 */
export function loadRecent(): RecentEntry[] {
  try {
    const raw = local()?.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.flatMap((row): RecentEntry[] => {
      const item = row as { sourceId?: unknown; at?: unknown } | null;
      if (
        typeof item?.sourceId !== "string" ||
        item.sourceId === "" ||
        typeof item.at !== "number" ||
        seen.has(item.sourceId)
      )
        return [];
      seen.add(item.sourceId);
      return [{ sourceId: item.sourceId, at: item.at }];
    });
  } catch {
    return [];
  }
}

function save(rows: readonly RecentEntry[]): void {
  try {
    local()?.setItem(RECENT_KEY, JSON.stringify(rows.slice(0, KEEP)));
  } catch {
    /* 存不下只是少了「最近使用」。 */
  }
}

/** 最近使用的前几个 `sourceId`。 */
export function recentIds(limit: number = RECENT_LIMIT): string[] {
  return loadRecent()
    .slice(0, limit)
    .map((row) => row.sourceId);
}

/** 进入成功：前插去重。 */
export function recordRecent(sourceId: string, at: number = Date.now()): void {
  save([
    { sourceId, at },
    ...loadRecent().filter((row) => row.sourceId !== sourceId),
  ]);
}

/** 连接被移除：它的记录一起去掉。 */
export function forgetRecent(sourceId: string): void {
  const rows = loadRecent();
  if (rows.some((row) => row.sourceId === sourceId))
    save(rows.filter((row) => row.sourceId !== sourceId));
}

/** 记下「重载后进这一个」。 */
export function setEnterIntent(sourceId: string): void {
  try {
    session()?.setItem(ENTER_KEY, sourceId);
  } catch {
    /* 记不下就回到选择页，再点一次。 */
  }
}

/** 取走进入意图（只取一次）；没有是 `null`。 */
export function takeEnterIntent(): string | null {
  try {
    const store = session();
    const value = store?.getItem(ENTER_KEY) ?? null;
    if (value !== null) store?.removeItem(ENTER_KEY);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}
