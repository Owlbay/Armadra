import {
  type KeyObject,
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bitString,
  boolean,
  commonName,
  explicit,
  extension,
  implicit,
  integer,
  octetString,
  oid,
  sequence,
  subjectAltName,
  utcTime,
} from "./der";

/**
 * Gateway 的 TLS 材料（服务器壳与桌面对外服务共用）。
 *
 * 三条路，`status` 必须能说清走的是哪一条：
 *
 *   * **运维给的证书**（`--tls-cert` / `--tls-key`，或设置 `gateway.tls` 的
 *     `file` 来源，成对，缺一是错误）。core 不签发也不续期，证书的生命周期是
 *     运维的事。
 *   * **自签名**（服务器壳的缺省）。没给就在数据目录下生成一张，并在 `status`
 *     与启动日志里明确标注「自签名」——一张浏览器会拦的证书不是一个可以安静
 *     发生的默认值。
 *   * **本地 CA**（桌面 Gateway 的缺省，架构 §7）。`<数据目录>/tls/` 下一张长期
 *     的 CA（私钥 0600）加一张它签的叶证书；叶证书的 SAN 覆盖主机名与当前所有
 *     私网地址，地址变了只重签叶证书、CA 不变——手机装一次 CA 就够。
 *
 * 明文 HTTP 不是一个选项：会话走 Cookie，`__Host-` 前缀与 `Secure` 属性都要求
 * 安全上下文，没有 TLS 的 Gateway 连会话都建不起来。
 *
 * 信任锚指纹（{@link TlsMaterial.fingerprint}）：有本地 CA 时是 CA 的，其余是
 * 叶证书的；原生 App 按它钉证书，二维码里的 `fp` 就是它。
 */

export const SELF_SIGNED_DIR = "tls";
export const SELF_SIGNED_CERT = "self-signed.crt";
export const SELF_SIGNED_KEY = "self-signed.key";
export const LOCAL_CA_CERT = "ca.crt";
export const LOCAL_CA_KEY = "ca.key";
export const LOCAL_LEAF_CERT = "leaf.crt";
export const LOCAL_LEAF_KEY = "leaf.key";

/** 自签名证书的有效期。够长到不打断一次部署，短到不像一张永久凭证。 */
export const SELF_SIGNED_DAYS = 397;
/** 本地 CA 的有效期：手机装一次要管很久，十年。 */
export const LOCAL_CA_DAYS = 3650;
/** 叶证书比上限（398 天）少一天，Apple 的平台对更长的叶证书不认。 */
export const LOCAL_LEAF_DAYS = 397;
/** 剩余有效期少于这个就提前重签叶证书，免得在两次检查之间过期。 */
export const LEAF_RENEW_BEFORE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ACME 签来的证书（`./acme.ts`）：`<数据目录>/tls/acme/` 下，目录 0700、每个
 * 文件 0600。签发与续期是 ACME 管理器的事；这里只按文件读出当前那一张。
 */
export const ACME_DIR = "acme";
export const ACME_CERT = "cert.pem";
export const ACME_KEY = "key.pem";
export const ACME_ACCOUNT_KEY = "account.key";
export const ACME_STATE = "state.json";

export type TlsSourceKind = "file" | "selfSigned" | "localCa" | "acme";

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  /** 走的是哪一条路。 */
  readonly source: TlsSourceKind;
  /** `source === "selfSigned"`，留给服务器壳既有的日志与状态。 */
  readonly selfSigned: boolean;
  /** 证书文件的路径；运维给的就是他给的那个。 */
  readonly certFile: string;
  readonly keyFile: string;
  readonly notAfter: string;
  readonly subject: string;
  /** 叶证书 SAN 里的名字（`DNS:` / `IP Address:` 前缀已去掉）。 */
  readonly names: readonly string[];
  /** 信任锚 DER 的 SHA-256，小写十六进制、无分隔符。 */
  readonly fingerprint: string;
  /**
   * `GET /ca.crt` 发出去的那张 PEM：本地 CA 是 CA 本身；自签名是那张自签名
   * 证书（它自己就是根）；指定文件时是链文件里的最后一张（只有一张、即没有链
   * 时为 `undefined`）。
   */
  readonly anchor?: string;
}

