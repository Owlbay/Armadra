import { isIP, type Server as NetServer, type Socket } from "node:net";
import { type SecureContext, TLSSocket } from "node:tls";

/**
 * `tls-alpn-01`（RFC 8737）在 Gateway 这一侧的那一半：认出 CA 的验证握手，
 * 用挑战证书答完它，其余连接原样交给 HTTPS 服务。
 *
 * 为什么先看 ClientHello 而不是用 `SNICallback`：OpenSSL 在 TLS 1.2 里先选证书
 * （Node 的 `SNICallback` 就跑在这一步）、后选 ALPN，到选证书时还不知道对方
 * 要的是 `acme-tls/1`。所以在交给 TLS 之前读出第一条握手记录，从里面取 SNI 与
 * ALPN 列表；读到的字节原样塞回套接字，TLS 那一侧看到的是一条没被碰过的流。
 *
 * 只在有挑战挂着时才看：平时连接直接交出去，不多等一个字节。
 */

export const ACME_TLS_PROTOCOL = "acme-tls/1";

/** 读 ClientHello 最多等多久；超时的连接直接断。 */
export const CLIENT_HELLO_TIMEOUT_MS = 10_000;

/** TLS 记录头 5 字节，载荷最长 2^14 + 2048（RFC 8446 §5.2 的上限）。 */
const RECORD_HEADER = 5;
const MAX_RECORD = RECORD_HEADER + 16_384 + 2_048;

export interface ClientHello {
  /** SNI 里的主机名，小写；没带为 `undefined`。 */
  readonly servername: string | undefined;
  /** ALPN 列表，按客户端给的顺序。 */
  readonly protocols: readonly string[];
}

/** 挂着的 `tls-alpn-01` 挑战：ACME 管理器实现它。 */
export interface AcmeTlsResponder {
  /** 有没有挑战在等验证；没有时连接不经检查直接交出去。 */
  pending(): boolean;
  /** 这个 SNI 对应的挑战证书；不是在等的名字答 `undefined`。 */
  context(servername: string): SecureContext | undefined;
}

/**
 * 第一条 TLS 记录攒齐了没有。`complete` 时 `length` 是整条记录的长度；不是
 * 握手记录或长度离谱时是 `notTls`，调用方不再等、原样交出去。
 */
export function recordState(
  buffer: Buffer,
):
  | { state: "more" }
  | { state: "complete"; length: number }
  | { state: "notTls" } {
  if (buffer.length === 0) return { state: "more" };
  if (buffer[0] !== 0x16) return { state: "notTls" };
  if (buffer.length < RECORD_HEADER) return { state: "more" };
  const length = RECORD_HEADER + buffer.readUInt16BE(3);
  if (length > MAX_RECORD) return { state: "notTls" };
  return buffer.length >= length
    ? { state: "complete", length }
    : { state: "more" };
}

/**
 * 从第一条握手记录里取 SNI 与 ALPN（RFC 8446 §4.1.2、RFC 6066 §3、RFC 7301）。
 * 不是 ClientHello、被截断或跨记录时答 `undefined`——调用方当普通连接处理。
 */
export function parseClientHello(record: Buffer): ClientHello | undefined {
  const reader = new Reader(record);
  if (reader.u8() !== 0x16) return undefined;
  reader.skip(2);
  const recordLength = reader.u16();
  const body = reader.take(recordLength);
  if (body === undefined) return undefined;
  const hello = new Reader(body);
  if (hello.u8() !== 0x01) return undefined;
  const helloLength = hello.u24();
  const message = hello.take(helloLength);
  if (message === undefined) return undefined;
  const fields = new Reader(message);
  fields.skip(2 + 32);
  fields.skip(fields.u8());
  fields.skip(fields.u16());
  fields.skip(fields.u8());
  if (fields.failed) return undefined;
  if (fields.remaining() === 0) return { servername: undefined, protocols: [] };
  const extensions = fields.take(fields.u16());
  if (extensions === undefined) return undefined;
  const list = new Reader(extensions);
  let servername: string | undefined;
  const protocols: string[] = [];
  while (list.remaining() > 0) {
    const type = list.u16();
    const data = list.take(list.u16());
    if (data === undefined) return undefined;
    if (type === 0x0000) {
      const names = new Reader(data);
      const entries = names.take(names.u16());
      if (entries === undefined) return undefined;
      const entry = new Reader(entries);
      while (entry.remaining() > 0) {
        const kind = entry.u8();
        const name = entry.take(entry.u16());
        if (name === undefined) return undefined;
        if (kind === 0 && servername === undefined) {
          servername = name.toString("ascii").toLowerCase();
        }
      }
    } else if (type === 0x0010) {
      const alpn = new Reader(data);
      const entries = alpn.take(alpn.u16());
      if (entries === undefined) return undefined;
      const entry = new Reader(entries);
      while (entry.remaining() > 0) {
        const protocol = entry.take(entry.u8());
        if (protocol === undefined) return undefined;
        protocols.push(protocol.toString("latin1"));
      }
    }
  }
  return list.failed ? undefined : { servername, protocols };
}

