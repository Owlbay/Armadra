import { z } from "zod";

/**
 * ACP — the Agent Client Protocol surface (contract §14,
 * docs/design/acp-session-view.md). Skeleton: G1-4 (§14.1) and G2-1
 * (§14.2–§14.4) fill in sessions, events and approvals.
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

export type AcpSupport = (typeof ACP_SUPPORT)[number];
export type AcpResume = (typeof ACP_RESUME)[number];
export type AgentAcpInfo = z.infer<typeof agentAcpInfoSchema>;
