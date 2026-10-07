import { WebSocket } from "ws";

import { CONTROL_PATH, CONTROL_PROTOCOL } from "./ws-control";

/**
 * 测试用的控制面客户端：直接说上游 RPC 的 peer 帧（契约 §35.1 的线上样子），
 * 不经 `@orpc/client`——core 不依赖它，而用例要验的正是线上的帧。
 *
 *   请求 `{ i, p: { u: "/<域>/<动词>", b: { json: 入参 }, h? } }`
 *   响应 `{ i, p: { s?, h?, b: { json } } }`；订阅的响应头 `content-type:
 *        text/event-stream`，之后是 `{ i, t: 3, p: { e: "message" | "error" |
 *        "done", d: { json }, m?: { id } } }`
 *   取消 `{ i, t: 4 }`
 */

export interface PeerResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface PeerEvent {
  readonly event: "message" | "error" | "done";
  readonly data: unknown;
  readonly id?: string;
}

export class Peer {
  private sequence = 0;
  private readonly waiting = new Map<
    string,
    (response: PeerResponse) => void
  >();
  readonly events = new Map<string, PeerEvent[]>();
  private readonly eventWaiters = new Set<() => void>();
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) =>
      socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        i: string;
        t?: number;
        p: Record<string, unknown>;
      };
      if (message.t === 3) {
        const payload = message.p as {
          e: PeerEvent["event"];
          d?: { json?: unknown };
          m?: { id?: string };
        };
        const list = this.events.get(message.i) ?? [];
        list.push({
          event: payload.e,
          data: payload.d?.json,
          ...(payload.m?.id === undefined ? {} : { id: payload.m.id }),
        });
        this.events.set(message.i, list);
        for (const wake of [...this.eventWaiters]) wake();
        return;
      }
      if (message.t === 4) return;
      const payload = message.p as {
        s?: number;
        h?: Record<string, string>;
        b?: { json?: unknown };
      };
      this.waiting.get(message.i)?.({
        status: payload.s ?? 200,
        headers: payload.h ?? {},
        body: payload.b?.json,
      });
      this.waiting.delete(message.i);
    });
  }

  /** 发一次调用，返回它的 id 与响应。 */
  call(
    procedure: string,
    input: unknown,
    headers?: Record<string, string>,
  ): { id: string; response: Promise<PeerResponse> } {
    const id = String((this.sequence += 1));
    const response = new Promise<PeerResponse>((resolve) =>
      this.waiting.set(id, resolve),
    );
    this.socket.send(
      JSON.stringify({
        i: id,
        p: {
          u: `/${procedure.split(".").join("/")}`,
          b: { json: input },
          ...(headers === undefined ? {} : { h: headers }),
        },
      }),
    );
    return { id, response };
  }

  /** 取消一个订阅。 */
  abort(id: string): void {
    this.socket.send(JSON.stringify({ i: id, t: 4 }));
  }

  /** 等某个订阅攒够 `count` 项（或出现 error / done）。 */
  async until(
    id: string,
    test: (events: PeerEvent[]) => boolean,
    timeoutMs = 5_000,
  ): Promise<PeerEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const list = this.events.get(id) ?? [];
      if (test(list)) return list;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `订阅 ${id} 没等到：${JSON.stringify(list).slice(-400)}`,
        );
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.eventWaiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.eventWaiters.add(wake);
      });
    }
  }
}

/** 连上 `/api/ws`。`protocols` 缺省只报控制面的子协议。 */
export function connectPeer(
  base: string,
  protocols: readonly string[] = [CONTROL_PROTOCOL],
  options: { readonly autoPong?: boolean; readonly origin?: string } = {},
): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `${base.replace(/^http/, "ws")}${CONTROL_PATH}`,
      [...protocols],
      { origin: base, ...options },
    );
    const peer = new Peer(socket);
    socket.once("open", () => resolve(peer));
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`upgrade ${response.statusCode}`)),
    );
  });
}