/**
 * SNI 换回 ACME 标识：IP 标识的验证握手用反向解析名（RFC 8738 §6：
 * `4.3.2.1.in-addr.arpa`、逐半字节倒写的 `ip6.arpa`），其余原样。
 */
export function identifierOf(servername: string): string {
  const name = servername.toLowerCase().replace(/\.$/, "");
  const v4 = /^((?:\d{1,3}\.){3}\d{1,3})\.in-addr\.arpa$/.exec(name);
  if (v4 !== null) {
    const address = (v4[1] as string).split(".").reverse().join(".");
    return isIP(address) === 4 ? address : name;
  }
  const v6 = /^((?:[0-9a-f]\.){32})ip6\.arpa$/.exec(name);
  if (v6 !== null) {
    const nibbles = (v6[1] as string).split(".").filter(Boolean).reverse();
    const groups: string[] = [];
    for (let index = 0; index < 32; index += 4) {
      groups.push(
        nibbles
          .slice(index, index + 4)
          .join("")
          .replace(/^0{1,3}/, ""),
      );
    }
    const address = compressIpv6(groups);
    return isIP(address) === 6 ? address : name;
  }
  return name;
}

function compressIpv6(groups: string[]): string {
  // 最长一串 0 组缩成 `::`，与 `URL` / `isIP` 的写法一致。
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - index > bestLength && end - index > 1) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/**
 * 一条新连接：有挑战挂着就先读 ClientHello。是 `acme-tls/1` 而且 SNI 是在等的
 * 名字，就用挑战证书握手、握完即关；`acme-tls/1` 但名字不对就断开；别的一律
 * 原样交给 `next`。
 */
export function routeAcmeTls(
  socket: Socket,
  responder: AcmeTlsResponder,
  next: (socket: Socket) => void,
  timeoutMs = CLIENT_HELLO_TIMEOUT_MS,
): void {
  if (!responder.pending()) {
    next(socket);
    return;
  }
  let buffered = Buffer.alloc(0);
  let settled = false;
  const finish = (): boolean => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("end", onGone);
    socket.removeListener("error", onGone);
    socket.removeListener("close", onGone);
    return true;
  };
  const onGone = () => {
    if (finish()) socket.destroy();
  };
  const handOver = () => {
    if (!finish()) return;
    socket.pause();
    if (buffered.length > 0) socket.unshift(buffered);
    const state = recordState(buffered);
    const hello =
      state.state === "complete"
        ? parseClientHello(buffered.subarray(0, state.length))
        : undefined;
    if (hello === undefined || !hello.protocols.includes(ACME_TLS_PROTOCOL)) {
      next(socket);
      return;
    }
    const context =
      hello.servername === undefined
        ? undefined
        : responder.context(hello.servername);
    if (context === undefined) {
      socket.destroy();
      return;
    }
    answerChallenge(socket, context);
  };
  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (recordState(buffered).state !== "more") handOver();
  };
  const timer = setTimeout(onGone, timeoutMs);
  timer.unref();
  socket.on("data", onData);
  socket.once("end", onGone);
  socket.once("error", onGone);
  socket.once("close", onGone);
}

/** 用挑战证书完成握手（只协商 `acme-tls/1`），然后关掉。 */
export function answerChallenge(socket: Socket, context: SecureContext): void {
  const secure = new TLSSocket(socket, {
    isServer: true,
    secureContext: context,
    ALPNProtocols: [ACME_TLS_PROTOCOL],
  });
  secure.once("secure", () => secure.end());
  secure.on("error", () => secure.destroy());
  secure.setTimeout(CLIENT_HELLO_TIMEOUT_MS, () => secure.destroy());
}

/**
 * 给一个 TLS 服务装上 {@link routeAcmeTls}：把它自己的握手入口（`tls.Server`
 * 构造时登记的那一个 `connection` 监听）换成「先看一眼再交给它」。在登记任何
 * 别的 `connection` 监听之前调。
 */
export function interceptAcmeTls(
  server: NetServer,
  responder: AcmeTlsResponder,
): void {
  const listeners = server.listeners("connection");
  if (listeners.length !== 1) {
    throw new Error("TLS 服务的握手入口不是唯一的一个，没法插入 tls-alpn-01");
  }
  const accept = listeners[0] as (socket: Socket) => void;
  server.removeListener("connection", accept);
  server.on("connection", (socket: Socket) => {
    if (socket.destroyed) return;
    routeAcmeTls(socket, responder, (handed) => accept.call(server, handed));
  });
}

class Reader {
  private offset = 0;
  failed = false;

  constructor(private readonly buffer: Buffer) {}

  remaining(): number {
    return this.failed ? 0 : this.buffer.length - this.offset;
  }

  u8(): number {
    return this.read(1)?.readUInt8(0) ?? 0;
  }

  u16(): number {
    return this.read(2)?.readUInt16BE(0) ?? 0;
  }

  u24(): number {
    return this.read(3)?.readUIntBE(0, 3) ?? 0;
  }

  skip(length: number): void {
    this.read(length);
  }

  take(length: number): Buffer | undefined {
    return this.read(length);
  }

  private read(length: number): Buffer | undefined {
    if (this.failed || this.offset + length > this.buffer.length) {
      this.failed = true;
      return undefined;
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}
