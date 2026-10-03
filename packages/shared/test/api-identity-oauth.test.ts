import { describe, expect, it } from "vitest";
import {
  OAUTH_CODES,
  oauthBindingListSchema,
  oauthLogoutSchema,
  oauthProviderListSchema,
  oauthStartRequestSchema,
  oauthStartSchema,
} from "../src/index.js";

describe("OAuth / OIDC API (contract §18.5)", () => {
  it("parses the anonymous and the owner provider lists", () => {
    expect(
      oauthProviderListSchema.parse({
        configured: true,
        providers: [{ id: "corp", kind: "oidc" }],
      }).providers[0]?.usable,
    ).toBeUndefined();
    const owner = oauthProviderListSchema.parse({
      configured: true,
      providers: [
        {
          id: "github",
          kind: "github",
          clientId: "Iv1.x",
          enabled: true,
          allowSignup: false,
          allowedDomains: [],
          hasClientSecret: false,
          usable: false,
          callbackUrls: [
            "https://a.example/api/identity/oauth/github/callback",
          ],
        },
      ],
    });
    expect(owner.providers[0]?.hasClientSecret).toBe(false);
  });

  it("defaults start to login and parses the rest", () => {
    expect(oauthStartRequestSchema.parse({}).mode).toBe("login");
    expect(
      oauthStartSchema.parse({ authorizeUrl: "https://idp/x", expiresAtMs: 1 })
        .authorizeUrl,
    ).toBe("https://idp/x");
    expect(
      oauthBindingListSchema.parse({
        bindings: [
          { credentialId: "a", providerId: "", kind: "oidc", createdAtMs: 1 },
        ],
      }).bindings,
    ).toHaveLength(1);
    expect(oauthLogoutSchema.parse({ endSessionUrl: null }).endSessionUrl).toBe(
      null,
    );
    expect(OAUTH_CODES).toContain("oauth_not_configured");
  });
});
