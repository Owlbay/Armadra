import { eventIterator } from "@orpc/contract";
import { z } from "zod";

import { errors } from "./errors.js";
import { jsonObjectSchema, jsonValueSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `boards.*`（契约 §36）：画布列表、文档的读与存、在线设备与编辑租约、实时
 * 状态，以及控制面上的在线订阅 `boards.presence`。
 *
 * 形状写线上的样子而不是页面解析后的样子：core 把每个字段都写全（节点的
 * `labels` / `note`、连线的 `kind`），所以出参没有缺省值，校验校的是 core 真发
 * 出去的那份；页面的 `boardDocumentSchema` 再按自己的口径解析一遍。标识与时刻
 * 只校是字符串，格式是页面解析时的事——出参校验不该因为一行旧数据把整份
 * 文档答成 500。
 *
 * 入参只校形状。名字长度、视口、节点与连线的语义检查、`clientId` 的字符集、
 * 保存里已退役的 `kanban` 字段仍在域里，旧路径与 procedure 走同一个实现，拒绝
 * 的码一样；保存的入参因此是「已知字段 + 透传」，`kanban` 要走到域里被拒。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：心跳与离开只要
 * `canvas:read`（只读的客户端也要让别人看见自己），拿租约与其余写是
 * `canvas:write`。
 */

const boardRef = z.object({
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
});

export const boardWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }),
  /** 不透明的白板快照（JSON 字符串）；空串是还没有白板内容。 */
  whiteboard: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const boardNodeWireSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  type: z.string(),
  title: z.string(),
  color: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  size: z.object({ width: z.number(), height: z.number() }).optional(),
  collapsed: z.boolean().optional(),
  expandedHeight: z.number().optional(),
  parentId: z.string().optional(),
  labels: z.array(z.string()),
  note: z.string(),
  /** 节点自己的数据，按 `type` 各有各的形状（页面解析）；core 不看里面。 */
  data: jsonValueSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const boardEdgeWireSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.string(),
  role: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const boardDocumentWireSchema = z.object({
  board: boardWireSchema,
  nodes: z.array(boardNodeWireSchema),
  edges: z.array(boardEdgeWireSchema),
});

const presenceClientWireSchema = z.object({
  clientId: z.string(),
  deviceName: z.string(),
  deviceKey: z.string(),
  lastSeenAt: z.string(),
});

const leaseWireSchema = z.object({
  clientId: z.string(),
  deviceName: z.string(),
  deviceKey: z.string(),
  acquiredAt: z.string(),
});

/**
 * 在线表的快照（契约 §9.4）：心跳、离开、拿租约的回答，订阅的每一项，也是
 * `canvas.presence` 事件的字段。`writable` 与 `deviceKey` 因人而异：只在发给
 * 请求者本人的回答里（心跳、拿租约、订阅的每一项），事件里没有。
 */
export const boardPresenceWireSchema = z.object({
  boardId: z.string(),
  clients: z.array(presenceClientWireSchema),
  lease: leaseWireSchema.nullable(),
  writable: z.boolean().optional(),
  deviceKey: z.string().optional(),
});

export const boardRealtimeStateWireSchema = z.object({
  realtime: z.boolean(),
  materializedSeq: z.number().int(),
  enabled: z.boolean().optional(),
});

export type BoardPresenceItem = z.input<typeof boardPresenceWireSchema>;
export type BoardRealtimeStateWire = z.input<
  typeof boardRealtimeStateWireSchema
>;

const clientFields = {
  /** 页面自己生成的随机串，一个标签页一个；字符集由域校验。 */
  clientId: z.string(),
  deviceName: z.string().optional(),
};

