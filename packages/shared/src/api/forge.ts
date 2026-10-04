import { z } from "zod";

/**
 * Hosted forges (contract §29): GitHub, Gitea / Forgejo and (from G5-15)
 * GitLab behind one shape. GitHub keeps its own `/api/github/*` surface (§5);
 * `/api/forge/*` reaches the same client and credential for GitHub remotes.
 *
 * Tokens never appear here — a config only says whether one is stored.
 */

export const FORGE_KINDS = ["github", "gitea", "gitlab"] as const;
export const forgeKindSchema = z.enum(FORGE_KINDS);
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** Forges configurable through `/api/forge/configs` (GitHub uses §5). */
export const CONFIGURABLE_FORGES = ["gitea", "gitlab"] as const;
export const configurableForgeSchema = z.enum(CONFIGURABLE_FORGES);
export type ConfigurableForge = (typeof CONFIGURABLE_FORGES)[number];

export const forgeRepoSchema = z.object({
  host: z.string(),
  owner: z.string(),
  name: z.string(),
});
export type ForgeRepo = z.infer<typeof forgeRepoSchema>;

/** `GET /api/forge/repos/{host}/{owner}/{name}`, `POST /api/forge/resolve` (§29.2). */
export const forgeDetectionSchema = z.object({
  repository: forgeRepoSchema,
  forge: forgeKindSchema.nullable(),
  source: z.enum(["github", "config"]).nullable(),
  configKey: z.string().nullable(),
  apiBase: z.string().nullable(),
  webUrl: z.string().nullable(),
  credential: z.boolean(),
  accountLogin: z.string().nullable(),
});
export type ForgeDetection = z.infer<typeof forgeDetectionSchema>;

/** One row of `GET /api/forge/configs` (§29.3). */
export const forgeConfigSchema = z.object({
  repoKey: z.string(),
  forge: forgeKindSchema,
  apiBase: z.string(),
  credential: z.boolean(),
  accountLogin: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
});
export type ForgeConfig = z.infer<typeof forgeConfigSchema>;

export const forgeConfigListSchema = z.object({
  configs: z.array(forgeConfigSchema),
});

/** `PUT /api/forge/configs/{host}[/{owner}/{name}]` body. */
export const putForgeConfigSchema = z.object({
  forge: configurableForgeSchema,
  /** Site root or API root (`…/api/v1` for Gitea, `…/api/v4` for GitLab). */
  apiBase: z.string().min(1).max(2048),
  /** Omit to keep the stored token (dropped if `apiBase` changes); `""` removes it. */
  token: z.string().max(512).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type PutForgeConfig = z.infer<typeof putForgeConfigSchema>;

export const forgeIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  /** Empty in list responses; the detail carries the whole text. */
  body: z.string(),
  state: z.enum(["open", "closed"]),
  author: z.string().nullable(),
  labels: z.array(z.string()),
  commentCount: z.number().int().nonnegative(),
  url: z.string(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  closedAtMs: z.number().int().nullable(),
});
export type ForgeIssue = z.infer<typeof forgeIssueSchema>;

export const forgePullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  author: z.string().nullable(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  url: z.string(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  mergedAtMs: z.number().int().nullable(),
  /** Queued to merge when the pipeline succeeds (GitLab, §29.6). */
  autoMerge: z.boolean().default(false),
  /** The head branch lives in another repository. */
  fromFork: z.boolean().default(false),
});
export type ForgePull = z.infer<typeof forgePullSchema>;

export const forgeIssuePageSchema = z.object({
  items: z.array(forgeIssueSchema),
  nextCursor: z.string().nullable(),
});
export const forgePullPageSchema = z.object({
  items: z.array(forgePullSchema),
  nextCursor: z.string().nullable(),
});

export const forgeFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum(["added", "modified", "removed", "renamed", "other"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullable(),
});
export type ForgeFile = z.infer<typeof forgeFileSchema>;
export const forgeFilesSchema = z.object({ files: z.array(forgeFileSchema) });

export const forgeCheckStateSchema = z.enum([
  "pending",
  "success",
  "failure",
  "neutral",
]);
export const forgeChecksSchema = z.object({
  headSha: z.string(),
  rollup: z.enum(["pending", "success", "failure", "neutral", "none"]),
  checks: z.array(
    z.object({
      name: z.string(),
      state: forgeCheckStateSchema,
      url: z.string().nullable(),
    }),
  ),
});
export type ForgeChecks = z.infer<typeof forgeChecksSchema>;

export const createForgePullSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).optional(),
  head: z.string().min(1).max(255),
  base: z.string().min(1).max(255),
  draft: z.boolean().optional(),
});

export const mergeForgePullSchema = z.object({
  method: z.enum(["merge", "squash", "rebase"]).optional(),
  headSha: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/),
});

export const forgeMergedSchema = z.object({
  merged: z.literal(true),
  sha: z.string().nullable(),
});

/** `GET …/merge-options` (§29.4): the methods this repository accepts now. */
export const forgeMergeOptionsSchema = z.object({
  methods: z.array(z.enum(["merge", "squash", "rebase"])),
  /** "Merge when the pipeline succeeds" is available (GitLab). */
  autoMerge: z.boolean().default(false),
  /** The project runs merge trains: auto-merge joins the train. */
  mergeTrain: z.boolean().default(false),
});
export type ForgeMergeOptions = z.infer<typeof forgeMergeOptionsSchema>;

/** `POST …/pulls/{number}/auto-merge`: merged now, or queued (maybe on a train). */
export const forgeAutoMergeSchema = z.object({
  merged: z.boolean(),
  sha: z.string().nullable(),
  train: z.boolean(),
});
export type ForgeAutoMerge = z.infer<typeof forgeAutoMergeSchema>;

/** `DELETE …/pulls/{number}/branch`: deleted, or why not (`reasonCode`). */
export const forgeBranchDeletionSchema = z.object({
  deleted: z.boolean(),
  reasonCode: z.string(),
});

/** Refusal codes of `/api/forge/*` besides the shared ones (§29.5). */
export const FORGE_ERROR_CODES = [
  "forge_not_configured",
  "forge_credential_rejected",
  "forge_forbidden",
  "forge_scope",
  "forge_unavailable",
  "unknown_outcome",
  "rate_limited",
  "conflict",
  "rebase_started",
] as const;
