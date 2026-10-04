import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assemble } from "./assemble.mjs";
import { stageAssets } from "./dry-run.mjs";
import { generateKey, publicKeyFile, secretFromKey } from "./minisign.mjs";
import {
  MIRROR_ENV,
  RCLONE_IMAGE,
  mirrorConfig,
  promote,
  promotePlan,
  rcloneEnv,
  rcloneRunner,
  stage,
  stagePlan,
  verifyMirror,
} from "./mirror.mjs";
import { S3_DEV } from "../dev-stack/services.mjs";

const VERSION = "0.2.0";
const TAG = `v${VERSION}`;

const FULL = {
  ARMADRA_MIRROR_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  ARMADRA_MIRROR_BUCKET: "armadra-updates",
  ARMADRA_MIRROR_ACCESS_KEY_ID: "id",
  ARMADRA_MIRROR_SECRET_ACCESS_KEY: "secret",
};

test("no mirror settings skip; some of them is a configuration error", () => {
  assert.deepEqual(mirrorConfig({}), { skip: true });
  const half = mirrorConfig({ ARMADRA_MIRROR_BUCKET: "b" });
  assert.match(half.problem, /half configured/);
  assert.match(half.problem, /ARMADRA_MIRROR_ENDPOINT/);
  const config = mirrorConfig(FULL);
  assert.equal(config.provider, "Cloudflare");
  assert.equal(config.region, "auto");
  assert.equal(config.bucket, "armadra-updates");
  assert.equal(MIRROR_ENV.length, 4);
});

test("the rclone remote is defined by environment, never by a file", () => {
  const env = rcloneEnv(mirrorConfig(FULL));
  assert.equal(env.RCLONE_CONFIG_MIRROR_TYPE, "s3");
  assert.equal(env.RCLONE_CONFIG_MIRROR_PROVIDER, "Cloudflare");
  assert.equal(
    env.RCLONE_CONFIG_MIRROR_ENDPOINT,
    "https://acct.r2.cloudflarestorage.com",
  );
  assert.equal(env.RCLONE_CONFIG_MIRROR_NO_CHECK_BUCKET, "true");
});

test("stage uploads the bundles before any manifest, then lays the mirror's latest.json over, then checks", () => {
  const plan = stagePlan({
    source: "/r",
    manifestSource: "/m",
    bucket: "b",
    version: VERSION,
  });
  assert.deepEqual(
    plan.map((args) => args.slice(0, 3)),
    [
      ["copy", "/r", "mirror:b/releases/download/v0.2.0"],
      ["copy", "/r", "mirror:b/releases/download/v0.2.0"],
      ["copy", "/m", "mirror:b/releases/download/v0.2.0"],
      ["check", "/r", "mirror:b/releases/download/v0.2.0"],
    ],
  );
  assert.ok(plan[0].includes("--exclude") && plan[0].includes("latest.json*"));
  assert.ok(plan[1].includes("+ SHA256SUMS*") && plan[1].includes("- *"));
  assert.ok(plan[3].includes("--one-way"));
  // Without a mirror manifest nothing is overlaid and nothing excluded from the check.
  const plain = stagePlan({ source: "/r", bucket: "b", version: VERSION });
  assert.equal(plain.length, 3);
  assert.ok(!plain[2].includes("--exclude"));
});

test("promote copies only the manifests of that version to latest, server side", () => {
  const plan = promotePlan({ bucket: "b", version: VERSION });
  assert.deepEqual(plan[0].slice(0, 3), [
    "copy",
    "mirror:b/releases/download/v0.2.0",
    "mirror:b/releases/latest/download",
  ]);
  assert.ok(plan[0].includes("- *"));
  assert.equal(plan[1][0], "check");
});

