import { correction, generate } from "lean-qr";
import type { GatewayPairingPayload } from "@armadra/shared";

/**
 * 对外服务那一页的二维码。
 *
 * 以前这里自己实现了一个只到版本 6（L 级 134 字节）的编码器，够装一个
 * `https://192.168.1.20:8443`；Gateway 的配对链接还要带一张票和 64 位的
 * 信任锚指纹（契约 §17.3），放不下。编码交给 `lean-qr`（MIT、无依赖、
 * 支持到版本 40），这里只管两件事：编出一张 SVG 用的路径，以及配对载荷
 * 与二维码文本之间的来回。
 */

export interface QrCode {
  size: number;
  /** `true` 是深色模块。索引是 `[row][col]`。 */
  modules: boolean[][];
}

/**
 * 把一段文本编成 QR 矩阵；空串或装不下时返回 `null`——宁可只显示那行地址，
 * 也不画一张扫不出来的图。纠错至少 M 级：屏幕反光与手机对焦都会丢模块。
 */
export function encodeQr(text: string): QrCode | null {
  if (text === "") return null;
  let bitmap: ReturnType<typeof generate>;
  try {
    bitmap = generate(text, { minCorrectionLevel: correction.M });
  } catch {
    return null;
  }
  const modules = Array.from({ length: bitmap.size }, (_, y) =>
    Array.from({ length: bitmap.size }, (_, x) => bitmap.get(x, y)),
  );
  return { size: bitmap.size, modules };
}

/**
 * 深色模块合并成一条 SVG path。整块图只有一个 `<path>`，不是几百个 `<rect>`。
 */
export function qrPath(code: QrCode): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    let run = 0;
    for (let x = 0; x <= code.size; x += 1) {
      const dark = x < code.size && code.modules[y]![x]!;
      if (dark) run += 1;
      else if (run > 0) {
        parts.push(`M${x - run} ${y}h${run}v1h-${run}z`);
        run = 0;
      }
    }
  }
  return parts.join("");
}

/** 二维码给谁扫：手机相机（打开网页）或 App 内的扫码（深链）。 */
export type PairingTarget = "web" | "app";

/** 配对载荷 → 二维码里的文本。 */
export function pairingQrText(
  payload: Pick<GatewayPairingPayload, "webUrl" | "deepLink">,
  target: PairingTarget = "web",
): string {
  return target === "app" ? payload.deepLink : payload.webUrl;
}

/** 从二维码里读出来的配对信息。 */
export interface ScannedPairing {
  /** `https://<host>:<port>`。 */
  origin: string;
  ticket: string;
  /** 信任锚指纹，64 位小写十六进制；网页链接里可以没有。 */
  fingerprint: string;
}

const TICKET = /^[A-Za-z0-9._~-]+$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * 反过来：扫到的文本 → 配对信息。认两种形状（契约 §17.3）：
 *
 *  - `https://<host>:<port>/#pair=<票>[&fp=<指纹>]`
 *  - `armadra://pair?host=<host:port>&ticket=<票>&fp=<指纹>`
 *
 * 其余一律 `null`，不猜。
 */
export function parsePairingQr(text: string): ScannedPairing | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:") {
    const match = /^#pair=([A-Za-z0-9._~-]+)(?:&fp=([0-9a-f]{64}))?$/.exec(
      url.hash,
    );
    if (!match || (url.pathname !== "/" && url.pathname !== "")) return null;
    return {
      origin: url.origin,
      ticket: match[1]!,
      fingerprint: match[2] ?? "",
    };
  }
  if (url.protocol === "armadra:") {
    // `armadra://pair?…`：URL 把 `pair` 解析成主机。
    if (url.host !== "pair" && url.pathname.replace(/^\/+/, "") !== "pair")
      return null;
    const host = url.searchParams.get("host") ?? "";
    const ticket = url.searchParams.get("ticket") ?? "";
    const fingerprint = url.searchParams.get("fp") ?? "";
    if (!TICKET.test(ticket) || !FINGERPRINT.test(fingerprint)) return null;
    let origin: string;
    try {
      const parsed = new URL(`https://${host}`);
      if (parsed.host !== host || host === "") return null;
      origin = parsed.origin;
    } catch {
      return null;
    }
    return { origin, ticket, fingerprint };
  }
  return null;
}
