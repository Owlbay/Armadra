import { z } from "zod";

import { request } from "../api/request";
import {
  localSource,
  registerSource,
  setCurrentSourceResolver,
} from "../api/source";
import {
  type RemoteConnectionOptions,
  type SourceConnection,
  createLocalConnection,
  createRemoteConnection,
} from "./connection";
import { createDesktopCredentialProvider } from "./credentials";
import type { CredentialProvider, SourceDescriptor } from "./types";

/**
 * 源表（客户端包 §1.1）：本机源永远在、永远第一；别的源来自一个加载器——
 *
 * - 桌面与服务器壳的页面：本机 core 的源表（`GET /api/sources`，契约 §33），
 *   {@link loadSourcesFromLocalCore}；
 * - 手机：本地存储里的源表（A1-5）；
 * - 云页面：云会话（SaaS 页面）。
 *
 * `hydrate` 换上加载到的那一批：每个远程源在后台各自连，连不上只是那一个
 * 源的状态，不挡本机源、也不让 `hydrate` 失败。
 */
export interface SourceRegistry {
  /** 本机在前，其余按 `orderIndex`、再按标识。快照：没变就是同一个数组。 */
  list(): readonly SourceConnection[];
  get(sourceId: string): SourceConnection | undefined;
  local(): SourceConnection;
  /** 当前源：省略了源的 `api/*` 调用发往它。缺省本机。 */
  current(): SourceConnection;
  setCurrent(sourceId: string): void;
  /** 加一个远程源（同一个标识已有就换掉旧的）并在后台连。 */
  add(descriptor: SourceDescriptor): SourceConnection;
  /** 移除一个远程源并断开；本机源移不掉。 */
  remove(sourceId: string): void;
  /** 用加载器换上整批远程源；加载失败保留现状（本机源总在）。 */
  hydrate(load: SourceLoader): Promise<void>;
  /** 成员或当前源变了时通知（各源自己的状态订阅各自的连接）。 */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export type SourceLoader = () => Promise<readonly SourceDescriptor[]>;

export interface SourceRegistryOptions {
  readonly local?: SourceConnection;
  /** 远程源的凭据来源；缺省经本机 core 换票（桌面与服务器壳）。 */
  readonly provider?: CredentialProvider;
  /** 造远程连接（测试注入）。 */
  readonly connect?: (descriptor: SourceDescriptor) => SourceConnection;
  /** 远程连接的其余选项（`fetch`、`WebSocket` 等）。 */
  readonly remote?: Omit<RemoteConnectionOptions, "provider">;
  /**
   * 这是页面的那张源表：把「当前源」接到 `api/source.ts`，把挂载的源登记给
   * 按地址找源的发送点（`<img>` 取图、下载）。测试里的源表不接。
   */
  readonly global?: boolean;
}

function byOrder(a: SourceConnection, b: SourceConnection): number {
  if (a.descriptor.kind === "local") return -1;
  if (b.descriptor.kind === "local") return 1;
  return (
    a.descriptor.orderIndex - b.descriptor.orderIndex ||
    (a.descriptor.sourceId < b.descriptor.sourceId ? -1 : 1)
  );
}

export function createSourceRegistry(
  options: SourceRegistryOptions = {},
): SourceRegistry {
  const local = options.local ?? createLocalConnection();
  let provider = options.provider;
  const connect =
    options.connect ??
    ((descriptor: SourceDescriptor) =>
      createRemoteConnection(descriptor, {
        ...options.remote,
        provider: (provider ??= createDesktopCredentialProvider()),
      }));
  const remotes = new Map<
    string,
    { connection: SourceConnection; unregister: () => void }
  >();
  const listeners = new Set<() => void>();
  let currentId = local.descriptor.sourceId;
  let snapshot: readonly SourceConnection[] = [local];
  let disposed = false;

  const changed = () => {
    snapshot = [
      local,
      ...[...remotes.values()].map((entry) => entry.connection),
    ].sort(byOrder);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* 一个订阅者出错不拖垮别的。 */
      }
    }
  };

  const drop = (sourceId: string) => {
    const entry = remotes.get(sourceId);
    if (entry === undefined) return false;
    remotes.delete(sourceId);
    entry.unregister();
    entry.connection.disconnect();
    if (currentId === sourceId) currentId = local.descriptor.sourceId;
    return true;
  };

  const put = (descriptor: SourceDescriptor) => {
    drop(descriptor.sourceId);
    const connection = connect(descriptor);
    remotes.set(descriptor.sourceId, {
      connection,
      unregister: options.global
        ? registerSource(connection.source)
        : () => undefined,
    });
    // 连接在后台：失败落在这个源的状态里，不抛给加入它的人。
    void connection.connect().catch(() => undefined);
    return connection;
  };

  const registry: SourceRegistry = {
    list: () => snapshot,
    get: (sourceId) =>
      sourceId === local.descriptor.sourceId
        ? local
        : remotes.get(sourceId)?.connection,
    local: () => local,
    current: () => registry.get(currentId) ?? local,
    setCurrent(sourceId) {
      const next = registry.get(sourceId)
        ? sourceId
        : local.descriptor.sourceId;
      if (next === currentId) return;
      currentId = next;
      changed();
    },
    add(descriptor) {
      if (
        descriptor.kind === "local" ||
        descriptor.sourceId === local.descriptor.sourceId
      )
        return local;
      const connection = put(descriptor);
      changed();
      return connection;
    },
    remove(sourceId) {
      if (drop(sourceId)) changed();
    },
    async hydrate(load) {
      let descriptors: readonly SourceDescriptor[];
      try {
        descriptors = await load();
      } catch {
        return;
      }
      if (disposed) return;
      const wanted = new Map<string, SourceDescriptor>();
      for (const descriptor of descriptors) {
        if (
          descriptor.kind === "local" ||
          descriptor.sourceId === local.descriptor.sourceId
        )
          continue;
        wanted.set(descriptor.sourceId, descriptor);
      }
      for (const sourceId of [...remotes.keys()]) {
        if (!wanted.has(sourceId)) drop(sourceId);
      }
      for (const descriptor of wanted.values()) {
        const existing = remotes.get(descriptor.sourceId)?.connection;
        // 同一个源描述没变就留着那条连接（不重连）。
        if (
          existing !== undefined &&
          JSON.stringify(existing.descriptor) === JSON.stringify(descriptor)
        )
          continue;
        put(descriptor);
      }
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      for (const sourceId of [...remotes.keys()]) drop(sourceId);
      listeners.clear();
      snapshot = [local];
      if (options.global) setCurrentSourceResolver(null);
    },
  };

  if (options.global) setCurrentSourceResolver(() => registry.current().source);
  return registry;
}

