/**
 * 出站政策（外部服务 §9.3、§12.3）落在用量刷新上的样子：开关关着时一个请求都
 * 不发（假端点计数为 0），开着时请求的地址与头；Codex 端点答 HTML 判
 * `unsupported`。全程用临时目录当 HOME 与数据目录、文件密钥后端，`fetch` 是
 * 注入的假货，不碰任何真网络与真钥匙串。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OUTBOUND } from "../net/outbound";
import { SettingsStore } from "../settings/store";
import { UsageService } from "./service";
import type { Fetcher } from "./providers";

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ARMADRA_SECRET_BACKEND",
  "ARMADRA_GITHUB_API_BASE",
  "ARMADRA_CODEX_BIN",
] as const;

let root: string;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let calls: Call[];
let reply: (url: string) => Response;

const fakeFetch: Fetcher = async (input, init) => {
  const url = String(input);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    (init?.headers ?? {}) as Record<string, string>,
  )) {
    headers[key.toLowerCase()] = value;
  }
  calls.push({ url, headers });
  return reply(url);
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "armadra-usage-policy-"));
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "home", ".claude");
  process.env.CODEX_HOME = join(root, "home", ".codex");
  process.env.ARMADRA_SECRET_BACKEND = "file";
  delete process.env.ARMADRA_GITHUB_API_BASE;
  // Codex 的 CLI 兜底缺省关；万一被打开也只会拉起一个不存在的程序。
  process.env.ARMADRA_CODEX_BIN = join(root, "no-such-codex");
  mkdirSync(join(root, "home"), { recursive: true });
  calls = [];
  reply = () => json({});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function service(settings: Record<string, unknown>): UsageService {
  return new UsageService({
    settings: SettingsStore.inMemory(settings as never),
    dataDir: join(root, "data"),
    fetch: fakeFetch,
  });
}

function writeClaudeLogin(): void {
  const directory = process.env.CLAUDE_CONFIG_DIR!;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "claude-token" } }),
  );
}

function writeCodexLogin(): void {
  const directory = process.env.CODEX_HOME!;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "codex-token", account_id: "acct-1" },
    }),
  );
}

function writeCopilotLogin(): void {
  const directory = join(root, "data", "secrets");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "armadra-copilot.token"), "gho_copilot", {
    mode: 0o600,
  });
}

describe("出站政策：Claude 与 Copilot 的额度端点默认关", () => {
  it("缺省设置下一个请求都不发，在用的那两家报 policy_off", async () => {
    writeClaudeLogin();
    writeCopilotLogin();
    const usage = service({ usage: { providers: { codex: false } } });
    const snapshot = await usage.refresh();
    expect(calls).toHaveLength(0);
    const byId = Object.fromEntries(
      snapshot.providers.map((provider) => [provider.id, provider]),
    );
    expect(byId.claude).toMatchObject({
      status: "unavailable",
      reason: "policy_off",
      credentialSource: "none",
      windows: [],
    });
    expect(byId.copilot).toMatchObject({
      status: "unavailable",
      reason: "policy_off",
    });
  });

  it("本机没在用的那家只报 unavailable，不报 policy_off", async () => {
    const usage = service({ usage: { providers: { codex: false } } });
    const snapshot = await usage.refresh();
    expect(calls).toHaveLength(0);
    for (const provider of snapshot.providers) {
      expect(provider.status).toBe("unavailable");
      expect(provider.reason).toBeUndefined();
    }
  });

  it("逐个 provider 的开关关着时连 policy_off 也不报", async () => {
    writeClaudeLogin();
    const usage = service({
      usage: { claudeUsage: true, providers: { claude: false, codex: false } },
    });
    const snapshot = await usage.refresh();
    expect(calls).toHaveLength(0);
    expect(snapshot.providers[0]!.reason).toBeUndefined();
  });

  it("没有设置存储时按缺省（关）算", async () => {
    writeCopilotLogin();
    const usage = new UsageService({
      settings: undefined,
      dataDir: join(root, "data"),
      fetch: fakeFetch,
    });
    expect(usage.policyAllows("claude")).toBe(false);
    expect(usage.policyAllows("copilot")).toBe(false);
    expect(usage.policyAllows("codex")).toBe(true);
  });

  it("打开 copilotUsage 后照原样请求 copilot_internal/user", async () => {
    writeCopilotLogin();
    reply = () =>
      json({
        quota_snapshots: { premium_interactions: { percent_remaining: 40 } },
      });
    const usage = service({
      usage: { copilotUsage: true, providers: { claude: false, codex: false } },
    });
    const snapshot = await usage.refresh();
    expect(calls).toEqual([
      {
        url: OUTBOUND.copilotUsage.url,
        headers: {
          authorization: "token gho_copilot",
          accept: "application/json",
        },
      },
    ]);
    expect(snapshot.providers[2]).toMatchObject({
      id: "copilot",
      status: "ok",
    });
  });

  // macOS 上 Claude 的凭据先查登录钥匙串；测试不去碰开发者的真钥匙串。
  it.skipIf(process.platform === "darwin")(
    "打开 claudeUsage 后照原样请求 oauth/usage",
    async () => {
      writeClaudeLogin();
      reply = () => json({ five_hour: { utilization: 12, resets_at: null } });
      const usage = service({
        usage: {
          claudeUsage: true,
          providers: { codex: false, copilot: false },
        },
      });
      const snapshot = await usage.refresh();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(OUTBOUND.claudeUsage.url);
      expect(calls[0]!.headers).toMatchObject({
        authorization: "Bearer claude-token",
        "anthropic-beta": "oauth-2025-04-20",
      });
      expect(snapshot.providers[0]).toMatchObject({ status: "ok" });
    },
  );
});

describe("Codex：非官方端点，默认开", () => {
  it("缺省设置下照常请求", async () => {
    writeCodexLogin();
    reply = () =>
      json({ rate_limit: { primary_window: { used_percent: 30 } } });
    const usage = service({});
    const snapshot = await usage.refresh();
    expect(calls.map((call) => call.url)).toEqual([OUTBOUND.codexUsage.url]);
    expect(calls[0]!.headers).toMatchObject({
      authorization: "Bearer codex-token",
      "chatgpt-account-id": "acct-1",
    });
    expect(snapshot.providers[1]).toMatchObject({ id: "codex", status: "ok" });
  });

  it.each([
    [
      "标了 text/html",
      () =>
        new Response("<html>challenge</html>", {
          status: 403,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ],
    [
      "没标类型的 HTML",
      () => new Response("  <!doctype html><p>moved</p>", { status: 200 }),
    ],
  ])("答 HTML（%s）判 unsupported，不算错误", async (_label, answer) => {
    writeCodexLogin();
    reply = answer;
    const usage = service({});
    const snapshot = await usage.refresh();
    expect(snapshot.providers[1]).toMatchObject({
      id: "codex",
      status: "unavailable",
      reason: "unsupported",
    });
  });

  it("坏 JSON 仍是 parse 错误", async () => {
    writeCodexLogin();
    reply = () =>
      new Response("{nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const snapshot = await service({}).refresh();
    expect(snapshot.providers[1]).toMatchObject({
      status: "error",
      reason: "parse",
    });
  });
});
