import { eventIterator } from "@orpc/contract";
import { z } from "zod";

import { workspaceEventSchema } from "../api/events.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `workspaces.*`（契约 §34.4，试点域）。
 *
 * 形状写线上的样子而不是页面解析后的样子：本地工作空间不带 `executionHostId`
 * （页面的 `workspaceSchema` 把它补成 `""`），颜色与授权由 core 写全，所以这里
 * 没有缺省值——出参校验校的是 core 真发出去的那份。标识与时刻只校是字符串：
 * UUID 与时间戳格式是页面解析时的事，出参校验不该因为一行旧数据把整张列表答
 * 成 500。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：工作空间这一行本身
 * （新建、改名、改授权、删除、换根目录）是 `workspace:share`，只有 owner 能做。
 *
 * 入参只校形状；名字长度、颜色格式、根目录存不存在这些语义检查仍在域里，旧
 * 路径与 procedure 走的是同一个实现，拒绝的码一样。
 */

const permissionsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  execute: z.boolean(),
});

export const workspaceWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  color: z.string(),
  permissions: permissionsSchema,
  executionHostId: z.string().optional(),
  lastOpenedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workspaceSummaryWireSchema = workspaceWireSchema.extend({
  boards: z.array(
    z.object({ id: z.string(), name: z.string(), nodeCount: z.number().int() }),
  ),
});

const workspaceRef = z.object({ workspaceId: z.string().min(1) });

/**
 * 订阅里的位置帧（契约 §35.4）：每次（重新）订上、补发完之后发一帧，`id` 是
 * 这时的 outbox 位置。它不是第 22 个工作空间事件——页面拿它当「订上了」的上升
 * 沿，并让还没收到任何事件的订阅也有一个可续的 `lastEventId`。
 */
export const workspaceEventsCursorSchema = z.object({
  type: z.literal("cursor"),
  /** 补到了哪里（含其它工作空间的序号）；下一次续订从它之后。 */
  cursor: z.number().int().nonnegative(),
  /** outbox 的保留下限：比它小的位置续不上了。 */
  floor: z.number().int().nonnegative(),
  /** 这台 core 发过的最大序号。 */
  watermark: z.number().int().nonnegative(),
});

/** `workspaces.events` 的一项：工作空间事件或位置帧。 */
export const workspaceEventsItemSchema = z.union([
  workspaceEventSchema,
  workspaceEventsCursorSchema,
]);

export type WorkspaceEventsItem = z.input<typeof workspaceEventsItemSchema>;
export type WorkspaceEventsCursor = z.infer<typeof workspaceEventsCursorSchema>;

export const workspaces = {
  list: oc
    .input(z.object({}).optional())
    .output(z.array(workspaceSummaryWireSchema))
    .errors(errors.pick("unauthenticated", "forbidden"))
    .meta(
      meta({
        scope: "canvas:read",
        since: "1.3",
        contract: "§34.4",
        legacy: { method: "GET", path: "/api/workspaces" },
      }),
    ),
  create: oc
    .input(
      z.object({
        name: z.string(),
        rootPath: z.string(),
        color: z.string().optional(),
        permissions: permissionsSchema.nullish(),
        /** 根目录还不存在、要 core 建（父目录必须在，末级必须不在）。 */
        createDirectory: z.boolean().optional(),
      }),
    )
    .output(workspaceWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        scope: "canvas:write",
        since: "1.3",
        contract: "§34.4",
        legacy: { method: "POST", path: "/api/workspaces" },
      }),
    ),
  openDirectory: oc
    .input(
      z.object({
        name: z.string(),
        rootPath: z.string(),
        color: z.string().optional(),
        permissions: permissionsSchema.nullish(),
      }),
    )
    .output(workspaceWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "workspace:share",
        since: "1.3",
        contract: "§34.4",
        legacy: { method: "POST", path: "/api/workspaces/open-directory" },
      }),
    ),
  openRemote: oc
    .input(
      z.object({
        name: z.string(),
        executionHostId: z.string().optional(),
        rootPath: z.string(),
        permissions: permissionsSchema.nullish(),
      }),
    )
    .output(workspaceWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        scope: "workspace:share",
        since: "1.3",
        contract: "§34.4",
        legacy: { method: "POST", path: "/api/workspaces/remote" },
      }),
    ),
  update: oc
    .input(
      workspaceRef.extend({
        name: z.string().optional(),
        color: z.string().optional(),
        permissions: permissionsSchema.nullish(),
      }),
    )
    .output(workspaceWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        scope: "workspace:share",
        workspaceKey: "workspaceId",
        since: "1.3",
        contract: "§34.4",
        legacy: { method: "PATCH", path: "/api/workspaces/{workspaceId}" },
      }),
    ),
  delete: oc
    .input(workspaceRef)
    .output(z.void())
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        scope: "workspace:share",
        workspaceKey: "workspaceId",
        since: "1.3",
        contract: "§34.4",
        legacy: {
          method: "DELETE",
          path: "/api/workspaces/{workspaceId}",
          successStatus: 204,
        },
      }),
    ),
  open: oc
    .input(workspaceRef)
    .output(workspaceWireSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        scope: "canvas:read",
        workspaceKey: "workspaceId",
        since: "1.3",
        contract: "§34.4",
        legacy: { method: "POST", path: "/api/workspaces/{workspaceId}/open" },
      }),
    ),
  /**
   * 工作空间事件流（契约 §35.4）：控制面 `/api/ws` 上的订阅，每项的事件 `id` 是
   * outbox 序号。`cursor` 是旧 `?cursor=` 的同义（`now` 或一个位置）；断线重订
   * 时客户端交回的 `lastEventId` 优先。位置掉出保留下限答 `snapshot_required`，
   * 比水位还新答 `cursor_ahead`——两者都是先整份重读、再从现在订。
   */
  events: oc
    .input(
      workspaceRef.extend({
        cursor: z
          .union([z.literal("now"), z.number().int().nonnegative()])
          .optional(),
      }),
    )
    .output(eventIterator(workspaceEventsItemSchema))
    .errors(
      errors.pick(
        "forbidden",
        "not_found",
        "snapshot_required",
        "cursor_ahead",
        "overflow",
        "limit_reached",
      ),
    )
    .meta(
      meta({
        scope: "events:read",
        workspaceKey: "workspaceId",
        since: "1.4",
        contract: "§35.4",
        backpressure: "resubscribe",
      }),
    ),
};
