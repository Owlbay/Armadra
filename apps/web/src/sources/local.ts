/**
 * 本机源（客户端包 §1.1）：页面所在的那台 core。
 *
 * - 桌面壳：壳报的回环端口，Bearer 由壳的票换来（`api/shell-transport.ts`）；
 * - 服务器壳托管的页面：同源，Cookie 会话；
 * - 原生 App：连接页记下的那台 Gateway，Bearer 来自钥匙串（`mobile/entry.ts`）。
 *
 * 地址的算法在 `api/local-runtime.ts`（`localRuntime`），`Source` 本体在
 * `api/source.ts`（`localSource`）——`api/*` 不依赖 `sources/`，这里只把它们
 * 收拢成源层的入口。
 */
export {
  LOCAL_SOURCE_ID,
  installLocalTransport,
  localSource,
} from "../api/source";
export { localRuntime } from "../api/local-runtime";
export { LOCAL_DESCRIPTOR, createLocalConnection } from "./connection";
