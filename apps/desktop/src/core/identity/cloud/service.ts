/**
 * 云登录与登记域的门面（契约 §31）：procedure、旧路径与别的域（源表 A1-3、
 * 隧道 A3-2、服务器壳 CLI A4-4）都经它，不直接碰里面的几块。
 */

import type { CloudLoginResult, CloudLogin } from "./login";
import {
  type CloudRelay,
  type CloudRegistry,
  IDLE_RELAY,
  type RelayCleaner,
} from "./register";
import type { SourceKey } from "./source-key";
import type { CloudStore, RegistrationRow } from "./store";

export class CloudService {
  private relay: CloudRelay = IDLE_RELAY;
  private cleaner: RelayCleaner | undefined;

  constructor(
    private readonly store: CloudStore,
    private readonly registry: CloudRegistry,
    private readonly logins: CloudLogin,
    private readonly key: SourceKey,
  ) {}

  /** 隧道（A3-2）装好之后挂上来；登记、撤销、状态从此经它。 */
  attachRelay(relay: CloudRelay): void {
    this.relay = relay;
  }

  /**
   * 源表域（`sources/`）装好之后挂上：撤销时用远程服务 owner 的会话删中继侧的
   * 源记录（契约 §31.4）。没挂时撤销照样完成，记为待清理。
   */
  attachRelayCleaner(cleaner: RelayCleaner): void {
    this.cleaner = cleaner;
  }

  /** 当前挂着的删源那一步（没挂时 `undefined`）。 */
  currentCleaner(): RelayCleaner | undefined {
    return this.cleaner;
  }

  /** 当前挂着的隧道（没装时是空实现）。 */
  currentRelay(): CloudRelay {
    return this.relay;
  }

  login(input: {
    readonly assertion: string;
    readonly invitationToken?: string | undefined;
    readonly origin: string;
    readonly remoteIp: string;
    readonly userAgent: string;
  }): Promise<CloudLoginResult> {
    return this.logins.login(input);
  }

  bind(principalId: string, assertion: string): Promise<{ bound: true }> {
    return this.logins.bind(principalId, assertion);
  }

  register(
    input: { issuer: string; registrationToken: string; label?: string },
    principalId?: string,
    pinnedFingerprint?: string,
  ) {
    return this.registry.register(input, principalId, pinnedFingerprint);
  }

  revoke(
    input: { issuer: string },
    principalId?: string,
    options?: { relaySide?: "revoked" },
  ) {
    return this.registry.revoke(input, principalId, options);
  }

  relayPending() {
    return this.registry.relayPending();
  }

  relayCleanup(input: { issuer: string }) {
    return this.registry.relayCleanup(input);
  }

  relayDismiss(input: { issuer: string }, principalId?: string) {
    return this.registry.relayDismiss(input, principalId);
  }

  status() {
    return this.registry.status();
  }

  trustedOrigins(input: { issuer: string; origins: string[] }) {
    return this.registry.trustedOrigins(input);
  }

  /** 这台 core 有没有有效登记到这个 issuer（`RemoteService.registered`）。 */
  registered(issuer: string): boolean {
    return this.registry.registered(issuer);
  }

  /** 一条有效登记（隧道要它的可信来源、中继来源）；没有是 `undefined`。 */
  registration(issuer: string): RegistrationRow | undefined {
    return this.store.live(issuer);
  }

  /** 全部有效登记（隧道启动时逐个起）。 */
  registrations(): RegistrationRow[] {
    return this.store.list();
  }

  /** 对这个远程服务的 CA 指纹（「远程服务」表里同一 issuer 那一行）；空串 = 系统信任。 */
  fingerprint(issuer: string): string {
    return this.store.remoteFingerprint(issuer);
  }

  /** `Authorization: Source <jws>`（`aud` = issuer），隧道取节点与令牌时用。 */
  signSourceJws(audience: string): Promise<string> {
    return this.key.signSourceJws(audience);
  }

  /** 隧道握手的 `auth`：用源私钥签那几行字节。私钥不出这个域。 */
  signBytes(data: Uint8Array): Promise<Uint8Array> {
    return this.key.signBytes(data);
  }
}
