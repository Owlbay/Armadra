import type {
  ContractProcedure,
  ContractRouterClient,
  InferSchemaInput,
  InferSchemaOutput,
} from "@orpc/contract";

import type { ProcedureMeta } from "./meta.js";
import { settings } from "./settings.js";
import { sources } from "./sources.js";
import { system } from "./system.js";
import { workspaces } from "./workspaces.js";

/**
 * 契约树（工程规范化 §2.3.1）：`contract.<域>.<动词>`。
 *
 * 这是 `@orpc/contract` 只许出现的那一处（加上 core 与页面各一个门面，§2.2.2）；
 * 业务侧拿到的是这里导出的值与类型，不直接碰上游。新域按契约 §34 起的预分配
 * 逐个加进来（工程规范化包 §0）。
 */
export const contract = { system, workspaces, settings, sources };

export type Contract = typeof contract;
export type ContractDomain = keyof Contract;

/** 页面拿到的客户端：`client.workspaces.list()` 这样调。 */
export type ContractClient = ContractRouterClient<Contract>;

/** 实现一侧收到的入参：入参 schema 解析之后的样子。 */
export type ProcedureInput<P> =
  P extends ContractProcedure<infer I, infer _O, infer _E, infer _M>
    ? InferSchemaOutput<I>
    : never;

/** 实现一侧要交出的出参：出参 schema 解析之前的样子。 */
export type ProcedureResult<P> =
  P extends ContractProcedure<infer _I, infer O, infer _E, infer _M>
    ? InferSchemaInput<O>
    : never;

/** 契约里的一条 procedure，连同它的路径与元数据。 */
export interface ContractEntry {
  /** `["workspaces", "list"]`。 */
  readonly path: readonly string[];
  /** `workspaces.list`。 */
  readonly name: string;
  readonly meta: Partial<ProcedureMeta>;
  readonly procedure: ContractProcedure<never, never, never, never>;
}

function isProcedure(
  value: unknown,
): value is ContractProcedure<never, never, never, never> {
  return (
    typeof value === "object" &&
    value !== null &&
    "~orpc" in value &&
    typeof (value as { "~orpc": unknown })["~orpc"] === "object"
  );
}

/** 按声明顺序列出契约里的每一条 procedure。 */
export function contractEntries(
  tree: Record<string, unknown> = contract,
  prefix: readonly string[] = [],
): ContractEntry[] {
  const found: ContractEntry[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = [...prefix, key];
    if (isProcedure(value)) {
      const def = value["~orpc"] as { meta?: Partial<ProcedureMeta> };
      found.push({
        path,
        name: path.join("."),
        meta: def.meta ?? {},
        procedure: value,
      });
    } else if (typeof value === "object" && value !== null) {
      found.push(...contractEntries(value as Record<string, unknown>, path));
    }
  }
  return found;
}

export { errors, errorStatus, isDefinedCode } from "./errors.js";
export type { DeclaredError } from "./errors.js";
export { jsonObjectSchema, jsonValueSchema } from "./json.js";
export type { JsonValue } from "./json.js";
export { SCOPES, meta } from "./meta.js";
export type { LegacyRoute, ProcedureMeta, Scope } from "./meta.js";
export { systemHelloOutputSchema } from "./system.js";
export type { SystemHello } from "./system.js";
export {
  clientSourceSchema,
  remoteAddInputSchema,
  remoteServiceSchema,
  remoteSourceSummarySchema,
  sourceSessionSchema,
} from "./sources.js";
export type {
  ClientSource,
  RemoteAddInput,
  RemoteService,
  RemoteSourceSummary,
  SourceSession,
} from "./sources.js";
export {
  workspaceSummaryWireSchema,
  workspaceWireSchema,
} from "./workspaces.js";
