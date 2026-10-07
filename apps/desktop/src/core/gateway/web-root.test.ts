import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cacheControlFor,
  contentTypeFor,
  desktopWebRootCandidates,
  firstWebRoot,
  hashedAsset,
  openWebRoot,
  resolveFile,
  resolveWithinRoot,
  staticHeaders,
} from "./web-root";
import { tempDir } from "../testing/temp-dir";

function fixture(): { root: string; outside: string } {
  const root = tempDir("armadra-webroot-");
  const outside = tempDir("armadra-outside-");
  writeFileSync(join(outside, "secret.txt"), "不该被读到");
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-D3fK9x2a.js"), "1");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  symlinkSync(join(root, "assets", "app-D3fK9x2a.js"), join(root, "inside.js"));
  return { root, outside };
}

describe("静态托管", () => {
  it("字符串上的收敛：解码、塌缩、落在根外就没有下一步", () => {
    // `resolve` 而不是写死 `/srv/web`：Windows 上根会带盘符、分隔符是反斜杠，
    // 收敛逻辑本身是跨平台的，断言也该按平台的拼法来。
    const root = resolve("/srv/web");
    expect(resolveWithinRoot(root, "/index.html")).toBe(
      join(root, "index.html"),
    );
    expect(resolveWithinRoot(root, "/a//b/../index.html")).toBe(
      join(root, "a", "index.html"),
    );
    // 编码过的 `..` 与直接写的 `..` 塌缩成同一个答案，而它在根外。
    expect(resolveWithinRoot(root, "/%2e%2e%2f%2e%2e%2fetc")).toBeUndefined();
    expect(resolveWithinRoot(root, "/../../etc")).toBeUndefined();
    expect(resolveWithinRoot(root, "/index.html?v=1")).toBe(
      join(root, "index.html"),
    );
    expect(resolveWithinRoot(root, "/%ff")).toBeUndefined();
    expect(resolveWithinRoot(root, "/a\0b")).toBeUndefined();
  });

  it("realpath 上的复核挡住指向包外的符号链接", async () => {
    const { root } = fixture();
    const web = await openWebRoot(root);
    expect(await resolveFile(web, "/link.txt")).toBeUndefined();
    // 指向包内的链接照常服务。
    expect((await resolveFile(web, "/inside.js"))?.relative).toBe(
      join("assets", "app-D3fK9x2a.js"),
    );
  });

  it("单页回退只接住没有扩展名的路径", async () => {
    const { root } = fixture();
    const web = await openWebRoot(root);
    expect((await resolveFile(web, "/workspace/abc"))?.relative).toBe(
      "index.html",
    );
    expect(await resolveFile(web, "/assets/missing.js")).toBeUndefined();
  });

  it("没有 index.html 的目录不是 apps/web 的产物", async () => {
    const empty = tempDir("armadra-empty-");
    await expect(openWebRoot(empty)).rejects.toThrow(/index\.html/);
  });

  it("缓存按产物形状分档", () => {
    expect(hashedAsset("app-D3fK9x2a.js")).toBe(true);
    expect(hashedAsset("plain.js")).toBe(false);
    expect(cacheControlFor("index.html")).toBe("no-store");
    expect(cacheControlFor(join("assets", "app-D3fK9x2a.js"))).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("favicon.ico")).toBe("no-cache");
  });

  it("类型与安全头", () => {
    expect(contentTypeFor("/a/b.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/a/b.unknown")).toBe("application/octet-stream");
    const headers = staticHeaders();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["cache-control"]).toBe("no-store");
  });
});

describe("桌面壳 Gateway 的产物位置", () => {
  it("环境变量、打包版资源目录（asar 外、unpacked、asar 里）、入口旁边、检出，按这个顺序", () => {
    const resources = resolve("/Applications/Armadra.app/Contents/Resources");
    const entry = join(resources, "app.asar", "out", "core", "main.js");
    const checkout = tempDir("armadra-checkout-");
    mkdirSync(join(checkout, "apps/web/dist"), { recursive: true });
    writeFileSync(
      join(checkout, "apps/web/dist/index.html"),
      "<!doctype html>",
    );
    const nested = join(checkout, "apps/desktop");
    mkdirSync(nested, { recursive: true });
    expect(
      desktopWebRootCandidates({
        env: { ARMADRA_GATEWAY_WEB_ROOT: "/srv/web" },
        resourcesPath: resources,
        entry,
        cwd: nested,
      }),
    ).toEqual([
      resolve("/srv/web"),
      join(resources, "renderer"),
      join(resources, "app.asar.unpacked", "out", "renderer"),
      // 入口旁边的 `../renderer` 与它是同一个，去重。
      join(resources, "app.asar", "out", "renderer"),
      join(checkout, "apps/web/dist"),
    ]);
    // 开发版：没有资源目录，入口在检出的 out/ 里。
    expect(
      desktopWebRootCandidates({
        env: {},
        entry: join(checkout, "apps/desktop/out/core/main.js"),
        cwd: tempDir("armadra-elsewhere-"),
      }),
    ).toEqual([join(checkout, "apps/desktop/out/renderer")]);
  });

  it("取第一个有 index.html 的；都没有就是 undefined", async () => {
    const empty = tempDir("armadra-webroot-empty-");
    const { root } = fixture();
    expect(await firstWebRoot([empty, root])).toMatchObject({
      directory: resolve(root),
    });
    expect(await firstWebRoot([empty])).toBeUndefined();
  });
});
