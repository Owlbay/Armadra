/**
 * The canvas, context and browser verbs as ama tools — generated from
 * `hook-client/verbs.ts`'s `VERB_TOOLS`, the table `armadra-hook mcp` reads
 * too, never copied by hand (docs/design/coordinator-agent.md §3).
 *
 * Each tool is one `POST /control/<verb>`, `/context-link/<verb>` or
 * `/browser/<verb>` through {@link callVerb}. What the adapter adds is the
 * permission class ama's pipeline sorts the call by: reading the board is
 * `read`, changing it is `write`, and stopping or closing another agent is
 * `execute` — asked for in ama's default mode, in the node's terminal. The
 * adapter never answers an approval itself.
 */

import type {
  HostApi,
  ToolDefinition,
  ToolPermission,
  ToolResult,
} from "@armadra/agent/host";
import { VERB_TOOLS, type VerbTool } from "../../hook-client/verbs.js";
import { type CallOutcome, callVerb } from "./client.js";

/** Verbs that only read. Anything not listed in either table is `write`. */
const READ: Readonly<Record<string, readonly string[]>> = {
  canvas: ["help", "list", "inbox", "outbox", "handoff-read"],
  // Every context verb reads a linked node; the budget is the core's.
  context: ["list", "summary", "transcript", "terminal"],
  browser: ["read", "wait", "capture", "pdf"],
};

/** Verbs that stop, close or reach outside the board. */
const EXECUTE: Readonly<Record<string, readonly string[]>> = {
  canvas: ["interrupt", "close"],
  context: [],
  browser: ["upload", "download", "close"],
};

/**
 * The class ama's permission pipeline files a verb under. An unknown verb (one
 * added to the runtime later) is `write`: asked for in the default mode, never
 * silently allowed.
 */
export function permissionOf(tool: VerbTool): ToolPermission {
  if (EXECUTE[tool.group]?.includes(tool.verb) === true) return "execute";
  if (READ[tool.group]?.includes(tool.verb) === true) return "read";
  return "write";
}

export type Caller = (tool: VerbTool, input: unknown) => Promise<CallOutcome>;

/** One verb as an ama tool definition. */
export function toolDefinition(
  tool: VerbTool,
  call: Caller = callVerb,
): ToolDefinition {
  const permission = permissionOf(tool);
  return {
    name: tool.name,
    label: `${tool.group} ${tool.verb}`,
    description: tool.description,
    parameters: tool.inputSchema as ToolDefinition["parameters"],
    permission,
    annotations: {
      readOnly: permission === "read",
      destructive: permission === "execute",
      openWorld: tool.group === "browser",
    },
    async execute(input: unknown): Promise<ToolResult> {
      try {
        const outcome = await call(tool, input);
        return "ok" in outcome
          ? { content: outcome.ok === "" ? "ok" : outcome.ok }
          : { content: outcome.error, isError: true };
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

/** Every verb as a tool, in the table's order (canvas, context, browser). */
export function canvasTools(call: Caller = callVerb): ToolDefinition[] {
  return VERB_TOOLS.map((tool) => toolDefinition(tool, call));
}

/** Registers every tool; answers the names. */
export function registerTools(
  api: Pick<HostApi, "tools">,
  call: Caller = callVerb,
): string[] {
  const names: string[] = [];
  for (const tool of canvasTools(call)) {
    api.tools.register(tool);
    names.push(tool.name);
  }
  return names;
}
