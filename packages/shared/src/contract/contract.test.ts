import { getEventIteratorSchemaDetails } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ERROR_CODES, errors, isRegisteredErrorCode } from "./errors.js";
import { contract, contractEntries } from "./index.js";
import { SCOPES } from "./meta.js";

/**
 * 契约树的守卫（工程规范化包 §1.2）：路径唯一、节号不跨域、错误码都在注册表、
 * 每条都声明了 scope、出参没有 `z.unknown()` / `z.any()`。
 */

const entries = contractEntries();

type Def = {
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  errorMap: Record<string, { status?: number }>;
};
const def = (entry: (typeof entries)[number]) =>
  (entry.procedure as unknown as { "~orpc": Def })["~orpc"];

/** 走一遍 schema，找 `unknown` / `any`（懒的展开一次，免得自引用转圈）。 */
function loose(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const inner = schema as unknown as {
    def: { type: string } & Record<string, unknown>;
  };
  const kind = inner.def.type;
  if (kind === "unknown" || kind === "any") return [kind];
  const children: z.ZodType[] = [];
  const d = inner.def;
  const push = (value: unknown) => {
    if (value && typeof value === "object" && "def" in value) {
      children.push(value as z.ZodType);
    }
  };
  if (kind === "object") {
    for (const value of Object.values(
      (d.shape as Record<string, unknown>) ?? {},
    ))
      push(value);
    push(d.catchall);
  }
  if (kind === "lazy") push((d.getter as () => unknown)());
  if (kind === "array") push(d.element);
  if (kind === "record") {
    push(d.keyType);
    push(d.valueType);
  }
  if (kind === "union")
    for (const option of d.options as unknown[]) push(option);
  for (const key of ["innerType", "in", "out", "schema"]) push(d[key]);
  return children.flatMap((child) => loose(child, seen));
}