export interface TlsRequest {
  readonly certFile?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly dataDir: string;
  /** 证书要覆盖的名字：监听地址、主机名、私网地址与公网来源的主机。 */
  readonly hosts: readonly string[];
  /**
   * 没给证书文件时走哪一条。缺省 `selfSigned`（服务器壳的既有行为）。`acme`
   * 读 ACME 管理器已经写好的那一对，没有就是错误——签发不在这里发生。
   */
  readonly generated?: "selfSigned" | "localCa" | "acme";
  readonly now?: () => Date;
}

export function resolveTls(request: TlsRequest): TlsMaterial {
  const { certFile, keyFile } = request;
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error("--tls-cert 与 --tls-key 必须成对给出");
  }
  if (certFile !== undefined && keyFile !== undefined) {
    return fileMaterial(certFile, keyFile);
  }
  const now = request.now ?? (() => new Date());
  if (request.generated === "acme") return acmeMaterial(request.dataDir);
  if (request.generated === "localCa") {
    return localCaMaterial(request.dataDir, request.hosts, now());
  }
  const directory = join(request.dataDir, SELF_SIGNED_DIR);
  const generatedCert = join(directory, SELF_SIGNED_CERT);
  const generatedKey = join(directory, SELF_SIGNED_KEY);
  const reusable = reuse(generatedCert, generatedKey, request.hosts, now());
  if (reusable !== undefined) return reusable;
  const material = selfSignedCertificate(request.hosts, now());
  privateDirectory(directory);
  writePrivate(generatedKey, material.key);
  writeFileSync(generatedCert, material.cert, { mode: 0o644 });
  return describe(material.cert, material.key, {
    source: "selfSigned",
    certFile: generatedCert,
    keyFile: generatedKey,
  });
}

/** 运维给的证书文件：原样用；链里多于一张时最后一张当作信任锚发出去。 */
function fileMaterial(certFile: string, keyFile: string): TlsMaterial {
  const cert = readFileSync(certFile, "utf8");
  const key = readFileSync(keyFile, "utf8");
  const chain = pemBlocks(cert);
  return describe(cert, key, {
    source: "file",
    certFile,
    keyFile,
    anchor: chain.length > 1 ? chain[chain.length - 1] : undefined,
  });
}

/**
 * ACME 管理器写下的证书链与私钥。公共 CA 签的证书不需要用户装根，所以没有
 * 信任锚可发（`/ca.crt` 答 404）；指纹是叶证书的，每次续期都会变。
 */
export function acmeMaterial(dataDir: string): TlsMaterial {
  const directory = join(dataDir, SELF_SIGNED_DIR, ACME_DIR);
  const certFile = join(directory, ACME_CERT);
  const keyFile = join(directory, ACME_KEY);
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    throw new Error("还没有 ACME 证书：签发要先于监听");
  }
  return describe(
    readFileSync(certFile, "utf8"),
    readFileSync(keyFile, "utf8"),
    { source: "acme", certFile, keyFile },
  );
}

function describe(
  cert: string,
  key: string,
  options: {
    source: TlsSourceKind;
    certFile: string;
    keyFile: string;
    anchor?: string | undefined;
    anchorFingerprint?: string;
  },
): TlsMaterial {
  const parsed = new X509Certificate(cert);
  return {
    cert,
    key,
    source: options.source,
    selfSigned: options.source === "selfSigned",
    certFile: options.certFile,
    keyFile: options.keyFile,
    notAfter: parsed.validTo,
    subject: parsed.subject,
    names: sanNames(parsed),
    fingerprint: options.anchorFingerprint ?? fingerprintOf(parsed),
    ...(options.anchor !== undefined
      ? { anchor: options.anchor }
      : options.source === "selfSigned"
        ? { anchor: cert }
        : {}),
  };
}

/** DER 的 SHA-256，小写十六进制。原生 App 与配对载荷里的 `fp` 都是这个拼法。 */
export function fingerprintOf(certificate: X509Certificate | string): string {
  const parsed =
    typeof certificate === "string"
      ? new X509Certificate(certificate)
      : certificate;
  return createHash("sha256").update(parsed.raw).digest("hex");
}

/** 一份 PEM 文本里的每一张证书，按出现顺序。 */
export function pemBlocks(text: string): string[] {
  return (
    text.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []
  ).map((block) => `${block}\n`);
}

