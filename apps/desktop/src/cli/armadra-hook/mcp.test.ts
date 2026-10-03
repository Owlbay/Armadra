/**
 * `armadra-hook mcp`: the three methods on the wire, the tool table against
 * the runtime's verb lists, `tools/call` against `armadra-hook canvas` byte
 * for byte, and the error shapes (ACP design §5.8).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VERBS as BROWSER_ROUTE_VERBS } from "../../core/browser/args.js";
import { VERBS as CONTEXT_ROUTE_VERBS } from "../../core/collab/context-link.js";
import { VERBS as CONTROL_VERBS } from "../../core/collab/control/index.js";
import { mcpInstructions } from "../../core/collab/skill.js";
import { VERB_TOOLS, toolByName } from "../../hook-client/verbs.js";
import { runCanvas } from "./control.js";
import {
  MCP_PROTOCOL_VERSIONS,
  type McpResponse,
  RPC_ERRORS,
  type ToolCaller,
  callTool,
  handleLine,
  serve,
} from "./mcp.js";

/* --------------------------------- harness -------------------------------- */

const temporaries: string[] = [];
const servers: net.Server[] = [];
const ENV_KEYS = [
  "ARMADRA_NODE_ID",
  "ARMADRA_ENDPOINT_FILE",
  "ARMADRA_DATA_DIR",
  "ARMADRA_SESSION_ID",
  "ARMADRA_SESSION_GENERATION",
  "ARMADRA_HOOK_TIMEOUT_MS",
] as const;
const savedEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // The default data directory is a failover candidate; keep a real install out.
  process.env["ARMADRA_DATA_DIR"] = tempdir();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const server of servers.splice(0)) server.close();
  for (const dir of temporaries.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "armadra-mcp-"));
  temporaries.push(dir);
  return dir;
}

/** A TCP endpoint that keeps every raw request and answers with `response`. */
async function endpoint(response: string): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const headEnd = raw.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = raw.subarray(0, headEnd).toString("utf8");
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? "0");
      if (raw.length < headEnd + 4 + length) return;
      requests.push(raw.subarray(0, headEnd + 4 + length).toString("utf8"));
      socket.end(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const dir = tempdir();
  const tokens = path.join(dir, "node-tokens");
  fs.mkdirSync(tokens);
  fs.writeFileSync(path.join(tokens, "node-7"), "kid1234.macvalue\n");
  const file = path.join(dir, "hook-endpoint.env");
  fs.writeFileSync(
    file,
    `ARMADRA_HOOK_PORT='${port}'\nARMADRA_HOOK_TOKEN='app-token-abc'\n` +
      `ARMADRA_NODE_TOKEN_DIR='${tokens}'\nARMADRA_HOOK_VERSION='1'\n`,
  );
  process.env["ARMADRA_NODE_ID"] = "node-7";
  process.env["ARMADRA_ENDPOINT_FILE"] = file;
  return { requests };
}

