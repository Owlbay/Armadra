/**
 * GitHub 装进 {@link Forge}：同一个 `GithubClient`（条件请求、限流、写不重试）、
 * 同一份凭据与 API 根（`/api/github/*` 配的那一份），只把记录换成 forge 形状。
 *
 * `/api/github/*` 本身一行不改：这里是它旁边的第二个调用方，不是替身。
 */

import type { GithubClient } from "../github/client";
import * as api from "../github/endpoints";
import { codeOf, GithubError } from "../github/errors";
import { isPullRecord, toIssue, toPull } from "../github/decode";
import type { WireIssue, WirePull } from "../github/decode";
import type { GithubService } from "../github/service";
import {
  GithubCheckConclusion,
  GithubIssueState,
  GithubMergeableState,
  GithubPullState,
  type GithubCheckSummary,
  type GithubIssue,
  type GithubPullFile,
  type GithubPullRequest,
  type GithubRepositoryRef,
} from "../github/types";
import {
  type CreatePullInput,
  DEFAULT_LIMIT,
  type Forge,
  type ForgeCheckState,
  type ForgeChecks,
  type ForgeError,
  type ForgeFile,
  type ForgeFileStatus,
  type ForgeIssue,
  type ForgeIssueState,
  type ForgeMerged,
  type ForgePage,
  type ForgePull,
  type ForgeRepo,
  type ListOptions,
  MAX_FILES,
  MAX_LIMIT,
  MAX_NUMBER,
  type MergeInput,
  forgeError,
  rollupOf,
  validRefName,
  validSha,
} from "./types";

function ms(value: bigint): number {
  return Number(value);
}

function msOrNull(value: bigint): number | null {
  return value > 0n ? Number(value) : null;
}

export function fromGithubIssue(issue: GithubIssue): ForgeIssue {
  return {
    number: Number(issue.number),
    title: issue.title,
    body: issue.body,
    state: issue.state === GithubIssueState.CLOSED ? "closed" : "open",
    author: issue.author?.login || null,
    labels: issue.labels.map((label) => label.name),
    commentCount: Number(issue.commentCount),
    url: issue.htmlUrl,
    createdAtMs: ms(issue.createdAtUnixMs),
    updatedAtMs: ms(issue.updatedAtUnixMs),
    closedAtMs: msOrNull(issue.closedAtUnixMs),
  };
}

export function fromGithubPull(pull: GithubPullRequest): ForgePull {
  const state =
    pull.state === GithubPullState.MERGED
      ? "merged"
      : pull.state === GithubPullState.CLOSED
        ? "closed"
        : "open";
  return {
    number: Number(pull.number),
    title: pull.title,
    body: pull.body,
    state,
    draft: pull.draft,
    author: pull.author?.login || null,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    headSha: pull.headSha,
    mergeable:
      pull.mergeable === GithubMergeableState.MERGEABLE
        ? "mergeable"
        : pull.mergeable === GithubMergeableState.CONFLICTING
          ? "conflicting"
          : "unknown",
    url: pull.htmlUrl,
    createdAtMs: ms(pull.createdAtUnixMs),
    updatedAtMs: ms(pull.updatedAtUnixMs),
    mergedAtMs: msOrNull(pull.mergedAtUnixMs),
  };
}

function fileStatus(value: string): ForgeFileStatus {
  switch (value) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    case "modified":
    case "changed":
      return "modified";
    default:
      return "other";
  }
}

export function fromGithubFile(file: GithubPullFile): ForgeFile {
  return {
    path: file.path,
    previousPath: file.previousPath === "" ? null : file.previousPath,
    status: fileStatus(file.status),
    additions: Number(file.additions),
    deletions: Number(file.deletions),
    patch: file.binary || file.patch === "" ? null : file.patch,
  };
}

