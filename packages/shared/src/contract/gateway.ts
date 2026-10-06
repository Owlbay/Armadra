import { z } from "zod";

import {
  gatewayPairingPayloadSchema,
  gatewayStatusSchema,
} from "../api/gateway.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `gateway.*`（契约 §43.7；Gateway 的形状见 §17、§24）：对外的 HTTPS 服务的状态、
 * 配置与配对票。读与写只有 owner（全局 `settings:*`，成员一律 `403`）。
 *
 * 入参只校形状（字段的类型与有没有多余的键），取值（`listen` 的选项、端口范围、
 * `publicOrigin` 必须是 https 来源、证书来源）仍在域里判，拒绝的原话与旧路径一样。
 * 配对票（`pair` 的答案）是两分钟内能换出一台 owner 设备的凭据：只答给调用方，
 * 不进审计与日志。
 *
 * **匿名面不经 RPC**：配对短码换票（`exchangePairingCode`）发生在手机还没有任何
 * 身份的时候，短码本身就是凭据，所以只经旧路径 `POST /api/gateway/pairing-code/
 * exchange`（`scope: null`，在 Gateway 的准入里放行、不要会话），RPC 路径不实现
 * （答 `501`）。它登记在这里是为了让契约说清这条路的形状、错误与权限，实现仍在
 * `core/gateway/`（限流与档位都在那里判）。
 */

const base = { since: "1.14" } as const;
const section = "§43.7" as const;

const patch = z.strictObject({
  enabled: z.boolean().optional(),
  listen: z.string().optional(),
  port: z.number().optional(),
  publicOrigin: z.string().optional(),
  tls: z
    .strictObject({
      source: z.string().optional(),
      certFile: z.string().optional(),
      keyFile: z.string().optional(),
      acmeEmail: z.string().optional(),
    })
    .optional(),
});

const denied = errors.pick("unauthenticated", "forbidden");

export const gateway = {
  /** 状态：开没开、监听在哪、证书来源与指纹、ACME 的续期状态、上次失败。 */
  status: oc
    .input(z.object({}).optional())
    .output(gatewayStatusSchema)
    .errors(denied)
    .meta(
      meta({
        ...base,
        contract: section,
        scope: "settings:read",
        legacy: { method: "GET", path: "/api/gateway" },
      }),
    ),
  /** 改配置（`gateway.*` 的子集，没给的键不动），再按新配置开、关或重开；答新状态。 */
  configure: oc
    .input(patch)
    .output(gatewayStatusSchema)
    .errors({
      ...denied,
      ...errors.pick(
        "bad_request",
        "gateway_managed_by_shell",
        "settings_unavailable",
      ),
    })
    .meta(
      meta({
        ...base,
        contract: section,
        scope: "settings:write",
        legacy: { method: "PUT", path: "/api/gateway" },
      }),
    ),
  /** 铸一张两分钟的一次性配对票：网页链接、原生深链，私网档位上还有 8 位短码。 */
  pair: oc
    .input(
      z.object({
        origin: z.string().optional(),
        deviceName: z.string().optional(),
      }),
    )
    .output(gatewayPairingPayloadSchema)
    .errors({
      ...denied,
      ...errors.pick("bad_request", "gateway_not_running", "invalid_origin"),
    })
    .meta(
      meta({
        ...base,
        contract: section,
        scope: "settings:write",
        legacy: { method: "POST", path: "/api/gateway/pairing" },
      }),
    ),
  /** 匿名：配对短码换出与 `#pair=` 同一张票。只经旧路径，RPC 上不登记。 */
  exchangePairingCode: oc
    .input(z.object({ code: z.string() }))
    .output(gatewayPairingPayloadSchema)
    .errors(
      errors.pick(
        "bad_request",
        "gateway_not_running",
        "pairing_code_disabled",
        "pairing_code_invalid",
        "origin_mismatch",
        "rate_limited",
      ),
    )
    .meta(
      meta({
        ...base,
        contract: section,
        scope: null,
        legacy: { method: "POST", path: "/api/gateway/pairing-code/exchange" },
      }),
    ),
};
