/**
 * 分享链接的解析在共享层（`@armadra/shared` 的 `join-link`）：页面、手机与 core
 * 的 `sources.mountByLink` 认同一种拼法。
 */
export {
  type JoinLink,
  isJoinLink,
  issuerOrigin,
  parseJoinLink,
} from "@armadra/shared";
