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
  forgeIssueSchema,
  forgeMergedSchema,
  forgePullPageSchema,
  forgePullSchema,
} from "@armadra/shared";
import { z } from "zod";

import {
  RuntimeConnectionError,
  RuntimeRequestError,
  json,
  query,
  request,
} from "./request";

/**
 * 托管平台面（契约 §29）：Gitea / Forgejo 与 GitLab 的 issue、PR（GitLab 的
 * merge request）、配置。GitHub 仓库仍走 `api/github.ts`（§5）——这里只用
 * `resolve` 认出它是 GitHub，然后把面板交还给那一面。
 *
 * 令牌只在 `putForgeConfig` 里出去一次；任何答复都不带它。
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

/** GitLab 多级子组的 owner（`group/sub`）整条编码成一段：路由按段匹配。 */
export function repoPath(repo: ForgeRepo): string {
  return `/api/forge/repos/${query(repo.host)}/${query(repo.owner)}/${query(repo.name)}`;
}

/**
 * 配置行的键：`<host>` 或 `<host>/<owner>/<name>` → 路径。owner 可以是多级子组
 * （`<host>/group/sub/name`）：首段是主机、末段是名字，中间整条作 owner 编码成一段。
 */
export function configPath(repoKey: string): string {
  const parts = repoKey.split("/");
  if (parts.length < 3) {
    return `/api/forge/configs/${parts.map(query).join("/")}`;
  }
  const host = parts[0] ?? "";
  const name = parts[parts.length - 1] ?? "";
  const owner = parts.slice(1, -1).join("/");
  return `/api/forge/configs/${query(host)}/${query(owner)}/${query(name)}`;
}

/** 一个 git 远端地址 → 识别结果。地址在请求体里：它可能带凭据。 */
export function resolveForge(remoteUrl: string): Promise<ForgeDetection> {
  return request("/api/forge/resolve", forgeDetectionSchema, {
    method: "POST",
    ...json({ remoteUrl }),
  });
}

export async function forgeConfigs(): Promise<ForgeConfig[]> {
  return (await request("/api/forge/configs", forgeConfigListSchema)).configs;
}

export function putForgeConfig(
  repoKey: string,
  input: {
    forge: ConfigurableForge;
    apiBase: string;
    token?: string;
    expectedRevision: number;
  },
): Promise<ForgeConfig> {
  return request(configPath(repoKey), forgeConfigSchema, {
    method: "PUT",
    ...json(input),
  });
}

export async function deleteForgeConfig(
  repoKey: string,
  expectedRevision: number,
): Promise<void> {
  await request(
    `${configPath(repoKey)}?expectedRevision=${expectedRevision}`,
    z.object({ removed: z.boolean() }),
    { method: "DELETE" },
  );
}

function listQuery(state: ForgeListState, cursor: string | null): string {
  const params = new URLSearchParams({ state });
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function forgeIssues(
  repo: ForgeRepo,
  state: ForgeListState,
  cursor: string | null = null,
) {
  return request(
    `${repoPath(repo)}/issues?${listQuery(state, cursor)}`,
    forgeIssuePageSchema,
  );
}

export function forgeIssue(repo: ForgeRepo, number: number) {
  return request(`${repoPath(repo)}/issues/${number}`, forgeIssueSchema);
}

export function setForgeIssueState(
  repo: ForgeRepo,
  number: number,
  state: "open" | "closed",
) {
  return request(`${repoPath(repo)}/issues/${number}`, forgeIssueSchema, {
    method: "PATCH",
    ...json({ state }),
  });
}

export function forgePulls(
  repo: ForgeRepo,
  state: ForgeListState,
  cursor: string | null = null,
) {
  return request(
    `${repoPath(repo)}/pulls?${listQuery(state, cursor)}`,
    forgePullPageSchema,
  );
}

export function forgePull(repo: ForgeRepo, number: number) {
  return request(`${repoPath(repo)}/pulls/${number}`, forgePullSchema);
}

export function createForgePull(
  repo: ForgeRepo,
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
  },
) {
  return request(`${repoPath(repo)}/pulls`, forgePullSchema, {
    method: "POST",
    ...json(input),
  });
}

export async function forgePullFiles(repo: ForgeRepo, number: number) {
  return (
    await request(`${repoPath(repo)}/pulls/${number}/files`, forgeFilesSchema)
  ).files;
}

export function forgePullChecks(repo: ForgeRepo, number: number) {
  return request(`${repoPath(repo)}/pulls/${number}/checks`, forgeChecksSchema);
}

export function mergeForgePull(
  repo: ForgeRepo,
  number: number,
  input: { method: ForgeMergeMethod; headSha: string },
) {
  return request(`${repoPath(repo)}/pulls/${number}/merge`, forgeMergedSchema, {
    method: "POST",
    ...json(input),
  });
}

/** 平台显示名：品牌名不翻译。 */
export const FORGE_NAMES: Record<string, string> = {
  github: "GitHub",
  gitea: "Gitea",
  gitlab: "GitLab",
};

/** 各平台能用的合并方式：GitLab 的 rebase 是另一个异步动作，不接。 */
export function mergeMethods(forge: string): ForgeMergeMethod[] {
  return forge === "gitlab"
    ? ["merge", "squash"]
    : ["merge", "squash", "rebase"];
}
