/**
 * `session/new` 的 `mcpServers` 参数（ACP 设计 §5.8）：把 `armadra-hook mcp`
 * 交给经 ACP 驱动的 Agent，画布工具由它承担。
 *
 * 一条 stdio 服务器：命令是本机的 `armadra-hook`（`terminal/environment.ts`
 * 的 `hookClient()`，与终端里 PATH 上那个是同一个），参数 `["mcp"]`，环境变量
 * 与终端节点的注入同一份（`agentEnvironment`：节点 id、端点文件……，只有地址、
 * 不带令牌），会话绑定（`ARMADRA_SESSION_ID` / `_GENERATION`）有就加——
 * `canvas_ack` / `canvas_handoff_read` 要用。所以 core 分不出这条 MCP 与
 * `armadra-hook canvas` 的区别，也不多给权限。
 *
 * 客户端兼容：`@armadra/agent` 的 `AcpClient` 旧版开会话固定发
 * `mcpServers: []`，新版接受第三个参数 `{ mcpServers }` 并声明
 * `AcpClient.features.mcpServers`。{@link sessionOpener} 按这个声明选路：
 * 支持才带，不支持照旧开会话，并如实答 `mcpInjected: false`——缺了画布工具的
 * 会话照样能用，只是 Agent 不能动画布。
 */

import { AcpClient } from "@armadra/agent/acp";

import { agentEnvironment, hookClient } from "../terminal/environment";
import type { AcpAdapter } from "./adapters";
import type {
  AcpLoadSessionResult,
  AcpMcpServer,
  AcpNewSessionResult,
} from "./types";

/** MCP 服务器名：工具在 CLI 里显示为 `armadra` 这一组。 */
export const CANVAS_MCP_NAME = "armadra";

/**
 * stdio 的 MCP 服务器（ACP v1 每家都必须支持的那一种）。类型别名而不是
 * interface：要能赋给 `AcpMcpServer`（`Record<string, unknown>`）。
 */
export type AcpStdioMcpServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
};

export interface CanvasMcpInput {
  readonly nodeId: string;
  readonly agentId: string;
  readonly dataDir: string;
  readonly nodeName?: string;
  readonly nodeRole?: string;
  /** 会话行的 id 与代次：`canvas_ack` / `canvas_handoff_read` 的绑定。 */
  readonly session?: { readonly id: string; readonly generation: number };
  /** `armadra-hook` 的路径；缺省读 `hookClient()`。 */
  readonly hookBin?: string;
}

/**
 * 画布那条 MCP 服务器。本机没有 `armadra-hook`（源码检出没构建）时答
 * `undefined`：一条指向不存在程序的服务器会让有的 Agent 起会话就失败。
 */
export function canvasMcpServer(
  input: CanvasMcpInput,
): AcpStdioMcpServer | undefined {
  const command = input.hookBin ?? hookClient();
  if (command === undefined || command === "") return undefined;
  const env = agentEnvironment(
    input.nodeId,
    input.agentId,
    input.dataDir,
    input.nodeName,
    input.nodeRole,
  ).map(([name, value]) => ({ name, value }));
  if (input.session !== undefined) {
    env.push(
      { name: "ARMADRA_SESSION_ID", value: input.session.id },
      {
        name: "ARMADRA_SESSION_GENERATION",
        value: String(input.session.generation),
      },
    );
  }
  return { name: CANVAS_MCP_NAME, command, args: ["mcp"], env };
}

/**
 * 这家适配器开会话时带的 `mcpServers`：适配器表说不加（ama 走 profile 的
 * host 适配器，免得两套工具表）、没给输入或本机没有客户端时为空。
 */
export function acpMcpServers(
  adapter: Pick<AcpAdapter, "injection">,
  input: CanvasMcpInput | undefined,
): AcpStdioMcpServer[] {
  if (!adapter.injection.mcp || input === undefined) return [];
  const server = canvasMcpServer(input);
  return server === undefined ? [] : [server];
}

/** `AcpClient` 自己声明的可选能力；旧版没有 `features`，一律答不支持。 */
export function clientAcceptsMcpServers(
  client: { readonly features?: unknown } = AcpClient as {
    readonly features?: unknown;
  },
): boolean {
  const features = client.features as { mcpServers?: unknown } | undefined;
  return features?.mcpServers === true;
}

/** 新版 `AcpClient` 开会话的签名（第三个参数）。 */
interface McpCapableClient {
  newSession(
    cwd: string,
    signal: AbortSignal | undefined,
    options: { mcpServers: readonly AcpMcpServer[] },
  ): Promise<AcpNewSessionResult>;
  loadSession(
    sessionId: string,
    cwd: string,
    signal: AbortSignal | undefined,
    options: { mcpServers: readonly AcpMcpServer[] },
  ): Promise<AcpLoadSessionResult>;
  resumeSession(
    sessionId: string,
    cwd: string,
    signal: AbortSignal | undefined,
    options: { mcpServers: readonly AcpMcpServer[] },
  ): Promise<AcpLoadSessionResult>;
}

/** 开会话用的三个方法，`mcpServers` 已按客户端能力决定带不带。 */
export interface AcpSessionOpener {
  newSession(cwd: string): Promise<AcpNewSessionResult>;
  loadSession(sessionId: string, cwd: string): Promise<AcpLoadSessionResult>;
  resumeSession(sessionId: string, cwd: string): Promise<AcpLoadSessionResult>;
  /** 要带的服务器真的随开会话发出去了。 */
  readonly mcpInjected: boolean;
}

/** {@link sessionOpener} 用到的那部分客户端（测试可以给一个记录调用的替身）。 */
export type AcpSessionClient = Pick<
  AcpClient,
  "newSession" | "loadSession" | "resumeSession"
>;

/**
 * 没有服务器要带、或客户端不支持时，调用与旧版完全相同（不传第三个参数，
 * 线路逐字节不变）。
 */
export function sessionOpener(
  client: AcpSessionClient,
  servers: readonly AcpMcpServer[] = [],
  supported: boolean = clientAcceptsMcpServers(),
): AcpSessionOpener {
  if (servers.length === 0 || !supported) {
    return {
      newSession: (cwd) => client.newSession(cwd),
      loadSession: (id, cwd) => client.loadSession(id, cwd),
      resumeSession: (id, cwd) => client.resumeSession(id, cwd),
      mcpInjected: false,
    };
  }
  const capable = client as unknown as McpCapableClient;
  const options = { mcpServers: servers };
  return {
    newSession: (cwd) => capable.newSession(cwd, undefined, options),
    loadSession: (id, cwd) => capable.loadSession(id, cwd, undefined, options),
    resumeSession: (id, cwd) =>
      capable.resumeSession(id, cwd, undefined, options),
    mcpInjected: true,
  };
}
