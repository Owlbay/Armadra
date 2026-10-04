import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../bus";
import { emptyRequest } from "../http/router";
import { CoreServer } from "../http/server";
import {
  type AuditEvent,
  installAuditSink,
  resetAuditSink,
} from "../identity/audit";
import type { CorePlatform } from "../platform";
import { plainFileBackend } from "../secrets";
import { tempDir } from "../testing/temp-dir";
import {
  AMA_KEY_PROVIDERS,
  AMA_KEY_VARIABLES,
  AmaCredentials,
  amaKeyScope,
  amaKeyVariable,
  amaSecretName,
  installAmaCredentialRoutes,
  setAmaCredentials,
} from "./ama-credentials";

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

  it("hands the launcher ama's own variables for the keys that are set", async () => {
    const root = tempDir("armadra-ama-vars-");
    const credentials = new AmaCredentials(
      plainFileBackend(join(root, "secrets")),
    );
    expect(await credentials.variables()).toEqual([]);
    await credentials.set("openai", FAKE_KEY);
    await credentials.set("deepseek", "sk-other");
    expect(await credentials.variables()).toEqual([
      { variable: "AMA_API_KEY_OPENAI", value: FAKE_KEY },
      { variable: "AMA_API_KEY_DEEPSEEK", value: "sk-other" },
    ]);
    for (const provider of AMA_KEY_PROVIDERS) {
      expect(AMA_KEY_VARIABLES).toContain(amaKeyVariable(provider));
    }
    // Cleared in the settings: gone at the next start.
    await credentials.clear("openai");
    expect((await credentials.variables()).map((v) => v.variable)).toEqual([
      "AMA_API_KEY_DEEPSEEK",
    ]);
    // The only copy at rest is the secret store's entry.
    expect(existsSync(join(root, "integration"))).toBe(false);
  });

  it("narrows the answer to the node's provider (security review L10)", async () => {
    const root = tempDir("armadra-ama-scope-");
    const credentials = new AmaCredentials(
      plainFileBackend(join(root, "secrets")),
    );
    await credentials.set("openai", FAKE_KEY);
    await credentials.set("deepseek", "sk-other");
    // Before: every ama node redeemed every set key, whatever its model.
    expect(await credentials.variables()).toHaveLength(2);
    expect(await credentials.variables(["deepseek"])).toEqual([
      { variable: "AMA_API_KEY_DEEPSEEK", value: "sk-other" },
    ]);
    expect(await credentials.variables([])).toEqual([]);
  });

  it("reads the provider off ama's `<provider>/<model>`", () => {
    expect(amaKeyScope("deepseek/deepseek-chat")).toEqual({
      kind: "provider",
      providers: ["deepseek"],
    });
    expect(amaKeyScope("volcengine/doubao@coding")).toEqual({
      kind: "provider",
      providers: ["volcengine"],
    });
    expect(amaKeyScope({ id: "gpt-x", provider: "OpenAI" })).toEqual({
      kind: "provider",
      providers: ["openai"],
    });
    // A provider that takes no key here gets none, not all.
    for (const keyless of ["ollama/qwen", "chatgpt/gpt-x", "packy/grok"]) {
      expect(amaKeyScope(keyless)).toEqual({ kind: "provider", providers: [] });
    }
    for (const none of [undefined, "", "deepseek-chat", "/x", {}, 7]) {
      expect(amaKeyScope(none)).toEqual({ kind: "unscoped" });
    }
  });
});

describe("ama key routes", () => {
  it("audit set and clear by provider, never the key (security review M5)", async () => {
    const root = tempDir("armadra-ama-routes-");
    const credentials = new AmaCredentials(
      plainFileBackend(join(root, "secrets")),
    );
    const log = { error() {}, warn() {}, info() {}, debug() {} };
    const server = new CoreServer({
      platform: { log } as unknown as CorePlatform,
      bus: new EventBus(),
      version: "test",
    });
    installAmaCredentialRoutes(server, credentials);
    const audited: AuditEvent[] = [];
    installAuditSink((event) => audited.push(event));
    try {
      const body = Buffer.from(JSON.stringify({ apiKey: FAKE_KEY }));
      const put = await server.router.dispatch(
        "PUT",
        "/api/agents/ama/credentials/deepseek",
        {
          ...emptyRequest("PUT", "/api/agents/ama/credentials/deepseek"),
          body,
          json: <T>() => JSON.parse(body.toString("utf8")) as T,
        },
      );
      expect(put.status).toBe(200);
      const cleared = await server.router.dispatch(
        "DELETE",
        "/api/agents/ama/credentials/deepseek",
      );
      expect(cleared.status).toBe(200);
      expect(audited).toEqual([
        { action: "ama.credential.set", target: "deepseek" },
        { action: "ama.credential.clear", target: "deepseek" },
      ]);
      expect(JSON.stringify(audited)).not.toContain(FAKE_KEY);
    } finally {
      resetAuditSink();
    }
  });
});
