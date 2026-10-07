import type { GatewayPairingPayload, GatewayStatus } from "@armadra/shared";

/**
 * `gateway` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用；名字是数据
 * 不是界面文案。时钟钉在 {@link NOW}，倒计时每次截图都一样。
 */

export const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);

const FINGERPRINT =
  "5f1c9a0e2b7d4c6f8a1e3b5d7c9f0a2e4b6d8c0f1a3e5b7d9c2f4a6e8b0d1c3f";
const TICKET = "8c1f0b2e9d7a6c5f.Qm9vX2dhdGV3YXlfdGlja2V0X3NhbXBsZQ";
const ORIGIN = "https://192.168.1.8:8443";

const TLS: GatewayStatus["tls"] = {
  source: "localCa",
  certFile: "",
  keyFile: "",
  acmeEmail: "",
  fingerprint: null,
  subject: null,
  names: [],
  notAfter: null,
  caAvailable: false,
};

export const OFF: GatewayStatus = {
  enabled: false,
  running: false,
  managedBy: "settings",
  listen: "private",
  port: 8443,
  publicOrigin: "",
  address: null,
  origin: null,
  origins: [],
  tls: TLS,
  error: null,
};

export const RUNNING: GatewayStatus = {
  ...OFF,
  enabled: true,
  running: true,
  address: { host: "0.0.0.0", port: 8443 },
  origin: ORIGIN,
  origins: [ORIGIN, "https://mac.local:8443", "https://127.0.0.1:8443"],
  tls: {
    ...TLS,
    fingerprint: FINGERPRINT,
    subject: "CN=192.168.1.8",
    names: ["192.168.1.8", "mac.local", "127.0.0.1"],
    notAfter: "2027-11-04T00:00:00.000Z",
    caAvailable: true,
  },
};

export const STARTING: GatewayStatus = { ...OFF, enabled: true };

/** ACME 续期连着失败两次，旧证书继续服务，下次重试的时刻（契约 §17.1）。 */
export const RENEW_FAILED: GatewayStatus = {
  ...RUNNING,
  publicOrigin: "https://armadra.example",
  tls: {
    ...RUNNING.tls,
    source: "acme",
    acmeEmail: "ops@armadra.example",
    acme: {
      directory: "https://acme-v02.api.letsencrypt.org/directory",
      profile: "shortlived",
      names: ["armadra.example"],
      notAfter: "2026-10-09T00:00:00.000Z",
      renewAt: "2026-10-03T12:30:00.000Z",
      failures: 2,
      lastError: { code: "acme_failed", message: "" },
    },
  },
};

/** 这台设备自己（设备表里标「当前」）。 */
export const CURRENT_DEVICE = "dev-iphone";

export const FAILED: GatewayStatus = {
  ...OFF,
  enabled: true,
  error: { code: "port_in_use", message: "" },
};

export const PAIRING: GatewayPairingPayload = {
  origin: ORIGIN,
  ticket: TICKET,
  fingerprint: FINGERPRINT,
  expiresAt: new Date(NOW + 179_000).toISOString(),
  webUrl: `${ORIGIN}/#pair=${TICKET}&fp=${FINGERPRINT}`,
  deepLink: `armadra://pair?host=192.168.1.8%3A8443&ticket=${TICKET}&fp=${FINGERPRINT}`,
  code: "3F7K-9Q2M",
};

/** 已过期的那张：时钟走过了 `expiresAt`。 */
export const EXPIRED_NOW = NOW + 200_000;

export const DEVICES = [
  {
    deviceId: "dev-iphone",
    principalId: "owner",
    name: "iPhone 17",
    role: "owner",
    epoch: 1,
    createdAtMs: Date.UTC(2026, 8, 28),
    revokedAtMs: 0,
  },
  {
    deviceId: "dev-pixel",
    principalId: "member-1",
    name: "Pixel 10",
    role: "member",
    epoch: 1,
    createdAtMs: Date.UTC(2026, 9, 1),
    revokedAtMs: 0,
  },
  {
    deviceId: "dev-ipad",
    principalId: "owner",
    name: "iPad Air",
    role: "owner",
    epoch: 2,
    createdAtMs: Date.UTC(2026, 9, 2),
    revokedAtMs: 0,
  },
];

export const CA_HREF = `${ORIGIN}/ca.crt`;
