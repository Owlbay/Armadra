import { z } from "zod";

import {
  pushConfigSchema,
  pushDeviceListSchema,
  pushDeviceResponseSchema,
  pushRevokeResponseSchema,
  pushTestResponseSchema,
} from "../api/push.js";
import { errors } from "./errors.js";
import { jsonObjectSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `push.*`（契约 §43.4；推送的形状见 §19、§27）：推送配置、设备登记与撤销、测试
 * 通知。
 *
 * 路由门不判这一段（`route-scopes.ts` 的 `SELF_GUARDED`）：推送域只碰请求主体自己
 * 的设备，自己认请求身份——这里声明的 `canvas:read` 与旧路径的清单一致，门面把它
 * 交给同一道路由门，门对这一段放行，判定仍在域里（匿名主体 `401`，别人的设备
 * `404`，桌面壳本机请求登记 `409 device_required`）。
 *
 * 答案里没有令牌、没有公钥本身，只说有没有（`encrypted`、`unifiedpush`）；登记的
 * 入参带令牌与订阅密钥，只出去一次，不进日志与审计。入参只校形状（一个 JSON
 * 对象），取值与互斥条件仍在域里判（`core/push/devices.ts`）。
 */

const base = {
  since: "1.14",
  contract: "§43.4",
  scope: "canvas:read",
} as const;
const DEVICES = "/api/push/devices";
const DEVICE = "/api/push/devices/{deviceId}";
const denied = errors.pick("unauthenticated", "forbidden");

export const push = {
  /** 这台 core 的推送配置：Web Push 的 VAPID 公钥、原生传输的状态与可达平台。 */
  config: oc
    .input(z.object({}).optional())
    .output(pushConfigSchema)
    .errors(denied)
    .meta(
      meta({ ...base, legacy: { method: "GET", path: "/api/push/config" } }),
    ),
  /** 自己名下的设备（owner 也只看自己名下的）。 */
  devices: oc
    .input(z.object({}).optional())
    .output(pushDeviceListSchema)
    .errors(denied)
    .meta(meta({ ...base, legacy: { method: "GET", path: DEVICES } })),
  /** 登记或覆盖这次请求背后那台已配对设备的推送；请求体里没有设备 id 可填。 */
  register: oc
    .input(jsonObjectSchema)
    .output(pushDeviceResponseSchema)
    .errors({
      ...denied,
      ...errors.pick("bad_request", "device_required"),
    })
    .meta(meta({ ...base, legacy: { method: "PUT", path: DEVICES } })),
  /** 改这台设备收哪些种类（§27.1）；只有设备的主人能改。 */
  setKinds: oc
    .input(
      z.object({
        deviceId: z.string(),
        kinds: z.array(z.string()).optional(),
      }),
    )
    .output(pushDeviceResponseSchema)
    .errors({ ...denied, ...errors.pick("bad_request", "not_found") })
    .meta(meta({ ...base, legacy: { method: "PATCH", path: DEVICE } })),
  /** 撤销一台设备；owner 能撤任何一台，别人只能撤自己的，其余与不存在同答。 */
  revoke: oc
    .input(z.object({ deviceId: z.string() }))
    .output(pushRevokeResponseSchema)
    .errors({ ...denied, ...errors.pick("not_found") })
    .meta(meta({ ...base, legacy: { method: "DELETE", path: DEVICE } })),
  /** 给这台设备发一条测试通知；旧路径答 `202`。 */
  test: oc
    .input(z.object({}).optional())
    .output(pushTestResponseSchema)
    .errors({ ...denied, ...errors.pick("device_required") })
    .meta(
      meta({
        ...base,
        legacy: { method: "POST", path: "/api/push/test", successStatus: 202 },
      }),
    ),
};
