import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CoreRequest } from "../../http/router";
import { runAs } from "../../identity/gate";
import type { CoreContext } from "../../main";
import type { SecretBackend, SecretBackendKind } from "../../secrets/backend";
import { posixLauncher } from "../../hook/install/launcher";
import { type HookFixture, hookFixture } from "../../hook/fixture";
import { type Fixture, fixture } from "../../workspaces/fixture";
import { install as installWorkspaces } from "../../workspaces/routes";
import { install as installCanvas } from "../../canvas/routes";
import { install as installTerminals } from "../../terminal/install";
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_REF_ENV,
  CredentialError,
  CredentialsDomain,
  kindRow,
  setCredentialsDomain,
  variablesFor,
} from "./index";
import { installRoutes } from "./routes";

/**
 * 节点凭据（契约 §20）：映射表封闭、条目只回 `isSet`、启动前的校验与拒绝码、
 * 兑换只认绑定、值不进响应（兑换除外）与日志、启动器只把值给 CLI 进程。
 */

const VALUE = "sk-ant-oat01-FAKE-VALUE-FOR-TESTS-ONLY";

/** 内存里的后端，自报一个不是 `file` 的种类。 */
function memoryBackend(kind: SecretBackendKind = "keychain"): SecretBackend & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    kind,
    values,
    get: (name) => Promise.resolve(values.get(name)),
    set: (name, value) => {
      values.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      values.delete(name);
      return Promise.resolve();
    },
  };
}