function sanNames(parsed: X509Certificate): string[] {
  return (parsed.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^(DNS|IP Address|IP):/, ""))
    .filter((entry) => entry !== "");
}

function covers(parsed: X509Certificate, hosts: readonly string[]): boolean {
  const names = sanNames(parsed).map((name) => name.toLowerCase());
  return hosts.every((host) => {
    const literal =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return names.includes(literal.toLowerCase());
  });
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

/**
 * 私钥先建成 0600 再写：`writeFileSync` 的 mode 受 umask 影响，而一份短暂可读
 * 的私钥和一份一直可读的私钥是同一个问题。
 */
function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** 先写临时文件再改名：重签到一半断电，留下的仍是上一对能配上的证书与私钥。 */
function replaceFile(file: string, content: string, mode: number): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, file);
}

/**
 * 已经生成过的那张还能不能接着用：文件在、解得开、没过期、而且覆盖了这次要
 * 服务的每一个名字。少一个名字就重新生成——一张对不上主机名的证书在浏览器那
 * 里和没有证书一样。
 */
function reuse(
  certFile: string,
  keyFile: string,
  hosts: readonly string[],
  now: Date,
): TlsMaterial | undefined {
  if (!existsSync(certFile) || !existsSync(keyFile)) return undefined;
  try {
    const cert = readFileSync(certFile, "utf8");
    const key = readFileSync(keyFile, "utf8");
    const parsed = new X509Certificate(cert);
    if (new Date(parsed.validTo).getTime() <= now.getTime()) return undefined;
    if (!covers(parsed, hosts)) return undefined;
    return describe(cert, key, { source: "selfSigned", certFile, keyFile });
  } catch {
    return undefined;
  }
}

/* -------------------------------- 本地 CA -------------------------------- */

export interface LocalCa {
  readonly cert: string;
  readonly key: KeyObject;
  readonly parsed: X509Certificate;
}

/**
 * 本地 CA：有就读，没有就生成。读得出来但过期或坏了**不**悄悄换一张——那等于
 * 让每台装过 CA 的手机同时失效，而用户不会知道为什么；这时抛错，由状态页报
 * 「证书需要重置」。
 */
export function localCa(dataDir: string, now: Date): LocalCa {
  const directory = join(dataDir, SELF_SIGNED_DIR);
  const certFile = join(directory, LOCAL_CA_CERT);
  const keyFile = join(directory, LOCAL_CA_KEY);
  if (existsSync(certFile) && existsSync(keyFile)) {
    const cert = readFileSync(certFile, "utf8");
    const key = createPrivateKey(readFileSync(keyFile, "utf8"));
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(key)) {
      throw new Error("本地 CA 的证书与私钥对不上");
    }
    if (new Date(parsed.validTo).getTime() <= now.getTime()) {
      throw new Error("本地 CA 已过期：重置证书后手机需要重新安装 CA");
    }
    return { cert, key, parsed };
  }
  privateDirectory(directory);
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const name = commonName(`Armadra Local CA ${randomBytes(4).toString("hex")}`);
  const keyId = subjectKeyId(spki);
  const cert = signCertificate({
    subject: name,
    issuer: name,
    spki,
    signer: privateKey,
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(now.getTime() + LOCAL_CA_DAYS * DAY_MS),
    extensions: [
      // basicConstraints: CA, pathLen 0——它只签叶证书，不签下级 CA。
      extension("2.5.29.19", true, sequence(boolean(true), integer(0))),
      // keyCertSign | cRLSign
      extension("2.5.29.15", true, bitString(Buffer.from([0x06]), 1)),
      extension("2.5.29.14", false, octetString(keyId)),
    ],
  });
  writePrivate(
    keyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  writeFileSync(certFile, cert, { mode: 0o644 });
  return { cert, key: privateKey, parsed: new X509Certificate(cert) };
}

