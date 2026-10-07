import { createECDH } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractEntries } from "@armadra/shared";
import { EventBus } from "../bus";
import { routeScope } from "../http/route-scopes";
import { installContract } from "../http/rpc";
import { CoreServer } from "../http/server";
import {
  type RequestIdentity,
  installRouteGuard,
  resetRouteGuard,
} from "../identity/gate";
import { createRouteGuard } from "../identity/route-access";
import { permits } from "../identity/scopes";
import { createLog, nodePlatform } from "../platform";
import { b64url } from "../push/crypto";
import { pushFixture } from "../push/fixture";
import { PUSH_ROUTES, installRoutes } from "../push/routes";
import { tempDir } from "../testing/temp-dir";
import {
  type Answer,
  type Kit,
  expectParity,
  startKit,
  text,
} from "./parity-kit";

/**
 * push 域的对偶测试（契约 §43.4；工程规范化包 §3 ④）。
 *
 * 同一份夹具问三次——路由表里原来那条 handler、旧 REST 路径（经 HTTP，由契约实现
 * 经 `OpenAPIHandler` 答）、新 procedure。成功的答案按 `canonicalJson` 逐字节
 * 相等；失败的码、状态与原话相等（procedure 多一个 `requestId`）。谁在问由名字
 * 决定：`owner` 与 `member` 是各带一台身份设备的主体，`other` 是另一个成员，`anon`
 * 是服务器壳上没有 principal 的匿名主体，`local` 是桌面壳的本机请求（没有请求身份）。
 *
 * 单独一节写**拒绝路径**：同一道路由门之下，推送域只碰请求主体自己的设备——
 * 成员改不了、撤不掉别人的设备（答与不存在一样的 404，设备原样在），匿名主体
 * 一律 401，本机请求登记不了；任何答案里都没有令牌与密钥。
 */

let kit: Kit;
let server: CoreServer;
let fixture: ReturnType<typeof pushFixture>;
let member: { principalId: string; deviceId: string };
let other: { principalId: string; deviceId: string };
let identities: Record<string, RequestIdentity | undefined>;

const VOLATILE = new Set(["createdAt"]);

beforeAll(async () => {
  fixture = pushFixture();
  member = fixture.member("成员");
  other = fixture.member("别人");
  const memberIdentity = (who: { principalId: string; deviceId: string }) => ({
    subject: {
      principalId: who.principalId,
      kind: "member" as const,
      scopes: [],
    },
    device: { deviceId: who.deviceId, deviceName: "x" },
  });
  identities = {
    owner: {
      subject: fixture.owner,
      device: { deviceId: fixture.ownerDeviceId, deviceName: "owner 的手机" },
    },
    member: memberIdentity(member),
    other: memberIdentity(other),
    anon: { subject: { principalId: "", kind: "member", scopes: [] } },
    local: undefined,
  };
  const platform = nodePlatform({
    dataDir: tempDir("armadra-parity-push-"),
    appVersion: "0.0.0-test",
    isPackaged: false,
    log: createLog("error"),
  });
  server = new CoreServer({
    platform,
    bus: new EventBus(),
    version: "0.0.0-test",
  });
  installRoutes(server, fixture.push);
  installContract(server, { validateOutput: true, platform });
  kit = await startKit(server, (name) => identities[name]);
  // 路由门是真的：推送在 `SELF_GUARDED` 里，门放行，判定在域里。
  installRouteGuard(
    createRouteGuard({
      database: fixture.database,
      permits: (who, required) => permits([...who.scopes], required),
      effectiveScopes: (who) => [...who.scopes],
    }),
  );
});

afterAll(async () => {
  resetRouteGuard();
  await server.close();
  fixture.close();
});

/** 一台浏览器订阅的登记体（`PushSubscription.toJSON()` 的样子，密钥是真的 P-256 点）。 */
function webRegistration(endpoint: string, extra: object = {}) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    platform: "web",
    transport: "webpush",
    locale: "en",
    subscription: {
      endpoint,
      keys: {
        p256dh: b64url(ecdh.getPublicKey()),
        auth: b64url(Buffer.alloc(16, 3)),
      },
    },
    ...extra,
  };
}

