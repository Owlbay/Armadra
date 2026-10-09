/**
 * The mod's own test file for `claude plugin test` (docs/design/claude-mods.md §10.2): the
 * engine runs it against the generated module with `$` mocked beneath the
 * plugin — the endpoint file and node token answered from memory, the fetch
 * answered or refused, the hook client recorded instead of started.
 *
 * Never written into the data directory: `template.test.ts` and the probe put
 * it beside a copy of the module in a temporary folder and run the engine on
 * it, when a Claude Code at or above the gate is there.
 */
export function claudeModPluginTest(clientBin: string): string {
  return `import { describe, expect, mock, test } from "claude-code/testing";

const CLIENT = ${JSON.stringify(clientBin)};
const SOCK = "/tmp/armadra-mod-test/hook.sock";
const ENDPOINT =
  "ARMADRA_HOOK_SOCK='" + SOCK + "'\\n" +
  "ARMADRA_HOOK_TOKEN='bearer'\\n" +
  "ARMADRA_NODE_TOKEN_DIR='/tmp/armadra-mod-test/node-tokens'\\n";

function world(on: any, refuse: boolean) {
  mock.env(on, {
    ARMADRA_NODE_ID: "node-1",
    ARMADRA_ENDPOINT_FILE: "/tmp/armadra-mod-test/hook-endpoint.env",
    ARMADRA_SESSION_ID: "session-1",
    ARMADRA_SESSION_GENERATION: "3",
    ARMADRA_NODE_NAME: "reviewer",
  });
  const fetched: any[] = [];
  const ran: any[] = [];
  // A call on the engine is answered { value } or { deny }.
  on("fs.read", async ($: any, e: any) => ({
    value: e.path.endsWith("hook-endpoint.env") ? ENDPOINT : "node-token\\n",
  }));
  on("http.fetch", async ($: any, e: any) => {
    fetched.push(e);
    if (refuse) return { deny: "nonessential network traffic is disabled" };
    return { value: { status: 204, ok: true, headers: {}, text: "" } };
  });
  on("process.run", async ($: any, e: any) => {
    ran.push(e);
    return { value: { exitCode: 0, stdout: "", stderr: "" } };
  });
  // The engine beneath: each event answered as a session with no settings
  // hook would, so the mod's own hooks are all that runs.
  for (const name of ["classic.Stop", "classic.UserPromptSubmit"]) {
    on(name, async () => ({}));
  }
  on("session.start", async ($: any, e: any) => ({ cwd: e.cwd }));
  on("session.version", async () => ({
    value: { version: "2.1.293", base: "2.1.293" },
  }));
  on("ui.status", async () => ({ value: undefined }));
  return { fetched, ran };
}

async function settle($: any, done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) =>
      typeof setTimeout === "function" ? setTimeout(resolve, 10) : resolve(undefined),
    );
}

describe("armadra-mod", () => {
  test("reports a classic event over the socket, unchanged, without a revision", async ($: any, on: any) => {
    const w = world(on, false);
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: "done" });
    await settle($, () => w.fetched.length > 0);
    expect(w.fetched.length).toBe(1);
    const call = w.fetched[0];
    expect(call.url).toBe("http://armadra/hook/claude");
    expect(call.init.socketPath).toBe(SOCK);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["X-Armadra-Hook-Token"]).toBe("bearer");
    expect(call.init.headers["X-Armadra-Node-Token"]).toBe("node-token");
    expect(call.init.headers["X-Armadra-Hook-Client"]).toBe("5");
    const body = JSON.parse(call.init.body);
    expect(body.nodeId).toBe("node-1");
    expect(body.version).toBe(1);
    expect(body.payload.hook_event_name).toBe("Stop");
    expect(body.payload.last_assistant_message).toBe("done");
    expect(body.terminalBinding).toEqual({ sessionId: "session-1", generation: 3 });
    expect(w.ran.length).toBe(0);
  });

  test("falls back to the hook client when the fetch is refused", async ($: any, on: any) => {
    const w = world(on, true);
    await $.classic.UserPromptSubmit({ prompt: "go" });
    await settle($, () => w.ran.length > 0);
    expect(w.ran.length).toBe(1);
    expect(w.ran[0].argv).toEqual([CLIENT, "claude"]);
    const payload = JSON.parse(w.ran[0].init.stdin);
    expect(payload.hook_event_name).toBe("UserPromptSubmit");
    expect(payload.prompt).toBe("go");
  });

  test("says hello at session start", async ($: any, on: any) => {
    const w = world(on, false);
    await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
    await settle($, () => w.fetched.some((call) => call.url.endsWith("/node/mod")));
    const hello = w.fetched.find((call) => call.url.endsWith("/node/mod"));
    expect(hello.url).toBe("http://armadra/node/mod");
    const body = JSON.parse(hello.init.body);
    expect(body.engine).toBe("claude");
    expect(body.transport).toBe("socket");
    expect(body.profile).toBe("terminal");
    expect(body.isInteractive).toBe(true);
    expect(body.modRevision).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("node-token");
    expect(JSON.stringify(body)).not.toContain("bearer");
  });
});
`;
}
