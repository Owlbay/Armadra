/**
 * `mobile` 分区的假数据（设计展示页 §2.1，设计系统 §5.13）。纯值，无副作用。
 */
export const MOBILE_ORIGIN = "https://192.168.1.8:8443";
export const MOBILE_CA_HREF = `${MOBILE_ORIGIN}/ca.crt`;
export const MOBILE_LINK = `${MOBILE_ORIGIN}/#pair=k7f3.Qm9yZXN0LWdyZWVu&fp=${"3f7a".repeat(16)}`;
export const MOBILE_NODE_ID = "5a7d2c1e-3b4f-4e6a-9c8d-0f1e2d3c4b5a";

/** 分区里的样本，一块 390×844 的屏幕一个。 */
export const MOBILE_SAMPLES = [
  "native",
  "web",
  "error",
  "push",
  "focusAcp",
  "focusTerminal",
] as const;
export type MobileSampleId = (typeof MOBILE_SAMPLES)[number];