describe("契约树", () => {
  it("不是空的，名字与路径一致", () => {
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      expect(entry.name).toBe(entry.path.join("."));
    }
    expect(Object.keys(contract)).toEqual([
      "system",
      "workspaces",
      "settings",
      "sources",
      "identity",
      "files",
      "terminals",
      "boards",
      "git",
      "agents",
      "forge",
      "github",
      "gitRepository",
      "security",
      "accounts",
      "acp",
      "workflows",
      "coordinator",
      "push",
      "mail",
      "credentials",
      "gateway",
      "diagnostics",
    ]);
  });

  it("procedure 名唯一，旧路径（方法 + 模式）也唯一", () => {
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    const legacy = entries.flatMap((entry) =>
      entry.meta.legacy
        ? [`${entry.meta.legacy.method} ${entry.meta.legacy.path}`]
        : [],
    );
    expect(new Set(legacy).size).toBe(legacy.length);
  });

  it("每条都写全了元数据：scope、since、契约节号", () => {
    for (const entry of entries) {
      expect(entry.meta.scope, entry.name).not.toBeUndefined();
      if (entry.meta.scope !== null) {
        expect(SCOPES, entry.name).toContain(entry.meta.scope);
      }
      expect(entry.meta.since, entry.name).toMatch(/^\d+\.\d+$/);
      // §31–§33 预分配给平台设计（云登录、隧道、源表），§34 起是工程规范化各域。
      expect(entry.meta.contract, entry.name).toMatch(
        /^§(3[1-9]|[4-9]\d)\.\d+$/,
      );
    }
  });

  it("一个契约节号只属于一个域", () => {
    const owner = new Map<string, string>();
    for (const entry of entries) {
      const section = entry.meta.contract as string;
      const domain = entry.path[0] as string;
      expect(owner.get(section) ?? domain, `${section} 被两个域共用`).toBe(
        domain,
      );
      owner.set(section, domain);
    }
  });

  it("匿名的只能经旧路径，且只在身份面、健康检查或配对短码换票下", () => {
    for (const entry of entries) {
      if (entry.meta.scope !== null) continue;
      expect(entry.meta.legacy, entry.name).toBeDefined();
      expect(entry.meta.legacy?.path, entry.name).toMatch(
        /^\/api\/identity\/|^\/(api\/)?health$|^\/api\/gateway\/pairing-code\/exchange$/,
      );
    }
  });

  it("工作空间键是入参里真有的字段", () => {
    for (const entry of entries) {
      const key = entry.meta.workspaceKey;
      if (key === undefined) continue;
      const input = def(entry).inputSchema as z.ZodObject;
      expect(Object.keys(input.shape), entry.name).toContain(key);
    }
  });

  it("旧路径的 {参数} 都是入参里的字段", () => {
    for (const entry of entries) {
      const legacy = entry.meta.legacy;
      if (legacy === undefined) continue;
      const params = [...legacy.path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1] as string,
      );
      if (params.length === 0) continue;
      const input = def(entry).inputSchema as z.ZodObject;
      for (const param of params) {
        expect(Object.keys(input.shape), entry.name).toContain(param);
      }
    }
  });

  it("声明的错误码都在注册表里，状态一致", () => {
    for (const entry of entries) {
      for (const [code, item] of Object.entries(def(entry).errorMap)) {
        expect(isRegisteredErrorCode(code), `${entry.name}: ${code}`).toBe(
          true,
        );
        if (isRegisteredErrorCode(code)) {
          expect(item.status, `${entry.name}: ${code}`).toBe(
            ERROR_CODES[code].status,
          );
        }
      }
    }
  });

  it("出参没有 unknown / any", () => {
    for (const entry of entries) {
      const output = def(entry).outputSchema;
      expect(output, entry.name).toBeDefined();
      const yields = getEventIteratorSchemaDetails(output as never)?.yields;
      const found = loose((yields ?? output) as z.ZodType);
      // 事件流的每一项就是页面那份 `workspaceEventSchema`。`agent.approval` 的
      // `request` 已收紧成审批行（原话按 JSON 透传）；剩下的是 ACP 帧里工具调用的
      // `rawInput` / `rawOutput`——适配器给的原样载荷，形状由各家 Agent 定。只许
      // 减少，不许增加。
      const allowed = LOOSE_ALLOWANCE[entry.name] ?? 0;
      expect(found.length, entry.name).toBeLessThanOrEqual(allowed);
    }
  });

  it("订阅（出参是事件迭代器）写了背压策略，普通调用不写", () => {
    for (const entry of entries) {
      const subscription =
        getEventIteratorSchemaDetails(def(entry).outputSchema as never) !==
        undefined;
      expect(entry.meta.backpressure !== undefined, entry.name).toBe(
        subscription,
      );
      // 订阅只经控制面，没有 REST 旧路径可挂。
      if (subscription) expect(entry.meta.legacy, entry.name).toBeUndefined();
    }
  });
});

const LOOSE_ALLOWANCE: Readonly<Record<string, number>> = {
  "workspaces.events": 2,
};

describe("守卫自己真的抓得到", () => {
  it("unknown 藏在对象、数组、可选里也找得到", () => {
    expect(loose(z.object({ a: z.array(z.unknown().optional()) }))).toEqual([
      "unknown",
    ]);
    expect(loose(z.record(z.string(), z.any()))).toEqual(["any"]);
    expect(loose(z.object({ a: z.string() }))).toEqual([]);
  });

  it("errors.pick 的状态来自注册表", () => {
    expect(errors.pick("conflict", "not_found")).toEqual({
      conflict: { status: 409 },
      not_found: { status: 404 },
    });
  });
});

