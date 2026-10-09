import { MAX_AGENT_UPLOAD_BYTES } from "@armadra/shared";

import type { CoreContext } from "../main";
import { answered, workspaceId } from "../workspaces/routes";
import { DomainError } from "../workspaces/support";
import { getWorkspace } from "../workspaces/table";
import { pruneUploads, storeUpload } from "./uploads";

/** 体上限：一个文件再加一点余量（`Content-Type` 之外没有别的东西）。 */
export const MAX_UPLOAD_BODY_BYTES = MAX_AGENT_UPLOAD_BYTES + 64 * 1024;

export const AGENT_UPLOADS_PATH = "/api/workspaces/{workspaceId}/agent-uploads";

/**
 * `POST /api/workspaces/{id}/agent-uploads?name=<文件名>`（契约 §55）：体是原样的
 * 字节，`Content-Type` 是文件自己的。粘进 Agent 是向它输入，所以要工作空间的
 * `execute` 授权（与开终端同一档）；字节流留在 REST，不进 procedure。
 */
export function install(context: CoreContext): void {
  const database = context.db.database;
  const { server, dataDir } = context;
  server.bodyLimit(AGENT_UPLOADS_PATH, MAX_UPLOAD_BODY_BYTES);

  // 启动时清一遍过期的：这一步失败不挡 core 起来。
  try {
    pruneUploads(dataDir);
  } catch (error) {
    context.log.warn("agent uploads prune failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  server.router.handle(
    "POST",
    AGENT_UPLOADS_PATH,
    answered((match, request) => {
      const workspace = getWorkspace(database, workspaceId(match));
      if (!workspace.permissions.execute) {
        throw new DomainError(
          403,
          "forbidden",
          "This workspace does not allow running agents",
        );
      }
      const name = request.query.get("name");
      if (name !== null && name.length > 1024) {
        throw new DomainError(400, "bad_request", "File name is too long");
      }
      return {
        status: 200,
        body: storeUpload(
          dataDir,
          workspace.id,
          name,
          String(request.headers["content-type"] ?? ""),
          request.body,
        ),
      };
    }),
  );
}
