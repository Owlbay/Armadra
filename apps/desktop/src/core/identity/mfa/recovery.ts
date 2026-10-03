import {
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * 恢复码：一批 10 个，只在生成的那一次以明文出现，库里只存 scrypt 哈希。
 *
 * 码长 10 个字符、取自 32 个不易混淆的字符（50 比特），显示成 `xxxxx-xxxxx`。熵
 * 够高，所以 scrypt 用比口令低一档的成本（N=2^14）；同一批共用一份盐，一次校验
 * 只派生一次，再和这一批的哈希逐个定时比较——不必为每个码各跑一遍 scrypt。
 */

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // 去掉 i l o 0 1
const CODE_LENGTH = 10;
const SALT_BYTES = 16;
const KDF = { N: 1 << 14, r: 8, p: 1 } as const;
const HASH_BYTES = 32;

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = "";
    for (let index = 0; index < CODE_LENGTH; index += 1) {
      raw += ALPHABET[randomInt(ALPHABET.length)];
    }
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/** 用户怎么敲都行：大小写、空格、连字符都不算。 */
export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]+/g, "");
}

export function recoveryCodeShape(input: string): boolean {
  const value = normalizeRecoveryCode(input);
  return (
    value.length === CODE_LENGTH &&
    [...value].every((c) => ALPHABET.includes(c))
  );
}

function derive(code: string, salt: Buffer): Buffer {
  return scryptSync(
    Buffer.from(normalizeRecoveryCode(code), "utf8"),
    salt,
    HASH_BYTES,
    {
      ...KDF,
      maxmem: 256 * KDF.N * KDF.r,
    },
  );
}

export function hashRecoveryCodes(
  codes: readonly string[],
  salt: Buffer = randomBytes(SALT_BYTES),
): { codeHash: Buffer; salt: Buffer }[] {
  return codes.map((code) => ({ codeHash: derive(code, salt), salt }));
}

/**
 * 输入命中这一批里哪个还没用过的码；没命中 `undefined`。按盐分组派生，所以混
 * 了两批（不该发生）也照样对。
 */
export function matchRecoveryCode(
  input: string,
  rows: readonly { codeHash: Buffer; salt: Buffer; usedAtMs: number }[],
): Buffer | undefined {
  if (!recoveryCodeShape(input)) return undefined;
  const derived = new Map<string, Buffer>();
  let found: Buffer | undefined;
  for (const row of rows) {
    const key = row.salt.toString("hex");
    let candidate = derived.get(key);
    if (candidate === undefined) {
      candidate = derive(input, row.salt);
      derived.set(key, candidate);
    }
    const equal =
      candidate.length === row.codeHash.length &&
      timingSafeEqual(candidate, row.codeHash);
    // 用过的也比较一遍，耗时不随「这个码用没用过」变化。
    if (equal && row.usedAtMs === 0 && found === undefined)
      found = row.codeHash;
  }
  return found;
}
