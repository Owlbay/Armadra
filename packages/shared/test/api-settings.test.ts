import { describe, expect, it } from "vitest";
import {
  COMPLETION_SETTINGS_DEFAULTS,
  completionSettingsSchema,
} from "../src/index.js";

/**
 * 补全计划的设置键（G0-3）。core 侧的归一在
 * `apps/desktop/src/core/settings/completion-settings.test.ts`，两边的选项表
 * 是同一份文件的两份字节拷贝。
 */
describe("completion settings schema", () => {
  it("fills every default in for an empty document", () => {
    expect(completionSettingsSchema.parse({})).toEqual({
      ...COMPLETION_SETTINGS_DEFAULTS,
      identity: {
        ...COMPLETION_SETTINGS_DEFAULTS.identity,
        oauth: { providers: [] },
      },
    });
  });

  it("snaps broken values back to the defaults and keeps unknown keys", () => {
    const parsed = completionSettingsSchema.parse({
      gateway: { enabled: "yes", listen: "public", port: 70_000, future: 1 },
      push: { transport: "apns" },
      identity: { passwordMinLength: 8, mfa: { requireFor: "everyone" } },
      agents: { defaultDriver: "pty", custom: [] },
      collab: { realtime: "on" },
      usage: { claudeLocalWindow: "off" },
      diagnostics: { reportPageErrors: 1 },
      theme: "dark",
    });
    expect(parsed.gateway.enabled).toBe(false);
    expect(parsed.gateway.listen).toBe("loopback");
    expect(parsed.gateway.port).toBe(0);
    expect((parsed.gateway as Record<string, unknown>).future).toBe(1);
    expect(parsed.push.transport).toBe("log");
    expect(parsed.identity.passwordMinLength).toBe(12);
    expect(parsed.identity.mfa.requireFor).toBe("none");
    expect(parsed.agents.defaultDriver).toBe("acp");
    expect((parsed.agents as Record<string, unknown>).custom).toEqual([]);
    expect(parsed.collab.realtime).toBe(true);
    expect(parsed.usage.claudeLocalWindow).toBe(true);
    expect(parsed.diagnostics.reportPageErrors).toBe(false);
    expect((parsed as Record<string, unknown>).theme).toBe("dark");
  });

  it("drops a broken OAuth provider without losing the others", () => {
    const providers = completionSettingsSchema.parse({
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
