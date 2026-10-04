import { z } from "zod";

import {
  agentDriverSchema,
  agentIdSchema,
  permissionModeSchema,
} from "../domain/index.js";

/**
 * ACP — the Agent Client Protocol surface (contract §14,
 * docs/design/acp-session-view.md). §14.1 is G1-4's; the session, event and
 * approval shapes below (§14.2–§14.4) follow design §9.2 and are what the
 * session view (G1-6) reads. G2-1 serves them and writes the contract text.
 *
 * Every wire object is `looseObject`: the protocol is younger than this file,
 * and a field an adapter adds must not make the page drop a whole frame.
 */

/** How a CLI speaks ACP: its own entry point, an official or a community adapter. */
export const ACP_SUPPORT = ["native", "official", "community"] as const;
export const acpSupportSchema = z.enum(ACP_SUPPORT);

/** Which ACP method resumes a session across processes; `none` = start a new one. */
export const ACP_RESUME = ["load", "resume", "none"] as const;
export const acpResumeSchema = z.enum(ACP_RESUME);

/** The `acp` field of a `GET /api/agents` row (contract §14.1). */
export const agentAcpInfoSchema = z.looseObject({
  support: acpSupportSchema,
  /** Program looked up on the augmented PATH (`opencode`, `codex-acp`, …). */
  program: z.string(),
  installed: z.boolean(),
  version: z.string().optional(),
  resume: acpResumeSchema,
});

/* ------------------------------ ACP payloads ------------------------------ */

/** One ACP content block; only `text` is rendered, the rest are kept. */
export const acpContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

export const ACP_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;
export const acpToolKindSchema = z.enum(ACP_TOOL_KINDS);

export const ACP_TOOL_CALL_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
] as const;
export const acpToolCallStatusSchema = z.enum(ACP_TOOL_CALL_STATUSES);

/** `tool_call.content[]`: a content block, a file diff, or a terminal id. */
export const acpToolCallContentSchema = z.union([
  z.looseObject({ type: z.literal("content"), content: acpContentBlockSchema }),
  z.looseObject({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullish(),
    newText: z.string(),
  }),
  z.looseObject({ type: z.literal("terminal"), terminalId: z.string() }),
]);

export const acpToolCallLocationSchema = z.looseObject({
  path: z.string(),
  line: z.number().int().nullish(),
});

/**
 * A `tool_call` / `tool_call_update` body, and the `toolCall` of a permission
 * request. Everything but the id may be absent on an update; an unknown kind
 * or status is kept as absent rather than failing the frame.
 */
export const acpToolCallSchema = z.looseObject({
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: acpToolKindSchema.optional().catch(undefined),
  status: acpToolCallStatusSchema.optional().catch(undefined),
  content: z.array(acpToolCallContentSchema).optional(),
  locations: z.array(acpToolCallLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

export const ACP_PERMISSION_OPTION_KINDS = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
] as const;
export const acpPermissionOptionKindSchema = z.enum(
  ACP_PERMISSION_OPTION_KINDS,
);

export const acpPermissionOptionSchema = z.looseObject({
  optionId: z.string(),
  name: z.string(),
  kind: acpPermissionOptionKindSchema,
});

export const acpSessionModeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
});

export const acpModeStateSchema = z.looseObject({
  currentModeId: z.string(),
  availableModes: z.array(acpSessionModeSchema),
});

export const acpPlanEntrySchema = z.looseObject({
  content: z.string(),
  priority: z.string().optional(),
  status: z.string().optional(),
});

/**
 * `session/update`'s `update`, as the core forwards it verbatim. Only the
 * discriminator is required here; the page narrows each variant with the
 * schemas above and ignores the ones it does not draw.
 */
export const acpSessionUpdateSchema = z.looseObject({
  sessionUpdate: z.string(),
});

export const ACP_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const;
export const acpStopReasonSchema = z.enum(ACP_STOP_REASONS);

/* ------------------------------ §14.2 routes ------------------------------ */

/**
 * `POST /api/acp/sessions` → the session row (`terminalSessionSchema`,
 * `backend: "acp"`).
 */
export const createAcpSessionRequestSchema = z.object({
  workspaceId: z.string(),
  nodeId: z.string(),
  cwd: z.string(),
  agentId: agentIdSchema,
  permissionMode: permissionModeSchema.optional(),
  model: z.string().optional(),
  /** The CLI's own session id to pick up again. */
  resume: z.string().optional(),
  /** The first prompt, sent once the session is open. */
  prompt: z.string().optional(),
});

