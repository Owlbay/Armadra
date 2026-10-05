import { oc as upstream } from "@orpc/contract";

/**
 * 每条 procedure 自己说清楚的那几件事（工程规范化 §2.3.1）。
 *
 * 上游 1.x 的写法是 `oc.$meta<T>()`；2.x 改叫 `defineMeta`。契约文件只见
 * {@link oc} 与 {@link meta}，换写法时只动这一个文件。
 */

/**
 * 授权词汇表：与 core 的 `identity/scopes.ts` 的 `PERMISSIONS` 同一份（core 那边
 * 有一条用例逐项对着看）。`route-scopes.ts` 给每条 REST 路由写的就是这些名字。
 */
export const SCOPES = [
  "canvas:read",
  "canvas:write",
  "terminal:read",
  "terminal:write",
  "terminal:create",
  "terminal:drive",
  "agent:launch",
  "approval:answer",
  "events:read",
  "assets:read",
  "assets:write",
  "mermaid:import",
  "workspace:share",
  "files:read",
  "files:write",
  "git:read",
  "git:write",
  "github:read",
  "github:write",
  "browser:read",
  "browser:control",
  "automation:read",
  "automation:manage",
  "credential:use",
  "resources:read",
  "settings:read",
  "settings:write",
  "updates:read",
  "identity:read",
  "identity:manage",
] as const;

export type Scope = (typeof SCOPES)[number];

/** 迁移期的旧 REST 路径：门面把它挂到同一份实现上（§2.4）。 */
export interface LegacyRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** 路由表里那条带 `{param}` 的模式；参数名就是 input 的字段名。 */
  readonly path: string;
  /** 旧路径成功时答的状态；缺省 200（删除答 204）。 */
  readonly successStatus?: number;
}

export interface ProcedureMeta {
  /** 要求的权限；`null` = 匿名（只许经 legacy 路径，且在 `/api/identity/` 或 `/health` 下）。 */
  readonly scope: Scope | null;
  /** input 里哪个字段是工作空间标识；有它时授权绑在那个工作空间上。 */
  readonly workspaceKey?: string;
  /** 首次出现的协议版本（`major.minor`）。 */
  readonly since: string;
  /** 契约文档里的节号，`§N.M`；生成器按它把表写进对应的标记块。 */
  readonly contract: `§${number}.${number}`;
  readonly legacy?: LegacyRoute;
  /** 标了就是要删：值是标记时的版本，下一个 minor 删（§2.3.3）。 */
  readonly deprecated?: string;
  /** 记这条的耗时日志（`ARMADRA_RPC_TRACE=1` 时全开）。 */
  readonly trace?: boolean;
}

/** 契约文件用的构造器：带好了元数据的类型。 */
export const oc = upstream.$meta<Partial<ProcedureMeta>>({});

/** 一条 procedure 的元数据；类型上要求写全。 */
export function meta(value: ProcedureMeta): ProcedureMeta {
  return value;
}
