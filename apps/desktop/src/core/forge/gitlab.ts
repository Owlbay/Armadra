/**
 * GitLab（`/api/v4`，自托管与 gitlab.com 同一套）。
 *
 *   * 认证 `PRIVATE-TOKEN: <令牌>`；令牌要 `read_api`（读）或 `api`（写）。
 *     403 的答复里 `error` 是 `insufficient_scope`（经典令牌）或
 *     `insufficient_granular_scope`（细粒度令牌）时译成 `scopeMissing`：该换令牌，
 *     而不是去改仓库权限。远端的说明文字从不往外传。
 *   * merge request ↔ pull request：编号用 `iid`（项目内编号），`opened` ↔ `open`，
 *     `source_branch` / `target_branch` ↔ head / base。issue 与 MR 是两套编号，
 *     不像 GitHub / Gitea 共用一个空间。
 *   * 项目用 URL 编码的完整路径寻址（`owner%2Fname`，多级子组是
 *     `group%2Fsub%2Fname`）；子组怎么从远端地址认出来见 `service.ts::resolve`。
 *   * 列表的 `closed` 含已合并：GitLab 的 `state=closed` 不含 merged，所以按
 *     `all` 取再滤掉开着的，一页可能不满。
 *   * 差异来自 `/merge_requests/{iid}/diffs`（15.7 起）；增删行数从补丁里数。
 *   * 检查用 commit statuses（流水线的作业也写在这里），同名只留 id 最大的那条；
 *     允许失败的作业失败记 `neutral`。
 *   * 合并：`PUT …/merge` 带 `sha`，远端 head 变了就 409；`squash` 对应
 *     `squash: true`。能用哪几种看项目的 `merge_method` / `squash_option`
 *     （{@link GitlabForge.mergeOptions}）。`rebase` 只在项目要线性历史
 *     （`ff` / `rebase_merge`）时有：源分支落后目标时先发 `PUT …/rebase`
 *     （异步），答 `REBASE_STARTED`——变基会换 head，评审者要先看新的 head
 *     再合；不落后就照常 `PUT …/merge`，由项目设置决定快进或半线性。
 *   * 草稿：建草稿 MR 加标题前缀 `Draft: `，读时看 `draft`。
 */

import {
  type CreatePullInput,
  DEFAULT_LIMIT,
  type Forge,
  type ForgeCheck,
  type ForgeCheckState,
  type ForgeChecks,
  ForgeError,
  type ForgeFile,
  type ForgeFileStatus,
  type ForgeIssue,
  type ForgeIssueState,
  type ForgeMergeMethod,
  type ForgeMergeable,
  type ForgeMergeOptions,
  type ForgeMerged,
  type ForgePage,
  type ForgePull,
  type ForgePullState,
  type ForgeRepo,
  type ListOptions,
  MAX_BODY,
  MAX_FILES,
  MAX_LIMIT,
  MAX_TITLE,
  type MergeInput,
  forgeError,
  rollupOf,
  timeMs,
  validRefName,
  validSha,
} from "./types";
import {
  ForgeTransport,
  type TokenSource,
  decodeJson,
  normalizeBase,
} from "./transport";
import { validName } from "../github/remote";
import { count, numbered, text, webUrl } from "./wire";

const API_SUFFIX = "/api/v4";
/** 差异按页取；三页一百个文件到 {@link MAX_FILES}。 */
const DIFF_PAGE = 100;

/** 403 答复里表示「令牌缺范围」的两个机器码。 */
export const GITLAB_SCOPE_ERRORS = [
  "insufficient_scope",
  "insufficient_granular_scope",
] as const;

/**
 * 用户给的地址 → API 根。给站点根（`https://gitlab.example.com`）或 API 根
 * （`…/api/v4`）都行；不收的地址答 `undefined`。
 */
export function gitlabApiBase(value: string): string | undefined {
  const base = normalizeBase(value);
  if (base === undefined) return undefined;
  return base.endsWith(API_SUFFIX) ? base : `${base}${API_SUFFIX}`;
}

