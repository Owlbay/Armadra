/**
 * The canvas, context and browser verbs as a tool table: tool name, one-line
 * description, JSON Schema for the arguments, and the route the call goes to.
 *
 * Two programs read it and neither may keep a copy: `armadra-hook mcp`
 * (`tools/list`) and the `ama` adapter's tool registry. A `tools/call` is one
 * `POST <path>` with the body `armadra-hook canvas|context|browser` would have
 * sent — `{nodeId, args}` where `args` is {@link toWireArgs} of the input — so
 * the runtime cannot tell the three callers apart.
 *
 * Where each part comes from:
 *
 *   * **Browser** verbs are generated from `core/browser/verb-spec.ts`, the
 *     runtime's own list, which imports nothing.
 *   * **Canvas** and **context** verbs are written out below, keyed by the
 *     runtime's verb types (`collab/control/index.ts::VERBS`,
 *     `collab/context-link.ts::VERBS`). The keys are checked by the compiler —
 *     a verb added to either list without a row here does not build — and the
 *     enum values and the route set by `verbs.test.ts`. Those modules are only
 *     imported as *types*: the hook client is a small bundle and must not drag
 *     the core's database and agent registry in with it.
 *
 * Argument names are the wire's flag names (`permission-mode`, `dry-run`),
 * not camelCase: they are what the runtime reads out of `args`, and the CLI
 * sends exactly these.
 */

import type { VERBS as CONTEXT_VERB_LIST } from "../core/collab/context-link.js";
import type { ControlVerb } from "../core/collab/control/index.js";
import {
  BROWSER_VERB_SPECS,
  flagsOf,
  type BrowserFlagSpec,
} from "../core/browser/verb-spec.js";
import type { JsonValue } from "./json.js";

export type ContextVerb = (typeof CONTEXT_VERB_LIST)[number];

/** The subset of JSON Schema the table uses. */
export interface JsonSchema {
  type?: "object" | "string" | "integer" | "boolean" | "array";
  description?: string;
  enum?: readonly string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  minimum?: number;
  minItems?: number;
}

export type VerbGroup = "canvas" | "context" | "browser";

export interface VerbTool {
  /** `canvas_open_agent`: `[A-Za-z0-9_]`, unique across the table. */
  readonly name: string;
  readonly group: VerbGroup;
  /** The verb as the runtime spells it (`open-agent`). */
  readonly verb: string;
  /** The hook-endpoint route: `/control/<verb>`, `/context-link/<verb>`, `/browser/<verb>`. */
  readonly path: string;
  readonly description: string;
  /** Always `{type: "object", properties, additionalProperties: false}`. */
  readonly inputSchema: JsonSchema;
  /**
   * `"session"`: the caller adds `sessionId` and `generation` from
   * `ARMADRA_SESSION_ID` / `ARMADRA_SESSION_GENERATION`, the way
   * `armadra-hook canvas` does, and never takes them from the model.
   */
  readonly binding?: "session";
  /** Browser verbs: run under the long budget (`BROWSER_TIMEOUT_MS`). */
  readonly long?: boolean;
}

// ---------------------------------------------------------------------------
// Schema helpers

const str = (description: string): JsonSchema => ({
  type: "string",
  description,
});
const int = (description: string, minimum?: number): JsonSchema => ({
  type: "integer",
  description,
  ...(minimum === undefined ? {} : { minimum }),
});
const bool = (description: string): JsonSchema => ({
  type: "boolean",
  description,
});
const oneOf = (values: readonly string[], description: string): JsonSchema => ({
  type: "string",
  enum: values,
  description,
});
const strings = (description: string, minItems?: number): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  description,
  ...(minItems === undefined ? {} : { minItems }),
});

const DRY_RUN = bool("validate only; the board is not changed");

/**
 * Enum values the runtime owns. Copied rather than imported for the reason in
 * the header; `verbs.test.ts` compares each with its source.
 */
