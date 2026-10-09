import type { SourceDescriptor, SourceRoute } from "../sources/types";

/**
 * 手机的连接表（客户端包 §4，契约 §55）：每个连接一行 {@link SourceDescriptor}，
 * 没有任何凭据——凭据在原生钥匙串里（`native-bridge.ts`）。表本身是页面的本地
 * 存储（`armadra.sources`），当前选中的连接另存一个键。
 *
 * 键是源的标识（core `system.hello` 的 `sourceId`，直连 Gateway 时是 `hostId`）。
 * 同一个源的每一种到达（局域网配对、局域网中转、公网中转）是这一行的一条路
 * （`routes`）；行上的 `baseUrl` / `relayOrigin` / `cloudIssuer` 是首选路由的镜像，
 * `kind` 照 v1：有中继那条路就是 `relayed`。
 *
 * 表的版本在 `armadra.sources.version`：1（§55 之前，一源一路）读到时一次性拆成
 * 路，写回成 2；远程服务的槽从按源改成按 `(源, 来源)`，旧槽搬到它那条中继上。
 */
const TABLE_KEY = "armadra.sources";
const ACTIVE_KEY = "armadra.sources.active";
const VERSION_KEY = "armadra.sources.version";
const TABLE_VERSION = 2;
/** 经中继的连接用钥匙串里哪一份远程服务登录（`serviceId`），见 {@link remoteSlotOf}。 */
const SLOTS_KEY = "armadra.sources.remoteSlots";

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

function routeOf(value: unknown): SourceRoute | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const via = row.via;
  const origin = text(row.origin);
  if ((via !== "direct" && via !== "relayed") || origin === "") return null;
  return {
    via,
    origin,
    cloudIssuer: via === "relayed" ? text(row.cloudIssuer) : "",
    fingerprint: text(row.fingerprint),
    preferred: row.preferred === true,
    lastOkAtMs: typeof row.lastOkAtMs === "number" ? row.lastOkAtMs : 0,
  };
}

/** v1 的一行（一源一路）→ 路：有直连地址的一条 direct（首选），有中继来源的一条 relayed。 */
function legacyRoutes(row: Record<string, unknown>): SourceRoute[] {
  const baseUrl = text(row.baseUrl);
  const relayOrigin = text(row.relayOrigin);
  const routes: SourceRoute[] = [];
  if (baseUrl !== "")
    routes.push({
      via: "direct",
      origin: baseUrl,
      cloudIssuer: "",
      fingerprint: text(row.fingerprint),
      preferred: true,
      lastOkAtMs: 0,
    });
  if (relayOrigin !== "")
    routes.push({
      via: "relayed",
      origin: relayOrigin,
      cloudIssuer: text(row.cloudIssuer),
      fingerprint: "",
      preferred: baseUrl === "",
      lastOkAtMs: 0,
    });
  return routes;
}