test("without rclone on PATH it runs the pinned image, mounting what it reads", () => {
  const mac = rcloneRunner({ env: {}, platform: "darwin", local: false });
  assert.equal(mac.path("/tmp/release"), "/mnt/m0");
  assert.equal(mac.path("/tmp/mirror"), "/mnt/m1");
  assert.equal(mac.path("/tmp/release"), "/mnt/m0");
  assert.equal(
    mac.endpoint("http://127.0.0.1:8095"),
    "http://host.docker.internal:8095",
  );
  const call = mac.invoke(["version"], { A: "1" });
  assert.equal(call.command, "docker");
  assert.ok(call.args.includes(RCLONE_IMAGE));
  assert.ok(call.args.includes("/tmp/release:/mnt/m0:ro"));
  assert.ok(!call.args.includes("--network"));
  const linux = rcloneRunner({ env: {}, platform: "linux", local: false });
  assert.equal(
    linux.endpoint("http://127.0.0.1:8095"),
    "http://127.0.0.1:8095",
  );
  assert.ok(linux.invoke(["version"], {}).args.includes("--network"));
  const local = rcloneRunner({ env: {}, local: true });
  assert.equal(local.invoke(["version"], {}).command, "rclone");
});

/** A release assembled with a throwaway key and a mirror manifest for `base`. */
async function assembled(base) {
  const work = mkdtempSync(join(tmpdir(), "armadra-mirror-"));
  const directory = join(work, "release");
  const out = join(work, "mirror");
  stageAssets({ directory, version: VERSION });
  const key = generateKey();
  const result = await assemble({
    directory,
    version: VERSION,
    repo: "Owlbay/Armadra",
    tag: TAG,
    notes: "- notes",
    secret: secretFromKey(key),
    mirror: { base, out },
  });
  assert.deepEqual(result.problems, []);
  return { work, directory, out, publicKeyText: publicKeyFile(key) };
}

/** Lay a release out the way the bucket holds it after stage + promote. */
function bucketTree({ directory, out, root, overlay = true }) {
  const versioned = join(root, "releases/download", TAG);
  const latest = join(root, "releases/latest/download");
  mkdirSync(versioned, { recursive: true });
  mkdirSync(latest, { recursive: true });
  for (const name of readdirSync(directory))
    copyFileSync(join(directory, name), join(versioned, name));
  if (overlay)
    for (const name of readdirSync(out))
      copyFileSync(join(out, name), join(versioned, name));
  for (const name of readdirSync(versioned))
    if (/^(latest\.json|SHA256SUMS|latest-.*\.yml)/.test(name))
      copyFileSync(join(versioned, name), join(latest, name));
}

