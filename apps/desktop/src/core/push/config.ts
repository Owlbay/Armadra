import type { CompletionSettings } from "../settings/schema";
import type { ApnsConfig, FcmConfig } from "./transport-direct";

/**
 * 推送配置：设置文档（「设置 → 后台服务 → 推送」）与服务器壳的环境变量合成
 * 一份（外部服务 §5.2）。
 *
 * 环境变量逐项覆盖设置里的同一项，空串等于没给。密钥只有**文件路径**：
 * `ARMADRA_PUSH_APNS_KEY_FILE` 指向 `.p8`，`ARMADRA_PUSH_FCM_CREDENTIALS_FILE`
 * 指向服务账号 JSON，内容从不进环境变量也不进设置文档。
 *
 * `ARMADRA_PUSH_APNS_ENDPOINT` / `ARMADRA_PUSH_FCM_ENDPOINT` 只给测试：把 Apple
 * 与 Google 的地址换成 dev-stack 的 push-sink。
 */

export type NativeTransport = CompletionSettings["push"]["transport"];

export interface PushConfig {
  /** 原生 App 走哪条路；Web Push 与它无关。 */
  readonly native: NativeTransport;
  readonly relayUrl: string;
  readonly apns?: ApnsConfig;
  readonly fcm?: FcmConfig;
  readonly webpush: { readonly enabled: boolean; readonly subject: string };
}

/** 读到的这些环境变量名，集中在一处给文档与测试对照。 */
export const PUSH_ENV = [
  "ARMADRA_PUSH_TRANSPORT",
  "ARMADRA_PUSH_RELAY_URL",
  "ARMADRA_PUSH_APNS_KEY_FILE",
  "ARMADRA_PUSH_APNS_KEY_ID",
  "ARMADRA_PUSH_APNS_TEAM_ID",
  "ARMADRA_PUSH_APNS_BUNDLE_ID",
  "ARMADRA_PUSH_APNS_PRODUCTION",
  "ARMADRA_PUSH_APNS_ENDPOINT",
  "ARMADRA_PUSH_FCM_CREDENTIALS_FILE",
  "ARMADRA_PUSH_FCM_PROJECT_ID",
  "ARMADRA_PUSH_FCM_ENDPOINT",
  "ARMADRA_PUSH_VAPID_SUBJECT",
] as const;

const NATIVE: readonly NativeTransport[] = ["log", "direct", "relay"];

function pick(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() ?? "";
  return value === "" ? fallback : value;
}

function endpoint(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim() ?? "";
  return value === "" ? undefined : value.replace(/\/+$/, "");
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function resolvePushConfig(
  settings: CompletionSettings["push"],
  env: NodeJS.ProcessEnv,
  publicOrigin = "",
): PushConfig {
  const apnsKeyFile = pick(
    env,
    "ARMADRA_PUSH_APNS_KEY_FILE",
    settings.apns.keyFile,
  );
  const apnsKeyId = pick(env, "ARMADRA_PUSH_APNS_KEY_ID", settings.apns.keyId);
  const apnsTeamId = pick(
    env,
    "ARMADRA_PUSH_APNS_TEAM_ID",
    settings.apns.teamId,
  );
  const apnsTopic = pick(
    env,
    "ARMADRA_PUSH_APNS_BUNDLE_ID",
    settings.apns.topic,
  );
  const productionEnv = env.ARMADRA_PUSH_APNS_PRODUCTION?.trim() ?? "";
  const production =
    productionEnv === "" ? settings.apns.production : productionEnv === "1";
  const apnsEndpoint = endpoint(env, "ARMADRA_PUSH_APNS_ENDPOINT");
  const apns: ApnsConfig | undefined =
    apnsKeyFile && apnsKeyId && apnsTeamId && apnsTopic
      ? {
          keyFile: apnsKeyFile,
          keyId: apnsKeyId,
          teamId: apnsTeamId,
          topic: apnsTopic,
          production,
          ...(apnsEndpoint === undefined ? {} : { endpoint: apnsEndpoint }),
        }
      : undefined;

  const fcmFile = pick(
    env,
    "ARMADRA_PUSH_FCM_CREDENTIALS_FILE",
    settings.fcm.serviceAccountFile,
  );
  const fcmProject = pick(
    env,
    "ARMADRA_PUSH_FCM_PROJECT_ID",
    settings.fcm.projectId,
  );
  const fcmEndpoint = endpoint(env, "ARMADRA_PUSH_FCM_ENDPOINT");
  const fcm: FcmConfig | undefined = fcmFile
    ? {
        serviceAccountFile: fcmFile,
        ...(fcmProject === "" ? {} : { projectId: fcmProject }),
        ...(fcmEndpoint === undefined ? {} : { endpoint: fcmEndpoint }),
      }
    : undefined;

  const relayRaw = pick(env, "ARMADRA_PUSH_RELAY_URL", settings.relayUrl);
  const relayUrl = httpUrl(relayRaw) ? relayRaw.replace(/\/+$/, "") : "";

  // 显式说了走哪条就听它的；设置停在缺省的 `log` 时，服务器壳只给了环境变量
  // 也该能用——给了中继地址就是中继，给了 APNs / FCM 的文件就是直连。
  const declared = env.ARMADRA_PUSH_TRANSPORT?.trim() as NativeTransport;
  const native: NativeTransport = NATIVE.includes(declared)
    ? declared
    : settings.transport !== "log"
      ? settings.transport
      : env.ARMADRA_PUSH_RELAY_URL?.trim()
        ? "relay"
        : env.ARMADRA_PUSH_APNS_KEY_FILE?.trim() ||
            env.ARMADRA_PUSH_FCM_CREDENTIALS_FILE?.trim()
          ? "direct"
          : "log";

  const subject = pick(
    env,
    "ARMADRA_PUSH_VAPID_SUBJECT",
    settings.webpush.subject,
  );
  return {
    native,
    relayUrl,
    ...(apns === undefined ? {} : { apns }),
    ...(fcm === undefined ? {} : { fcm }),
    webpush: {
      enabled: settings.webpush.enabled,
      subject: validSubject(subject)
        ? subject
        : publicOrigin.startsWith("https://")
          ? publicOrigin
          : // 厂商只用它联系发送方；自托管没有可公开的地址时用一个保留域。
            "mailto:push@armadra.invalid",
    },
  };
}

function validSubject(subject: string): boolean {
  return /^mailto:\S+@\S+$/.test(subject) || /^https:\/\/\S+$/.test(subject);
}

/** 原生这条路现在能不能发；`notConfigured` 时接口照常答 `queued`，只写日志。 */
export function nativeStatus(config: PushConfig): "ready" | "notConfigured" {
  if (config.native === "relay") {
    return config.relayUrl === "" ? "notConfigured" : "ready";
  }
  if (config.native === "direct") {
    return config.apns === undefined && config.fcm === undefined
      ? "notConfigured"
      : "ready";
  }
  return "notConfigured";
}
