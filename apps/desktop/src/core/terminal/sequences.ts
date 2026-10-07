import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** Initialize once before PTY spawn. Existing/corrupt allocators are never reset. */
export function initializeContextSequence(
  directory: string,
  sessionId: string,
  generation: number,
): boolean {
  if (
    !/^[0-9a-f-]{36}$/i.test(sessionId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    return false;
  try {
    const existing = lstatSync(directory, { throwIfNoEntry: false });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      return false;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    const file = join(directory, `${sessionId}-${generation}.seq`);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 16)
        return false;
      if (process.platform !== "win32" && stat.mode & 0o077) return false;
      const bytes = readFileSync(file),
        count = bytes.readBigUInt64BE(0);
      return (
        count === (~bytes.readBigUInt64BE(8) & 0xffff_ffff_ffff_ffffn) &&
        count <= BigInt(Number.MAX_SAFE_INTEGER)
      );
    }
    const bytes = Buffer.alloc(16);
    bytes.writeBigUInt64BE(0xffff_ffff_ffff_ffffn, 8);
    const descriptor = openSync(file, "wx", 0o600);
    try {
      writeSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch {
    return false;
  }
}
