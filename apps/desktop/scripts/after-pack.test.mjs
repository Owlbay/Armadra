import { strict as assert } from "node:assert";
import test from "node:test";

import {
  bundleResources,
  copyWithRetry,
  electronNoticePlacements,
  noticeResources,
  placeElectronNotices,
  migrationResources,
  placeLaunchExe,
  placements,
  platformFor,
} from "./after-pack.mjs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_EXE_RESOURCE } from "./launch-exe.mjs";

test("only the platform/arch pairs this shell ships are packaged", () => {
  assert.equal(platformFor("darwin", "arm64"), "darwin");
  assert.equal(platformFor("win32", "x64"), "win32");
  assert.equal(platformFor("linux", "arm64"), "linux");
  assert.throws(() => platformFor("win32", "ia32"), /no bundle target/);
});

test("a busy file is retried until it copies, and the holder is reported once", () => {
  let calls = 0;
  const seen = [];
  const attempts = copyWithRetry("src.exe", "dst.exe", {
    stepMs: 0,
    copy: () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    log: (line) => seen.push(line),
    report: () => "42 scanner (module)",
    sleep: () => {},
  });
  assert.equal(attempts, 3);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /42 scanner \(module\)/);
  assert.match(seen[1], /after 3 attempts/);
});

test("a file that stays busy past the limit fails with the code in the message", () => {
  let clock = 0;
  assert.throws(
    () =>
      copyWithRetry("src.exe", "dst.exe", {
        limitMs: 10,
        stepMs: 5,
        copy: () => {
          throw Object.assign(new Error("busy"), { code: "EPERM" });
        },
        log: () => {},
        report: () => "",
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
        },
      }),
    /stayed busy for 0.01s \(EPERM\)/,
  );
});

test("an error that is not a sharing violation is not retried", () => {
  let calls = 0;
  assert.throws(
    () =>
      copyWithRetry("src.exe", "dst.exe", {
        copy: () => {
          calls += 1;
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        },
        log: () => {},
        sleep: () => {},
      }),
    /gone/,
  );
  assert.equal(calls, 1);
});

test("a platform's placements are its out/ bundles, the notices and every migration, nothing else", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const placed = placements(platform);
    // Nothing is an executable any more: the core runs on the Electron the
    // bundle already carries, and there are no sidecar binaries left to chmod.
    assert.deepEqual(
      placed.filter((p) => p.executable),
      [],
    );
    assert.deepEqual(
      placed.map((p) => `${p.from} -> ${p.to}`),
      [
        ...bundleResources(platform),
        ...noticeResources(),
        ...migrationResources(),
      ].map((r) => `${r.from} -> ${r.to}`),
    );
  }
  // Only Windows carries the session host; every platform carries the hook
  // and the bundled ama with its host adapter.
  const ama = [
    "agent/ama.cjs",
    "agent/ama-sandbox.cjs",
    "agent-host/ama-armadra.cjs",
  ];
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(
      bundleResources(platform).map((r) => r.to),
      ["cli/armadra-hook.js", "tray.png", ...ama],
    );
  }
  assert.deepEqual(
    bundleResources("win32").map((r) => r.to),
    [
      "cli/armadra-hook.js",
      "tray.png",
      ...ama,
      "session-host/host.cjs",
      "session-host/shutdown-if-idle.cjs",
    ],
  );
  // The paths the core looks for (`hook/install/shared.ts::agentBundle`,
  // `agentHostBundle`) under `process.resourcesPath`.
  assert.ok(
    bundleResources("darwin").some(
      (r) => r.from === "out/agent/ama.cjs" && r.to === "agent/ama.cjs",
    ),
  );
});

test("the migrations go where a packaged core looks for them", () => {
  const migrations = migrationResources();
  // `core/db/migrations.ts` joins `resourcesPath` with exactly "migrations".
  assert.ok(migrations.every((m) => m.to.startsWith("migrations/")));
  assert.ok(migrations.every((m) => m.to.endsWith(".sql")));
  // One continuous sequence from 1: the same set the ledger preflight reads.
  assert.deepEqual(
    migrations.map((m) =>
      Number(m.to.slice("migrations/".length, -".sql".length).slice(0, 4)),
    ),
    migrations.map((_, index) => index + 1),
  );
});