export const ENUMS = {
  /** `canvas/validation.ts::EDGE_ROLES` */
  edgeRoles: ["peer", "supervises"],
  /** `dependencies/store.ts::DEPENDENCY_CONDITIONS` */
  afterTurn: ["current", "next"],
  /** `collab/wake.ts::INBOX_WAKE_MODES` */
  inboxWake: ["off", "notify", "deliver"],
  /** `collab/control/board.ts::NODE_PALETTE` */
  palette: [
    "#0a84ff",
    "#32d74b",
    "#ffd60a",
    "#ff453a",
    "#bf5af2",
    "#6ac4dc",
    "#ff9f0a",
  ],
} as const;

interface Row {
  readonly description: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly binding?: "session";
}

/** The agent-launch options `open-agent` and `team` share. */
const LAUNCH_OPTIONS: Record<string, JsonSchema> = {
  "permission-mode": str(
    "permission mode for the new CLI; only modes that CLI supports are accepted",
  ),
  after: strings(
    "node ids to wait for before the task is sent; a comma-separated string also works",
  ),
  "after-turn": oneOf(
    ENUMS.afterTurn,
    "wait for the upstream's current turn (default) or its next successful one",
  ),
  ttl: int("minutes to wait for the dependencies; default one day", 1),
  "inbox-wake": oneOf(
    ENUMS.inboxWake,
    "what an idle node does with unread canvas mail",
  ),
};

// ---------------------------------------------------------------------------
// Canvas verbs (`/control/<verb>`)

const CANVAS: Record<ControlVerb, Row> = {
  help: {
    description:
      "Short collaboration guide and the canvas verbs this runtime answers.",
  },
  post: {
    description:
      "Store a handoff message for a linked agent; it reads it with `inbox`.",
    properties: {
      to: str("the recipient: a linked node's id, name or title"),
      key: str("idempotency key, so a retry is not a second message"),
      body: str("the message, 1–2000 characters"),
    },
    required: ["to", "key", "body"],
  },
  inbox: {
    description: "Read your pending messages without acknowledging them.",
    properties: {
      limit: int("how many, 1–32 (default 10)", 1),
      after: int("only messages after this sequence number", 0),
    },
  },
  ack: {
    description: "Acknowledge one received message.",
    properties: { id: str("the message id from `inbox`") },
    required: ["id"],
    binding: "session",
  },
  "handoff-read": {
    description:
      "Read the frozen handoff bundle a peer approved for this session.",
    properties: { id: str("the handoff id") },
    required: ["id"],
    binding: "session",
  },
  list: {
    description: "List the nodes on this board and how they link to you.",
  },
  "open-terminal": {
    description: "Open a plain terminal node next to this one.",
    properties: { title: str("node title"), "dry-run": DRY_RUN },
  },
  "open-agent": {
    description:
      "Open an agent node, link it as your sub, and give it a first task once it reports idle.",
    properties: {
      agent: str("agent id, e.g. claude, codex, or custom:<id>"),
      task: str("the first task, sent when the node is idle"),
      title: str("node title"),
      model: str("model alias, 1–120 characters"),
      worktree: str(
        "a worktree name or path; the node goes in that checkout's Frame (created if missing)",
      ),
      ...LAUNCH_OPTIONS,
      "dry-run": DRY_RUN,
    },
    required: ["agent"],
  },
  "open-browser": {
    description:
      "Open a browser node linked to this one; drive it with the browser tools.",
    properties: {
      url: str("first address to open"),
      title: str("node title"),
      "dry-run": DRY_RUN,
    },
  },
  sticky: {
    description: "Put a sticky note on the board.",
    properties: {
      title: str("note title"),
      content: str("note text, up to 20000 characters"),
      "dry-run": DRY_RUN,
    },
  },
  link: {
    description:
      "Link two nodes; supervises means `from` is the main and `to` the sub.",
    properties: {
      from: str("source node id or title (default: this node)"),
      to: str("target node id or title"),
      role: oneOf(
        ENUMS.edgeRoles,
        "peer (default for a new link) or supervises",
      ),
      "name-from": str("short name to give the source node"),
      "name-to": str("short name to give the target node"),
      name: str("alias of name-to"),
      "dry-run": DRY_RUN,
    },
    required: ["to"],
  },
  rename: {
    description: "Retitle a node or set its short name on the board.",
    properties: {
      node: str("node id or title (default: this node)"),
      title: str("new title"),
      handle: str("new short name"),
      "no-handle": bool("clear the short name"),
    },
  },
  color: {
    description: "Set a node's colour from the board palette.",
    properties: {
      color: oneOf(ENUMS.palette, "palette colour"),
      node: str("node id or title (default: this node)"),
    },
    required: ["color"],
  },
  interrupt: {
    description: "Stop the current turn of a linked agent below or beside you.",
    properties: {
      to: str("a linked node's id, name or title"),
      "dry-run": DRY_RUN,
    },
    required: ["to"],
  },
  close: {
    description: "Close a node; asks the person first when it has live work.",
    properties: {
      node: str("node id or title"),
      "dry-run": DRY_RUN,
    },
    required: ["node"],
  },
  send: {
    description:
      "Type a message into a linked agent's terminal and press Enter; queued while it is busy. Branch on `outcome` and `code`, never on the prose.",
    properties: {
      to: str("a linked node's id, name or title"),
      body: str("the message"),
      key: str("idempotency key"),
      "no-queue": bool("refuse instead of queueing when the target is busy"),
      interrupt: bool("stop the target's current turn first"),
      unverified: bool(
        "send to a terminal with no state adapter, on PTY observation alone",
      ),
      "dry-run": DRY_RUN,
    },
    required: ["to", "body"],
  },
  outbox: {
    description: "Your deliveries still waiting to be sent.",
    properties: {
      to: str("only those to this node"),
      limit: int("how many (default 20)", 1),
    },
  },
  cancel: {
    description: "Drop one queued delivery.",
    properties: { id: str("the queued id from `send` or `outbox`") },
    required: ["id"],
  },
  team: {
    description:
      "Open up to 6 agents at once, optionally chained or gathered, each linked as your sub.",
    properties: {
      member: strings(
        'one per agent: "AGENT[@MODEL]|TITLE|TASK[|worktree=DIR]"',
        1,
      ),
      chain: bool("each member waits for the previous one"),
      gather: str('"AGENT|TITLE|TASK" for one more that waits for all'),
      ...LAUNCH_OPTIONS,
      "dry-run": DRY_RUN,
    },
    required: ["member"],
  },
};