const JSON_OK = (body: string) =>
  `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

const request = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });

async function answer(line: string, call?: ToolCaller): Promise<McpResponse> {
  const response = await handleLine(line, call);
  if (response === undefined) throw new Error("no response");
  return response;
}

async function result(line: string, call?: ToolCaller): Promise<any> {
  const response = await answer(line, call);
  if (!("result" in response)) throw new Error(JSON.stringify(response));
  return response.result;
}

/* --------------------------------- methods -------------------------------- */

describe("initialize", () => {
  it("answers the tools capability, the server and the board's rules", async () => {
    const init = await result(
      request(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      }),
    );
    expect(init).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "armadra", version: expect.any(String) },
      instructions: mcpInstructions(),
    });
    expect(init.instructions).toContain("ARMADRA MESSAGE");
    expect(init.instructions).toContain("canvas_open_agent");
  });

  it("offers its newest revision to a client asking for one it does not know", async () => {
    const init = await result(
      request(1, "initialize", { protocolVersion: "1999-01-01" }),
    );
    expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[0]);
  });

  it("names only tools that exist in the instructions", () => {
    const named = mcpInstructions().match(/\b(canvas|context)_[a-z_]+/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(toolByName(name)).toBeDefined();
  });
});

describe("tools/list", () => {
  it("is the verb table, verb for verb with the runtime's lists", async () => {
    const { tools } = await result(request(2, "tools/list"));
    expect(tools.map((t: { name: string }) => t.name)).toEqual(
      VERB_TOOLS.map((t) => t.name),
    );
    const verbs = (group: string) =>
      VERB_TOOLS.filter((t) => t.group === group).map((t) => t.verb);
    expect(verbs("canvas")).toEqual([...CONTROL_VERBS]);
    expect(verbs("context")).toEqual([...CONTEXT_ROUTE_VERBS]);
    expect(new Set(verbs("browser"))).toEqual(new Set(BROWSER_ROUTE_VERBS));
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
      ]);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("tools/call", () => {
  it("sends the request `armadra-hook canvas` sends, byte for byte", async () => {
    const server = await endpoint(JSON_OK('{"ok":true,"message":"stored"}'));
    const call = await result(
      request(3, "tools/call", {
        name: "canvas_post",
        arguments: { to: "n2", key: "k1", body: "hi" },
      }),
    );
    expect(call).toEqual({ content: [{ type: "text", text: "stored" }] });

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runCanvas(["post", "--to", "n2", "--key", "k1", "--body", "hi"]),
    ).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toBe(server.requests[1]);
    expect(server.requests[0]).toMatch(/^POST \/control\/post HTTP\/1\.1\r\n/);
    expect(server.requests[0]).toContain(
      "X-Armadra-Node-Token: kid1234.macvalue",
    );
    expect(server.requests[0]).toContain(
      '{"args":{"body":"hi","key":"k1","to":"n2"},"nodeId":"node-7"}',
    );
  });

  it("routes context tools to /context-link and numbers as the CLI's text", async () => {
    const server = await endpoint(JSON_OK('{"result":"digest"}'));
    const call = await result(
      request(4, "tools/call", {
        name: "context_transcript",
        arguments: { node: "n2", n: 5, since: true },
      }),
    );
    expect(call.content[0].text).toBe("digest");
    expect(server.requests[0]).toMatch(/^POST \/context-link\/transcript /);
    expect(server.requests[0]).toContain(
      '{"args":{"n":"5","node":"n2","since":true},"nodeId":"node-7"}',
    );
  });

  it("adds the session binding from the environment, never from the model", async () => {
    const server = await endpoint(JSON_OK('{"ok":true}'));
    process.env["ARMADRA_SESSION_ID"] = "s-1";
    process.env["ARMADRA_SESSION_GENERATION"] = "4";
    await result(
      request(5, "tools/call", { name: "canvas_ack", arguments: { id: "m1" } }),
    );
    expect(server.requests[0]).toContain(
      '{"args":{"generation":4,"id":"m1","sessionId":"s-1"},"nodeId":"node-7"}',
    );
    const smuggled = await result(
      request(6, "tools/call", {
        name: "canvas_ack",
        arguments: { id: "m1", sessionId: "other" },
      }),
    );
    expect(smuggled.isError).toBe(true);
    expect(server.requests).toHaveLength(1);
  });

  it("refuses handoff-read without a binding, as the CLI does", async () => {
    const server = await endpoint(JSON_OK("{}"));
    const call = await result(
      request(7, "tools/call", {
        name: "canvas_handoff_read",
        arguments: { id: "h1" },
      }),
    );
    expect(call.isError).toBe(true);
    expect(call.content[0].text).toMatch(/session binding is required/);
    expect(server.requests).toHaveLength(0);
  });

  it("gives the long budget to browser tools only", async () => {
    const seen: (boolean | undefined)[] = [];
    const spy: ToolCaller = async (tool) => {
      seen.push(tool.long);
      return { content: [{ type: "text", text: "" }] };
    };
    await result(
      request(8, "tools/call", { name: "browser_read", arguments: {} }),
      spy,
    );
    await result(
      request(9, "tools/call", { name: "canvas_list", arguments: {} }),
      spy,
    );
    expect(seen).toEqual([true, undefined]);
  });
});

/* ---------------------------------- errors -------------------------------- */

describe("errors", () => {
  it("are tool results the model can read when the tool ran and failed", async () => {
    await endpoint(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 30\r\n\r\n{"error":"node is not linked"}',
    );
    expect(
      await result(
        request(10, "tools/call", {
          name: "context_summary",
          arguments: { node: "x" },
        }),
      ),
    ).toEqual({
      content: [{ type: "text", text: "node is not linked (403)" }],
      isError: true,
    });

    const bad = await result(
      request(11, "tools/call", {
        name: "canvas_color",
        arguments: { color: "pink" },
      }),
    );
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/must be one of/);
  });

  it("say so when there is no canvas at all", async () => {
    delete process.env["ARMADRA_NODE_ID"];
    const call = await callTool(toolByName("canvas_list")!, {});
    expect(call.isError).toBe(true);
    expect(call.content[0]!.text).toMatch(/ARMADRA_NODE_ID is not set/);
  });

  it("are JSON-RPC errors for what is not a tool call at all", async () => {
    const code = async (line: string) => {
      const response = await answer(line);
      if (!("error" in response)) throw new Error(JSON.stringify(response));
      return [response.id, response.error.code];
    };
    expect(await code("{not json")).toEqual([null, RPC_ERRORS.parseError]);
    expect(await code("[1,2]")).toEqual([null, RPC_ERRORS.invalidRequest]);
    expect(await code('{"jsonrpc":"1.0","id":1,"method":"ping"}')).toEqual([
      1,
      RPC_ERRORS.invalidRequest,
    ]);
    expect(await code(request(12, "resources/list"))).toEqual([
      12,
      RPC_ERRORS.methodNotFound,
    ]);
    expect(
      await code(request(13, "tools/call", { name: "canvas_nope" })),
    ).toEqual([13, RPC_ERRORS.invalidParams]);
    expect(await code(request(14, "tools/call", {}))).toEqual([
      14,
      RPC_ERRORS.invalidParams,
    ]);
  });

  it("are never sent for notifications or responses", async () => {
    for (const line of [
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}',
      '{"jsonrpc":"2.0","id":5,"result":{}}',
      "",
    ]) {
      expect(await handleLine(line)).toBeUndefined();
    }
  });
});

/* ---------------------------------- stream -------------------------------- */

describe("serve", () => {
  it("answers line by line, out of order when a call is slow, and drains on EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let release: () => void = () => {};
    const slow: ToolCaller = (tool) =>
      new Promise((resolve) => {
        release = () =>
          resolve({ content: [{ type: "text", text: `done ${tool.name}` }] });
      });
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = serve(input, output, slow);
    input.write(
      `${request(1, "tools/call", { name: "browser_wait", arguments: {} })}\n`,
    );
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write(`${request(2, "ping")}\r\n`);
    input.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await done;
    const lines = Buffer.concat(chunks)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
      {
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "done browser_wait" }] },
      },
    ]);
  });
});
