/**
 * 契约 §26 的用例装配（只给测试用）：上游 `@armadra/agent` 0.6.7 的 `AcpClient`
 * 还没有 `elicitation/create` 与 `session/set_config_option`，它的假 Agent 也不
 * 发这两样。上游加上之前，用例用这里的两样顶上：
 *
 *   * {@link withFeatures}：在上游 `AcpClient` 上补出这两个能力的子类，形状就是
 *     要上游加的那一版（`features.elicitation` / `features.configOptions`、
 *     构造参数 `onElicitation`、`setConfigOption(sessionId, configId, value)`），
 *     用例经 `vi.mock("@armadra/agent/acp")` 换进去；
 *   * {@link featureAgentPath}：一个会发 `elicitation/create`、答 `configOptions`
 *     的假 ACP Agent（真子进程），写进临时目录，只依赖上游导出的 `JsonRpcPeer`。
 *
 * 上游带上之后删掉这个文件，用例改用上游的假 Agent。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** 上游 `AcpClient` 的那几处（私有成员在 JS 里照样够得着）。 */
interface UpstreamClient {
  readonly options: {
    onElicitation?(params: unknown, signal: AbortSignal): Promise<unknown>;
  };
  readonly peer: {
    request(
      method: string,
      params?: unknown,
      signal?: AbortSignal,
    ): Promise<unknown>;
  };
  onRequest(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  cancel(sessionId: string): Promise<void>;
}

type ClientClass = abstract new (...args: never[]) => object;

/** 上游 `AcpClient` → 带 elicitation 与配置项能力的子类。 */
export function withFeatures<T extends ClientClass>(Base: T): T {
  const base = Base as unknown as {
    features?: Record<string, unknown>;
    prototype: UpstreamClient;
  };
  const Featured = class extends (Base as unknown as new (
    ...args: unknown[]
  ) => UpstreamClient) {
    static features = {
      ...(base.features ?? {}),
      elicitation: true,
      configOptions: true,
    };

    private readonly elicitations = new Map<string, Set<AbortController>>();

    override async onRequest(
      method: string,
      params: unknown,
      connection: AbortSignal,
    ): Promise<unknown> {
      if (method !== "elicitation/create") {
        return super.onRequest(method, params, connection);
      }
      const handler = this.options.onElicitation;
      if (handler === undefined) return { action: "decline" };
      const sessionId = String(
        (params as { sessionId?: unknown } | null)?.sessionId ?? "",
      );
      const controller = new AbortController();
      const set = this.elicitations.get(sessionId) ?? new Set();
      set.add(controller);
      this.elicitations.set(sessionId, set);
      const signal = AbortSignal.any([controller.signal, connection]);
      try {
        const answer = await Promise.race([
          handler(params, signal),
          new Promise((resolve) => {
            const cancelled = () => resolve({ action: "cancel" });
            if (signal.aborted) cancelled();
            else signal.addEventListener("abort", cancelled, { once: true });
          }),
        ]);
        return signal.aborted ? { action: "cancel" } : answer;
      } finally {
        set.delete(controller);
      }
    }

    override async cancel(sessionId: string): Promise<void> {
      for (const controller of this.elicitations.get(sessionId) ?? []) {
        controller.abort();
      }
      await super.cancel(sessionId);
    }

    setConfigOption(
      sessionId: string,
      configId: string,
      value: string,
    ): Promise<unknown> {
      return this.peer.request("session/set_config_option", {
        sessionId,
        configId,
        value,
      });
    }
  };
  return Featured as unknown as T;
}

/** 假 Agent 的源码。`ACP_URL` 换成上游 `@armadra/agent/acp` 的文件 URL。 */
const SOURCE = `
import { createHash } from "node:crypto";
import { JsonRpcPeer, RpcError } from "ACP_URL";

const MODELS = [
  { value: "small", name: "Small" },
  { group: "big", name: "Big", options: [{ value: "large", name: "Large", description: "slow" }] },
];
const sessions = new Map();
let counter = 0;

function configOptions(session) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: MODELS },
  ];
}
function open(id) {
  const session = sessions.get(id) ?? { id, model: "small", turn: undefined };
  sessions.set(id, session);
  return session;
}
const MODES = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] };

const peer = new JsonRpcPeer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, raw) {
    const params = raw ?? {};
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
          authMethods: [],
          agentInfo: { name: "fake-feature-agent", version: "0.0.1" },
        };
      case "session/new": {
        counter += 1;
        const session = open("feat-" + counter);
        return { sessionId: session.id, modes: MODES, configOptions: configOptions(session) };
      }
      case "session/load":
      case "session/resume": {
        const id = String(params.sessionId ?? "");
        if (!id.startsWith("feat-")) throw new RpcError(-32002, "unknown session: " + id);
        const session = open(id);
        return { modes: MODES, configOptions: configOptions(session) };
      }
      case "session/set_mode":
        return {};
      case "session/set_config_option": {
        const session = open(String(params.sessionId));
        if (params.configId !== "model") throw new RpcError(-32602, "unknown config");
        if (!["small", "large"].includes(params.value)) throw new RpcError(-32602, "unknown model");
        session.model = params.value;
        return { configOptions: configOptions(session) };
      }
      case "session/prompt": {
        const session = open(String(params.sessionId));
        const text = (params.prompt ?? []).map((block) => block.text ?? "").join("");
        const say = (line) =>
          peer.notify("session/update", {
            sessionId: session.id,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } },
          });
        const controller = new AbortController();
        session.turn = controller;
        if (text.includes("[elicit]")) {
          const answer = await peer.request("elicitation/create", {
            sessionId: session.id,
            message: "Pick a color",
            requestedSchema: {
              type: "object",
              properties: {
                color: { type: "string", enum: ["red", "blue"] },
                count: { type: "integer", minimum: 1 },
              },
              required: ["color"],
            },
          });
          await say("elicit: " + answer.action + " " + JSON.stringify(answer.content ?? null));
          return { stopReason: answer.action === "cancel" ? "cancelled" : "end_turn" };
        }
        const env = /\\[env ([A-Z0-9_]+)\\]/.exec(text);
        if (env) {
          const value = process.env[env[1]];
          const digest = value === undefined ? "absent" : createHash("sha256").update(value).digest("hex");
          await say("env " + env[1] + " " + digest);
          return { stopReason: "end_turn" };
        }
        if (text.includes("[model]")) {
          await say("model " + session.model);
          return { stopReason: "end_turn" };
        }
        await say("echo: " + text);
        return { stopReason: "end_turn" };
      }
      default:
        throw new RpcError(-32601, "method not found: " + method);
    }
  },
  onNotification() {},
});
await peer.closed;
`;

let written: string | undefined;

/**
 * 写出假 Agent，答它的路径（`node <path>` 起）。`acpUrl` 是上游
 * `@armadra/agent/acp` 的入口；用例从 `fakeAcpAgentPath()` 推出来传进来。
 */
export function featureAgentPath(fakeAcpAgentPath: string): string {
  if (written !== undefined) return written;
  // `<dist>/drivers/acp/testing/fake-agent-main.js` → `<dist>/acp.js`
  const acp = join(dirname(fakeAcpAgentPath), "..", "..", "..", "acp.js");
  const directory = join(tmpdir(), `armadra-acp-feature-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "feature-agent.mjs");
  writeFileSync(path, SOURCE.replace("ACP_URL", pathToFileURL(acp).href));
  written = path;
  return path;
}
