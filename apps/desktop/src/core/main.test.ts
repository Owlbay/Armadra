import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CoreContext,
  DOMAINS,
  HelpRequested,
  type RunningCore,
  run,
  runtimeEndpoint,
} from "./main";
import { install as installAcp } from "./acp";
import { install as installGateway } from "./gateway";
import { install as installHooks } from "./hook";
import { installIdentity } from "./identity";
import { install as installPush } from "./push";
import { install as installRealtime } from "./realtime";
import { install as installTerminals } from "./terminal/install";
import { install as installWorkflow } from "./workflow";
import { install as installForge } from "./forge";
import { install as installGit } from "./git";
import { install as installGithub } from "./github";
import { install as installMail } from "./mail";
import { install as installDiagnostics } from "./diagnostics";
import { read } from "./endpoints";
import { loopbackAnonymousOwner } from "./identity/http";
import { ROUTES } from "./http/routes";
import { selfGuarded } from "./http/route-scopes";
import { parseAnnouncement, VERSION } from "./instance";
import { endpointsFile } from "./paths";
import { tempDir } from "./testing/temp-dir";
import { TEST_ORIGIN, loopbackSession } from "./testing/loopback-session";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, "db/migrations");

const running: RunningCore[] = [];
afterEach(async () => {
  for (const core of running.splice(0)) await core.stop();
});

function temporary(): string {
  return tempDir("armadra-core-");
}

async function start(dataDir: string, listen = "tcp:127.0.0.1:0") {
  const lines: string[] = [];
  const core = await run({
    argv: ["--listen", listen, "--data-dir", dataDir],
    env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
    stdout: (line) => lines.push(line),
  });
  running.push(core);
  return { core, lines };
}

/** One hand-written upgrade request; returns the status line. */
function upgrade(
  core: RunningCore,
  path: string,
  origin?: string,
  protocol?: string,
): Promise<string> {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return new Promise((done) => {
    const socket = connect(tcp.port, tcp.host, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${tcp.host}\r\nConnection: Upgrade\r\n` +
          `Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
          (origin === undefined ? "" : `Origin: ${origin}\r\n`) +
          (protocol === undefined
            ? ""
            : `Sec-WebSocket-Protocol: ${protocol}\r\n`) +
          `\r\n`,
      );
    });
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes("\r\n")) {
        socket.destroy();
        done(received.slice(0, received.indexOf("\r\n")));
      }
    });
    socket.on("error", () => done("error"));
  });
}

function base(core: RunningCore): string {
  const tcp = core.bound.find((spec) => spec.kind === "tcp");
  if (tcp?.kind !== "tcp") throw new Error("no TCP listener");
  return `http://${tcp.host}:${tcp.port}`;
}

