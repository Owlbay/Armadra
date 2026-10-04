import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { type ListenSpec, bind, release } from "../listen";
import { IdentityError, identityFailure } from "./errors";
import { nativeOrigin } from "./origin";
import { allScopes } from "./scopes";
import type { IdentityService } from "./service";
import { validName } from "./tokens";

/**
 * 私有控制通道：签票的那一头。
 *
 * 签一张一次性票是**特权操作**——谁拿到票谁就能换一个全权会话。所以它不在公开
 * 的那个监听上，而在数据目录下一个 0600 的 Unix socket 上：文件权限就是鉴权，
 * 只有同一个操作系统用户的进程连得上，网络上没有这个地址。
 *
 * 桌面壳因此不再 spawn `armadra-host pair`：壳和 core 在同一棵进程树里，票据经
 * 这条通道直接取（设计 D6）。壳仍然是唯一能取票的一方，页面只能向壳要。
 *
 * 一个方法，`POST /control/identity/ticket`，请求体 `{ origin, deviceName }`，
 * 答 `armadra-host pair` 印的那个 JSON 形状——`HostIdentityClient.pair()` 原样
 * 收得下，所以前端一行不用改。
 *
 * TODO(R6)：Windows 上换成命名管道，并带上受保护的 DACL 与逐连接的客户端 SID
 * 核对；`node:net` 建出来的普通管道实例达不到这条通道要求的隔离，所以在
 * Windows 上这条通道不开；壳在那里走另一条取票路径。
 */

export const CONTROL_SOCKET = "core-control.sock";
export const TICKET_PATH = "/control/identity/ticket";

/** 请求体本身就是几十个字节；超过这个数的不是一次取票。 */
const MAX_CONTROL_BODY = 8192;

export function controlSocketPath(dataDir: string): string {
  return join(dataDir, CONTROL_SOCKET);
}

export interface ControlChannel {
  readonly spec: ListenSpec;
  close(): Promise<void>;
}

export interface ControlOptions {
  readonly service: IdentityService;
  readonly instanceId: string;
  readonly dataDir: string;
  readonly log?: { warn(message: string, fields?: unknown): void };
}

export async function startControlChannel(
  options: ControlOptions,
): Promise<ControlChannel | undefined> {
  if (process.platform === "win32") {
    options.log?.warn("身份私有通道在 Windows 上尚未实现（R6），本次不开");
    return undefined;
  }
  const server: Server = createServer((request, response) => {
    void handle(options, request, response);
  });
  const spec = await bind(server, {
    kind: "unix",
    path: controlSocketPath(options.dataDir),
  });
  return {
    spec,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          release(spec);
          resolve();
        });
        // A keep-alive client on the control socket would otherwise hold
        // `close` open, and with it the whole core's shutdown.
        server.closeAllConnections();
      }),
  };
}

