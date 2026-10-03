import { describe, expect, it } from "vitest";
import {
  mfaChallengeSchema,
  mfaStatusSchema,
  passkeyListSchema,
  identitySessionListSchema,
  PASSWORD_POLICY_CODES,
} from "../src/index.js";

describe("identity hardening API (contract §18.1–§18.4)", () => {
  it("parses the two-step login answer and the MFA status", () => {
    expect(
      mfaChallengeSchema.parse({
        mfaRequired: true,
        challengeId: "a".repeat(32),
        expiresAtMs: 1,
        methods: ["totp", "recovery"],
      }).methods,
    ).toEqual(["totp", "recovery"]);
    expect(
      mfaStatusSchema.parse({
        enrolled: true,
        pending: false,
        enrolledAtMs: 1,
        verifiedAtMs: 2,
        recoveryCodesRemaining: 9,
        requireFor: "members",
        required: true,
      }).requireFor,
    ).toBe("members");
  });

  it("parses the passkey list, including the IP-host refusal", () => {
    expect(
      passkeyListSchema.parse({
        available: false,
        rpId: "",
        reason: "passkey_unavailable_on_ip_host",
        passkeys: [],
      }).available,
    ).toBe(false);
  });

  it("parses the session list", () => {
    expect(
      identitySessionListSchema.parse({
        sessions: [
          {
            sessionId: "s".repeat(32),
            principalId: "p".repeat(32),
            deviceId: "d".repeat(32),
            deviceName: "laptop",
            createdAtMs: 1,
            lastSeenAtMs: 0,
            expiresAtMs: 2,
            remoteIp: "127.0.0.1",
            userAgent: "ua",
            current: true,
          },
        ],
      }).sessions,
    ).toHaveLength(1);
    expect(PASSWORD_POLICY_CODES).toContain("password_too_common");
  });
});
