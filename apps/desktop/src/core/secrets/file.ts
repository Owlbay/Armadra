/**
 * 数据目录里的三种文件后端：明文 0600（`file`）、壳封存的密文（`dpapi` /
 * `libsecret`）、master key 封装（`file-encrypted`）。
 *
 * 后两种写的是同一个信封：`{ v, kind, … , data }`。信封记着是谁封的，所以一份
 * 桌面壳 DPAPI 封的条目落到服务器壳手里时，报的是「由别的后端封存」，而不是一次
 * 莫名其妙的解密失败。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  type SecretBackend,
  type SecretBackendKind,
  type SecretSealer,
  SecretUnavailable,
  checkSecretName,
} from "./backend";

/** 单个条目的上限：令牌与 API key 都远小于它，大得离谱的文件不被信任。 */
const MAX_ENTRY_BYTES = 64 * 1024;

/** 目录 0700、文件从创建那一刻就是 0600，经临时文件 + rename 原子替换。 */
export function writePrivateFile(path: string, content: string | Buffer): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.new`;
  rmSync(temporary, { force: true });
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeSync(
      handle,
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    );
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

/** 读一个私有文件；不在时 `undefined`，被放宽过权限或大得离谱时不被信任。 */
export function readPrivateFile(path: string): Buffer | undefined {
  if (!existsSync(path)) return undefined;
  const info = statSync(path);
  // 被放宽过的文件不再被信任：别的东西已经有过读它的机会。Windows 上 mode 位不
  // 反映 ACL，只能信用户目录的继承权限。
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new SecretUnavailable("permissions_widened");
  }
  if (info.size > MAX_ENTRY_BYTES) throw new SecretUnavailable("oversized");
  return readFileSync(path);
}

/* --------------------------------- 明文 ---------------------------------- */

/**
 * `<dir>/<name>.token`，0600 明文。没有 OS 存储可用时的降级，后端如实报 `file`。
 */
export function plainFileBackend(directory: string): SecretBackend {
  const path = (name: string) =>
    join(directory, `${checkSecretName(name)}.token`);
  return {
    kind: "file",
    async get(name) {
      const content = readPrivateFile(path(name));
      if (content === undefined) return undefined;
      const value = content.toString("utf8").trim();
      return value === "" ? undefined : value;
    },
    async set(name, value) {
      writePrivateFile(path(name), value);
    },
    async delete(name) {
      rmSync(path(name), { force: true });
    },
  };
}

/* --------------------------------- 信封 ---------------------------------- */

interface Envelope {
  readonly v: 1;
  readonly kind: SecretBackendKind;
  readonly keyId?: string;
  readonly iv?: string;
  readonly tag?: string;
  readonly data: string;
}

function parseEnvelope(content: Buffer): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    throw new SecretUnavailable("corrupt");
  }
  const envelope = parsed as Partial<Envelope> | null;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.v !== 1 ||
    typeof envelope.kind !== "string" ||
    typeof envelope.data !== "string"
  ) {
    throw new SecretUnavailable("corrupt");
  }
  return envelope as Envelope;
}

function envelopeFile(directory: string, name: string): string {
  return join(directory, `${checkSecretName(name)}.sealed`);
}

/* ------------------------------ 壳封存的密文 ------------------------------ */

/**
 * `<dir>/<name>.sealed`，内容由 {@link SecretSealer}（桌面壳的 `safeStorage`）封。
 * 密文按用户、按机器绑定，所以别的后端读到它只能报 `sealed_by_<kind>`。
 */
export function sealedFileBackend(
  directory: string,
  sealer: SecretSealer,
): SecretBackend {
  return {
    kind: sealer.kind,
    async get(name) {
      const content = readPrivateFile(envelopeFile(directory, name));
      if (content === undefined) return undefined;
      const envelope = parseEnvelope(content);
      if (envelope.kind !== sealer.kind) {
        throw new SecretUnavailable(`sealed_by_${envelope.kind}`);
      }
      const plain = await sealer.unseal(Buffer.from(envelope.data, "base64"));
      const value = plain.toString("utf8");
      return value === "" ? undefined : value;
    },
    async set(name, value) {
      const path = envelopeFile(directory, name);
      const sealed = await sealer.seal(Buffer.from(value, "utf8"));
      const envelope: Envelope = {
        v: 1,
        kind: sealer.kind,
        data: sealed.toString("base64"),
      };
      writePrivateFile(path, JSON.stringify(envelope));
    },
    async delete(name) {
      rmSync(envelopeFile(directory, name), { force: true });
    },
  };
}

/* ---------------------------- master key 封装 ----------------------------- */

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** 一把 master key 的指纹：只用来在信封里认出「这条是哪把钥匙封的」。 */
export function masterKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function decodeKey(content: Buffer, path: string): Buffer {
  const text = content.toString("utf8").trim();
  const key = Buffer.from(text, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== text) {
    throw new Error(`master key at ${path} is not 32 bytes of base64`);
  }
  return key;
}

/** 读一把 master key；不在时 `undefined`。坏的钥匙文件是错误，不是「生成一把新的」。 */
export function readMasterKey(path: string): Buffer | undefined {
  const content = readPrivateFile(path);
  return content === undefined ? undefined : decodeKey(content, path);
}

/**
 * 读 master key，不在时生成一把（0600）。
 *
 * 只在**数据目录里**的默认位置生成：一个由运维指过去的路径（systemd
 * `LoadCredential=`）缺了是配置错误，生成一把新的会让旧条目全部打不开。
 */
export function loadOrCreateMasterKey(
  path: string,
  options: { readonly create: boolean },
): Buffer {
  const existing = readMasterKey(path);
  if (existing !== undefined) return existing;
  if (!options.create) {
    throw new Error(`master key file ${path} does not exist`);
  }
  const key = randomBytes(KEY_BYTES);
  writePrivateFile(path, `${key.toString("base64")}\n`);
  return key;
}

function seal(key: Buffer, value: string): Envelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    v: 1,
    kind: "file-encrypted",
    keyId: masterKeyId(key),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function open(keys: readonly Buffer[], envelope: Envelope): string {
  if (envelope.kind !== "file-encrypted") {
    throw new SecretUnavailable(`sealed_by_${envelope.kind}`);
  }
  const key = keys.find(
    (candidate) => masterKeyId(candidate) === envelope.keyId,
  );
  if (key === undefined || envelope.iv === undefined || !envelope.tag) {
    throw new SecretUnavailable("unknown_master_key");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretUnavailable("corrupt");
  }
}

export interface EncryptedFileOptions {
  /** 条目所在目录。 */
  readonly directory: string;
  /** 当前的 master key 文件。 */
  readonly keyFile: string;
  /** 不在时生不生成（只有数据目录里的默认位置才生成）。 */
  readonly createKey: boolean;
}

/** 轮换中途留下的上一把钥匙；轮换做完就删。 */
export function previousKeyFile(keyFile: string): string {
  return `${keyFile}.previous`;
}

/**
 * `<dir>/<name>.sealed`，AES-256-GCM，钥匙是 `keyFile` 里的 32 字节。
 *
 * 每次操作现读钥匙：轮换（{@link rotateMasterKey}）可以在 core 运行时做完，而一次
 * 中途中断的轮换留下 `.previous`，用它还能打开还没重封的条目。
 */
export function encryptedFileBackend(
  options: EncryptedFileOptions,
): SecretBackend {
  const keys = (): Buffer[] => {
    const current = loadOrCreateMasterKey(options.keyFile, {
      create: options.createKey,
    });
    const previous = readMasterKey(previousKeyFile(options.keyFile));
    return previous === undefined ? [current] : [current, previous];
  };
  return {
    kind: "file-encrypted",
    async get(name) {
      const content = readPrivateFile(envelopeFile(options.directory, name));
      if (content === undefined) return undefined;
      const value = open(keys(), parseEnvelope(content));
      return value === "" ? undefined : value;
    },
    async set(name, value) {
      const [current] = keys();
      writePrivateFile(
        envelopeFile(options.directory, name),
        JSON.stringify(seal(current as Buffer, value)),
      );
    },
    async delete(name) {
      rmSync(envelopeFile(options.directory, name), { force: true });
    },
  };
}

/**
 * 换一把 master key，并把目录里每个条目用新钥匙重封。
 *
 * 顺序保证任何一步中断都不丢条目：先全部解开（有一条打不开就整个放弃，什么都没
 * 改）；旧钥匙留成 `.previous`；写新钥匙；逐条重封；最后删 `.previous`。
 *
 * 返回重封的条目数。
 */
export function rotateMasterKey(
  options: Omit<EncryptedFileOptions, "createKey">,
  next: Buffer = randomBytes(KEY_BYTES),
): number {
  if (next.length !== KEY_BYTES) throw new Error("master key must be 32 bytes");
  const current = readMasterKey(options.keyFile);
  if (current === undefined) {
    throw new Error(`master key file ${options.keyFile} does not exist`);
  }
  const previous = readMasterKey(previousKeyFile(options.keyFile));
  const known = previous === undefined ? [current] : [current, previous];
  const entries = existsSync(options.directory)
    ? readdirSync(options.directory).filter((file) => file.endsWith(".sealed"))
    : [];
  const opened = entries.map((file) => {
    const path = join(options.directory, file);
    const content = readPrivateFile(path);
    if (content === undefined) return undefined;
    const envelope = parseEnvelope(content);
    // 别的后端封的条目不归这把钥匙管，原样留着。
    if (envelope.kind !== "file-encrypted") return undefined;
    return { path, value: open(known, envelope) };
  });
  writePrivateFile(
    previousKeyFile(options.keyFile),
    `${current.toString("base64")}\n`,
  );
  writePrivateFile(options.keyFile, `${next.toString("base64")}\n`);
  let count = 0;
  for (const entry of opened) {
    if (entry === undefined) continue;
    writePrivateFile(entry.path, JSON.stringify(seal(next, entry.value)));
    count += 1;
  }
  rmSync(previousKeyFile(options.keyFile), { force: true });
  return count;
}
