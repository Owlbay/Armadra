/**
 * Provider 状态页（roadmap §3.9「Provider 状态页 / 事故徽标」）。
 *
 * 用量卡回答「我还剩多少」，回答不了「是不是它那边出事了」——额度没满、请求
 * 却一直失败的时候，人最先想知道的是后者。三家都用同一种公开状态页，
 * `/api/v2/status.json` 给一个总指示（none / minor / major / critical /
 * maintenance），这里只读这一个字段。
 *
 * 三条规矩：
 *
 *   * **不编答案**。超时、非 200、JSON 不对、离线，一律 `unknown`，不回退成
 *     「正常」。一个假的绿灯比没有灯更糟。
 *   * **有缓存**。状态页不是实时仪表，五分钟问一次足够；看板开着、页面每次
 *     重渲染都来问，也只在缓存过期后真发请求，同一时刻只有一趟在路上。
 *   * **能关**。`usage.statusBadges` 关掉之后这里一个请求都不发（开关在路由
 *     那一层判；只有旧键 `usage.statusPage` 的文档由设置归一化沿用旧值）。
 */

import { OUTBOUND } from "../net/outbound";

export const STATUS_PROVIDER_IDS = ["anthropic", "openai", "github"] as const;
export type StatusProviderId = (typeof STATUS_PROVIDER_IDS)[number];

export type StatusIndicator =
  | "none"
  | "minor"
  | "major"
  | "critical"
  | "maintenance"
  | "unknown";

const INDICATORS: readonly StatusIndicator[] = [
  "none",
  "minor",
  "major",
  "critical",
  "maintenance",
];

export interface ProviderStatus {
  readonly id: StatusProviderId;
  readonly indicator: StatusIndicator;
  /** 状态页自己的一句话（英文，第三方原文）；`unknown` 时没有。 */
  readonly description?: string;
  /** 给人看的状态页地址。 */
  readonly pageUrl: string;
  /** 这份答案是什么时候取到的；`unknown` 时是最后一次尝试的时间。 */
  readonly checkedAt: string;
}

export interface StatusSource {
  /** JSON 地址。 */
  readonly url: string;
  readonly pageUrl: string;
}

/** Atlassian Statuspage 的公共 Status API 路径。 */
const STATUS_JSON_PATH = "/api/v2/status.json";

function source(root: string): StatusSource {
  return { url: `${root}${STATUS_JSON_PATH}`, pageUrl: root };
}

/**
 * 地址在出站表里（`net/outbound.ts`）。Anthropic 的状态页已从
 * `status.anthropic.com` 搬到 `status.claude.com`（旧地址 302 过去）；这里用新
 * 地址，`fetch` 仍按缺省跟随重定向，`status.test.ts` 钉着这一点。
 */
export const STATUS_SOURCES: Readonly<Record<StatusProviderId, StatusSource>> =
  {
    anthropic: source(OUTBOUND.statusAnthropic.url),
    openai: source(OUTBOUND.statusOpenai.url),
    github: source(OUTBOUND.statusGithub.url),
  };

/**
 * 三家的状态页换成同一个根地址下的 `/<id>/api/v2/status.json`。只给探针与
 * 测试用：`ARMADRA_STATUS_PAGE_BASE` 设了才走这里（与
 * `ARMADRA_GITHUB_API_BASE` 同一种做法），好让实浏览器探针把徽标对着本机的
 * fixture 服务器跑，而不是真网络。空串与没设一样按官方地址。
 */
export function statusSources(
  base: string | undefined,
): Readonly<Record<StatusProviderId, StatusSource>> {
  const root = base?.trim().replace(/\/+$/, "") ?? "";
  if (root === "") return STATUS_SOURCES;
  const out = {} as Record<StatusProviderId, StatusSource>;
  for (const id of STATUS_PROVIDER_IDS) {
    out[id] = {
      url: `${root}/${id}/api/v2/status.json`,
      pageUrl: `${root}/${id}`,
    };
  }
  return out;
}

/** 五分钟：状态页本身也不是秒级更新的。 */
export const STATUS_TTL_MS = 5 * 60_000;
/** 一家不回话不能拖住另外两家，也不能拖住看板。 */
export const STATUS_TIMEOUT_MS = 5_000;

export type StatusFetch = (
  url: string,
  init: {
    signal: AbortSignal;
    headers: Record<string, string>;
    redirect: "follow";
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface StatusServiceOptions {
  readonly fetch?: StatusFetch;
  readonly sources?: Readonly<Record<StatusProviderId, StatusSource>>;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
}

/** 从一份 `status.json` 里取指示；形状不对就是 `undefined`。 */
export function parseStatusDocument(
  body: unknown,
): { indicator: StatusIndicator; description?: string } | undefined {
  const status = (body as { status?: unknown } | null)?.status as
    | { indicator?: unknown; description?: unknown }
    | undefined;
  if (typeof status !== "object" || status === null) return undefined;
  const indicator = status.indicator;
  if (
    typeof indicator !== "string" ||
    !INDICATORS.includes(indicator as StatusIndicator)
  ) {
    return undefined;
  }
  return {
    indicator: indicator as StatusIndicator,
    ...(typeof status.description === "string" && status.description
      ? { description: status.description.slice(0, 200) }
      : {}),
  };
}

export class StatusService {
  private readonly fetch: StatusFetch;
  private readonly sources: Readonly<Record<StatusProviderId, StatusSource>>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private cached: { at: number; providers: ProviderStatus[] } | undefined;
  private inflight: Promise<ProviderStatus[]> | undefined;

  constructor(options: StatusServiceOptions = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as StatusFetch);
    this.sources = options.sources ?? STATUS_SOURCES;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? STATUS_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  }

  /** 缓存未过期就回缓存；否则三家并发取一次。 */
  async current(): Promise<ProviderStatus[]> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < this.ttlMs) return cached.providers;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchAll(): Promise<ProviderStatus[]> {
    const providers = await Promise.all(
      STATUS_PROVIDER_IDS.map((id) => this.fetchOne(id)),
    );
    this.cached = { at: this.now(), providers };
    return providers;
  }

  private async fetchOne(id: StatusProviderId): Promise<ProviderStatus> {
    const source = this.sources[id];
    const unknown: ProviderStatus = {
      id,
      indicator: "unknown",
      pageUrl: source.pageUrl,
      checkedAt: new Date(this.now()).toISOString(),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(source.url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
        // 状态页会搬家（anthropic → claude），跟随是这里的契约而不是缺省碰巧。
        redirect: "follow",
      });
      if (!response.ok) return unknown;
      const parsed = parseStatusDocument(await response.json());
      if (!parsed) return unknown;
      return {
        id,
        ...parsed,
        pageUrl: source.pageUrl,
        checkedAt: new Date(this.now()).toISOString(),
      };
    } catch {
      // 离线、DNS、超时、证书——对看板都是同一个答案：不知道。
      return unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
