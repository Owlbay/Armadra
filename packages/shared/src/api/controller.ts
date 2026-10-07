import { z } from "zod";

/** Local controller v1. Append optional fields; reject unknown major versions. */
export const CONTROLLER_PROTOCOL = 1;
export const CONTROLLER_PATH = "/controller/v1/commands";
export const CONTROLLER_LIMITS = {
  bodyBytes: 256 * 1024,
  responseBytes: 32 * 1024,
  summaryBytes: 8 * 1024,
  nodes: 32,
  links: 128,
  tasks: 6,
  concurrency: 4,
  waitSeconds: 60,
  events: 50,
} as const;
export const CONTROLLER_METHODS = [
  "doctor",
  "workspaces.list",
  "connect",
  "disconnect",
  "boards.list",
  "board.get",
  "graph.validate",
  "graph.apply",
  "run.start",
  "run.get",
  "run.wait",
  "run.cancel",
  "run.artifacts",
] as const;
export type ControllerMethod = (typeof CONTROLLER_METHODS)[number];
export const ControllerCommandSchema = z
  .object({
    schemaVersion: z.literal(CONTROLLER_PROTOCOL),
    requestId: z.string().min(1).max(128),
    instanceId: z.string().min(1).max(128),
    method: z.enum(CONTROLLER_METHODS),
    params: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ControllerCommand = z.infer<typeof ControllerCommandSchema>;
export interface ControllerReply {
  schemaVersion: 1;
  ok: boolean;
  requestId: string;
  data?: unknown;
  error?: { code: string; message: string };
}

export const ControllerNodeRefSchema = z.union([
  z.object({ id: z.string().uuid() }).strict(),
  z.object({ key: z.string().min(1).max(64) }).strict(),
]);
const position = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict();
const size = z
  .object({
    width: z.number().positive().max(10000),
    height: z.number().positive().max(10000),
  })
  .strict();
export const ControllerNodeDataSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("terminal"),
      agent: z
        .object({
          id: z.enum(["codex", "claude", "opencode", "pi", "omp", "copilot"]),
          permissionMode: z
            .enum(["default", "auto-edit", "full-auto", "plan"])
            .optional(),
          model: z.string().min(1).max(120).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sticky"),
      content: z.string().max(20000).default(""),
    })
    .strict(),
  z.object({ kind: z.literal("group") }).strict(),
  z
    .object({
      kind: z.literal("editor"),
      path: z.string().min(1).max(4000),
      readonly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("diff"),
      repoPath: z.string().min(1).max(4000).default("."),
      scope: z.enum(["worktree", "staged"]).default("worktree"),
      paths: z.array(z.string().max(4000)).max(32).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("files"),
      path: z.string().min(1).max(4000).default("."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("browser"),
      url: z.string().max(4000).default(""),
    })
    .strict(),
]);
export const ControllerGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedUpdatedAt: z.string().min(1).max(64),
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z
            .object({
              op: z.literal("createNode"),
              key: z.string().min(1).max(64),
              type: z.enum([
                "terminal",
                "sticky",
                "group",
                "editor",
                "diff",
                "files",
                "browser",
              ]),
              title: z.string().min(1).max(160),
              data: ControllerNodeDataSchema,
              position: position.optional(),
              parent: ControllerNodeRefSchema.optional(),
            })
            .strict(),
          z
            .object({
              op: z.literal("updateNode"),
              node: ControllerNodeRefSchema,
              changes: z
                .object({
                  title: z.string().min(1).max(160).optional(),
                  color: z
                    .string()
                    .regex(/^#[0-9a-fA-F]{6}$/)
                    .optional(),
                  position: position.optional(),
                  size: size.optional(),
                  parentId: z.string().uuid().nullable().optional(),
                })
                .strict(),
            })
            .strict(),
          z
            .object({
              op: z.literal("createContextLink"),
              source: ControllerNodeRefSchema,
              target: ControllerNodeRefSchema,
              role: z.enum(["peer", "supervises"]).default("peer"),
            })
            .strict(),
          z
            .object({
              op: z.literal("removeContextLink"),
              edgeId: z.string().uuid(),
            })
            .strict(),
        ]),
      )
      .max(256),
  })
  .strict();
export type ControllerGraph = z.infer<typeof ControllerGraphSchema>;
