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

/** `tls.acme` of §17.1: the renewal state while the ACME source is serving. */
export const gatewayAcmeStatusSchema = z.object({
  directory: z.string(),
  profile: z.enum(["shortlived", "classic"]).nullable(),
  names: z.array(z.string()),
  notAfter: z.string().datetime({ offset: true }).nullable(),
  /** Next renewal, or the next retry after a failure. */
  renewAt: z.string().datetime({ offset: true }).nullable(),
  /** Consecutive failures; the old certificate keeps serving meanwhile. */
  failures: z.number().int().min(0),
  lastError: gatewayErrorSchema.nullable(),
});

export type GatewayAcmeStatus = z.infer<typeof gatewayAcmeStatusSchema>;

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
    /** `null` unless the ACME source is serving (optional for older cores). */
    acme: gatewayAcmeStatusSchema.nullable().optional(),
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
  /**
   * 8-character pairing code shown as `XXXX-XXXX` (§24). `null` when the
   * gateway is on the public `all` tier or has a public origin; absent on the
   * exchange answer and on older cores.
   */
  code: z
    .string()
    .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    .nullable()
    .optional(),
});

export type GatewayPairingPayload = z.infer<typeof gatewayPairingPayloadSchema>;

/** Pairing-code alphabet: `[A-Z2-9]`, no 0 / 1 (§24). */
export const GATEWAY_PAIRING_CODE_PATTERN = /^[A-Z2-9]{8}$/;
export const GATEWAY_PAIRING_CODE_LENGTH = 8;

/** `POST /api/gateway/pairing-code/exchange` request body (§24). */
export const gatewayPairingCodeExchangeSchema = z
  .object({ code: z.string().min(1).max(32) })
  .strict();

export type GatewayPairingCodeExchange = z.infer<
  typeof gatewayPairingCodeExchangeSchema
>;

/** `POST /api/identity/ws-ticket` on the gateway, Bearer mode only (§17.4). */
export const gatewayWsTicketSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export type GatewayWsTicket = z.infer<typeof gatewayWsTicketSchema>;
