import { join } from "node:path";

import {
  type SecretBackend,
  encryptedFileBackend,
  forcedFileBackend,
  loadOrCreateMasterKey,
  plainFileBackend,
  secretsDirectory,
} from "../../desktop/src/core/secrets";

/**
 * 服务器壳的密钥后端（[外部服务 §12.1](../../../docs/design/external-services.md)）。
 *
 * 服务器上没有登录会话持有的钥匙串，所以条目用一把 master key 做 AES-256-GCM
 * 封装，自报 `file-encrypted`。钥匙默认在 `<数据目录>/secrets/master.key`（0600，
 * 首启生成）；`ARMADRA_SECRET_MASTER_KEY_FILE` 可以指到别处（如 systemd
 * `LoadCredential=`），那时缺了就拒绝启动而不是另生成一把——新钥匙打不开旧条目。
 *
 * `ARMADRA_SECRET_BACKEND=file` 强制明文 0600（测试与无人值守）。
 */

export const MASTER_KEY_ENV = "ARMADRA_SECRET_MASTER_KEY_FILE";

export function masterKeyFile(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { readonly path: string; readonly configured: boolean } {
  const configured = (env[MASTER_KEY_ENV] ?? "").trim();
  return configured === ""
    ? { path: join(secretsDirectory(dataDir), "master.key"), configured: false }
    : { path: configured, configured: true };
}

export function serverSecrets(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretBackend {
  const directory = secretsDirectory(dataDir);
  if (forcedFileBackend(env)) return plainFileBackend(directory);
  const key = masterKeyFile(dataDir, env);
  // 现在就读（或生成）一次：钥匙不对是启动时的错，不是第一次登录时的。
  loadOrCreateMasterKey(key.path, { create: !key.configured });
  return encryptedFileBackend({
    directory,
    keyFile: key.path,
    createKey: !key.configured,
  });
}
