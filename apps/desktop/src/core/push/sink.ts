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
  readonly kind: "apns" | "fcm" | "fcm-token" | "webpush" | "relay";
  readonly method: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly status: number;
  readonly deviceToken?: string | null;
  readonly subscription?: string;
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
