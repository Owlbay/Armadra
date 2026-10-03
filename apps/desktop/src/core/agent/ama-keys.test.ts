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

import type { CoreRequest } from "../http/router";
import type { SecretBackend } from "../secrets/backend";
import { posixLauncher } from "../hook/install/launcher";
import { type HookFixture, hookFixture } from "../hook/fixture";
import {
  AMA_KEY_VARIABLES,
  AmaCredentials,
  setAmaCredentials,
} from "./ama-credentials";

/**
 * ama 的模型密钥怎么到 ama（契约 §12.4）：hook 通道的 `/credential/ama` 只答给
 * 验过 token 的 ama 节点；启动器 `run/ama` 只把认得的名字设给 ama 进程，失败就
 * 不启动。值不落盘、不进节点 shell 的环境、不进启动器正文。
 */

const KEY = "sk-ama-FAKE-VALUE-FOR-TESTS-ONLY";

function memoryBackend(): SecretBackend {
  const values = new Map<string, string>();
  return {
    kind: "keychain",
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

const temporary: string[] = [];
afterEach(() => {
  setAmaCredentials(undefined);
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")(
  "the hook surface's /credential/ama",
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
        path: "/credential/ama",
        query: new URLSearchParams(),
        headers,
        body: encoded,
        raw: undefined as never,
        json: <T>(): T => JSON.parse(encoded.toString("utf8")) as T,
      } satisfies CoreRequest;
      return one.server.router.dispatch(
        "POST",
        "/credential/ama",
        request,
      ) as Promise<{ status: number; body: unknown }>;
    }

    function agentOf(one: HookFixture, id: string): void {
      one.context.database
        .prepare(
          "UPDATE nodes SET data_json = json_set(data_json, '$.agent', json(?)) WHERE id = ?",
        )
        .run(JSON.stringify({ id }), one.nodeId);
    }

    it("answers the keys only to an ama node's verified token", async () => {
      const one = hookFixture();
      hooks.push(one);
      const keys = new AmaCredentials(memoryBackend());
      await keys.set("deepseek", KEY);
      setAmaCredentials(keys);
      agentOf(one, "ama");
      const token = one.service.issueNodeToken(one.nodeId);
      const good = {
        "x-armadra-hook-token": one.bearer,
        "x-armadra-node-token": token,
      };
      const answer = await post(one, { nodeId: one.nodeId }, good);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        variables: [{ variable: "AMA_API_KEY_DEEPSEEK", value: KEY }],
      });

      const noToken = await post(
        one,
        { nodeId: one.nodeId },
        { "x-armadra-hook-token": one.bearer },
      );
      expect(noToken.status).toBe(403);
      const forged = await post(
        one,
        { nodeId: one.nodeId },
        { ...good, "x-armadra-node-token": "0".repeat(64) },
      );
      expect(forged.status).toBe(403);
      const noBearer = await post(
        one,
        { nodeId: one.nodeId },
        { "x-armadra-node-token": token },
      );
      expect(noBearer.status).toBe(403);

      // A Claude node on the same board gets nothing, verified or not.
      agentOf(one, "claude");
      const claude = await post(one, { nodeId: one.nodeId }, good);
      expect(claude.status).toBe(403);
      expect(JSON.stringify([noToken, forged, noBearer, claude])).not.toContain(
        KEY,
      );
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "the POSIX launcher's ama key block",
  () => {
    function setup(answer: string, exitCode = 0) {
      const dir = mkdtempSync(join(tmpdir(), "armadra-ama-launch-"));
      temporary.push(dir);
      const client = join(dir, "client");
      writeFileSync(
        client,
        `#!/bin/sh\n[ "$1 $2" = "credential --ama" ] || exit 9\nprintf '${answer}'\nexit ${exitCode}\n`,
      );
      chmodSync(client, 0o755);
      const launcher = join(dir, "run-ama");
      writeFileSync(
        launcher,
        posixLauncher({
          agentId: "ama",
          runDir: dir,
          shimDir: dir,
          args: [],
          env: [],
          amaKeys: { client, variables: AMA_KEY_VARIABLES },
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

    const gate = { ARMADRA_NODE_ID: "n1" };

    it("sets every answered key on the program alone", () => {
      const launcher = setup(
        `AMA_API_KEY_DEEPSEEK=${KEY}\\nAMA_API_KEY_OPENAI=sk-two\\n`,
      );
      const result = run(
        launcher,
        gate,
        'printf "%s %s" "${#AMA_API_KEY_DEEPSEEK}" "$AMA_API_KEY_OPENAI"',
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${KEY.length} sk-two`);
      expect(readFileSync(launcher, "utf8")).not.toContain(KEY);
    });

    it("starts with no keys when none is set, and never asks outside a node", () => {
      const empty = setup("");
      expect(run(empty, gate, "printf ok").stdout).toBe("ok");
      const failing = setup("", 3);
      expect(run(failing, {}, "printf ok").stdout).toBe("ok");
    });

    it("refuses to start when the exchange fails or names another variable", () => {
      const failed = run(setup("", 1), gate, "printf started");
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      const foreign = run(setup("PATH=/tmp/evil\\n"), gate, "printf started");
      expect(foreign.status).toBe(1);
      expect(foreign.stdout).toBe("");
      expect(foreign.stderr).toContain("unexpected ama key variable");
    });
  },
);