// ---------------------------------------------------------------------------
// Context verbs (`/context-link/<verb>`)

const NODE = str(
  "which linked node: its id, name or title (defaults to the only link)",
);

const CONTEXT: Record<ContextVerb, Row> = {
  list: { description: "List the nodes linked to this one." },
  summary: {
    description: "A ≤2 KB digest of a linked node; read this first.",
    properties: { node: NODE },
  },
  transcript: {
    description:
      "The linked node's transcript, 20 entries by default, capped at 32 KB.",
    properties: {
      node: NODE,
      n: int("how many entries", 1),
      since: bool("only what is new since your last read"),
      full: bool("lift the 32 KB cap, up to max-kb"),
      "max-kb": int("with full: the cap in KB, at most 128", 1),
    },
  },
  terminal: {
    description:
      "The linked node's terminal screen, 40 lines by default (max 200).",
    properties: { node: NODE, n: int("how many lines", 1) },
  },
};

// ---------------------------------------------------------------------------
// Browser verbs (`/browser/<verb>`), generated

/** Value placeholders in `verb-spec.ts` that stand for a whole number. */
const NUMERIC_VALUES = new Set(["N", "MS", "PX"]);

function browserFlag(flag: BrowserFlagSpec): JsonSchema {
  if (flag.value === undefined) return bool(flag.help);
  const scalar: JsonSchema = NUMERIC_VALUES.has(flag.value)
    ? { type: "integer" }
    : { type: "string" };
  return flag.repeat === true
    ? { type: "array", items: scalar, description: flag.help }
    : { ...scalar, description: flag.help };
}

// ---------------------------------------------------------------------------
// The table

