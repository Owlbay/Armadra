/**
 * 手机 / 平板 App 与所连主机合不合得来：只看协议，不看两边的版本号。
 *
 * App 有自己的版本线（`apps/mobile/package.json`），桌面 / 服务器套件是另一条；
 * 两个数相不相等说明不了什么。App 打包时带的这份页面能对着 {@link MINIMUM_HOST_PROTOCOL}
 * 及以上的 core 工作（minor 只增不减、只加东西，页面按 `min(自己的, core 的)` 谈）；
 * major 不同就是不兼容。
 *
 * {@link MINIMUM_HOST_PROTOCOL} 是 `tools/release/compatibility.json` 的
 * `mobile.minimumHostProtocol` 的副本，`node tools/release/version.mjs mobile check`
 * 核对两者一致、且不高于 core 自己的协议。1.14 起手机用到的推送与对外服务动词
 * （契约 §43.4、§43.7）都在契约上；已发布的 0.2.x 全在 1.18 及以上。
 */
export const MINIMUM_HOST_PROTOCOL = { major: 1, minor: 14 } as const;

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * - `compatible`：能用。
 * - `updateHost`：主机的协议比 App 要的旧（minor 不够，或 major 更小）。
 * - `updateApp`：主机的 major 比 App 认得的新。
 * - `unknown`：还没问到，或主机没报协议。
 */
export type HostCompatibility =
  | "compatible"
  | "updateHost"
  | "updateApp"
  | "unknown";

export function hostCompatibility(
  host: ProtocolVersion | null | undefined,
  minimum: ProtocolVersion = MINIMUM_HOST_PROTOCOL,
): HostCompatibility {
  // `identityHello` 在主机没报协议时给 `{ major: 0, minor: 0 }`。
  if (!host || !Number.isInteger(host.major) || host.major <= 0)
    return "unknown";
  if (host.major < minimum.major) return "updateHost";
  if (host.major > minimum.major) return "updateApp";
  return host.minor < minimum.minor ? "updateHost" : "compatible";
}

/** `1.26` 这样的写法。 */
export function formatProtocol(protocol: ProtocolVersion): string {
  return `${protocol.major}.${protocol.minor}`;
}
