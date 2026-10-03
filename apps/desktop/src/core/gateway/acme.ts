import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import * as acme from "acme-client";
import { OUTBOUND } from "../net/outbound";
import type { CoreLog } from "../platform";
import {
  bitString,
  explicit,
  extension,
  integer,
  oid,
  sequence,
  set,
  subjectAltName,
} from "./der";
import { loopbackHost } from "./network";
import {
  ACME_ACCOUNT_KEY,
  ACME_CERT,
  ACME_DIR,
  ACME_KEY,
  ACME_STATE,
  SELF_SIGNED_DIR,
} from "./tls";

/**
 * Gateway 的第四种证书来源：ACME 内建（外部服务 §6.3，补全计划 G3-5）。
 *
 *   * **签发**：`acme-client` 走 `http-01`——本模块自己在 `ARMADRA_ACME_HTTP_PORT`
 *     （缺省 80）上开一个明文监听，只答 `/.well-known/acme-challenge/<令牌>`，
 *     其余请求 308 到对外来源。监听一直开着：续期也要用它。`tls-alpn-01` 不做
 *     ——它要在 TLS 握手里按 ALPN 换证书，而 80 端口在容器与反向代理部署里都是
 *     现成的。
 *   * **存放**：`<数据目录>/tls/acme/`，目录 0700，账户密钥、证书链、私钥与
 *     `state.json` 都是 0600。先写私钥再写证书，各自先写临时文件再改名。
 *   * **续期**：证书寿命过去三分之二时续（剩三分之一）。失败按 1、2、4…小时
 *     退避（封顶 12 小时，且不晚于剩余寿命的一半），**继续用旧证书**；连续失败
 *     到 {@link ACME_ALERT_AFTER} 次时通知一次（`onAlert`），成功后计数清零。
 *   * **启动**：已有证书没过期、覆盖全部名字、出自同一个目录地址就直接用（该续
 *     就在后台续）；否则当场签，签不出来就起不来——没有证书的 HTTPS 监听没有
 *     意义，悄悄退回自签名会让浏览器拦下所有人而运维不知道为什么。
 *
 * 配置（都在进程环境里，服务器壳的 `--acme <email>` 等同 `ARMADRA_ACME_EMAIL`）：
 * `ARMADRA_ACME_DIRECTORY`（缺省 Let's Encrypt 生产目录）、`ARMADRA_ACME_PROFILE`
 * （`shortlived` | `classic`；名字里有 IP 而没给时取 `shortlived`，IP 证书只有它）、
 * `ARMADRA_ACME_CA_BUNDLE`（信任目录服务器的 PEM 文件，Pebble / step-ca 用）、
 * `ARMADRA_ACME_HTTP_PORT` 与 `ARMADRA_ACME_HTTP_HOST`（挑战监听）。
 */

export const ACME_PROFILES = ["shortlived", "classic"] as const;
export type AcmeProfile = (typeof ACME_PROFILES)[number];

/** 连续失败多少次通知一次。 */
export const ACME_ALERT_AFTER = 3;
/** 证书寿命过去这么多就续。 */
export const ACME_RENEW_AT_FRACTION = 2 / 3;
export const ACME_DEFAULT_HTTP_PORT = 80;

const HOUR_MS = 60 * 60 * 1000;
const RETRY_BASE_MS = HOUR_MS;
const RETRY_MAX_MS = 12 * HOUR_MS;
const RETRY_MIN_MS = 60 * 1000;
/** `setTimeout` 的上限（约 24.8 天）；更远的到期分段等。 */
const TIMER_MAX_MS = 2 ** 31 - 1;
const CHALLENGE_PREFIX = "/.well-known/acme-challenge/";

export interface AcmeConfig {
  readonly email: string;
  /** 证书要覆盖的名字：域名或 IP 字面量，来自对外来源。 */
  readonly names: readonly string[];
  readonly directoryUrl: string;
  readonly profile?: AcmeProfile | undefined;
  /** 信任目录服务器用的 PEM 文本（测试 CA）。 */
  readonly caBundle?: string | undefined;
  readonly httpPort: number;
  readonly httpHost: string;
  /** 挑战监听上非挑战请求重定向去的地方。 */
  readonly redirectOrigin: string;
}