function checkState(value: GithubCheckConclusion): ForgeCheckState {
  switch (value) {
    case GithubCheckConclusion.SUCCESS:
      return "success";
    case GithubCheckConclusion.NEUTRAL:
    case GithubCheckConclusion.SKIPPED:
      return "neutral";
    case GithubCheckConclusion.FAILURE:
    case GithubCheckConclusion.CANCELLED:
    case GithubCheckConclusion.TIMED_OUT:
    case GithubCheckConclusion.ACTION_REQUIRED:
    case GithubCheckConclusion.STALE:
      return "failure";
    default:
      return "pending";
  }
}

export function fromGithubChecks(summary: GithubCheckSummary): ForgeChecks {
  const checks = summary.runs.map((run) => ({
    name: run.name,
    state: checkState(run.conclusion),
    url: run.detailsUrl === "" ? null : run.detailsUrl,
  }));
  return { headSha: summary.headSha, rollup: rollupOf(checks), checks };
}

/** GitHub 传输层 / 域层的拒绝 → forge 的种类。 */
export function fromGithubError(error: unknown): ForgeError | unknown {
  if (error instanceof GithubError) {
    switch (error.kind) {
      case "unsupported":
        return forgeError("notConfigured", "NO_CREDENTIAL");
      case "invalid":
        return forgeError("invalid");
      case "permission":
        return forgeError("remoteForbidden");
      case "notFound":
        return forgeError("notFound");
      case "conflict":
        return forgeError("conflict");
      case "rateLimited":
        return forgeError("rateLimited");
      case "unknownOutcome":
        return forgeError("unknownOutcome");
      default:
        return forgeError("unavailable");
    }
  }
  switch (codeOf(error)) {
    case "UNAUTHENTICATED":
      return forgeError("credentialRejected", "TOKEN_REJECTED");
    case "PERMISSION_DENIED":
      return forgeError("remoteForbidden", "FORBIDDEN");
    case "NOT_FOUND":
      return forgeError("notFound", "NOT_FOUND");
    case "CONFLICT":
      return forgeError("conflict", "CONFLICT");
    case "RESOURCE_EXHAUSTED":
      return forgeError("rateLimited", "RATE_LIMITED");
    case "UNKNOWN_OUTCOME":
      return forgeError("unknownOutcome", "UNKNOWN_OUTCOME");
    case "UNAVAILABLE":
      return forgeError("unavailable", "REMOTE_UNAVAILABLE");
    case "INVALID_ARGUMENT":
    case "UNSUPPORTED":
      return forgeError("invalid", "INVALID");
    default:
      return error;
  }
}

function numbered(number: number): bigint {
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_NUMBER) {
    throw forgeError("invalid", "NUMBER_INVALID");
  }
  return BigInt(number);
}

function decodeArray<T>(body: Buffer): T[] {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  }
  if (!Array.isArray(value))
    throw forgeError("unavailable", "RESPONSE_MALFORMED");
  return value as T[];
}

function perPage(limit: number): string {
  return String(limit > 0 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT);
}

export class GithubForge implements Forge {
  readonly kind = "github" as const;

  constructor(private readonly service: GithubService) {}

