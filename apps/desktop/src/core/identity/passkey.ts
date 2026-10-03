import { isIP } from "node:net";
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { IdentityError, IdentityRefusal } from "./errors";
import type { PasskeyRow } from "./store";
import { newId } from "./tokens";

/**
 * passkey（WebAuthn）：契约 §18.2，架构 §8.3。
 *
 * 密码学全在 `@simplewebauthn/server`（精确版本）里：选项生成、注册与断言的
 * 校验、计数器判定都交给它，这里不碰 CBOR、COSE 与签名。这里只做三件库不管的
 * 事：
 *
 *   1. **RP ID 的选取**（{@link resolveRelyingParty}）。`identity.rpId` 覆盖一切；
 *      否则取公网来源的主机名，多个公网来源取它们的公共后缀（按标签，至少两段；
 *      取不到就用第一个并在 `fallback` 里如实报）；都没有时取请求来源的主机。
 *      主机是 IP 字面量时 WebAuthn 本身不可用——答 `passkey_unavailable_on_ip_host`，
 *      让设置页解释，而不是让浏览器抛 `SecurityError`。
 *   2. **挑战**：内存里存 2 分钟、一次性。取出即删，过期的同样删掉；重启丢光
 *      无妨——挑战本来就只活两分钟。
 *   3. **凭据与人的对应**：登录走可发现凭据（不给 `allowCredentials`，不按账号
 *      列凭据——列了就是一个「这个账号有没有 passkey」的探测接口），按断言里的
 *      凭据 ID 找行，再核对 `userHandle`。
 *
 * attestation 只收 `none`，不做证明链校验：这里要的是「同一把钥匙」，不是「哪家
 * 厂商的钥匙」。
 */

export const PASSKEY_CHALLENGE_TTL_MS = 2 * 60 * 1000;
export const PASSKEY_TIMEOUT_MS = 60 * 1000;
export const RP_NAME = "Armadra";
const MAX_CHALLENGES = 4096;

export interface RelyingParty {
  readonly rpId: string;
  /** 这次请求的来源，校验时逐字节比对 `clientDataJSON.origin`。 */
  readonly origin: string;
  /** 多个公网来源取不到公共后缀，退回了第一个的主机名。 */
  readonly fallback: boolean;
}

function hostOf(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    throw new IdentityError("invalid");
  }
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function within(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}

/** 一组主机名按标签的公共后缀；没有公共部分时是空串。 */
export function commonHostSuffix(hosts: readonly string[]): string {
  if (hosts.length === 0) return "";
  const split = hosts.map((host) => host.split(".").reverse());
  const shortest = Math.min(...split.map((labels) => labels.length));
  const common: string[] = [];
  for (let index = 0; index < shortest; index += 1) {
    const label = split[0]?.[index];
    if (
      label === undefined ||
      split.some((labels) => labels[index] !== label)
    ) {
      break;
    }
    common.push(label);
  }
  return common.reverse().join(".");
}

export function passkeyUnavailableOnIpHost(): IdentityRefusal {
  return new IdentityRefusal(
    "invalid",
    400,
    "passkey_unavailable_on_ip_host",
    "Passkeys need a domain name; this host is being reached by IP address",
  );
}

/**
 * 这次请求该用哪个 RP ID。纯函数。
 *
 * `publicOrigins` 里的 IP 主机不参与公共后缀（它们本来就用不了 passkey）。
 */
export function resolveRelyingParty(input: {
  readonly requestOrigin: string;
  readonly override?: string;
  readonly publicOrigins?: readonly string[];
}): RelyingParty {
  const requestHost = hostOf(input.requestOrigin);
  if (isIP(requestHost) !== 0) throw passkeyUnavailableOnIpHost();
  const mismatch = () =>
    new IdentityRefusal(
      "invalid",
      400,
      "passkey_rp_id_mismatch",
      "This origin is not covered by the configured passkey RP ID",
    );
  const override = (input.override ?? "").trim().toLowerCase();
  if (override !== "") {
    if (isIP(override) !== 0) throw passkeyUnavailableOnIpHost();
    if (!within(requestHost, override)) throw mismatch();
    return { rpId: override, origin: input.requestOrigin, fallback: false };
  }
  const hosts = (input.publicOrigins ?? [])
    .map(hostOf)
    .filter((host) => isIP(host) === 0);
  if (hosts.length > 0) {
    const suffix = commonHostSuffix(hosts);
    const usable =
      suffix !== "" &&
      (suffix.includes(".") || hosts.every((host) => host === suffix));
    const rpId = usable ? suffix : (hosts[0] as string);
    if (!within(requestHost, rpId)) throw mismatch();
    return { rpId, origin: input.requestOrigin, fallback: !usable };
  }
  return { rpId: requestHost, origin: input.requestOrigin, fallback: false };
}

/* --------------------------------- 挑战 ---------------------------------- */

interface Pending {
  readonly challenge: string;
  readonly purpose: "register" | "login";
  readonly principalId: string;
  readonly rp: RelyingParty;
  readonly label: string;
  readonly expiresAtMs: number;
}

export function challengeExpired(): IdentityRefusal {
  return new IdentityRefusal(
    "invalid",
    400,
    "passkey_challenge_expired",
    "The passkey challenge is unknown, used or expired; start again",
  );
}

/** 内存挑战表：两分钟、一次性。 */
export class ChallengeStore {
  private readonly pending = new Map<string, Pending>();

