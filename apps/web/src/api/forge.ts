import {
  type ConfigurableForge,
  type ForgeConfig,
  type ForgeDetection,
  type ForgeIssue,
  type ForgePull,
  type ForgeRepo,
  forgeChecksSchema,
  forgeConfigListSchema,
  forgeConfigSchema,
  forgeDetectionSchema,
  forgeFilesSchema,
  forgeIssuePageSchema,
  forgeAutoMergeSchema,
  forgeBranchDeletionSchema,
  forgeIssueSchema,
  forgeMergeOptionsSchema,
  forgeMergedSchema,
  forgePullPageSchema,
  forgePullSchema,
} from "@armadra/shared";
import { z } from "zod";

import { currentClient } from "./client";
import { RuntimeConnectionError, RuntimeRequestError } from "./request";

/**
 * 托管平台面（契约 §29）：Gitea / Forgejo 与 GitLab 的 issue、PR（GitLab 的
 * merge request）、配置。GitHub 仓库仍走 `api/github.ts`（§5）——这里只用
 * `resolve` 认出它是 GitHub，然后把面板交还给那一面。
 *
 * 令牌只在 `putForgeConfig` 里出去一次；任何答复都不带它。
 *
 * 调用经 RPC 客户端（`client.forge.*`，契约 §41.2），发往当前源；答案仍过页面自己
 * 的 schema。
 */

export type {
  ConfigurableForge,
  ForgeConfig,
  ForgeDetection,
  ForgeIssue,
  ForgePull,
  ForgeRepo,
};
export type ForgeChecks = z.infer<typeof forgeChecksSchema>;
export type ForgeFile = z.infer<typeof forgeFilesSchema>["files"][number];
export type ForgeListState = "open" | "closed" | "all";
export type ForgeMergeMethod = "merge" | "squash" | "rebase";

/** 页面认得的拒绝。认不出的落在 `failed`，不软化成别的。 */
export type ForgeFailure =
  | "notConfigured"
  | "credentialRejected"
  | "forbidden"
  | "scope"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "unknownOutcome"
  | "rebaseStarted"
  | "invalid"
  | "unavailable"
  | "unsupported"
  | "network"
  | "failed";

export function forgeFailure(error: unknown): ForgeFailure {
  if (error instanceof RuntimeConnectionError) return "network";
  if (!(error instanceof RuntimeRequestError)) return "failed";
  switch (error.code) {
    case "forge_not_configured":
      return "notConfigured";
    case "forge_credential_rejected":
      return "credentialRejected";
    case "forge_forbidden":
    case "forbidden":
      return "forbidden";
    case "forge_scope":
      return "scope";
    case "not_found":
      return "notFound";
    case "conflict":
      return "conflict";
    case "rate_limited":
      return "rateLimited";
    case "unknown_outcome":
      return "unknownOutcome";
    case "rebase_started":
      return "rebaseStarted";
    case "bad_request":
      return "invalid";
    case "forge_unavailable":
      return "unavailable";
    default:
      // 没装托管平台域的 core（库没过统一迁移）答 501 / 404。
      return error.status === 501 || error.status === 404
        ? "unsupported"
        : "failed";
  }
}

/** i18n 键：`forge.failure.<种类>`。 */
export function forgeFailureKey(error: unknown): string {
  return `forge.failure.${forgeFailure(error)}`;
}

/**
 * 配置行的键：`<host>` 或 `<host>/<owner>/<name>` → 一对 procedure 的入参。owner
 * 可以是多级子组（`<host>/group/sub/name`）：首段是主机、末段是名字，中间整条
 * 作 owner（线上编码成路径的一段，契约 §41.2）。
 */
export function configTarget(
  repoKey: string,
): { host: string } | { host: string; owner: string; name: string } {
  const parts = repoKey.split("/");
  if (parts.length < 3) return { host: parts.join("/") };
  return {
    host: parts[0] ?? "",
    owner: parts.slice(1, -1).join("/"),
    name: parts[parts.length - 1] ?? "",
  };
}

/** 当前源的 `forge.*`（契约 §41.2）；换了源，后面的调用就发往新的源。 */
const rpc = () => currentClient().forge;

/** 一个 git 远端地址 → 识别结果。地址在请求体里：它可能带凭据。 */
export async function resolveForge(remoteUrl: string): Promise<ForgeDetection> {
  return forgeDetectionSchema.parse(await rpc().resolve({ remoteUrl }));
}

/** 一个已知仓库（外部连接里记着的那个）→ 识别结果。 */
export async function detectForge(repo: ForgeRepo): Promise<ForgeDetection> {
  return forgeDetectionSchema.parse(await rpc().detect(repo));
}

