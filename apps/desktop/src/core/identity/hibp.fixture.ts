import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dev-stack 的 hibp fixture（`tools/dev-stack/hibp-fixture.mjs`），在测试进程里
 * 起一份：与 `pnpm dev-stack up` 起的容器是同一份代码，`password`、`123456`、
 * `qwerty`、`armadra-pwned-fixture` 一定命中。路径运行时拼，tsc 不解析那个
 * `.mjs`。只给测试用。
 */

export interface HibpFixture {
  readonly base: string;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const HIBP_FIXTURE_MODULE = resolve(
  here,
  "../../../../../tools/dev-stack/hibp-fixture.mjs",
);

export async function startHibp(): Promise<HibpFixture> {
  const module = (await import(HIBP_FIXTURE_MODULE)) as {
    startHibpFixture(options: { port: number }): Promise<HibpFixture>;
  };
  return module.startHibpFixture({ port: 0 });
}
