import { describe, expect, it } from "vitest";
import type { OutboundRequest } from "../../desktop/src/core/sources/http-client";
import { parseCommandLine } from "./cli";
import {
  CloudCliError,
  type LocalCore,
  PASSWORD_ENV,
  TOKEN_ENV,
  parseExpires,
} from "./cloud";
import { main } from "./main";

const ISSUER = "https://relay.example.com";
const FINGERPRINT = "ab".repeat(32);
const TOKEN = "registration-token-secret";
const PASSWORD = "correct horse battery staple";
const ACCESS = "relay-access-token-secret";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** 假的本机 core：按路径答，记下每次调用。 */
function fakeCore(
  options: { registered?: boolean; alreadyRegistered?: boolean } = {},
) {
  const calls: Call[] = [];
  let registered = options.registered ?? false;
  const core: LocalCore = {
    async call(method, path, body) {
      calls.push({ method, path, body });
      if (method === "GET" && path === "/api/sources") {
        return {
          remotes: [
            {
              serviceId: "s".repeat(32),
              issuer: ISSUER,
              fingerprint: FINGERPRINT,
              registered,
            },
          ],
        };
      }
      if (method === "POST" && path === "/api/sources/remotes") {
        return {
          remote: {
            serviceId: "s".repeat(32),
            issuer: ISSUER,
            fingerprint: FINGERPRINT,
            registered,
          },
          next: "ready",
        };
      }
      if (path.endsWith("/session")) return { accessToken: ACCESS };
      if (method === "POST" && path === "/api/identity/cloud/register") {
        if (options.alreadyRegistered === true) {
          throw new CloudCliError("cloud_already_registered", "已经登记");
        }
        registered = true;
        return { issuer: ISSUER, tunnel: { state: "connecting", node: null } };
      }
      if (method === "GET" && path === "/api/identity/cloud") {
        return {
          sourceId: "h".repeat(32),
          registrations: registered
            ? [
                {
                  issuer: ISSUER,
                  mode: "personal",
                  tunnel: {
                    state: "ready",
                    node: "wss://relay.example.com/t/v1",
                  },
                },
              ]
            : [],
        };
      }
      if (
        method === "DELETE" &&
        path.startsWith("/api/identity/cloud/register")
      ) {
        return {};
      }
      if (method === "POST" && path === "/api/identity/invitations") {
        return {
          invitationId: "i".repeat(32),
          token: `${"i".repeat(32)}.secret`,
          expiresAtMs: 2_000_000_000_000,
        };
      }
      if (
        method === "DELETE" &&
        path.startsWith("/api/identity/invitations/")
      ) {
        return { revoked: true };
      }
      throw new Error(`未预期的调用 ${method} ${path}`);
    },
  };
  return { core, calls };
}

