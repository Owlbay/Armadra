/**
 * 桌面包的入口（`package.json` 的 `main`）：先问是不是 `Armadra serve`，是就
 * 把进程交给服务器壳，不装配任何桌面的东西；否则载入 `index.ts`——它一行没变，
 * 单实例锁、更新、崩溃上报都在它里面，serve 模式一个都不沾。
 */
import { join } from "node:path";
import { runServeShell, serveArguments } from "./serve-launch";

const serveRest = serveArguments(process.argv);
if (serveRest !== null) {
  runServeShell(serveRest);
} else {
  // 同步 require：`ready` 与 `open-url` 的监听必须在同一个 tick 里装好。
  // 路径放进变量：写成字面量 `require("./index")` 时，打包器会把它提升成文件
  // 顶部的 require，serve 模式下桌面壳也跟着装配起来（开了默认数据目录）。
  const desktop = join(__dirname, "index.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(desktop);
}
