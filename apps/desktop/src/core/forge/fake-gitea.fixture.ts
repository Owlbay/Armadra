/**
 * 进程内的假 Gitea：只答 `core/forge/gitea.ts` 用到的那几条 `/api/v1`，按真 Gitea
 * 1.2x 的字段拼法。记下每条请求（方法、路径、认证头），测试据此断言「令牌只发到
 * 配置的根」「写不重试」。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  pull?: boolean;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean;
  head: string;
  base: string;
  sha: string;
  mergeSha?: string;
  files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    previous?: string;
  }[];
  diff: string;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
  readonly body: unknown;
}

export interface FakeGitea {
  readonly root: string;
  readonly apiBase: string;
  readonly requests: FakeRequest[];
  readonly issues: FakeIssue[];
  readonly pulls: FakePull[];
  readonly statuses: Map<
    string,
    { context: string; status: string; target_url: string }[]
  >;
  /** 下一条匹配的请求答这个状态（一次性）。 */
  failNext(method: string, path: RegExp, status: number): void;
  close(): Promise<void>;
}

const OWNER = "acme";
const REPO = "app";
const TOKEN = "gitea-test-token";

export const FAKE_GITEA = {
  owner: OWNER,
  repo: REPO,
  token: TOKEN,
  login: "armadra-bot",
};

