import { z } from "zod";

import { errors } from "./errors.js";
import { jsonObjectSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `diagnostics.*`（契约 §43.8；页面错误上报的形状见 §30）：页面把 `window` 的
 * `error` 与 `unhandledrejection` 报给 core。
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
};
