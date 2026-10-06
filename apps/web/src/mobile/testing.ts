import { vi } from "vitest";

import type {
  NativeBridge,
  PeekResult,
  StoredRemote,
  StoredSession,
} from "./native-bridge";

/** 内存里的 localStorage（jsdom 下没有可用的）。 */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

/** 会话密钥：`<32 位十六进制>.<43 位 base64url>`。 */
export const SESSION_A = `${"0".repeat(32)}.${"a".repeat(43)}`;
export const SESSION_B = `${"1".repeat(32)}.${"b".repeat(43)}`;
export const SESSION_C = `${"2".repeat(32)}.${"c".repeat(43)}`;

/** 钥匙串的内存替身：按 `sourceId` + `via` 一份、按 `serviceId` 一份。 */
export function fakeBridge(
  overrides: Omit<Partial<NativeBridge>, "peek"> & {
    peek?: PeekResult | null;
  } = {},
) {
  const sessions = new Map<string, StoredSession>();
  const remotes = new Map<string, StoredRemote>();
  const pins: { origin: string; fingerprint: string }[] = [];
  const { peek, ...rest } = overrides;
  const bridge = {
    available: true,
    canScan: true,
    getSessions: vi.fn(async () => [...sessions.values()]),
    setSession: vi.fn(async (session: StoredSession) => {
      sessions.set(`${session.sourceId}|${session.via}`, session);
    }),
    removeSession: vi.fn(async (sourceId: string, origin?: string) => {
      for (const [key, session] of [...sessions]) {
        if (
          session.sourceId === sourceId &&
          (origin === undefined || session.origin === origin)
        )
          sessions.delete(key);
      }
    }),
    getRemotes: vi.fn(async () => [...remotes.values()]),
    setRemote: vi.fn(async (remote: StoredRemote) => {
      remotes.set(remote.serviceId, remote);
    }),
    removeRemote: vi.fn(async (serviceId: string) => {
      remotes.delete(serviceId);
    }),
    peek: vi.fn(async () => peek ?? null),
    pin: vi.fn(async (origin: string, fingerprint: string) => {
      pins.push({ origin, fingerprint });
    }),
    scan: vi.fn(async () => null),
    pushRegistration: vi.fn(async () => null),
    pushRotated: vi.fn(async () => false),
    ackPushRotation: vi.fn(async () => undefined),
    onPushRotated: () => () => undefined,
    openExternal: vi.fn(async () => false),
    ...rest,
  } as unknown as NativeBridge;
  return { bridge, sessions, remotes, pins };
}

export interface Reply {
  readonly status?: number;
  readonly body: unknown;
}

/** 按「方法 路径」应答的 fetch 替身；没登记的路径答 404。 */
export function routedFetch(
  routes: Record<string, (init: RequestInit, url: URL) => Reply>,
) {
  const calls: { key: string; init: RequestInit; url: URL }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${url.pathname}`;
      calls.push({ key, init: init ?? {}, url });
      const route = routes[key];
      const reply = route
        ? route(init ?? {}, url)
        : { status: 404, body: { code: "not_found", message: "" } };
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => reply.body,
      } as unknown as Response;
    },
  ) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}
