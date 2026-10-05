/**
 * `armadra-hook mcp` — the canvas, context and browser verbs as an MCP server
 * on stdio (ACP design §5.8).
 *
 * An agent driven over ACP has no terminal to run `armadra-hook canvas` in, so
 * core hands this command to it in `session/new.mcpServers` (`core/acp/mcp.ts`)
 * and the agent talks MCP to it instead. Three methods, written by hand — no
 * MCP SDK in a bundle the CLIs fork:
 *
 *   * `initialize` answers the server info, the `tools` capability and the
 *     board's rules as `instructions` (`collab/skill.ts::mcpInstructions`);
 *   * `tools/list` is `hook-client/verbs.ts::VERB_TOOLS`, unfiltered;
 *   * `tools/call` is one `POST <tool.path>` with the body and headers
 *     `armadra-hook canvas|context|browser` would have sent — same node token,
 *     same session binding for the tools that need one — so the runtime
 *     cannot tell the two callers apart and grants nothing extra.
 *
 * Framing is MCP's stdio transport: one JSON-RPC message per line, UTF-8, no
 * embedded newlines. `ping` is answered too (clients send it as a liveness
 * check), every notification is ignored, and anything else is
 * `-32601 method not found`.
 *
 * Errors follow MCP's split. A message that is not JSON-RPC, an unknown method
 * and an unknown tool are protocol errors (`error`). A tool that ran and
 * failed — bad arguments, no endpoint, a 4xx from the runtime — is a result
 * with `isError: true`, so the model reads why and can correct itself.
 *
 * Like the other loud subcommands, everything is re-read per call: the
 * endpoint file and the node token can change under a long-lived server when
 * the runtime restarts.
 */

import * as readline from "node:readline";

import { mcpInstructions } from "../../core/collab/skill.js";
import { envVar } from "../../hook-client/endpoint.js";
import { isSuccess, postJsonRequest } from "../../hook-client/http.js";
import type { JsonValue } from "../../hook-client/json.js";
import { headersFor, loadSession, send } from "../../hook-client/session.js";
import {
  VERB_TOOLS,
  type VerbTool,
  toWireArgs,
  toolByName,
} from "../../hook-client/verbs.js";
import {
  browserTimeoutMs,
  verbTimeoutMs,
  controlBody,
  render,
  renderError,
} from "./control.js";
import { CLIENT_VERSION } from "./usage.js";

/** MCP revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const MCP_SERVER_NAME = "armadra";

/** JSON-RPC 2.0 error codes the server answers with. */
export const RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

type RpcId = string | number;

interface RpcError {
  code: number;
  message: string;
}

export type McpResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId | null; error: RpcError };

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

/** One `tools/call`, injectable so the wire tests can watch it. */
export type ToolCaller = (
  tool: VerbTool,
  input: unknown,
) => Promise<McpToolResult>;

/* --------------------------------- methods -------------------------------- */

/** `initialize`: echo the client's revision when it is one of ours. */
export function initializeResult(params: unknown): Record<string, unknown> {
  const requested = (params as { protocolVersion?: unknown } | null)
    ?.protocolVersion;
  const protocolVersion =
    typeof requested === "string" &&
    (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : MCP_PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: MCP_SERVER_NAME, version: CLIENT_VERSION },
    instructions: mcpInstructions(),
  };
}

