import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeSecret } from "../../core/paths";
import { CliError } from "./client";

export interface Profile {
  schemaVersion: 1;
  controllerId: string;
  workspaceId: string;
  credential: string;
  dataDir: string;
}
export function profilesDirectory(): string {
  return (
    process.env.ARMADRA_CONTROLLER_PROFILES_DIR ??
    join(homedir(), ".config/armadra/controller-profiles")
  );
}
function pathFor(name: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name))
    throw new CliError(
      "invalid_arguments",
      "Profile names use letters, digits, underscores and dashes",
      2,
    );
  return join(profilesDirectory(), name + ".json");
}
export function saveProfile(name: string, profile: Profile): void {
  const path = pathFor(name);
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw new CliError("profile_exists", "Choose an unused profile name", 5);
  writeSecret(path, JSON.stringify(profile) + "\n");
}
export function loadProfile(
  name: string | undefined,
  dataDir: string,
): { name: string; profile: Profile } {
  if (!name) {
    let entries: string[];
    try {
      entries = readdirSync(profilesDirectory()).filter((f) =>
        f.endsWith(".json"),
      );
    } catch {
      entries = [];
    }
    const choices = entries
      .map((f) => f.slice(0, -5))
      .filter((n) => {
        try {
          return loadProfile(n, dataDir).profile.dataDir === resolve(dataDir);
        } catch {
          return false;
        }
      });
    if (choices.length !== 1)
      throw new CliError(
        "target_required",
        "Select an explicit --profile; no unique profile exists for this data directory",
        2,
      );
    name = choices[0]!;
  }
  const path = pathFor(name);
  let profile: Profile;
  try {
    const file = lstatSync(path);
    const directory = lstatSync(profilesDirectory());
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      directory.isSymbolicLink() ||
      (file.mode & 0o777) !== 0o600 ||
      (directory.mode & 0o777) !== 0o700 ||
      file.uid !== process.getuid?.()
    )
      throw new Error("unsafe profile permissions");
    profile = JSON.parse(readFileSync(path, "utf8")) as Profile;
    if (
      profile.schemaVersion !== 1 ||
      typeof profile.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(profile.credential) ||
      typeof profile.controllerId !== "string" ||
      typeof profile.workspaceId !== "string"
    )
      throw new Error("invalid profile");
  } catch {
    throw new CliError(
      "authorization_required",
      "Profile is missing, invalid or not private (0600 file, 0700 directory)",
      4,
    );
  }
  if (profile.dataDir !== resolve(dataDir))
    throw new CliError(
      "scope_denied",
      "Profile belongs to another core data directory",
      4,
    );
  return { name, profile };
}
export function removeProfile(name: string): void {
  rmSync(pathFor(name), { force: true });
}