export async function forgeConfigs(): Promise<ForgeConfig[]> {
  return forgeConfigListSchema.parse(await rpc().configs({})).configs;
}

export async function putForgeConfig(
  repoKey: string,
  input: {
    forge: ConfigurableForge;
    apiBase: string;
    token?: string;
    expectedRevision: number;
  },
): Promise<ForgeConfig> {
  const target = configTarget(repoKey);
  return forgeConfigSchema.parse(
    "owner" in target
      ? await rpc().putRepoConfig({ ...target, ...input })
      : await rpc().putHostConfig({ ...target, ...input }),
  );
}

export async function deleteForgeConfig(
  repoKey: string,
  expectedRevision: number,
): Promise<void> {
  const target = configTarget(repoKey);
  if ("owner" in target) {
    await rpc().removeRepoConfig({ ...target, expectedRevision });
  } else {
    await rpc().removeHostConfig({ ...target, expectedRevision });
  }
}

export async function forgeIssues(
  repo: ForgeRepo,
  state: ForgeListState,
  cursor: string | null = null,
) {
  return forgeIssuePageSchema.parse(
    await rpc().issues({ ...repo, state, ...(cursor ? { cursor } : {}) }),
  );
}

export async function forgeIssue(repo: ForgeRepo, number: number) {
  return forgeIssueSchema.parse(await rpc().issue({ ...repo, number }));
}

export async function setForgeIssueState(
  repo: ForgeRepo,
  number: number,
  state: "open" | "closed",
) {
  return forgeIssueSchema.parse(
    await rpc().setIssueState({ ...repo, number, state }),
  );
}

export async function forgePulls(
  repo: ForgeRepo,
  state: ForgeListState,
  cursor: string | null = null,
) {
  return forgePullPageSchema.parse(
    await rpc().pulls({ ...repo, state, ...(cursor ? { cursor } : {}) }),
  );
}

export async function forgePull(repo: ForgeRepo, number: number) {
  return forgePullSchema.parse(await rpc().pull({ ...repo, number }));
}

export async function createForgePull(
  repo: ForgeRepo,
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  },
) {
  return forgePullSchema.parse(await rpc().createPull({ ...repo, ...input }));
}

export async function forgePullFiles(repo: ForgeRepo, number: number) {
  return forgeFilesSchema.parse(await rpc().pullFiles({ ...repo, number }))
    .files;
}

export async function forgePullChecks(repo: ForgeRepo, number: number) {
  return forgeChecksSchema.parse(await rpc().pullChecks({ ...repo, number }));
}

export async function mergeForgePull(
  repo: ForgeRepo,
  number: number,
  input: { method: ForgeMergeMethod; headSha: string },
) {
  return forgeMergedSchema.parse(
    await rpc().merge({ ...repo, number, ...input }),
  );
}

export type ForgeMergeOptions = z.infer<typeof forgeMergeOptionsSchema>;

/** 这个仓库现在能用的合并方式与自动合并（GitLab 按项目设置，§29.6）。 */
export async function forgeMergeOptions(
  repo: ForgeRepo,
): Promise<ForgeMergeOptions> {
  return forgeMergeOptionsSchema.parse(await rpc().mergeOptions(repo));
}

/** 流水线通过后合并（GitLab）；项目开了合并列车时排进列车。 */
export async function autoMergeForgePull(
  repo: ForgeRepo,
  number: number,
  input: { method: ForgeMergeMethod; headSha: string },
) {
  return forgeAutoMergeSchema.parse(
    await rpc().autoMerge({ ...repo, number, ...input }),
  );
}

export async function cancelAutoMergeForgePull(
  repo: ForgeRepo,
  number: number,
): Promise<void> {
  await rpc().cancelAutoMerge({ ...repo, number });
}

/**
 * 合并后删源分支（Gitea / GitLab）：带页面上显示的 head；分支动过、受保护、
 * 来自 fork 或还没合并时答 `{ deleted: false, reasonCode }` 而不是照删。
 */
export async function deleteForgeBranch(
  repo: ForgeRepo,
  number: number,
  headSha: string,
) {
  return forgeBranchDeletionSchema.parse(
    await rpc().deleteBranch({ ...repo, number, headSha }),
  );
}

/** 平台显示名：品牌名不翻译。 */
export const FORGE_NAMES: Record<string, string> = {
  github: "GitHub",
  gitea: "Gitea",
  gitlab: "GitLab",
};

/** 问不到 `merge-options`（旧 core）时各平台的合并方式。 */
export function mergeMethods(forge: string): ForgeMergeMethod[] {
  return forge === "gitlab"
    ? ["merge", "squash"]
    : ["merge", "squash", "rebase"];
}