/** 三种答法（同一个主体）。 */
async function three(
  as: string,
  method: string,
  path: string,
  name: string,
  input: unknown,
  body: unknown = input,
): Promise<readonly [Answer, Answer, Answer]> {
  return [
    await kit.table(method, path, body, as),
    await kit.legacy(method, path, body, as),
    await kit.procedure(name, input, as),
  ];
}

const DEVICE = (id: string) => `/api/push/devices/${encodeURIComponent(id)}`;

describe("config / devices：读", () => {
  it("config：没配置时 Web Push 可用、原生 notConfigured，三种答法一样", async () => {
    for (const as of ["owner", "member", "local"]) {
      const answers = await three(
        as,
        "GET",
        PUSH_ROUTES.config,
        "push.config",
        undefined,
      );
      expect(answers[0].status).toBe(200);
      expect(answers[0].body).toMatchObject({
        native: { transport: "log", status: "notConfigured", platforms: [] },
        webpush: { enabled: true },
      });
      expectParity(answers);
    }
  });

  it("devices：只列自己名下的；桌面本机请求（没有主体）看的是没有归属的那份", async () => {
    // 先让成员登记一台，owner 与别人各看各的。
    const registered = await kit.procedure(
      "push.register",
      webRegistration("https://push.example/seen"),
      "member",
    );
    expect(registered.status).toBe(200);
    for (const as of ["owner", "member", "other", "local"]) {
      const answers = await three(
        as,
        "GET",
        PUSH_ROUTES.devices,
        "push.devices",
        undefined,
      );
      expect(answers[0].status, as).toBe(200);
      expectParity(answers, { volatile: VOLATILE });
    }
    const mine = (await kit.procedure("push.devices", undefined, "member"))
      .body as {
      devices: { deviceId: string; current: boolean }[];
    };
    expect(mine.devices).toHaveLength(1);
    expect(mine.devices[0]).toMatchObject({
      deviceId: member.deviceId,
      current: true,
    });
    const theirs = (await kit.procedure("push.devices", undefined, "other"))
      .body as {
      devices: unknown[];
    };
    expect(theirs.devices).toEqual([]);
  });
});

describe("register：登记", () => {
  it("web push：登记的永远是这次请求背后的那台设备，三种答法一样，答案里没有订阅与密钥", async () => {
    const body = webRegistration("https://push.example/register-ok");
    for (const as of ["owner", "member"]) {
      const answers = await three(
        as,
        "PUT",
        PUSH_ROUTES.devices,
        "push.register",
        body,
      );
      expect(answers[0].status, as).toBe(200);
      expectParity(answers, { volatile: VOLATILE });
      const wire = text(answers[2]);
      expect(wire).not.toContain("push.example");
      expect(wire).not.toContain(body.subscription.keys.p256dh);
      expect(wire).not.toContain(body.subscription.keys.auth);
      expect(answers[2].body).toMatchObject({
        device: { platform: "web", transport: "webpush", encrypted: true },
      });
    }
  });

  it("拒绝：本机请求没有设备 409、匿名 401、坏体 400，码与原话三处一样", async () => {
    const body = webRegistration("https://push.example/refused");
    const cases: readonly [string, unknown][] = [
      ["local", body],
      ["anon", body],
      ["member", { platform: "ios", transport: "webpush" }],
      ["member", { platform: "web", transport: "direct", token: "x" }],
      ["member", { platform: "ios", transport: "relay", token: "x" }],
    ];
    const statuses: number[] = [];
    for (const [as, input] of cases) {
      const answers = await three(
        as,
        "PUT",
        PUSH_ROUTES.devices,
        "push.register",
        input,
      );
      expect(answers[0].status, JSON.stringify(input)).toBeGreaterThanOrEqual(
        400,
      );
      expectParity(answers);
      statuses.push(answers[0].status);
    }
    expect(statuses).toEqual([409, 401, 400, 400, 400]);
  });

  it("被撤销的设备再登记：403", async () => {
    const stray = fixture.member("撤过的");
    identities.stray = {
      subject: { principalId: stray.principalId, kind: "member", scopes: [] },
      device: { deviceId: stray.deviceId, deviceName: "x" },
    };
    fixture.database
      .prepare(
        "UPDATE identity_devices SET revoked_at_ms = 1 WHERE device_id = ?",
      )
      .run(stray.deviceId);
    const answers = await three(
      "stray",
      "PUT",
      PUSH_ROUTES.devices,
      "push.register",
      webRegistration("https://push.example/revoked"),
    );
    expect(answers[0].status).toBe(403);
    expectParity(answers);
  });
});

