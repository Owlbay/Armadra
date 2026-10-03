import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import * as Sentry from "@sentry/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventBus } from "../../desktop/src/core/bus";
import { CoreServer } from "../../desktop/src/core/http/server";
import { createLog } from "../../desktop/src/core/platform";
import { tempDir } from "../../desktop/src/core/testing/temp-dir";
import { CRASH_REPORT_DSN_ENV, installServerDiagnostics } from "./diagnostics";
import { serverPlatform } from "./platform-node";

/**
 * 对 dev-stack 的 GlitchTip（外部服务 §11.2、§14）：真 `@sentry/node`、真 core
 * 请求路径、真收件端，断言收到的事件里没有环境变量、家目录、终端输出与凭据。
 *
 * 只在 `ARMADRA_DEV_STACK=1` 时跑（`pnpm dev-stack up glitchtip` 之后；CI 由
 * `tools/probes/crash-report-e2e.mjs` 经 e2e 清单调起）。组织 / 项目 / 只读 API
 * 令牌由容器里的 `manage.py shell` 现建，都是本机 dev-stack 里的测试数据。
 */

const GLITCHTIP = "http://127.0.0.1:8000";
const enabled = process.env.ARMADRA_DEV_STACK === "1";

const SEED = `
from django.contrib.auth import get_user_model
from apps.organizations_ext.models import Organization
from apps.projects.models import Project, ProjectKey
from apps.api_tokens.models import APIToken
User = get_user_model()
user, _ = User.objects.get_or_create(email="crash-probe@armadra.test")
org, _ = Organization.objects.get_or_create(slug="armadra-probe", defaults={"name": "armadra-probe"})
if not org.users.filter(pk=user.pk).exists():
    org.add_user(user)
project, _ = Project.objects.get_or_create(organization=org, slug="crash-probe", defaults={"name": "crash-probe", "platform": "node"})
key = ProjectKey.objects.filter(project=project).first() or ProjectKey.objects.create(project=project)
token = APIToken.objects.create(user=user)
token.add_permissions(["project:read", "event:read", "org:read"])
print("DSN=" + key.get_dsn())
print("TOKEN=" + token.token)
`;

interface Seeded {
  readonly dsn: string;
  readonly token: string;
}

function seed(): Seeded {
  const docker = process.env.ARMADRA_DOCKER_BIN ?? "docker";
  const found = spawnSync(
    docker,
    [
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=armadra-dev",
      "--filter",
      "label=com.docker.compose.service=glitchtip",
    ],
    { encoding: "utf8" },
  );
  const container = found.stdout.trim().split("\n")[0];
  if (!container)
    throw new Error("glitchtip 容器没在跑：pnpm dev-stack up glitchtip");
  const run = spawnSync(
    docker,
    ["exec", "-i", container, "./manage.py", "shell"],
    { input: SEED, encoding: "utf8", timeout: 120_000 },
  );
  const out = `${run.stdout}`;
  const dsn = /^DSN=(.+)$/m.exec(out)?.[1]?.trim();
  const token = /^TOKEN=(.+)$/m.exec(out)?.[1]?.trim();
  if (!dsn || !token) throw new Error(`seed failed: ${run.stderr}`);
  return { dsn, token };
}