function localCaMaterial(
  dataDir: string,
  hosts: readonly string[],
  now: Date,
): TlsMaterial {
  const ca = localCa(dataDir, now);
  const directory = join(dataDir, SELF_SIGNED_DIR);
  const certFile = join(directory, LOCAL_LEAF_CERT);
  const keyFile = join(directory, LOCAL_LEAF_KEY);
  const anchorFingerprint = fingerprintOf(ca.parsed);
  const existing = reusableLeaf(certFile, keyFile, ca, hosts, now);
  if (existing !== undefined) {
    return describe(existing.cert, existing.key, {
      source: "localCa",
      certFile,
      keyFile,
      anchor: ca.cert,
      anchorFingerprint,
    });
  }
  const leaf = issueLeaf(ca, hosts, now);
  // 先换私钥再换证书：中间断掉时，下一次启动发现两者对不上就再签一次。
  replaceFile(keyFile, leaf.key, 0o600);
  replaceFile(certFile, leaf.cert, 0o644);
  return describe(leaf.cert, leaf.key, {
    source: "localCa",
    certFile,
    keyFile,
    anchor: ca.cert,
    anchorFingerprint,
  });
}

function reusableLeaf(
  certFile: string,
  keyFile: string,
  ca: LocalCa,
  hosts: readonly string[],
  now: Date,
): { cert: string; key: string } | undefined {
  if (!existsSync(certFile) || !existsSync(keyFile)) return undefined;
  try {
    const cert = readFileSync(certFile, "utf8");
    const key = readFileSync(keyFile, "utf8");
    const parsed = new X509Certificate(cert);
    const remaining = new Date(parsed.validTo).getTime() - now.getTime();
    if (remaining <= LEAF_RENEW_BEFORE_DAYS * DAY_MS) return undefined;
    // 换过 CA（用户重置）之后旧叶子不再由它签，不能接着用。
    if (!parsed.verify(ca.parsed.publicKey)) return undefined;
    if (!parsed.checkPrivateKey(createPrivateKey(key))) return undefined;
    // 名字只看「覆盖」：地址少了一个不必重签，多了一个才必须。
    if (!covers(parsed, hosts)) return undefined;
    return { cert, key };
  } catch {
    return undefined;
  }
}

/**
 * 本地 CA 签的叶证书，SAN 覆盖传进来的每一个名字。`options` 给测试里的假 CA
 * 用（ACME 用例要给定私钥与有效期签一张）。
 */
export function issueLeaf(
  ca: LocalCa,
  hosts: readonly string[],
  now: Date,
  options: {
    readonly privateKey?: KeyObject;
    readonly notBefore?: Date;
    readonly notAfter?: Date;
  } = {},
): { cert: string; key: string } {
  if (hosts.length === 0) throw new Error("叶证书至少要覆盖一个名字");
  const privateKey =
    options.privateKey ??
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const caSpki = createPublicKey(ca.key).export({
    type: "spki",
    format: "der",
  }) as Buffer;
  const cert = signCertificate({
    subject: commonName(hosts[0] as string),
    // issuer 必须与 CA 的 subject 逐字节相同，直接取 CA 证书里的那段编码。
    issuer: subjectDer(ca.parsed),
    spki,
    signer: ca.key,
    notBefore: options.notBefore ?? new Date(now.getTime() - 60 * 60 * 1000),
    notAfter:
      options.notAfter ?? new Date(now.getTime() + LOCAL_LEAF_DAYS * DAY_MS),
    extensions: [
      extension("2.5.29.19", true, sequence()),
      // digitalSignature
      extension("2.5.29.15", true, bitString(Buffer.from([0x80]), 7)),
      // extKeyUsage: serverAuth
      extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
      extension("2.5.29.17", false, subjectAltName(hosts)),
      extension("2.5.29.14", false, octetString(subjectKeyId(spki))),
      extension(
        "2.5.29.35",
        false,
        sequence(implicit(0, subjectKeyId(caSpki))),
      ),
    ],
  });
  return {
    cert,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** RFC 5280 §4.2.1.2 的方法一：公钥 BIT STRING 内容的 SHA-1。 */
function subjectKeyId(spki: Buffer): Buffer {
  // SPKI = SEQUENCE { AlgorithmIdentifier, BIT STRING }；P-256 的公钥是 65 字节
  // 的未压缩点，紧跟在 BIT STRING 头与「未用位数」之后，位于末尾。
  return createHash("sha1")
    .update(spki.subarray(spki.length - 65))
    .digest();
}

/**
 * 证书里 subject 那段 DER，原样取出。`X509Certificate` 不给原始字节，所以按
 * TBSCertificate 的结构走：version、serial、signature、issuer、validity、
 * subject——第六个元素。
 */
function subjectDer(parsed: X509Certificate): Buffer {
  const tbs = children(children(parsed.raw)[0] as Buffer);
  const hasVersion = ((tbs[0] as Buffer)[0] as number) === 0xa0;
  return tbs[hasVersion ? 5 : 4] as Buffer;
}

/** 一个构造类型 TLV 的直接子元素，每个都是完整的 TLV。 */
function children(element: Buffer): Buffer[] {
  const { headerLength, length } = tlvHeader(element, 0);
  const out: Buffer[] = [];
  let offset = headerLength;
  const end = headerLength + length;
  while (offset < end) {
    const inner = tlvHeader(element, offset);
    out.push(
      element.subarray(offset, offset + inner.headerLength + inner.length),
    );
    offset += inner.headerLength + inner.length;
  }
  return out;
}

function tlvHeader(
  buffer: Buffer,
  offset: number,
): { headerLength: number; length: number } {
  const first = buffer[offset + 1] as number;
  if (first < 0x80) return { headerLength: 2, length: first };
  const count = first & 0x7f;
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = length * 256 + (buffer[offset + 2 + index] as number);
  }
  return { headerLength: 2 + count, length };
}

/* -------------------------------- 签发 ---------------------------------- */

function signCertificate(input: {
  subject: Buffer;
  issuer: Buffer;
  spki: Buffer;
  signer: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: readonly Buffer[];
}): string {
  // ecdsa-with-SHA256。参数字段按 RFC 5758 省略。
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"));
  const serial = randomBytes(16);
  serial[0] = (serial[0] as number) & 0x7f;
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    algorithm,
    input.issuer,
    sequence(utcTime(input.notBefore), utcTime(input.notAfter)),
    input.subject,
    input.spki,
    explicit(3, sequence(...input.extensions)),
  );
  const signature = createSign("SHA256").update(tbs).sign(input.signer);
  return pem("CERTIFICATE", sequence(tbs, algorithm, bitString(signature)));
}