describe("setKinds / revoke / test", () => {
  it("setKinds：自己的设备改得了，全选回到全部；不认识的种类 400；缺 kinds 400", async () => {
    const id = member.deviceId;
    const cases: readonly [unknown, number][] = [
      [{ kinds: ["approval", "agentDone"] }, 200],
      [{ kinds: ["approval", "nonsense"] }, 400],
      [{}, 400],
      [
        {
          kinds: [
            "approval",
            "agentDone",
            "agentError",
            "deliveryFailed",
            "schedule",
            "resources",
            "comment",
            "workflowGate",
          ],
        },
        200,
      ],
    ];
    for (const [body, status] of cases) {
      const answers = await three(
        "member",
        "PATCH",
        DEVICE(id),
        "push.setKinds",
        { deviceId: id, ...(body as object) },
        body,
      );
      expect(answers[0].status, JSON.stringify(body)).toBe(status);
      expectParity(answers, { volatile: VOLATILE });
    }
  });

  it("setKinds：别人的设备、不存在的设备、owner 改别人的都是同一句 404，设备的偏好没动", async () => {
    const before = text(
      await kit.procedure("push.devices", undefined, "member"),
      VOLATILE,
    );
    for (const [as, id] of [
      ["other", member.deviceId],
      ["owner", member.deviceId],
      ["member", "no-such-device"],
    ] as const) {
      const answers = await three(
        as,
        "PATCH",
        DEVICE(id),
        "push.setKinds",
        { deviceId: id, kinds: ["approval"] },
        { kinds: ["approval"] },
      );
      expect(answers[0].status, `${as} ${id}`).toBe(404);
      expectParity(answers);
    }
    expect(
      text(await kit.procedure("push.devices", undefined, "member"), VOLATILE),
    ).toBe(before);
  });

  it("test：登记过的设备排上一条测试通知（旧路径 202，procedure 200）；本机与没登记的 409", async () => {
    await kit.procedure(
      "push.register",
      webRegistration("https://push.example/test"),
      "owner",
    );
    const answers = await three(
      "owner",
      "POST",
      PUSH_ROUTES.test,
      "push.test",
      undefined,
    );
    expect(answers[0].status).toBe(202);
    expectParity(answers, { volatile: new Set(["id"]), legacyStatus: 202 });
    expect(answers[2].body).toMatchObject({ queued: true });
    for (const as of ["local", "other"]) {
      const refused = await three(
        as,
        "POST",
        PUSH_ROUTES.test,
        "push.test",
        undefined,
      );
      expect(refused[0].status, as).toBe(409);
      expectParity(refused);
    }
  });

  it("revoke：成员只撤得掉自己的，owner 撤得掉任何一台；别人的与不存在的同一句 404，设备还在", async () => {
    const victim = fixture.member("被撤的");
    identities.victim = {
      subject: { principalId: victim.principalId, kind: "member", scopes: [] },
      device: { deviceId: victim.deviceId, deviceName: "x" },
    };
    const register = () =>
      kit.procedure(
        "push.register",
        webRegistration(`https://push.example/${Math.random()}`),
        "victim",
      );
    expect((await register()).status).toBe(200);
    const alive = async () =>
      (
        (await kit.procedure("push.devices", undefined, "victim")).body as {
          devices: unknown[];
        }
      ).devices.length;

    // 别人撤不掉，也探测不出它在不在。
    for (const as of ["other", "anon"]) {
      const answers = await three(
        as,
        "DELETE",
        DEVICE(victim.deviceId),
        "push.revoke",
        { deviceId: victim.deviceId },
        undefined,
      );
      expect(answers[0].status, as).toBeGreaterThanOrEqual(401);
      expectParity(answers);
    }
    const missing = await three(
      "other",
      "DELETE",
      DEVICE("no-such-device"),
      "push.revoke",
      { deviceId: "no-such-device" },
      undefined,
    );
    expect(missing[0].status).toBe(404);
    expect(text(missing[0])).toBe(
      text(
        await kit.table("DELETE", DEVICE(victim.deviceId), undefined, "other"),
      ),
    );
    expect(await alive()).toBe(1);

    // 自己撤得掉；owner 撤得掉别人的。每种答法各撤一次（撤过就是 `false`，所以
    // 每次先重新登记）。
    for (const as of ["victim", "owner"]) {
      const path = DEVICE(victim.deviceId);
      const ways = [
        () => kit.table("DELETE", path, undefined, as),
        () => kit.legacy("DELETE", path, undefined, as),
        () => kit.procedure("push.revoke", { deviceId: victim.deviceId }, as),
      ];
      for (const way of ways) {
        expect((await register()).status).toBe(200);
        const answer = await way();
        expect(answer.status, as).toBe(200);
        expect(answer.body, as).toEqual({ revoked: true });
      }
    }
    expect(await alive()).toBe(0);
  });
});

