import {
  IdentityRequestError,
  IdentityTransportError,
  pairIdentity,
  pairWithGateway,
  takePairingTicket,
} from "../api/identity";
import { exchangePairingCode } from "../api/gateway";
import { saveRuntimeOrigin } from "../api/runtime-url";
import { parsePairingQr } from "../host/qr";
import type { ConnectFailure } from "./ConnectScreen";
import { nativeBridge, type NativeBridge } from "./native-bridge";

/** 配对失败 → 连接页的原因。认不出的一律 `failed`。 */
export function failureOf(error: unknown): ConnectFailure {
  if (error instanceof IdentityTransportError) return "unreachable";
  if (error instanceof IdentityRequestError) {
    // 配对码换票的几种拒绝（契约 §24）。
    if (error.code === "pairing_code_invalid") return "codeInvalid";
    if (error.code === "pairing_code_disabled") return "codeDisabled";
    if (error.code === "origin_mismatch") return "codeOrigin";
    if (error.status === 429) return "rateLimited";
  }
  if (
    error instanceof IdentityRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 410)
  )
    return "expired";
  return "failed";
}

export interface NativeConnectDeps {
  readonly bridge: NativeBridge;
  readonly pair: typeof pairWithGateway;
  readonly save: (origin: string) => void;
  /** 记下来源后重新加载：`RUNTIME_URL` 在模块求值时就定了。 */
  readonly reload: () => void;
}

const nativeDeps = (): NativeConnectDeps => ({
  bridge: nativeBridge(),
  pair: pairWithGateway,
  save: saveRuntimeOrigin,
  reload: () => globalThis.location.reload(),
});

/**
 * 原生 App：配对链接（网页链接或 `armadra://pair` 深链，契约 §17.3）→ 先把
 * 信任锚指纹交给原生钉扎 → 用票配对（凭据进钥匙串）→ 记下来源 → 重载。
 *
 * 指纹必须有：App 不装 CA，没有指纹就没有东西可钉，宁可不连。
 */
export async function connectNative(
  link: string,
  deps: NativeConnectDeps = nativeDeps(),
): Promise<ConnectFailure | null> {
  const scanned = parsePairingQr(link);
  if (scanned === null) return "invalid";
  if (scanned.fingerprint === "") return "noFingerprint";
  try {
    await deps.bridge.pin(scanned.origin, scanned.fingerprint);
  } catch {
    return "pin";
  }
  try {
    await deps.pair(scanned.origin, scanned.ticket);
  } catch (error) {
    return failureOf(error);
  }
  deps.save(scanned.origin);
  deps.reload();
  return null;
}

/**
 * 手机浏览器：页面就是经这个 Gateway 打开的，票从 `#pair=` 来，这时才取走并
 * 从地址栏抹掉。会话是 Cookie，配对成功就能进画布。
 */
export async function connectWeb(
  ticket: string = takePairingTicket(),
  pair: typeof pairIdentity = pairIdentity,
): Promise<ConnectFailure | null> {
  if (ticket === "") return "expired";
  try {
    await pair(ticket);
    return null;
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * 配对码（契约 §24）：8 位换出一张与 `#pair=` 相同的票，再照常配对。
 *
 *  - 手机浏览器：页面就是经这个 Gateway 打开的，会话是 Cookie。
 *  - 原生 App：只在已经记下（并钉过）一个 Gateway 来源时可用——App 不装 CA，
 *    没钉过信任锚就连不上，拿不到码换出来的指纹。换出的指纹照样再钉一次，
 *    锚变了（重置 CA）这一步就失败，不自动信任新证书。
 */
export async function connectWithCode(
  code: string,
  target:
    | { readonly mode: "web" }
    | { readonly mode: "native"; readonly origin: string },
  deps: {
    readonly exchange?: typeof exchangePairingCode;
    readonly pairWeb?: typeof pairIdentity;
    readonly native?: NativeConnectDeps;
  } = {},
): Promise<ConnectFailure | null> {
  const exchange = deps.exchange ?? exchangePairingCode;
  let payload: Awaited<ReturnType<typeof exchangePairingCode>>;
  try {
    payload =
      target.mode === "web"
        ? await exchange(code)
        : await exchange(code, target.origin);
  } catch (error) {
    return failureOf(error);
  }
  if (target.mode === "web") {
    try {
      await (deps.pairWeb ?? pairIdentity)(payload.ticket);
      return null;
    } catch (error) {
      return failureOf(error);
    }
  }
  const native = deps.native ?? nativeDeps();
  if (payload.origin !== target.origin) return "failed";
  try {
    await native.bridge.pin(payload.origin, payload.fingerprint);
  } catch {
    return "pin";
  }
  try {
    await native.pair(payload.origin, payload.ticket);
  } catch (error) {
    return failureOf(error);
  }
  native.save(payload.origin);
  native.reload();
  return null;
}