export class AcmeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 从邮箱、对外来源与环境拼出配置；缺东西就是 `acme_misconfigured`。纯函数（读
 * `ARMADRA_ACME_CA_BUNDLE` 指向的文件除外）。
 */
export function acmeConfigFrom(input: {
  readonly email: string;
  readonly publicOrigins: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}): AcmeConfig {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AcmeError("acme_misconfigured", "ACME 需要一个有效的联系邮箱");
  }
  const names: string[] = [];
  for (const origin of input.publicOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new AcmeError("acme_misconfigured", `对外来源不是 URL：${origin}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      loopbackHost(host)
    ) {
      throw new AcmeError(
        "acme_misconfigured",
        `ACME 不能给回环地址签证书：${origin}`,
      );
    }
    if (!names.includes(host)) names.push(host);
  }
  if (names.length === 0) {
    throw new AcmeError(
      "acme_misconfigured",
      "ACME 需要对外来源（--public-origin https://域名）",
    );
  }
  const env = input.env;
  const profileText = env.ARMADRA_ACME_PROFILE?.trim() ?? "";
  if (
    profileText !== "" &&
    !(ACME_PROFILES as readonly string[]).includes(profileText)
  ) {
    throw new AcmeError(
      "acme_misconfigured",
      `ARMADRA_ACME_PROFILE 只认 ${ACME_PROFILES.join(" / ")}`,
    );
  }
  const profile =
    profileText !== ""
      ? (profileText as AcmeProfile)
      : names.some((name) => isIP(name) !== 0)
        ? "shortlived"
        : undefined;
  const portText = env.ARMADRA_ACME_HTTP_PORT?.trim() ?? "";
  const httpPort = portText === "" ? ACME_DEFAULT_HTTP_PORT : Number(portText);
  if (!Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65_535) {
    throw new AcmeError(
      "acme_misconfigured",
      `ARMADRA_ACME_HTTP_PORT 不是端口：${portText}`,
    );
  }
  const bundlePath = env.ARMADRA_ACME_CA_BUNDLE?.trim() ?? "";
  let caBundle: string | undefined;
  if (bundlePath !== "") {
    try {
      caBundle = readFileSync(bundlePath, "utf8");
    } catch (error) {
      throw new AcmeError(
        "acme_misconfigured",
        `读不了 ARMADRA_ACME_CA_BUNDLE：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    email,
    names,
    directoryUrl:
      env.ARMADRA_ACME_DIRECTORY?.trim() || OUTBOUND.acmeLetsEncrypt.url,
    profile,
    caBundle,
    httpPort,
    httpHost: env.ARMADRA_ACME_HTTP_HOST?.trim() || "0.0.0.0",
    redirectOrigin: (input.publicOrigins[0] as string).replace(/\/+$/, ""),
  };
}

/* ------------------------------- 签发 ------------------------------------ */

/** `http-01` 的应答表：令牌 → key authorization。 */
export type ChallengeResponder = Map<string, string>;

export interface IssueRequest {
  readonly names: readonly string[];
  readonly email: string;
  readonly accountKey: string;
  readonly certificateKey: string;
  readonly profile?: AcmeProfile | undefined;
  readonly challenges: ChallengeResponder;
}

/** 一次签发；测试换成假的。返回 PEM 证书链（叶证书在前）。 */
export type AcmeIssuer = (request: IssueRequest) => Promise<string>;

/**
 * 真正的签发：`acme-client` 一步一步走 RFC 8555——账户、订单、授权、挑战、
 * 定稿、取证书。不用它的 `auto()`：那里传不进 `profile`。
 */
