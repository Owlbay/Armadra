/**
 * dev-stack 的 `release` 服务入口。
 *
 * 启动时现造一份发布目录：每个目标一个假的可更新包（几十字节的占位正文）、
 * 用**本次启动现生成**的 minisign 密钥签名、`latest.json` 与 `SHA256SUMS`，
 * 然后用 `tools/release/mock-release-server.mjs` 把它当成 GitHub Releases 端点
 * 托管出去。私钥只在这个进程的内存里，从不落盘；公钥写到 `RELEASE_KEY_DIR`
 * （dev-stack 把它挂到宿主机的 `tools/dev-stack/.data/release/`），测试拿它验签。
 *
 * 版本默认 `99.0.0`，比任何真实版本都新，所以客户端总会看到「有更新」。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, desktopAssets } from "../release/artifacts.mjs";
import { writeChecksums } from "../release/checksums.mjs";
import {
  generateKey,
  publicKeyFile,
  signDetached,
} from "../release/minisign.mjs";
import { startMockReleaseServer } from "../release/mock-release-server.mjs";
import { writeManifest } from "../release/updater-manifest.mjs";

export const OWNER = "armadra";
export const REPO = "armadra";

/** Build the fixture release; returns where it is and the public key text. */
export async function buildReleaseFixture({
  directory = mkdtempSync(join(tmpdir(), "armadra-release-")),
  version = "99.0.0",
  publicBase,
  key = generateKey(),
}) {
  const tag = `v${version}`;
  mkdirSync(directory, { recursive: true });
  for (const target of TARGETS) {
    for (const asset of desktopAssets(version, target)) {
      const body = Buffer.from(
        `armadra dev-stack fixture ${asset.name} — not a real bundle\n`,
      );
      writeFileSync(join(directory, asset.name), body);
      if (asset.updater)
        writeFileSync(
          join(directory, `${asset.name}.sig`),
          signDetached(key, body, `timestamp:0\tfile:${asset.name}`),
        );
    }
  }
  const notes = `Armadra ${version} (dev-stack fixture)`;
  writeManifest({
    directory,
    version,
    notes,
    targets: TARGETS,
    downloadUrl: (name) =>
      `${publicBase}/download/${tag}/${encodeURIComponent(name)}`,
  });
  await writeChecksums(directory);
  return { directory, tag, notes, publicKey: publicKeyFile(key) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  const port = Number(env.MOCK_RELEASE_PORT || 8090);
  const publicBase = env.MOCK_RELEASE_PUBLIC_BASE || `http://127.0.0.1:${port}`;
  const fixture = await buildReleaseFixture({
    version: env.RELEASE_VERSION || "99.0.0",
    publicBase,
  });
  if (env.RELEASE_KEY_DIR) {
    mkdirSync(env.RELEASE_KEY_DIR, { recursive: true });
    writeFileSync(join(env.RELEASE_KEY_DIR, "minisign.pub"), fixture.publicKey);
  }
  const server = await startMockReleaseServer({
    releases: [
      { directory: fixture.directory, tag: fixture.tag, body: fixture.notes },
    ],
    owner: OWNER,
    repo: REPO,
    host: env.MOCK_RELEASE_HOST || "127.0.0.1",
    port,
    publicBase,
  });
  console.log(`release fixture ${fixture.tag} at ${server.source}`);
  const stop = () => server.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