/** `POST /api/acp/sessions/{id}/prompt`. */
export const acpPromptRequestSchema = z.object({ text: z.string().min(1) });
export const acpPromptResponseSchema = z.looseObject({ turnId: z.string() });

/** `POST /api/acp/sessions/{id}/mode`. */
export const acpModeRequestSchema = z.object({ modeId: z.string().min(1) });

/**
 * A pending `session/request_permission`, as stored in
 * `agent_approvals.request_json` and as `agent.approval` carries it.
 */
export const acpPermissionRequestSchema = z.looseObject({
  protocol: z.literal("acp"),
  toolCall: acpToolCallSchema,
  options: z.array(acpPermissionOptionSchema),
});

/** A pending permission listed with the log, so a reload can draw the card. */
export const acpPendingPermissionSchema = acpPermissionRequestSchema.extend({
  pendingId: z.string(),
});

/* -------------------- §26.1 elicitation, §26.2 models -------------------- */

/** One field of an elicitation form: the flat primitive types the spec allows. */
export const acpElicitationFieldSchema = z.union([
  z.looseObject({
    type: z.literal("string"),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string()).optional(),
    enumNames: z.array(z.string()).optional(),
    format: z.string().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    default: z.string().optional(),
  }),
  z.looseObject({
    type: z.enum(["number", "integer"]),
    title: z.string().optional(),
    description: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    default: z.number().optional(),
  }),
  z.looseObject({
    type: z.literal("boolean"),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional(),
  }),
]);

export const acpElicitationFormSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), acpElicitationFieldSchema),
  required: z.array(z.string()).optional(),
});

/**
 * An `elicitation/create` as the core stores it. `requestedSchema` is absent
 * when the agent sent a form the page cannot draw (only decline / cancel
 * remain); `url` only in `url` mode.
 */
export const acpElicitationSchema = z.looseObject({
  message: z.string(),
  mode: z.enum(["form", "url"]).catch("form"),
  requestedSchema: acpElicitationFormSchema.optional(),
  url: z.string().optional(),
});

/**
 * A pending `elicitation/create`, as stored in `agent_approvals.request_json`
 * and as `agent.approval` carries it (contract §26.1).
 */
export const acpElicitationRequestSchema = z.looseObject({
  protocol: z.literal("acp"),
  elicitation: acpElicitationSchema,
});

/** A pending elicitation listed with the log (`elicitations`). */
export const acpPendingElicitationSchema = acpElicitationRequestSchema.extend({
  pendingId: z.string(),
});

export const ACP_ELICITATION_ACTIONS = ["accept", "decline", "cancel"] as const;
export const acpElicitationActionSchema = z.enum(ACP_ELICITATION_ACTIONS);

