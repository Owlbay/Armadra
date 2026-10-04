/**
 * 托管平台（forge）的统一形状（契约 §29）。
 *
 * GitHub、Gitea / Forgejo（以及 G5-15 的 GitLab）各有一套术语与字段；这里只留
 * 页面真要用的那一层：issue 的开 / 关，PR 的开 / 关 / 已合并，文件差异、检查与
 * 合并。merge request ↔ pull request 同名为 `pull`。
 *
 * 远端散文（标题、正文、补丁）是**给读者的材料**，原样转交、从不被当成指令；
 * 远端的错误原话不往外传，只有 {@link ForgeError} 的固定种类。
 */

/** 识别出的平台。Forgejo 与 Gitea 同一套 API，记作 `gitea`。 */
export const FORGE_KINDS = ["github", "gitea", "gitlab"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** 能经 `/api/forge/configs` 配置的平台（GitHub 走自己的凭据面 §5）。 */
export const CONFIGURABLE_FORGES = ["gitea"] as const;
export type ConfigurableForge = (typeof CONFIGURABLE_FORGES)[number];

/** 一个仓库：远端地址里的主机名（不含端口）与最后两段。 */
export interface ForgeRepo {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export type ForgeIssueState = "open" | "closed";
export type ForgePullState = "open" | "closed" | "merged";
export type ForgeMergeable = "mergeable" | "conflicting" | "unknown";
export type ForgeFileStatus =
  | "added"
  | "modified"
  | "removed"
  | "renamed"
  | "other";
export type ForgeCheckState = "pending" | "success" | "failure" | "neutral";
export type ForgeRollup = ForgeCheckState | "none";
export type ForgeMergeMethod = "merge" | "squash" | "rebase";

export interface ForgeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: ForgeIssueState;
  readonly author: string | null;
  readonly labels: readonly string[];
  readonly commentCount: number;
  readonly url: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly closedAtMs: number | null;
}

export interface ForgePull {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: ForgePullState;
  readonly draft: boolean;
  readonly author: string | null;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly mergeable: ForgeMergeable;
  readonly url: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly mergedAtMs: number | null;
}

export interface ForgeFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: ForgeFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** 这个文件的统一差异；二进制或远端没给时 `null`。 */
  readonly patch: string | null;
}

export interface ForgeCheck {
  readonly name: string;
  readonly state: ForgeCheckState;
  readonly url: string | null;
}

export interface ForgeChecks {
  readonly headSha: string;
  readonly rollup: ForgeRollup;
  readonly checks: readonly ForgeCheck[];
}

export interface ForgeMerged {
  readonly merged: true;
  readonly sha: string | null;
}

export interface ForgePage<T> {
  readonly items: readonly T[];
  /** 下一页的页码串；没有下一页时 `null`。游标是页码，从不是远端 URL。 */
  readonly nextCursor: string | null;
}

export interface ListOptions {
  readonly state: "open" | "closed" | "all";
  readonly page: number;
  readonly limit: number;
}

export interface CreatePullInput {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly draft: boolean;
}

export interface MergeInput {
  readonly method: ForgeMergeMethod;
  /** 评审者看到的那个 head；远端的 head 动过就拒绝，而不是合进别的东西。 */
  readonly headSha: string;
}

/**
 * 一个平台的实现。每个方法都对着**这台机器配置的** API 根，仓库只给 owner 与
 * 名字，从不让请求重新指向别的服务。
 */
export interface Forge {
  readonly kind: ForgeKind;
  listIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>>;
  getIssue(repo: ForgeRepo, number: number): Promise<ForgeIssue>;
  setIssueState(
    repo: ForgeRepo,
    number: number,
    state: ForgeIssueState,
  ): Promise<ForgeIssue>;
  listPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>>;
  getPull(repo: ForgeRepo, number: number): Promise<ForgePull>;
  createPull(repo: ForgeRepo, input: CreatePullInput): Promise<ForgePull>;
  pullFiles(repo: ForgeRepo, number: number): Promise<readonly ForgeFile[]>;
  checks(repo: ForgeRepo, number: number): Promise<ForgeChecks>;
  merge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeMerged>;
}

/**
 * 域层的拒绝种类。线上的 `{code, message}` 在 `routes.ts` 按它翻译。
 *
 *   * `notConfigured`：这个仓库没有识别出的平台，或识别出了但没有令牌。
 *   * `credentialRejected`：远端说令牌不对（401）。
 *   * `remoteForbidden`：远端说这个令牌没有这项权限（403）。
 *   * `unknownOutcome`：写已发出、结果没读到——调用方重新读，永远不要重试。
 */
export type ForgeErrorKind =
  | "invalid"
  | "notFound"
  | "notConfigured"
  | "credentialRejected"
  | "remoteForbidden"
  | "conflict"
  | "rateLimited"
  | "unavailable"
  | "unknownOutcome";

export class ForgeError extends Error {
  constructor(
    readonly kind: ForgeErrorKind,
    /** 稳定的机器原因（`HEAD_CHANGED`、`NOT_MERGEABLE`…），不带远端原话。 */
    readonly reason = "",
  ) {
    super(reason === "" ? kind : `${kind} (${reason})`);
    this.name = "ForgeError";
  }
}

export function forgeError(kind: ForgeErrorKind, reason = ""): ForgeError {
  return new ForgeError(kind, reason);
}

export const MAX_NUMBER = 2_147_483_647;
export const MAX_PAGE = 1000;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;
export const MAX_FILES = 300;
export const MAX_TITLE = 256;
export const MAX_BODY = 65_536;

/** 只接受完整的对象名：短 SHA 会让一次合并指向评审者看到的那个 head 之外的东西。 */
export function validSha(value: string): boolean {
  return (
    (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
  );
}

/** 分支名：不越级、不以斜杠开头、没有控制字符。 */
export function validRefName(name: string): boolean {
  return (
    name !== "" &&
    name.length <= 255 &&
    !name.includes("..") &&
    !name.startsWith("/") &&
    !/[\s\\~^:?*[\]\x00-\x1f\x7f]/.test(name)
  );
}

export function rollupOf(checks: readonly ForgeCheck[]): ForgeRollup {
  if (checks.length === 0) return "none";
  if (checks.some((check) => check.state === "failure")) return "failure";
  if (checks.some((check) => check.state === "pending")) return "pending";
  if (checks.every((check) => check.state === "neutral")) return "neutral";
  return "success";
}

/** ISO 时间串 → 毫秒；空、坏或零值答 `null`。 */
export function timeMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}
