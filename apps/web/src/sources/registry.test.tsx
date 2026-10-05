import { act, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentSource,
  knownSources,
  localSource,
  sourceForUrl,
} from "../api/source";
import type { SourceConnection } from "./connection";
import {
  SourcesProvider,
  useCurrentSource,
  useSourceStatus,
  useSources,
} from "./context";
import {
  type SourceRegistry,
  createSourceRegistry,
  loadSourcesFromLocalCore,
} from "./registry";
import type { SourceDescriptor, SourceStatus } from "./types";

const descriptor = (
  sourceId: string,
  orderIndex: number,
  overrides: Partial<SourceDescriptor> = {},
): SourceDescriptor => ({
  sourceId,
  kind: "direct",
  label: sourceId,
  baseUrl: `https://${sourceId}.example`,
  relayOrigin: "",
  cloudIssuer: "",
  fingerprint: "",
  orderIndex,
  ...overrides,
});

/** 一条假的远程连接：`connect` 按给的行为走，状态可订阅。 */
function fakeConnection(
  d: SourceDescriptor,
  behaviour: "ok" | "throw" | "hang" = "ok",
): SourceConnection & { disconnected: boolean } {
  const listeners = new Set<() => void>();
  let status: SourceStatus = {
    state: "idle",
    via: null,
    since: 0,
    lastError: null,
  };
  const connection = {
    descriptor: d,
    disconnected: false,
    get status() {
      return status;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    source: {
      ...localSource,
      sourceId: d.sourceId,
      httpBase: d.baseUrl,
      wsBase: d.baseUrl.replace(/^https/, "wss"),
    },
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(),
    socket: () => {
      throw new Error("unused");
    },
    async connect() {
      if (behaviour === "throw") throw new Error("unreachable");
      if (behaviour === "hang") return new Promise<void>(() => undefined);
      status = { state: "ready", via: "direct", since: 1, lastError: null };
      for (const listener of listeners) listener();
    },
    disconnect() {
      connection.disconnected = true;
    },
    renew: async () => undefined,
  };
  return connection as unknown as SourceConnection & {
    disconnected: boolean;
  };
}

let registry: SourceRegistry | null = null;
afterEach(() => {
  registry?.dispose();
  registry = null;
  vi.unstubAllGlobals();
});

function make(
  behaviours: Record<string, "ok" | "throw" | "hang"> = {},
  global = false,
) {
  const made: Record<string, ReturnType<typeof fakeConnection>> = {};
  registry = createSourceRegistry({
    global,
    connect: (d) =>
      (made[d.sourceId] = fakeConnection(d, behaviours[d.sourceId] ?? "ok")),
  });
  return { registry, made };
}

describe("源表", () => {
  it("只有本机源：本机就是当前源", () => {
    const { registry } = make();
    expect(registry.list().map((c) => c.descriptor.sourceId)).toEqual([
      "local",
    ]);
    expect(registry.current()).toBe(registry.local());
    expect(registry.local().source).toBe(localSource);
  });

  it("远程源 connect 抛错或一直不答，都不挡 hydrate 与本机源", async () => {
    const { registry, made } = make({ bad: "throw", slow: "hang" });
    await registry.hydrate(async () => [
      descriptor("bad", 1),
      descriptor("slow", 2),
      descriptor("good", 3),
    ]);
    expect(registry.list().map((c) => c.descriptor.sourceId)).toEqual([
      "local",
      "bad",
      "slow",
      "good",
    ]);
    expect(registry.local().status.state).toBe("ready");
    expect(made.good!.status.state).toBe("ready");
  });

  it("加载器失败：保留现状", async () => {
    const { registry } = make();
    registry.add(descriptor("one", 1));
    await registry.hydrate(async () => {
      throw new Error("404");
    });
    expect(registry.list()).toHaveLength(2);
  });

  it("排序：本机永远第一，其余按 orderIndex；本机行不收进来", async () => {
    const { registry } = make();
    await registry.hydrate(async () => [
      descriptor("z", 2),
      descriptor("y", 1),
      { ...descriptor("local", 0), kind: "local" },
    ]);
    expect(registry.list().map((c) => c.descriptor.sourceId)).toEqual([
      "local",
      "y",
      "z",
    ]);
  });

  it("再 hydrate：没了的断开移除，没变的留着不重连，变了的换掉", async () => {
    const { registry, made } = make();
    await registry.hydrate(async () => [
      descriptor("keep", 1),
      descriptor("gone", 2),
      descriptor("moved", 3),
    ]);
    const keep = made.keep!;
    const gone = made.gone!;
    const moved = made.moved!;
    await registry.hydrate(async () => [
      descriptor("keep", 1),
      descriptor("moved", 0),
    ]);
    expect(registry.get("keep")).toBe(keep);
    expect(gone.disconnected).toBe(true);
    expect(registry.get("gone")).toBeUndefined();
    expect(moved.disconnected).toBe(true);
    expect(registry.get("moved")).not.toBe(moved);
    expect(registry.list().map((c) => c.descriptor.sourceId)).toEqual([
      "local",
      "moved",
      "keep",
    ]);
  });

  it("本机源移不掉；当前源被移除时退回本机", () => {
    const { registry } = make();
    registry.add(descriptor("one", 1));
    registry.setCurrent("one");
    expect(registry.current().descriptor.sourceId).toBe("one");
    registry.remove("local");
    expect(registry.get("local")).toBe(registry.local());
    registry.remove("one");
    expect(registry.current()).toBe(registry.local());
    registry.setCurrent("nope");
    expect(registry.current()).toBe(registry.local());
  });

  it("页面那张源表：当前源接到 api/source，挂载的源能按地址找到", () => {
    const { registry } = make({}, true);
    expect(currentSource()).toBe(localSource);
    const one = registry.add(descriptor("one", 1));
    expect(knownSources()).toContain(one.source);
    expect(sourceForUrl("https://one.example/api/workspaces/w/assets/a")).toBe(
      one.source,
    );
    registry.setCurrent("one");
    expect(currentSource()).toBe(one.source);
    registry.remove("one");
    expect(currentSource()).toBe(localSource);
    expect(knownSources()).toEqual([localSource]);
    registry.dispose();
    expect(currentSource()).toBe(localSource);
  });

  it("测试里的源表不碰全局", () => {
    const { registry } = make();
    const one = registry.add(descriptor("one", 1));
    registry.setCurrent("one");
    expect(currentSource()).toBe(localSource);
    expect(knownSources()).not.toContain(one.source);
  });
});

describe("本机 core 的源表加载器", () => {
  it("GET /api/sources → 源描述（凭据不在答案里）", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sources: [
              {
                ...descriptor("one", 1),
                principalHint: "p",
                addedAtMs: 1,
                lastOkAtMs: 2,
                hasCredentials: true,
              },
            ],
            remotes: [],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(loadSourcesFromLocalCore()).resolves.toEqual([
      descriptor("one", 1),
    ]);
    expect(String(fetch.mock.calls[0]![0 as never])).toBe(
      `${localSource.httpBase}/api/sources`,
    );
  });
});

describe("React 钩子", () => {
  it("useSources / useCurrentSource / useSourceStatus 跟着源表变", () => {
    const { registry } = make();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <SourcesProvider registry={registry}>{children}</SourcesProvider>
    );
    const hook = renderHook(
      () => {
        const sources = useSources();
        const current = useCurrentSource();
        const status = useSourceStatus(sources[1]);
        return { sources, current, status };
      },
      { wrapper },
    );
    expect(hook.result.current.sources).toHaveLength(1);
    expect(hook.result.current.status.state).toBe("idle");
    act(() => {
      registry.add(descriptor("one", 1, {}));
    });
    expect(hook.result.current.sources).toHaveLength(2);
    expect(hook.result.current.status.state).toBe("ready");
    act(() => registry.setCurrent("one"));
    expect(hook.result.current.current.descriptor.sourceId).toBe("one");
  });
});
