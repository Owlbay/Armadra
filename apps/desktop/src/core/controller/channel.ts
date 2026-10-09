import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The longest Unix socket path `bind(2)` takes, terminating NUL excluded:
 * `sun_path` is 104 bytes on macOS and the BSDs, 108 on Linux.
 */
export function maxSocketPath(platform = process.platform): number {
  return platform === "linux" ? 107 : 103;
}

/**
 * Where the controller socket goes. Normally `<dataDir>/controller.sock`; a
 * data directory deep enough that the path no longer fits `sun_path` (a
 * temporary directory on macOS is already ~50 bytes) moves it to a private
 * per-data-directory folder under the temporary directory. Clients never
 * derive the path — they read it from `endpoints.json` — so moving it costs
 * nothing, while refusing it would take the whole core down with `EINVAL`.
 */
export function controllerSocketPath(
  dataDir: string,
  platform = process.platform,
  temporary = tmpdir(),
): string {
  const preferred = join(dataDir, "controller.sock");
  if (Buffer.byteLength(preferred) <= maxSocketPath(platform)) return preferred;
  const digest = createHash("sha256").update(dataDir).digest("hex");
  return join(temporary, `armadra-ctl-${digest.slice(0, 16)}`, "c.sock");
}

/**
 * The fallback folder is in a shared temporary directory on Linux: it must be
 * ours, a real directory and 0700, or someone else could sit between the CLI
 * and the core.
 */
function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid))
    throw new Error(`${path} is not a private directory of this user`);
  chmodSync(path, 0o700);
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
  const path = controllerSocketPath(options.dataDir, platform);
  const directory = dirname(path);
  if (directory !== options.dataDir) ensurePrivateDirectory(directory);
  const spec = await bind(server, { kind: "unix", path });
  // Controller authorization requires actual OS protection, not best effort.
  try {
    chmodSync(directory, 0o700);
    chmodSync(path, 0o600);
    if ((lstatSync(directory).mode & 0o777) !== 0o700)
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

const DRAIN_BYTES = CONTROLLER_LIMITS.bodyBytes * 4;

/**
 * Reads and discards what is left of the request body, up to `DRAIN_BYTES`, so
 * the client finishes writing before it reads an early rejection; answering
 * mid-upload races the client's write and surfaces as EPIPE instead of the
 * reply. Returns false when the body is too large or the stream failed.
 */
async function drain(request: IncomingMessage): Promise<boolean> {
  if (request.readableEnded) return true;
  let seen = 0;
  try {
    for await (const chunk of request) {
      seen += (chunk as Buffer).length;
      if (seen > DRAIN_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
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
      // Keep reading an oversized body (see `drain`) before answering 413.
      if (length > DRAIN_BYTES) {
        response.destroy();
        return;
      }
      if (length <= CONTROLLER_LIMITS.bodyBytes)
        chunks.push(Buffer.from(chunk));
    }
    if (length > CONTROLLER_LIMITS.bodyBytes)
      throw new ControllerError("body_limit", "Request exceeds 256 KiB", 413);
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
    if (!(await drain(request))) {
      response.destroy();
      return;
    }
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