function iso(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 1) + seconds * 1000).toISOString();
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeGitea(): Promise<FakeGitea> {
  const requests: FakeRequest[] = [];
  const issues: FakeIssue[] = [];
  const pulls: FakePull[] = [];
  const statuses = new Map<
    string,
    { context: string; status: string; target_url: string }[]
  >();
  const failures: { method: string; path: RegExp; status: number }[] = [];
  let root = "";

  const issueJson = (issue: FakeIssue) => ({
    id: issue.number * 10,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: "alice", id: 1 },
    labels: issue.labels.map((name, index) => ({
      id: index + 1,
      name,
      color: "ff0000",
    })),
    comments: 2,
    html_url: `${root}/${OWNER}/${REPO}/issues/${issue.number}`,
    created_at: iso(issue.number),
    updated_at: iso(issue.number + 100),
    closed_at: issue.state === "closed" ? iso(issue.number + 200) : null,
    pull_request: issue.pull === true ? { merged: false } : null,
  });
  const pullJson = (pull: FakePull) => ({
    id: pull.number * 10,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: false,
    user: { login: "bob", id: 2 },
    base: { ref: pull.base, sha: "0".repeat(40), label: pull.base },
    head: { ref: pull.head, sha: pull.sha, label: pull.head },
    mergeable: pull.mergeable,
    merged: pull.merged,
    merged_at: pull.merged ? iso(500) : null,
    merge_commit_sha: pull.merged ? (pull.mergeSha ?? null) : null,
    html_url: `${root}/${OWNER}/${REPO}/pulls/${pull.number}`,
    created_at: iso(pull.number),
    updated_at: iso(pull.number + 100),
  });

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const method = request.method ?? "GET";
    const body = await readBody(request);
    const authorization = String(request.headers.authorization ?? "");
    requests.push({
      method,
      path: url.pathname + url.search,
      authorization,
      body,
    });
    const send = (
      status: number,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const text =
        payload === undefined
          ? ""
          : typeof payload === "string"
            ? payload
            : JSON.stringify(payload);
      response.writeHead(status, {
        "content-type":
          typeof payload === "string" ? "text/plain" : "application/json",
        ...headers,
      });
      response.end(text);
    };
    const failure = failures.findIndex(
      (entry) => entry.method === method && entry.path.test(url.pathname),
    );
    if (failure >= 0) {
      const [entry] = failures.splice(failure, 1);
      send(entry!.status, { message: "remote said <script>no</script>" });
      return;
    }
    if (authorization !== `token ${TOKEN}`) {
      send(401, { message: "token is required" });
      return;
    }
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path === "/user" && method === "GET") {
      send(200, { id: 9, login: FAKE_GITEA.login });
      return;
    }
    const prefix = `/repos/${OWNER}/${REPO}`;
    if (!path.startsWith(prefix)) {
      send(404, { message: "not found" });
      return;
    }
    const rest = path.slice(prefix.length);
    const state = url.searchParams.get("state") ?? "open";
    const page = Number(url.searchParams.get("page") ?? "1");
    const limit = Number(url.searchParams.get("limit") ?? "30");
    const paged = <T>(items: T[]) => {
      const slice = items.slice((page - 1) * limit, page * limit);
      const headers: Record<string, string> = {
        "x-total-count": String(items.length),
      };
      if (page * limit < items.length) {
        headers.link = `<${root}/api/v1${path}?page=${page + 1}&limit=${limit}>; rel="next"`;
      }
      return { slice, headers };
    };
    let match: RegExpMatchArray | null;
    if (rest === "/issues" && method === "GET") {
      const wanted = issues.filter(
        (issue) =>
          (state === "all" || issue.state === state) &&
          (url.searchParams.get("type") !== "issues" || issue.pull !== true),
      );
      const { slice, headers } = paged(wanted);
      send(200, slice.map(issueJson), headers);
      return;
    }
    if ((match = rest.match(/^\/issues\/(\d+)$/))) {
      const issue = issues.find((item) => item.number === Number(match![1]));
      if (issue === undefined) return send(404, { message: "not found" });
      if (method === "PATCH") {
        const next = (body as { state?: string }).state;
        if (next === "open" || next === "closed") issue.state = next;
        return send(201, issueJson(issue));
      }
      return send(200, issueJson(issue));
    }
    if (rest === "/pulls" && method === "GET") {
      const wanted = pulls.filter(
        (pull) => state === "all" || pull.state === state,
      );
      const { slice, headers } = paged(wanted);
      return send(200, slice.map(pullJson), headers);
    }
    if (rest === "/pulls" && method === "POST") {
      const input = body as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      if (input.head === "missing")
        return send(404, { message: "branch not found" });
      const number =
        Math.max(
          0,
          ...issues.map((i) => i.number),
          ...pulls.map((p) => p.number),
        ) + 1;
      const pull: FakePull = {
        number,
        title: input.title,
        body: input.body,
        state: "open",
        merged: false,
        mergeable: true,
        head: input.head,
        base: input.base,
        sha: "c".repeat(40),
        files: [],
        diff: "",
      };
      pulls.push(pull);
      return send(201, pullJson(pull));
    }
    if ((match = rest.match(/^\/pulls\/(\d+)(\.diff|\/files|\/merge)?$/))) {
      const pull = pulls.find((item) => item.number === Number(match![1]));
      if (pull === undefined) return send(404, { message: "not found" });
      const suffix = match[2] ?? "";
      if (suffix === "" && method === "GET") return send(200, pullJson(pull));
      if (suffix === ".diff") return send(200, pull.diff);
      if (suffix === "/files") {
        return send(
          200,
          pull.files.map((file) => ({
            filename: file.filename,
            previous_filename: file.previous ?? "",
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.additions + file.deletions,
          })),
        );
      }
      if (suffix === "/merge" && method === "POST") {
        const input = body as { Do?: string; head_commit_id?: string };
        if (!pull.mergeable) return send(405, { message: "not mergeable" });
        if (input.head_commit_id !== pull.sha)
          return send(409, { message: "head out of date" });
        pull.merged = true;
        pull.state = "closed";
        pull.mergeSha = "d".repeat(40);
        return send(200);
      }
    }
    if ((match = rest.match(/^\/commits\/([0-9a-f]{40})\/status$/))) {
      const list = statuses.get(match[1]!) ?? [];
      return send(200, {
        state: "pending",
        sha: match[1],
        statuses: list,
        total_count: list.length,
      });
    }
    send(404, { message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  root = `http://127.0.0.1:${port}`;
  return {
    root,
    apiBase: `${root}/api/v1`,
    requests,
    issues,
    pulls,
    statuses,
    failNext: (method, path, status) => failures.push({ method, path, status }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
