import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { apnsSender } from "./apns";
import { fcmSender } from "./fcm";
import { createRelay } from "./relay";

/**
 * 中继进程入口。全部配置走环境变量，密钥只给**文件路径**：
 *
 * | 变量                                  | 用途                                         |
 * | ------------------------------------- | -------------------------------------------- |
 * | `ARMADRA_RELAY_HOST` / `_PORT`        | 监听地址，缺省 `127.0.0.1:8095`（前面放 TLS 反向代理） |
 * | `ARMADRA_RELAY_SECRET_FILE`           | 32 字节随机数（原始或 base64），封中继令牌   |
 * | `ARMADRA_RELAY_APNS_KEY_FILE`         | 发布方的 `.p8`                               |
 * | `ARMADRA_RELAY_APNS_KEY_ID` / `_TEAM_ID` / `_TOPIC` | APNs 的 Key ID、Team ID、bundle id |
 * | `ARMADRA_RELAY_APNS_PRODUCTION`       | `1` = 生产环境，否则 sandbox                 |
 * | `ARMADRA_RELAY_FCM_CREDENTIALS_FILE`  | 发布方的 Firebase 服务账号 JSON              |
 * | `ARMADRA_RELAY_FCM_PROJECT_ID`        | 可选，缺省取服务账号里的                     |
 * | `ARMADRA_RELAY_APNS_ENDPOINT` / `ARMADRA_RELAY_FCM_ENDPOINT` | 只给测试：指向 push-sink |
 */

export interface RelayProcess {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

function env(source: NodeJS.ProcessEnv, name: string): string {
  return source[name]?.trim() ?? "";
}

export function readSecret(file: string): Buffer {
  const raw = readFileSync(file);
  if (raw.length === 32) return raw;
  const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
  if (decoded.length !== 32) {
    throw new Error(`${file} 应是 32 字节随机数（原始或 base64）`);
  }
  return decoded;
}

export async function startRelay(
  source: NodeJS.ProcessEnv = process.env,
): Promise<RelayProcess> {
  const secretFile = env(source, "ARMADRA_RELAY_SECRET_FILE");
  if (secretFile === "") throw new Error("缺 ARMADRA_RELAY_SECRET_FILE");
  const apnsKey = env(source, "ARMADRA_RELAY_APNS_KEY_FILE");
  const apnsEndpoint = env(source, "ARMADRA_RELAY_APNS_ENDPOINT");
  const ios =
    apnsKey === ""
      ? undefined
      : apnsSender({
          keyFile: apnsKey,
          keyId: env(source, "ARMADRA_RELAY_APNS_KEY_ID"),
          teamId: env(source, "ARMADRA_RELAY_APNS_TEAM_ID"),
          topic: env(source, "ARMADRA_RELAY_APNS_TOPIC"),
          production: env(source, "ARMADRA_RELAY_APNS_PRODUCTION") === "1",
          ...(apnsEndpoint === "" ? {} : { endpoint: apnsEndpoint }),
        });
  const fcmFile = env(source, "ARMADRA_RELAY_FCM_CREDENTIALS_FILE");
  const fcmProject = env(source, "ARMADRA_RELAY_FCM_PROJECT_ID");
  const fcmEndpoint = env(source, "ARMADRA_RELAY_FCM_ENDPOINT");
  const android =
    fcmFile === ""
      ? undefined
      : fcmSender({
          serviceAccountFile: fcmFile,
          ...(fcmProject === "" ? {} : { projectId: fcmProject }),
          ...(fcmEndpoint === "" ? {} : { endpoint: fcmEndpoint }),
        });
  if (ios === undefined && android === undefined) {
    throw new Error("APNs 与 FCM 至少配一个");
  }
  const relay = createRelay({
    secret: readSecret(secretFile),
    ...(ios === undefined ? {} : { ios }),
    ...(android === undefined ? {} : { android }),
  });
  const server = createServer((request, response) => {
    relay.serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const host = env(source, "ARMADRA_RELAY_HOST") || "127.0.0.1";
  const port = Number(env(source, "ARMADRA_RELAY_PORT") || 8095);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as { port: number };
  return {
    server,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        ios?.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// 打包产物是 CJS（`scripts/build.mjs`）；测试里按 ESM 加载时没有 `require`。
if (typeof require !== "undefined" && require.main === module) {
  startRelay().then(
    (relay) => {
      process.stdout.write(`armadra-push-relay listening on ${relay.url}\n`);
      const stop = () => void relay.close().then(() => process.exit(0));
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    },
    (error: unknown) => {
      process.stderr.write(
        `armadra-push-relay: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
