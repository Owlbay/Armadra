import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  MAX_AGENT_UPLOAD_BYTES,
  type AgentUploadResponse,
} from "@armadra/shared";

import { assetExtension } from "../assets/store";
import { DomainError, badRequest, notFound } from "../workspaces/support";
import { mimeOrOctetStream } from "./mime";

/**
 * 粘贴或拖进 Agent 节点的文件（契约 §56）。
 *
 * 落在**这台 core 的数据目录**里，不进工作区：`<dataDir>/agent-uploads/<工作空间>/<id>/<名字>`。
 * 页面发往哪个源，字节就落在哪台机器上——经中继到达的源，core 在另一台机器，
 * 会话也在那台，所以 Agent 读得到的路径就在它自己的盘上。
 *
 *   * **一个工作空间一个目录**：id 是 128 位随机数，查找时同时要工作空间对得上，
 *     别的工作空间的 id 读不到。
 *   * **名字只留安全字符**：`[A-Za-z0-9._-]`，扩展名保留。粘进终端的路径因此
 *     不需要按 shell 转义（数据目录本身带空格时另说，粘贴那一侧会加引号）。
 *   * **有上限，会清**：单个文件 {@link MAX_AGENT_UPLOAD_BYTES}；超过
 *     {@link UPLOAD_TTL_MS} 的、以及一个工作空间合计超过
 *     {@link MAX_WORKSPACE_UPLOAD_BYTES} 时最旧的，在每次上传后与 core 启动时删掉。
 *   * 正文不进日志、事件与持久化；答复里只有名字、路径、类型与字节数。
 */

export const UPLOADS_DIRECTORY = "agent-uploads";

/** 一份上传留这么久（按目录的修改时间）。 */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 一个工作空间的上传合计不超过这么多；超了从最旧的删起。 */
export const MAX_WORKSPACE_UPLOAD_BYTES = 256 * 1024 * 1024;

const ID = /^[0-9a-f]{32}$/;
const WORKSPACE = /^[A-Za-z0-9-]{1,64}$/;
const NAME_LIMIT = 80;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export type StoredUpload = AgentUploadResponse;

function workspaceDirectory(dataDir: string, workspaceId: string): string {
  if (!WORKSPACE.test(workspaceId)) throw badRequest("Workspace id is invalid");
  return join(dataDir, UPLOADS_DIRECTORY, workspaceId);
}

/**
 * 页面给的文件名 → 落盘的名字：去掉目录部分，只留安全字符，长度有限，扩展名
 * 保留；剪贴板里的截图常常没有扩展名，按 `Content-Type` 补一个图片扩展名。
 */
export function sanitizeUploadName(
  name: string | null | undefined,
  contentType = "",
): string {
  const base = (name ?? "").split(/[\\/]/).at(-1) ?? "";
  let clean = base
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/[._]+$/, "");
  if (clean === "") clean = "file";
  let dot = clean.lastIndexOf(".");
  if (dot <= 0) {
    const extension = assetExtension(contentType);
    if (extension !== undefined) {
      clean = `${clean === "file" ? "image" : clean}.${extension}`;
      dot = clean.lastIndexOf(".");
    }
  }
  if (clean.length > NAME_LIMIT) {
    const extension = dot > 0 ? clean.slice(dot).slice(0, 16) : "";
    clean = clean.slice(0, NAME_LIMIT - extension.length) + extension;
  }
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  return clean;
}

function describe(id: string, directory: string, name: string): StoredUpload {
  const path = join(directory, name);
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile()) throw notFound("Upload was not found");
  return {
    id,
    name,
    path,
    mimeType: mimeOrOctetStream(name),
    bytes: info.size,
  };
}

/** 存一份上传，然后顺手清一遍这个工作空间。 */
export function storeUpload(
  dataDir: string,
  workspaceId: string,
  requestedName: string | null | undefined,
  contentType: string,
  bytes: Buffer,
  now: number = Date.now(),
): StoredUpload {
  if (bytes.byteLength === 0) throw badRequest("Upload is empty");
  if (bytes.byteLength > MAX_AGENT_UPLOAD_BYTES) {
    throw new DomainError(413, "payload_too_large", "Upload is too large");
  }
  const root = workspaceDirectory(dataDir, workspaceId);
  const id = randomBytes(16).toString("hex");
  const directory = join(root, id);
  const name = sanitizeUploadName(requestedName, contentType);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, name), bytes, { mode: 0o600 });
  const stored = describe(id, directory, name);
  pruneUploads(dataDir, workspaceId, now, id);
  return stored;
}

/** 按 id 找回一份上传；不在这个工作空间里就是没有。 */
export function resolveUpload(
  dataDir: string,
  workspaceId: string,
  id: string,
): StoredUpload {
  if (!ID.test(id)) throw badRequest("Upload id is invalid");
  const directory = join(workspaceDirectory(dataDir, workspaceId), id);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    throw notFound("Upload was not found");
  }
  const name = names.find((entry) => !entry.startsWith("."));
  if (name === undefined) throw notFound("Upload was not found");
  return describe(id, directory, name);
}

interface Entry {
  readonly path: string;
  readonly at: number;
  readonly bytes: number;
}

function entriesOf(root: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      const info = statSync(path);
      if (!info.isDirectory()) continue;
      let bytes = 0;
      for (const file of readdirSync(path)) {
        bytes +=
          statSync(join(path, file), { throwIfNoEntry: false })?.size ?? 0;
      }
      entries.push({ path, at: info.mtimeMs, bytes });
    } catch {
      // 并发删掉了：不算。
    }
  }
  return entries;
}

/**
 * 删掉过期的，再把合计压到上限以内（从最旧的删起）。`keep` 是刚存的那一份：
 * 它本身已经过了单文件上限，不会被自己的合计挤掉。不给工作空间时清所有的。
 */
export function pruneUploads(
  dataDir: string,
  workspaceId?: string,
  now: number = Date.now(),
  keep?: string,
): void {
  const base = join(dataDir, UPLOADS_DIRECTORY);
  let roots: string[];
  if (workspaceId !== undefined) {
    roots = [workspaceDirectory(dataDir, workspaceId)];
  } else {
    try {
      roots = readdirSync(base)
        .filter((name) => WORKSPACE.test(name))
        .map((name) => join(base, name));
    } catch {
      return;
    }
  }
  for (const root of roots) {
    const fresh: Entry[] = [];
    for (const entry of entriesOf(root)) {
      if (
        now - entry.at > UPLOAD_TTL_MS &&
        !entry.path.endsWith(keep ?? "\0")
      ) {
        rmSync(entry.path, { recursive: true, force: true });
      } else {
        fresh.push(entry);
      }
    }
    let total = fresh.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of fresh.sort((a, b) => a.at - b.at)) {
      if (total <= MAX_WORKSPACE_UPLOAD_BYTES) break;
      if (keep !== undefined && entry.path.endsWith(keep)) continue;
      rmSync(entry.path, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }
}
