import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Source } from "../api/source";
import { localSource } from "../api/source";
import { SourcesProvider } from "../sources/context";
import { createSourceRegistry } from "../sources/registry";
import type { SourceConnection } from "../sources/connection";
import type { SourceDescriptor } from "../sources/types";

const calls: string[] = [];
const rows: Record<string, { id: string; name: string }[]> = {
  local: [{ id: "w1", name: "本机" }],
  remote: [{ id: "w1", name: "远程" }],
};

vi.mock("../api/client", () => ({
  clientFor: (source: Source) => ({ sourceId: source.sourceId }),
  runtimeApi: {
    listWorkspaces: async () => {
      calls.push("local");
      return rows.local;
    },
  },
}));
vi.mock("../api/workspaces", () => ({
  workspacesApiFor: (rpc: () => { sourceId: string }) => ({
    listWorkspaces: async () => {
      const { sourceId } = rpc();
      calls.push(sourceId);
      return rows[sourceId] ?? [];
    },
  }),
}));

const { useWorkspaces, useWorkspacesQuery } = await import(
  "./workspaces-query"
);

function remoteDescriptor(): SourceDescriptor {
  return {
    sourceId: "remote",
    kind: "direct",
    label: "remote",
    baseUrl: "https://remote.example",
    relayOrigin: "",
    cloudIssuer: "",
    fingerprint: "",
    orderIndex: 1,
  };
}

function fakeRemote(d: SourceDescriptor): SourceConnection {
  const status = {
    state: "ready" as const,
    via: "direct" as const,
    since: 1,
    lastError: null,
  };
  return {
    descriptor: d,
    status,
    subscribe: () => () => undefined,
    source: { ...localSource, sourceId: d.sourceId },
    client: {},
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    disconnect: () => undefined,
    renew: async () => undefined,
  } as unknown as SourceConnection;
}

afterEach(() => {
  calls.length = 0;
});

function wrapperFor(registry: ReturnType<typeof createSourceRegistry>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <SourcesProvider registry={registry}>{children}</SourcesProvider>
    </QueryClientProvider>
  );
  return { Wrapper, client };
}

describe("useWorkspaces", () => {
  it("每个就绪的源各发一次，合并成 { sourceId, workspace }[]，本机在前", async () => {
    const registry = createSourceRegistry({ connect: fakeRemote });
    registry.add(remoteDescriptor());
    const { Wrapper, client } = wrapperFor(registry);
    const { result } = renderHook(() => useWorkspaces(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(
      result.current.data.map((row) => [row.sourceId, row.workspace.name]),
    ).toEqual([
      ["local", "本机"],
      ["remote", "远程"],
    ]);
    // 同名的工作空间 id 在两个源里是两份缓存。
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([
      ["src", "local", "workspaces"],
      ["src", "remote", "workspaces"],
    ]);
    registry.dispose();
  });

  it("零配置（只有本机源）：只发一个请求，与 useWorkspacesQuery 共用缓存", async () => {
    const registry = createSourceRegistry();
    const { Wrapper } = wrapperFor(registry);
    const { result } = renderHook(
      () => ({ many: useWorkspaces(), one: useWorkspacesQuery() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.one.data).toHaveLength(1));
    await waitFor(() => expect(result.current.many.data).toHaveLength(1));
    expect(result.current.many.data[0]!.sourceId).toBe("local");
    expect(calls).toEqual(["local"]);
    registry.dispose();
  });
});
