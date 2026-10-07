import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { currentSource, localSource, type Source } from "../api/source";
import { useSourceSwitchCacheReset } from "../app/use-sources-bootstrap";
import type { SourceConnection } from "./connection";
import { type SourceRegistry, createSourceRegistry } from "./registry";
import { sk } from "./scope";
import type { SourceDescriptor } from "./types";

/**
 * 两个源的数据不串（A1-2 / A1-4 留下的一项）：不带源前缀的查询（设置、用量、
 * Agent 列表……）在换当前源时作废并向新源重取，上一个源晚到的答案不落进
 * 缓存；带源前缀的各归各的源。
 */

const REMOTE: SourceDescriptor = {
  sourceId: "remote-a",
  kind: "direct",
  label: "A",
  baseUrl: "https://remote-a.example",
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex: 0,
};

function remoteConnection(d: SourceDescriptor): SourceConnection {
  const source: Source = {
    ...localSource,
    sourceId: d.sourceId,
    httpBase: d.baseUrl,
    wsBase: d.baseUrl.replace(/^https/, "wss"),
  };
  return {
    descriptor: d,
    status: { state: "ready", via: "direct", since: 0, lastError: null },
    subscribe: () => () => undefined,
    source,
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    connect: async () => undefined,
    disconnect: () => undefined,
    renew: async () => undefined,
    revoke: () => undefined,
  };
}

let registry: SourceRegistry | null = null;
afterEach(() => {
  registry?.dispose();
  registry = null;
});

/** 一个「答此刻当前源是谁」的读数；`hold` 时挂着，由测试放行。 */
function makeReader() {
  const pending: { sourceId: string; resolve: (value: string) => void }[] = [];
  let hold = false;
  const read = vi.fn(() => {
    const sourceId = currentSource().sourceId;
    if (!hold) return Promise.resolve(sourceId);
    return new Promise<string>((resolve) =>
      pending.push({ sourceId, resolve }),
    );
  });
  return {
    read,
    pending,
    holdNext(value: boolean) {
      hold = value;
    },
  };
}

function setup() {
  registry = createSourceRegistry({ global: true, connect: remoteConnection });
  registry.add(REMOTE);
  const table = registry;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { table, client, wrapper };
}

describe("切源时两个源的数据不串", () => {
  it("有人在看的不带源前缀的查询：换源后向新源重取，不留上一个源的答案", async () => {
    const { table, client, wrapper } = setup();
    const reader = makeReader();
    const { result } = renderHook(
      () => {
        useSourceSwitchCacheReset(() => table);
        return useQuery({ queryKey: ["settings"], queryFn: reader.read });
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe("local"));

    act(() => table.setCurrent("remote-a"));
    await waitFor(() => expect(result.current.data).toBe("remote-a"));
    expect(client.getQueryData(["settings"])).toBe("remote-a");

    act(() => table.setCurrent("local"));
    await waitFor(() => expect(result.current.data).toBe("local"));
  });

  it("上一个源在路上的答案换源之后才到：不落进缓存", async () => {
    const { table, client, wrapper } = setup();
    const reader = makeReader();
    reader.holdNext(true);
    const { result } = renderHook(
      () => {
        useSourceSwitchCacheReset(() => table);
        return useQuery({ queryKey: ["agents"], queryFn: reader.read });
      },
      { wrapper },
    );
    await waitFor(() => expect(reader.pending).toHaveLength(1));
    expect(reader.pending[0]!.sourceId).toBe("local");

    reader.holdNext(false);
    act(() => table.setCurrent("remote-a"));
    await waitFor(() => expect(result.current.data).toBe("remote-a"));
    // 本机那一份现在才答：已经作废，不覆盖 remote-a 的。
    await act(async () => reader.pending[0]!.resolve("local"));
    expect(client.getQueryData(["agents"])).toBe("remote-a");
    expect(result.current.data).toBe("remote-a");
  });

  it("带源前缀的查询各归各的源：换源不清，切回来不必重取", async () => {
    const { table, client, wrapper } = setup();
    const local = vi.fn(async () => ["local-workspace"]);
    renderHook(
      () => {
        useSourceSwitchCacheReset(() => table);
        return useQuery({ queryKey: sk("workspaces"), queryFn: local });
      },
      { wrapper },
    );
    await waitFor(() =>
      expect(client.getQueryData(["src", "local", "workspaces"])).toEqual([
        "local-workspace",
      ]),
    );
    client.setQueryData(["src", "remote-a", "workspaces"], ["remote-ws"]);
    act(() => table.setCurrent("remote-a"));
    expect(client.getQueryData(["src", "local", "workspaces"])).toEqual([
      "local-workspace",
    ]);
    expect(client.getQueryData(["src", "remote-a", "workspaces"])).toEqual([
      "remote-ws",
    ]);
    expect(local).toHaveBeenCalledTimes(1);
  });
});
