import { lstatSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { canonicalDirectory, contains } from "../workspaces/roots";
import { ControllerError } from "./errors";

/** Validate existing ancestors too, so missing outputs cannot hide a symlink escape. */
export function scopedPath(
  root: string,
  requested: string,
): { path: string; relativePath: string } {
  if (
    !requested ||
    requested.length > 4096 ||
    /[\u0000-\u001f]/.test(requested) ||
    requested.includes("\\") ||
    isAbsolute(requested) ||
    /^[A-Za-z]:/.test(requested) ||
    requested.split("/").some((p) => p === ".." || p === "")
  )
    throw new ControllerError(
      "path_outside_workspace",
      "Use a relative path inside the selected workspace",
    );
  const base = canonicalDirectory(root);
  let candidate = base;
  let missingAncestor = false;
  for (const part of requested.split("/")) {
    candidate = resolve(candidate, part);
    const stat = missingAncestor
      ? undefined
      : lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) missingAncestor = true;
    if (stat) candidate = realpathSync.native(candidate);
    if (!contains(base, candidate))
      throw new ControllerError(
        "path_outside_workspace",
        "Path resolves outside the selected workspace",
        403,
      );
  }
  return {
    path: candidate,
    relativePath: relative(base, candidate).split(sep).join("/") || ".",
  };
}
