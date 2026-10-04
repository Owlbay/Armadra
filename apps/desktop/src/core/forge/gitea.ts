/**
 * Gitea / Forgejo（两者同一套 `/api/v1`）。
 *
 *   * 认证 `Authorization: token <令牌>`；令牌要 `read:repository`（读）与
 *     `write:repository` / `write:issue`（写）。
 *   * pull request 同名；检查用 commit statuses（Gitea Actions 也写这一张）。
 *   * 差异：文件表来自 `/pulls/{n}/files`，每个文件的补丁从 `/pulls/{n}.diff`
 *     按文件切出来（文件表本身不带补丁）。
 *   * 草稿：Gitea 按标题前缀 `WIP:` 认草稿，建草稿 PR 就加这个前缀。
 */

import {
  ALL_MERGE_METHODS,
  type CreatePullInput,
  DEFAULT_LIMIT,
  type Forge,
  type ForgeCheck,
  type ForgeCheckState,
  type ForgeBranchDeletion,
  type ForgeChecks,
  ForgeError,
  type ForgeFile,
  type ForgeFileStatus,
  type ForgeIssue,
  type ForgeIssueState,
  type ForgeMergeOptions,
  type ForgeMerged,
  type ForgePage,
  type ForgePull,
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

const API_SUFFIX = "/api/v1";

/**
 * 用户给的地址 → API 根。给站点根（`https://git.example.com`）或 API 根
 * （`…/api/v1`）都行；不收的地址答 `undefined`。
 */
export function giteaApiBase(value: string): string | undefined {
  const base = normalizeBase(value);
  if (base === undefined) return undefined;
  return base.endsWith(API_SUFFIX) ? base : `${base}${API_SUFFIX}`;
}

/** API 根 → 站点根，拼仓库的网页地址用。 */
export function giteaWebRoot(apiBase: string): string {
  return apiBase.endsWith(API_SUFFIX)
    ? apiBase.slice(0, -API_SUFFIX.length)
    : apiBase;
}

interface WireUser {
  login?: string;
}
interface WireLabel {
  name?: string;
}
interface WireIssue {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  user?: WireUser | null;
  labels?: WireLabel[] | null;
  comments?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: unknown;
}
interface WireBranch {
  ref?: string;
  sha?: string;
  repo_id?: number;
}
/** `GET /repos/{o}/{r}/branches/{b}`。 */
interface WireRepoBranch {
  name?: string;
  commit?: { id?: string } | null;
  protected?: boolean;
}
interface WirePull {
  number?: number;
  title?: string;
  body?: string;
  state?: string;
  draft?: boolean;
  user?: WireUser | null;
  base?: WireBranch | null;
  head?: WireBranch | null;
  mergeable?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}
interface WireFile {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}
interface WireStatus {
  context?: string;
  status?: string;
  state?: string;
  target_url?: string;
}

function login(user: WireUser | null | undefined): string | null {
  return typeof user?.login === "string" && user.login !== ""
    ? user.login
    : null;
}

function toIssue(value: WireIssue): ForgeIssue {
  return {
    number: count(value.number),
    title: text(value.title, MAX_TITLE * 4),
    body: text(value.body, MAX_BODY * 4),
    state: value.state === "closed" ? "closed" : "open",
    author: login(value.user),
    labels: (value.labels ?? [])
      .map((label) => text(label?.name, 128))
      .filter((name) => name !== "")
      .slice(0, 100),
    commentCount: count(value.comments),
    url: webUrl(value.html_url),
    createdAtMs: timeMs(value.created_at) ?? 0,
    updatedAtMs: timeMs(value.updated_at) ?? 0,
    closedAtMs: value.state === "closed" ? timeMs(value.closed_at) : null,
  };
}

function toPull(value: WirePull): ForgePull {
  const merged = value.merged === true;
  const state = merged
    ? "merged"
    : value.state === "closed"
      ? "closed"
      : "open";
  const title = text(value.title, MAX_TITLE * 4);
  return {
    number: count(value.number),
    title,
    body: text(value.body, MAX_BODY * 4),
    state,
    draft: value.draft === true || /^\s*\[?WIP\]?:?\s/i.test(title),
    author: login(value.user),
    baseRef: text(value.base?.ref, 255),
    headRef: text(value.head?.ref, 255),
    headSha: validSha(value.head?.sha ?? "") ? (value.head?.sha as string) : "",
    // Gitea 在算合并性时也答 false；已合并 / 已关的不再算。
    mergeable:
      state !== "open"
        ? "unknown"
        : value.mergeable === true
          ? "mergeable"
          : "conflicting",
    url: webUrl(value.html_url),
    createdAtMs: timeMs(value.created_at) ?? 0,
    updatedAtMs: timeMs(value.updated_at) ?? 0,
    mergedAtMs: merged ? timeMs(value.merged_at) : null,
    autoMerge: false,
    fromFork: forked(value.head?.repo_id, value.base?.repo_id),
  };
}

/** 两边仓库 id 都在且不同才算 fork；缺字段（老版本）按同仓库。 */
export function forked(head: unknown, base: unknown): boolean {
  return (
    typeof head === "number" &&
    typeof base === "number" &&
    head > 0 &&
    base > 0 &&
    head !== base
  );
}

/** 分支名进路径：逐段编码，斜杠留着（Gitea 的分支路由吃整条剩余路径）。 */
function branchPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function fileStatus(value: string | undefined): ForgeFileStatus {
  switch (value) {
    case "added":
      return "added";
    case "deleted":
      return "removed";
    case "renamed":
      return "renamed";
    case "changed":
    case "modified":
      return "modified";
    default:
      return "other";
  }
}

function checkState(value: string | undefined): ForgeCheckState {
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "warning":
      return "neutral";
    default:
      return "pending";
  }
}

