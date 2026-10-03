import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plainFileBackend } from "../secrets";
import { tempDir } from "../testing/temp-dir";
import {
  AMA_KEY_PROVIDERS,
  AmaCredentials,
  amaSecretName,
  setAmaCredentials,
} from "./ama-credentials";
import { writeAmaAuth } from "./canvas-launch";
import { artifactLayout } from "../hook/install/inject";

const FAKE_KEY = "sk-test-not-a-real-key";

afterEach(() => setAmaCredentials(undefined));

describe("ama's model keys", () => {
  it("answers whether a key is set and where, never the key", async () => {
    const root = tempDir("armadra-ama-keys-");
    const credentials = new AmaCredentials(
      plainFileBackend(join(root, "secrets")),
    );
    const before = await credentials.status();
    expect(before.backend).toBe("file");
    expect(before.providers.map((entry) => entry.id)).toEqual([
      ...AMA_KEY_PROVIDERS,
    ]);
    expect(before.providers.every((entry) => !entry.isSet)).toBe(true);

    await credentials.set("deepseek", FAKE_KEY);
    const after = await credentials.status();
    expect(
      after.providers.find((entry) => entry.id === "deepseek")?.isSet,
    ).toBe(true);
    expect(JSON.stringify(after)).not.toContain(FAKE_KEY);

    // A fresh instance reads it back from the backend.
    const again = new AmaCredentials(plainFileBackend(join(root, "secrets")));
    expect(
      (await again.status()).providers.find((entry) => entry.id === "deepseek")
        ?.isSet,
    ).toBe(true);

    await credentials.clear("deepseek");
    expect(
      (await credentials.status()).providers.some((entry) => entry.isSet),
    ).toBe(false);
  });

  it("names its entries inside the secret namespace", () => {
    for (const provider of AMA_KEY_PROVIDERS) {
      expect(amaSecretName(provider)).toMatch(/^armadra-ama-[a-z]+$/);
    }
  });

  it("writes auth.json 0600 at the path the profile names, before a start", async () => {
    const root = tempDir("armadra-ama-auth-");
    const dataDir = join(root, "data");
    // No credentials domain at all: an empty file, not a stale one.
    const empty = writeAmaAuth(dataDir);
    expect(empty).toBe(artifactLayout(dataDir, "ama").authFile);
    expect(JSON.parse(readFileSync(empty, "utf8"))).toEqual({
      version: 1,
      providers: {},
    });

    const credentials = new AmaCredentials(
      plainFileBackend(join(root, "secrets")),
    );
    await credentials.set("openai", FAKE_KEY);
    setAmaCredentials(credentials);
    const path = writeAmaAuth(dataDir);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      providers: { openai: { apiKey: FAKE_KEY } },
    });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "integration", "ama")).mode & 0o077).toBe(
        0,
      );
    }

    // Cleared in the settings: gone from the file at the next start.
    await credentials.clear("openai");
    writeAmaAuth(dataDir);
    expect(readFileSync(path, "utf8")).not.toContain(FAKE_KEY);
  });
});