/** API 根 → 站点根，拼仓库的网页地址用。 */
export function gitlabWebRoot(apiBase: string): string {
  return apiBase.endsWith(API_SUFFIX)
    ? apiBase.slice(0, -API_SUFFIX.length)
    : apiBase;
}

/**
 * GitLab 的 403 细分。只读 `error` 这一个机器码；答复不是 JSON、没有这个字段、
 * 或者不是 403，交回通用翻译。
 */
export function gitlabRefusal(
  status: number,
  body: Buffer,
): ForgeError | undefined {
  if (status !== 403 || body.byteLength > 64 * 1024) return undefined;
  let code: unknown;
  try {
    code = (JSON.parse(body.toString("utf8")) as { error?: unknown })?.error;
  } catch {
    return undefined;
  }
  return typeof code === "string" &&
    (GITLAB_SCOPE_ERRORS as readonly string[]).includes(code)
    ? forgeError("scopeMissing", code.toUpperCase())
    : undefined;
}

interface WireUser {
  username?: string;
}
interface WireIssue {
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  author?: WireUser | null;
  labels?: unknown[] | null;
  user_notes_count?: number;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}
interface WireMergeRequest {
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author?: WireUser | null;
  source_branch?: string;
  target_branch?: string;
  sha?: string | null;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
}

/**
 * 项目设置 → 能用的合并方式。`merge_method`：`merge`（合并提交）只有 merge；
 * `rebase_merge`（半线性）有 merge 与「先变基再合」；`ff`（只快进）只有 rebase。
 * `squash_option`：`never` 去掉 squash，`always` 只剩 squash，其余加上 squash。
 */
export function gitlabMergeMethods(project: {
  merge_method?: string;
  squash_option?: string;
}): ForgeMergeMethod[] {
  if (project.squash_option === "always") return ["squash"];
  const methods: ForgeMergeMethod[] =
    project.merge_method === "ff"
      ? ["rebase"]
      : project.merge_method === "rebase_merge"
        ? ["merge", "rebase"]
        : ["merge"];
  if (project.squash_option !== "never") methods.push("squash");
  return methods;
}
interface WireProject {
  merge_method?: string;
  squash_option?: string;
}
interface WireDiff {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}
interface WireStatus {
  id?: number;
  name?: string;
  status?: string;
  allow_failure?: boolean;
  target_url?: string | null;
}

function login(user: WireUser | null | undefined): string | null {
  return typeof user?.username === "string" && user.username !== ""
    ? user.username
    : null;
}

function labelNames(value: unknown[] | null | undefined): string[] {
  return (value ?? [])
    .map((label) =>
      // `with_labels_details=true` 时是对象；缺省是字符串。
      typeof label === "string"
        ? text(label, 128)
        : text((label as { name?: unknown } | null)?.name, 128),
    )
    .filter((name) => name !== "")
    .slice(0, 100);
}

function toIssue(value: WireIssue): ForgeIssue {
  const closed = value.state === "closed";
  return {
    number: count(value.iid),
    title: text(value.title, MAX_TITLE * 4),
    body: text(value.description, MAX_BODY * 4),
    state: closed ? "closed" : "open",
    author: login(value.author),
    labels: labelNames(value.labels),
    commentCount: count(value.user_notes_count),
    url: webUrl(value.web_url),
    createdAtMs: timeMs(value.created_at) ?? 0,
    updatedAtMs: timeMs(value.updated_at) ?? 0,
    closedAtMs: closed ? timeMs(value.closed_at) : null,
  };
}

function pullState(value: string | undefined): ForgePullState {
  if (value === "merged") return "merged";
  if (value === "closed") return "closed";
  // `opened` 与 `locked`（正在合并）都还开着。
  return "open";
}

