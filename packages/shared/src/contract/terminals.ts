import { z } from "zod";

import { driveLeaseSchema } from "../api/drive.js";
import {
  TERMINAL_DRIVE_ACTIONS,
  TERMINATE_MODES,
  sessionsResponseSchema,
  terminalBackendInfoSchema,
  terminalCaptureResponseSchema,
  terminalSessionSchema,
} from "../api/terminals.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `terminals.*`（契约 §38）：终端会话的 HTTP 面——开、读、抓屏、粘贴、滚动、
 * 终止、重起、唤醒、接管 / 交还，以及后端与工作空间会话列表。
 *
 * 终端的字节流不在这里：输入输出走 `WS /api/terminals/{sessionId}/ws`（§14），
 * 那条连接与它的帧不动，也不进控制面。`POST /api/terminals/{sessionId}/node-token/…`
 * 属于凭据域，随 E3-8。
 *
 * 出参复用页面已有的 schema，只补 core 一直在答、而页面 schema 当时没写的字段
 * （会话行的 `kind` 与 `ownerNodeId`，后端信息的 `platform`）：契约不能比旧路径
 * 少答东西。入参只校形状，域里的判断（工作空间与 cwd、节点 id、粘贴大小上限、
 * 凭据）留在 `core/terminal/`，旧路径与 procedure 走同一份实现，拒绝的码与原话
 * 一样；所以这里不加 `min` / `max` 之类会让入参校验抢在域前面拒绝的约束。
 *
 * 终端的原始输出只在 `capture` 的出参里过，不进日志、事件与持久化；粘贴的文字
 * 只在入参里过，同样不落盘不记日志。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：开一个是
 * `terminal:create`，读是 `terminal:read`，往已有会话里动手是 `terminal:write`。
 * 向别人开的会话里写还要 `terminal:drive`，那一条在终端输入路径上判，不在路由上。
 */

const sessionRef = z.object({ sessionId: z.string().min(1) });

/**
 * 页面拿到的会话行：页面 schema 加上 core 一直在答的两个字段，并把 id 与时刻放宽
 * 成字符串——契约出参不能比旧路径更挑剔（探针与测试种的工作空间 id 不是 UUID），
 * 格式由页面自己的 schema 再校一遍。
 */
