import type {
  AuditPage,
  IdentitySessionRow,
  Lockout,
  MfaStatus,
  OAuthBinding,
  PasskeyList,
} from "@armadra/shared";

/**
 * `auth` 分区的假数据（设计展示页 §2.1）。纯对象，无副作用；名字、设备、IP
 * 是数据不是界面文案。时钟钉在 {@link NOW}。
 */

export const NOW = Date.UTC(2026, 9, 3, 8, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const ME = "4f1c9a0e2b7d4c6f8a1e3b5d7c9f0a2e";
const LIN = "9d2e7b1c3a5f4e6d8c0b2a4f6e8d0c1b";
const ZHAO = "1a3c5e7f9b2d4f6a8c0e2b4d6f8a0c2e";

export const MEMBERS = [
  { principalId: ME, displayName: "陈一" },
  { principalId: LIN, displayName: "林二" },
  { principalId: ZHAO, displayName: "赵三" },
];

export const PROVIDERS = [
  { id: "github", kind: "github" as const },
  { id: "acme-sso", kind: "oidc" as const },
];

export const MANAGED_PROVIDERS = [
  {
    id: "github",
    kind: "github" as const,
    enabled: true,
    usable: true,
    hasClientSecret: true,
    callbackUrls: [
      "https://armadra.example.com/api/identity/oauth/github/callback",
    ],
  },
  {
    id: "acme-sso",
    kind: "oidc" as const,
    enabled: true,
    usable: false,
    hasClientSecret: false,
    callbackUrls: [
      "https://armadra.example.com/api/identity/oauth/acme-sso/callback",
    ],
  },
];

export const PASSKEYS: PasskeyList = {
  available: true,
  rpId: "armadra.example.com",
  reason: "",
  passkeys: [
    {
      credentialId: "c1a2b3c4d5e6f708192a3b4c5d6e7f80",
      label: "Safari · macOS",
      aaguid: "",
      transports: ["internal", "hybrid"],
      createdAtMs: NOW - 12 * DAY,
    },
    {
      credentialId: "d1a2b3c4d5e6f708192a3b4c5d6e7f81",
      label: "Chrome · Android",
      aaguid: "",
      transports: ["hybrid"],
      createdAtMs: NOW - 2 * DAY,
    },
  ],
};

export const PASSKEYS_ON_IP: PasskeyList = {
  available: false,
  rpId: "",
  reason: "passkey_unavailable_on_ip_host",
  passkeys: [],
};

const MFA_BASE: MfaStatus = {
  enrolled: false,
  pending: false,
  enrolledAtMs: 0,
  verifiedAtMs: 0,
  recoveryCodesRemaining: 0,
  requireFor: "members",
  required: true,
};

export const MFA_REQUIRED: MfaStatus = MFA_BASE;
export const MFA_ON: MfaStatus = {
  ...MFA_BASE,
  enrolled: true,
  enrolledAtMs: NOW - 30 * DAY,
  verifiedAtMs: NOW - DAY,
  recoveryCodesRemaining: 8,
};

export const ENROLLMENT = {
  secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  otpauthUri:
    "otpauth://totp/Armadra:%E9%99%88%E4%B8%80?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Armadra&algorithm=SHA1&digits=6&period=30",
};

export const RECOVERY_CODES = [
  "k7m2q-x9p4w",
  "a3f8r-t6y1u",
  "h5j2n-c8v4b",
  "q1w9e-r3t7y",
  "z6x2c-v8b4n",
  "m3k7j-h1g5f",
  "p9o2i-u4y8t",
  "d6s1a-f3g7h",
  "w2e8r-t4y6u",
  "b5n9m-c1v3x",
];

export const BINDINGS: OAuthBinding[] = [
  {
    credentialId: "e1a2b3c4d5e6f708192a3b4c5d6e7f82",
    providerId: "github",
    kind: "github",
    createdAtMs: NOW - 40 * DAY,
  },
];

const session = (
  id: string,
  principalId: string,
  deviceName: string,
  userAgent: string,
  lastSeen: number,
  remoteIp: string,
  current = false,
): IdentitySessionRow => ({
  sessionId: id,
  principalId,
  deviceId: `dev-${id}`,
  deviceName,
  createdAtMs: NOW - 5 * DAY,
  lastSeenAtMs: NOW - lastSeen,
  expiresAtMs: NOW + 25 * DAY,
  remoteIp,
  userAgent,
  current,
});

export const SESSIONS: IdentitySessionRow[] = [
  session("s1", ME, "Armadra · Chrome", "Macintosh", 0, "192.168.1.20", true),
  session("s2", ME, "Armadra · Safari", "iPhone", 3 * 60 * MIN, "10.0.0.7"),
  session("s3", ME, "Armadra · Edge", "Windows NT", 2 * DAY, "203.0.113.4"),
];

export const ALL_SESSIONS: IdentitySessionRow[] = [
  ...SESSIONS,
  session("s4", LIN, "Armadra · Firefox", "X11; Linux", 20 * MIN, "10.0.0.12"),
];

export const LOCKOUTS: Lockout[] = [
  {
    key: `principal:${ZHAO}`,
    principalId: ZHAO,
    failures: 6,
    lockedUntilMs: NOW + 4 * MIN,
  },
];

const entry = (
  id: number,
  ago: number,
  principalId: string,
  action: string,
  target = "",
  detail: unknown = null,
) => ({
  id,
  atMs: NOW - ago,
  principalId,
  deviceId: "",
  action,
  target,
  workspaceId: "",
  detail,
});

export const AUDIT: AuditPage = {
  entries: [
    entry(48, 2 * MIN, ME, "identity.login", "", { method: "passkey" }),
    entry(47, 9 * MIN, ZHAO, "identity.lockout", `principal:${ZHAO}`, {
      failures: 5,
    }),
    entry(46, 10 * MIN, ZHAO, "identity.login.failed", "", {
      reason: "password",
      ip: "198.51.100.23",
    }),
    entry(45, 40 * MIN, LIN, "identity.mfa.enroll"),
    entry(44, 3 * 60 * MIN, ME, "share.grant.set", "w-design", {
      role: "editor",
    }),
    entry(43, DAY, LIN, "identity.passkey.add", "c1a2b3c4", { aaguid: "" }),
  ],
  nextBeforeId: 43,
};
