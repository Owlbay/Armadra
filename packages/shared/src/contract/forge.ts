import { z } from "zod";

import {
  forgeAutoMergeSchema,
  forgeBranchDeletionSchema,
  forgeChecksSchema,
  forgeConfigListSchema,
  forgeConfigSchema,
  forgeDetectionSchema,
  forgeFilesSchema,
  forgeIssuePageSchema,
  forgeIssueSchema,
  forgeMergeOptionsSchema,
  forgeMergedSchema,
  forgePullPageSchema,
  forgePullSchema,
} from "../api/forge.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `forge.*`（契约 §41.2）：Gitea / Forgejo 与 GitLab 的 issue、PR（GitLab 的
 * merge request）与配置。GitHub 仓库走 `github.*`（§41.1）——这里只用 `resolve`
 * 认出它是 GitHub，然后把面板交还给那一面。
 *
 * 出参复用 `api/forge.ts` 那套 schema：页面本来就拿它们解析，契约不另写一份。
 * 入参只校形状（字段的类型）：缺没缺、编号是否合法、`state` / `method` 是不是
 * 认识的值、字符串多长这些判断在域里（`core/forge/`），旧路径与 procedure 走同
 * 一份实现，拒绝的码与原话一样，所以这里不加 `min` / `max` 与必填之类会让入参
 * 校验抢在域前面拒绝的约束。
 *
 * 旧路径的参数是路径段与查询串：`number`、`limit`、`expectedRevision` 以字符串
 * 到达，procedure 里是数字，两种拼法都收。GitLab 多级子组的 `owner`（`group/sub`）
 * 整条编码成一段。配置有两个路径形（只有主机、主机加仓库），各是一对 procedure。
 *
 * 令牌只在 `putHostConfig` / `putRepoConfig` 的入参里出去一次，答案、日志与错误
 * 细节都不带它。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：读是 `github:read`，
 * 写是 `github:write`；`resolve` 虽是 `POST`，只是读。
 */

const base = { since: "1.11", contract: "§41.2" } as const;
const REPO = "/api/forge/repos/{host}/{owner}/{name}";

const repoRef = z.object({
  host: z.string(),
  owner: z.string(),
  name: z.string(),
});

/** 一条 issue / PR 的编号：旧路径是路径段（字符串），procedure 是数字。 */
const numbered = repoRef.extend({ number: z.union([z.number(), z.string()]) });

const listing = repoRef.extend({
  state: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.union([z.number(), z.string()]).optional(),
});

const config = z.object({
  forge: z.string().optional(),
  apiBase: z.string().optional(),
  /** 缺省保留已存的令牌；`""` 删掉它。 */
  token: z.string().optional(),
  expectedRevision: z.number().int().optional(),
});

const mergeBody = numbered.extend({
  method: z.string().optional(),
  headSha: z.string().optional(),
});

const read = errors.pick(
  "bad_request",
  "not_found",
  "forge_not_configured",
  "forge_credential_rejected",
  "forge_forbidden",
  "forge_scope",
  "rate_limited",
  "forge_unavailable",
);
const write = errors.pick(
  "bad_request",
  "not_found",
  "conflict",
  "rebase_started",
  "forge_not_configured",
  "forge_credential_rejected",
  "forge_forbidden",
  "forge_scope",
  "rate_limited",
  "unknown_outcome",
  "forge_unavailable",
);
const settings = errors.pick("bad_request", "not_found", "conflict");

const removal = z.object({ removed: z.boolean() });
const cancellation = z.object({ cancelled: z.boolean() });

