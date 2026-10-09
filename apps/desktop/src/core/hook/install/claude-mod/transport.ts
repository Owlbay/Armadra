/**
 * The transport half of the Claude Code mod (contract §57, docs/design/claude-mods.md §3.1):
 * endpoint parsing, headers, the `terminalBinding` without a revision, the
 * socket → TCP → `armadra-hook` order, and the hello.
 *
 * The same rules as the Pi / OMP extension (`extension-template.ts`) and the
 * `armadra-hook` client, ported to what a mod has: no Node, only `$`. So the
 * endpoint and the node token are read with `$.fs.read`, the request goes out
 * through `$.http.fetch` (with `socketPath` for the Unix socket), and the
 * fallback is `$.process.run` of the client with the payload on stdin.
 *
 * Text, not a module this build runs: what `template.ts` concatenates into
 * `hooks/armadra.ts`. Written with `String.raw` so the generated regular
 * expressions keep their backslashes; nothing in it may contain a template
 * placeholder.
 */
export const TRANSPORT_DECLARATIONS = String.raw`
type ArmadraTransport = "socket" | "tcp" | "process";

interface ArmadraSession {
  nodeId: string;
  sock: string | undefined;
  port: number | undefined;
  headers: Record<string, string>;
  binding: { sessionId: string; generation: number } | undefined;
}

// Which way the hello last said the reports go: it is sent again when a
// report goes another way (the first refused fetch, say). Module state on
// purpose: a reload runs session.start again and starts it over.
let armadraHelloVia: ArmadraTransport | undefined;
let armadraHelloBody: Record<string, unknown> | undefined;

// The same gate as the hook client's: an id only becomes part of a path or a
// header after it passes this.
function armadraIsId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 80 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

// KEY='value' with POSIX single-quote escaping, as the core writes it.
function armadraUnquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).split("'\\''").join("'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).split('\\"').join('"').split("\\\\").join("\\");
  }
  return value;
}

function armadraParseEndpoint(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === "") continue;
    map.set(key, armadraUnquote(line.slice(separator + 1).trim()));
  }
  return map;
}

// Read on every event, never cached: the terminal can outlive the core that
// spawned it, and the next core writes a new socket path and a new bearer.
// The tokens live in this function's locals and the request headers only.
async function armadraSession($: EngineInterface): Promise<ArmadraSession | undefined> {
  const nodeId = await $.env.get("ARMADRA_NODE_ID");
  const endpointFile = await $.env.get("ARMADRA_ENDPOINT_FILE");
  if (!armadraIsId(nodeId) || endpointFile === undefined || endpointFile === "") {
    return undefined;
  }
  let text: string;
  try {
    text = await $.fs.read(endpointFile);
  } catch {
    return undefined;
  }
  const map = armadraParseEndpoint(text);
  const sock = map.get("ARMADRA_HOOK_SOCK") || undefined;
  const rawPort = map.get("ARMADRA_HOOK_PORT") ?? "";
  const portNumber = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
  const port = portNumber > 0 && portNumber < 65536 ? portNumber : undefined;
  if (sock === undefined && port === undefined) return undefined;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Armadra-Hook-Client": ARMADRA_CLIENT_REVISION,
    "X-Armadra-Hook-Token": map.get("ARMADRA_HOOK_TOKEN") ?? "",
  };
  let verified = false;
  const tokenDir = map.get("ARMADRA_NODE_TOKEN_DIR");
  if (tokenDir !== undefined && tokenDir !== "") {
    try {
      const token = (await $.fs.read(tokenDir + "/" + nodeId)).trim();
      if (token !== "") {
        headers["X-Armadra-Node-Token"] = token;
        verified = true;
      }
    } catch {
      // A missing node token downgrades the report; it does not cancel it.
    }
  }
  // The binding carries no sourceRevision: the core allocates it from the
  // same counter the hook client uses (contract §57). Only with a node token,
  // as the client does: an unverified report has no binding to prove.
  let binding: ArmadraSession["binding"];
  const sessionId = await $.env.get("ARMADRA_SESSION_ID");
  const rawGeneration = (await $.env.get("ARMADRA_SESSION_GENERATION")) ?? "";
  if (verified && armadraIsId(sessionId) && /^\d{1,15}$/.test(rawGeneration)) {
    binding = { sessionId, generation: Number(rawGeneration) };
  }
  return { nodeId, sock, port, headers, binding };
}

// One POST through the host's fetch: the socket first, the port second. Any
// HTTP answer is a delivery (the core decides what it was worth); a rejection
// (no socket, the organization's policy, nonessential traffic turned off)
// moves on.
async function armadraFetch(
  $: EngineInterface,
  session: ArmadraSession,
  pathname: string,
  body: (via: ArmadraTransport) => string,
): Promise<ArmadraTransport | undefined> {
  if (session.sock !== undefined) {
    try {
      await $.http.fetch("http://armadra" + pathname, {
        method: "POST",
        headers: session.headers,
        body: body("socket"),
        socketPath: session.sock,
      });
      return "socket";
    } catch {
      // Refused or unreachable: try the port.
    }
  }
  if (session.port !== undefined) {
    try {
      await $.http.fetch("http://127.0.0.1:" + String(session.port) + pathname, {
        method: "POST",
        headers: session.headers,
        body: body("tcp"),
      });
      return "tcp";
    } catch {
      // Refused or unreachable: the caller falls back to the client.
    }
  }
  return undefined;
}

// The hook client with this input on stdin: what the settings hook would
// have run, so nothing is lost when the host refuses our fetch.
async function armadraSpawn($: EngineInterface, verb: string, input: string): Promise<boolean> {
  try {
    const ran = await $.process.run([ARMADRA_CLIENT, verb], { stdin: input, timeoutMs: 5000 });
    return ran.exitCode === 0;
  } catch {
    return false;
  }
}

// Tells the core this session runs the mod (POST /node/mod): versions and
// the transport only, never a path, a token or a tool name.
async function armadraHello($: EngineInterface, via: ArmadraTransport | undefined): Promise<void> {
  try {
    if (armadraHelloBody === undefined) return;
    const session = await armadraSession($);
    if (session === undefined) return;
    const hello = armadraHelloBody;
    if (via !== "process") {
      const sent = await armadraFetch($, session, "/node/mod", (transport) =>
        JSON.stringify({ ...hello, nodeId: session.nodeId, transport }),
      );
      if (sent !== undefined) {
        armadraHelloVia = sent;
        return;
      }
    }
    const input = JSON.stringify({ ...hello, transport: "process" });
    if (await armadraSpawn($, "mod-hello", input)) armadraHelloVia = "process";
  } catch {
    // Observability only: a lost hello costs the settings page a line.
  }
}

async function armadraNote($: EngineInterface, via: ArmadraTransport): Promise<void> {
  if (armadraHelloBody !== undefined && armadraHelloVia !== undefined && armadraHelloVia !== via) {
    await armadraHello($, via);
  }
}

// One provider payload, exactly as the settings hook would have read it on
// stdin. Never throws and never rejects.
async function armadraReport($: EngineInterface, payload: unknown): Promise<void> {
  try {
    const session = await armadraSession($);
    if (session === undefined) return;
    const envelope: Record<string, unknown> = { nodeId: session.nodeId, version: 1, payload };
    if (session.binding !== undefined) envelope.terminalBinding = session.binding;
    const body = JSON.stringify(envelope);
    const via = await armadraFetch($, session, "/hook/claude", () => body);
    if (via !== undefined) {
      await armadraNote($, via);
      return;
    }
    if (await armadraSpawn($, "claude", JSON.stringify(payload))) await armadraNote($, "process");
  } catch {
    // Reporting is best effort: a canvas problem must not become a session one.
  }
}

// At most ms of the session's end: the chain shares about 1.5 s.
async function armadraWithin($: EngineInterface, work: Promise<void>, ms: number): Promise<void> {
  try {
    await Promise.race([work, $.clock.sleep(ms)]);
  } catch {
    // The sleep was cut short by the dispatch ending: nothing left to wait for.
  }
}
`;
