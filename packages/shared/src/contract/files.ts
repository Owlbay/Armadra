import { z } from "zod";

import {
  fileContentSchema,
  fileInfoSchema,
  fileListSchema,
  fileVersionSchema,
  importFilesResponseSchema,
  watchRegistrationSchema,
  writeFileResponseSchema,
} from "../api/files.js";
import {
  fileEntryKindSchema,
  fileEntryResultSchema,
  fileIndexSchema,
  fileSearchResultSchema,
  trashEntrySchema,
  trashListSchema,
} from "../api/search.js";
import { errors } from "./errors.js";
import { meta, oc } from "./meta.js";

/**
 * `files.*`（契约 §37）：工作空间文件的 JSON 面——浏览、读、写、新建、改名、
 * 回收站、文件名索引、项目搜索、监听、版本检查，以及「在文件管理器里显示」与
 * 「按本机路径导入」。
 *
 * 出参复用 `api/files.ts` 与 `api/search.ts` 那套 schema：页面本来就拿它们解析，
 * 契约不另写一份。入参只校形状：路径是否越界、能不能写、内容 SHA 对不对这些
 * 判断在域里（`core/files/`），旧路径与 procedure 走同一份实现，拒绝的码与原话
 * 一样，所以这里不加 `min` / `max` 之类会让入参校验抢在域前面拒绝的约束。
 *
 * 留在 REST 的（字节流，不是 JSON，§37.2）：整份上传（`POST /imports`，多部分）、
 * 下载（`GET /file-download`，附件、分块、`Range`）、`<img src>` 一类的直接取
 * 字节。文件正文只在读与写的入出参里过，不进日志、事件与持久化。
 *
 * 权限与路由表（`core/http/route-scopes.ts`）给旧路径的一致：读是 `files:read`，
 * 其余（连同搜索与监听的 POST / DELETE）是 `files:write`；「显示」拉起外部程序，
 * 与开终端同一档 `terminal:create`。
 */

const workspaceRef = z.object({ workspaceId: z.string().min(1) });

/** 旧路径是查询串：缺省与空串都是根目录（`.`）。 */
const pathQuery = workspaceRef.extend({ path: z.string().optional() });

const base = {
  since: "1.5",
  contract: "§37.1",
  workspaceKey: "workspaceId",
} as const;
const WORKSPACE = "/api/workspaces/{workspaceId}";