/** 同一条路（`via` + `origin`）只留一条；恰好一条首选（没有就第一条）。 */
function normalized(routes: readonly SourceRoute[]): SourceRoute[] {
  const seen = new Set<string>();
  const unique = routes.filter((route) => {
    const key = `${route.via}\u0000${route.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chosen = unique.findIndex((route) => route.preferred);
  const index = chosen < 0 ? 0 : chosen;
  return unique.map((route, at) => ({ ...route, preferred: at === index }));
}

/** 由路算出镜像字段（与 core 的 `SourcesStore.mirror` 同一个规矩）。 */
function withMirror(
  base: { sourceId: string; label: string; orderIndex: number },
  routes: readonly SourceRoute[],
): SourceDescriptor | null {
  const list = normalized(routes);
  const preferred = list.find((route) => route.preferred);
  if (preferred === undefined) return null;
  const direct =
    preferred.via === "direct"
      ? preferred
      : list.find((route) => route.via === "direct");
  const relay =
    preferred.via === "relayed"
      ? preferred
      : list.find((route) => route.via === "relayed");
  return {
    sourceId: base.sourceId,
    // 有中继那条路就是 relayed（与 v1 一样）：`me.stream` 与通知条按它认经中继的
    // 连接；先走哪条由路的首选与选路决定，不看 `kind`。
    kind: relay === undefined ? "direct" : "relayed",
    label: base.label,
    baseUrl: direct?.origin ?? "",
    relayOrigin: relay?.origin ?? "",
    cloudIssuer: relay?.cloudIssuer ?? "",
    fingerprint: direct?.fingerprint ?? "",
    orderIndex: base.orderIndex,
    routes: list,
  };
}

function descriptorOf(value: unknown): SourceDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const sourceId = text(row.sourceId);
  if (sourceId === "") return null;
  const routes = Array.isArray(row.routes)
    ? row.routes.flatMap((one) => {
        const route = routeOf(one);
        return route === null ? [] : [route];
      })
    : legacyRoutes(row);
  return withMirror(
    {
      sourceId,
      label: text(row.label),
      orderIndex: typeof row.orderIndex === "number" ? row.orderIndex : 0,
    },
    routes,
  );
}

function readTable(): SourceDescriptor[] {
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

/**
 * v1 → v2，一次性：行拆成路写回；按源记的远程服务槽搬到那个源的中继那条路上
 * （v1 一源只有一条中继）。读不出来的表不动、不标版本——不丢东西。
 */
function upgrade(): void {
  const store = storage();
  if (store === undefined) return;
  try {
    if (store.getItem(VERSION_KEY) === String(TABLE_VERSION)) return;
    const raw = store.getItem(TABLE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
    }
    const rows = readTable();
    const slots = loadSlots();
    const moved: Record<string, string> = {};
    for (const [key, serviceId] of Object.entries(slots)) {
      if (key.includes("\u0000")) {
        moved[key] = serviceId;
        continue;
      }
      const row = rows.find((one) => one.sourceId === key);
      const relay = row?.routes?.find((route) => route.via === "relayed");
      // 没有中继那条路的旧槽（行已删）照旧留着，读的时候还落得回来。
      moved[relay === undefined ? key : slotKey(key, relay.origin)] = serviceId;
    }
    save(rows);
    saveSlots(moved);
    store.setItem(VERSION_KEY, String(TABLE_VERSION));
  } catch {
    /* 存不下：下次再升。 */
  }
}

/** 读连接表；损坏的行丢掉，整张读不出来是空表。 */
export function loadConnections(): SourceDescriptor[] {
  upgrade();
  return readTable();
}

function save(rows: readonly SourceDescriptor[]): void {
  storage()?.setItem(TABLE_KEY, JSON.stringify(rows));
}

/**
 * 加一个连接；同一个源已有就合并成一行：新到的路补进去（同一条路改写它的
 * 签发方与指纹），标签以新的为准，顺序不变。新的直连地址顶替原来首选的直连；
 * 中继只在没有首选时成为首选。返回合并后的行。
 */
export function upsertConnection(
  incoming: Omit<SourceDescriptor, "kind" | "orderIndex" | "routes">,
): SourceDescriptor {
  const rows = loadConnections();
  const existing = rows.find((row) => row.sourceId === incoming.sourceId);
  let routes: SourceRoute[] = [...(existing?.routes ?? [])];
  const add = (route: SourceRoute) => {
    const current = routes.find(
      (one) => one.via === route.via && one.origin === route.origin,
    );
    const preferredNow = routes.find((one) => one.preferred);
    const preferred =
      current?.preferred === true ||
      preferredNow === undefined ||
      (route.via === "direct" && preferredNow.via === "direct");
    routes = routes
      .filter((one) => one !== current)
      .map((one) => (preferred ? { ...one, preferred: false } : one));
    routes.push({
      ...route,
      preferred,
      lastOkAtMs: current?.lastOkAtMs ?? 0,
      cloudIssuer: route.cloudIssuer || current?.cloudIssuer || "",
      fingerprint: route.fingerprint || current?.fingerprint || "",
    });
  };
  if (incoming.baseUrl !== "")
    add({
      via: "direct",
      origin: incoming.baseUrl,
      cloudIssuer: "",
      fingerprint: incoming.fingerprint,
      preferred: false,
      lastOkAtMs: 0,
    });
  if (incoming.relayOrigin !== "")
    add({
      via: "relayed",
      origin: incoming.relayOrigin,
      cloudIssuer: incoming.cloudIssuer,
      fingerprint: "",
      preferred: false,
      lastOkAtMs: 0,
    });
  const merged = withMirror(
    {
      sourceId: incoming.sourceId,
      label: incoming.label || existing?.label || "",
      orderIndex:
        existing?.orderIndex ??
        rows.reduce((top, row) => Math.max(top, row.orderIndex), -1) + 1,
    },
    routes,
  );
  if (merged === null) {
    // 一条路也没给：不建行（与 v1 一样，没有地址的行读不出来）。
    return (
      existing ?? {
        sourceId: incoming.sourceId,
        kind: "direct",
        label: incoming.label,
        baseUrl: "",
        relayOrigin: "",
        cloudIssuer: incoming.cloudIssuer,
        fingerprint: incoming.fingerprint,
        orderIndex: rows.length,
        routes: [],
      }
    );
  }
  save(
    existing === undefined
      ? [...rows, merged]
      : rows.map((row) => (row.sourceId === merged.sourceId ? merged : row)),
  );
  return merged;
}

/** 记下这条路刚连通（选路按最近成功排序）。没有这条路不动。 */
export function touchRoute(
  sourceId: string,
  via: SourceRoute["via"],
  origin: string,
  atMs: number = Date.now(),
): void {
  const rows = loadConnections();
  const row = rows.find((one) => one.sourceId === sourceId);
  const routes = row?.routes ?? [];
  if (
    row === undefined ||
    !routes.some((one) => one.via === via && one.origin === origin)
  )
    return;
  const next = {
    ...row,
    routes: routes.map((one) =>
      one.via === via && one.origin === origin
        ? { ...one, lastOkAtMs: atMs }
        : one,
    ),
  };
  save(rows.map((one) => (one.sourceId === sourceId ? next : one)));
}

/** 从表里去掉一个连接（它的凭据由调用方另行清掉）。 */
export function removeConnection(sourceId: string): void {
  save(loadConnections().filter((row) => row.sourceId !== sourceId));
  if (activeConnectionId() === sourceId) storage()?.removeItem(ACTIVE_KEY);
  const slots = loadSlots();
  const prefix = `${sourceId}\u0000`;
  const kept = Object.fromEntries(
    Object.entries(slots).filter(
      ([key]) => key !== sourceId && !key.startsWith(prefix),
    ),
  );
  if (Object.keys(kept).length !== Object.keys(slots).length) saveSlots(kept);
}

/* ------------------------------ 远程服务的槽 ------------------------------ */

function slotKey(sourceId: string, origin: string): string {
  return `${sourceId}\u0000${origin}`;
}

function loadSlots(): Record<string, string> {
  try {
    const raw = storage()?.getItem(SLOTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1] !== "",
      ),
    );
  } catch {
    return {};
  }
}

function saveSlots(slots: Record<string, string>): void {
  storage()?.setItem(SLOTS_KEY, JSON.stringify(slots));
}

/** 不给来源时用这个源首选的那条中继。 */
function relayOriginOf(sourceId: string): string {
  const row = readTable().find((one) => one.sourceId === sourceId);
  return row?.relayOrigin ?? "";
}

/**
 * 这个连接的这条中继用钥匙串里哪一份远程服务登录。同一个中继下主人与访客各是
 * 一份（`credentials.ts::serviceIdOf(issuer, principal)`），同一台主机经两个中继
 * 各是一份；早先的连接没有记录，答 `null`，由调用方落回那个签发方原来的单槽——
 * 旧数据原样可用，不搬不丢。
 */
export function remoteSlotOf(sourceId: string, origin?: string): string | null {
  upgrade();
  const slots = loadSlots();
  const via = origin ?? relayOriginOf(sourceId);
  return (
    (via === "" ? undefined : slots[slotKey(sourceId, via)]) ??
    slots[sourceId] ??
    null
  );
}

export function setRemoteSlot(
  sourceId: string,
  serviceId: string,
  origin?: string,
): void {
  upgrade();
  const via = origin ?? relayOriginOf(sourceId);
  saveSlots({
    ...loadSlots(),
    [via === "" ? sourceId : slotKey(sourceId, via)]: serviceId,
  });
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
