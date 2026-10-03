import { z } from "zod";

/**
 * Workflows and runners (contract §15, docs/design/coordinator-agent.md §5).
 * Skeleton: G1-8 fills in drafts, templates and runs; G2-3 adds the
 * automation target.
 */

/** The three step kinds of a workflow draft. */
export const WORKFLOW_STEP_KINDS = ["prompt", "collect", "gate"] as const;
export const workflowStepKindSchema = z.enum(WORKFLOW_STEP_KINDS);

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];
