import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TARGETS, desktopAssets } from "./artifacts.mjs";
import {
  CHANNEL_ASSETS,
  WINGET_ID,
  assetName,
  channelValues,
  fill,
  push,
  render,
} from "./publish-channels.mjs";
import { parseYaml } from "../ci/workflow-yaml.mjs";

const VERSION = "1.2.3";
const REPO = "AMA-Link/Armadra";

/** SHA256SUMS listing every bundle the release publishes, with distinct digests. */
function sums(version = VERSION, drop = []) {
  const lines = [];
  let n = 0;
  for (const target of TARGETS)
    for (const asset of desktopAssets(version, target)) {
      if (drop.includes(asset.name)) continue;
      n += 1;
      lines.push(`${n.toString(16).padStart(64, "a")}  ${asset.name}`);
    }
  lines.push(`${"f".repeat(64)}  armadra-web_${version}.tar.gz`);
  return `${lines.join("\n")}\n`;
}

function digestOf(text, name) {
  return text
    .split("\n")
    .find((line) => line.endsWith(`  ${name}`))
    .slice(0, 64);
}

function withRendered(run, options = {}) {
  const out = mkdtempSync(join(tmpdir(), "armadra-channels-"));
  try {
    const written = render({
      version: VERSION,
      repo: REPO,
      sums: sums(),
      out,
      license: "MIT License\n",
      ...options,
    });
    return run(out, written);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("every channel asset is a name artifacts.mjs publishes", () => {
  for (const key of CHANNEL_ASSETS) assetName(VERSION, key);
  assert.throws(
    () => assetName(VERSION, "darwin-aarch64.pkg"),
    /is not a bundle tools\/release\/artifacts\.mjs publishes/,
  );
});

test("only stable versions and owner/name repos render, and every channel bundle must be in SHA256SUMS", () => {
  assert.throws(
    () => channelValues({ version: "1.2.3-rc.1", repo: REPO, sums: sums() }),
    /stable versions only/,
  );
  assert.throws(
    () => channelValues({ version: VERSION, repo: "Armadra", sums: sums() }),
    /owner\/name/,
  );
  assert.throws(
    () =>
      channelValues({
        version: VERSION,
        repo: REPO,
        sums: sums(VERSION, ["Armadra_1.2.3_windows-aarch64-setup.exe"]),
      }),
    /does not list Armadra_1\.2\.3_windows-aarch64-setup\.exe/,
  );
});

test("a placeholder without a value fails rather than rendering empty", () => {
  assert.equal(fill("v{{a}}", { a: "1" }), "v1");
  assert.throws(
    () => fill("{{a}} {{b}}", { a: "1" }, "x.rb"),
    /x\.rb: no value for b/,
  );
});

test("render writes the cask, the Scoop manifest, three winget manifests and the PKGBUILD", () =>
  withRendered((out, written) => {
    const wingetDir = `winget/manifests/a/AMA-Link/Armadra/${VERSION}`;
    assert.deepEqual(written.sort(), [
      "aur/PKGBUILD",
      "homebrew/Casks/armadra.rb",
      "scoop/bucket/armadra.json",
      `${wingetDir}/${WINGET_ID}.installer.yaml`,
      `${wingetDir}/${WINGET_ID}.locale.en-US.yaml`,
      `${wingetDir}/${WINGET_ID}.yaml`,
    ]);
    for (const path of written)
      assert.doesNotMatch(readFileSync(join(out, path), "utf8"), /\{\{/);
  }));

test("the cask pins both macOS dmgs by SHA256SUMS and downloads from the release", () =>
  withRendered((out) => {
    const cask = readFileSync(join(out, "homebrew/Casks/armadra.rb"), "utf8");
    const list = sums();
    assert.match(cask, /^cask "armadra" do$/m);
    assert.match(cask, new RegExp(`version "${VERSION}"`));
    assert.match(
      cask,
      new RegExp(
        `arm: +"${digestOf(list, "Armadra_1.2.3_darwin-aarch64.dmg")}"`,
      ),
    );
    assert.match(
      cask,
      new RegExp(
        `intel: "${digestOf(list, "Armadra_1.2.3_darwin-x86_64.dmg")}"`,
      ),
    );
    assert.match(
      cask,
      /url "https:\/\/github\.com\/AMA-Link\/Armadra\/releases\/download\/v#\{version\}\/Armadra_#\{version\}_darwin-#\{arch\}\.dmg"/,
    );
    assert.match(cask, /app "Armadra\.app"/);
    assert.match(cask, /strategy :github_latest/);
  }));

test("the Scoop manifest uses the portable zips and autoupdates from SHA256SUMS", () =>
  withRendered((out) => {
    const manifest = JSON.parse(
      readFileSync(join(out, "scoop/bucket/armadra.json"), "utf8"),
    );
    const list = sums();
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.license, "MIT");
    assert.deepEqual(manifest.architecture["64bit"], {
      url: `https://github.com/${REPO}/releases/download/v${VERSION}/Armadra_${VERSION}_windows-x86_64-portable.zip`,
      hash: digestOf(list, `Armadra_${VERSION}_windows-x86_64-portable.zip`),
    });
    assert.equal(
      manifest.architecture.arm64.hash,
      digestOf(list, `Armadra_${VERSION}_windows-aarch64-portable.zip`),
    );
    assert.deepEqual(manifest.checkver, {
      github: `https://github.com/${REPO}`,
    });
    assert.equal(manifest.autoupdate.hash.url, "$baseurl/SHA256SUMS");
    assert.match(
      manifest.autoupdate.architecture["64bit"].url,
      /\/v\$version\/Armadra_\$version_windows-x86_64-portable\.zip$/,
    );
    // The autoupdate URL is the published name with the version substituted.
    assert.equal(
      manifest.autoupdate.architecture["64bit"].url.replaceAll(
        "$version",
        VERSION,
      ),
      manifest.architecture["64bit"].url,
    );
  }));

test("the winget manifests agree on identity and version and pin both NSIS installers", () =>
  withRendered((out) => {
    const dir = join(out, `winget/manifests/a/AMA-Link/Armadra/${VERSION}`);
    const docs = Object.fromEntries(
      readdirSync(dir).map((name) => [
        name,
        parseYaml(readFileSync(join(dir, name), "utf8")),
      ]),
    );
    const types = Object.values(docs)
      .map((doc) => doc.ManifestType)
      .sort();
    assert.deepEqual(types, ["defaultLocale", "installer", "version"]);
    for (const doc of Object.values(docs)) {
      assert.equal(doc.PackageIdentifier, WINGET_ID);
      assert.equal(String(doc.PackageVersion), VERSION);
      assert.equal(String(doc.ManifestVersion), "1.10.0");
    }
    const installer = docs[`${WINGET_ID}.installer.yaml`];
    assert.equal(installer.InstallerType, "nullsoft");
    const list = sums();
    assert.deepEqual(
      installer.Installers.map((entry) => [
        entry.Architecture,
        entry.InstallerUrl.split("/").pop(),
        entry.InstallerSha256,
      ]),
      [
        [
          "x64",
          `Armadra_${VERSION}_windows-x86_64-setup.exe`,
          digestOf(
            list,
            `Armadra_${VERSION}_windows-x86_64-setup.exe`,
          ).toUpperCase(),
        ],
        [
          "arm64",
          `Armadra_${VERSION}_windows-aarch64-setup.exe`,
          digestOf(
            list,
            `Armadra_${VERSION}_windows-aarch64-setup.exe`,
          ).toUpperCase(),
        ],
      ],
    );
    const locale = docs[`${WINGET_ID}.locale.en-US.yaml`];
    assert.equal(locale.Publisher, "AMA-Link");
    assert.equal(locale.License, "MIT");
    assert.ok(locale.ShortDescription.length <= 256);
  }));

test("the PKGBUILD is armadra-bin over the .debs, with the LICENSE hashed from the repository", () =>
  withRendered((out) => {
    const pkgbuild = readFileSync(join(out, "aur/PKGBUILD"), "utf8");
    const list = sums();
    assert.match(pkgbuild, /^pkgname=armadra-bin$/m);
    assert.match(
      pkgbuild,
      new RegExp(`^pkgver=${VERSION.replaceAll(".", "\\.")}$`, "m"),
    );
    assert.match(pkgbuild, /^arch=\('x86_64' 'aarch64'\)$/m);
    assert.match(
      pkgbuild,
      new RegExp(
        `sha256sums_x86_64=\\('${digestOf(list, `Armadra_${VERSION}_linux-x86_64.deb`)}'\\)`,
      ),
    );
    assert.match(
      pkgbuild,
      new RegExp(
        `sha256sums_aarch64=\\('${digestOf(list, `Armadra_${VERSION}_linux-aarch64.deb`)}'\\)`,
      ),
    );
    const license = createHash("sha256").update("MIT License\n").digest("hex");
    assert.match(pkgbuild, new RegExp(`^sha256sums=\\('${license}'\\)$`, "m"));
  }));

test("--download-base points every channel at another origin (local install checks)", () =>
  withRendered(
    (out) => {
      const cask = readFileSync(join(out, "homebrew/Casks/armadra.rb"), "utf8");
      assert.match(cask, /url "http:\/\/127\.0\.0\.1:8765\/v#\{version\}\//);
      const scoop = JSON.parse(
        readFileSync(join(out, "scoop/bucket/armadra.json"), "utf8"),
      );
      assert.ok(
        scoop.architecture["64bit"].url.startsWith(
          "http://127.0.0.1:8765/v1.2.3/",
        ),
      );
      // autoupdate always follows the GitHub release, never the local origin.
      assert.match(
        scoop.autoupdate.architecture["64bit"].url,
        /^https:\/\/github\.com\//,
      );
    },
    { downloadBase: "http://127.0.0.1:8765/" },
  ));

function hasGit() {
  return spawnSync("git", ["--version"]).status === 0;
}

test(
  "push commits a channel's files into its repository once, and is a no-op when unchanged",
  { skip: !hasGit() },
  () =>
    withRendered((out) => {
      const base = mkdtempSync(join(tmpdir(), "armadra-tap-"));
      try {
        const remote = join(base, "tap.git");
        const run = (args, cwd) => {
          const result = spawnSync("git", args, { cwd, encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr);
          return result.stdout;
        };
        run(["init", "--bare", "-b", "main", remote]);
        const seed = join(base, "seed");
        run(["init", "-b", "main", seed]);
        writeFileSync(join(seed, "README.md"), "tap\n");
        run(["add", "."], seed);
        run(
          ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"],
          seed,
        );
        run(["push", remote, "main"], seed);

        assert.equal(
          push({
            channel: "tap",
            rendered: out,
            remote,
            version: VERSION,
            dryRun: true,
          }),
          "would-push",
        );
        assert.equal(
          run(["log", "--oneline", "main"], remote).trim().split("\n").length,
          1,
        );
        assert.equal(
          push({ channel: "tap", rendered: out, remote, version: VERSION }),
          "pushed",
        );
        assert.match(
          run(["log", "-1", "--format=%s", "main"], remote),
          /^armadra 1\.2\.3\n$/,
        );
        assert.match(
          run(["show", "main:Casks/armadra.rb"], remote),
          /cask "armadra" do/,
        );
        assert.equal(
          push({ channel: "tap", rendered: out, remote, version: VERSION }),
          "unchanged",
        );
        assert.throws(
          () =>
            push({
              channel: "winget",
              rendered: out,
              remote,
              version: VERSION,
            }),
          /tap and scoop/,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }),
);
