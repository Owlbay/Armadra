import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { markManagedDirectory } from "../files/paths";
import { badRequest } from "../workspaces/support";

/**
 * `POST /api/workspaces/{id}/exports/{exportId}/png` — a whiteboard export.
 *
 * Whatever is on the whiteboard — ink, a shape, a whole frame — only exists
 * as vectors inside the browser's whiteboard document, so the one party that
 * can rasterise it is the page. It uploads the PNG as a data URL and the core
 * drops the bytes at `<workspace>/.armadra/exports/<exportId>.png`, which is
 * the path a linked agent is handed (`ContextLink.content.pngPath`).
 *
 * The export id is not required to be a node: the thing exported is usually
 * a plain whiteboard item, which has no row anywhere. It only has to be a
 * uuid, which is what keeps the file name from being a path.
 */

export const EXPORTS_DIRECTORY = ".armadra/exports";
/** A 480×360 whiteboard is tens of kilobytes; the cap stops a runaway client. */
export const MAX_EXPORT_PNG_BYTES = 8 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExportPngResult {
  /** Absolute path, which is what an agent is told to open. */
  readonly path: string;
  /** The same file relative to the workspace root. */
  readonly relativePath: string;
  readonly bytes: number;
}

export function writePngExport(
  root: string,
  exportId: string,
  dataUrl: string,
): ExportPngResult {
  if (!UUID.test(exportId)) throw badRequest("Export id is invalid");
  if (dataUrl.length > MAX_EXPORT_PNG_BYTES) {
    throw badRequest("Exported image is too large");
  }
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw badRequest("Only base64 PNG data URLs are accepted");
  }
  const payload = dataUrl.slice(PNG_DATA_URL_PREFIX.length).trim();
  if (payload === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw badRequest("Exported image is not valid base64");
  }
  const bytes = Buffer.from(payload, "base64");
  const directory = join(root, EXPORTS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  markManagedDirectory(join(root, ".armadra"));
  const path = join(directory, `${exportId}.png`);
  writeFileSync(path, bytes);
  return {
    path,
    relativePath: `${EXPORTS_DIRECTORY}/${exportId}.png`,
    bytes: bytes.length,
  };
}

/**
 * `POST /api/workspaces/{id}/exports/{exportId}/text` — a code block an agent
 * replied with, put on the board as an editor node (ACP 会话视图设计 §7，契约
 * §14.5).
 *
 * Same place and same rules as the PNG export, one level deeper: the export id
 * is the source node's uuid and the file lands at
 * `.armadra/exports/acp/<exportId>/<name>`. `.armadra` is ours (a self-ignoring
 * `.gitignore`), so the file never shows up in `git status`; the generic file
 * routes refuse to create directories in there, which is why this is its own
 * route rather than `PUT …/file`.
 *
 * The `.armadra` it lands in is the one in the agent's working directory
 * (`cwd`, the node's session row) when that directory is inside the workspace,
 * so the agent finds the file next to the code it is working on; anything else
 * — no session, a directory outside the workspace, one that is gone — falls
 * back to the workspace root. The answer's `relativePath` stays relative to
 * the workspace root either way, because that is what an editor node opens.
 */
export const TEXT_EXPORTS_DIRECTORY = `${EXPORTS_DIRECTORY}/acp`;
export const MAX_EXPORT_TEXT_BYTES = 1024 * 1024;
/** A plain file name: no separators, no leading dot, short. */
const EXPORT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

/**
 * Where under `root` a text export goes: `cwd` relative to the workspace root
 * in `/` form, or `""` for the root itself. Only a directory that exists and,
 * with its symlinks resolved, is strictly inside `root` qualifies, and never
 * one inside a managed or VCS folder.
 */
export function exportBase(root: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "" || !isAbsolute(cwd)) return "";
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return "";
  }
  const inside = relative(root, real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return "";
  const parts = inside.split(sep);
  if (parts.some((part) => part === ".armadra" || part === ".git")) return "";
  return parts.join("/");
}

export function writeTextExport(
  root: string,
  exportId: string,
  name: string,
  content: string,
  cwd?: string,
): ExportPngResult {
  if (!UUID.test(exportId)) throw badRequest("Export id is invalid");
  if (!EXPORT_NAME.test(name) || name.includes("..")) {
    throw badRequest("Export name is invalid");
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MAX_EXPORT_TEXT_BYTES) {
    throw badRequest("Exported text is too large");
  }
  const base = exportBase(root, cwd);
  const home = base === "" ? root : join(root, ...base.split("/"));
  const directory = join(home, TEXT_EXPORTS_DIRECTORY, exportId.toLowerCase());
  mkdirSync(directory, { recursive: true });
  markManagedDirectory(join(home, ".armadra"));
  const path = join(directory, name);
  writeFileSync(path, bytes);
  const inBase = `${TEXT_EXPORTS_DIRECTORY}/${exportId.toLowerCase()}/${name}`;
  return {
    path,
    relativePath: base === "" ? inBase : `${base}/${inBase}`,
    bytes: bytes.length,
  };
}
