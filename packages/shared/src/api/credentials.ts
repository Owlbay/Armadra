import { z } from "zod";

/**
 * Node credentials — `credentialRef` (contract §20,
 * docs/design/completion-architecture.md §9.1). Skeleton: G1-1 fills in the
 * routes, the `kind` table and the refusal codes.
 */

/**
 * One credential entry as the API answers it. The value lives in the secret
 * store and never travels: `isSet` is all a response says about it.
 */
export const credentialEntrySchema = z.looseObject({
  ref: z.string().min(1).max(200),
  providerId: z.string().min(1).max(120),
  kind: z.string().min(1).max(60),
  label: z.string().max(200),
  isSet: z.boolean(),
});

export type CredentialEntry = z.infer<typeof credentialEntrySchema>;
