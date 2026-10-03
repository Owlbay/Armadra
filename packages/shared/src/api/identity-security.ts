import { z } from "zod";

/**
 * Identity hardening — password policy, passkeys, MFA, sessions, OAuth / OIDC
 * and audit (contract §18, docs/design/completion-architecture.md §8.3).
 * Skeleton: G1-11, G1-12 and G2-8 fill in their subsections.
 */

/** `identity.mfa.requireFor`: who must pass a second factor at sign-in. */
export const MFA_REQUIREMENTS = ["none", "members", "all"] as const;
export const mfaRequirementSchema = z.enum(MFA_REQUIREMENTS);

export type MfaRequirement = (typeof MFA_REQUIREMENTS)[number];
