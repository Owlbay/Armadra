import * as React from "react";

import { cloudSources } from "../sources/cloud-client";
import { DIRECT_PROBE_TIMEOUT_MS, probeDirect } from "../sources/routing";
import type { CloudAuth } from "../sources/types";
import type { ServiceRow } from "./rows";

/**
 * 选择页的在线状态（A7-1，多端入口设计 §1.3）。
 *
 * - 直连那条路：匿名 `GET <base>/api/identity/hello`（1.5 秒，与选路同一个探测），
 *   答的是这台就算在线；
 * - 经中继的：每个远程服务一次 `GET <issuer>/v1/me/sources`，答案里的 `online`
 *   覆盖这个服务下的全部源；换不到访问令牌（登录失效）→ 这一组「已登出」，组里
 *   的行状态未知。
 *
 * 一台有几条路时任一条答在线就算在线。最多 {@link PROBE_CONCURRENCY} 个并发，
 * 结果缓存 {@link PROBE_TTL_MS}；探测不挡点行进入。
 */

export type ServiceStatus = "online" | "offline" | "unknown";

export interface ProbeResult {
  readonly statuses: Readonly<Record<string, ServiceStatus>>;
  /** 登录失效的远程服务（签发方）。 */
  readonly signedOut: readonly string[];
}

export const PROBE_CONCURRENCY = 3;
export const PROBE_TTL_MS = 30_000;
/** 远程服务的目录要走一趟公网，比直连探测宽一些。 */
const RELAY_PROBE_TIMEOUT_MS = 5_000;

export interface ProbeDeps {
  readonly fetch?: typeof fetch;
  /** 远程服务的访问令牌（手机：钥匙串里那一槽换的）；不给就不探中继。 */
  readonly cloudAuth?: Pick<CloudAuth, "access">;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  readonly ttlMs?: number;
}

type Answer =
  | { readonly kind: "direct"; readonly online: boolean }
  | {
      readonly kind: "relay";
      readonly online: ReadonlyMap<string, boolean> | null;
      readonly signedOut: boolean;
    };

/** 并发上限：排队跑，同时最多 `limit` 个。 */
function limiter(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (running >= limit) return;
    const start = queue.shift();
    if (start === undefined) return;
    running += 1;
    start();
  };
  return <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        work()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            next();
          });
      });
      next();
    });
}

/** 登录失效（凭据被拒）而不是网络断了：4xx 的远程服务答案与源层的「未授权」。 */
function signedOutError(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown } | null;
  if (typeof failure?.status === "number")
    return failure.status >= 400 && failure.status < 500;
  return (
    failure?.code === "source_unauthorized" ||
    failure?.code === "unauthorized" ||
    failure?.code === "token_invalid"
  );
}

export interface ServiceProbe {
  probe(rows: readonly ServiceRow[]): Promise<ProbeResult>;
  /** 丢掉缓存（回到前台时照样按缓存走，人点「刷新」才用得着）。 */
  clear(): void;
}

export function createServiceProbe(
  baseOf: (sourceId: string) => string,
  deps: ProbeDeps = {},
): ServiceProbe {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? PROBE_TTL_MS;
  const run = limiter(deps.concurrency ?? PROBE_CONCURRENCY);
  const cache = new Map<string, { at: number; answer: Promise<Answer> }>();

  const cached = (key: string, work: () => Promise<Answer>) => {
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ttl) return hit.answer;
    const answer = run(work);
    cache.set(key, { at: now(), answer });
    // 失败的不缓存：下一次照样再问。
    answer.catch(() => cache.delete(key));
    return answer;
  };

  const direct = (sourceId: string, base: string) =>
    cached(`direct:${sourceId}`, async () => ({
      kind: "direct",
      online: await probeDirect(base, sourceId, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        timeoutMs: deps.timeoutMs ?? DIRECT_PROBE_TIMEOUT_MS,
      }),
    }));

  const relay = (issuer: string) =>
    cached(`relay:${issuer}`, async () => {
      const auth = deps.cloudAuth;
      if (auth === undefined)
        return { kind: "relay", online: null, signedOut: false };
      let token: string;
      try {
        token = await auth.access(issuer);
      } catch (error) {
        return {
          kind: "relay",
          online: null,
          signedOut: signedOutError(error),
        };
      }
      try {
        const listed = await cloudSources(issuer, token, {
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          timeoutMs: RELAY_PROBE_TIMEOUT_MS,
        });
        return {
          kind: "relay",
          online: new Map(listed.map((one) => [one.sourceId, one.online])),
          signedOut: false,
        };
      } catch (error) {
        return {
          kind: "relay",
          online: null,
          signedOut: signedOutError(error),
        };
      }
    });

  return {
    async probe(rows) {
      const statuses: Record<string, ServiceStatus> = {};
      const signedOut = new Set<string>();
      await Promise.all(
        rows.map(async (row) => {
          if (row.local) {
            statuses[row.sourceId] = "online";
            return;
          }
          const answers = await Promise.all(
            row.routes.map((route) =>
              (route.via === "direct"
                ? direct(row.sourceId, baseOf(row.sourceId))
                : relay(route.issuer)
              ).catch((): Answer | null => null),
            ),
          );
          let known = false;
          let online = false;
          answers.forEach((answer, index) => {
            if (answer === null) return;
            if (answer.kind === "direct") {
              known = true;
              online ||= answer.online;
              return;
            }
            if (answer.signedOut) signedOut.add(row.routes[index]!.issuer);
            if (answer.online === null) return;
            known = true;
            online ||= answer.online.get(row.sourceId) === true;
          });
          statuses[row.sourceId] = online
            ? "online"
            : known
              ? "offline"
              : "unknown";
        }),
      );
      return { statuses, signedOut: [...signedOut] };
    },
    clear() {
      cache.clear();
    },
  };
}

const EMPTY: ProbeResult = { statuses: {}, signedOut: [] };

/**
 * 进入页面与回到前台时各探一次（缓存内不重发）；卸载后的答案丢掉。
 */
export function useServiceProbe(
  rows: readonly ServiceRow[],
  probe: ServiceProbe | null,
): ProbeResult {
  const [result, setResult] = React.useState<ProbeResult>(EMPTY);
  const key = rows.map((row) => row.sourceId).join(",");
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  React.useEffect(() => {
    if (probe === null) return;
    let live = true;
    const once = () => {
      void probe
        .probe(rowsRef.current)
        .then((next) => {
          if (live) setResult(next);
        })
        .catch(() => undefined);
    };
    once();
    const visible = () => {
      if (globalThis.document?.visibilityState === "visible") once();
    };
    globalThis.document?.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      globalThis.document?.removeEventListener("visibilitychange", visible);
    };
  }, [probe, key]);
  return result;
}
