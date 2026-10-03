import type { Gateway } from "./listener";
import type { ListenMode } from "./network";
import type { TlsMaterial } from "./tls";

/**
 * `GET /api/gateway` 的线上形状（契约 §17.1）。
 *
 * 只报状态与公开材料：指纹、证书主题与名字、有效期。私钥路径之外的证书路径
 * 照设置原样回（那是 owner 自己填的），私钥内容与配对票从不出现在这里。
 */

export type GatewayTlsSourceName = "localCa" | "file" | "acme" | "selfSigned";

export interface GatewayConfigView {
  readonly enabled: boolean;
  readonly listen: ListenMode;
  readonly port: number;
  readonly publicOrigin: string;
  readonly tls: {
    readonly source: "localCa" | "file" | "acme";
    readonly certFile: string;
    readonly keyFile: string;
    readonly acmeEmail: string;
  };
}

export interface GatewayFailure {
  readonly code: string;
  readonly message: string;
}

export function statusJson(input: {
  readonly config: GatewayConfigView;
  readonly managedBy: "settings" | "shell";
  readonly gateway: Gateway | undefined;
  readonly error: GatewayFailure | undefined;
}): Record<string, unknown> {
  const { config, gateway } = input;
  const tls: TlsMaterial | undefined = gateway?.tls();
  return {
    enabled: input.managedBy === "shell" ? true : config.enabled,
    running: gateway !== undefined,
    managedBy: input.managedBy,
    listen: config.listen,
    port: config.port,
    publicOrigin: config.publicOrigin,
    address:
      gateway === undefined
        ? null
        : { host: gateway.address.host, port: gateway.address.port },
    origin: gateway?.origin() ?? null,
    origins: gateway === undefined ? [] : [...gateway.origins()],
    tls: {
      source: (tls?.source ?? config.tls.source) as GatewayTlsSourceName,
      certFile: config.tls.certFile,
      keyFile: config.tls.keyFile,
      acmeEmail: config.tls.acmeEmail,
      fingerprint: tls?.fingerprint ?? null,
      subject: tls?.subject ?? null,
      names: tls === undefined ? [] : [...tls.names],
      notAfter: tls === undefined ? null : new Date(tls.notAfter).toISOString(),
      caAvailable: tls?.anchor !== undefined,
    },
    error: input.error ?? null,
  };
}