  put(value: Omit<Pending, "expiresAtMs">, nowMs: number): string {
    this.sweep(nowMs);
    if (this.pending.size >= MAX_CHALLENGES) {
      // 撑满只可能是有人在刷选项接口（IP 桶之外）；丢最老的，不拒新的。
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const id = newId();
    this.pending.set(id, {
      ...value,
      expiresAtMs: nowMs + PASSKEY_CHALLENGE_TTL_MS,
    });
    return id;
  }

  /** 取出即删；不存在、用途不对或过期都抛 `passkey_challenge_expired`。 */
  take(id: string, purpose: Pending["purpose"], nowMs: number): Pending {
    const value = this.pending.get(id);
    this.pending.delete(id);
    if (
      value === undefined ||
      value.purpose !== purpose ||
      value.expiresAtMs <= nowMs
    ) {
      throw challengeExpired();
    }
    return value;
  }

  size(): number {
    return this.pending.size;
  }

  private sweep(nowMs: number): void {
    for (const [id, value] of this.pending) {
      if (value.expiresAtMs <= nowMs) this.pending.delete(id);
    }
  }
}

/* --------------------------------- 流程 ---------------------------------- */

export interface NewPasskey {
  readonly webauthnId: string;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly aaguid: string;
  readonly transports: readonly string[];
  readonly label: string;
}

function userHandle(principalId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(principalId, "utf8"));
}

function verificationFailed(): IdentityRefusal {
  return new IdentityRefusal(
    "invalid",
    400,
    "passkey_verification_failed",
    "The passkey response did not verify",
  );
}

export class Passkeys {
  readonly challenges = new ChallengeStore();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  async registrationOptions(input: {
    readonly rp: RelyingParty;
    readonly principalId: string;
    readonly userName: string;
    readonly existing: readonly PasskeyRow[];
    readonly label?: string;
  }): Promise<{
    challengeId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: input.rp.rpId,
      userName: input.userName,
      userID: userHandle(input.principalId),
      timeout: PASSKEY_TIMEOUT_MS,
      attestationType: "none",
      excludeCredentials: input.existing.map((row) => ({
        id: row.webauthnId,
        transports: [...row.transports],
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
    });
    const challengeId = this.challenges.put(
      {
        challenge: options.challenge,
        purpose: "register",
        principalId: input.principalId,
        rp: input.rp,
        label: (input.label ?? "").slice(0, 128),
      },
      this.clock(),
    );
    return { challengeId, options };
  }

  /**
   * 校验注册应答。挑战必须是同一个人、同一个来源要的；任何一处不对都是
   * `passkey_verification_failed`，挑战照样作废。
   */
  async verifyRegistration(input: {
    readonly challengeId: string;
    readonly principalId: string;
    readonly origin: string;
    readonly response: unknown;
    readonly label?: string;
  }): Promise<NewPasskey> {
    const pending = this.challenges.take(
      input.challengeId,
      "register",
      this.clock(),
    );
    if (
      pending.principalId !== input.principalId ||
      pending.rp.origin !== input.origin
    ) {
      throw verificationFailed();
    }
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.rp.origin,
        expectedRPID: pending.rp.rpId,
        requireUserVerification: false,
      });
    } catch {
      throw verificationFailed();
    }
    if (!verified.verified) throw verificationFailed();
    const info = verified.registrationInfo;
    if (info.fmt !== "none") throw verificationFailed();
    const label = (input.label ?? pending.label).trim().slice(0, 128);
    return {
      webauthnId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey),
      signCount: info.credential.counter,
      aaguid: info.aaguid,
      transports: (info.credential.transports ?? []).slice(0, 8),
      label,
    };
  }

  async authenticationOptions(rp: RelyingParty): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      timeout: PASSKEY_TIMEOUT_MS,
      userVerification: "preferred",
    });
    const challengeId = this.challenges.put(
      {
        challenge: options.challenge,
        purpose: "login",
        principalId: "",
        rp,
        label: "",
      },
      this.clock(),
    );
    return { challengeId, options };
  }

  /**
   * 校验登录断言。`lookup` 按 WebAuthn 凭据 ID 找行（调用方在库里找）。失败一律
   * `unauthenticated`——不区分「没有这把钥匙」和「签名不对」。
   */
  async verifyAuthentication(input: {
    readonly challengeId: string;
    readonly origin: string;
    readonly response: unknown;
    readonly lookup: (webauthnId: string) => PasskeyRow | undefined;
  }): Promise<{ row: PasskeyRow; newCounter: number }> {
    const pending = this.challenges.take(
      input.challengeId,
      "login",
      this.clock(),
    );
    if (pending.rp.origin !== input.origin) {
      throw new IdentityError("unauthenticated");
    }
    const response = input.response as AuthenticationResponseJSON;
    const id = typeof response?.id === "string" ? response.id : "";
    const row = id === "" ? undefined : input.lookup(id);
    if (row === undefined) throw new IdentityError("unauthenticated");
    const handle = response.response?.userHandle;
    if (
      typeof handle === "string" &&
      handle !== "" &&
      handle !== Buffer.from(row.principalId, "utf8").toString("base64url")
    ) {
      throw new IdentityError("unauthenticated");
    }
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.rp.origin,
        expectedRPID: pending.rp.rpId,
        credential: {
          id: row.webauthnId,
          publicKey: new Uint8Array(row.publicKey),
          counter: row.signCount,
          transports: [...row.transports],
        },
        requireUserVerification: false,
      });
    } catch {
      // 计数器回退（克隆的认证器）也在这里：库判定拒绝，我们照拒。
      throw new IdentityError("unauthenticated");
    }
    if (!verified.verified) throw new IdentityError("unauthenticated");
    return { row, newCounter: verified.authenticationInfo.newCounter };
  }
}