describe("拒绝路径：路由门放行，判定在域里", () => {
  it("匿名主体读什么都是 401，且什么都没写", async () => {
    const before = fixture.database
      .prepare("SELECT count(*) AS n FROM push_devices")
      .get() as { n: number };
    for (const [method, path, name, input] of [
      ["GET", PUSH_ROUTES.devices, "push.devices", undefined],
      [
        "PUT",
        PUSH_ROUTES.devices,
        "push.register",
        webRegistration("https://push.example/anon"),
      ],
      ["POST", PUSH_ROUTES.test, "push.test", undefined],
    ] as const) {
      const answers = await three("anon", method, path, name, input);
      expect(answers[0].status, name).toBe(401);
      expectParity(answers);
    }
    const after = fixture.database
      .prepare("SELECT count(*) AS n FROM push_devices")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("没有任何令牌与密钥出现在 devices 的答案里", async () => {
    await kit.procedure(
      "push.register",
      {
        platform: "android",
        transport: "relay",
        token: "SECRET-RELAY-TOKEN-0001",
        publicKey: b64url(Buffer.alloc(32, 7)),
        unifiedpush: { endpoint: "https://ntfy.example/secret-topic" },
      },
      "member",
    );
    const wire = text(await kit.procedure("push.devices", undefined, "member"));
    for (const secret of [
      "SECRET-RELAY-TOKEN-0001",
      "secret-topic",
      b64url(Buffer.alloc(32, 7)),
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain('"unifiedpush":true');
  });
});

describe("入参形状错：procedure 与旧路径由契约先答 bad_request", () => {
  it("类型不对：码与状态一致，procedure 带 issues", async () => {
    const id = member.deviceId;
    const cases: readonly [string, string, unknown, string, unknown][] = [
      [
        "PATCH",
        DEVICE(id),
        { kinds: "approval" },
        "push.setKinds",
        { deviceId: id, kinds: "approval" },
      ],
      ["PUT", PUSH_ROUTES.devices, ["x"], "push.register", ["x"]],
    ];
    for (const [method, path, body, name, input] of cases) {
      const rest = await kit.legacy(method, path, body, "member");
      const rpc = await kit.procedure(name, input, "member");
      for (const answer of [rest, rpc]) {
        expect(answer.status, name).toBe(400);
        expect(answer.body, name).toMatchObject({ code: "bad_request" });
      }
      const detail = (rpc.body as { details?: { issues?: unknown[] } }).details;
      expect(detail?.issues?.length, name).toBeGreaterThan(0);
    }
  });
});

describe("契约与 core 的两张表（push）", () => {
  const entries = contractEntries().filter((entry) =>
    entry.name.startsWith("push."),
  );

  it("6 条都在契约里，每条都有旧路径", () => {
    expect(entries.map((entry) => entry.name).sort()).toEqual(
      ["config", "devices", "register", "revoke", "setKinds", "test"].map(
        (name) => `push.${name}`,
      ),
    );
    for (const entry of entries) {
      expect(entry.meta.legacy, entry.name).toBeDefined();
    }
  });

  it("meta.scope 与路由表给旧路径的要求一致；旧路径都在路由表里并有人认领", () => {
    for (const entry of entries) {
      const legacyRoute = entry.meta.legacy!;
      expect(
        routeScope(legacyRoute.method, legacyRoute.path)?.permission ?? null,
        entry.name,
      ).toBe(entry.meta.scope);
      const found = server.router.match(legacyRoute.path);
      expect(found?.entry.methods ?? []).toContain(legacyRoute.method);
      expect(
        server.router.claimed(legacyRoute.method, found?.entry.path as string),
        entry.name,
      ).toBe(true);
    }
  });
});
