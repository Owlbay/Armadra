import { useQueries, useQuery } from "@tanstack/react-query";
import type { WorkspaceSummary } from "@armadra/shared";

import { clientFor, runtimeApi } from "../api/client";
import { workspacesApiFor } from "../api/workspaces";
import { useSources } from "../sources/context";
import { srcKey } from "../sources/scope";
import { sk } from "../sources/scope";

/**
 * 工作空间列表（`GET /api/workspaces`）。
 *
 * 首页删掉之后（§27）这份查询只剩侧栏在用：顶行下拉列已知工作空间、
 * 「项目」组按 `openWorkspaceIds` 排行、`useBoardSync` 启动时按 id 找回
 * 上次那个。所以它从 `WorkspaceGrid` 搬到这里，独立成一个模块。
 *
 * `retry: false` 是刻意的：Runtime 连不上时要立刻把错误状态交出去，
 * 而不是先卡三次重试。但错误状态下每 3 秒自己探一次——桌面壳重启 Runtime、
 * 或 `pnpm dev` 那边刚起来时，界面自己就回来了（`useBoardSync` 随后会把
 * 上次的工作空间接上），用户不必做任何事。
 */
const RECONNECT_POLL_MS = 3_000;

export function useWorkspacesQuery() {
  return useQuery({
    queryKey: sk("workspaces"),
    queryFn: runtimeApi.listWorkspaces,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      query.state.status === "error" ? RECONNECT_POLL_MS : false,
  });
}

/** 某个源里的一个工作空间。 */
export interface SourcedWorkspace {
  readonly sourceId: string;
  readonly workspace: WorkspaceSummary;
}

/**
 * 全部「就绪」的源各发一次，合并成 `{ sourceId, workspace }[]`（客户端包 §2）。
 * 本机在前；只有本机源时与 {@link useWorkspacesQuery} 是同一份缓存、同一个请求。
 */
export function useWorkspaces() {
  const sources = useSources();
  const ready = sources.filter(
    (connection) =>
      connection.descriptor.kind === "local" ||
      connection.status.state === "ready",
  );
  const results = useQueries({
    queries: ready.map((connection) => ({
      queryKey: srcKey(connection.source.sourceId, "workspaces"),
      queryFn: () =>
        workspacesApiFor(() => clientFor(connection.source)).listWorkspaces(),
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: (query: { state: { status: string } }) =>
        query.state.status === "error" ? RECONNECT_POLL_MS : false,
    })),
  });
  const data: SourcedWorkspace[] = [];
  results.forEach((result, index) => {
    const sourceId = ready[index]!.source.sourceId;
    for (const workspace of result.data ?? []) {
      data.push({ sourceId, workspace });
    }
  });
  return {
    data,
    isPending: results.some((result) => result.isPending),
    isError: results.length > 0 && results.every((result) => result.isError),
    results,
  };
}
