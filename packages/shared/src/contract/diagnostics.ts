import { z } from "zod";

import { errors } from "./errors.js";
import { jsonObjectSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `diagnostics.*`（契约 §43.8；页面错误上报的形状见 §30，Runtime 健康数字见
 * §54）：页面把 `window` 的 `error` 与 `unhandledrejection` 报给 core；探针与
 * 诊断面板读 Runtime 的事件循环延迟与采样计数。
 *
 * 路由门不判这一段（`route-scopes.ts` 的 `SELF_GUARDED`）：登录即可，域自己认会话
 * 并按设备限流；声明的 `canvas:read` 与旧路径的清单一致。默认关：`enabled` 为
 * 假时一条也不收，`report` 答 `{ accepted: false }` 且不看请求体。
 *
 * 收下的先在页面剥离、core 按本机的家目录与环境变量再剥一遍，栈里的地址与路径
 * 只留文件名；终端原始输出与文件正文不进上报。入参是一个 JSON 对象，`kind`、
 * `name`、`message`、`stack` 的取值与长度仍在域里判。限流（`429`）的重试秒数在
 * `details.retryAfterSeconds`，旧路径同时给 `Retry-After` 头。
 */

const base = {
  since: "1.14",
  contract: "§43.8",
  scope: "canvas:read",
} as const;
const PATH = "/api/diagnostics/client-error";
export const RUNTIME_DIAGNOSTICS_PATH = "/api/diagnostics/runtime";

/** `diagnostics.runtime` 的答案（契约 §54）：只有数字与时间戳。 */
export const runtimeDiagnosticsSchema = z.object({
  eventLoop: z.object({
    windowMs: z.number(),
    p50Ms: z.number(),
    p99Ms: z.number(),
    maxMs: z.number(),
  }),
  sampling: z.object({
    intervalMs: z.number(),
    inFlight: z.boolean(),
    rounds: z.number().int(),
    lastRoundMs: z.number().nullable(),
    maxRoundMs: z.number().nullable(),
    overlapsSkipped: z.number().int(),
    timeouts: z.object({
      ps: z.number().int(),
      tmux: z.number().int(),
      probe: z.number().int(),
    }),
    lastRoundAt: z.string().nullable(),
  }),
});

export const diagnostics = {
  /** 页面要不要收：`diagnostics.reportPageErrors` 开着、壳的崩溃上报在发。 */
  clientErrorStatus: oc
    .input(z.object({}).optional())
    .output(z.object({ enabled: z.boolean() }))
    .errors(errors.pick("unauthenticated"))
    .meta(meta({ ...base, legacy: { method: "GET", path: PATH } })),
  /** 报一条页面错误；收下答 `accepted: true`（旧路径 `202`）。 */
  reportClientError: oc
    .input(jsonObjectSchema)
    .output(z.object({ accepted: z.boolean() }))
    .errors(errors.pick("bad_request", "unauthenticated", "rate_limited"))
    .meta(
      meta({
        ...base,
        legacy: { method: "POST", path: PATH, successStatus: 202 },
      }),
    ),
  /**
   * Runtime 的健康数字（契约 §54）：事件循环延迟与资源采样循环的计数。没有
   * 命令行、路径、进程名。资源域没装时 `not_found`。
   */
  runtime: oc
    .input(z.object({}).optional())
    .output(runtimeDiagnosticsSchema)
    .errors(errors.pick("unauthenticated", "not_found"))
    .meta(
      meta({
        ...base,
        since: "1.26",
        legacy: { method: "GET", path: RUNTIME_DIAGNOSTICS_PATH },
      }),
    ),
};