test("a Windows target also gets the canvas launcher, built only on a Windows host", () => {
  const built = [];
  const logs = [];
  const options = {
    host: "win32",
    compile: (output) => (built.push(output), output),
    log: (line) => logs.push(line),
  };
  assert.equal(placeLaunchExe("darwin", "R", options), undefined);
  assert.equal(placeLaunchExe("linux", "R", options), undefined);
  assert.deepEqual(built, []);
  assert.equal(
    placeLaunchExe("win32", "R", options),
    join("R", LAUNCH_EXE_RESOURCE),
  );
  assert.deepEqual(built, [join("R", LAUNCH_EXE_RESOURCE)]);

  const elsewhere = [];
  assert.equal(
    placeLaunchExe("win32", "R", {
      host: "darwin",
      compile: () => assert.fail("no compiler off Windows"),
      log: (line) => elsewhere.push(line),
    }),
    undefined,
  );
  assert.match(
    elsewhere[0],
    /WARNING .*armadra-launch\.exe.*without injection/,
  );
});

test("every bundle carries the generated notices and ama's own, from files that exist", () => {
  assert.deepEqual(
    noticeResources().map((r) => r.to),
    ["THIRD_PARTY_NOTICES.md", "agent/LICENSE", "agent/THIRD_PARTY_NOTICES.md"],
  );
  const app = fileURLToPath(new URL("..", import.meta.url));
  for (const resource of noticeResources())
    assert.ok(existsSync(join(app, resource.from)), resource.from);
});

test("Electron's notices go back into Contents/Resources on macOS and beside the executable elsewhere", () => {
  const dirs = { appOutDir: "OUT", resourcesDir: "RES" };
  assert.deepEqual(
    electronNoticePlacements("darwin", dirs).map((p) => `${p.from} -> ${p.to}`),
    [
      `LICENSE -> ${join("RES", "LICENSE.electron.txt")}`,
      `LICENSES.chromium.html -> ${join("RES", "LICENSES.chromium.html")}`,
    ],
  );
  assert.deepEqual(
    electronNoticePlacements("win32", dirs).map((p) => p.to),
    [
      join("OUT", "LICENSE.electron.txt"),
      join("OUT", "LICENSES.chromium.html"),
    ],
  );

  const dir = mkdtempSync(join(tmpdir(), "armadra-after-pack-"));
  try {
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "LICENSE"), "electron");
    writeFileSync(join(dist, "LICENSES.chromium.html"), "<html>");
    const mac = {
      appOutDir: join(dir, "mac"),
      resourcesDir: join(dir, "mac/Resources"),
    };
    let looked = 0;
    const options = {
      dist: () => (looked++, dist),
      copy: (from, to) => copyFileSync(from, to),
    };
    assert.equal(placeElectronNotices("darwin", mac, options).length, 2);
    assert.equal(
      readFileSync(join(mac.resourcesDir, "LICENSE.electron.txt"), "utf8"),
      "electron",
    );
    // Windows/Linux: what electron-builder already placed is left alone.
    const linux = {
      appOutDir: join(dir, "linux"),
      resourcesDir: join(dir, "linux/resources"),
    };
    mkdirSync(linux.appOutDir);
    writeFileSync(join(linux.appOutDir, "LICENSE.electron.txt"), "packager's");
    assert.deepEqual(placeElectronNotices("linux", linux, options), [
      join(linux.appOutDir, "LICENSES.chromium.html"),
    ]);
    assert.equal(
      readFileSync(join(linux.appOutDir, "LICENSE.electron.txt"), "utf8"),
      "packager's",
    );
    // Both already beside the executable: the distribution is not even looked up.
    const before = looked;
    assert.deepEqual(placeElectronNotices("linux", linux, options), []);
    assert.equal(looked, before);
    // A distribution without them fails the build rather than ship without.
    rmSync(join(dist, "LICENSE"));
    assert.throws(
      () => placeElectronNotices("darwin", mac, options),
      /notices must ship with the bundle/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
