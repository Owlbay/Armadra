/**
 * core 自己拥有的密钥存在哪儿——接口。
 *
 * core 只认 {@link SecretBackend}：一个按名字存取字符串的地方，加上它自报的
 * {@link SecretBackendKind}。具体是钥匙串、DPAPI、libsecret 还是数据目录里的文件，
 * 由装配它的壳决定（[外部服务 §12.1](../../../../../docs/design/external-services.md)）。
 *
 * 值只在内存里待一次调用那么久：从不进日志、SQLite 或任何一条 API 响应。到达设置
 * 页的只有 `kind`——它**在哪儿**。
 */

/**
 * 后端自报的种类。
 *
 * - `keychain`：macOS 登录钥匙串（`security(1)`）。
 * - `dpapi`：Windows，桌面壳的 `safeStorage` 加密，密文在数据目录。
 * - `libsecret`：Linux，桌面壳的 `safeStorage` 且后端是 libsecret / kwallet。
 * - `file-encrypted`：服务器壳，数据目录里的 master key 做 AES-256-GCM。
 * - `file`：0600 明文文件，一次**降级**，设置页照实说。
 */
export const SECRET_BACKEND_KINDS = [
  "keychain",
  "dpapi",
  "libsecret",
  "file-encrypted",
  "file",
] as const;

export type SecretBackendKind = (typeof SECRET_BACKEND_KINDS)[number];

export interface SecretBackend {
  readonly kind: SecretBackendKind;
  /** 存着的值；没有（或是空的）时 `undefined`。存着但打不开时抛 {@link SecretUnavailable}。 */
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** 删一个不在的条目是成功。 */
  delete(name: string): Promise<void>;
}

/**
 * 条目在，但这一次拿不到：壳断开了、密文是另一种后端封的、master key 不对。
 * `reason` 是代码，不带值，也不带路径之外的任何东西。
 */
export class SecretUnavailable extends Error {
  readonly code = "secret_unavailable";
  constructor(readonly reason: string) {
    super(`secret unavailable: ${reason}`);
    this.name = "SecretUnavailable";
  }
}

/**
 * 每个条目的名字都带 `armadra-` 前缀，好让人在钥匙串里一眼找到、一把清掉。它同时
 * 兼作文件名，所以只收一个保守的字符集，永远拼不出一条逃出目录的路径。
 */
const NAME_PATTERN = /^armadra-[A-Za-z0-9._@-]{1,200}$/;

export function checkSecretName(name: string): string {
  if (!NAME_PATTERN.test(name) || name.includes("..")) {
    throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * 把一段明文封成只有这台机器、这个用户打得开的密文。桌面壳用 `safeStorage` 实现
 * （经 {@link ./ipc}），core 只看到这个接口。
 */
export interface SecretSealer {
  readonly kind: "dpapi" | "libsecret";
  seal(plain: Buffer): Promise<Buffer>;
  unseal(sealed: Buffer): Promise<Buffer>;
}

/** 一个拒绝一切的后端：壳说了要用某种存储、但这一刻接不上它。不降级成明文。 */
export function unavailableBackend(
  kind: SecretBackendKind,
  reason: string,
): SecretBackend {
  const refuse = (): Promise<never> =>
    Promise.reject(new SecretUnavailable(reason));
  return { kind, get: refuse, set: refuse, delete: refuse };
}
