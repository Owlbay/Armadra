import {
  createFileEntryRequestSchema,
  fileContentSchema,
  fileEntryResultSchema,
  fileInfoSchema,
  fileListSchema,
  fileVersionSchema,
  importFilesResponseSchema,
  renameFileEntryRequestSchema,
  trashEntrySchema,
  trashListSchema,
  watchFileRequestSchema,
  watchRegistrationSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
  type FileEntryKind,
} from "@armadra/shared";
import { z } from "zod";
import type { ArmadraClient } from "./client";
import { query, request } from "./request";
import { currentSource } from "./source";

/**
 * 工作空间文件（契约 §37）。
 *
 * JSON 面经 RPC 客户端（`client.files.*`），答案仍过页面自己的 schema，调用点
 * 看到的形状与迁移前一样。留在 REST 的是字节流（§37.2）：整份上传（多部分）
 * 与下载的 URL（附件、分块、`Range`，也是 `<a href>` / `<img src>` 直接取的
 * 那种），它们不是 JSON，不经客户端。客户端由 `api/client.ts` 交进来：这个模块
 * 被它 import，反过来 import 它就是一个环。
 */
export const filesApiFor = (rpc: () => ArmadraClient) => ({
  /* ----------------------------------- 文件 ----------------------------- */
  fileInfo: async (workspaceId: string, path: string) =>
    fileInfoSchema.parse(await rpc().files.info({ workspaceId, path })),
  fileDownloadUrl: (workspaceId: string, path: string) =>
    `${currentSource().httpBase}/api/workspaces/${workspaceId}/file-download?path=${query(path)}`,
  importFiles: (
    workspaceId: string,
    entries: { file: File; path: string }[],
    directories: string[] = [],
  ) => {
    const body = new FormData();
    body.append(
      "manifest",
      JSON.stringify({
        paths: entries.map((entry) => entry.path),
        directories,
      }),
    );
    entries.forEach((entry, index) =>
      body.append(String(index), entry.file, entry.file.name),
    );
    return request(
      `/api/workspaces/${workspaceId}/imports`,
      importFilesResponseSchema,
      { method: "POST", body },
    );
  },
  importLocalFiles: async (workspaceId: string, paths: readonly string[]) =>
    importFilesResponseSchema.parse(
      await rpc().files.importLocal({ workspaceId, paths: [...paths] }),
    ),
  listFiles: async (workspaceId: string, path = ".") =>
    fileListSchema.parse(await rpc().files.list({ workspaceId, path })),
  readFile: async (workspaceId: string, path: string) =>
    fileContentSchema.parse(await rpc().files.read({ workspaceId, path })),
  /**
   * 原子写入；已有文件必须携带内容SHA，缺省仅创建新文件。
   */
  writeFile: async (
    workspaceId: string,
    path: string,
    content: string,
    expectedSize?: number,
    expectedSha256?: string,
    /** Re-emit the BOM the read stripped, so a file that had one keeps it. */
    bom?: boolean,
  ) =>
    writeFileResponseSchema.parse(
      await rpc().files.write({
        workspaceId,
        ...writeFileRequestSchema.parse({
          path,
          content,
          ...(expectedSize === undefined ? {} : { expectedSize }),
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
          ...(bom ? { bom } : {}),
        }),
      }),
    ),
  /** 新建文件 / 新建文件夹；同名一律 409，不覆盖。 */
  createFileEntry: async (
    workspaceId: string,
    path: string,
    kind: FileEntryKind,
  ) =>
    fileEntryResultSchema.parse(
      await rpc().files.create({
        workspaceId,
        ...createFileEntryRequestSchema.parse({ path, kind }),
      }),
    ),
  /** 重命名与移动是同一件事，只差目标路径。 */
  renameFileEntry: async (workspaceId: string, from: string, to: string) =>
    fileEntryResultSchema.parse(
      await rpc().files.rename({
        workspaceId,
        ...renameFileEntryRequestSchema.parse({ from, to }),
      }),
    ),
  /** 删除到工作区 `.armadra/trash/`，不做永久删除。 */
  trashFileEntry: async (workspaceId: string, path: string) =>
    trashEntrySchema.parse(await rpc().files.trash({ workspaceId, path })),
  listTrash: async (workspaceId: string) =>
    trashListSchema.parse(await rpc().files.trashList({ workspaceId })),
  restoreTrash: async (workspaceId: string, id: string) =>
    fileEntryResultSchema.parse(await rpc().files.restore({ workspaceId, id })),
  /**
   * 在 core 所在机器的文件管理器里定位工作区内的一项（`.` 是根目录）。
   * 越界判定在 core：壳的白名单不收工作区根目录。
   */
  revealFileEntry: async (workspaceId: string, path: string) =>
    z
      .object({ ok: z.boolean() })
      .parse(await rpc().files.reveal({ workspaceId, path })),
  /**
   * 声明某个编辑器节点正打开这个文件（E01/M4）。
   * `status: "unsupported"` 表示这台机器没有可用的监听后端，改用 `fileVersion`。
   */
  watchFile: async (workspaceId: string, path: string, nodeId: string) =>
    watchRegistrationSchema.parse(
      await rpc().files.watch({
        workspaceId,
        ...watchFileRequestSchema.parse({ path, nodeId }),
      }),
    ),
  unwatchFile: async (
    workspaceId: string,
    path: string,
    nodeId: string,
  ): Promise<undefined> => {
    await rpc().files.unwatch({ workspaceId, path, nodeId });
    return undefined;
  },
  /** 按需版本检查：文件不存在也是正常回答（`exists: false`），不是 404。 */
  fileVersion: async (workspaceId: string, path: string) =>
    fileVersionSchema.parse(await rpc().files.version({ workspaceId, path })),
});