describe("the core process", () => {
  it("announces its instance on stdout before it binds anything", async () => {
    const { core, lines } = await start(temporary());
    expect(lines[0]).toBeDefined();
    expect(parseAnnouncement(lines[0] as string)).toBe(core.instanceId);
  });

  it("publishes an endpoint record naming every transport it bound", async () => {
    const dataDir = temporary();
    const { core } = await start(dataDir);
    const document = read(endpointsFile(dataDir));
    expect(document.version).toBe(1);
    expect(document.runtime?.instanceId).toBe(core.instanceId);
    expect(document.runtime?.processId).toBe(process.pid);
    expect(document.runtime?.http).toBe(base(core));
    expect(document.runtime?.websocket).toBe(base(core).replace("http", "ws"));
  });

  // `--listen unix:` is refused on Windows by design (`listen.ts` names
  // `pipe:NAME` instead), so there is no socket to withdraw there.
  it.skipIf(process.platform === "win32")(
    "withdraws the record and removes its socket when it stops",
    async () => {
      const dataDir = temporary();
      const socket = join(dataDir, "core.sock");
      const { core } = await start(dataDir, `unix:${socket}`);
      expect(existsSync(socket)).toBe(true);
      await core.stop();
      running.length = 0;
      expect(read(endpointsFile(dataDir)).runtime).toBeUndefined();
      expect(existsSync(socket)).toBe(false);
      // The file itself stays: it is a shared document, not ours to delete.
      expect(existsSync(endpointsFile(dataDir))).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the data directory and the endpoint file private",
    async () => {
      const dataDir = temporary();
      await start(dataDir);
      expect(statSync(endpointsFile(dataDir)).mode & 0o777).toBe(0o600);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    },
  );

  // Same reason: the second transport here is a Unix socket.
  it.skipIf(process.platform === "win32")(
    "listens on several transports at once",
    async () => {
      const dataDir = temporary();
      const socket = join(dataDir, "core.sock");
      const core = await run({
        argv: [
          "--listen",
          `unix:${socket}`,
          "--listen",
          "tcp:127.0.0.1:0",
          "--data-dir",
          dataDir,
        ],
        env: {
          ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
          ARMADRA_LOG: "error",
        },
        stdout: () => {},
      });
      running.push(core);
      expect(core.bound.map((spec) => spec.kind).sort()).toEqual([
        "tcp",
        "unix",
      ]);
      const document = read(endpointsFile(dataDir));
      expect(document.runtime?.socket).toBe(socket);
      expect(document.runtime?.http).toBeDefined();
    },
  );

  it("creates the database in the data directory it was given", async () => {
    const dataDir = temporary();
    await start(dataDir);
    expect(existsSync(join(dataDir, "canvas.db"))).toBe(true);
  });

  it("says hello on the bus once it is serving", async () => {
    const dataDir = temporary();
    const core = await run({
      argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
      env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
      stdout: () => {},
    });
    running.push(core);
    // The event has already fired by the time `run` resolves, so a late
    // subscriber proves only that the bus is wired; that is what R1 needs.
    let seen: unknown;
    core.bus.on("runtime.hello", (payload) => (seen = payload));
    core.bus.emit("runtime.hello", {
      instanceId: core.instanceId,
      version: "0.1.0",
    });
    expect(seen).toEqual({ instanceId: core.instanceId, version: "0.1.0" });
  });

  // 安全审查 L9：回环匿名不再按本机主人处理。缺省关；裸 core 用环境变量显式
  // 打开；壳传的选项优先于环境（服务器壳传 false，环境里有也不开）。
  it("回环匿名按主人缺省关，ARMADRA_LOOPBACK_OWNER=1 才开，选项优先", async () => {
    const env = {
      ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
      ARMADRA_LOG: "error",
    };
    const plain = await start(temporary());
    expect(loopbackAnonymousOwner()).toBe(false);
    const refused = await fetch(
      `${base(plain.core)}/api/automations/plans?workspaceId=ws`,
      { headers: { origin: "http://127.0.0.1:1420" } },
    );
    expect(refused.status).toBe(401);
    await plain.core.stop();
    running.splice(running.indexOf(plain.core), 1);

    const opened = await run({
      argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", temporary()],
      env: { ...env, ARMADRA_LOOPBACK_OWNER: "1" },
      stdout: () => {},
    });
    running.push(opened);
    expect(loopbackAnonymousOwner()).toBe(true);
    await opened.stop();
    running.splice(running.indexOf(opened), 1);

    const pinned = await run({
      argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", temporary()],
      env: { ...env, ARMADRA_LOOPBACK_OWNER: "1" },
      stdout: () => {},
      loopbackAnonymousOwner: false,
    });
    running.push(pinned);
    expect(loopbackAnonymousOwner()).toBe(false);
  });

  it("prints usage for --help and starts nothing", async () => {
    const lines: string[] = [];
    await expect(
      run({ argv: ["--help"], env: {}, stdout: (line) => lines.push(line) }),
    ).rejects.toBeInstanceOf(HelpRequested);
    expect(lines.join("")).toContain("--listen");
  });

  it("refuses to start on an argument it does not understand", async () => {
    await expect(
      run({ argv: ["--serve-everything"], env: {}, stdout: () => {} }),
    ).rejects.toThrow(/unsupported core argument/);
  });

  it("publishes nothing when it cannot bind", async () => {
    const dataDir = temporary();
    const { core } = await start(dataDir);
    const held = base(core).split(":")[2] as string;
    const second = temporary();
    await expect(
      run({
        argv: ["--listen", `tcp:127.0.0.1:${held}`, "--data-dir", second],
        env: {
          ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
          ARMADRA_LOG: "error",
        },
        stdout: () => {},
      }),
    ).rejects.toThrow(/already in use/);
    expect(existsSync(endpointsFile(second))).toBe(false);
  });

  // nightly 37858782422：启动中途失败（当时是 controller.sock 超长 EINVAL）时库先关了，
  // 终端对账、依赖与工作流扫描、ACP 预热还在跑，撞上 `database is not open`。
  it("启动中途失败时，先停各域登记的后台工作再关库", async () => {
    const { core } = await start(temporary());
    const held = base(core).split(":")[2] as string;
    const seen: string[] = [];
    await expect(
      run({
        argv: ["--listen", `tcp:127.0.0.1:${held}`, "--data-dir", temporary()],
        env: {
          ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
          ARMADRA_LOG: "error",
        },
        stdout: () => {},
        domains: [
          (context) => {
            context.onStop?.(() => {
              context.db.database.prepare("SELECT 1").get();
              seen.push("stopped with the database open");
            });
          },
        ],
      }),
    ).rejects.toThrow(/already in use/);
    expect(seen).toEqual(["stopped with the database open"]);
  });

  it("正常关停按登记的逆序停域，都在关库之前；一个域停失败不拦后面的", async () => {
    const order: string[] = [];
    const domain =
      (name: string, fail = false) =>
      (context: CoreContext) => {
        context.onStop?.(async () => {
          context.db.database.prepare("SELECT 1").get();
          order.push(name);
          if (fail) throw new Error(`${name} failed`);
        });
      };
    const core = await run({
      argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", temporary()],
      env: { ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir, ARMADRA_LOG: "error" },
      stdout: () => {},
      domains: [domain("first"), domain("second", true), domain("third")],
    });
    await core.stop();
    expect(order).toEqual(["third", "second", "first"]);
    expect(() => core.db.database.prepare("SELECT 1").get()).toThrow(
      /not open/,
    );
  });

  // macOS 的 sun_path 只有 104 字节，CI 的临时目录就占了一半：
  // `<dataDir>/controller.sock` 放不下时挪到临时目录下的私有目录，core 照常起来，
  // 地址经 endpoints.json 公布。
  it.skipIf(process.platform === "win32")(
    "数据目录深到 controller.sock 超出 sun_path 也照常起来，公布挪过去的地址",
    async () => {
      const deep = join(temporary(), "x".repeat(60), "serve-data");
      expect(Buffer.byteLength(join(deep, "controller.sock"))).toBeGreaterThan(
        104,
      );
      const { core } = await start(deep);
      const socket = read(endpointsFile(deep)).controller?.socket;
      expect(socket).toBeDefined();
      expect(socket?.startsWith(deep)).toBe(false);
      expect(Buffer.byteLength(socket ?? "")).toBeLessThanOrEqual(103);
      expect(statSync(socket ?? "").isSocket()).toBe(true);
      await core.stop();
      running.splice(running.indexOf(core), 1);
      expect(existsSync(socket ?? "")).toBe(false);
    },
  );
});

describe("what the core answers", () => {
  it("reports the same health document on both paths", async () => {
    const { core } = await start(temporary());
    const first = await (await fetch(`${base(core)}/health`)).json();
    const second = await (await fetch(`${base(core)}/api/health`)).json();
    expect(first).toEqual(second);
    expect(first).toEqual({
      status: "ok",
      version: VERSION,
      instanceId: core.instanceId,
      build: expect.any(String) as string,
      // R3 brought the hook service up with the core: the endpoint file names
      // this data directory's socket, which is what `ok` reports on. Windows
      // has no such socket — the hook service reports no `sock` there and the
      // clients reach the core over its TCP listener instead.
      hook:
        process.platform === "win32"
          ? { ok: true }
          : { ok: true, sock: join(core.dataDir, "hook.sock") },
      // 这台机器上有没有 Chromium 决定真假；键必须在，页面靠它给浏览器入口。
      capabilities: { headlessBrowser: expect.any(Boolean) as boolean },
      // 页面按它校验本机路径、按缺省 shell 引用启动行。
      platform: process.platform,
      defaultShell: expect.any(String) as string,
    });
  });

  it("answers a route it has not written with 501 naming that path", async () => {
    const { core } = await start(temporary());
    const session = await loopbackSession(core, base(core));
    // askpass 那两条在表里但**故意**不在 HTTP 面上（助手走它自己的 0600 socket），
    // 所以主监听器上能观察到 501 的只剩它们。
    const response = await session.fetch("/api/ssh/askpass/prompts/x");
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      code: "not_implemented",
      message: "未实现：/api/ssh/askpass/prompts/{promptId}",
    });
  });

  /**
   * 路由表的 `implemented` 与装配之后的事实逐条对账。
   *
   * 这张表是页面用来分辨「该等」和「该改」的唯一依据，而它是手写的：一条真
   * 答得出来却没打标记的路由会让人以为功能没做（打包验收时终端与 hook 面那
   * 十几条就是这样），反过来一条打了标记却没人注册的路由会让页面撞上 501。
   * 两种漂移都只在**装配之后**才看得见，所以这条用例起一个真 core。
   */
  it("路由表说答得出来的那些，装配之后真的有人接", async () => {
    const { core } = await start(temporary());
    // 三种装法都算：普通 handler、等升级的流，以及 GitHub / 自动化 / 身份那
    // 三张整段接管前缀的 JSON 面。
    const claimed = (entry: (typeof ROUTES)[number]): boolean =>
      core.server.streamed(entry.path) ||
      core.server.rawHandled(entry.path) ||
      entry.methods.some((method) =>
        core.server.router.claimed(method, entry.path),
      );
    const missing: string[] = [];
    const undeclared: string[] = [];
    for (const entry of ROUTES) {
      if (entry.surface !== "runtime") continue;
      const has = claimed(entry);
      if (entry.implemented === true && !has) missing.push(entry.path);
      if (entry.implemented !== true && has) undeclared.push(entry.path);
    }
    expect(missing, "写着已实现却没人注册").toEqual([]);
    expect(undeclared, "答得出来却没打标记").toEqual([]);
  });

  /**
   * 路由 scope 的覆盖率，补上路由表之外的那一半（安全审查 2026-10）：整段
   * 接管的前缀（身份、OAuth、GitHub、自动化、工作流）不在路由表里，路由门照样
   * 按 `route-scopes.ts` 判它们。每个前缀下的读写都必须有声明，或者在自己认
   * 身份的 `SELF_GUARDED` 里——缺一条，成员在那里就是缺省拒绝之外的一个洞。
   */
  it("整段接管的前缀也都声明了 scope 或自己认身份", async () => {
    const { core } = await start(temporary());
    const prefixes = core.server.rawPrefixes();
    expect(prefixes.length).toBeGreaterThan(0);
    const undeclared: string[] = [];
    for (const prefix of prefixes) {
      const probe = `${prefix.replace(/\/$/, "")}/probe`;
      if (selfGuarded(probe)) continue;
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        if (core.server.router.requiredScope(method, probe) === undefined) {
          undeclared.push(`${method} ${prefix}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("answers a path nobody claimed with 404, not 501", async () => {
    const { core } = await start(temporary());
    const session = await loopbackSession(core, base(core));
    const response = await session.fetch("/api/invented");
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("not_found");
  });

  it("answers JSON with a content type and no trailing newline", async () => {
    // Byte parity with the Rust Runtime: its axum responses end at the
    // closing brace, and a Content-Length assertion on either side must agree.
    const { core } = await start(temporary());
    const response = await fetch(`${base(core)}/health`);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toMatch(/\}$/);
  });

  it("answers a loopback origin and refuses any other", async () => {
    const { core } = await start(temporary());
    const allowed = await fetch(`${base(core)}/health`, {
      headers: { origin: "http://127.0.0.1:1420" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:1420",
    );
    const refused = await fetch(`${base(core)}/health`, {
      headers: { origin: "http://example.com" },
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("forbidden");
  });

  it("answers a preflight with the allowed verbs and no body", async () => {
    const { core } = await start(temporary());
    const response = await fetch(`${base(core)}/api/workspaces`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:1420" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PATCH",
    );
  });

  it("refuses a WebSocket upgrade that names no origin", async () => {
    // `fetch` will not send an upgrade, so this is spoken by hand.
    const { core } = await start(temporary());
    expect(await upgrade(core, "/api/workspaces/ws-1/events")).toMatch(
      /^HTTP\/1\.1 403/,
    );
  });

  it("refuses an upgrade the core has no stream for", async () => {
    const { core } = await start(temporary());
    // Both streams in the table — the workspace event one and the language
    // session one — are written now, so the case this covers is an upgrade to
    // a path the table does not carry at all: refused outright, rather than a
    // socket left hanging open.
    expect(
      await upgrade(
        core,
        "/api/workspaces/ws-1/not-a-stream",
        "http://127.0.0.1:1420",
      ),
    ).toMatch(/^HTTP\/1\.1 501/);
  });

  /**
   * A stream that exists refuses on its own terms instead. The workspace
   * event route checks the workspace before the upgrade, exactly as the Rust
   * route does, so an unknown one is an HTTP 404 rather than a socket that
   * opens and immediately closes.
   */
  it("lets a stream that exists answer its own refusal", async () => {
    const { core } = await start(temporary());
    const session = await loopbackSession(core, base(core));
    expect(
      await upgrade(
        core,
        "/api/workspaces/ws-1/events",
        TEST_ORIGIN,
        await session.wsProtocol(),
      ),
    ).toMatch(/^HTTP\/1\.1 404/);
  });

  /**
   * 安全审查 L9：本机另一个回环端口上的网页（或任何不带会话的本机进程）调
   * core 的 `/api/` 与流，一律被拒。只有不要会话的那几条放行。
   */
  describe("回环上没带会话的请求（契约 §3.2，安全审查 L9）", () => {
    const STRANGER = "http://127.0.0.1:8080";

    it("别的回环来源与不报来源的调用打 /api/ 都是 401", async () => {
      const { core } = await start(temporary());
      const callers: Record<string, string>[] = [{ origin: STRANGER }, {}];
      for (const headers of callers) {
        const settings = await fetch(`${base(core)}/api/settings`, { headers });
        expect(settings.status).toBe(401);
        expect(await settings.json()).toEqual({
          code: "unauthenticated",
          message: "需要一个已配对设备的会话",
        });
        const write = await fetch(`${base(core)}/api/workspaces`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: "x", rootPath: "/tmp" }),
        });
        expect(write.status).toBe(401);
      }
      // 带着一个编出来的 Bearer 也一样。
      const forged = await fetch(`${base(core)}/api/settings`, {
        headers: {
          origin: STRANGER,
          authorization: `Bearer ${"0".repeat(32)}.${"a".repeat(43)}`,
        },
      });
      expect(forged.status).toBe(401);
    });

    it("不要会话的那几条照旧：健康检查、hello、预检", async () => {
      const { core } = await start(temporary());
      const headers = { origin: STRANGER };
      expect((await fetch(`${base(core)}/health`, { headers })).status).toBe(
        200,
      );
      expect(
        (await fetch(`${base(core)}/api/health`, { headers })).status,
      ).toBe(200);
      expect(
        (await fetch(`${base(core)}/api/identity/hello`, { headers })).status,
      ).toBe(200);
      const preflight = await fetch(`${base(core)}/api/settings`, {
        method: "OPTIONS",
        headers,
      });
      expect(preflight.status).toBe(204);
    });

    it("没带票的升级是 401；票只认签它的来源、只用一次", async () => {
      const { core } = await start(temporary());
      const session = await loopbackSession(core, base(core));
      const workspace = (await (
        await session.fetch("/api/workspaces")
      ).json()) as { id: string }[];
      const events = `/api/workspaces/${workspace[0]?.id}/events`;
      expect(await upgrade(core, events, STRANGER)).toMatch(/^HTTP\/1\.1 401/);
      expect(
        await upgrade(core, events, STRANGER, await session.wsProtocol()),
      ).toMatch(/^HTTP\/1\.1 401/);
      const protocol = await session.wsProtocol();
      expect(await upgrade(core, events, TEST_ORIGIN, protocol)).toMatch(
        /^HTTP\/1\.1 101/,
      );
      expect(await upgrade(core, events, TEST_ORIGIN, protocol)).toMatch(
        /^HTTP\/1\.1 401/,
      );
    });

    it("媒体票（§37.4）：不带头直接取得到，签票的会话登出之后作废", async () => {
      const { core } = await start(temporary());
      const session = await loopbackSession(core, base(core));
      const project = temporary();
      writeFileSync(join(project, "clip.mp4"), Buffer.alloc(4096, 7));
      const created = (await (
        await session.fetch("/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "media", rootPath: project }),
        })
      ).json()) as { id: string };
      const issued = await session.fetch("/api/rpc/files/mediaTicket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: { workspaceId: created.id, path: "clip.mp4" },
        }),
      });
      expect(issued.status).toBe(200);
      const { url } = ((await issued.json()) as { json: { url: string } }).json;
      // 浏览器的 `<video src>`：没有 Origin、没有 Authorization。
      const part = await fetch(`${base(core)}${url}`, {
        headers: { range: "bytes=0-1023" },
      });
      expect(part.status).toBe(206);
      expect((await part.arrayBuffer()).byteLength).toBe(1024);
      // 同一个文件不带票照旧 401。
      const bare = await fetch(
        `${base(core)}/api/workspaces/${created.id}/file-download?path=clip.mp4`,
        { headers: { origin: TEST_ORIGIN } },
      );
      expect(bare.status).toBe(401);
      const loggedOut = await fetch(
        `${base(core)}/api/identity/session/logout`,
        {
          method: "POST",
          headers: {
            origin: session.origin,
            authorization: `Bearer ${session.refreshToken}`,
          },
        },
      );
      expect(loggedOut.status).toBeLessThan(300);
      const after = await fetch(`${base(core)}${url}`);
      expect(after.status).toBe(401);
    });

    it("配对之后带 Bearer 是 200；会话绑在来源上，换个来源不认", async () => {
      const { core } = await start(temporary());
      const session = await loopbackSession(core, base(core));
      expect((await session.fetch("/api/settings")).status).toBe(200);
      const elsewhere = await fetch(`${base(core)}/api/settings`, {
        headers: { ...session.headers, origin: STRANGER },
      });
      expect(elsewhere.status).toBe(401);
    });

    it("反复配对（页面重载、托盘）设备列表不增长", async () => {
      const { core } = await start(temporary());
      await loopbackSession(core, base(core), "http://127.0.0.1:50001");
      await loopbackSession(core, base(core), "http://127.0.0.1:50002");
      const tray = await loopbackSession(
        core,
        base(core),
        new URL(base(core)).origin,
      );
      const answer = await tray.fetch("/api/identity/devices");
      expect(answer.status).toBe(200);
      expect(
        ((await answer.json()) as { devices: unknown[] }).devices,
      ).toHaveLength(1);
    });

    it("ws-ticket 只发给带着会话的原生传输", async () => {
      const { core } = await start(temporary());
      const anonymous = await fetch(`${base(core)}/api/identity/ws-ticket`, {
        method: "POST",
        headers: { origin: STRANGER },
      });
      expect(anonymous.status).toBe(401);
    });

    it("显式打开回环匿名（裸 core）时这道门不在", async () => {
      const dataDir = temporary();
      const core = await run({
        argv: ["--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
        env: {
          ARMADRA_CORE_MIGRATIONS_DIR: migrationsDir,
          ARMADRA_LOG: "error",
          ARMADRA_LOOPBACK_OWNER: "1",
        },
        stdout: () => {},
      });
      running.push(core);
      const settings = await fetch(`${base(core)}/api/settings`, {
        headers: { origin: STRANGER },
      });
      expect(settings.status).toBe(200);
    });
  });

  it("stops accepting once it has stopped", async () => {
    const { core } = await start(temporary());
    const address = base(core);
    await core.stop();
    running.length = 0;
    await expect(fetch(`${address}/health`)).rejects.toThrow();
  });
});

describe("the published record", () => {
  it("names every transport, and nothing a browser cannot reach when there is none", () => {
    const endpoint = runtimeEndpoint(
      "instance-1",
      [
        { kind: "tcp", host: "127.0.0.1", port: 53211 },
        { kind: "unix", path: "/tmp/armadra/runtime.sock" },
        { kind: "pipe", name: "armadra-core" },
      ],
      () => new Date(0),
      4321,
    );
    expect(endpoint).toEqual({
      instanceId: "instance-1",
      writtenAt: "1970-01-01T00:00:00.000Z",
      processId: 4321,
      http: "http://127.0.0.1:53211",
      websocket: "ws://127.0.0.1:53211",
      socket: "/tmp/armadra/runtime.sock",
      pipe: "\\\\.\\pipe\\armadra-core",
    });

    const private_ = runtimeEndpoint("instance-2", [
      { kind: "unix", path: "/tmp/armadra/runtime.sock" },
    ]);
    expect(private_.http).toBeUndefined();
    expect(private_.websocket).toBeUndefined();
  });
});

describe("the assembly order", () => {
  it("补全计划的域按 identity → 终端 → acp → workflow → realtime → push → gateway 装配", () => {
    const order = [
      installIdentity,
      installTerminals,
      installAcp,
      installWorkflow,
      installRealtime,
      installPush,
      installGateway,
    ].map((install) => DOMAINS.indexOf(install));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Gateway 对外监听，开始时每个域都得已经装好；hook 服务公布端点，也在
    // 每个答得了 hook 报告的域之后。
    expect(DOMAINS.at(-1)).toBe(installGateway);
    expect(DOMAINS.at(-2)).toBe(installHooks);
  });

  it("G5 的三个域：forge 在 GitHub 与 Git 之后，邮件与页面错误上报在推送之后、hook 服务之前", () => {
    const at = (install: (typeof DOMAINS)[number]) => DOMAINS.indexOf(install);
    for (const install of [installForge, installMail, installDiagnostics]) {
      expect(at(install)).toBeGreaterThanOrEqual(0);
    }
    expect(at(installForge)).toBeGreaterThan(at(installGithub));
    expect(at(installForge)).toBeGreaterThan(at(installGit));
    expect(at(installMail)).toBeGreaterThan(at(installPush));
    expect(at(installDiagnostics)).toBeGreaterThan(at(installPush));
    expect(at(installMail)).toBeLessThan(at(installHooks));
    expect(at(installDiagnostics)).toBeLessThan(at(installHooks));
  });
});

describe("the built bundle", () => {
  const bundle = resolve(here, "../../out/core/main.js");

  it.skipIf(!existsSync(bundle))(
    "is plain CommonJS that requires no Electron",
    () => {
      const source = readFileSync(bundle, "utf8");
      expect(source).not.toMatch(/require\(["']electron["']\)/);
      expect(source).toContain("armadra-runtime instance ");
    },
  );
});
