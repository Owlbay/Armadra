import { hostname } from "node:os";

import { isJsonObject, type JsonValue } from "./local";
import { MAX_HOST_NAME } from "./schema";

/**
 * 这台主机的名字（契约 §61）：设置 `host.name`，没设是系统主机名。经
 * `GET /api/identity/hello` 与 `system.hello` 的 `hostName` 报给别的设备，也是
 * 本机源表行的缺省名与登记到远程服务时的源名称。
 */

/** 系统主机名；取不到时是 `Armadra`。 */
export function systemHostName(name: string = hostname()): string {
  return name.trim().slice(0, MAX_HOST_NAME) || "Armadra";
}

/** 设置文档里的 `host.name`（已规范化）；没设是空串。 */
export function configuredHostName(document: JsonValue | undefined): string {
  if (!isJsonObject(document ?? null)) return "";
  const host = (document as Record<string, JsonValue>).host;
  if (!isJsonObject(host ?? null)) return "";
  const name = (host as Record<string, JsonValue>).name;
  return typeof name === "string" ? name.trim().slice(0, MAX_HOST_NAME) : "";
}

/** 生效的名字：设置里的，没设是系统主机名。 */
export function effectiveHostName(
  document: JsonValue | undefined,
  system: string = systemHostName(),
): string {
  return configuredHostName(document) || system;
}
