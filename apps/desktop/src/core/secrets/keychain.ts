/**
 * macOS 登录钥匙串，经 `security(1)`。
 *
 * 桌面壳在 macOS 上维持这一条而不换成 `safeStorage`：已有的条目就在钥匙串里，
 * 换后端意味着同一个令牌有两套存放（[外部服务 §12.1](../../../../../docs/design/external-services.md)）。
 *
 * 工具经一个可注入的 {@link SecurityTool} 调用，测试永远不碰开发者真正的钥匙串。
 */

import { execFile } from "node:child_process";

import {
  type SecretBackend,
  SecretUnavailable,
  checkSecretName,
} from "./backend";

export interface SecurityResult {
  /** 退出码；`0` 成功，`44` 是「没有这个条目」。 */
  readonly code: number;
  readonly stdout: string;
}

/** 跑一次 `security`。`stdin` 给交互提示用，值从不出现在命令行上。 */
export type SecurityTool = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityResult>;

/** `security` 对「没有这个条目」的退出码。 */
export const ITEM_NOT_FOUND = 44;

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export const realSecurityTool: SecurityTool = (args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(
      "security",
      [...args],
      {
        timeout: 10_000,
        encoding: "utf8",
        maxBuffer: 1 << 20,
        env: minimalEnv(),
      },
      (error, stdout) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code as number)
              : -1;
        resolve({ code, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
    child.stdin?.end(stdin ?? "");
  });

/**
 * `security -i` 一行命令约 4 KiB 封顶；留出命令本身与转义的余量。超过就明说，
 * 不截断。
 */
export const KEYCHAIN_MAX_VALUE = 3500;

/** `security -i` 的参数：双引号包起来，反斜杠与双引号前加反斜杠。 */
export function quoteForInteractive(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 一个钥匙串条目的地址。`account` 缺省时只按 service 找。 */
export interface KeychainAddress {
  readonly service: string;
  readonly account?: string;
}

function addressArgs(address: KeychainAddress): string[] {
  return address.account === undefined
    ? ["-s", address.service]
    : ["-a", address.account, "-s", address.service];
}

/** 读一个条目；不在时 `undefined`，工具别的失败抛 {@link SecretUnavailable}。 */
export async function readKeychain(
  tool: SecurityTool,
  address: KeychainAddress,
): Promise<string | undefined> {
  const result = await tool([
    "find-generic-password",
    ...addressArgs(address),
    "-w",
  ]);
  if (result.code === ITEM_NOT_FOUND) return undefined;
  if (result.code !== 0) throw new SecretUnavailable("keychain_failed");
  const value = result.stdout.replace(/[\r\n]+$/, "");
  return value === "" ? undefined : value;
}

/** 删一个条目；不在是成功。 */
export async function deleteKeychain(
  tool: SecurityTool,
  address: KeychainAddress,
): Promise<void> {
  const result = await tool([
    "delete-generic-password",
    ...addressArgs(address),
  ]);
  if (result.code === 0 || result.code === ITEM_NOT_FOUND) return;
  throw new SecretUnavailable("keychain_failed");
}

/**
 * 名字同时是 service 与 account：一个条目一个名字，在钥匙串访问里按 `armadra-`
 * 一搜就是全部。
 */
export function keychainBackend(
  tool: SecurityTool = realSecurityTool,
): SecretBackend {
  const address = (name: string): KeychainAddress => {
    checkSecretName(name);
    return { service: name, account: name };
  };
  return {
    kind: "keychain",
    get: (name) => readKeychain(tool, address(name)),
    async set(name, value) {
      if (/[\r\n]/.test(value)) throw new Error("secret values are one line");
      const where = address(name);
      if (value.length > KEYCHAIN_MAX_VALUE) {
        throw new SecretUnavailable("keychain_value_too_long");
      }
      // 经 `security -i` 从标准输入读一整条命令写，而不是 `-w <值>`（参数会出现在
      // 进程命令行里），也不是 `-w` 的交互提示——那条走 getpass，超过 128 个字符
      // 的值会被悄悄截断，读回来对不上（远程服务的刷新令牌就比这长）。
      await tool(
        ["-i"],
        `add-generic-password -U ${addressArgs(where)
          .map(quoteForInteractive)
          .join(" ")} -w ${quoteForInteractive(value)}\n`,
      );
      // 两次提示对不上时工具也退 0，所以写靠读回来确认。
      const stored = await readKeychain(tool, where).catch(() => undefined);
      if (stored !== value) throw new SecretUnavailable("keychain_failed");
    },
    delete: (name) => deleteKeychain(tool, address(name)),
  };
}
