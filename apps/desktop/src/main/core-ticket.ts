import type { ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import {
  TICKET_MESSAGE,
  type TicketIpcRequest,
  type TicketIpcResponse,
} from "../core/identity/control";

import {
  type NativeTicket,
  NativeTicketError,
  TICKET_OUTPUT_LIMIT,
  checkCoreTicket,
  nativeOrigin,
} from "../shell-core/ticket";

/**
 * 从 core 的私有通道取一张原生会话票——页面能向壳要的唯一一样东西。
 *
 * 规则在 `shell-core/ticket.ts`，这个文件只是那一次 HTTP 往返。core 与壳在同一
 * 棵进程树里，通道是数据目录下一个 0600 的 Unix socket，文件权限就是鉴权（设计
 * D6）。
 */

/** core 的私有通道，和 `core/identity/control.ts` 里那个名字是同一个。 */
export const CORE_CONTROL_SOCKET = "core-control.sock";

/** 一次取票最多等这么久；通道在同一台机器上，慢只可能是没人在听。 */
const CORE_TICKET_TIMEOUT_MS = 5_000;

/** core 记下的这台机器的设备名。 */
export function deviceName(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "本机桌面" : "This desktop";
}

/**
 * 签一张票。
 *
 * 失败只带一个稳定标记：通道不在、core 还没起来，都是 `hostUnavailable`；core
 * 拒绝签票（来源不是壳能呈现的那种）是 `originUnsupported`。
 */
export async function issueCoreTicket(options: {
  readonly dataDir: string;
  readonly origin: string;
  readonly deviceName: string;
  /** 测试用；缺省是这台机器的平台。 */
  readonly platform?: NodeJS.Platform;
}): Promise<NativeTicket> {
  if (!nativeOrigin(options.origin)) {
    throw new NativeTicketError("originUnsupported");
  }
  if (options.deviceName.trim() === "") {
    throw new NativeTicketError("hostUnavailable");
  }
  let answer: { status: number; body: string };
  try {
    const payload = { origin: options.origin, deviceName: options.deviceName };
    answer =
      (options.platform ?? process.platform) === "win32"
        ? await requestOverIpc(payload)
        : await requestOverSocket(
            join(options.dataDir, CORE_CONTROL_SOCKET),
            payload,
          );
  } catch (error) {
    if (error instanceof NativeTicketError) throw error;
    throw new NativeTicketError(
      (error as NodeJS.ErrnoException).code === "ETIMEDOUT"
        ? "timeout"
        : "hostUnavailable",
    );
  }
  if (answer.status === 400) throw new NativeTicketError("originUnsupported");
  if (answer.status !== 200) throw new NativeTicketError("cliFailed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new NativeTicketError("malformed");
  }
  return checkCoreTicket(parsed, options.origin, Date.now());
}

function requestOverSocket(
  socketPath: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: "/control/identity/ticket",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
        timeout: CORE_TICKET_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > TICKET_OUTPUT_LIMIT) {
            response.destroy();
            reject(new Error("ticket response exceeds its limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => {
      const error: NodeJS.ErrnoException = new Error(
        "ticket request timed out",
      );
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end(body);
  });
}

/* --------------------------- Windows：fork 的 IPC --------------------------- */

/**
 * Windows 上 core 的私有通道还不开（`core/identity/control.ts` 的 TODO），票经
 * fork 自带的 IPC 通道签：只有起这个 core 的壳在那条通道的另一头（契约 §3.2，
 * 安全审查 L9）。壳每次 spawn 都把新 child 交过来；不是这个壳起的 core（接管、
 * 外部 Runtime）没有通道，取票失败为 `hostUnavailable`。
 */
type TicketChild = Pick<ChildProcess, "on" | "send" | "connected">;

let ticketChild: TicketChild | undefined;
let nextTicketId = 1;
const pendingTickets = new Map<
  number,
  {
    resolve: (answer: { status: number; body: string }) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

function ticketResponse(message: unknown): message is TicketIpcResponse {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === TICKET_MESSAGE &&
    typeof (message as { id?: unknown }).id === "number" &&
    typeof (message as { status?: unknown }).status === "number"
  );
}

/** 在一个刚 spawn 的 core 上挂取票应答。 */
export function attachTicketChannel(child: TicketChild): void {
  ticketChild = child;
  child.on("message", (message: unknown) => {
    if (!ticketResponse(message)) return;
    const waiter = pendingTickets.get(message.id);
    if (waiter === undefined) return;
    pendingTickets.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve({
      status: message.status,
      body: JSON.stringify(message.body ?? null),
    });
  });
  child.on("exit", () => {
    if (ticketChild === child) ticketChild = undefined;
    for (const [id, waiter] of pendingTickets) {
      pendingTickets.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(new Error("core exited"));
    }
  });
}

/** 测试用：忘掉上一个 child。 */
export function resetTicketChannel(): void {
  ticketChild = undefined;
  pendingTickets.clear();
}

function requestOverIpc(payload: {
  origin: string;
  deviceName: string;
}): Promise<{ status: number; body: string }> {
  const child = ticketChild;
  if (child === undefined || !child.connected || child.send === undefined) {
    // 不是这个壳起的 core：说清楚，页面据此提示重开应用，而不是静默 401。
    return Promise.reject(new NativeTicketError("channelUnavailable"));
  }
  const id = nextTicketId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTickets.delete(id);
      const error: NodeJS.ErrnoException = new Error(
        "ticket request timed out",
      );
      error.code = "ETIMEDOUT";
      reject(error);
    }, CORE_TICKET_TIMEOUT_MS);
    timer.unref?.();
    pendingTickets.set(id, { resolve, reject, timer });
    const request: TicketIpcRequest = {
      type: TICKET_MESSAGE,
      id,
      origin: payload.origin,
      deviceName: payload.deviceName,
    };
    try {
      child.send(request);
    } catch (error) {
      pendingTickets.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
