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

  it("匿名的只能经旧路径，且只在身份面或健康检查下", () => {
    for (const entry of entries) {
      if (entry.meta.scope !== null) continue;
      expect(entry.meta.legacy, entry.name).toBeDefined();
      expect(entry.meta.legacy?.path, entry.name).toMatch(
        /^\/api\/identity\/|^\/(api\/)?health$/,
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
      // 事件流的每一项就是页面那份 `workspaceEventSchema`，它有三处透传的
      // `unknown`（`agent.approval` 的 `request`、ACP 帧的 `update` 与 `error`
      // 的附加字段）。只许减少，不许增加；收紧在 E3 对应域迁移时做。
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
  "workspaces.events": 3,
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
      ["sources.list", "outputSchema", protocol.sourcesListOutputSchema],
      [
        "sources.addDirect",
        "inputSchema",
        protocol.sourcesAddDirectInputSchema,
      ],
      ["sources.addDirect", "outputSchema", protocol.clientSourceSchema],
      ["sources.update", "inputSchema", protocol.sourcesUpdateInputSchema],
      ["sources.session", "inputSchema", protocol.sourcesSessionInputSchema],
      ["sources.session", "outputSchema", protocol.sourcesSessionOutputSchema],
      ["sources.remoteAdd", "inputSchema", protocol.remoteAddInputSchema],
      ["sources.remoteAdd", "outputSchema", protocol.remoteAddOutputSchema],
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

  it("login 是唯一的匿名 procedure，且只经旧路径", () => {
    const anonymous = entries.filter((entry) => entry.meta.scope === null);
    expect(anonymous.map((entry) => entry.name)).toEqual([
      "identity.cloud.login",
    ]);
    expect(anonymous[0]?.meta.legacy?.path).toBe("/api/identity/cloud/login");
  });

  it("§31 的错误码与协议包注册表同拼法、同状态", async () => {
    const { ERRORS } = (await import(
      "@armadra/platform-protocol/errors"
    )) as unknown as { ERRORS: Record<string, { status: number }> };
    for (const entry of entries.filter((one) =>
      one.name.startsWith("identity.cloud."),
    )) {
      for (const [code, item] of Object.entries(def(entry).errorMap)) {
        expect(ERRORS[code]?.status, `${entry.name}: ${code}`).toBe(
          item.status,
        );
      }
    }
  });
});