/**
 * 把一份统一差异按文件切开，键是新路径（删除的文件是旧路径）。补丁从第一个
 * `@@` 开始，与 GitHub 的 `patch` 字段同一个起点；二进制文件没有 `@@`，不在表里。
 */
export function splitDiff(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  const blocks = diff.split(/^(?=diff --git )/m);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) continue;
    const lines = block.split("\n");
    let path = "";
    for (const line of lines) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("+++ b/")) path = line.slice(6);
      else if (line.startsWith("rename to ")) path = path || line.slice(10);
      else if (line.startsWith("--- a/") && path === "") path = line.slice(6);
    }
    if (path === "") {
      // 没有 `---` / `+++` 的块（纯改名、二进制）：头里 a/ 与 b/ 等长时取 b/。
      const header = (lines[0] ?? "").slice("diff --git ".length);
      const half = (header.length - 1) / 2;
      if (Number.isInteger(half) && header.startsWith("a/")) {
        path = header.slice(half + 1).replace(/^b\//, "");
      }
    }
    const hunk = block.indexOf("\n@@");
    if (path === "" || hunk < 0) continue;
    patches.set(path, block.slice(hunk + 1).replace(/\n$/, ""));
  }
  return patches;
}

function repoPath(repo: ForgeRepo, suffix = ""): string {
  if (!validName(repo.owner) || !validName(repo.name)) {
    throw forgeError("invalid", "REPOSITORY_INVALID");
  }
  return `/repos/${repo.owner}/${repo.name}${suffix}`;
}

function listQuery(options: ListOptions, kind: "issues" | "pulls") {
  const limit =
    options.limit > 0 && options.limit <= MAX_LIMIT
      ? options.limit
      : DEFAULT_LIMIT;
  const query: Record<string, string> = {
    state: options.state,
    limit: String(limit),
  };
  if (options.page > 1) query.page = String(options.page);
  if (kind === "issues") query.type = "issues";
  else query.sort = "recentupdate";
  return query;
}