export const files = {
  list: oc
    .input(pathQuery)
    .output(fileListSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:read",
        legacy: { method: "GET", path: `${WORKSPACE}/files` },
      }),
    ),
  info: oc
    .input(pathQuery)
    .output(fileInfoSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:read",
        legacy: { method: "GET", path: `${WORKSPACE}/file-info` },
      }),
    ),
  /** 编辑器的读：UTF-8 文本、内容 SHA（下一次保存要带）、编码与换行。 */
  read: oc
    .input(pathQuery)
    .output(fileContentSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:read",
        legacy: { method: "GET", path: `${WORKSPACE}/file` },
      }),
    ),
  /**
   * 原子写入。已有文件必须带上读到的 `expectedSha256`；缺省只许新建。旧版的
   * `expectedSize` 单独不能授权覆盖，带它而不带 SHA 答 `bad_request`。
   */
  write: oc
    .input(
      workspaceRef.extend({
        path: z.string(),
        content: z.string(),
        expectedSize: z.number().nullish(),
        expectedSha256: z.string().nullish(),
        /** 把读时剥掉的 BOM 写回去。 */
        bom: z.boolean().optional(),
      }),
    )
    .output(writeFileResponseSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "PUT", path: `${WORKSPACE}/file` },
      }),
    ),
  /** 新建文件或文件夹；同名一律 `conflict`，不覆盖。 */
  create: oc
    .input(workspaceRef.extend({ path: z.string(), kind: fileEntryKindSchema }))
    .output(fileEntryResultSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/file-entries` },
      }),
    ),
  /** 重命名与移动是同一件事，只差目标路径。 */
  rename: oc
    .input(workspaceRef.extend({ from: z.string(), to: z.string() }))
    .output(fileEntryResultSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/file-entries/rename` },
      }),
    ),
  /** 删到工作空间的 `.armadra/trash/`，不做永久删除。 */
  trash: oc
    .input(workspaceRef.extend({ path: z.string() }))
    .output(trashEntrySchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/file-entries/trash` },
      }),
    ),
  trashList: oc
    .input(workspaceRef)
    .output(trashListSchema)
    .errors(errors.pick("forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:read",
        legacy: { method: "GET", path: `${WORKSPACE}/file-entries/trash` },
      }),
    ),
  restore: oc
    .input(workspaceRef.extend({ id: z.string() }))
    .output(fileEntryResultSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/file-entries/restore` },
      }),
    ),
  /** 快速打开：按文件名模糊匹配，跳过构建目录并给上限；`truncated` 说明被截。 */
  index: oc
    .input(
      workspaceRef.extend({
        query: z.string().optional(),
        // 旧路径是查询串，数字以字符串到达。
        limit: z.coerce.number().optional(),
      }),
    )
    .output(fileIndexSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:read",
        legacy: { method: "GET", path: `${WORKSPACE}/file-index` },
      }),
    ),
  /**
   * 项目搜索：core 侧逐文件找，按文件分页（`offset` / `nextOffset`）。调用方断开
   * 连接，扫描随之停下（答 499 `cancelled`，没人读得到）。
   */
  search: oc
    .input(
      workspaceRef.extend({
        query: z.string(),
        regex: z.boolean().nullish(),
        caseSensitive: z.boolean().nullish(),
        wholeWord: z.boolean().nullish(),
        include: z.string().nullish(),
        exclude: z.string().nullish(),
        maxMatchesPerFile: z.number().nullish(),
        limit: z.number().nullish(),
        offset: z.number().nullish(),
      }),
    )
    .output(fileSearchResultSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "cancelled"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/file-search` },
      }),
    ),
  /**
   * 声明某个编辑器节点正打开这个文件。`status: "unsupported"` 表示没有可用的
   * 监听后端，页面改用 `version`；远端工作空间 `mode` 是 `poll`。
   */
  watch: oc
    .input(workspaceRef.extend({ path: z.string(), nodeId: z.string() }))
    .output(watchRegistrationSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/file-watch` },
      }),
    ),
  /**
   * 注销一个监听；没登记过的是空操作，所以切换工作空间后迟到的关闭不是错误。
   * 没有 `meta.legacy`：旧路径 `DELETE …/file-watch` 带查询串，而契约层的 DELETE
   * 只读体，所以那条旧路径继续由路由表的原 handler 答。
   */
  unwatch: oc
    .input(
      workspaceRef.extend({
        path: z.string().optional(),
        nodeId: z.string().optional(),
      }),
    )
    .output(z.void())
    .errors(errors.pick("forbidden", "not_found"))
    .meta(meta({ ...base, scope: "files:write" })),
  /** 按需版本检查：文件不存在也是正常回答（`exists: false`），不是 `not_found`。 */
  version: oc
    .input(pathQuery)
    .output(fileVersionSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        ...base,
        scope: "files:read",
        legacy: { method: "GET", path: `${WORKSPACE}/file-version` },
      }),
    ),
  /** 在 core 所在机器的文件管理器里定位一项（`.` 是根）；只对本机工作空间有意义。 */
  reveal: oc
    .input(workspaceRef.extend({ path: z.string() }))
    .output(z.object({ ok: z.boolean() }))
    .errors(
      errors.pick(
        "bad_request",
        "forbidden",
        "not_found",
        "unsupported",
        "reveal_failed",
      ),
    )
    .meta(
      meta({
        ...base,
        scope: "terminal:create",
        legacy: { method: "POST", path: `${WORKSPACE}/reveal` },
      }),
    ),
  /** 把桌面壳已有路径的文件复制进工作空间（1–256 个）；上传字节的多部分版留在 REST。 */
  importLocal: oc
    .input(workspaceRef.extend({ paths: z.array(z.string()) }))
    .output(importFilesResponseSchema)
    .errors(errors.pick("bad_request", "forbidden", "not_found", "conflict"))
    .meta(
      meta({
        ...base,
        scope: "files:write",
        legacy: { method: "POST", path: `${WORKSPACE}/imports/local` },
      }),
    ),
  /**
   * 输出到画板的代码块（契约 §14.5、§37.3）：写成
   * `.armadra/exports/acp/<exportId>/<name>`（来源 Agent 节点的工作目录在工作区内时
   * 落在那里），答绝对路径、工作区相对路径与字节数。`exportId` 是来源节点的 id；
   * 文件名与大小（至多 1 MiB）的检查在域里。远端工作空间写在执行主机上。
   */
  exportText: oc
    .input(
      workspaceRef.extend({
        exportId: z.string(),
        name: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .output(
      z.object({
        path: z.string(),
        relativePath: z.string(),
        bytes: z.number(),
      }),
    )
    .errors(errors.pick("bad_request", "forbidden", "not_found"))
    .meta(
      meta({
        since: "1.17",
        contract: "§37.3",
        workspaceKey: "workspaceId",
        scope: "assets:read",
        legacy: {
          method: "POST",
          path: `${WORKSPACE}/exports/{exportId}/text`,
        },
      }),
    ),
};
