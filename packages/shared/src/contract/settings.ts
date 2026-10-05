import { z } from "zod";

import { errors } from "./errors.js";
import { jsonObjectSchema } from "./json.js";
import { meta, oc } from "./meta.js";

/**
 * `settings.*`（契约 §34.5，试点域）。
 *
 * 设置文档是「已知键归一 + 未知键透传」的一份 JSON（`core/settings/schema.ts`），
 * 所以出入参都是任意 JSON 对象；哪几段要校验由域自己说（终端后端、日志保留
 * 天数这两个封闭选项被拒时答 `bad_request`）。页面按自己认得的那几段再解析
 * 一遍（`apps/web/src/api/settings.ts`）。
 */
export const settings = {
  get: oc
    .input(z.object({}).optional())
    .output(jsonObjectSchema)
    .errors(errors.pick("unauthenticated", "forbidden"))
    .meta(
      meta({
        scope: "settings:read",
        since: "1.3",
        contract: "§34.5",
        legacy: { method: "GET", path: "/api/settings" },
      }),
    ),
  /** 按段浅合并；数组整段替换，`null` 删键。答合并后的整份文档。 */
  update: oc
    .input(jsonObjectSchema)
    .output(jsonObjectSchema)
    .errors(errors.pick("bad_request", "forbidden"))
    .meta(
      meta({
        scope: "settings:write",
        since: "1.3",
        contract: "§34.5",
        legacy: { method: "PATCH", path: "/api/settings" },
      }),
    ),
  /** 哪些键存在本机、不随设置文档走（迁移 §1.4），以及那个文件在哪。 */
  local: oc
    .input(z.object({}).optional())
    .output(z.object({ paths: z.array(z.string()), file: z.string() }))
    .errors(errors.pick("unauthenticated", "forbidden"))
    .meta(
      meta({
        scope: "settings:read",
        since: "1.3",
        contract: "§34.5",
        legacy: { method: "GET", path: "/api/settings/local" },
      }),
    ),
};