async function api(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${GLITCHTIP}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

/** 等到带这个标记的事件入库，返回它的完整 JSON。 */
async function eventWith(
  token: string,
  marker: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await api(
      token,
      "/api/0/projects/armadra-probe/crash-probe/events/",
    )) as { eventID?: string; id?: string; title?: string; message?: string }[];
    const hit = list.find((event) =>
      `${event.title ?? ""} ${event.message ?? ""}`.includes(marker),
    );
    if (hit !== undefined) {
      const id = hit.eventID ?? hit.id;
      return (await api(
        token,
        `/api/0/projects/armadra-probe/crash-probe/events/${id}/`,
      )) as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

describe.skipIf(!enabled)("崩溃上报 → dev-stack GlitchTip", () => {
  let seeded: Seeded;
  const secret = `sk-probe-${randomBytes(16).toString("hex")}`;
  const envName = "ARMADRA_PROBE_API_KEY";

  beforeAll(() => {
    seeded = seed();
  }, 180_000);

  afterAll(async () => {
    await Sentry.close(2_000);
  });

  /** 起一个只有一条会抛的路由的 core 服务，经它的 500 路径报错。 */
  async function throughCore(
    env: NodeJS.ProcessEnv,
    thrown: Error,
  ): Promise<() => Promise<void>> {
    const dataDir = tempDir("crash-probe-");
    const log = createLog("error", () => {});
    const diagnostics = installServerDiagnostics({
      dataDir,
      env,
      release: "0.0.0-probe",
      log,
      // vitest 里没有 CommonJS 的 require；打出来的服务器包里走缺省那条。
      loadSdk: () => Sentry,
      watch: false,
      exit: () => {},
    });
    await diagnostics.refresh();
    const platform = {
      ...serverPlatform({ dataDir, appVersion: "0", isPackaged: false, log }),
      reportError: diagnostics.reportError,
    };
    const server = new CoreServer({
      platform,
      bus: new EventBus(),
      version: "0",
    });
    server.router.handle("GET", "/api/workspaces/{workspaceId}/events", () => {
      // 作用域上的用户与 extra：剥离要把它们整段删掉。
      Sentry.setUser({ email: "someone@armadra.test", ip_address: "10.1.2.3" });
      Sentry.setExtra("terminal", "$ cat ~/.ssh/id_ed25519");
      Sentry.setContext("process", { env: { [envName]: secret } });
      Sentry.addBreadcrumb({ category: "console", message: "$ npm test PASS" });
      Sentry.addBreadcrumb({
        category: "app",
        message: "opened workspace",
        data: { path: `${homedir()}/secret-project` },
      });
      throw thrown;
    });
    const listener = server.createListener();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/w1/events`,
    );
    expect(response.status).toBe(500);
    await Sentry.flush(5_000);
    return async () => {
      await server.close();
      await diagnostics.stop();
    };
  }

  it("收到一条事件，且没有环境变量、家目录、终端输出、用户与 extra", async () => {
    const marker = `probe-${randomBytes(6).toString("hex")}`;
    const env = {
      [CRASH_REPORT_DSN_ENV]: seeded.dsn,
      [envName]: secret,
      HOME: homedir(),
    };
    const error = new Error(
      `${marker} failed with key ${secret} reading ${homedir()}/secret-project/a.ts and /Users/probe-user/x \u001b[31m$ cat .env\u001b[0m token=ghp_abcdefghijklmnopqrstuvwxyz012345`,
    );
    const stop = await throughCore(env, error);
    try {
      const event = await eventWith(seeded.token, marker, 60_000);
      expect(event, "GlitchTip 没收到事件").not.toBe(null);
      const text = JSON.stringify(event);
      expect(text).toContain(marker);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(envName);
      expect(text).not.toContain(homedir());
      expect(text).not.toContain("probe-user");
      // 家目录下的路径留下相对部分（用户名没了），面包屑的 data 整段没了。
      expect(text).toContain("~/secret-project/a.ts");
      expect(text).not.toContain('"path"');
      expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
      expect(text).not.toContain("\\u001b");
      expect(text).not.toContain("id_ed25519");
      expect(text).not.toContain("npm test");
      expect(text).not.toContain("someone@armadra.test");
      expect(text).not.toContain("10.1.2.3");
      const tags = (event!.tags ?? []) as { key: string; value: string }[];
      expect(tags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "source", value: "http" }),
          expect.objectContaining({ key: "shell", value: "server" }),
        ]),
      );
    } finally {
      await stop();
    }
  }, 120_000);

  it("没配 DSN：同一路径什么都不发", async () => {
    const marker = `probe-off-${randomBytes(6).toString("hex")}`;
    const stop = await throughCore(
      {},
      new Error(`${marker} should stay local`),
    );
    try {
      expect(await eventWith(seeded.token, marker, 8_000)).toBe(null);
    } finally {
      await stop();
    }
  }, 60_000);
});