/** `tools/list`: the whole table, no pagination. */
export function toolsListResult(): { tools: Record<string, unknown>[] } {
  return {
    tools: VERB_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

const text = (body: string, isError = false): McpToolResult => ({
  content: [{ type: "text", text: body }],
  ...(isError ? { isError: true as const } : {}),
});

/**
 * The real `tools/call`: the request `armadra-hook canvas|context|browser`
 * makes, built from the same pieces (`loadSession`, `headersFor`,
 * `controlBody`, `send`) and rendered the same way.
 */
export const callTool: ToolCaller = async (tool, input) => {
  const wire = toWireArgs(tool, input);
  if ("error" in wire) return text(wire.error, true);
  const args: Record<string, JsonValue> = wire.ok;
  if (tool.binding === "session") {
    // Never from the model: the binding proves which session is asking.
    delete args["sessionId"];
    delete args["generation"];
    const session = envVar("ARMADRA_SESSION_ID");
    const generation = envVar("ARMADRA_SESSION_GENERATION");
    if (
      session !== undefined &&
      generation !== undefined &&
      /^\d+$/.test(generation)
    ) {
      args["sessionId"] = session;
      args["generation"] = Number(generation);
    } else if (tool.verb === "handoff-read") {
      return text(
        "A current terminal session binding is required; restart an older terminal.",
        true,
      );
    }
  }
  const loaded = loadSession();
  if ("error" in loaded) return text(loaded.error, true);
  const body = controlBody(loaded.ok.nodeId, args);
  const outcome = await send(
    loaded.ok,
    (current, candidate) =>
      postJsonRequest(tool.path, headersFor(current, candidate), body),
    tool.long === true ? browserTimeoutMs() : verbTimeoutMs(),
  );
  if ("error" in outcome) return text(outcome.error, true);
  if (!isSuccess(outcome.ok)) return text(renderError(outcome.ok), true);
  return text(render(outcome.ok));
};

/* --------------------------------- dispatch ------------------------------- */

const reply = (id: RpcId, result: unknown): McpResponse => ({
  jsonrpc: "2.0",
  id,
  result,
});
const failure = (
  id: RpcId | null,
  code: number,
  message: string,
): McpResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

function isId(value: unknown): value is RpcId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * Answers one line. `undefined` = nothing to send (a notification, a blank
 * line, or a response from the client — this server never sends requests).
 */
export async function handleLine(
  line: string,
  call: ToolCaller = callTool,
): Promise<McpResponse | undefined> {
  if (line.trim() === "") return undefined;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return failure(null, RPC_ERRORS.parseError, "parse error: not JSON");
  }
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    // Batches were removed from MCP in 2025-06-18; one message per line.
    return failure(
      null,
      RPC_ERRORS.invalidRequest,
      "invalid request: expected one JSON-RPC object",
    );
  }
  const object = message as Record<string, unknown>;
  const hasId = "id" in object && object["id"] !== undefined;
  const id = hasId && isId(object["id"]) ? object["id"] : null;
  if (object["jsonrpc"] !== "2.0" || (hasId && id === null)) {
    return failure(
      id,
      RPC_ERRORS.invalidRequest,
      "invalid request: not JSON-RPC 2.0",
    );
  }
  const method = object["method"];
  if (typeof method !== "string") {
    // A response (to nothing — we never ask) or garbage without an id.
    return id === null || "result" in object || "error" in object
      ? undefined
      : failure(id, RPC_ERRORS.invalidRequest, "invalid request: no method");
  }
  if (id === null) return undefined; // notifications/initialized, cancelled, …
  const params = object["params"];

  switch (method) {
    case "initialize":
      return reply(id, initializeResult(params));
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, toolsListResult());
    case "tools/call": {
      const name = (params as { name?: unknown } | null)?.name;
      if (typeof name !== "string") {
        return failure(
          id,
          RPC_ERRORS.invalidParams,
          "tools/call needs a tool name",
        );
      }
      const tool = toolByName(name);
      if (tool === undefined) {
        return failure(id, RPC_ERRORS.invalidParams, `unknown tool: ${name}`);
      }
      const input = (params as { arguments?: unknown }).arguments;
      try {
        return reply(id, await call(tool, input));
      } catch (error) {
        return reply(
          id,
          text(error instanceof Error ? error.message : String(error), true),
        );
      }
    }
    default:
      return failure(
        id,
        RPC_ERRORS.methodNotFound,
        `method not found: ${method}`,
      );
  }
}

/* ---------------------------------- server -------------------------------- */

/**
 * Serves until `input` ends, then waits for the calls still running so their
 * answers are written before the process goes. Requests are handled
 * concurrently — a browser `wait` must not hold up a `tools/list` — and each
 * answer is one line on `output`.
 */
export async function serve(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  call: ToolCaller = callTool,
): Promise<void> {
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const running = new Set<Promise<void>>();
  for await (const line of lines) {
    const task = handleLine(line, call).then((response) => {
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    });
    running.add(task);
    void task.finally(() => running.delete(task));
  }
  await Promise.all(running);
}

/** `armadra-hook mcp` */
export async function run(args: string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write("armadra-hook: `mcp` takes no arguments\n");
    return 1;
  }
  await serve(process.stdin, process.stdout);
  return 0;
}
