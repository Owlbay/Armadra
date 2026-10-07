import type { RouteEntry } from "./routes";

/**
 * 身份三域（契约 §42）的旧路径：整段 `/api/identity/` 由身份域的原样路由接
 * （`identity/http.ts`、`identity/oauth/http.ts`），这几行让契约的旧路径有表可查
 * （`routes.ts` 的 {@link ROUTES} 展开它）。凭据换会话的那几条（§42.4）不在
 * 契约里，也不在这张表里。字面量段在带参数的同级模式之前：表按顺序匹配。
 */
export const IDENTITY_ROUTES: readonly RouteEntry[] = [
  {
    path: "/api/identity/session",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/devices",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/devices/revoke",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/passkey",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/passkey/register/options",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/passkey/register/verify",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/passkey/{credentialId}",
    methods: ["PATCH", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/mfa",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/mfa/totp/enroll",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/mfa/totp/confirm",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/mfa/disable",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/mfa/recovery-codes",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/mfa/reset",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/sessions",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/sessions/revoke-others",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/sessions/{sessionId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/lockouts",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/lockouts/{principalId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/oauth/providers",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/oauth/providers/{providerId}/secret",
    methods: ["PUT", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/oauth/bindings",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/oauth/bindings/{credentialId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/audit",
    methods: ["GET"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/principals",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/principals/{principalId}/disable",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/principals/{principalId}/password-reset",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/credentials",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/credentials/{credentialId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/invitations",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/invitations/{invitationId}",
    methods: ["DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/invitations/{invitationId}/accept",
    methods: ["POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/groups",
    methods: ["GET", "POST"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/groups/{groupId}",
    methods: ["PATCH", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/groups/{groupId}/members/{principalId}",
    methods: ["PUT", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
  {
    path: "/api/identity/grants",
    methods: ["GET", "PUT", "DELETE"],
    surface: "runtime",
    implemented: true,
  },
];