function mergeable(
  value: WireMergeRequest,
  state: ForgePullState,
): ForgeMergeable {
  if (state !== "open") return "unknown";
  const detailed = value.detailed_merge_status;
  if (
    value.has_conflicts === true ||
    detailed === "conflict" ||
    detailed === "broken_status" ||
    value.merge_status === "cannot_be_merged"
  ) {
    return "conflicting";
  }
  if (detailed === "mergeable") return "mergeable";
  // 老版本只有 `merge_status`；新版本里 detailed 说别的（流水线、审批…）时，
  // 那不是冲突，也还不能合。
  if (detailed === undefined && value.merge_status === "can_be_merged") {
    return "mergeable";
  }
  return "unknown";
}

/** merge request → pull。 */
export function toPull(value: WireMergeRequest): ForgePull {
  const state = pullState(value.state);
  const title = text(value.title, MAX_TITLE * 4);
  const sha = value.sha ?? "";
  return {
    number: count(value.iid),
    title,
    body: text(value.description, MAX_BODY * 4),
    state,
    draft:
      value.draft === true ||
      value.work_in_progress === true ||
      /^\s*(\[draft\]|\(draft\)|draft:)/i.test(title),
    author: login(value.author),
    baseRef: text(value.target_branch, 255),
    headRef: text(value.source_branch, 255),
    headSha: validSha(sha) ? sha : "",
    mergeable: mergeable(value, state),
    url: webUrl(value.web_url),
    createdAtMs: timeMs(value.created_at) ?? 0,
    updatedAtMs: timeMs(value.updated_at) ?? 0,
    mergedAtMs: state === "merged" ? timeMs(value.merged_at) : null,
  };
}

function fileStatus(value: WireDiff): ForgeFileStatus {
  if (value.new_file === true) return "added";
  if (value.deleted_file === true) return "removed";
  if (value.renamed_file === true) return "renamed";
  return "modified";
}

