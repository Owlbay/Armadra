import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyServedRelease } from "../release/dry-run.mjs";
import { verifyDetached } from "../release/minisign.mjs";
import { startMockReleaseServer } from "../release/mock-release-server.mjs";
import { OWNER, REPO, buildReleaseFixture } from "./release-entry.mjs";

test("release：现造的发布能被列出、下载并用现生成的公钥验签", async () => {
  const directory = mkdtempSync(join(tmpdir(), "release-fixture-"));
  // 先占一个端口拿到地址，再按它造清单——与容器里「固定端口 + publicBase」同理。
  const probe = await startMockReleaseServer({
    releases: [],
    owner: OWNER,
    repo: REPO,
  });
  const port = Number(new URL(probe.base).port);
  await probe.close();
  const publicBase = `http://127.0.0.1:${port}`;
  const fixture = await buildReleaseFixture({
    directory,
    publicBase,
    version: "99.0.0",
  });
  const server = await startMockReleaseServer({
    releases: [
      { directory: fixture.directory, tag: fixture.tag, body: fixture.notes },
    ],
    owner: OWNER,
    repo: REPO,
    host: "127.0.0.1",
    port,
    publicBase,
  });
  try {
    assert.equal(server.base, publicBase);
    const releases = await (await fetch(`${server.source}/releases`)).json();
    assert.equal(releases[0].tag_name, "v99.0.0");
    const names = releases[0].assets.map((asset) => asset.name);
    assert.ok(names.includes("latest.json") && names.includes("SHA256SUMS"));

    const manifest = JSON.parse(
      readFileSync(join(directory, "latest.json"), "utf8"),
    );
    assert.equal(manifest.version, "99.0.0");
    const entry = manifest.platforms["linux-x86_64"];
    assert.ok(entry.url.startsWith(`${publicBase}/download/v99.0.0/`));
    const bundle = Buffer.from(await (await fetch(entry.url)).arrayBuffer());
    assert.ok(bundle.length > 0);
    assert.equal(
      verifyDetached(fixture.publicKey, entry.signature, bundle).ok,
      true,
    );
    // 客户端的整条路：检查（带 ETag 再查一次得 304）→ 取清单 → 逐条校验。
    const served = await verifyServedRelease({
      source: server.source,
      publicKeyText: fixture.publicKey,
    });
    assert.deepEqual(served.problems, []);
    const tampered = Buffer.concat([bundle, Buffer.from("x")]);
    assert.equal(
      verifyDetached(fixture.publicKey, entry.signature, tampered).reason,
      "signatureMismatch",
    );
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