describe("§33 与协议包同一份", () => {
  it("sources.* 的出入参就是协议包 core-api 的 schema 对象", async () => {
    const protocol = await import("@armadra/platform-protocol/core-api");
    const pairs: [string, "inputSchema" | "outputSchema", unknown][] = [
      [
        "sources.addDirect",
        "inputSchema",
        protocol.sourcesAddDirectInputSchema,
      ],
      ["sources.update", "inputSchema", protocol.sourcesUpdateInputSchema],
      ["sources.session", "outputSchema", protocol.sourcesSessionOutputSchema],
      ["sources.remoteAdd", "inputSchema", protocol.remoteAddInputSchema],
      [
        "sources.remoteSources",
        "outputSchema",
        protocol.remoteSourcesOutputSchema,
      ],
      ["sources.mount", "inputSchema", protocol.mountInputSchema],
      [
        "sources.remoteSession",
        "outputSchema",
        protocol.remoteSessionOutputSchema,
      ],
    ];
    for (const [name, slot, schema] of pairs) {
      const entry = entries.find((one) => one.name === name);
      expect(entry, name).toBeDefined();
      expect(def(entry!)[slot], `${name} ${slot}`).toBe(schema);
    }
  });
});

describe("§55 在协议包的形状上追加", () => {
  // 协议包（cloud 仓，0.3.1）还没有 `routes` 与 `defaultLabel`（§61）：这几个
  // schema 是它的 `extend`，协议包的每个字段逐个沿用同一个对象，只多这两节的字段。
  it("源表行、列表与 session 入参是协议包形状的超集", async () => {
    const protocol = await import("@armadra/platform-protocol/core-api");
    type Shaped = { shape: Record<string, unknown> };
    const superset = (ours: unknown, theirs: unknown, extra: string[]) => {
      const mine = (ours as Shaped).shape;
      const base = (theirs as Shaped).shape;
      for (const key of Object.keys(base)) {
        // 嵌套的行另外比（它们本身是超集）。
        if (key === "sources" || key === "remotes" || key === "remote")
          continue;
        expect(mine[key], key).toBe(base[key]);
      }
      expect(Object.keys(mine).filter((key) => !(key in base))).toEqual(extra);
    };
    const slot = (name: string, which: "inputSchema" | "outputSchema") =>
      def(entries.find((one) => one.name === name)!)[which];
    superset(
      slot("sources.addDirect", "outputSchema"),
      protocol.clientSourceSchema,
      ["routes", "defaultLabel"],
    );
    superset(
      slot("sources.mount", "outputSchema"),
      protocol.clientSourceSchema,
      ["routes", "defaultLabel"],
    );
    superset(
      slot("sources.remoteUpdate", "outputSchema"),
      protocol.remoteServiceSchema,
      ["defaultLabel"],
    );
    superset(
      slot("sources.remoteAdd", "outputSchema"),
      protocol.remoteAddOutputSchema,
      [],
    );
    superset(
      slot("sources.list", "outputSchema"),
      protocol.sourcesListOutputSchema,
      [],
    );
    superset(
      slot("sources.session", "inputSchema"),
      protocol.sourcesSessionInputSchema,
      ["route"],
    );
  });
});