export interface GiteaOptions {
  readonly apiBase: string;
  readonly token: TokenSource;
  readonly fetch?: typeof globalThis.fetch;
}

export class GiteaForge implements Forge {
  readonly kind = "gitea" as const;
  private readonly http: ForgeTransport;

  constructor(options: GiteaOptions) {
    this.http = new ForgeTransport({
      base: options.apiBase,
      token: options.token,
      authorize: (token) => ({ authorization: `token ${token}` }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** 令牌属于谁。配置时核验一次，免得存下一个远端不认的令牌。 */
  async viewer(): Promise<string> {
    const response = await this.http.get("/user");
    const value = decodeJson<WireUser>(response);
    const name = login(value);
    if (name === null) throw forgeError("unavailable", "RESPONSE_MALFORMED");
    return name;
  }

  async listIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>> {
    const response = await this.http.get(
      repoPath(repo, "/issues"),
      listQuery(options, "issues"),
    );
    const values = decodeJson<WireIssue[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    return {
      items: values.filter((value) => value.pull_request == null).map(toIssue),
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
    };
  }

  async getIssue(repo: ForgeRepo, number: number): Promise<ForgeIssue> {
    const response = await this.http.get(
      repoPath(repo, `/issues/${numbered(number)}`),
    );
    const value = decodeJson<WireIssue>(response);
    // 同一个编号空间里的 PR 不是 issue：关掉它的含义完全不同。
    if (value.pull_request != null) throw forgeError("notFound", "IS_PULL");
    return toIssue(value);
  }

  async setIssueState(
    repo: ForgeRepo,
    number: number,
    state: ForgeIssueState,
  ): Promise<ForgeIssue> {
    // 先读一次：PR 的编号经 issues 端点也改得动，那不是这个动词的意思。
    await this.getIssue(repo, number);
    const response = await this.http.write(
      "PATCH",
      repoPath(repo, `/issues/${numbered(number)}`),
      { state },
    );
    return toIssue(decodeJson<WireIssue>(response));
  }

  async listPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>> {
    const response = await this.http.get(
      repoPath(repo, "/pulls"),
      listQuery(options, "pulls"),
    );
    const values = decodeJson<WirePull[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    return {
      items: values.map(toPull),
      nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
    };
  }

  async getPull(repo: ForgeRepo, number: number): Promise<ForgePull> {
    const response = await this.http.get(
      repoPath(repo, `/pulls/${numbered(number)}`),
    );
    return toPull(decodeJson<WirePull>(response));
  }

  async createPull(
    repo: ForgeRepo,
    input: CreatePullInput,
  ): Promise<ForgePull> {
    if (!validRefName(input.head) || !validRefName(input.base)) {
      throw forgeError("invalid", "REF_INVALID");
    }
    const title = input.draft ? `WIP: ${input.title}` : input.title;
    const response = await this.http.write("POST", repoPath(repo, "/pulls"), {
      title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    return toPull(decodeJson<WirePull>(response));
  }

  async pullFiles(
    repo: ForgeRepo,
    number: number,
  ): Promise<readonly ForgeFile[]> {
    const index = numbered(number);
    const response = await this.http.get(
      repoPath(repo, `/pulls/${index}/files`),
      {
        limit: String(MAX_FILES),
      },
    );
    const values = decodeJson<WireFile[]>(response);
    if (!Array.isArray(values)) {
      throw forgeError("unavailable", "RESPONSE_MALFORMED");
    }
    const diff = await this.http.get(
      repoPath(repo, `/pulls/${index}.diff`),
      undefined,
      "text/plain",
    );
    const patches = splitDiff(diff.body.toString("utf8"));
    return values.slice(0, MAX_FILES).map((value) => {
      const path = text(value.filename, 4096);
      const previous = text(value.previous_filename, 4096);
      return {
        path,
        previousPath: previous === "" || previous === path ? null : previous,
        status: fileStatus(value.status),
        additions: count(value.additions),
        deletions: count(value.deletions),
        patch: patches.get(path) ?? null,
      };
    });
  }

  async checks(repo: ForgeRepo, number: number): Promise<ForgeChecks> {
    const pull = await this.getPull(repo, number);
    if (pull.headSha === "") {
      return { headSha: "", rollup: "none", checks: [] };
    }
    const response = await this.http.get(
      repoPath(repo, `/commits/${pull.headSha}/status`),
    );
    const combined = decodeJson<{ statuses?: WireStatus[] | null }>(response);
    // 同一个 context 的多次上报只留最新那条（远端按时间倒序给）。
    const seen = new Set<string>();
    const checks: ForgeCheck[] = [];
    for (const status of combined.statuses ?? []) {
      const name = text(status.context, 256);
      if (name === "" || seen.has(name)) continue;
      seen.add(name);
      const url = webUrl(status.target_url);
      checks.push({
        name,
        state: checkState(status.status ?? status.state),
        url: url === "" ? null : url,
      });
    }
    return { headSha: pull.headSha, rollup: rollupOf(checks), checks };
  }

  async merge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeMerged> {
    if (!validSha(input.headSha)) throw forgeError("invalid", "SHA_INVALID");
    const before = await this.getPull(repo, number);
    if (before.state === "merged")
      throw forgeError("conflict", "ALREADY_MERGED");
    if (before.state !== "open") throw forgeError("conflict", "NOT_OPEN");
    if (before.headSha !== input.headSha) {
      throw forgeError("conflict", "HEAD_CHANGED");
    }
    await this.http.write(
      "POST",
      repoPath(repo, `/pulls/${numbered(number)}/merge`),
      {
        Do: input.method,
        head_commit_id: input.headSha,
      },
    );
    // 合并的答复没有正文；合并提交从 PR 上读。读不到不改变「已合并」这个事实。
    try {
      const response = await this.http.get(repoPath(repo, `/pulls/${number}`));
      const sha = decodeJson<WirePull>(response).merge_commit_sha ?? "";
      return { merged: true, sha: validSha(sha) ? sha : null };
    } catch {
      return { merged: true, sha: null };
    }
  }

  async deleteBranch(
    repo: ForgeRepo,
    number: number,
    headSha: string,
  ): Promise<ForgeBranchDeletion> {
    if (!validSha(headSha)) throw forgeError("invalid", "SHA_INVALID");
    const pull = await this.getPull(repo, number);
    if (pull.state !== "merged") return refused("NOT_MERGED");
    if (pull.fromFork) return refused("FORK_BRANCH");
    if (!validRefName(pull.headRef) || pull.headRef === pull.baseRef) {
      return refused("BRANCH_PROTECTED");
    }
    const path = repoPath(repo, `/branches/${branchPath(pull.headRef)}`);
    let branch: WireRepoBranch;
    try {
      branch = decodeJson<WireRepoBranch>(await this.http.get(path));
    } catch (error) {
      if (error instanceof ForgeError && error.kind === "notFound") {
        return refused("ALREADY_DELETED");
      }
      throw error;
    }
    if (branch.protected === true) return refused("BRANCH_PROTECTED");
    if (branch.commit?.id !== headSha) return refused("BRANCH_MOVED");
    await this.http.write("DELETE", path);
    return { deleted: true, reasonCode: "" };
  }

  /** 不按仓库的 `allow_*` 细分：远端不收的方式由合并本身答 405 / 422。 */
  async mergeOptions(_repo: ForgeRepo): Promise<ForgeMergeOptions> {
    return { methods: ALL_MERGE_METHODS, autoMerge: false, mergeTrain: false };
  }
}

function refused(reasonCode: string): ForgeBranchDeletion {
  return { deleted: false, reasonCode };
}