  /** 配好的 client 与核过的仓库引用；API 根永远来自这台机器的 GitHub 配置。 */
  private target(repo: ForgeRepo): {
    client: GithubClient;
    ref: GithubRepositoryRef;
  } {
    const client = this.service.client();
    const ref = this.service.repository({
      owner: repo.owner,
      name: repo.name,
      apiBase: "",
      host: "",
    });
    return { client, ref };
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      this.service.credentials.noteSuccess();
      return result;
    } catch (error) {
      // 让设置页照旧能说「这个令牌不再工作了」。
      if (!(error instanceof GithubError)) {
        this.service.credentials.noteFailure(error);
      }
      throw fromGithubError(error);
    }
  }

  listIssues(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgeIssue>> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const query: Record<string, string> = {
        state: options.state,
        per_page: perPage(options.limit),
        sort: "updated",
        direction: "desc",
      };
      if (options.page > 1) query.page = String(options.page);
      const response = await client.get(
        `/repos/${ref.owner}/${ref.name}/issues`,
        query,
      );
      const values = decodeArray<WireIssue>(response.body);
      const atMs = this.service.now();
      return {
        items: values
          .filter((value) => !isPullRecord(value))
          .map((value) => fromGithubIssue(toIssue(value, ref, atMs))),
        nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
      };
    });
  }

  getIssue(repo: ForgeRepo, number: number): Promise<ForgeIssue> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const result = await api.issue(
        client,
        ref,
        numbered(number),
        this.service.now(),
      );
      return fromGithubIssue(result.issue);
    });
  }

  setIssueState(
    repo: ForgeRepo,
    number: number,
    state: ForgeIssueState,
  ): Promise<ForgeIssue> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const index = numbered(number);
      // 先读：PR 的编号经 issues 端点也改得动，那不是这个动词的意思。
      await api.issue(client, ref, index, this.service.now());
      const issue = await api.patchIssue(
        client,
        ref,
        index,
        { state },
        this.service.now(),
      );
      return fromGithubIssue(issue);
    });
  }

  listPulls(
    repo: ForgeRepo,
    options: ListOptions,
  ): Promise<ForgePage<ForgePull>> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const query: Record<string, string> = {
        state: options.state,
        per_page: perPage(options.limit),
        sort: "updated",
        direction: "desc",
      };
      if (options.page > 1) query.page = String(options.page);
      const response = await client.get(
        `/repos/${ref.owner}/${ref.name}/pulls`,
        query,
      );
      const values = decodeArray<WirePull>(response.body);
      const atMs = this.service.now();
      return {
        items: values.map((value) =>
          fromGithubPull(toPull(value, ref, [], atMs)),
        ),
        nextCursor: response.nextPage > 1 ? String(response.nextPage) : null,
      };
    });
  }

  getPull(repo: ForgeRepo, number: number): Promise<ForgePull> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const result = await api.pull(
        client,
        ref,
        numbered(number),
        [],
        this.service.now(),
      );
      return fromGithubPull(result.pull);
    });
  }

  createPull(repo: ForgeRepo, input: CreatePullInput): Promise<ForgePull> {
    return this.run(async () => {
      if (!validRefName(input.head) || !validRefName(input.base)) {
        throw forgeError("invalid", "REF_INVALID");
      }
      const { client, ref } = this.target(repo);
      const pull = await api.createPull(
        client,
        ref,
        {
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
          draft: input.draft,
        },
        [],
        this.service.now(),
      );
      return fromGithubPull(pull);
    });
  }

  pullFiles(repo: ForgeRepo, number: number): Promise<readonly ForgeFile[]> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const files = await api.pullFiles(
        client,
        ref,
        numbered(number),
        MAX_FILES,
      );
      return files.map(fromGithubFile);
    });
  }

  checks(repo: ForgeRepo, number: number): Promise<ForgeChecks> {
    return this.run(async () => {
      const { client, ref } = this.target(repo);
      const now = this.service.now();
      const { pull } = await api.pull(client, ref, numbered(number), [], now);
      if (!validSha(pull.headSha)) {
        return { headSha: "", rollup: "none" as const, checks: [] };
      }
      return fromGithubChecks(await api.checks(client, ref, pull.headSha, now));
    });
  }

  merge(
    repo: ForgeRepo,
    number: number,
    input: MergeInput,
  ): Promise<ForgeMerged> {
    return this.run(async () => {
      if (!validSha(input.headSha)) throw forgeError("invalid", "SHA_INVALID");
      const { client, ref } = this.target(repo);
      // GitHub 自己核 `sha`：head 动过就 409，不会合进评审者没看到的东西。
      const sha = await api.merge(
        client,
        ref,
        numbered(number),
        input.headSha,
        input.method,
        "",
        "",
      );
      return { merged: true as const, sha };
    });
  }
}
