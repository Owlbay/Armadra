import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tempDir } from "../../core/testing/temp-dir";
import { loadProfile, saveProfile } from "./profiles";

let directory: string;
beforeEach(() => {
  directory = tempDir("armadra-private-profiles-");
  vi.stubEnv("ARMADRA_CONTROLLER_PROFILES_DIR", join(directory, "profiles"));
});
afterEach(() => vi.unstubAllEnvs());
it("rejects traversal in profile names before any file is created", () => {
  expect(() =>
    saveProfile("../escape", {
      schemaVersion: 1,
      controllerId: "c",
      workspaceId: "w",
      credential: "a".repeat(43),
      dataDir: directory,
    }),
  ).toThrow();
});

if (process.platform !== "win32") {
  it("keeps credentials private, refuses scope mistakes and ambiguous profile selection", () => {
    const profile = {
      schemaVersion: 1 as const,
      controllerId: "controller",
      workspaceId: "workspace",
      credential: "a".repeat(43),
      dataDir: directory,
    };
    saveProfile("first", profile);
    const path = join(directory, "profiles/first.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "profiles")).mode & 0o777).toBe(0o700);
    expect(loadProfile(undefined, directory).name).toBe("first");
    expect(() => loadProfile("first", "other-data-dir")).toThrow();
    expect(() => saveProfile("first", profile)).toThrow();
    expect(readFileSync(path, "utf8")).toContain(profile.credential);
    saveProfile("second", profile);
    expect(() => loadProfile(undefined, directory)).toThrow();
    chmodSync(path, 0o644);
    expect(() => loadProfile("first", directory)).toThrow();
    expect(() => saveProfile("../escape", profile)).toThrow();
  });
}
