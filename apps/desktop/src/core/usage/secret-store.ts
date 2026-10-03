/**
 * 用量域的密钥存放，现在由 `core/secrets` 统一提供（[外部服务 §12.1](../../../../../docs/design/external-services.md)）。
 * 这里只剩再导出，旧的 import 路径照旧能用。
 */

import { readFileSync } from "node:fs";

export {
  SecretStore,
  type SecretBackend,
  type SecretBackendKind,
} from "../secrets";

/** 读一个明文令牌文件；不在或是空的时 `undefined`。给测试看文件后端写了什么。 */
export function readTokenFile(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