function harness(
  core: LocalCore,
  extra: {
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    prompt?: string;
    link?: { status: number; body: unknown };
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const relay: OutboundRequest[] = [];
  const clock = { now: 1_000 };
  const io = {
    stdout: (line: string) => void out.push(line),
    stderr: (line: string) => void err.push(line),
    env: extra.env ?? {},
    moduleDir: "/nowhere",
    ...(extra.stdin === undefined
      ? {}
      : { stdin: async () => extra.stdin as string }),
    ...(extra.prompt === undefined
      ? {}
      : { prompt: async () => extra.prompt as string }),
    cloud: {
      connect: async () => core,
      now: () => (clock.now += 400),
      transport: async (request: OutboundRequest) => {
        relay.push(request);
        if (request.url.endsWith("/v1/sources/registration-tokens")) {
          return {
            status: 200,
            body: { registrationToken: TOKEN, expiresAtMs: 1, issuer: ISSUER },
          };
        }
        return (
          extra.link ?? {
            status: 200,
            body: {
              linkId: "L1",
              url: `${ISSUER}/j/L1`,
              secret: "sekret",
              expiresAtMs: 2_000_000_000_000,
            },
          }
        );
      },
    },
  };
  return { io, out, err, relay };
}

describe("cloud 与 invite 的参数解析", () => {
  it("cloud 要一个动作，参数在表里，invite 的 --cloud-link 不带值", () => {
    const parsed = parseCommandLine([
      "cloud",
      "register",
      "--issuer",
      ISSUER,
      "--token-stdin",
    ]);
    expect(parsed).toMatchObject({
      kind: "run",
      command: "cloud",
      positionals: ["register"],
    });
    expect(parseCommandLine(["cloud", "register", "extra"])).toMatchObject({
      kind: "error",
    });
    expect(
      parseCommandLine(["cloud", "register", "--listen", "a:1"]),
    ).toMatchObject({ kind: "error" });
    expect(
      parseCommandLine(["invite", "--cloud-link", "--issuer", ISSUER]),
    ).toMatchObject({
      kind: "run",
      command: "invite",
    });
    expect(parseCommandLine(["invite", "--cloud-link=1"])).toMatchObject({
      kind: "error",
    });
  });

  it("--expires 认 m / h / d", () => {
    expect(parseExpires("30m")).toBe(1_800_000);
    expect(parseExpires("12h")).toBe(43_200_000);
    expect(parseExpires("7d")).toBe(604_800_000);
    for (const bad of ["7", "d", "0d", "7w", "-1d", ""]) {
      expect(parseExpires(bad)).toBeUndefined();
    }
  });
});

describe("cloud register / revoke / status", () => {
  it("register：令牌与指纹交给 core，等隧道 ready，输出里没有令牌", async () => {
    const { core, calls } = fakeCore();
    const { io, out, err } = harness(core, { env: { [TOKEN_ENV]: TOKEN } });
    const code = await main(
      [
        "cloud",
        "register",
        "--issuer",
        ISSUER,
        "--fingerprint",
        FINGERPRINT,
        "--label",
        "box",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/register")?.body,
    ).toEqual({
      issuer: ISSUER,
      registrationToken: TOKEN,
      label: "box",
      fingerprint: FINGERPRINT,
    });
    expect(out.join("")).toContain("已登记");
    expect(out.join("")).toContain("ready");
    expect(out.join("") + err.join("")).not.toContain(TOKEN);
  });

  it("register：--token-stdin 从标准输入读；已登记是幂等的，退出 0", async () => {
    const { core, calls } = fakeCore({ alreadyRegistered: true });
    const { io, out } = harness(core, { stdin: `${TOKEN}\n` });
    expect(
      await main(
        ["cloud", "register", "--issuer", ISSUER, "--token-stdin"],
        io,
      ),
    ).toBe(0);
    expect(out.join("")).toContain("跳过");
    expect(
      (calls[0]?.body as { registrationToken: string }).registrationToken,
    ).toBe(TOKEN);
  });

  it("register：缺令牌或地址是用法错误（2），不去连 core", async () => {
    const { core, calls } = fakeCore();
    const { io, err } = harness(core);
    expect(await main(["cloud", "register", "--issuer", ISSUER], io)).toBe(2);
    expect(await main(["cloud", "register", "--token", TOKEN], io)).toBe(2);
    expect(
      await main(
        [
          "cloud",
          "register",
          "--issuer",
          ISSUER,
          "--token",
          TOKEN,
          "--fingerprint",
          "zz",
        ],
        io,
      ),
    ).toBe(2);
    expect(calls).toEqual([]);
    expect(err.join("")).not.toContain(TOKEN);
  });

  it("revoke 与 status（含 --output json）", async () => {
    const { core, calls } = fakeCore({ registered: true });
    const { io, out } = harness(core);
    expect(await main(["cloud", "revoke", "--issuer", ISSUER], io)).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: `/api/identity/cloud/register?issuer=${encodeURIComponent(ISSUER)}`,
    });
    out.length = 0;
    expect(await main(["cloud", "status"], io)).toBe(0);
    expect(out.join("")).toContain(`${ISSUER}（personal）隧道 ready`);
    out.length = 0;
    expect(await main(["cloud", "status", "--output", "json"], io)).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      command: "cloud status",
      registrations: [{ issuer: ISSUER }],
    });
  });

  it("core 没起来：退出 69（容器入口据此重试）", async () => {
    const { io, err } = harness(fakeCore().core, {
      env: { [TOKEN_ENV]: TOKEN },
    });
    io.cloud.connect = async () => {
      throw new CloudCliError("host_unavailable", "连不上运行中的服务器壳");
    };
    expect(await main(["cloud", "register", "--issuer", ISSUER], io)).toBe(69);
    expect(err.join("")).toContain("连不上");
  });
});

