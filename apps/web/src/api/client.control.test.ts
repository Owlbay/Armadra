import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { controlClient, errorCode } from "./client";
import type { Source } from "./source";
import { resetControlChannel } from "./ws";

/**
 * 控制面客户端（契约 §35）：订阅断线之后由重试插件在新连接上重订，并把最后
 * 一个事件 `id` 作为 `last-event-id` 交回 core；续不上的拒绝原样交给调用方。
 * 这里的「core」是一个说 peer 帧的假 socket。
 */

interface Request {
  readonly id: string;
  readonly path: string;
  readonly input: unknown;
  readonly headers: Record<string, string>;
}

class PeerSocket {
  static instances: PeerSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly requests: Request[] = [];

  constructor(readonly url: string) {
    PeerSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string) {
    const message = JSON.parse(data) as {
      i: string;
      t?: number;
      p?: { u: string; b?: { json?: unknown }; h?: Record<string, string> };
    };
    if (message.t !== undefined || message.p === undefined) return;
    this.requests.push({
      id: message.i,
      path: message.p.u,
      input: message.p.b?.json,
      headers: message.p.h ?? {},
    });
  }

  reply(id: string, payload: object) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ i: id, ...payload }),
      }),
    );
  }

  /** 订阅的响应头：之后是事件。 */
  stream(id: string) {
    this.reply(id, { p: { h: { "content-type": "text/event-stream" } } });
  }

  event(id: string, json: unknown, eventId?: string) {
    this.reply(id, {
      t: 3,
      p: {
        e: "message",
        d: { json },
        ...(eventId === undefined ? {} : { m: { id: eventId } }),
      },
    });
  }

  close() {
    this.readyState = 3;
  }

  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

const source: Source = {
  sourceId: "control-test",
  httpBase: "http://core.test",
  wsBase: "http://core.test",
  credentials: {
    mode: "none",
    access: async () => null,
    renew: async () => false,
    csrf: async () => null,
    renewCsrf: async () => null,
  },
  fetch: globalThis.fetch,
  WebSocket: PeerSocket as unknown as typeof WebSocket,
};

const latest = () => PeerSocket.instances.at(-1) as PeerSocket;

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let index = 0; index < 200; index += 1) {
    const value = read();
    if (value !== undefined) return value;
    await vi.advanceTimersByTimeAsync(10);
  }
  throw new Error("等不到");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  PeerSocket.instances = [];
});

afterEach(() => {
  resetControlChannel(source);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("controlClient", () => {
  it("订阅断线后在新连接上重订，带 last-event-id", async () => {
    const client = controlClient(source);
    const items: unknown[] = [];
    const controller = new AbortController();
    const reading = (async () => {
      const iterator = await client.workspaces.events(
        { workspaceId: "w1" },
        { signal: controller.signal },
      );
      for await (const item of iterator) items.push(item);
    })().catch(() => undefined);

    const first = await until(() => latest()?.requests[0]);
    expect(first.path).toBe("/workspaces/events");
    expect(first.input).toEqual({ workspaceId: "w1" });
    expect(first.headers["last-event-id"]).toBeUndefined();
    latest().stream(first.id);
    latest().event(
      first.id,
      { type: "cursor", cursor: 7, floor: 0, watermark: 7 },
      "7",
    );
    latest().event(
      first.id,
      { type: "workspace.updated", workspaceId: "w1" },
      "8",
    );
    await until(() => (items.length >= 2 ? true : undefined));

    latest().drop();
    const second = await until(() =>
      PeerSocket.instances.length >= 2 ? latest().requests[0] : undefined,
    );
    expect(second.path).toBe("/workspaces/events");
    expect(second.headers["last-event-id"]).toBe("8");
    latest().stream(second.id);
    latest().event(
      second.id,
      { type: "workspace.updated", workspaceId: "w1" },
      "9",
    );
    await until(() => (items.length >= 3 ? true : undefined));
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await reading;
  });

  it("续不上（snapshot_required）不重订，错误交给调用方", async () => {
    const client = controlClient(source);
    let failure: unknown;
    void (async () => {
      const iterator = await client.workspaces.events({ workspaceId: "w1" });
      for await (const _item of iterator) {
        // 不会到这里。
      }
    })().catch((error: unknown) => {
      failure = error;
    });
    const request = await until(() => latest()?.requests[0]);
    latest().reply(request.id, {
      p: {
        s: 409,
        b: {
          json: {
            defined: true,
            code: "snapshot_required",
            status: 409,
            message: "掉出保留下限",
          },
        },
      },
    });
    await until(() => failure);
    expect(errorCode(failure)).toBe("snapshot_required");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latest().requests).toHaveLength(1);
  });
});
