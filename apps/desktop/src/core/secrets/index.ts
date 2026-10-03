/**
 * 密钥后端的挑选与装配（[外部服务 §12.1](../../../../../docs/design/external-services.md)）。
 *
 * | 条件                                         | 后端                     | 自报                     |
 * | -------------------------------------------- | ------------------------ | ------------------------ |
 * | `ARMADRA_SECRET_BACKEND=file`                | 0600 明文                | `file`                   |
 * | 壳经 `CorePlatform.secrets` 给了一个（服务器壳） | 它                       | 它的                     |
 * | 桌面壳写了 `ARMADRA_SECRET_SEALER=ipc:<kind>`  | `safeStorage` 经 IPC 封存 | `dpapi` / `libsecret`    |
 * | macOS                                        | `security(1)` 钥匙串      | `keychain`               |
 * | 其余                                         | 0600 明文                | `file`                   |
 *
 * 壳说了要用 `safeStorage` 但通道不在（core 被别的壳接管）时，后端拒绝一切而不是
 * 降级成明文。
 */

import { join } from "node:path";

import { type SecretBackend, unavailableBackend } from "./backend";
import { plainFileBackend, sealedFileBackend } from "./file";
import { type IpcChannel, ipcSealer, sealerKindFromEnv } from "./ipc";
import {
  type SecurityTool,
  keychainBackend,
  realSecurityTool,
} from "./keychain";

export * from "./backend";
export {
  encryptedFileBackend,
  loadOrCreateMasterKey,
  masterKeyId,
  plainFileBackend,
  previousKeyFile,
  readMasterKey,
  rotateMasterKey,
  sealedFileBackend,
} from "./file";
export {
  SEALER_ENV,
  SECRETS_MESSAGE,
  ipcSealer,
  sealerKindFromEnv,
  type IpcChannel,
  type SealRequest,
  type SealResponse,
  type SealerKind,
} from "./ipc";
export {
  keychainBackend,
  realSecurityTool,
  type KeychainAddress,
  type SecurityTool,
} from "./keychain";
export {
  migrateLegacySecrets,
  migrationRecordFile,
  type LegacySecret,
  type MigrationResult,
} from "./migrate";
export { SecretStore, legacyFile, legacyKeychain } from "./store";

/** 数据目录里放密钥文件的地方。 */
export function secretsDirectory(dataDir: string): string {
  return join(dataDir, "secrets");
}

/** `ARMADRA_SECRET_BACKEND=file`：测试与无人值守用，强制明文 0600。 */
export function forcedFileBackend(env: NodeJS.ProcessEnv): boolean {
  return (env.ARMADRA_SECRET_BACKEND ?? "").trim().toLowerCase() === "file";
}

export interface ResolveOptions {
  readonly dataDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 壳注入的后端（服务器壳）。 */
  readonly injected?: SecretBackend | undefined;
  /** fork 的 IPC 通道；桌面壳起的 core 里就是 `process`。 */
  readonly channel?: IpcChannel | undefined;
  readonly platform?: NodeJS.Platform;
  readonly security?: SecurityTool;
}

export interface ResolvedSecrets {
  readonly backend: SecretBackend;
  readonly dataDir: string;
  /** 读旧钥匙串条目用的工具；只在 `backend.kind === "keychain"` 时有意义。 */
  readonly security: SecurityTool;
}

export function resolveSecretBackend(options: ResolveOptions): ResolvedSecrets {
  const env = options.env ?? process.env;
  const security = options.security ?? realSecurityTool;
  const directory = secretsDirectory(options.dataDir);
  const done = (backend: SecretBackend): ResolvedSecrets => ({
    backend,
    dataDir: options.dataDir,
    security,
  });
  if (forcedFileBackend(env)) return done(plainFileBackend(directory));
  if (options.injected !== undefined) return done(options.injected);
  const sealer = sealerKindFromEnv(env);
  if (sealer !== undefined) {
    const channel = options.channel;
    if (channel === undefined || typeof channel.send !== "function") {
      return done(unavailableBackend(sealer, "shell_disconnected"));
    }
    return done(sealedFileBackend(directory, ipcSealer(sealer, channel)));
  }
  if ((options.platform ?? process.platform) === "darwin") {
    return done(keychainBackend(security));
  }
  return done(plainFileBackend(directory));
}

/** 装配时能拿到的那一点：数据目录与壳给的平台。 */
export interface SecretContext {
  readonly dataDir: string;
  readonly platform: { readonly secrets?: SecretBackend | undefined };
}

const resolved = new WeakMap<object, ResolvedSecrets>();

/**
 * 这一轮 core 的密钥后端。按平台对象缓存：同一轮里各域拿到的是同一个后端（同一
 * 条 IPC 通道、同一组挂起请求）。
 */
export function secretsFor(context: SecretContext): ResolvedSecrets {
  const cached = resolved.get(context.platform);
  if (cached !== undefined && cached.dataDir === context.dataDir) return cached;
  const fresh = resolveSecretBackend({
    dataDir: context.dataDir,
    injected: context.platform.secrets,
    channel: process as unknown as IpcChannel,
  });
  resolved.set(context.platform, fresh);
  return fresh;
}
