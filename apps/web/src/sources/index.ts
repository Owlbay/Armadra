/**
 * 多源连接层（客户端包 §1）：源表、连接、凭据来源、选路与托管的流。
 */
export * from "./types";
export {
  type SourceConnection,
  type SourceSocketOptions,
  type RemoteConnectionOptions,
  createRemoteConnection,
} from "./connection";
export {
  type SourceRegistry,
  type SourceLoader,
  type SourceRegistryOptions,
  createSourceRegistry,
  loadSourcesFromLocalCore,
  resetSourceRegistry,
  sourceRegistry,
} from "./registry";
export {
  type AccessExchange,
  ACCESS_RENEW_LEAD_MS,
  createCachedCredentialProvider,
  createDesktopCredentialProvider,
  exchangeViaLocalCore,
} from "./credentials";
export { type SessionTokens, createSessionTokens } from "./session-tokens";
export {
  DIRECT_PROBE_TIMEOUT_MS,
  type Route,
  candidateRoutes,
  pickRoute,
  probeDirect,
} from "./routing";
export {
  ManagedSocket,
  type ManagedSocketOptions,
  type ManagedSocketState,
  type SocketEnvironment,
} from "./managed-socket";
export * from "./local";
export {
  SourcesProvider,
  useCurrentSource,
  useSource,
  useSourceStatus,
  useSources,
} from "./context";
