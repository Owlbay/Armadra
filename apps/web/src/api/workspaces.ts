import {
  createWorkspaceRequestSchema,
  openRemoteWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListSchema,
  workspaceSchema,
  type CreateWorkspaceRequest,
  type OpenRemoteWorkspaceRequest,
  type UpdateWorkspaceRequest,
} from "@armadra/shared";
import type { ArmadraClient } from "./client";
import { query, request } from "./request";

/**
 * 工作空间（契约 §34.4，第一批迁到契约上的域）。
 *
 * 调用经 RPC 客户端（`client.workspaces.*`），答案仍过页面自己的 schema——
 * 本地工作空间不带 `executionHostId`，这里补成 `""`，调用点看到的形状与迁移前
 * 一样。客户端由 `api/client.ts` 交进来：这个模块被它 import，反过来 import
 * 它就是一个环。多部分上传的导入留在 REST。
 */
export const workspacesApiFor = (rpc: () => ArmadraClient) => ({
  /* --------------------------------- 工作空间 --------------------------- */
  listWorkspaces: async () =>
    workspaceListSchema.parse(await rpc().workspaces.list({})),
  createWorkspace: async (input: CreateWorkspaceRequest) =>
    workspaceSchema.parse(
      await rpc().workspaces.create(createWorkspaceRequestSchema.parse(input)),
    ),
  updateWorkspace: async (workspaceId: string, patch: UpdateWorkspaceRequest) =>
    workspaceSchema.parse(
      await rpc().workspaces.update({
        workspaceId,
        ...updateWorkspaceRequestSchema.parse(patch),
      }),
    ),
  openWorkspace: async (workspaceId: string) =>
    workspaceSchema.parse(await rpc().workspaces.open({ workspaceId })),
  /** 从列表移除：Runtime 删库里的这条记录，磁盘上的项目不动（§20）。 */
  deleteWorkspace: async (workspaceId: string): Promise<undefined> => {
    await rpc().workspaces.delete({ workspaceId });
    return undefined;
  },

  /**
   * Open a project that lives on an SSH execution host (H02). The path is a
   * path on that host and is proven there, not here: an unreachable host or a
   * missing remote Worker fails instead of producing a workspace that quietly
   * reads local files.
   */
  openRemoteWorkspace: async (input: OpenRemoteWorkspaceRequest) =>
    workspaceSchema.parse(
      await rpc().workspaces.openRemote(
        openRemoteWorkspaceRequestSchema.parse(input),
      ),
    ),

  /* ----------------------------------- 工作区导入 ----------------------- */
  openDirectory: async (input: CreateWorkspaceRequest) =>
    workspaceSchema.parse(
      await rpc().workspaces.openDirectory(
        createWorkspaceRequestSchema.parse(input),
      ),
    ),
  importWorkspace: (folder: {
    name: string;
    files: { file: File; path: string }[];
    directories: string[];
  }) => {
    const body = new FormData();
    body.append(
      "manifest",
      JSON.stringify({
        paths: folder.files.map((entry) => entry.path),
        directories: folder.directories,
      }),
    );
    folder.files.forEach((entry, index) =>
      body.append(String(index), entry.file, entry.file.name),
    );
    return request(
      `/api/workspaces/import?name=${query(Array.from(folder.name).slice(0, 120).join(""))}`,
      workspaceSchema,
      { method: "POST", body },
    );
  },
});
