// 容器健康检查：从容器里经回环打 Gateway 的 `/health`。
//
// 只连 127.0.0.1、只为了知道进程在答话，所以不验证书——ACME 证书签给的是域名，
// 自签名证书谁都不信；对外的那条路由宿主机上的检查（dev-stack、CI）负责。
import { request } from "node:https";

const listen = process.env.ARMADRA_LISTEN ?? "0.0.0.0:8443";
const port = Number(listen.slice(listen.lastIndexOf(":") + 1));

const probe = request(
  {
    host: "127.0.0.1",
    port,
    path: "/health",
    method: "GET",
    rejectUnauthorized: false,
    timeout: 4000,
  },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
probe.on("timeout", () => probe.destroy(new Error("timeout")));
probe.on("error", () => process.exit(1));
probe.end();