/** 一张自签名的 P-256 证书，SAN 覆盖传进来的每一个名字。 */
export function selfSignedCertificate(
  hosts: readonly string[],
  now: Date,
): { cert: string; key: string } {
  if (hosts.length === 0) throw new Error("自签名证书至少要覆盖一个名字");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const subject = commonName(hosts[0] as string);
  const cert = signCertificate({
    subject,
    issuer: subject,
    spki,
    signer: privateKey,
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(now.getTime() + SELF_SIGNED_DAYS * DAY_MS),
    extensions: [
      // 自签名的叶子同时是自己的根：客户端要么钉它，要么把它装进信任库。
      extension("2.5.29.19", true, sequence(boolean(true))),
      // digitalSignature | keyEncipherment | keyCertSign
      extension("2.5.29.15", true, bitString(Buffer.from([0xa4]), 2)),
      // extKeyUsage: serverAuth
      extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
      extension("2.5.29.17", false, subjectAltName(hosts)),
    ],
  });
  return {
    cert,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** RFC 8737 的 `id-pe-acmeIdentifier`。 */
export const ACME_IDENTIFIER_OID = "1.3.6.1.5.5.7.1.31";

/**
 * `tls-alpn-01` 的挑战证书（RFC 8737 §3）：自签名，SAN 只有这一个标识（域名进
 * `dNSName`、IP 进 `iPAddress`），带一条**关键**扩展 `acmeIdentifier`，内容是
 * key authorization 的 SHA-256。只在 ALPN 为 `acme-tls/1` 的握手里出示，验完
 * 就扔，所以有效期只给一天。
 */
export function acmeChallengeCertificate(
  identifier: string,
  keyAuthorization: string,
  now: Date,
): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // subject 留空：标识在 SAN 里，CN 的 64 字符上限管不到长域名。
  const subject = sequence();
  const digest = createHash("sha256").update(keyAuthorization).digest();
  const cert = signCertificate({
    subject,
    issuer: subject,
    spki,
    signer: privateKey,
    notBefore: new Date(now.getTime() - 60 * 60 * 1000),
    notAfter: new Date(now.getTime() + DAY_MS),
    extensions: [
      extension("2.5.29.17", false, subjectAltName([identifier])),
      // Authorization ::= OCTET STRING (SIZE (32))，再包进扩展值的 OCTET STRING。
      extension(ACME_IDENTIFIER_OID, true, octetString(digest)),
    ],
  });
  return {
    cert,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}
