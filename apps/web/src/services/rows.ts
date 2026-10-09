import type { SourceDescriptor } from "../sources/types";
import { RECENT_LIMIT, type RecentEntry } from "./recent";

/**
 * 选择服务的行模型（A7-1，多端入口设计 §1.3）。
 *
 * 列表按 `sourceId` 一行：手机连接表与 core 源表都以它为键，同一台主机经几条路
 * 到达也只出现一次。到达方式按选路的优先次序（直连优先，D27）；「全部」里按
 * 首选那条路分组，其余路写在第二行，不重复出现。
 */

export type ServiceRouteVia = "direct" | "relayed";

export interface ServiceRoute {
  readonly via: ServiceRouteVia;
  /** 经中继时远程服务的签发方（没有记签发方时是中继来源）；直连是空串。 */
  readonly issuer: string;
  /** 经中继时远程服务的名字（缺省主机名）；直连是空串。 */
  readonly serviceName: string;
}

export interface ServiceRow {
  readonly sourceId: string;
  /** 名字：源的标签，缺省主机名。 */
  readonly name: string;
  readonly local: boolean;
  /** 到达方式，首选在前；本机没有。 */
  readonly routes: readonly ServiceRoute[];
  /** 上次进入成功的时刻；没进过是 `null`。 */
  readonly lastUsedAt: number | null;
}

export type ServiceGroupKind = "local" | "direct" | "relay";

export interface ServiceGroup {
  /** `local` / `direct` / `relay:<issuer>`。 */
  readonly key: string;
  readonly kind: ServiceGroupKind;
  /** 中继组的远程服务名；其余是空串。 */
  readonly name: string;
  /** 中继组的签发方；其余是空串。 */
  readonly issuer: string;
  readonly rows: readonly ServiceRow[];
}

export interface ServiceLayout {
  /** 最近使用（按记录顺序）；一共不超过 {@link RECENT_LIMIT} 行时不单列，是空表。 */
  readonly recent: readonly ServiceRow[];
  readonly groups: readonly ServiceGroup[];
}

/** 地址里的主机（带端口）；认不出原样返回。 */
export function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export interface RowOptions {
  /** 签发方 → 远程服务名（桌面是 `remote_services.label`）；没有就用主机名。 */
  readonly serviceName?: (issuer: string) => string;
  readonly recent?: readonly RecentEntry[];
}

/** 源描述 → 行。 */
export function serviceRowOf(
  descriptor: SourceDescriptor,
  options: RowOptions = {},
): ServiceRow {
  const local = descriptor.kind === "local";
  const routes: ServiceRoute[] = [];
  if (!local && descriptor.baseUrl !== "")
    routes.push({ via: "direct", issuer: "", serviceName: "" });
  if (!local && descriptor.relayOrigin !== "") {
    const issuer = descriptor.cloudIssuer || descriptor.relayOrigin;
    routes.push({
      via: "relayed",
      issuer,
      serviceName: options.serviceName?.(issuer) || hostOf(issuer),
    });
  }
  const used = options.recent?.find(
    (entry) => entry.sourceId === descriptor.sourceId,
  );
  return {
    sourceId: descriptor.sourceId,
    name:
      descriptor.label ||
      (descriptor.baseUrl !== ""
        ? hostOf(descriptor.baseUrl)
        : descriptor.relayOrigin !== ""
          ? descriptor.sourceId.slice(0, 8)
          : ""),
    local,
    routes,
    lastUsedAt: used?.at ?? null,
  };
}

function groupOf(row: ServiceRow): Omit<ServiceGroup, "rows"> {
  if (row.local) return { key: "local", kind: "local", name: "", issuer: "" };
  const first = row.routes[0];
  if (first === undefined || first.via === "direct")
    return { key: "direct", kind: "direct", name: "", issuer: "" };
  return {
    key: `relay:${first.issuer}`,
    kind: "relay",
    name: first.serviceName,
    issuer: first.issuer,
  };
}

const KIND_ORDER: Record<ServiceGroupKind, number> = {
  local: 0,
  relay: 1,
  direct: 2,
};

/**
 * 排版：本机一组在最前，中继各一组（按第一次出现的顺序），直连一组在最后；
 * 组内保持传入顺序。行数超过 {@link RECENT_LIMIT} 才单列「最近使用」（一共就
 * 两三行时它只是把同几行再列一遍）。
 */
export function layoutServices(
  rows: readonly ServiceRow[],
  recent: readonly string[] = [],
): ServiceLayout {
  const groups = new Map<
    string,
    Omit<ServiceGroup, "rows"> & { rows: ServiceRow[] }
  >();
  for (const row of rows) {
    const group = groupOf(row);
    const existing = groups.get(group.key);
    if (existing) existing.rows.push(row);
    else groups.set(group.key, { ...group, rows: [row] });
  }
  const ordered = [...groups.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
  const byId = new Map(rows.map((row) => [row.sourceId, row]));
  const recentRows = recent.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined || row.local ? [] : [row];
  });
  return {
    recent: rows.length > RECENT_LIMIT ? recentRows : [],
    groups: ordered,
  };
}
