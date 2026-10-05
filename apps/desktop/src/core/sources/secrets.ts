/**
 * 源与远程服务的凭据（契约 §33、平台规格 core 包 §1.4）。
 *
 * - `armadra-source-<sourceId>`：`{ byOrigin: { [origin]: { refreshToken, deviceId } } }`
 *   ——直连与中继各一份，键是 Gateway 来源或中继的 `relayBaseUrl`。
 * - `armadra-remote-<serviceId>`：`{ refreshToken, deviceId }`。
 *
 * 访问令牌与口令从不落盘；刷新令牌每次换票都旋转并写回。值只经
 * {@link SecretBackend}（钥匙串 / safeStorage / 数据目录里的加密文件），不进
 * SQLite、日志与任何答案。
 */

import { type SecretBackend, checkSecretName } from "../secrets/backend";

export interface StoredCredential {
  readonly refreshToken: string;
  readonly deviceId: string;
}

export interface SourceCredentials {
  readonly byOrigin: Readonly<Record<string, StoredCredential>>;
}

export function sourceSecretName(sourceId: string): string {
  return checkSecretName(`armadra-source-${sourceId}`);
}

export function remoteSecretName(serviceId: string): string {
  return checkSecretName(`armadra-remote-${serviceId}`);
}

function credentialOf(value: unknown): StoredCredential | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { refreshToken, deviceId } = value as Record<string, unknown>;
  if (typeof refreshToken !== "string" || refreshToken === "") return undefined;
  return {
    refreshToken,
    deviceId: typeof deviceId === "string" ? deviceId : "",
  };
}

async function readJson(
  backend: SecretBackend,
  name: string,
): Promise<unknown> {
  let text: string | undefined;
  try {
    text = await backend.get(name);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class SourceSecrets {
  constructor(private readonly backend: () => SecretBackend) {}

  async source(sourceId: string): Promise<SourceCredentials> {
    const value = await readJson(this.backend(), sourceSecretName(sourceId));
    const byOrigin: Record<string, StoredCredential> = {};
    const raw =
      typeof value === "object" && value !== null
        ? (value as { byOrigin?: unknown }).byOrigin
        : undefined;
    if (typeof raw === "object" && raw !== null) {
      for (const [origin, entry] of Object.entries(raw)) {
        const credential = credentialOf(entry);
        if (credential !== undefined) byOrigin[origin] = credential;
      }
    }
    return { byOrigin };
  }

  async hasSource(sourceId: string): Promise<boolean> {
    return Object.keys((await this.source(sourceId)).byOrigin).length > 0;
  }

  /** 写一个来源的凭据（旋转）；`undefined` 删掉这个来源的那份。 */
  async putSource(
    sourceId: string,
    origin: string,
    credential: StoredCredential | undefined,
  ): Promise<void> {
    const current = await this.source(sourceId);
    const byOrigin = { ...current.byOrigin };
    if (credential === undefined) delete byOrigin[origin];
    else byOrigin[origin] = credential;
    const name = sourceSecretName(sourceId);
    if (Object.keys(byOrigin).length === 0) {
      await this.backend().delete(name);
      return;
    }
    await this.backend().set(name, JSON.stringify({ byOrigin }));
  }

  async clearSource(sourceId: string): Promise<void> {
    await this.backend().delete(sourceSecretName(sourceId));
  }

  async remote(serviceId: string): Promise<StoredCredential | undefined> {
    return credentialOf(
      await readJson(this.backend(), remoteSecretName(serviceId)),
    );
  }

  async putRemote(
    serviceId: string,
    credential: StoredCredential,
  ): Promise<void> {
    await this.backend().set(
      remoteSecretName(serviceId),
      JSON.stringify(credential),
    );
  }

  async clearRemote(serviceId: string): Promise<void> {
    await this.backend().delete(remoteSecretName(serviceId));
  }
}
