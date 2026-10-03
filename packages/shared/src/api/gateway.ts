import { z } from "zod";

/**
 * Gateway — the desktop's outward-facing service (contract §17,
 * docs/design/completion-architecture.md §7). Skeleton: G1-10 fills in status,
 * configuration and pairing.
 */

/** What the pairing QR code carries. */
export const gatewayPairingPayloadSchema = z.object({
  origin: z.string().url(),
  ticket: z.string().min(1),
  /** SHA-256 fingerprint of the gateway's certificate. */
  fingerprint: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export type GatewayPairingPayload = z.infer<typeof gatewayPairingPayloadSchema>;