export const boards = {
  list: oc
    .input(z.object({ workspaceId: z.string().min(1) }))
    .output(z.array(boardWireSchema))
    .errors(errors.pick("unauthenticated", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.1",
        legacy: { method: "GET", path: "/api/workspaces/{workspaceId}/boards" },
      }),
    ),
  create: oc
    .input(z.object({ workspaceId: z.string().min(1), name: z.string() }))
    .output(boardWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.1",
        legacy: {
          method: "POST",
          path: "/api/workspaces/{workspaceId}/boards",
        },
      }),
    ),
  update: oc
    .input(
      boardRef.extend({
        name: z.string().optional(),
        sortOrder: z.number().nullish(),
      }),
    )
    .output(boardWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.1",
        legacy: {
          method: "PATCH",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}",
        },
      }),
    ),
  delete: oc
    .input(boardRef)
    .output(z.void())
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.1",
        legacy: {
          method: "DELETE",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}",
          successStatus: 204,
        },
      }),
    ),
  /** 一块板的文档：板、节点、连线与白板快照。 */
  load: oc
    .input(boardRef)
    .output(boardDocumentWireSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.2",
        legacy: {
          method: "GET",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}/document",
        },
      }),
    ),
  /**
   * 存文档。`expectedUpdatedAt` 是 CAS 的修订号（旧了答 `conflict`）；`clientId`
   * 是编辑租约的写者（别人持有租约答 `canvas_lease_held`，租约先于 CAS 判）。
   * 白板快照（`whiteboard`）与节点、连线在同一次调用里走，缺席保留已存的那份。
   */
  save: oc
    .input(
      z.looseObject({
        workspaceId: z.string().min(1),
        boardId: z.string().min(1),
        expectedUpdatedAt: z.string(),
        nodes: z.array(jsonObjectSchema),
        edges: z.array(jsonObjectSchema),
        viewport: jsonObjectSchema,
        whiteboard: z.string().nullish(),
        clientId: z.string().nullish(),
      }),
    )
    .output(boardDocumentWireSchema)
    .errors(
      errors.pick(
        "bad_request",
        "forbidden",
        "not_found",
        "conflict",
        "canvas_lease_held",
        "realtime_active",
      ),
    )
    .meta(
      meta({
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.2",
        legacy: {
          method: "PUT",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}/document",
        },
      }),
    ),
  /** 这块板走不走实时协同（契约 §16.2）。 */
  realtime: oc
    .input(boardRef)
    .output(boardRealtimeStateWireSchema)
    .errors(errors.pick("forbidden", "not_found", "not_implemented"))
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.3",
        legacy: {
          method: "GET",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}/realtime",
        },
      }),
    ),
  /**
   * 心跳（契约 §9.1）：登记或续期，答在线表与租约。订阅 `boards.presence` 在
   * 连接着的时候替页面续期；这一条留给「刚被操作过」（`active`）与立刻问一次
   * 谁拿着租约。
   */
  heartbeat: oc
    .input(boardRef.extend({ ...clientFields, active: z.boolean().optional() }))
    .output(boardPresenceWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.4",
        legacy: {
          method: "POST",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}/presence",
        },
      }),
    ),
  /** 显式离开；没登记过的客户端离开也是成功（那正是「已经过期了」的样子）。 */
  leave: oc
    .input(boardRef.extend({ clientId: z.string() }))
    .output(boardPresenceWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.4",
        legacy: {
          method: "DELETE",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}/presence/{clientId}",
        },
      }),
    ),
  /** 拿租约；`takeover` 是用户确认过的接管（契约 §9.2）。 */
  acquireLease: oc
    .input(
      boardRef.extend({ ...clientFields, takeover: z.boolean().optional() }),
    )
    .output(boardPresenceWireSchema)
    .errors(
      errors.pick("bad_request", "forbidden", "not_found", "canvas_lease_held"),
    )
    .meta(
      meta({
        scope: "canvas:write",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.4",
        legacy: {
          method: "POST",
          path: "/api/workspaces/{workspaceId}/boards/{boardId}/lease",
        },
      }),
    ),
  /**
   * 在线订阅（契约 §36.4）：订上就是登记（同一次心跳），连接着就是续期，订阅
   * 结束（取消、断线）就是离开。每一项是这个客户端看到的在线表：先发订上时的
   * 那份，之后每次这块板的在线表或租约变了发一份（含授权变化的复判）。
   */
  presence: oc
    .input(boardRef.extend(clientFields))
    .output(eventIterator(boardPresenceWireSchema))
    .errors(
      errors.pick(
        "bad_request",
        "forbidden",
        "not_found",
        "overflow",
        "limit_reached",
      ),
    )
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.6",
        contract: "§36.4",
        backpressure: "drop-oldest",
      }),
    ),
};
