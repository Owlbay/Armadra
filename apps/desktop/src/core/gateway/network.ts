import { hostname, networkInterfaces } from "node:os";
import { isIPv4, isIPv6 } from "node:net";
import { canonicalOrigin } from "../identity/origin";

/**
 * Gateway 的地址与来源：监听在哪、接受哪些连接、哪些来源算「自己」。
 *
 * 设置 `gateway.listen` 的三档（架构 §7）：
 *
 *   * `loopback`：只绑 `127.0.0.1`。
 *   * `private`：绑 `0.0.0.0`，但只接受落在本机**私网接口地址**（与回环）上的
 *     连接——Node 一个监听只能绑一个地址，而私网地址会随 DHCP 变，逐个绑等于
 *     地址一变就要重开监听；按连接的本地地址筛，地址变了只需要换一张叶证书。
 *   * `all`：绑 `0.0.0.0`，不筛。
 */

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

export type ListenMode = "loopback" | "private" | "all";

/** 回环字面量。主机名不算：主机名是别人的 `/etc/hosts` 说了算的东西。 */
export function loopbackHost(host: string): boolean {
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (literal === "localhost") return true;
  if (/^127(\.\d{1,3}){3}$/.test(literal)) return true;
  const lowered = literal.toLowerCase();
  return lowered === "::1" || lowered === "0:0:0:0:0:0:0:1";
}

/** 一个地址字面量是不是私网：RFC 1918、CGNAT（Tailscale 一类）与 IPv6 ULA。 */
export function privateAddress(address: string): boolean {
  const literal = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIPv4(literal)) {
    const [a, b] = literal.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIPv6(literal)) return /^f[cd]/i.test(literal);
  return false;
}

type Interfaces = ReturnType<typeof networkInterfaces>;

/**
 * 本机当前的私网地址，排好序（叶证书的 SAN 与「地址变没变」都按它比）。
 * 链路本地（169.254/16、fe80::/10）不算：别的设备没法稳定地叫到它。
 */
export function privateAddresses(
  interfaces: Interfaces = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (privateAddress(entry.address)) found.add(entry.address);
    }
  }
  return [...found].sort();
}

/**
 * `all` 档的「自己」：每块非回环网卡上的地址（链路本地除外），私网与公网都算。
 */
export function interfaceAddresses(
  interfaces: Interfaces = networkInterfaces(),
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (/^169\.254\./.test(entry.address) || /^fe80:/i.test(entry.address)) {
        continue;
      }
      found.add(entry.address);
    }
  }
  return [...found].sort();
}

/**
 * 这一档「自己」的主机，按二维码优先用谁排：私网地址在前（手机最容易连上），
 * 然后是主机名，最后是回环。`localhost` 永远不在里面——`https://localhost`
 * 是 Android 版 App 的来源，不能同时是 Gateway 自己的。
 */
export function gatewayHosts(
  mode: ListenMode,
  addresses: { privates: readonly string[]; all: readonly string[] },
  machine: string | undefined = machineHostname(),
): string[] {
  if (mode === "loopback") return ["127.0.0.1"];
  const own = mode === "private" ? addresses.privates : addresses.all;
  return [...new Set([...own, ...(machine ? [machine] : []), "127.0.0.1"])];
}

/** 这一档绑哪个地址。 */
export function bindHost(mode: ListenMode): string {
  return mode === "loopback" ? "127.0.0.1" : "0.0.0.0";
}

/**
 * 这条连接落在本机哪个地址上，这一档收不收。`private` 只收回环与当前私网地址；
 * 其余两档绑的地址本身已经是答案。
 */
export function acceptsConnection(
  mode: ListenMode,
  localAddress: string | undefined,
  privates: readonly string[],
): boolean {
  if (mode !== "private") return true;
  if (localAddress === undefined) return false;
  const literal = localAddress.startsWith("::ffff:")
    ? localAddress.slice(7)
    : localAddress;
  return loopbackHost(literal) || privates.includes(literal);
}

/** 本机的主机名，能当证书名字与来源用时才给（小写；拼不成来源就不给）。 */
export function machineHostname(name: string = hostname()): string | undefined {
  const lowered = name.trim().toLowerCase();
  if (lowered === "" || lowered === "localhost") return undefined;
  return canonicalOrigin(`https://${lowered}`) === `https://${lowered}`
    ? lowered
    : undefined;
}

/** `https://<host>:<port>` 的规范拼法；IPv6 加方括号。拼不成是 `undefined`。 */
export function httpsOrigin(host: string, port: number): string | undefined {
  const bracketed = host.includes(":") && !host.startsWith("[");
  return canonicalOrigin(`https://${bracketed ? `[${host}]` : host}:${port}`);
}

/**
 * 这次运行接受的来源集合：显式给的公网来源在前，加上监听地址自己那几个。
 * 后者是为了「直接用 IP 访问」这条路能走通；它不会放宽任何东西——那些地址本来
 * 就是这台机器自己。
 */
export function originsFor(
  hosts: readonly string[],
  port: number,
  publicOrigins: readonly string[],
): string[] {
  const all = [...publicOrigins];
  for (const host of hosts) {
    const own = httpsOrigin(host, port);
    if (own !== undefined) all.push(own);
  }
  return [...new Set(all)];
}

/** 证书要覆盖的名字：公网来源的主机加上监听那几个；`0.0.0.0` / `::` 不是名字。 */
export function certificateHosts(
  hosts: readonly string[],
  publicOrigins: readonly string[],
): string[] {
  const names = publicOrigins.map((origin) => new URL(origin).hostname);
  names.push(...hosts);
  return [
    ...new Set(
      names
        .map((host) =>
          host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host,
        )
        .filter((host) => host !== "0.0.0.0" && host !== "::" && host !== ""),
    ),
  ];
}
