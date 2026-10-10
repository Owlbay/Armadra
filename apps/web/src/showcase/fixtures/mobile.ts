import type { ServiceRow } from "../../services/rows";

/**
 * `mobile` 分区的假数据（设计展示页 §2.1，设计系统 §5.13）。纯值，无副作用。
 */
export const MOBILE_ORIGIN = "https://192.168.1.8:8443";
export const MOBILE_CA_HREF = `${MOBILE_ORIGIN}/ca.crt`;
export const MOBILE_LINK = `${MOBILE_ORIGIN}/#pair=k7f3.Qm9yZXN0LWdyZWVu&fp=${"3f7a".repeat(16)}`;
/** 配对码页的样本：输到一半（契约 §24）。 */
export const MOBILE_CODE = "3F7K9Q";
/** 多连接样本：个人中转的地址与它的信任锚指纹（64 位十六进制）。 */
export const MOBILE_RELAY_HOST = "relay.example.com";
export const MOBILE_RELAY_FINGERPRINT =
  "9b3e7c1a04d85f62e1a7b90c3d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4";
/** 连接列表与「选择主机」的样本（名字是用户数据，不进 i18n）。 */
export const MOBILE_CONNECTIONS = [
  {
    sourceId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    name: "MacBook Pro",
    defaultName: "MacBook Pro",
    local: false,
    routes: [
      {
        via: "relayed",
        issuer: `https://${MOBILE_RELAY_HOST}`,
        serviceName: MOBILE_RELAY_HOST,
      },
    ],
    lastUsedAt: null,
  },
  {
    sourceId: "0f9e8d7c6b5a49382716f5e4d3c2b1a0",
    name: "Studio",
    defaultName: "Studio",
    local: false,
    routes: [{ via: "direct", issuer: "", serviceName: "" }],
    lastUsedAt: null,
  },
] as const satisfies readonly ServiceRow[];
/** 选择页的在线状态样本。 */
export const MOBILE_CONNECTION_STATUSES = {
  [MOBILE_CONNECTIONS[0].sourceId]: "online",
  [MOBILE_CONNECTIONS[1].sourceId]: "offline",
} as const;
export const MOBILE_SOURCES = [
  {
    sourceId: MOBILE_CONNECTIONS[0].sourceId,
    name: "MacBook Pro",
    online: true,
  },
  { sourceId: MOBILE_CONNECTIONS[1].sourceId, name: "Studio", online: true },
  {
    sourceId: "77665544332211ffeeddccbbaa009988",
    name: "build-box",
    online: false,
  },
] as const;
export const MOBILE_NODE_ID = "5a7d2c1e-3b4f-4e6a-9c8d-0f1e2d3c4b5a";

/** 分区里的样本，一块 390×844 的屏幕一个。 */
export const MOBILE_SAMPLES = [
  "native",
  "web",
  "code",
  "error",
  "list",
  "add",
  "relay",
  "fingerprint",
  "sources",
  "push",
  "focusAcp",
  "focusTerminal",
] as const;
export type MobileSampleId = (typeof MOBILE_SAMPLES)[number];