/** 一份补丁里的增删行数（不数 `+++` / `---` 头）。 */
export function lineCounts(patch: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

/** 补丁从第一个 `@@` 起；二进制、过大被折叠的文件没有 `@@`，记 `null`。 */
function patchOf(diff: unknown): string | null {
  if (typeof diff !== "string" || diff === "") return null;
  const start = diff.startsWith("@@") ? 0 : diff.indexOf("\n@@") + 1;
  if (start < 0 || !diff.startsWith("@@", start)) return null;
  return diff.slice(start).replace(/\n$/, "");
}

function checkState(value: WireStatus): ForgeCheckState {
  switch (value.status) {
    case "success":
      return "success";
    case "failed":
      return value.allow_failure === true ? "neutral" : "failure";
    case "canceled":
      return "failure";
    case "skipped":
    case "manual":
      return "neutral";
    default:
      // created / pending / running / preparing / scheduled / waiting_for_resource
      return "pending";
  }
}

function projectPath(repo: ForgeRepo, suffix = ""): string {
  // owner 可以是多级子组 `group/sub`：整条路径一起 URL 编码成一段。
  if (
    !repo.owner.split("/").every((segment) => validName(segment)) ||
    !validName(repo.name)
  ) {
    throw forgeError("invalid", "REPOSITORY_INVALID");
  }
  return `/projects/${encodeURIComponent(`${repo.owner}/${repo.name}`)}${suffix}`;
}

function listQuery(
  options: ListOptions,
  kind: "issues" | "merge_requests",
): Record<string, string> {
  const limit =
    options.limit > 0 && options.limit <= MAX_LIMIT
      ? options.limit
      : DEFAULT_LIMIT;
  const query: Record<string, string> = {
    per_page: String(limit),
    order_by: "updated_at",
    sort: "desc",
  };
  if (options.page > 1) query.page = String(options.page);
  if (options.state === "open") query.state = "opened";
  else if (options.state === "closed") {
    // MR 的 `closed` 要连已合并一起：取全部、本地滤掉开着的。
    query.state = kind === "issues" ? "closed" : "all";
  }
  return query;
}

function array<T>(value: unknown): T[] {
  if (!Array.isArray(value))
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  return value as T[];
}

export interface GitlabOptions {
  readonly apiBase: string;
  readonly token: TokenSource;
  readonly fetch?: typeof globalThis.fetch;
}

export class GitlabForge implements Forge {
  readonly kind = "gitlab" as const;
  private readonly http: ForgeTransport;

  constructor(options: GitlabOptions) {
    this.http = new ForgeTransport({
      base: options.apiBase,
      token: options.token,
      authorize: (token) => ({ "private-token": token }),
      refuse: gitlabRefusal,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** 令牌属于谁。配置时核验一次，免得存下一个远端不认的令牌。 */
  async viewer(): Promise<string> {
    const value = decodeJson<WireUser>(await this.http.get("/user"));
    const name = login(value);
    if (name === null) throw forgeError("unavailable", "RESPONSE_MALFORMED");
    return name;
  }

  async listIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>> {
    const response = await this.http.get(
      projectPath(repo, "/issues"),
      listQuery(options, "issues"),
    );
    return {
      items: array<WireIssue>(decodeJson(response)).map(toIssue),
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
    };
  }

  async getIssue(repo: ForgeRepo, number: number): Promise<ForgeIssue> {
    const response = await this.http.get(
      projectPath(repo, `/issues/${numbered(number)}`),
    );
    return toIssue(decodeJson<WireIssue>(response));
  }

  async setIssueState(
    repo: ForgeRepo,
    number: number,
    state: ForgeIssueState,
  ): Promise<ForgeIssue> {
    const response = await this.http.write(
      "PUT",
      projectPath(repo, `/issues/${numbered(number)}`),
      { state_event: state === "closed" ? "close" : "reopen" },
    );
    return toIssue(decodeJson<WireIssue>(response));
  }

  async listPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>> {
    const response = await this.http.get(
      projectPath(repo, "/merge_requests"),
      listQuery(options, "merge_requests"),
    );
    let items = array<WireMergeRequest>(decodeJson(response)).map(toPull);
    if (options.state === "closed") {
      items = items.filter((pull) => pull.state !== "open");
    }
    return {
      items,
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
    };
  }

  async getPull(repo: ForgeRepo, number: number): Promise<ForgePull> {
    return toPull(await this.rawPull(repo, number));
  }

  private async rawPull(
    repo: ForgeRepo,
    number: number,
  ): Promise<WireMergeRequest> {
    const response = await this.http.get(
      projectPath(repo, `/merge_requests/${numbered(number)}`),
    );
    return decodeJson<WireMergeRequest>(response);
  }

  private async project(repo: ForgeRepo): Promise<WireProject> {
    return decodeJson<WireProject>(await this.http.get(projectPath(repo)));
  }

  async mergeOptions(repo: ForgeRepo): Promise<ForgeMergeOptions> {
    return { methods: gitlabMergeMethods(await this.project(repo)) };
  }

  async createPull(
    repo: ForgeRepo,
    input: CreatePullInput,
  ): Promise<ForgePull> {
    if (!validRefName(input.head) || !validRefName(input.base)) {
      throw forgeError("invalid", "REF_INVALID");
    }
    const response = await this.http.write(
      "POST",
      projectPath(repo, "/merge_requests"),
      {
        source_branch: input.head,
        target_branch: input.base,
        title: input.draft ? `Draft: ${input.title}` : input.title,
        description: input.body,
      },
    );
    return toPull(decodeJson<WireMergeRequest>(response));
  }

  async pullFiles(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeFile[]> {
    const index = numbered(number);
    const files: ForgeFile[] = [];
    let page = 1;
    while (files.length < MAX_FILES) {
      const query: Record<string, string> = { per_page: String(DIFF_PAGE) };
      if (page > 1) query.page = String(page);
      const response = await this.http.get(
        projectPath(repo, `/merge_requests/${index}/diffs`),
        query,
      );
      for (const value of array<WireDiff>(decodeJson(response))) {
        if (files.length >= MAX_FILES) break;
        const path = text(
          value.deleted_file === true ? value.old_path : value.new_path,
          4096,
        );
        const previous = text(value.old_path, 4096);
        const patch = patchOf(value.diff);
        const lines = lineCounts(patch ?? "");
        files.push({
          path,
          previousPath: previous === "" || previous === path ? null : previous,
          status: fileStatus(value),
          additions: lines.additions,
          deletions: lines.deletions,
          patch,
        });
      }
      if (response.nextPage <= page) break;
      page = response.nextPage;
    }
    return files;
  }

  async checks(repo: ForgeRepo, number: number): Promise<ForgeChecks> {
    const pull = await this.getPull(repo, number);
    if (pull.headSha === "") {
      return { headSha: "", rollup: "none", checks: [] };
    }
    const response = await this.http.get(
      projectPath(repo, `/repository/commits/${pull.headSha}/statuses`),
      { per_page: "100" },
    );
    // 同名的多次上报（重跑的作业）只留 id 最大的那条。
    const latest = new Map<string, WireStatus>();
    for (const status of array<WireStatus>(decodeJson(response))) {
      const name = text(status.name, 256);
      if (name === "") continue;
      const seen = latest.get(name);
      if (seen === undefined || count(status.id) > count(seen.id)) {
        latest.set(name, status);
      }
    }
    const checks: ForgeCheck[] = [...latest.entries()].map(([name, status]) => {
      const url = webUrl(status.target_url);
      return { name, state: checkState(status), url: url === "" ? null : url };
    });
    return { headSha: pull.headSha, rollup: rollupOf(checks), checks };
  }

  async merge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeMerged> {
    if (!validSha(input.headSha)) throw forgeError("invalid", "SHA_INVALID");
    if (input.method === "rebase") {
      const methods = gitlabMergeMethods(await this.project(repo));
      if (!methods.includes("rebase")) {
        throw forgeError("invalid", "MERGE_METHOD_UNSUPPORTED");
      }
    }
    const raw = await this.rawPull(repo, number);
    const before = toPull(raw);
    if (before.state === "merged")
      throw forgeError("conflict", "ALREADY_MERGED");
    if (before.state !== "open") throw forgeError("conflict", "NOT_OPEN");
    if (before.headSha !== input.headSha) {
      throw forgeError("conflict", "HEAD_CHANGED");
    }
    if (
      input.method === "rebase" &&
      raw.detailed_merge_status === "need_rebase"
    ) {
      // 变基是异步的，而且会换 head：发出去就停，不在同一次请求里接着合。
      await this.http.write(
        "PUT",
        projectPath(repo, `/merge_requests/${numbered(number)}/rebase`),
      );
      throw forgeError("conflict", "REBASE_STARTED");
    }
    let response;
    try {
      response = await this.http.write(
        "PUT",
        projectPath(repo, `/merge_requests/${numbered(number)}/merge`),
        { sha: input.headSha, squash: input.method === "squash" },
      );
    } catch (error) {
      // 409：`sha` 与源分支的 head 不符；405 / 422：现在合不了（草稿、流水线、冲突）。
      if (error instanceof ForgeError && error.reason === "CONFLICT") {
        throw forgeError("conflict", "HEAD_CHANGED");
      }
      if (
        error instanceof ForgeError &&
        (error.reason === "NOT_ALLOWED" || error.reason === "UNPROCESSABLE")
      ) {
        throw forgeError("conflict", "NOT_MERGEABLE");
      }
      throw error;
    }
    let after: WireMergeRequest;
    try {
      after = decodeJson<WireMergeRequest>(response);
    } catch {
      throw forgeError("unknownOutcome", "RESPONSE_MALFORMED");
    }
    // 答复是合并之后的 MR；它还没到 merged（排进了合并队列）时如实说「结果未知」。
    if (after.state !== "merged") {
      throw forgeError("unknownOutcome", "MERGE_PENDING");
    }
    const sha = after.merge_commit_sha ?? after.squash_commit_sha ?? "";
    return { merged: true, sha: validSha(sha) ? sha : null };
  }
}