export const forge = {
  /* -------------------------------- 配置 -------------------------------- */
  /** 配置行，令牌只说有没有存。 */
  configs: oc
    .input(z.object({}))
    .output(forgeConfigListSchema)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: "/api/forge/configs" },
      }),
    ),
  /** 存一条主机级配置；`expectedRevision` 为 0 或缺省时新建。 */
  putHostConfig: oc
    .input(config.extend({ host: z.string() }))
    .output(forgeConfigSchema)
    .errors(settings)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "PUT", path: "/api/forge/configs/{host}" },
      }),
    ),
  removeHostConfig: oc
    .input(
      z.object({
        host: z.string(),
        expectedRevision: z.union([z.number(), z.string()]).optional(),
      }),
    )
    .output(removal)
    .errors(settings)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "DELETE", path: "/api/forge/configs/{host}" },
      }),
    ),
  /** 存一条仓库级配置（覆盖主机级）。 */
  putRepoConfig: oc
    .input(config.extend(repoRef.shape))
    .output(forgeConfigSchema)
    .errors(settings)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: {
          method: "PUT",
          path: "/api/forge/configs/{host}/{owner}/{name}",
        },
      }),
    ),
  removeRepoConfig: oc
    .input(
      repoRef.extend({ expectedRevision: z.union([z.number(), z.string()]) }),
    )
    .output(removal)
    .errors(settings)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: {
          method: "DELETE",
          path: "/api/forge/configs/{host}/{owner}/{name}",
        },
      }),
    ),

  /* ------------------------------- 识别 --------------------------------- */
  /** 一个 git 远端地址 → 识别结果。地址在体里：它可能带凭据。 */
  resolve: oc
    .input(z.object({ remoteUrl: z.string().optional() }))
    .output(forgeDetectionSchema)
    .errors(errors.pick("bad_request"))
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "POST", path: "/api/forge/resolve" },
      }),
    ),
  detect: oc
    .input(repoRef)
    .output(forgeDetectionSchema)
    .errors(errors.pick("bad_request"))
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: REPO },
      }),
    ),

  /* ------------------------------- issue -------------------------------- */
  /** 列表不带正文：详情把整份拿回来。 */
  issues: oc
    .input(listing)
    .output(forgeIssuePageSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/issues` },
      }),
    ),
  issue: oc
    .input(numbered)
    .output(forgeIssueSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/issues/{number}` },
      }),
    ),
  setIssueState: oc
    .input(numbered.extend({ state: z.string().optional() }))
    .output(forgeIssueSchema)
    .errors(write)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "PATCH", path: `${REPO}/issues/{number}` },
      }),
    ),

  /* --------------------------------- PR --------------------------------- */
  pulls: oc
    .input(listing)
    .output(forgePullPageSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/pulls` },
      }),
    ),
  createPull: oc
    .input(
      repoRef.extend({
        title: z.string().optional(),
        body: z.string().optional(),
        head: z.string().optional(),
        base: z.string().optional(),
        draft: z.boolean().optional(),
      }),
    )
    .output(forgePullSchema)
    .errors(write)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "POST", path: `${REPO}/pulls`, successStatus: 201 },
      }),
    ),
  pull: oc
    .input(numbered)
    .output(forgePullSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/pulls/{number}` },
      }),
    ),
  pullFiles: oc
    .input(numbered)
    .output(forgeFilesSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/pulls/{number}/files` },
      }),
    ),
  pullChecks: oc
    .input(numbered)
    .output(forgeChecksSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/pulls/{number}/checks` },
      }),
    ),
  /** 这个仓库现在能用的合并方式与自动合并（GitLab 按项目设置）。 */
  mergeOptions: oc
    .input(repoRef)
    .output(forgeMergeOptionsSchema)
    .errors(read)
    .meta(
      meta({
        ...base,
        scope: "github:read",
        legacy: { method: "GET", path: `${REPO}/merge-options` },
      }),
    ),
  /** 按页面显示过的 head 合并：head 动了答 `conflict`。 */
  merge: oc
    .input(mergeBody)
    .output(forgeMergedSchema)
    .errors(write)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "POST", path: `${REPO}/pulls/{number}/merge` },
      }),
    ),
  /** 流水线 / 检查通过后合并（GitLab、Gitea）；没有这个能力的平台答 `bad_request`。 */
  autoMerge: oc
    .input(mergeBody)
    .output(forgeAutoMergeSchema)
    .errors(write)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "POST", path: `${REPO}/pulls/{number}/auto-merge` },
      }),
    ),
  cancelAutoMerge: oc
    .input(numbered)
    .output(cancellation)
    .errors(write)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: {
          method: "DELETE",
          path: `${REPO}/pulls/{number}/auto-merge`,
        },
      }),
    ),
  /** 合并后删源分支：分支动过、受保护、来自 fork 或还没合并时答 `deleted: false`。 */
  deleteBranch: oc
    .input(numbered.extend({ headSha: z.string().optional() }))
    .output(forgeBranchDeletionSchema)
    .errors(write)
    .meta(
      meta({
        ...base,
        scope: "github:write",
        legacy: { method: "DELETE", path: `${REPO}/pulls/{number}/branch` },
      }),
    ),
};