export function acmeClientIssuer(
  directoryUrl: string,
  caBundle?: string,
): AcmeIssuer {
  if (caBundle !== undefined) {
    // acme-client 的 HTTP 走它自己的 axios 实例；一个进程只有一个 ACME 目录。
    acme.axios.defaults.httpsAgent = new HttpsAgent({ ca: caBundle });
  }
  return async (request) => {
    const client = new acme.Client({
      directoryUrl,
      accountKey: request.accountKey,
    });
    await client.createAccount({
      termsOfServiceAgreed: true,
      contact: [`mailto:${request.email}`],
    });
    const order = await client.createOrder({
      identifiers: request.names.map((value) => ({
        type: isIP(value) === 0 ? "dns" : "ip",
        value,
      })),
      ...(request.profile === undefined ? {} : { profile: request.profile }),
    } as Parameters<typeof client.createOrder>[0]);
    const authorizations = await client.getAuthorizations(order);
    for (const authz of authorizations) {
      if (authz.status === "valid") continue;
      const challenge = authz.challenges.find(
        (candidate) => candidate.type === "http-01",
      );
      if (challenge === undefined) {
        throw new AcmeError(
          "acme_failed",
          `${authz.identifier.value} 没有 http-01 挑战可做`,
        );
      }
      const keyAuthorization =
        await client.getChallengeKeyAuthorization(challenge);
      request.challenges.set(challenge.token, keyAuthorization);
      try {
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
      } finally {
        request.challenges.delete(challenge.token);
      }
    }
    const csr = certificateRequest(request.names, request.certificateKey);
    const finalized = await client.finalizeOrder(order, csr);
    return client.getCertificate(finalized);
  };
}

/* ------------------------------ 管理器 ----------------------------------- */

export interface AcmeStatus {
  readonly directory: string;
  readonly profile: AcmeProfile | null;
  readonly names: readonly string[];
  readonly notAfter: string | null;
  /** 下一次续期的时间（失败后是下一次重试）。 */
  readonly renewAt: string | null;
  readonly failures: number;
  readonly lastError: { code: string; message: string } | null;
}