export const terminalSessionWireSchema = terminalSessionSchema.extend({
  id: z.string(),
  workspaceId: z.string(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  lastOutputAt: z.string().nullable().optional(),
  kind: z.string().optional(),
  ownerNodeId: z.string().nullable().optional(),
});

/** 后端信息：页面 schema 加上 `platform`（设置页与路径分隔符判断读它）。 */
export const terminalBackendWireSchema = terminalBackendInfoSchema.extend({
  platform: z.enum(["unix", "windows"]),
});

const TERMINAL = "/api/terminals/{sessionId}";
const base = { since: "1.6", contract: "§38.1" } as const;

export const terminals = {
  /**
   * 开一个会话。`agent` + `nodeId` 同时给才是 Agent 终端：core 据此铸节点令牌并
   * 注入 `ARMADRA_*` 环境（只给名字，凭据值不经过这里）；`ssh` 只带主机 id。
   */
  create: oc
    .input(
      z.object({
        workspaceId: z.string(),
        cwd: z.string(),
        shell: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        nodeId: z.string().optional(),
        agent: z
          .object({
            id: z.string(),
            accountId: z.string().optional(),
            permissionMode: z.string().optional(),
            model: z.string().optional(),
            sessionId: z.string().optional(),
            credentialRef: z.string().optional(),
          })
          .optional(),
        ssh: z.object({ hostId: z.string() }).optional(),
      }),
    )
    .output(terminalSessionWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        workspaceKey: "workspaceId",
        legacy: { method: "POST", path: "/api/terminals" },
      }),
    ),
  /** 哪个后端在用，为什么。 */
  backend: oc
    .input(z.object({}).optional())
    .output(terminalBackendWireSchema)
    .errors(errors.pick("forbidden"))
    .meta(
      meta({
        ...base,
        scope: "terminal:read",
        legacy: { method: "GET", path: "/api/terminals/backend" },
      }),
    ),
  /** 会话行，不管进程在不在。 */
  get: oc
    .input(sessionRef)
    .output(terminalSessionWireSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "terminal:read",
        legacy: { method: "GET", path: TERMINAL },
      }),
    ),
  /**
   * 抓屏：`escapes` 为真保留 SGR（给快照），否则是给 Agent 读的纯文本。`lines`
   * 缺省 200、上限 10000。旧路径是查询串，数字与布尔以字符串到达。
   */
  capture: oc
    .input(
      sessionRef.extend({
        lines: z.coerce.number().optional(),
        escapes: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
      }),
    )
    .output(terminalCaptureResponseSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "terminal:read",
        legacy: { method: "GET", path: `${TERMINAL}/capture` },
      }),
    ),
  /** 工作空间里的会话（侧栏）：每个终端节点一行，附带进程是否还在。 */
  sessions: oc
    .input(z.object({ workspaceId: z.string().min(1) }))
    .output(sessionsResponseSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "terminal:read",
        workspaceKey: "workspaceId",
        legacy: {
          method: "GET",
          path: "/api/workspaces/{workspaceId}/sessions",
        },
      }),
    ),
  /** 括号粘贴，`enter` 为真补一个回车。算人在驱动，与键盘上来的字节同一条语义。 */
  paste: oc
    .input(
      sessionRef.extend({
        text: z.string(),
        enter: z.boolean().optional(),
      }),
    )
    .output(terminalSessionWireSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:write",
        legacy: { method: "POST", path: `${TERMINAL}/paste` },
      }),
    ),
  /** 滚动回看：正数向上（更旧），负数向下；答 204。 */
  scroll: oc
    .input(sessionRef.extend({ lines: z.number() }))
    .output(z.void())
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "terminal:write",
        legacy: {
          method: "POST",
          path: `${TERMINAL}/scroll`,
          successStatus: 204,
        },
      }),
    ),
  /**
   * 三级终止：`interrupt` 发中断信号、`process`（缺省）杀进程树、`session` 连持久
   * 会话一起销毁。已经结束的会话不是错误，答它现在的样子。
   */
  terminate: oc
    .input(sessionRef.extend({ mode: z.enum(TERMINATE_MODES).optional() }))
    .output(terminalSessionWireSchema)
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:write",
        legacy: { method: "POST", path: `${TERMINAL}/terminate` },
      }),
    ),
  /** 同一个 session_key 起下一代；旧代次的 WS 帧之后一律被拒。 */
  recycle: oc
    .input(sessionRef)
    .output(terminalSessionWireSchema)
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:write",
        legacy: { method: "POST", path: `${TERMINAL}/recycle` },
      }),
    ),
  /**
   * 唤醒节能休眠的会话：在同一个会话 id 上起下一代，敲 CLI 自己的恢复行。已经
   * 醒着就答它现在的样子；不属于任何节点的会话答 409 `not_hibernated`。
   */
  wake: oc
    .input(sessionRef)
    .output(terminalSessionWireSchema)
    .errors(errors.pick("forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:write",
        legacy: { method: "POST", path: `${TERMINAL}/wake` },
      }),
    ),
  /**
   * 接管 / 交还这块屏幕。与「人敲一个键」的抢占不同：这是一句明确的「现在归
   * 我」，Agent 一律被拒直到有人交还。答回来的是新的租约；徽标读的是广播给每台
   * 设备的 `terminal.lease` 帧。
   */
  drive: oc
    .input(sessionRef.extend({ action: z.enum(TERMINAL_DRIVE_ACTIONS) }))
    .output(driveLeaseSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "terminal:write",
        legacy: { method: "POST", path: `${TERMINAL}/drive` },
      }),
    ),
};
