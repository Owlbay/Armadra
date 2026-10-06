import path from "node:path";

import { type PathEnvironment, type PlatformName, dataDir } from "./paths";

/**
 * 单实例锁按数据目录分（M1 收尾）。
 *
 * Electron 的 `requestSingleInstanceLock` 锁的是 Chromium 的 profile（`userData`）
 * 目录，不是 Armadra 的数据目录。默认数据目录照旧用 Electron 默认的 `userData`
 * ——改它会把已有用户的页面存储与浏览器节点的分区留在旧目录里。指了别的数据目录
 * （`ARMADRA_DATA_DIR`，开发、探针、隔离的第二份）时，profile 放进那个数据目录的
 * `electron/` 下，锁也就跟着它走：不同数据目录的实例互不影响，同一份数据目录只有
 * 一个壳。命令行已经给了 `--user-data-dir`（探针都这样起）时尊重它，不改。
 *
 * 纯函数：`env`、平台与路径模块都是参数，三个平台的规则在任一台上都能测。
 */
export function instanceProfileDir(
  argv: readonly string[],
  env: PathEnvironment,
  platform: PlatformName = process.platform,
  pathModule: typeof path = path,
): string | null {
  const override = env.ARMADRA_DATA_DIR;
  if (override === undefined || override === "") return null;
  if (
    argv.some(
      (arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="),
    )
  ) {
    return null;
  }
  const chosen = pathModule.resolve(override);
  const standard = pathModule.resolve(
    dataDir(platform, { ...env, ARMADRA_DATA_DIR: undefined }, pathModule),
  );
  // 指的就是默认那一份：与不带变量起的实例同一把锁。
  if (chosen === standard) return null;
  return pathModule.join(chosen, "electron");
}

/** 第二个实例交给已开着那个的附加数据（`second-instance` 的第四个参数）。 */
export interface SecondInstanceData {
  readonly joinLink: string | null;
}

/** 收到的附加数据里的深链；形状不对答 `null`（照旧从 argv 取）。 */
export function joinLinkOfData(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { joinLink?: unknown }).joinLink;
  return typeof value === "string" ? value : null;
}