interface PersistedState {
  directoryUrl: string;
  names: string[];
  failures: number;
  lastError: { code: string; message: string } | null;
  lastAttemptAt: string | null;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AcmeManagerOptions {
  readonly log: CoreLog;
  readonly issuer?: AcmeIssuer;
  readonly now?: () => Date;
  readonly timers?: Timers;
  /** 连续失败到 {@link ACME_ALERT_AFTER} 次时调一次。 */
  readonly onAlert?: (status: AcmeStatus) => void;
  /** 测试用：不开挑战监听。 */
  readonly listen?: boolean;
}

const REAL_TIMERS: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class AcmeManager {
  readonly directory: string;
  private readonly issuer: AcmeIssuer;
  private readonly now: () => Date;
  private readonly timers: Timers;
  private readonly challenges: ChallengeResponder = new Map();
  private readonly renewedListeners: (() => void)[] = [];
  private state: PersistedState;
  private server: Server | undefined;
  private timer: unknown;
  private renewAt: Date | undefined;
  private running: Promise<boolean> | undefined;
  private closed = false;

  constructor(
    dataDir: string,
    readonly config: AcmeConfig,
    private readonly options: AcmeManagerOptions,
  ) {
    this.directory = join(dataDir, SELF_SIGNED_DIR, ACME_DIR);
    this.issuer =
      options.issuer ?? acmeClientIssuer(config.directoryUrl, config.caBundle);
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? REAL_TIMERS;
    this.state = this.readState();
  }

  /** 开挑战监听，手里没有可用的证书就当场签；然后排上续期。 */
  async start(): Promise<void> {
    if (this.options.listen !== false) await this.listen();
    try {
      const current = this.current();
      if (current === undefined) {
        const ok = await this.renew();
        if (!ok) {
          const error = this.state.lastError;
          throw new AcmeError(
            error?.code ?? "acme_failed",
            error?.message ?? "ACME 签发失败",
          );
        }
      } else {
        this.schedule(this.dueAt(current));
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** 续期成功后调（Gateway 借它热换证书）。 */
  onRenewed(listener: () => void): void {
    this.renewedListeners.push(listener);
  }

  /** 挑战监听实际绑定的端口（`ARMADRA_ACME_HTTP_PORT=0` 时由内核分配）。 */
  httpPort(): number | undefined {
    const address = this.server?.address();
    return address !== null && typeof address === "object"
      ? address.port
      : undefined;
  }

  status(): AcmeStatus {
    const current = this.current(true);
    return {
      directory: this.config.directoryUrl,
      profile: this.config.profile ?? null,
      names: [...this.config.names],
      notAfter:
        current === undefined ? null : new Date(current.validTo).toISOString(),
      renewAt: this.renewAt?.toISOString() ?? null,
      failures: this.state.failures,
      lastError: this.state.lastError,
    };
  }

  /**
   * 签一次（续期与首签同一条路）。串行：同时来的第二次等第一次的结果。成功写
   * 文件、清零计数并通知；失败只记账、排重试，旧证书原样留着。
   */
  renew(): Promise<boolean> {
    if (this.running !== undefined) return this.running;
    const attempt = this.renewOnce().finally(() => {
      this.running = undefined;
    });
    this.running = attempt;
    return attempt;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
  }

  private async renewOnce(): Promise<boolean> {
    const at = this.now();
    try {
      const certificateKey = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const chain = await this.issuer({
        names: this.config.names,
        email: this.config.email,
        accountKey: this.accountKey(),
        certificateKey,
        profile: this.config.profile,
        challenges: this.challenges,
      });
      const leaf = new X509Certificate(chain);
      if (!leaf.checkPrivateKey(createPrivate(certificateKey))) {
        throw new AcmeError("acme_failed", "CA 发回的证书与私钥对不上");
      }
      this.ensureDirectory();
      replacePrivate(join(this.directory, ACME_KEY), certificateKey);
      replacePrivate(join(this.directory, ACME_CERT), chain);
      this.state = {
        directoryUrl: this.config.directoryUrl,
        names: [...this.config.names],
        failures: 0,
        lastError: null,
        lastAttemptAt: at.toISOString(),
      };
      this.writeState();
      this.options.log.info("ACME 证书已签发", {
        names: this.config.names,
        notAfter: leaf.validTo,
      });
      if (!this.closed) this.schedule(this.dueAt(leaf));
      for (const listener of this.renewedListeners) {
        try {
          listener();
        } catch (error) {
          this.options.log.warn("ACME 证书热换失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return true;
    } catch (error) {
      const failures = this.state.failures + 1;
      this.state = {
        ...this.state,
        failures,
        lastError: {
          code: error instanceof AcmeError ? error.code : "acme_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        lastAttemptAt: at.toISOString(),
      };
      this.writeState();
      this.options.log.warn("ACME 签发失败，继续用手里的证书", {
        failures,
        error: this.state.lastError?.message,
      });
      if (!this.closed) this.schedule(this.retryAt(failures));
      if (failures === ACME_ALERT_AFTER) {
        this.options.log.error("ACME 续期连续失败", { failures });
        this.options.onAlert?.(this.status());
      }
      return false;
    }
  }

  /**
   * 手里那张还能不能用：在、解得开、和私钥配得上、没过期、覆盖全部名字、出自
   * 同一个目录。`expired` 为真时过期的也返回（状态页要报它的到期时间）。
   */
  private current(expired = false): X509Certificate | undefined {
    const certFile = join(this.directory, ACME_CERT);
    const keyFile = join(this.directory, ACME_KEY);
    if (!existsSync(certFile) || !existsSync(keyFile)) return undefined;
    try {
      const parsed = new X509Certificate(readFileSync(certFile, "utf8"));
      if (
        !parsed.checkPrivateKey(createPrivate(readFileSync(keyFile, "utf8")))
      ) {
        return undefined;
      }
      if (expired) return parsed;
      if (new Date(parsed.validTo).getTime() <= this.now().getTime()) {
        return undefined;
      }
      if (this.state.directoryUrl !== this.config.directoryUrl)
        return undefined;
      const names = sanNames(parsed);
      if (!this.config.names.every((name) => names.includes(name))) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private dueAt(certificate: X509Certificate): Date {
    const from = new Date(certificate.validFrom).getTime();
    const to = new Date(certificate.validTo).getTime();
    return new Date(from + (to - from) * ACME_RENEW_AT_FRACTION);
  }

  private retryAt(failures: number): Date {
    const now = this.now().getTime();
    let delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    const current = this.current();
    if (current !== undefined) {
      const remaining = new Date(current.validTo).getTime() - now;
      delay = Math.min(delay, remaining / 2);
    }
    return new Date(now + Math.max(delay, RETRY_MIN_MS));
  }

  private schedule(at: Date): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.renewAt = at;
    const wait = Math.max(0, at.getTime() - this.now().getTime());
    this.timer = this.timers.set(
      () => {
        this.timer = undefined;
        if (this.closed) return;
        if (this.now().getTime() < at.getTime()) {
          this.schedule(at);
          return;
        }
        void this.renew();
      },
      Math.min(wait, TIMER_MAX_MS),
    );
  }

  private accountKey(): string {
    const file = join(this.directory, ACME_ACCOUNT_KEY);
    if (existsSync(file)) return readFileSync(file, "utf8");
    this.ensureDirectory();
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    replacePrivate(file, key);
    return key;
  }

  private readState(): PersistedState {
    const empty: PersistedState = {
      directoryUrl: "",
      names: [],
      failures: 0,
      lastError: null,
      lastAttemptAt: null,
    };
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.directory, ACME_STATE), "utf8"),
      ) as Partial<PersistedState>;
      return {
        directoryUrl:
          typeof parsed.directoryUrl === "string" ? parsed.directoryUrl : "",
        names: Array.isArray(parsed.names) ? parsed.names.map(String) : [],
        failures:
          typeof parsed.failures === "number" && parsed.failures >= 0
            ? parsed.failures
            : 0,
        lastError:
          parsed.lastError !== null &&
          typeof parsed.lastError === "object" &&
          typeof parsed.lastError?.code === "string"
            ? {
                code: parsed.lastError.code,
                message: String(parsed.lastError.message ?? ""),
              }
            : null,
        lastAttemptAt:
          typeof parsed.lastAttemptAt === "string"
            ? parsed.lastAttemptAt
            : null,
      };
    } catch {
      return empty;
    }
  }

  private writeState(): void {
    this.ensureDirectory();
    replacePrivate(
      join(this.directory, ACME_STATE),
      `${JSON.stringify(this.state, null, 2)}\n`,
    );
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private async listen(): Promise<void> {
    const server = createHttpServer((request, response) =>
      this.answer(request, response),
    );
    await new Promise<void>((done, failed) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        failed(
          new AcmeError(
            "acme_port_unavailable",
            `ACME 挑战端口 ${this.config.httpHost}:${this.config.httpPort} 开不了：${error.code ?? error.message}（ARMADRA_ACME_HTTP_PORT 可改）`,
          ),
        );
      });
      server.listen(this.config.httpPort, this.config.httpHost, () => done());
    });
    this.server = server;
  }

  private answer(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://acme").pathname;
    if (path.startsWith(CHALLENGE_PREFIX)) {
      const answer = this.challenges.get(path.slice(CHALLENGE_PREFIX.length));
      if (answer === undefined) {
        response.writeHead(404, { "content-type": "text/plain" }).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        })
        .end(answer);
      return;
    }
    // 明文端口上别的请求一律去 HTTPS：80 端口开着本来就是为了 ACME。
    response
      .writeHead(308, {
        location: `${this.config.redirectOrigin}${request.url ?? "/"}`,
      })
      .end();
  }
}

/**
 * PKCS#10 证书请求（RFC 2986）：空 subject、P-256 公钥、`extensionRequest` 里
 * 只有 SAN，ecdsa-with-SHA256 签名。自己拼而不用 acme-client 的 `createCsr`：
 * 后者经 `@peculiar/x509` 的反射元数据建扩展，在被打包或被测试运行器重复加载
 * 时会找不到 schema；本目录已经有一套给证书用的 DER 写入器。
 */
export function certificateRequest(
  names: readonly string[],
  keyPem: string,
): string {
  const key = createPrivateKey(keyPem);
  const spki = createPublicKey(key).export({
    type: "spki",
    format: "der",
  }) as Buffer;
  const extensions = sequence(
    extension("2.5.29.17", false, subjectAltName(names)),
  );
  const info = sequence(
    integer(0),
    sequence(),
    spki,
    // attributes [0] IMPLICIT SET OF Attribute：一个 extensionRequest。
    explicit(0, sequence(oid("1.2.840.113549.1.9.14"), set(extensions))),
  );
  const signature = createSign("SHA256").update(info).sign(key);
  const der = sequence(
    info,
    sequence(oid("1.2.840.10045.4.3.2")),
    bitString(signature),
  );
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END CERTIFICATE REQUEST-----\n`;
}

function createPrivate(pem: string) {
  return createPrivateKey(pem);
}

function sanNames(parsed: X509Certificate): string[] {
  return (parsed.subjectAltName ?? "")
    .split(",")
    .map((entry) =>
      entry
        .trim()
        .replace(/^(DNS|IP Address|IP):/, "")
        .toLowerCase(),
    )
    .filter((entry) => entry !== "");
}

/** 0600 的临时文件改名过去：断电时留下的要么是旧的，要么是完整的新的。 */
function replacePrivate(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}
