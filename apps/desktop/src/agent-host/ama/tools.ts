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
import {
  type JsonSchema,
  VERB_TOOLS,
  type VerbTool,
} from "../../hook-client/verbs.js";
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

/**
 * The JSON Schema keywords ama accepts in a tool's parameters (its
 * `agent/schema.ts` subset): a host tool with any other keyword makes
 * `create()` fail and ama exit 6. Measured against 0.6.2.
 */
export const AMA_SCHEMA_KEYWORDS = [
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "default",
] as const;

/**
 * The verb table's schema in ama's subset. A bound the subset cannot state
 * (`minimum`, `minItems`) moves into the description, where the model still
 * reads it; the runtime enforces it either way and answers a precise refusal.
 */
export function amaSchema(schema: JsonSchema): ToolDefinition["parameters"] {
  const notes: string[] = [];
  if (schema.minimum !== undefined) notes.push(`≥ ${schema.minimum}`);
  if (schema.minItems !== undefined) notes.push(`at least ${schema.minItems}`);
  const out: Record<string, unknown> = {};
  if (schema.type !== undefined) out.type = schema.type;
  const description = [schema.description, ...notes]
    .filter((part) => part !== undefined && part !== "")
    .join("; ");
  if (description !== "") out.description = description;
  if (schema.enum !== undefined) out.enum = [...schema.enum];
  if (schema.items !== undefined) out.items = amaSchema(schema.items);
  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        amaSchema(child),
      ]),
    );
  }
  if (schema.required !== undefined) out.required = [...schema.required];
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out as ToolDefinition["parameters"];
}

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
    parameters: amaSchema(tool.inputSchema),
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
