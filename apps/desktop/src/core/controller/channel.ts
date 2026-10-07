import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chmodSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONTROLLER_LIMITS,
  CONTROLLER_METHODS,
  CONTROLLER_PATH,
  CONTROLLER_PROTOCOL,
  ControllerCommandSchema,
  type ControllerCommand,
  type ControllerReply,
} from "@armadra/shared";
import { bind, release } from "../listen";
import { ControllerError } from "./errors";

export interface ControllerChannelOptions {
  readonly dataDir: string;
  readonly instanceId: string;
  readonly dispatch: (
    command: ControllerCommand,
    credential?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/** Separate listener, never registered on the browser/HTTP router. */
export async function startControllerChannel(
  options: ControllerChannelOptions,
  platform = process.platform,
) {
  if (platform === "win32") return undefined;
  const server = createServer((request, response) => {
    void handle(options, request, response);
  });
  server.requestTimeout = 70_000;
  server.headersTimeout = 5_000;
  const spec = await bind(server, {
    kind: "unix",
    path: join(options.dataDir, "controller.sock"),
  });
  // Controller authorization requires actual OS protection, not best effort.
  try {
    chmodSync(dirname(spec.kind === "unix" ? spec.path : ""), 0o700);
    chmodSync(join(options.dataDir, "controller.sock"), 0o600);
    if ((lstatSync(options.dataDir).mode & 0o777) !== 0o700)
      throw new Error("private directory required");
  } catch (error) {
    server.close();
    release(spec);
    throw error;
  }
  return {
    spec,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          release(spec);
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

async function handle(
  options: ControllerChannelOptions,
  request: IncomingMessage,
  response: ServerResponse,
) {
  let requestId = "unknown";
  const answer = (status: number, body: ControllerReply) => {
    let bytes = Buffer.from(JSON.stringify(body) + "\n");
    if (bytes.length > CONTROLLER_LIMITS.responseBytes) {
      status = 500;
      bytes = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          requestId,
          error: { code: "output_limit", message: "Read a smaller page" },
        }) + "\n",
      );
    }
    if (response.destroyed) return;
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": bytes.length,
      "cache-control": "no-store",
    });
    response.end(bytes);
  };
  try {
    if (request.headers.origin !== undefined)
      throw new ControllerError(
        "origin_forbidden",
        "Browser requests cannot use the local controller",
        403,
      );
    if (request.url !== CONTROLLER_PATH)
      throw new ControllerError(
        "not_found",
        "Unknown controller endpoint",
        404,
      );
    if (request.method !== "POST")
      throw new ControllerError(
        "method_not_allowed",
        "Only POST is supported",
        405,
      );
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > CONTROLLER_LIMITS.bodyBytes) {
        // The rest of the body stays unread; never reuse this connection.
        response.shouldKeepAlive = false;
        throw new ControllerError("body_limit", "Request exceeds 256 KiB", 413);
      }
      chunks.push(Buffer.from(chunk));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new ControllerError("invalid_arguments", "Expected a JSON command");
    }
    const record = raw as Partial<ControllerCommand> | null;
    if (typeof record?.requestId === "string")
      requestId = record.requestId.slice(0, 128);
    if (record && record.schemaVersion !== CONTROLLER_PROTOCOL)
      throw new ControllerError(
        "protocol_mismatch",
        "Controller protocol version must be 1",
        409,
      );
    if (record && !CONTROLLER_METHODS.includes(record.method!))
      throw new ControllerError("unknown_method", "Unknown controller method");
    const parsed = ControllerCommandSchema.safeParse(raw);
    if (!parsed.success)
      throw new ControllerError(
        "invalid_arguments",
        "Invalid controller command",
      );
    if (parsed.data.instanceId !== options.instanceId)
      throw new ControllerError(
        "instance_mismatch",
        "Discovery points at a different core instance",
        409,
      );
    const credential = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]+)$/,
    )?.[1];
    const abort = new AbortController();
    response.once("close", () => abort.abort());
    const data = await options.dispatch(parsed.data, credential, abort.signal);
    answer(200, { schemaVersion: 1, ok: true, requestId, data });
  } catch (error) {
    const failure =
      error instanceof ControllerError
        ? error
        : new ControllerError(
            "internal_error",
            "Controller operation failed",
            500,
          );
    answer(failure.status, {
      schemaVersion: 1,
      ok: false,
      requestId,
      error: { code: failure.code, message: failure.message },
    });
  }
}
