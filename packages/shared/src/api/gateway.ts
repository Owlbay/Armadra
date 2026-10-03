import { z } from "zod";
import {
  GATEWAY_LISTEN_CHOICES,
  GATEWAY_TLS_SOURCES,
} from "../completion-settings.js";

/**
 * Gateway — the desktop's outward-facing HTTPS service, also what the server
 * shell's `serve` opens (contract §17, docs/design/completion-architecture.md
 * §7).
 */

/** Where the running certificate came from; `selfSigned` is the server shell's default. */
export const gatewayTlsSourceSchema = z.enum([
  ...GATEWAY_TLS_SOURCES,
  "selfSigned",
]);

export const gatewayErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

/** `GET /api/gateway` (§17.1). */
export const gatewayStatusSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  managedBy: z.enum(["settings", "shell"]),
  listen: z.enum(GATEWAY_LISTEN_CHOICES),
  port: z.number().int().min(0).max(65_535),
  publicOrigin: z.string(),
  address: z.object({ host: z.string(), port: z.number().int() }).nullable(),
  origin: z.string().nullable(),
  origins: z.array(z.string()),
  tls: z.object({
    source: gatewayTlsSourceSchema,
    certFile: z.string(),
    keyFile: z.string(),
    acmeEmail: z.string(),
    /** SHA-256 of the trust anchor's DER, lowercase hex. */
    fingerprint: z.string().nullable(),
    subject: z.string().nullable(),
    names: z.array(z.string()),
    notAfter: z.string().datetime({ offset: true }).nullable(),
    caAvailable: z.boolean(),
  }),
  error: gatewayErrorSchema.nullable(),
});

export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;

/** `PUT /api/gateway` (§17.2): any subset of `gateway.*`. */
export const gatewayConfigPatchSchema = z
  .object({
    enabled: z.boolean(),
    listen: z.enum(GATEWAY_LISTEN_CHOICES),
    port: z.number().int().min(0).max(65_535),
    publicOrigin: z.string(),
    tls: z
      .object({
        source: z.enum(GATEWAY_TLS_SOURCES),
        certFile: z.string(),
        keyFile: z.string(),
        acmeEmail: z.string(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export type GatewayConfigPatch = z.infer<typeof gatewayConfigPatchSchema>;

/** `POST /api/gateway/pairing` — what the pairing QR code carries (§17.3). */
export const gatewayPairingPayloadSchema = z.object({
  origin: z.string().url(),
  ticket: z.string().min(1),
  /** SHA-256 fingerprint of the gateway's trust anchor. */
  fingerprint: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
  /** `https://<host>:<port>/#pair=<ticket>&fp=<fingerprint>`. */
  webUrl: z.string().url(),
  /** `armadra://pair?host=…&ticket=…&fp=…`. */
  deepLink: z.string().startsWith("armadra://pair?"),
});

export type GatewayPairingPayload = z.infer<typeof gatewayPairingPayloadSchema>;

/** `POST /api/identity/ws-ticket` on the gateway, Bearer mode only (§17.4). */
export const gatewayWsTicketSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export type GatewayWsTicket = z.infer<typeof gatewayWsTicketSchema>;
