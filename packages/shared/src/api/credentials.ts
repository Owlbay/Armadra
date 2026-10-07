import { z } from "zod";

/**
 * Node credentials — `credentialRef` (contract §20,
 * docs/design/completion-architecture.md §9.1, CLI 协作 §7.3).
 *
 * An entry is a named credential for one CLI: which CLI (`providerId`), which
 * kind (one row of the core's closed `kind` table) and a display `label`. The
 * value lives in the execution host's secret store and never travels back:
 * `isSet` is all a response says about it.
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
  /** Last time a node terminal took the value (ms); absent when never. */
  lastUsedAt: z.number().int().optional(),
});

export type CredentialEntry = z.infer<typeof credentialEntrySchema>;

/**
 * One row of the core's `kind` table. The variable a kind sets is the core's
 * business and is not on the wire; `enabled: false` rows are listed so the
 * settings page can show them greyed out until the real-account checks
 * (CLI 协作 §7.4 T4–T7) open them.
 */
export const credentialKindSchema = z.looseObject({
  providerId: z.string(),
  kind: z.string(),
  enabled: z.boolean(),
});

export type CredentialKind = z.infer<typeof credentialKindSchema>;

/**
 * `GET /api/credentials`. `available: false` means this host refuses to store
 * credentials at all (`reason` says why: the secret backend reports `file`,
 * or the platform has no credential-capable launcher yet).
 */
export const credentialListSchema = z.looseObject({
  backend: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
  kinds: z.array(credentialKindSchema),
  entries: z.array(credentialEntrySchema),
});

export type CredentialList = z.infer<typeof credentialListSchema>;

/** `POST /api/credentials`. The `ref` is minted by the core. */
export const createCredentialRequestSchema = z.object({
  providerId: z.string().min(1).max(120),
  kind: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(8_192),
});

export type CreateCredentialRequest = z.infer<
  typeof createCredentialRequestSchema
>;

/** `PATCH /api/credentials/{ref}`: rename, or replace the value. */
export const updateCredentialRequestSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  value: z.string().min(1).max(8_192).optional(),
});

export type UpdateCredentialRequest = z.infer<
  typeof updateCredentialRequestSchema
>;

/** The refusal codes of §20, on the credential routes and `POST /api/terminals`. */
export const CREDENTIAL_ERROR_CODES = [
  "credential_not_found",
  "credential_mismatch",
  "credential_kind_disabled",
  "credential_unsupported_here",
  "credential_backend_insecure",
  "credential_unset",
  "credential_unavailable",
] as const;

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];