/* ------------------------------ 本机 core 的源表 ----------------------------- */

const clientSourceSchema = z.object({
  sourceId: z.string().min(1),
  kind: z.enum(["local", "direct", "relayed", "hosted"]),
  label: z.string().default(""),
  baseUrl: z.string().default(""),
  relayOrigin: z.string().default(""),
  cloudIssuer: z.string().default(""),
  fingerprint: z.string().default(""),
  orderIndex: z.number().default(0),
});

const sourceListSchema = z.object({
  sources: z.array(clientSourceSchema),
});

/**
 * 桌面与服务器壳的页面：本机 core 记住的源（`GET /api/sources`，契约 §33）。
 * 凭据不在答案里（只有 `hasCredentials`），换票走 `sources/credentials.ts`。
 */
export const loadSourcesFromLocalCore: SourceLoader = async () => {
  const answer = await request(
    "/api/sources",
    sourceListSchema,
    undefined,
    localSource,
  );
  return answer.sources.map((source) => ({
    sourceId: source.sourceId,
    kind: source.kind,
    label: source.label,
    baseUrl: source.baseUrl,
    relayOrigin: source.relayOrigin,
    cloudIssuer: source.cloudIssuer,
    fingerprint: source.fingerprint,
    orderIndex: source.orderIndex,
  }));
};

/* -------------------------------- 页面那一张 -------------------------------- */

let pageRegistry: SourceRegistry | null = null;

/**
 * 页面的源表：第一次用到时才建，只有本机源；挂远程源的入口（设置页、手机
 * 连接页、链接落地页）往里 `add` / `hydrate`。不建它时页面照样只连本机。
 */
export function sourceRegistry(): SourceRegistry {
  pageRegistry ??= createSourceRegistry({ global: true });
  return pageRegistry;
}

/**
 * 换上一张带自己凭据来源的页面源表（手机：钥匙串；中继托管的页面：内存）。
 * 在画布挂载之前调：原来那张（若已建）连同它的连接一起拆掉。
 */
export function installPageSourceRegistry(
  options: Omit<SourceRegistryOptions, "global">,
): SourceRegistry {
  pageRegistry?.dispose();
  pageRegistry = createSourceRegistry({ ...options, global: true });
  return pageRegistry;
}

/** 测试换一张源表；传 `null` 丢掉现在那张。 */
export function resetSourceRegistry(next: SourceRegistry | null = null): void {
  pageRegistry?.dispose();
  pageRegistry = next;
}