describe("§31 与协议包同一份", () => {
  it("identity.cloud.* 的出入参就是协议包 core-api 的 schema 对象", async () => {
    const protocol = await import("@armadra/platform-protocol/core-api");
    const pairs: [string, "inputSchema" | "outputSchema", unknown][] = [
      ["identity.cloud.login", "inputSchema", protocol.cloudLoginInputSchema],
      ["identity.cloud.login", "outputSchema", protocol.cloudLoginOutputSchema],
      [
        "identity.cloud.register",
        "inputSchema",
        protocol.cloudRegisterInputSchema,
      ],
      [
        "identity.cloud.register",
        "outputSchema",
        protocol.cloudRegisterOutputSchema,
      ],
      ["identity.cloud.revoke", "inputSchema", protocol.cloudRevokeInputSchema],
      [
        "identity.cloud.status",
        "outputSchema",
        protocol.cloudStatusOutputSchema,
      ],
      ["identity.cloud.bind", "inputSchema", protocol.cloudBindInputSchema],
      [
        "identity.cloud.trustedOrigins",
        "inputSchema",
        protocol.cloudTrustedOriginsInputSchema,
      ],
    ];
    for (const [name, slot, schema] of pairs) {
      const entry = entries.find((one) => one.name === name);
      expect(entry, name).toBeDefined();
      expect(def(entry!)[slot], `${name} ${slot}`).toBe(schema);
    }
  });

  it("匿名 procedure 只有 login 与配对短码换票，且都只经旧路径", () => {
    const anonymous = entries.filter((entry) => entry.meta.scope === null);
    expect(anonymous.map((entry) => entry.name)).toEqual([
      "identity.cloud.login",
      "gateway.exchangePairingCode",
    ]);
    expect(anonymous.map((entry) => entry.meta.legacy?.path)).toEqual([
      "/api/identity/cloud/login",
      "/api/gateway/pairing-code/exchange",
    ]);
  });

  const CORE_LOCAL_CODES = new Set([
    "address_invalid",
    "address_https_only",
    "address_plaintext_loopback_only",
    "address_has_credentials",
    "fingerprint_invalid",
  ]);

  it("§31 的错误码与协议包注册表同拼法、同状态", async () => {
    const { ERRORS } = (await import(
      "@armadra/platform-protocol/errors"
    )) as unknown as { ERRORS: Record<string, { status: number }> };
    for (const entry of entries.filter((one) =>
      one.name.startsWith("identity.cloud."),
    )) {
      for (const [code, item] of Object.entries(def(entry).errorMap)) {
        // 地址与指纹格式的校验在 core 本地就答（§33.8），不经中继、不进协议包。
        if (CORE_LOCAL_CODES.has(code)) continue;
        expect(ERRORS[code]?.status, `${entry.name}: ${code}`).toBe(
          item.status,
        );
      }
    }
  });
});

describe("§42 身份三域", () => {
  const identityDomains = entries.filter(
    (entry) =>
      (entry.path[0] === "identity" && entry.path[1] !== "cloud") ||
      entry.path[0] === "security" ||
      entry.path[0] === "accounts",
  );

  it("都要会话、都挂在 /api/identity/ 的旧路径上，节号是 §42.1–§42.3", () => {
    expect(identityDomains.length).toBeGreaterThan(40);
    for (const entry of identityDomains) {
      expect(entry.meta.scope, entry.name).not.toBeNull();
      expect(entry.meta.legacy?.path, entry.name).toMatch(/^\/api\/identity\//);
      expect(entry.meta.contract, entry.name).toMatch(/^§42\.[123]$/);
      expect(entry.meta.since, entry.name).toBe("1.13");
    }
  });

  it("凭据换会话的那几条留在 REST 匿名面，不在契约里", () => {
    const legacy = new Set(
      entries.flatMap((entry) =>
        entry.meta.legacy === undefined
          ? []
          : [`${entry.meta.legacy.method} ${entry.meta.legacy.path}`],
      ),
    );
    for (const route of [
      "GET /api/identity/hello",
      "POST /api/identity/pair",
      "POST /api/identity/ws-ticket",
      "POST /api/identity/session/refresh",
      "POST /api/identity/session/csrf",
      "POST /api/identity/session/logout",
      "POST /api/identity/login",
      "POST /api/identity/register",
      "POST /api/identity/mfa/verify",
      "POST /api/identity/passkey/login/options",
      "POST /api/identity/passkey/login/verify",
      "POST /api/identity/oauth/{providerId}/start",
      "GET /api/identity/oauth/{providerId}/callback",
      "GET /api/identity/password-reset/{token}",
      "POST /api/identity/password-reset/{token}",
      "GET /api/identity/audit/export",
    ]) {
      expect(legacy.has(route), route).toBe(false);
    }
  });

  it("口令、密钥与令牌只在入参里，出参里只有签发那一次的明文", () => {
    const secretInputs = new Map([
      ["accounts.credentials.setPassword", "password"],
      ["security.oauth.setSecret", "clientSecret"],
      ["accounts.invitations.accept", "token"],
    ]);
    for (const [name, field] of secretInputs) {
      const entry = entries.find((one) => one.name === name);
      const input = def(entry!).inputSchema as z.ZodObject;
      const output = def(entry!).outputSchema as z.ZodObject;
      expect(Object.keys(input.shape), name).toContain(field);
      expect(Object.keys(output.shape), name).not.toContain(field);
    }
  });
});