const PATH_PREFIX: Record<VerbGroup, string> = {
  canvas: "/control/",
  context: "/context-link/",
  browser: "/browser/",
};

export function toolName(group: VerbGroup, verb: string): string {
  return `${group}_${verb.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

function object(row: Row): JsonSchema {
  return {
    type: "object",
    properties: row.properties ?? {},
    ...(row.required === undefined || row.required.length === 0
      ? {}
      : { required: row.required }),
    additionalProperties: false,
  };
}

function fromRows(group: VerbGroup, rows: Record<string, Row>): VerbTool[] {
  return Object.entries(rows).map(([verb, row]) => ({
    name: toolName(group, verb),
    group,
    verb,
    path: `${PATH_PREFIX[group]}${encodeURIComponent(verb)}`,
    description: row.description,
    inputSchema: object(row),
    ...(row.binding === undefined ? {} : { binding: row.binding }),
  }));
}

function browserTools(): VerbTool[] {
  return BROWSER_VERB_SPECS.map((spec) => {
    const properties: Record<string, JsonSchema> = {};
    for (const flag of flagsOf(spec)) properties[flag.name] = browserFlag(flag);
    return {
      name: toolName("browser", spec.name),
      group: "browser" as const,
      verb: spec.name,
      path: `${PATH_PREFIX.browser}${encodeURIComponent(spec.name)}`,
      description: spec.help,
      inputSchema: object({ description: spec.help, properties }),
      long: true,
    };
  });
}

/** Every tool, canvas first, then context, then browser. */
export const VERB_TOOLS: readonly VerbTool[] = [
  ...fromRows("canvas", CANVAS),
  ...fromRows("context", CONTEXT),
  ...browserTools(),
];

export function toolByName(name: string): VerbTool | undefined {
  return VERB_TOOLS.find((tool) => tool.name === name);
}

/**
 * Turns a tool call's arguments into the `args` object the route takes.
 *
 * The CLI only ever puts strings, booleans and arrays of strings on the wire,
 * and several runtime readers only accept those (`Args.text` ignores a
 * number), so numbers become their decimal text. A key the schema does not
 * declare, or a value of the wrong kind, is refused here rather than sent:
 * the model gets a precise error instead of a verb that silently ignored it.
 * A `false` boolean is dropped — the CLI cannot send one either.
 */
export function toWireArgs(
  tool: VerbTool,
  input: unknown,
): { ok: Record<string, JsonValue> } | { error: string } {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) {
    return { error: `${tool.name}: arguments must be an object` };
  }
  const properties = tool.inputSchema.properties ?? {};
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const schema = properties[key];
    if (schema === undefined) {
      return { error: `${tool.name}: unknown argument \`${key}\`` };
    }
    const converted = convert(schema, value);
    if (converted === undefined) {
      return {
        error: `${tool.name}: \`${key}\` must be ${describeType(schema)}`,
      };
    }
    if (converted === false) continue;
    out[key] = converted;
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in out)) {
      return { error: `${tool.name}: missing required argument \`${key}\`` };
    }
  }
  return { ok: out };
}

function convert(schema: JsonSchema, value: unknown): JsonValue | undefined {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value))
        return String(value);
      return typeof value === "string" && /^[+-]?\d+$/.test(value.trim())
        ? value
        : undefined;
    case "string":
      if (typeof value !== "string") return undefined;
      return schema.enum === undefined || schema.enum.includes(value)
        ? value
        : undefined;
    case "array": {
      const items = Array.isArray(value) ? value : [value];
      const out: string[] = [];
      for (const item of items) {
        const converted = convert(schema.items ?? { type: "string" }, item);
        if (typeof converted !== "string") return undefined;
        out.push(converted);
      }
      return out;
    }
    default:
      return undefined;
  }
}

function describeType(schema: JsonSchema): string {
  if (schema.enum !== undefined) return `one of ${schema.enum.join(", ")}`;
  if (schema.type === "array")
    return `a list of ${describeType(schema.items ?? { type: "string" })}s`;
  return `a ${schema.type ?? "value"}`;
}