function serve(root, port = 0) {
  const server = createServer((request, response) => {
    try {
      const path = join(root, decodeURIComponent(request.url.split("?")[0]));
      response.end(readFileSync(path));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("a mirror laid out by stage + promote verifies the way a client reads it", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const release = await assembled(base);
  const root = join(release.work, "bucket");
  bucketTree({ ...release, root });
  const server = await serve(root, port);
  try {
    const result = await verifyMirror({
      base,
      publicKeyText: release.publicKeyText,
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.version, VERSION);
    assert.equal(result.checked.length, 1 + 6);
  } finally {
    server.close();
    rmSync(release.work, { recursive: true, force: true });
  }
});

test("a mirror serving the release's own latest.json only mirrors the check", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const release = await assembled(base);
  const root = join(release.work, "bucket");
  bucketTree({ ...release, root, overlay: false });
  const server = await serve(root, port);
  try {
    const { problems } = await verifyMirror({
      base,
      publicKeyText: release.publicKeyText,
    });
    assert.ok(problems.some((p) => /is not on the mirror/.test(p)));
  } finally {
    server.close();
    rmSync(release.work, { recursive: true, force: true });
  }
});

test("the mirror's latest.json is signed as latest.json and offers what the release does", async () => {
  const release = await assembled("https://updates.example.invalid/");
  try {
    const mirrored = JSON.parse(
      readFileSync(join(release.out, "latest.json"), "utf8"),
    );
    const own = JSON.parse(
      readFileSync(join(release.directory, "latest.json"), "utf8"),
    );
    assert.deepEqual(
      Object.keys(mirrored.platforms),
      Object.keys(own.platforms),
    );
    for (const entry of Object.values(mirrored.platforms)) {
      assert.match(
        entry.url,
        /^https:\/\/updates\.example\.invalid\/releases\/download\/v0\.2\.0\//,
      );
      assert.match(entry.feed.url, /^https:\/\/updates\.example\.invalid\//);
    }
    assert.match(
      readFileSync(join(release.out, "latest.json.sig"), "utf8"),
      /trusted comment: file:latest\.json version:0\.2\.0/,
    );
    assert.ok(!readdirSync(release.directory).includes("mirror"));
  } finally {
    rmSync(release.work, { recursive: true, force: true });
  }
});

/**
 * dev-stack `s3`（`pnpm dev-stack up s3 --profile s3`）上真跑 rclone：建桶、stage、
 * promote，再用 `rclone serve http` 把桶当公开地址读一遍。只在 ARMADRA_DEV_STACK=1
 * 且桶答得上时跑。
 */
test(
  "stage and promote against the dev-stack S3 bucket, read back over HTTP",
  { skip: process.env.ARMADRA_DEV_STACK !== "1" },
  async (t) => {
    const reachable = await fetch(`${S3_DEV.endpoint}/`).catch(() => null);
    if (!reachable || reachable.status !== 403) {
      t.skip("dev-stack s3 is not up");
      return;
    }
    const bucket = `mirror-${Date.now()}`;
    const config = {
      endpoint: S3_DEV.endpoint,
      bucket,
      accessKeyId: S3_DEV.accessKeyId,
      secretAccessKey: S3_DEV.secretAccessKey,
      provider: "Other",
      region: S3_DEV.region,
    };
    const runner = rcloneRunner();
    const docker = !runner.local;
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const release = await assembled(base);
    const log = () => {};
    const rclone = (args, extra = [], override = {}) => {
      const call = rcloneRunner().invoke(args, {
        ...rcloneEnv({ ...config, endpoint: runner.endpoint(config.endpoint) }),
        ...override,
      });
      call.args.splice(call.command === "docker" ? 2 : 0, 0, ...extra);
      return call;
    };
    let served;
    try {
      // The job never creates buckets (R2 tokens are often bucket-scoped);
      // this throwaway one is made with the bucket check switched back on.
      const make = rclone(["mkdir", `mirror:${bucket}`], [], {
        RCLONE_CONFIG_MIRROR_NO_CHECK_BUCKET: "false",
      });
      assert.equal(
        spawnSync(make.command, make.args, { env: make.env, stdio: "inherit" })
          .status,
        0,
      );
      stage({
        directory: release.directory,
        manifestDir: release.out,
        version: VERSION,
        config,
        runner,
        log,
      });
      promote({ version: VERSION, config, runner, log });
      // The bucket's public face: rclone serves it read-only over HTTP, the
      // way a custom domain fronts an R2 bucket.
      const serveArgs = [
        "serve",
        "http",
        `mirror:${bucket}`,
        "--addr",
        docker && process.platform !== "linux" ? ":8080" : `127.0.0.1:${port}`,
        "--read-only",
      ];
      const call = rclone(
        serveArgs,
        docker
          ? [
              "-d",
              "--name",
              `armadra-mirror-serve-${port}`,
              ...(process.platform === "linux"
                ? []
                : ["-p", `127.0.0.1:${port}:8080`]),
            ]
          : [],
      );
      if (docker) {
        const started = spawnSync(call.command, call.args, {
          env: call.env,
          encoding: "utf8",
        });
        assert.equal(started.status, 0, started.stderr);
        served = {
          stop: () =>
            spawnSync("docker", ["rm", "-f", `armadra-mirror-serve-${port}`]),
        };
      } else {
        const child = (await import("node:child_process")).spawn(
          call.command,
          call.args,
          { env: call.env, stdio: "ignore" },
        );
        served = { stop: () => child.kill() };
      }
      let result;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        result = await verifyMirror({
          base,
          publicKeyText: release.publicKeyText,
        }).catch((error) => ({ problems: [error.message], checked: [] }));
        if (result.problems.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.deepEqual(result.problems, []);
      assert.equal(result.checked.length, 7);
    } finally {
      served?.stop();
      rmSync(release.work, { recursive: true, force: true });
    }
  },
);
