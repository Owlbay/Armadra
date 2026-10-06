import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { emptyRequest } from "../http/router";
import type { CoreServer } from "../http/server";
import { type RequestIdentity, runAs } from "../identity/gate";
import { type JsonValue, canonicalJson } from "./message";

/**
 * 对偶测试的共用件（E3-8b 的五个域）：同一份夹具问三次——路由表里的原 handler、旧
 * REST 路径（经 HTTP，由契约实现经 `OpenAPIHandler` 答）、新 procedure。谁在问由
 * 名字决定（`resolve` 把名字换成请求身份；`undefined` 是桌面壳的本机请求），HTTP 两路
 * 经准入门里的 `x-parity-as` 头带过去，路由表那一路直接 `runAs`。
 *
 * 只给测试用：它 import vitest。
 */

export interface Answer {
  readonly status: number;
  readonly body: unknown;
  /** 小写头名；只收测试关心的（`retry-after`）。 */
  readonly retryAfter?: string;
}

export type Resolve = (name: string) => RequestIdentity | undefined;

export interface Kit {
  readonly base: string;
  table(
    method: string,
    path: string,
    body?: unknown,
    as?: string,
  ): Promise<Answer>;
  legacy(
    method: string,
    path: string,
    body?: unknown,
    as?: string,
  ): Promise<Answer>;
  procedure(name: string, input?: unknown, as?: string): Promise<Answer>;
}

/** 给服务器装上准入门并开一个监听；`resolve` 答不出的名字就是匿名。 */
export async function startKit(
  server: CoreServer,
  resolve: Resolve,
): Promise<Kit> {
  server.admission((request) => {
    const who = request.headers["x-parity-as"];
    if (typeof who !== "string") return {};
    const identity = resolve(who);
    return identity === undefined ? {} : { identity };
  });
  const listener = server.createListener();
  await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  return {
    base,
    async table(method, path, body, as) {
      const url = new URL(path, "http://core");
      const encoded = Buffer.from(
        body === undefined ? "" : JSON.stringify(body),
        "utf8",
      );
      const request = {
        ...emptyRequest(method, url.pathname),
        query: url.searchParams,
        body: encoded,
        // 路由表那一路没有套接字：给一个固定的来源（与回环上的 HTTP 两路不同）。
        raw: { socket: { remoteAddress: "198.51.100.9" } } as never,
        json: <T>() => JSON.parse(encoded.toString("utf8")) as T,
      };
      const run = () => server.router.dispatch(method, url.pathname, request);
      const identity = as === undefined ? undefined : resolve(as);
      const answer = await (identity === undefined
        ? run()
        : runAs(identity, run));
      const wait =
        "headers" in answer ? answer.headers?.["retry-after"] : undefined;
      return {
        status: answer.status,
        body: answer.body,
        ...(wait === undefined ? {} : { retryAfter: wait }),
      };
    },
    async legacy(method, path, body, as) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (as !== undefined) headers["x-parity-as"] = as;
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const wait = response.headers.get("retry-after");
      return {
        status: response.status,
        body: text === "" ? undefined : JSON.parse(text),
        ...(wait === null ? {} : { retryAfter: wait }),
      };
    },
    async procedure(name, input, as) {
      const response = await fetch(
        `${base}/api/rpc/${name.replace(".", "/")}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(as === undefined ? {} : { "x-parity-as": as }),
          },
          body: JSON.stringify(input === undefined ? {} : { json: input }),
        },
      );
      const text = await response.text();
      const wait = response.headers.get("retry-after");
      const body = (text === "" ? {} : JSON.parse(text)) as Record<
        string,
        unknown
      >;
      if (response.ok) return { status: response.status, body: body.json };
      expect(typeof body.requestId, "错误带 requestId").toBe("string");
      const { requestId: _requestId, ...rest } = body;
      return {
        status: response.status,
        body: rest,
        ...(wait === null ? {} : { retryAfter: wait }),
      };
    },
  };
}

/** 把每次都会变的字段换成占位，再编成规范 JSON。 */
export function stable(
  value: unknown,
  volatile: ReadonlySet<string> = new Set(),
): JsonValue {
  if (Array.isArray(value)) return value.map((one) => stable(one, volatile));
  if (value === null || typeof value !== "object") {
    return (value ?? null) as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    out[key] = volatile.has(key) ? "<volatile>" : stable(field, volatile);
  }
  return out;
}

export const text = (
  answer: Answer,
  volatile: ReadonlySet<string> = new Set(),
): string => canonicalJson(stable(answer.body, volatile));

/**
 * 三种答法：成功时 procedure 恒为 200，旧路径的状态是契约登记的
 * `successStatus`（`legacyStatus`，缺省与原 handler 一样）；失败的状态相等；体规范化
 * 后逐字节相等。
 */
export function expectParity(
  [old, rest, rpc]: readonly [Answer, Answer, Answer],
  options: {
    volatile?: ReadonlySet<string>;
    legacyStatus?: number;
  } = {},
): void {
  const failed = old.status >= 400;
  expect(rest.status, "旧路径的状态").toBe(
    failed ? old.status : (options.legacyStatus ?? old.status),
  );
  expect(rpc.status, "procedure 的状态").toBe(failed ? old.status : 200);
  expect(text(rest, options.volatile), "旧路径的体").toBe(
    text(old, options.volatile),
  );
  expect(text(rpc, options.volatile), "procedure 的体").toBe(
    text(old, options.volatile),
  );
}