/** The answer the agent receives; `content` only with `accept`. */
export const acpElicitationAnswerSchema = z.object({
  action: acpElicitationActionSchema,
  content: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

/**
 * `POST /api/approvals/{pendingId}/answer` for an elicitation: `decision` may
 * be left out (it follows from the action).
 */
export const acpElicitationAnswerRequestSchema = z.object({
  decision: z.enum(["allow", "deny"]).optional(),
  elicitation: acpElicitationAnswerSchema,
});

export const acpModelSchema = z.looseObject({
  modelId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
});

/** The model catalog (same shape as `modes`). */
export const acpModelStateSchema = z.looseObject({
  currentModelId: z.string(),
  availableModels: z.array(acpModelSchema),
});

/** `PUT /api/acp/sessions/{id}/model`. */
export const acpModelRequestSchema = z.object({ modelId: z.string().min(1) });

/** One normalised transcript block (`core/history/types.ts::Block`). */
export const acpTranscriptBlockSchema = z.union([
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({
    type: z.literal("tool_use"),
    name: z.string(),
    id: z.string().optional(),
    input: z.unknown().optional(),
  }),
  z.looseObject({
    type: z.literal("tool_result"),
    id: z.string().optional(),
    content: z.unknown().optional(),
  }),
]);

/** One normalised record (`core/history/types.ts::TranscriptEntry`). */
export const acpTranscriptEntrySchema = z.looseObject({
  role: z.enum(["user", "assistant", "system"]),
  blocks: z.array(acpTranscriptBlockSchema),
  endOffset: z.number().int().nonnegative(),
  at: z.string().optional(),
});

/**
 * `GET /api/acp/sessions/{id}/log?after=<offset>` — the mirror read from
 * `after`. `modes` and `pending` describe the live process (absent when it is
 * not running), so a reloaded page can draw the mode picker and the open
 * permission card without asking the adapter to replay.
 */
export const acpLogResponseSchema = z.looseObject({
  entries: z.array(acpTranscriptEntrySchema),
  endOffset: z.number().int().nonnegative(),
  modes: acpModeStateSchema.nullish(),
  /** §26.2: `null` when the client or the agent offers no model choice. */
  models: acpModelStateSchema.nullish(),
  pending: z.array(acpPendingPermissionSchema).optional(),
  /** §26.1: pending `elicitation/create` requests. */
  elicitations: z.array(acpPendingElicitationSchema).optional(),
});

/** `POST /api/acp/nodes/{nodeId}/driver` (design §4.2). */
export const acpDriverRequestSchema = z.object({ driver: agentDriverSchema });
export const acpDriverResponseSchema = z.looseObject({
  sessionId: z.string(),
  resumed: z.boolean(),
});

/* ------------------------------ §14.3 events ------------------------------ */

export const acpUpdateEventSchema = z.object({
  type: z.literal("acp.update"),
  sessionId: z.string(),
  nodeId: z.string(),
  update: acpSessionUpdateSchema,
});

/**
 * A turn ended. `error` is present when the prompt failed with a JSON-RPC
 * error rather than a stop reason.
 */
export const acpTurnEventSchema = z.object({
  type: z.literal("acp.turn"),
  sessionId: z.string(),
  nodeId: z.string(),
  turnId: z.string(),
  stopReason: acpStopReasonSchema.optional().catch(undefined),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
});

export const acpDriverEventSchema = z.object({
  type: z.literal("acp.driver"),
  nodeId: z.string(),
  driver: agentDriverSchema,
  sessionId: z.string(),
  resumed: z.boolean(),
});

/* §14.4: the answer is `answerApprovalRequestSchema` (`agents.ts`) with its
 * optional `optionId`. */

export type AcpSupport = (typeof ACP_SUPPORT)[number];
export type AcpResume = (typeof ACP_RESUME)[number];
export type AgentAcpInfo = z.infer<typeof agentAcpInfoSchema>;
export type AcpContentBlock = z.infer<typeof acpContentBlockSchema>;
export type AcpToolKind = (typeof ACP_TOOL_KINDS)[number];
export type AcpToolCallStatus = (typeof ACP_TOOL_CALL_STATUSES)[number];
export type AcpToolCallContent = z.infer<typeof acpToolCallContentSchema>;
export type AcpToolCall = z.infer<typeof acpToolCallSchema>;
export type AcpPermissionOptionKind =
  (typeof ACP_PERMISSION_OPTION_KINDS)[number];
export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;
export type AcpSessionMode = z.infer<typeof acpSessionModeSchema>;
export type AcpModeState = z.infer<typeof acpModeStateSchema>;
export type AcpPlanEntry = z.infer<typeof acpPlanEntrySchema>;
export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;
export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];
export type CreateAcpSessionRequest = z.infer<
  typeof createAcpSessionRequestSchema
>;
export type AcpPermissionRequest = z.infer<typeof acpPermissionRequestSchema>;
export type AcpPendingPermission = z.infer<typeof acpPendingPermissionSchema>;
export type AcpTranscriptBlock = z.infer<typeof acpTranscriptBlockSchema>;
export type AcpTranscriptEntry = z.infer<typeof acpTranscriptEntrySchema>;
export type AcpLogResponse = z.infer<typeof acpLogResponseSchema>;
export type AcpDriverResponse = z.infer<typeof acpDriverResponseSchema>;
export type AcpUpdateEvent = z.infer<typeof acpUpdateEventSchema>;
export type AcpTurnEvent = z.infer<typeof acpTurnEventSchema>;
export type AcpDriverEvent = z.infer<typeof acpDriverEventSchema>;
export type AcpElicitationField = z.infer<typeof acpElicitationFieldSchema>;
export type AcpElicitationForm = z.infer<typeof acpElicitationFormSchema>;
export type AcpElicitation = z.infer<typeof acpElicitationSchema>;
export type AcpElicitationRequest = z.infer<typeof acpElicitationRequestSchema>;
export type AcpPendingElicitation = z.infer<typeof acpPendingElicitationSchema>;
export type AcpElicitationAction = (typeof ACP_ELICITATION_ACTIONS)[number];
export type AcpElicitationAnswer = z.infer<typeof acpElicitationAnswerSchema>;
export type AcpElicitationAnswerRequest = z.infer<
  typeof acpElicitationAnswerRequestSchema
>;
export type AcpModel = z.infer<typeof acpModelSchema>;
export type AcpModelState = z.infer<typeof acpModelStateSchema>;
