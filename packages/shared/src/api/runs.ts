import { z } from "zod";

export const RunInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedUpdatedAt: z.string().min(1).max(64),
    tasks: z
      .array(
        z
          .object({
            key: z.string().min(1).max(64),
            nodeId: z.string().uuid(),
            prompt: z
              .string()
              .min(1)
              .refine(
                (value) => [...value].length <= 2000,
                "Prompt exceeds the delivery limit",
              ),
            after: z.array(z.string().min(1).max(64)).max(6).default([]),
            outputs: z.array(z.string().min(1).max(4096)).max(16).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    maxConcurrency: z.number().int().min(1).max(4).default(2),
    deadlineSeconds: z.number().int().min(1).max(86400).default(3600),
  })
  .strict();
export type RunInput = z.infer<typeof RunInputSchema>;
export const ManualRunResponseSchema = z.object({
  runId: z.string(),
  state: z.string(),
});
export const RunStates = [
  "queued",
  "running",
  "blocked",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;
export const RunTaskStates = [
  "pending",
  "starting",
  "delivering",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
