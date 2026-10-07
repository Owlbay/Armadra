import { request } from "node:http";
import { randomUUID } from "node:crypto";
import {
  CONTROLLER_LIMITS,
  CONTROLLER_PATH,
  CONTROLLER_PROTOCOL,
  type ControllerMethod,
  type ControllerReply,
} from "@armadra/shared";
import { read } from "../../core/endpoints";
import { endpointsFile } from "../../core/paths";

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}
export function exitCode(code: string): number {
  if (
    [
      "protocol_mismatch",
      "instance_mismatch",
      "core_unavailable",
      "unsupported_platform",
    ].includes(code)
  )
    return 3;
  if (
    [
      "authorization_required",
      "authorization_revoked",
      "scope_denied",
      "scope_changed",
      "origin_forbidden",
    ].includes(code)
  )
    return 4;
  if (
    [
      "revision_conflict",
      "lease_held",
      "node_busy",
      "idempotency_conflict",
      "run_stopped",
      "cursor_ahead",
    ].includes(code)
  )
    return 5;
  if (["internal_error", "output_limit"].includes(code)) return 6;
  if (code === "result_unknown") return 7;
  return 2;
}

/** Pure Node transport. No database, scheduling, PTY, automatic retries or core launch. */
export class ControllerClient {
  constructor(
    private readonly directory: string,
    platform = process.platform,
  ) {
    if (platform === "win32")
      throw new CliError(
        "unsupported_platform",
        "Local controller v1 supports macOS and Linux Unix sockets",
        3,
      );
  }
  async call(
    method: ControllerMethod,
    params: Record<string, unknown>,
    credential?: string,
    idempotencyKey?: string,
    timeoutMs = 10_000,
  ): Promise<ControllerReply> {
    const hint = read(endpointsFile(this.directory)).controller;
    if (!hint?.socket || !hint.instanceId)
      throw new CliError(
        "core_unavailable",
        "No controller found. Start Armadra with the existing desktop or core command, or select --data-dir",
        3,
      );
    const requestId = randomUUID();
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: CONTROLLER_PROTOCOL,
        instanceId: hint.instanceId,
        requestId,
        method,
        params,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    );
    if (payload.length > CONTROLLER_LIMITS.bodyBytes)
      throw new CliError("body_limit", "Request exceeds 256 KiB", 2);
    return new Promise((resolve, reject) => {
      let sent = false;
      const mutation = [
        "connect",
        "disconnect",
        "graph.apply",
        "run.start",
        "run.cancel",
      ].includes(method);
      const call = request(
        {
          socketPath: hint.socket,
          path: CONTROLLER_PATH,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": payload.length,
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > CONTROLLER_LIMITS.responseBytes)
              call.destroy(
                new CliError(
                  "output_limit",
                  "Controller response exceeds 32 KiB",
                  6,
                ),
              );
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const body = JSON.parse(
                Buffer.concat(chunks).toString(),
              ) as ControllerReply;
              if (
                body.schemaVersion !== CONTROLLER_PROTOCOL ||
                body.requestId !== requestId ||
                typeof body.ok !== "boolean" ||
                (!body.ok && !body.error)
              )
                throw new Error("invalid envelope");
              resolve(body);
            } catch {
              reject(
                new CliError(
                  mutation ? "result_unknown" : "protocol_mismatch",
                  "Invalid controller response; reconcile before retrying a mutation",
                  mutation ? 7 : 3,
                ),
              );
            }
          });
        },
      );
      call.once("finish", () => {
        sent = true;
      });
      call.setTimeout(timeoutMs, () =>
        call.destroy(new Error("request timeout")),
      );
      call.once("error", (error) =>
        reject(
          error instanceof CliError
            ? error
            : new CliError(
                sent && mutation ? "result_unknown" : "core_unavailable",
                sent && mutation
                  ? "Response lost; use the same idempotency key to reconcile"
                  : "Cannot reach the discovered core controller",
                sent && mutation ? 7 : 3,
              ),
        ),
      );
      call.end(payload);
    });
  }
}
