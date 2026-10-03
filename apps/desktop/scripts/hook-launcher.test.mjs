import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { placeHookLauncher } from "./after-pack.mjs";
import {
  HOOK_LAUNCHER_RESOURCE,
  compileCSharp,
  compileHookLauncher,
  cscArguments,
  cscCandidates,
  findCsc,
} from "./hook-launcher.mjs";
import {
  LAUNCH_EXE_RESOURCE,
  LAUNCH_EXE_SOURCE,
  buildLaunchExe,
  compileLaunchExe,
} from "./launch-exe.mjs";

test("csc is looked for under every .NET Framework 4 directory of WINDIR", () => {
  const candidates = cscCandidates({ WINDIR: "D:\\Win" });
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    assert.ok(candidate.startsWith(join("D:\\Win", "Microsoft.NET")));
    assert.ok(candidate.endsWith(join("v4.0.30319", "csc.exe")));
  }
  const second = candidates[1];
  assert.equal(
    findCsc({ env: { WINDIR: "D:\\Win" }, exists: (p) => p === second }),
    second,
  );
  assert.equal(
    findCsc({ env: { WINDIR: "D:\\Win" }, exists: () => false }),
    undefined,
  );
});

test("the launcher is an anycpu console program", () => {
  const args = cscArguments("in.cs", "out.exe");
  assert.ok(args.includes("/target:exe"));
  assert.ok(args.includes("/platform:anycpu"));
  assert.ok(args.includes("/out:out.exe"));
  assert.equal(args.at(-1), "in.cs");
});

test("after-pack builds the launcher only for a Windows target", () => {
  const built = [];
  const logs = [];
  const options = {
    host: "win32",
    compile: (output) => (built.push(output), output),
    log: (line) => logs.push(line),
  };
  assert.equal(placeHookLauncher("darwin", "R", options), undefined);
  assert.equal(placeHookLauncher("linux", "R", options), undefined);
  assert.deepEqual(built, []);
  assert.equal(
    placeHookLauncher("win32", "R", options),
    join("R", HOOK_LAUNCHER_RESOURCE),
  );
  assert.deepEqual(built, [join("R", HOOK_LAUNCHER_RESOURCE)]);
});

test("a Windows target packaged elsewhere says it fell back to the .cmd", () => {
  const logs = [];
  const result = placeHookLauncher("win32", "R", {
    host: "darwin",
    compile: () => assert.fail("no compiler off Windows"),
    log: (line) => logs.push(line),
  });
  assert.equal(result, undefined);
  assert.match(logs[0], /WARNING .*armadra-hook\.cmd/);
});

test(
  "the C# source compiles with the csc every Windows ships",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-launcher-exe-"));
    try {
      const output = compileHookLauncher(join(dir, "armadra-hook.exe"));
      assert.ok(existsSync(output));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("one compile function builds both C# programs, named in its errors", () => {
  const windir = mkdtempSync(join(tmpdir(), "armadra-windir-"));
  try {
    const env = { WINDIR: windir };
    assert.throws(
      () => compileLaunchExe(join(windir, "out", "a.exe"), { env }),
      /^Error: launch-exe: no csc\.exe/,
    );
    const csc = cscCandidates(env)[2];
    mkdirSync(dirname(csc), { recursive: true });
    writeFileSync(csc, "");
    const calls = [];
    const ok = (program, args) => (
      calls.push({ program, args }),
      { status: 0 }
    );
    const output = join(windir, "out", "armadra-launch.exe");
    assert.equal(compileLaunchExe(output, { env, run: ok }), output);
    assert.equal(calls[0].program, csc);
    assert.ok(calls[0].args.includes(`/out:${output}`));
    assert.ok(
      calls[0].args
        .at(-1)
        .endsWith(join("armadra-launch", "windows-launch.cs")),
    );
    const failing = () => ({ status: 3, stdout: "CS1002", stderr: "" });
    assert.throws(
      () => compileCSharp("a.cs", output, { env, run: failing, name: "x" }),
      /^Error: x: csc exited 3\nCS1002/,
    );
  } finally {
    rmSync(windir, { recursive: true, force: true });
  }
  assert.ok(LAUNCH_EXE_SOURCE.endsWith("armadra-launch/windows-launch.cs"));
  assert.equal(LAUNCH_EXE_RESOURCE, "cli/armadra-launch.exe");
});

test("the build compiles the canvas launcher only on a Windows host", () => {
  const built = [];
  const logs = [];
  const compile = (output) => (built.push(output), output);
  const log = (line) => logs.push(line);
  assert.equal(
    buildLaunchExe(["--if-windows"], { host: "darwin", compile, log }),
    undefined,
  );
  assert.equal(
    buildLaunchExe(["--if-windows"], {
      host: "win32",
      env: { WINDIR: join(tmpdir(), "no-windows-here") },
      compile,
      log,
    }),
    undefined,
  );
  assert.match(logs[0], /WARNING no csc\.exe/);
  assert.deepEqual(built, []);
  // Asked for explicitly, it compiles wherever it is run (and fails off Windows).
  assert.equal(buildLaunchExe(["x.exe"], { compile, log }), "x.exe");
  assert.ok(
    buildLaunchExe([], { compile, log }).endsWith(
      join("out", "cli", "armadra-launch.exe"),
    ),
  );
});

test(
  "the canvas launcher's C# source compiles with the csc every Windows ships",
  { skip: process.platform !== "win32" },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "armadra-launch-exe-"));
    try {
      const output = compileLaunchExe(join(dir, "armadra-launch.exe"));
      assert.ok(existsSync(output));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
