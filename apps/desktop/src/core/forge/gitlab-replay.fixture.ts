/**
 * GitLab 回放夹具：把 `fixtures/gitlab/*.json` 里的一组「请求 → 答复」当成一个
 * `fetch`。请求按方法、API 根之后的路径与给出的查询键匹配；每条请求都记下来
 * （方法、完整地址、`PRIVATE-TOKEN` 头、请求体），测试据此断言令牌只发到配置的根、
 * 写不重试。没有匹配的请求答 599，测试会看到 `unavailable`。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GITLAB_FIXTURE = {
  apiBase: "https://gitlab.example.test/api/v4",
  token: "glpat-fixture-token-0000",
  repo: { host: "gitlab.example.test", owner: "acme", name: "app" },
  sha: "3f2a9c1d7e5b4a6f8c0d2e4f6a8b0c1d2e3f4a5b",
  oldSha: "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
  mergedSha: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
} as const;

export interface Interaction {
  readonly name?: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, string>;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
}

export interface Cassette {
  readonly apiBase: string;
  readonly interactions: readonly Interaction[];
}

export const CASSETTES = [
  "user",
  "issues",
  "merge-requests",
  "diffs",
  "statuses",
  "merge",
  "refusals",
] as const;
export type CassetteName = (typeof CASSETTES)[number];

export function cassette(name: CassetteName): Cassette {
  const file = fileURLToPath(
    new URL(`./fixtures/gitlab/${name}.json`, import.meta.url),
  );
  return JSON.parse(readFileSync(file, "utf8")) as Cassette;
}

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly token: string;
  readonly body: unknown;
}

export interface Replay {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: Recorded[];
}

function headerOf(init: RequestInit | undefined, name: string): string {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return "";
}

/**
 * 把几份录像合成一个 `fetch`。同一请求有多条时，`pick` 里点名的那条优先（按
 * `name`；起了名字的只在点名时答），其余取查询键最具体的那条。
 */
export function replay(
  names: readonly CassetteName[],
  pick: readonly string[] = [],
): Replay {
  const interactions = names.flatMap((name) => cassette(name).interactions);
  const requests: Recorded[] = [];
  const base = new URL(GITLAB_FIXTURE.apiBase);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    let body: unknown;
    if (init?.body !== undefined && init.body !== null) {
      body = JSON.parse(
        Buffer.from(init.body as Uint8Array).toString("utf8"),
      ) as unknown;
    }
    // 路径保持编码（`acme%2Fapp`），与录像里的写法逐字比较。
    const raw = String(input).slice(url.origin.length).split("?")[0] ?? "";
    const path =
      url.origin === base.origin && raw.startsWith(base.pathname)
        ? raw.slice(base.pathname.length)
        : raw;
    requests.push({
      method,
      url: String(input),
      path,
      query,
      token: headerOf(init, "private-token"),
      body,
    });
    // 查询键给得越多越具体：第二页的请求也带着第一页那条的 `per_page`。
    const specificity = (entry: Interaction) =>
      Object.keys(entry.request.query ?? {}).length;
    const candidates = interactions
      .filter(
        (entry) =>
          entry.request.method === method &&
          entry.request.path === path &&
          Object.entries(entry.request.query ?? {}).every(
            ([key, value]) => query[key] === value,
          ),
      )
      .sort((a, b) => specificity(b) - specificity(a));
    // 起了名字的是拒绝录像：只在点名时才答，免得盖过正常的那条。
    const chosen =
      candidates.find((entry) => pick.includes(entry.name ?? "")) ??
      candidates.find((entry) => entry.name === undefined);
    if (chosen === undefined || url.origin !== base.origin) {
      return new Response("no recorded interaction", { status: 599 });
    }
    const { status, headers, body: answer } = chosen.response;
    return new Response(status === 204 ? null : JSON.stringify(answer), {
      status,
      headers,
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}