async function handle(
  options: ControlOptions,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const answer = (status: number, body: unknown): void => {
    const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    response.end(payload);
  };
  const path = new URL(request.url ?? "/", "http://control").pathname;
  if (path !== TICKET_PATH) {
    answer(404, { code: "not_found", message: `没有这个接口：${path}` });
    return;
  }
  if (request.method !== "POST") {
    answer(405, { code: "method_not_allowed", message: "只接受 POST" });
    return;
  }
  let body: Buffer;
  try {
    body = await read(request, MAX_CONTROL_BODY);
  } catch (error) {
    answer(413, {
      code: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(body.toString("utf8") || "null");
  } catch {
    input = undefined;
  }
  const issued = issueShellTicket(options, input);
  answer(issued.status, issued.body);
}

/**
 * 签一张给桌面壳页面的票：私有通道（Unix socket）与 fork 的 IPC 通道共用这一段。
 * 答的是 `armadra-host pair` 印的那个形状；拒绝是 `{ code, message }`。
 */
export function issueShellTicket(
  options: Pick<ControlOptions, "service" | "instanceId">,
  input: unknown,
): { status: number; body: Record<string, unknown> } {
  try {
    const request = input as {
      origin?: unknown;
      deviceName?: unknown;
    } | null;
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.origin !== "string" ||
      typeof request.deviceName !== "string" ||
      !validName(request.deviceName) ||
      // 这条通道只给桌面壳签票，壳的来源永远是回环明文 HTTP。别的来源（比如
      // R6 的服务器壳要给手机配对的那种）走的是另一条路，不是这里。
      !nativeOrigin(request.origin)
    ) {
      throw new IdentityError("invalid");
    }
    const hostId = options.service.hostId();
    const ticket = options.service.issueBootstrap({
      hostId,
      instanceId: options.instanceId,
      origin: request.origin,
      deviceName: request.deviceName,
      // 壳配对的是本机自己，拿全套授权。空授权不会悄悄扩张成全权，得写出来。
      scopes: allScopes(),
    });
    // `armadra-host pair --output protobuf` 解码后的那个形状，逐字对齐：毫秒是
    // 十进制字符串，因为页面拿 bigint 比较它。
    return {
      status: 200,
      body: {
        hostId,
        hostInstanceId: options.instanceId,
        origin: request.origin,
        ticket: ticket.ticket,
        expiresAtUnixMs: String(ticket.expiresAtMs),
      },
    };
  } catch (error) {
    const failure = identityFailure(error);
    return {
      status: failure.status,
      body: { code: failure.code, message: failure.message },
    };
  }
}

/* --------------------------- fork 的 IPC 通道 ---------------------------- */

/**
 * Windows 上的取票路（契约 §3.2，安全审查 L9）。
 *
 * 私有通道在 Windows 上还不开（见上面的 TODO），而回环不再放行匿名请求之后，
 * 壳的页面没有票就什么都打不了。桌面壳的 core 是 `child_process.fork` 出来的，
 * fork 自带一条只连着父进程的 IPC 通道——只有起它的那个壳能在上面说话，这比
 * 文件权限更窄。所以 Windows 上票经这条通道签（`main/core-ticket.ts` 那一头），
 * 和密钥封存（`core/secrets/ipc.ts`）同一条通道、同一种「带 id 的请求 / 应答」。
 *
 *     壳 → core  { type: "armadra:identity-ticket", id, origin, deviceName }
 *     core → 壳  { type: "armadra:identity-ticket", id, status, body }
 *
 * `status` / `body` 与私有通道的 HTTP 答案逐字相同，壳那一头按同一套规矩核对。
 */
export const TICKET_MESSAGE = "armadra:identity-ticket";

export interface TicketIpcRequest {
  readonly type: typeof TICKET_MESSAGE;
  readonly id: number;
  readonly origin: string;
  readonly deviceName: string;
}

export interface TicketIpcResponse {
  readonly type: typeof TICKET_MESSAGE;
  readonly id: number;
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** fork 的子进程那一端：`process` 本身就满足它。 */
export interface TicketIpcChannel {
  send?: ((message: unknown) => boolean) | undefined;
  readonly connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

function ticketRequest(message: unknown): message is TicketIpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === TICKET_MESSAGE &&
    typeof (message as { id?: unknown }).id === "number"
  );
}

/**
 * 在 fork 的 IPC 通道上应答取票。没有通道（不是壳 fork 的 core）时什么也不做，
 * 返回 `false`。别的消息不归这里管，原样忽略。
 */
export function startTicketIpc(
  options: Pick<ControlOptions, "service" | "instanceId">,
  channel: TicketIpcChannel,
): boolean {
  if (channel.send === undefined) return false;
  channel.on("message", (message) => {
    if (!ticketRequest(message)) return;
    const issued = issueShellTicket(options, {
      origin: message.origin,
      deviceName: message.deviceName,
    });
    const response: TicketIpcResponse = {
      type: TICKET_MESSAGE,
      id: message.id,
      status: issued.status,
      body: issued.body,
    };
    try {
      if (channel.connected !== false) channel.send?.(response);
    } catch {
      // 壳已经不在：没有人等这张票。
    }
  });
  return true;
}

function read(
  request: import("node:http").IncomingMessage,
  limit: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        request.destroy();
        reject(new Error(`请求体超过 ${limit} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
