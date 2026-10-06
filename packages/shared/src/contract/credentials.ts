import { z } from "zod";

import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `credentials.*`（契约 §43.6；节点凭据的形状见 §20.2）：节点终端用的凭据条目。
 * 只有 owner（全局 `settings:*`，共享只发工作空间上的授权，成员在这里一律 `403`）。
 *
 * **值只进不出**：`create` 与 `update` 的入参带 `value`，任何答案、错误细节与
 * 日志都只有 `isSet`，没有值本身；审计只记条目名与种类。出参的每个字段都列在下面，
 * 不放透传：条目里没有任何能装下值的位置。入参只校形状，长度、种类表与「值是不是
 * 单行」仍在域里判（`core/agent/credentials/routes.ts`）。
 */

const base = { since: "1.14", contract: "§43.6" } as const;
const REF = "/api/credentials/{ref}";

const entry = z.object({
  ref: z.string(),
  providerId: z.string(),
  kind: z.string(),
  label: z.string(),
  isSet: z.boolean(),
  /** 节点终端最近一次取值的时刻（毫秒）；从没取过就没有这一项。 */
  lastUsedAt: z.number().int().optional(),
});

const list = z.object({
  backend: z.string(),
  available: z.boolean(),
  /** 这台主机不存凭据时的原因码（`available: false` 才有）。 */
  reason: z.string().optional(),
  kinds: z.array(
    z.object({
      providerId: z.string(),
      kind: z.string(),
      enabled: z.boolean(),
    }),
  ),
  entries: z.array(entry),
});

const denied = errors.pick("unauthenticated", "forbidden");
const storeErrors = errors.pick(
  "credential_backend_insecure",
  "credential_unsupported_here",
  "credential_unavailable",
);

export const credentials = {
  /** 这台主机能不能存、有哪些条目与种类（`enabled: false` 的种类灰着列出）。 */
  list: oc
    .input(z.object({}).optional())
    .output(list)
    .errors(denied)
    .meta(
      meta({
        ...base,
        scope: "settings:read",
        legacy: { method: "GET", path: "/api/credentials" },
      }),
    ),
  /** 新建一条；`ref` 由 core 生成。旧路径答 `201`。 */
  create: oc
    .input(
      z.object({
        providerId: z.string(),
        kind: z.string(),
        label: z.string(),
        value: z.string(),
      }),
    )
    .output(entry)
    .errors({
      ...denied,
      ...errors.pick("bad_request", "credential_kind_disabled"),
      ...storeErrors,
    })
    .meta(
      meta({
        ...base,
        scope: "settings:write",
        legacy: {
          method: "POST",
          path: "/api/credentials",
          successStatus: 201,
        },
      }),
    ),
  /** 改名或换值（两样至少给一样）。 */
  update: oc
    .input(
      z.object({
        ref: z.string(),
        label: z.string().optional(),
        value: z.string().optional(),
      }),
    )
    .output(entry)
    .errors({
      ...denied,
      ...errors.pick("bad_request", "credential_not_found"),
      ...storeErrors,
    })
    .meta(
      meta({
        ...base,
        scope: "settings:write",
        legacy: { method: "PATCH", path: REF },
      }),
    ),
  /** 删一条（值一并从密钥后端删掉）；旧路径答 `204`。 */
  remove: oc
    .input(z.object({ ref: z.string() }))
    .output(z.void())
    .errors({ ...denied, ...errors.pick("credential_not_found") })
    .meta(
      meta({
        ...base,
        scope: "settings:write",
        legacy: { method: "DELETE", path: REF, successStatus: 204 },
      }),
    ),
};