const opened: { close(): void }[] = [];
const temporary: string[] = [];
afterEach(() => {
  setCredentialsDomain(undefined);
  for (const one of opened.splice(0)) one.close();
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withRoutes(
  backend: SecretBackend,
  platform: NodeJS.Platform = "darwin",
): { core: Fixture; domain: CredentialsDomain; logged: unknown[] } {
  let domain: CredentialsDomain | undefined;
  const logged: unknown[] = [];
  const core = fixture([
    (context: CoreContext) => {
      domain = new CredentialsDomain({
        database: context.db.database,
        secrets: backend,
        baseOf: (id) => (id.startsWith("custom:") ? "claude" : id),
        platform,
        log: (message, fields) => logged.push([message, fields]),
      });
      installRoutes(context.server, domain);
    },
  ]);
  opened.push(core);
  return { core, domain: domain as CredentialsDomain, logged };
}

describe("the kind table", () => {
  it("is closed: the first version enables exactly Claude oauth-token and Copilot github-token", () => {
    expect(Object.isFrozen(CREDENTIAL_KINDS)).toBe(true);
    expect(
      CREDENTIAL_KINDS.filter((row) => row.enabled).map(
        (row) => `${row.providerId}/${row.kind}=${row.variable}`,
      ),
    ).toEqual([
      "claude/oauth-token=CLAUDE_CODE_OAUTH_TOKEN",
      "copilot/github-token=COPILOT_GITHUB_TOKEN",
    ]);
    // 其余几行在表里但关着：codex / pi / omp / opencode 都待 §7.4。
    const disabled = new Set(
      CREDENTIAL_KINDS.filter((row) => !row.enabled).map(
        (row) => row.providerId,
      ),
    );
    expect([...disabled].sort()).toEqual([
      "claude",
      "codex",
      "omp",
      "opencode",
      "pi",
    ]);
  });

  it("names only plain variables, never one that changes how a program runs", () => {
    const pairs = new Set<string>();
    for (const row of CREDENTIAL_KINDS) {
      expect(row.variable).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(row.variable).not.toMatch(
        /^(PATH|HOME|SHELL|NODE_OPTIONS|LD_|DYLD_|ARMADRA_)/,
      );
      const key = `${row.providerId}/${row.kind}`;
      expect(pairs.has(key), key).toBe(false);
      pairs.add(key);
    }
    expect(kindRow("claude", "PATH")).toBeUndefined();
    expect(variablesFor("claude")).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    expect(variablesFor("nobody")).toEqual([]);
  });
});

describe("/api/credentials", () => {
  it("stores the value in the secret store and only ever answers isSet", async () => {
    const backend = memoryBackend();
    const { core } = withRoutes(backend);
    const created = await core.call("POST", "/api/credentials", {
      providerId: "claude",
      kind: "oauth-token",
      label: "Work",
      value: ` ${VALUE}\n`,
    });
    expect(created.status).toBe(201);
    const entry = created.body as { ref: string };
    expect(created.body).toEqual({
      ref: entry.ref,
      providerId: "claude",
      kind: "oauth-token",
      label: "Work",
      isSet: true,
    });
    expect(backend.values.get(`armadra-credential-${entry.ref}`)).toBe(VALUE);

    const listed = await core.call("GET", "/api/credentials");
    expect(listed.status).toBe(200);
    const list = listed.body as Record<string, unknown>;
    expect(list.available).toBe(true);
    expect(list.backend).toBe("keychain");
    expect(list.entries).toEqual([created.body]);
    expect(list.kinds).toContainEqual({
      providerId: "copilot",
      kind: "github-token",
      enabled: true,
    });
    expect(JSON.stringify(list)).not.toContain(VALUE);
    // 变量名不上线：页面只需要「哪家、哪种、开没开」。
    expect(JSON.stringify(list)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");

    // 库里只有名字与种类。
    const rows = core.database
      .prepare("SELECT * FROM agent_credentials")
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(VALUE);

    const renamed = await core.call("PATCH", `/api/credentials/${entry.ref}`, {
      label: "Personal",
      value: "another-value",
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body as { label: string }).label).toBe("Personal");
    expect(JSON.stringify(renamed.body)).not.toContain("another-value");
    expect(backend.values.get(`armadra-credential-${entry.ref}`)).toBe(
      "another-value",
    );

    const removed = await core.call("DELETE", `/api/credentials/${entry.ref}`);
    expect(removed.status).toBe(204);
    expect(backend.values.size).toBe(0);
    const again = await core.call("DELETE", `/api/credentials/${entry.ref}`);
    expect(again.body).toMatchObject({ code: "credential_not_found" });
    expect(again.status).toBe(404);
  });

  it("refuses a kind outside the table, a disabled kind and a malformed body", async () => {
    const { core } = withRoutes(memoryBackend());
    const outside = await core.call("POST", "/api/credentials", {
      providerId: "claude",
      kind: "PATH",
      label: "x",
      value: "v",
    });
    expect(outside.status).toBe(400);
    expect(outside.body).toMatchObject({ code: "bad_request" });
    const disabled = await core.call("POST", "/api/credentials", {
      providerId: "codex",
      kind: "api-key",
      label: "x",
      value: "v",
    });
    expect(disabled.body).toMatchObject({ code: "credential_kind_disabled" });
    const multiline = await core.call("POST", "/api/credentials", {
      providerId: "claude",
      kind: "oauth-token",
      label: "x",
      value: "a\nb",
    });
    expect(multiline.status).toBe(400);
    const empty = await core.call(
      "PATCH",
      "/api/credentials/abcdef0123456789",
      {},
    );
    expect(empty.status).toBe(400);
    const unknown = await core.call(
      "PATCH",
      "/api/credentials/abcdef0123456789",
      { label: "y" },
    );
    expect(unknown.status).toBe(404);
  });

  it("refuses to store anything when the secret backend reports file", async () => {
    const { core } = withRoutes(memoryBackend("file"));
    const listed = await core.call("GET", "/api/credentials");
    expect(listed.body).toMatchObject({
      backend: "file",
      available: false,
      reason: "credential_backend_insecure",
    });
    const created = await core.call("POST", "/api/credentials", {
      providerId: "claude",
      kind: "oauth-token",
      label: "x",
      value: VALUE,
    });
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({ code: "credential_backend_insecure" });
  });

  it("is not available on Windows until the launcher there can redeem", async () => {
    const { core } = withRoutes(memoryBackend("dpapi"), "win32");
    const listed = await core.call("GET", "/api/credentials");
    expect(listed.body).toMatchObject({
      available: false,
      reason: "credential_unsupported_here",
    });
  });
});

describe("the launch check and the redemption", () => {
  async function seeded() {
    const backend = memoryBackend();
    const made = withRoutes(backend);
    const claude = await made.domain.store.create({
      providerId: "claude",
      kind: "oauth-token",
      label: "Work",
      value: VALUE,
    });
    const copilot = await made.domain.store.create({
      providerId: "copilot",
      kind: "github-token",
      label: "Bot",
      value: "github_pat_FAKE",
    });
    return { ...made, backend, claude, copilot };
  }

  function refusal(action: () => unknown): string | undefined {
    try {
      action();
    } catch (failure) {
      if (failure instanceof CredentialError) return failure.code;
      throw failure;
    }
    return undefined;
  }

  it("puts only the entry name in the terminal's environment", async () => {
    const { domain, claude } = await seeded();
    const env = domain.environment(
      "node-1",
      "claude",
      false,
      claude.ref,
      undefined,
    );
    expect(env).toEqual([[CREDENTIAL_REF_ENV, claude.ref]]);
    expect(JSON.stringify(env)).not.toContain(VALUE);
    // `custom:` 条目按它的基础 CLI 判。
    expect(
      domain.environment("node-2", "custom:mine", false, claude.ref, undefined),
    ).toEqual([[CREDENTIAL_REF_ENV, claude.ref]]);
    // 没有绑定：什么也不加。
    expect(
      domain.environment("node-3", "claude", false, undefined, undefined),
    ).toEqual([]);
  });

  it("refuses a mismatched provider, an unknown entry and an SSH node", async () => {
    const { domain, claude, copilot } = await seeded();
    expect(
      refusal(() =>
        domain.environment("n", "claude", false, copilot.ref, undefined),
      ),
    ).toBe("credential_mismatch");
    expect(
      refusal(() =>
        domain.environment("n", "codex", false, claude.ref, undefined),
      ),
    ).toBe("credential_mismatch");
    expect(
      refusal(() =>
        domain.environment("n", "claude", false, "0000000000000000", undefined),
      ),
    ).toBe("credential_mismatch");
    expect(
      refusal(() =>
        domain.environment("n", "claude", true, claude.ref, undefined),
      ),
    ).toBe("credential_unsupported_here");
    // 唤醒等没有请求的路：SSH 节点不带，校验不过也照带名字（兑换时拒绝）。
    expect(
      domain.environment("n", "claude", true, undefined, claude.ref),
    ).toEqual([]);
    expect(
      domain.environment("n", "codex", false, undefined, claude.ref),
    ).toEqual([[CREDENTIAL_REF_ENV, claude.ref]]);
  });

  it("redeems only the entry the node is bound to, and logs no value", async () => {
    const { domain, claude, copilot, logged, core } = await seeded();
    domain.environment("node-1", "claude", false, claude.ref, undefined);
    await expect(domain.redeem("node-1", claude.ref, {})).resolves.toEqual({
      variable: "CLAUDE_CODE_OAUTH_TOKEN",
      value: VALUE,
    });
    await expect(
      domain.redeem("node-1", copilot.ref, {}),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(domain.redeem("node-9", claude.ref, {})).rejects.toMatchObject(
      { code: "forbidden" },
    );
    // core 重启之后：内存里的绑定没了，节点数据里的那一条照认。
    await expect(
      domain.redeem("node-9", claude.ref, {
        ref: claude.ref,
        agentId: "claude",
      }),
    ).resolves.toMatchObject({ variable: "CLAUDE_CODE_OAUTH_TOKEN" });
    // 节点数据里的 Agent 换成了别家：校验重新做，不按旧的放行。
    await expect(
      domain.redeem("node-8", claude.ref, {
        ref: claude.ref,
        agentId: "codex",
      }),
    ).rejects.toMatchObject({ code: "credential_mismatch" });
    expect(JSON.stringify(logged)).not.toContain(VALUE);
    expect(JSON.stringify(logged)).toContain(claude.ref);
    const used = core.database
      .prepare("SELECT last_used_at FROM agent_credentials WHERE ref = ?")
      .get(claude.ref) as { last_used_at: number | null };
    expect(used.last_used_at).not.toBeNull();
  });

  it("answers credential_unset when the value is gone", async () => {
    const { domain, backend, claude } = await seeded();
    backend.values.clear();
    domain.environment("node-1", "claude", false, claude.ref, undefined);
    await expect(domain.redeem("node-1", claude.ref, {})).rejects.toMatchObject(
      {
        code: "credential_unset",
      },
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "POST /api/terminals with a credentialRef",
  () => {
    async function core(backend: SecretBackend) {
      const stops: (() => Promise<void>)[] = [];
      const made = fixture([
        installWorkspaces,
        installCanvas,
        (context: CoreContext) => {
          const domain = installTerminals(context, {
            configured: "direct",
            credentialSecrets: backend,
            platform: "darwin",
          });
          stops.push(() => domain.stop());
        },
      ]);
      opened.push({
        close: () => {
          void Promise.all(stops.map((stop) => stop())).finally(() =>
            made.close(),
          );
        },
      });
      const workspace = (
        await made.call("POST", "/api/workspaces", {
          name: "Canvas",
          rootPath: made.directory,
        })
      ).body as { id: string };
      return { core: made, workspaceId: workspace.id };
    }

    it("refuses before a pane exists, with the §20 codes", async () => {
      const backend = memoryBackend();
      const { core: made, workspaceId } = await core(backend);
      const created = await made.call("POST", "/api/credentials", {
        providerId: "copilot",
        kind: "github-token",
        label: "Bot",
        value: "github_pat_FAKE",
      });
      const ref = (created.body as { ref: string }).ref;
      const request = (agent: Record<string, unknown>, extra = {}) =>
        made.call("POST", "/api/terminals", {
          workspaceId,
          cwd: made.directory,
          nodeId: "00000000-0000-4000-8000-000000000001",
          agent,
          ...extra,
        });
      const mismatch = await request({ id: "claude", credentialRef: ref });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({ code: "credential_mismatch" });
      const ssh = await request(
        { id: "copilot", credentialRef: ref },
        { ssh: { hostId: "nowhere" } },
      );
      expect(ssh.body).toMatchObject({ code: "credential_unsupported_here" });
      const malformed = await request({ id: "copilot", credentialRef: 7 });
      expect(malformed.status).toBe(400);
      const rows = made.database
        .prepare("SELECT COUNT(*) AS n FROM terminal_sessions")
        .get() as { n: number };
      expect(rows.n).toBe(0);
    });

    it("refuses a member without credential:use, before a pane exists (security review H2)", async () => {
      const backend = memoryBackend();
      const { core: made, workspaceId } = await core(backend);
      const created = await made.call("POST", "/api/credentials", {
        providerId: "copilot",
        kind: "github-token",
        label: "Owner's",
        value: "github_pat_FAKE",
      });
      const ref = (created.body as { ref: string }).ref;
      const member = {
        subject: {
          principalId: "p-member",
          kind: "member" as const,
          scopes: [],
        },
      };
      const answer = await runAs(member, () =>
        made.call("POST", "/api/terminals", {
          workspaceId,
          cwd: made.directory,
          nodeId: "00000000-0000-4000-8000-000000000002",
          agent: { id: "copilot", credentialRef: ref },
        }),
      );
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code: "credential_forbidden" });
      const rows = made.database
        .prepare("SELECT COUNT(*) AS n FROM terminal_sessions")
        .get() as { n: number };
      expect(rows.n).toBe(0);
      expect(JSON.stringify(answer.body)).not.toContain("github_pat_FAKE");
    });

    it("refuses on a host whose secret backend is a plain file", async () => {
      const { core: made, workspaceId } = await core(memoryBackend("file"));
      const answer = await made.call("POST", "/api/terminals", {
        workspaceId,
        cwd: made.directory,
        nodeId: "00000000-0000-4000-8000-000000000001",
        agent: { id: "claude", credentialRef: "abcdef0123456789" },
      });
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({
        code: "credential_backend_insecure",
      });
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "the hook surface's /credential",
  () => {
    const hooks: HookFixture[] = [];
    afterEach(async () => {
      for (const one of hooks.splice(0)) {
        await one.server.close();
        one.close();
      }
    });

    function post(
      one: HookFixture,
      body: unknown,
      headers: Record<string, string>,
    ) {
      const encoded = Buffer.from(JSON.stringify(body), "utf8");
      const request = {
        method: "POST",
        path: "/credential",
        query: new URLSearchParams(),
        headers,
        body: encoded,
        raw: undefined as never,
        json: <T>(): T => JSON.parse(encoded.toString("utf8")) as T,
      } satisfies CoreRequest;
      return one.server.router.dispatch(
        "POST",
        "/credential",
        request,
      ) as Promise<{
        status: number;
        body: unknown;
      }>;
    }

    it("answers the value only to the bound node's verified token", async () => {
      const one = hookFixture();
      hooks.push(one);
      const domain = new CredentialsDomain({
        database: one.context.database,
        secrets: memoryBackend(),
        baseOf: (id) => id,
        platform: "darwin",
      });
      setCredentialsDomain(domain);
      const row = await domain.store.create({
        providerId: "claude",
        kind: "oauth-token",
        label: "Work",
        value: VALUE,
      });
      // 节点数据里的绑定（core 重启后的那条路）。
      one.context.database
        .prepare(
          "UPDATE nodes SET data_json = json_set(data_json, '$.agent', json(?)) WHERE id = ?",
        )
        .run(
          JSON.stringify({
            id: "claude",
            account: { accountId: "default", credentialRef: row.ref },
          }),
          one.nodeId,
        );
      const token = one.service.issueNodeToken(one.nodeId);
      const good = {
        "x-armadra-hook-token": one.bearer,
        "x-armadra-node-token": token,
      };
      const answer = await post(
        one,
        { nodeId: one.nodeId, ref: row.ref },
        good,
      );
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        variable: "CLAUDE_CODE_OAUTH_TOKEN",
        value: VALUE,
      });

      const noToken = await post(
        one,
        { nodeId: one.nodeId, ref: row.ref },
        { "x-armadra-hook-token": one.bearer },
      );
      expect(noToken.status).toBe(403);
      const forged = await post(
        one,
        { nodeId: one.nodeId, ref: row.ref },
        { ...good, "x-armadra-node-token": "0".repeat(64) },
      );
      expect(forged.status).toBe(403);
      const noBearer = await post(
        one,
        { nodeId: one.nodeId, ref: row.ref },
        { "x-armadra-node-token": token },
      );
      expect(noBearer.status).toBe(403);
      const other = await post(
        one,
        { nodeId: one.nodeId, ref: "abcdef0123456789" },
        good,
      );
      expect(other.status).toBe(403);
      expect(JSON.stringify([noToken, forged, noBearer, other])).not.toContain(
        VALUE,
      );
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "the POSIX launcher's credential block",
  () => {
    function setup(answer: string, exitCode = 0) {
      const dir = mkdtempSync(join(tmpdir(), "armadra-cred-launch-"));
      temporary.push(dir);
      const client = join(dir, "client");
      writeFileSync(
        client,
        `#!/bin/sh\n[ "$1" = credential ] || exit 9\nprintf '%s' '${answer}'\nexit ${exitCode}\n`,
      );
      chmodSync(client, 0o755);
      const launcher = join(dir, "run-claude");
      writeFileSync(
        launcher,
        posixLauncher({
          agentId: "claude",
          runDir: dir,
          shimDir: dir,
          args: [],
          env: [],
          credential: { client, variables: variablesFor("claude") },
        }),
      );
      chmodSync(launcher, 0o755);
      return launcher;
    }

    function run(
      launcher: string,
      env: Record<string, string>,
      script: string,
    ): { status: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync(launcher, ["/bin/sh", "-c", script], {
          env: { PATH: process.env.PATH ?? "", ...env },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, stdout, stderr: "" };
      } catch (failure) {
        const error = failure as {
          status: number;
          stdout: string;
          stderr: string;
        };
        return {
          status: error.status,
          stdout: error.stdout,
          stderr: error.stderr,
        };
      }
    }

    const gate = { ARMADRA_NODE_ID: "n1", ARMADRA_CREDENTIAL_REF: "abc" };

    it("sets the variable for the program alone", () => {
      const launcher = setup(`CLAUDE_CODE_OAUTH_TOKEN=${VALUE}`);
      const result = run(
        launcher,
        gate,
        'printf %s "${#CLAUDE_CODE_OAUTH_TOKEN}"',
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(String(VALUE.length));
      expect(readFileSync(launcher, "utf8")).not.toContain(VALUE);
    });

    it("does not ask without the gate or without a bound entry", () => {
      const launcher = setup("ANYTHING=x", 3);
      expect(run(launcher, {}, "printf ok").stdout).toBe("ok");
      expect(run(launcher, { ARMADRA_NODE_ID: "n1" }, "printf ok").stdout).toBe(
        "ok",
      );
    });

    it("refuses to start the program when the client fails or names another variable", () => {
      const failing = setup("", 1);
      const failed = run(failing, gate, "printf started");
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      const foreign = setup("PATH=/tmp/evil");
      const refused = run(foreign, gate, "printf started");
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("unexpected node credential variable");
    });

    it("refuses when there is no client to ask", () => {
      const dir = mkdtempSync(join(tmpdir(), "armadra-cred-launch-"));
      temporary.push(dir);
      const launcher = join(dir, "run-claude");
      writeFileSync(
        launcher,
        posixLauncher({
          agentId: "claude",
          runDir: dir,
          shimDir: dir,
          args: [],
          env: [],
          credential: { client: "", variables: variablesFor("claude") },
        }),
      );
      chmodSync(launcher, 0o755);
      expect(run(launcher, gate, "printf started").status).toBe(1);
      expect(run(launcher, { ARMADRA_NODE_ID: "n1" }, "printf ok").stdout).toBe(
        "ok",
      );
    });
  },
);
