/**
 * 补全计划要读的设置键（G0-3）：两份选项表逐字节相同，缺省值齐全，坏值退回
 * 缺省而不是让整份文档失效。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COMPLETION_SETTINGS_DEFAULTS } from "./completion-settings";
import type { JsonObject } from "./local";
import { completionSettings, normalize } from "./schema";

const REPO = join(__dirname, "..", "..", "..", "..", "..");

describe("completion-settings.ts", () => {
  it("与共享层那一份逐字节相同", () => {
    const core = readFileSync(join(__dirname, "completion-settings.ts"));
    const shared = readFileSync(
      join(REPO, "packages", "shared", "src", "completion-settings.ts"),
    );
    expect(core.equals(shared)).toBe(true);
  });
});

describe("补全计划的设置键", () => {
  it("空文档里每个键都有缺省", () => {
    const document = normalize({});
    const D = COMPLETION_SETTINGS_DEFAULTS;
    expect(document.gateway).toEqual(D.gateway);
    expect(document.push).toEqual(D.push);
    expect(document.identity).toEqual(D.identity);
    expect(document.collab).toEqual(D.collab);
    expect(document.models).toEqual(D.models);
    expect(document.diagnostics).toEqual(D.diagnostics);
    const usage = document.usage as JsonObject;
    expect(usage.claudeUsage).toBe(false);
    expect(usage.copilotUsage).toBe(false);
    expect(usage.statusBadges).toBe(true);
    // 没有自定义 Agent 的文件不长出 `agents` 段；读的人照样拿到缺省。
    expect(document.agents).toBeUndefined();
    expect(completionSettings({})).toEqual({
      ...D,
      identity: { ...D.identity, oauth: { providers: [] } },
    });
  });

  it("合法的值原样留下，未知键照旧透传", () => {
    const document = normalize({
      gateway: {
        enabled: true,
        listen: "private",
        port: 8443,
        publicOrigin: "https://canvas.example.invalid",
        tls: { source: "file", certFile: "/c.pem", keyFile: "/k.pem" },
        future: 1,
      },
      push: { transport: "relay", relayUrl: "https://relay.example.invalid" },
      identity: { breachCheck: "block", mfa: { requireFor: "members" } },
      agents: { defaultDriver: "terminal" },
      collab: { realtime: false },
      usage: { claudeUsage: true, statusBadges: false },
      models: { catalog: { autoRefresh: false } },
      diagnostics: { crashReportDsn: "https://k@glitchtip.example.invalid/1" },
    });
    const settings = completionSettings(document);
    expect(settings.gateway.listen).toBe("private");
    expect(settings.gateway.port).toBe(8443);
    expect(settings.gateway.tls.source).toBe("file");
    expect((document.gateway as JsonObject).future).toBe(1);
    expect(settings.push.transport).toBe("relay");
    expect(settings.identity.breachCheck).toBe("block");
    expect(settings.identity.mfa.requireFor).toBe("members");
    expect(settings.agents.defaultDriver).toBe("terminal");
    expect(settings.collab.realtime).toBe(false);
    expect(settings.usage).toEqual({
      claudeUsage: true,
      copilotUsage: false,
      statusBadges: false,
    });
    expect(settings.models.catalog.autoRefresh).toBe(false);
    expect(settings.diagnostics.crashReportDsn).toContain("glitchtip");
    // 再归一一次是同一份文档。
    expect(normalize(document)).toEqual(document);
  });

  it("坏值退回缺省", () => {
    const document = normalize({
      gateway: { enabled: "yes", listen: "public", port: 70_000, tls: 7 },
      push: { transport: "apns", apns: { keyFile: 3, production: "no" } },
      identity: {
        passwordMinLength: 8,
        breachCheck: "loud",
        mfa: { requireFor: "everyone" },
      },
      agents: { defaultDriver: "pty" },
      collab: { realtime: "on" },
      diagnostics: { crashReportDsn: 42 },
    });
    const settings = completionSettings(document);
    expect(settings.gateway).toEqual(COMPLETION_SETTINGS_DEFAULTS.gateway);
    expect(settings.push).toEqual(COMPLETION_SETTINGS_DEFAULTS.push);
    expect(settings.identity.passwordMinLength).toBe(12);
    expect(settings.identity.breachCheck).toBe("auto");
    expect(settings.identity.mfa.requireFor).toBe("none");
    expect(settings.agents.defaultDriver).toBe("acp");
    expect(settings.collab.realtime).toBe(true);
    expect(settings.diagnostics.crashReportDsn).toBe("");
  });

  it("状态徽标没写新键时沿用旧的 statusPage", () => {
    expect(
      completionSettings({ usage: { statusPage: false } }).usage.statusBadges,
    ).toBe(false);
    expect(
      completionSettings({ usage: { statusPage: false, statusBadges: true } })
        .usage.statusBadges,
    ).toBe(true);
  });

  it("OAuth 提供方：坏条目丢掉、同 id 留第一条、OIDC 必须有 issuer", () => {
    const providers = completionSettings({
      identity: {
        oauth: {
          providers: [
            { id: "gh", kind: "github", clientId: "abc" },
            { id: "gh", kind: "github", clientId: "second" },
            { id: "corp", kind: "oidc", clientId: "x" },
            {
              id: "dex",
              kind: "oidc",
              issuer: "http://127.0.0.1:5556/dex",
              clientId: "armadra",
              scopes: ["openid", "email"],
              allowSignup: true,
              allowedDomains: ["example.com"],
            },
            { id: "Bad Id", kind: "github", clientId: "x" },
            { id: "saml", kind: "saml", clientId: "x" },
            { id: "noscope", kind: "github", clientId: "x", scopes: [3] },
          ],
        },
      },
    }).identity.oauth.providers;
    expect(providers).toEqual([
      {
        id: "gh",
        kind: "github",
        clientId: "abc",
        scopes: [],
        allowSignup: false,
        allowedDomains: [],
        enabled: true,
      },
      {
        id: "dex",
        kind: "oidc",
        issuer: "http://127.0.0.1:5556/dex",
        clientId: "armadra",
        scopes: ["openid", "email"],
        allowSignup: true,
        allowedDomains: ["example.com"],
        enabled: true,
      },
    ]);
  });
});
