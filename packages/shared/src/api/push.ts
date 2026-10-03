import { z } from "zod";

/**
 * Push notifications (contract §19). Skeleton: G1-13 fills in devices and the
 * payload.
 */

/**
 * How a notification leaves the core: straight to APNs / FCM, through the
 * relay, or — when neither is configured — a debug log line.
 */
export const PUSH_TRANSPORTS = ["direct", "relay", "log"] as const;
export const pushTransportSchema = z.enum(PUSH_TRANSPORTS);

export type PushTransport = (typeof PUSH_TRANSPORTS)[number];
