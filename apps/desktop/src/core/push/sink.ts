import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dev-stack 的 push-sink（`tools/dev-stack/push-sink.mjs`），在测试进程里起一份。
 *
 * 用例对着它跑，与 `pnpm dev-stack up` 起的那个容器是同一份代码：请求形状、
 * JWT 校验与「按令牌前缀答错」的约定只有一处。路径是运行时拼的，所以 tsc 不去
 * 解析这个 `.mjs`；这里补上用例用到的那几样类型。只给测试用。
 */

export interface SinkRecord {
  readonly kind:
    | "apns"
    | "fcm"
    | "fcm-token"
    | "webpush"
    | "unifiedpush"
    | "relay";
  readonly method: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly status: number;
  readonly deviceToken?: string | null;
  readonly subscription?: string;
  readonly topic?: string;
  readonly jwt?: {
    readonly ok?: boolean;
    readonly reason?: string | null;
    readonly header: Record<string, unknown> | null;
    readonly claims: Record<string, unknown> | null;
    readonly signature?: string | null;
  } | null;
}

export interface Sink {
  readonly base: string;
  readonly records: SinkRecord[];
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const PUSH_SINK_MODULE = resolve(
  here,
  "../../../../../tools/dev-stack/push-sink.mjs",
);

export async function startSink(
  options: { keyDir?: string } = {},
): Promise<Sink> {
  const module = (await import(PUSH_SINK_MODULE)) as {
    startPushSink(options: { port: number; keyDir?: string }): Promise<Sink>;
  };
  return module.startPushSink({
    port: 0,
    ...(options.keyDir === undefined ? {} : { keyDir: options.keyDir }),
  });
}

/** 一条记录的正文（push-sink 存的是 base64）。 */
export function bodyOf(record: SinkRecord): Buffer {
  return Buffer.from(record.body, "base64");
}

/**
 * 同一份 push-sink 的路由，不过 socket：把 `fetch` 的请求直接交给它的
 * `handle`。推送域的用例要验的是「交给了哪个发送器、答复怎么处置」，不是
 * 线上那一跳；线上形状由各发送器对 {@link startSink} 的用例守着。在满载的
 * CI 机器上，一次真 HTTP 往返可能拖到发送器的 15 秒超时，于是被记成可重试、
 * 排到 5 秒之后，`dispatcher.idle()` 先回来了——断言就落在一次网络抖动上。
 */
export async function inMemorySink(): Promise<{
  readonly fetch: typeof fetch;
  readonly records: SinkRecord[];
}> {
  const module = (await import(PUSH_SINK_MODULE)) as {
    createPushSink(options: { origin?: string }): {
      readonly records: SinkRecord[];
      handle(request: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body: Buffer;
        httpVersion: string;
        origin: string;
      }): { status: number; headers: Record<string, string>; body: string };
    };
  };
  const sink = module.createPushSink({});
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? Buffer.alloc(0)
        : typeof raw === "string"
          ? Buffer.from(raw, "utf8")
          : Buffer.from(await new Response(raw).arrayBuffer());
    const outcome = sink.handle({
      method: (init?.method ?? "GET").toUpperCase(),
      path: `${url.pathname}${url.search}`,
      headers,
      body,
      httpVersion: "1.1",
      origin: url.origin,
    });
    return new Response(outcome.body, {
      status: outcome.status,
      headers: outcome.headers,
    });
  };
  return { fetch: fetcher as typeof fetch, records: sink.records };
}