describe("cloud login", () => {
  it("口令经标准输入：core 登录并钉扎，向中继要注册令牌，再登记；口令与令牌不出现在输出", async () => {
    const { core, calls } = fakeCore();
    const { io, out, err, relay } = harness(core, { stdin: `${PASSWORD}\n` });
    const code = await main(
      [
        "cloud",
        "login",
        "--issuer",
        ISSUER,
        "--account",
        "dev",
        "--fingerprint",
        FINGERPRINT,
        "--password-stdin",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(
      calls.find((call) => call.path === "/api/sources/remotes")?.body,
    ).toMatchObject({
      kind: "personal",
      issuer: ISSUER,
      account: "dev",
      password: PASSWORD,
      fingerprint: FINGERPRINT,
    });
    expect(relay).toHaveLength(1);
    expect(relay[0]).toMatchObject({
      method: "POST",
      url: `${ISSUER}/v1/sources/registration-tokens`,
      fingerprint: FINGERPRINT,
      headers: { authorization: `Bearer ${ACCESS}` },
    });
    expect(
      calls.find((call) => call.path === "/api/identity/cloud/register")?.body,
    ).toMatchObject({
      issuer: ISSUER,
      registrationToken: TOKEN,
    });
    const all = out.join("") + err.join("");
    for (const secret of [PASSWORD, TOKEN, ACCESS])
      expect(all).not.toContain(secret);
  });

  it("口令可来自环境变量或终端提示；都没有是用法错误", async () => {
    const env = harness(fakeCore().core, { env: { [PASSWORD_ENV]: PASSWORD } });
    expect(
      await main(
        ["cloud", "login", "--issuer", ISSUER, "--account", "dev"],
        env.io,
      ),
    ).toBe(0);
    const prompted = harness(fakeCore().core, { prompt: PASSWORD });
    expect(
      await main(
        ["cloud", "login", "--issuer", ISSUER, "--account", "dev"],
        prompted.io,
      ),
    ).toBe(0);
    const none = harness(fakeCore().core);
    expect(
      await main(
        ["cloud", "login", "--issuer", ISSUER, "--account", "dev"],
        none.io,
      ),
    ).toBe(2);
  });
});

describe("invite --cloud-link", () => {
  const base = [
    "invite",
    "--cloud-link",
    "--issuer",
    ISSUER,
    "--workspace",
    "w1",
  ];

  it("建邀请（maxUses、ttl）→ 中继出链接 → 打印 url#密.令牌", async () => {
    const { core, calls } = fakeCore({ registered: true });
    const { io, out, relay } = harness(core);
    expect(
      await main(
        [...base, "--role", "editor", "--max-uses", "5", "--expires", "7d"],
        io,
      ),
    ).toBe(0);
    expect(
      calls.find((call) => call.path === "/api/identity/invitations")?.body,
    ).toEqual({
      role: "editor",
      targetWorkspaceId: "w1",
      ttlMs: 604_800_000,
      maxUses: 5,
    });
    expect(relay[0]).toMatchObject({
      url: `${ISSUER}/v1/links`,
      body: {
        kind: "source_invite",
        sourceId: "h".repeat(32),
        invitationId: "i".repeat(32),
        role: "editor",
        maxUses: 5,
      },
    });
    expect(out.join("").trim()).toBe(
      `${ISSUER}/j/L1#sekret.${"i".repeat(32)}.secret`,
    );
  });

  it("没登记、参数不对都不建邀请；中继拒绝时撤掉刚建的邀请", async () => {
    const unregistered = fakeCore({ registered: false });
    const first = harness(unregistered.core);
    expect(await main(base, first.io)).toBe(1);
    expect(
      unregistered.calls.some(
        (call) => call.path === "/api/identity/invitations",
      ),
    ).toBe(false);

    const bad = fakeCore({ registered: true });
    const second = harness(bad.core);
    expect(
      await main(
        ["invite", "--issuer", ISSUER, "--workspace", "w1"],
        second.io,
      ),
    ).toBe(2);
    expect(await main([...base, "--group", "g1"], second.io)).toBe(2);
    expect(await main([...base, "--max-uses", "0"], second.io)).toBe(2);
    expect(await main([...base, "--expires", "soon"], second.io)).toBe(2);
    expect(bad.calls).toEqual([]);

    const refused = fakeCore({ registered: true });
    const third = harness(refused.core, {
      link: {
        status: 403,
        body: { code: "source_access_denied", message: "没有权限" },
      },
    });
    expect(await main(base, third.io)).toBe(1);
    expect(
      refused.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.path === `/api/identity/invitations/${"i".repeat(32)}`,
      ),
    ).toBe(true);
  });
});
