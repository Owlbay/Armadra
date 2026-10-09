import { localSource, type Source } from "../../api/source";
import type { SourceConnection } from "../../sources/connection";
import {
  type SourceRegistry,
  createSourceRegistry,
} from "../../sources/registry";
import type { SourceDescriptor, SourceState } from "../../sources/types";

/**
 * 「切换服务」对话框的样本源表（A7-1）：本机、经个人中转的两台、直连的一台。
 * 连接是假的——状态钉住，不发任何请求。名字是用户数据，不进 i18n。
 */
const ISSUER = "https://relay.example.com";

const SAMPLES: readonly (SourceDescriptor & { state: SourceState })[] = [
  {
    sourceId: "5e1f0c2a9b8d4e7f6a5b4c3d2e1f0a9b",
    kind: "relayed",
    label: "Workstation",
    baseUrl: "",
    relayOrigin: ISSUER,
    cloudIssuer: ISSUER,
    fingerprint: "",
    orderIndex: 0,
    state: "ready",
  },
  {
    sourceId: "9a8b7c6d5e4f30211203f4e5d6c7b8a9",
    kind: "relayed",
    label: "build-box",
    baseUrl: "",
    relayOrigin: ISSUER,
    cloudIssuer: ISSUER,
    fingerprint: "",
    orderIndex: 1,
    state: "offline",
  },
  {
    sourceId: "0f9e8d7c6b5a49382716f5e4d3c2b1a0",
    kind: "direct",
    label: "Studio",
    baseUrl: "https://192.168.1.8:8443",
    relayOrigin: "",
    cloudIssuer: "",
    fingerprint: "",
    orderIndex: 2,
    state: "connecting",
  },
];

function pinned(descriptor: SourceDescriptor, state: SourceState) {
  const source: Source = {
    ...localSource,
    sourceId: descriptor.sourceId,
    httpBase: descriptor.baseUrl || ISSUER,
    wsBase: (descriptor.baseUrl || ISSUER).replace(/^https/, "wss"),
  };
  const connection: SourceConnection = {
    descriptor,
    status: { state, via: null, since: 0, lastError: null },
    subscribe: () => () => undefined,
    source,
    client: {} as SourceConnection["client"],
    hello: null,
    request: async () => new Response(null, { status: 503 }),
    socket: () => {
      throw new Error("showcase");
    },
    connect: async () => undefined,
    disconnect: () => undefined,
    renew: async () => undefined,
    revoke: () => undefined,
  };
  return connection;
}

let registry: SourceRegistry | null = null;

export function showcaseSourceRegistry(): SourceRegistry {
  if (registry !== null) return registry;
  const states = new Map(SAMPLES.map((one) => [one.sourceId, one.state]));
  registry = createSourceRegistry({
    connect: (descriptor) =>
      pinned(descriptor, states.get(descriptor.sourceId) ?? "idle"),
  });
  for (const { state: _state, ...descriptor } of SAMPLES)
    registry.add(descriptor);
  return registry;
}
