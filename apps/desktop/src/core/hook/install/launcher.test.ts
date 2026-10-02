import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installCollaborationSkill } from "../../collab/skill";
import { tempDir } from "../../testing/temp-dir";
import { artifactLayout } from "./inject";
import {
  LAUNCH_GATE,
  type LauncherSpec,
  launcherFiles,
  posixLauncher,
  posixShim,
  runDirectory,
  shimsDirectory,
} from "./launcher";
import { remoteIntegrationFiles, runDirectory as remoteRun } from "./remote";

/**
 * POSIX 启动器与垫片（docs/design/canvas-launcher.md §4、§13.1）。
 *
 * 正文断言确定性；行为用真的 `/bin/sh` 跑：假 CLI 把自己收到的 argv 与几个
 * 变量写成 JSON，断言门开关、参数透传（空格、引号、`--`）、变量只给 CLI 进程、
 * 垫片摘掉自己的目录后委托。
 */

const posixOnly = process.platform !== "win32";

let root: string;
let spec: LauncherSpec;

/** 注入里故意带引号、空格、`$` 与换行转义，确认它们是字面量。 */
const NASTY = `developer_instructions="it's \\n $HOME \`x\` a b"`;

beforeEach(() => {
  root = tempDir("armadra-launcher-sh-");
  spec = {
    agentId: "claude",
    runDir: runDirectory(root, posix.join),
    shimDir: shimsDirectory(root, posix.join),
    args: ["--settings", join(root, "a dir", "settings.json"), "-c", NASTY],
    env: [
      ["OPENCODE_CONFIG_DIR", join(root, "config dir")],
      ["OPENCODE_CONFIG_CONTENT", '{"instructions":["x y"]}'],
    ],
  };
});

function write(files: Map<string, { content: string; mode: number }>): void {
  for (const [path, file] of files) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.content, "utf8");
    chmodSync(path, file.mode);
  }
}

/** 一个把 argv 与环境记成 JSON 的假 CLI，名字 `name`，放在 `dir` 里。 */
function fakeCli(dir: string, name: string, out: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  configDir: process.env.OPENCODE_CONFIG_DIR ?? null,",
      "  content: process.env.OPENCODE_CONFIG_CONTENT ?? null,",
      "  path: process.env.PATH,",
      "}));",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

interface Seen {
  argv: string[];
  configDir: string | null;
  content: string | null;
  path: string;
}

function run(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: string,
): { seen: Seen; stdout: string } {
  const stdout = execFileSync("/bin/sh", argv, { env, encoding: "utf8" });
  return { seen: JSON.parse(readFileSync(out, "utf8")) as Seen, stdout };
}

function baseEnv(path: string): NodeJS.ProcessEnv {
  return { PATH: path, HOME: root, ARMADRA_NO_GLOBAL_WRITES: "1" };
}

describe("the generated text", () => {
  it("is deterministic and puts both files where the layout says", () => {
    const files = launcherFiles(spec, posix.join);
    expect([...files.keys()]).toEqual([
      posix.join(root, "integration", "run", "claude"),
      posix.join(root, "integration", "shims", "claude"),
    ]);
    for (const file of files.values()) expect(file.mode).toBe(0o755);
    expect(launcherFiles(spec, posix.join)).toEqual(files);
    const launcher = posixLauncher(spec);
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcher).toContain(`[ -n "\${${LAUNCH_GATE}:-}" ] || exec "$@"`);
    // 变量在门之后才设。
    expect(launcher.indexOf("OPENCODE_CONFIG_DIR=")).toBeGreaterThan(
      launcher.indexOf("|| exec"),
    );
  });

  it("writes a launcher with nothing to inject as a plain exec", () => {
    const bare = posixLauncher({ ...spec, args: [], env: [] });
    expect(bare.trimEnd().split("\n").at(-1)).toBe('exec "$@"');
  });

  it("refuses an environment name that would be code", () => {
    expect(() =>
      posixLauncher({ ...spec, env: [["A;rm -rf /", "x"]] }),
    ).toThrow(/environment variable/);
  });

  it("delegates the shim to the launcher by bare name", () => {
    const shim = posixShim(spec);
    expect(shim.trimEnd().split("\n").at(-1)).toBe(
      `exec ${posix.join(spec.runDir, "claude")} claude "$@"`,
    );
  });
});

describe.runIf(posixOnly)("the launcher, run by /bin/sh", () => {
  const callerArgs = ["resume", "id-1", "a b", `it's "q"`, "--", "--x", ""];

  it("passes the caller's words through untouched outside a canvas node", () => {
    write(launcherFiles(spec, posix.join));
    const out = join(root, "out.json");
    const cli = fakeCli(join(root, "bin"), "claude", out);
    const { seen } = run(
      [join(spec.runDir, "claude"), cli, ...callerArgs],
      baseEnv("/usr/bin:/bin"),
      out,
    );
    expect(seen.argv).toEqual(callerArgs);
    expect(seen.configDir).toBeNull();
    expect(seen.content).toBeNull();
  });

  it("appends the injection after the caller's words in a canvas node", () => {
    write(launcherFiles(spec, posix.join));
    const out = join(root, "out.json");
    const cli = fakeCli(join(root, "bin"), "claude", out);
    const { seen } = run(
      [join(spec.runDir, "claude"), cli, ...callerArgs],
      { ...baseEnv("/usr/bin:/bin"), [LAUNCH_GATE]: "node-1" },
      out,
    );
    expect(seen.argv).toEqual([...callerArgs, ...spec.args]);
    expect(seen.configDir).toBe(join(root, "config dir"));
    expect(seen.content).toBe('{"instructions":["x y"]}');
  });

  it("sets the variables for the CLI only, never for its caller", () => {
    write(launcherFiles(spec, posix.join));
    const out = join(root, "out.json");
    const cli = fakeCli(join(root, "bin"), "claude", out);
    const script = join(root, "caller.sh");
    writeFileSync(
      script,
      `${posix.join(spec.runDir, "claude")} '${cli}'\necho "after=\${OPENCODE_CONFIG_DIR:-unset}"\n`,
      "utf8",
    );
    const { seen, stdout } = run(
      [script],
      { ...baseEnv("/usr/bin:/bin"), [LAUNCH_GATE]: "node-1" },
      out,
    );
    expect(seen.configDir).toBe(join(root, "config dir"));
    expect(stdout.trim()).toBe("after=unset");
  });

  it("lets the shim find the real CLI past itself, and inject once", () => {
    write(launcherFiles(spec, posix.join));
    const out = join(root, "out.json");
    const realDir = join(root, "real bin");
    fakeCli(realDir, "claude", out);
    const path = `${spec.shimDir}:${realDir}:/usr/bin:/bin`;
    const { seen } = run(
      [join(spec.shimDir, "claude"), "--model", "opus"],
      { ...baseEnv(path), [LAUNCH_GATE]: "node-1" },
      out,
    );
    expect(seen.argv).toEqual(["--model", "opus", ...spec.args]);
    // 垫片摘掉了自己：CLI 再起 `claude` 时命中真程序，不会再经过启动器。
    expect(seen.path).toBe(`${realDir}:/usr/bin:/bin`);
    expect(seen.path.split(":")).not.toContain(spec.shimDir);
  });

  it("starts the real CLI bare through the shim outside a canvas node", () => {
    write(launcherFiles(spec, posix.join));
    const out = join(root, "out.json");
    const realDir = join(root, "real");
    fakeCli(realDir, "claude", out);
    const { seen } = run(
      [join(spec.shimDir, "claude"), "x y"],
      baseEnv(`${spec.shimDir}:${realDir}:/usr/bin:/bin`),
      out,
    );
    expect(seen.argv).toEqual(["x y"]);
    expect(seen.configDir).toBeNull();
  });

  it("is executable as written", () => {
    write(launcherFiles(spec, posix.join));
    expect(statSync(join(spec.runDir, "claude")).mode & 0o111).not.toBe(0);
    const out = join(root, "out.json");
    const cli = fakeCli(join(root, "bin"), "claude", out);
    execFileSync(join(spec.runDir, "claude"), [cli, "ok"], {
      env: baseEnv("/usr/bin:/bin"),
    });
    expect((JSON.parse(readFileSync(out, "utf8")) as Seen).argv).toEqual([
      "ok",
    ]);
  });
});

/**
 * 执行主机那份（docs/design/canvas-launcher.md §6.2）：同一个生成器，垫片委托
 * 给 `run/<cli>`，启动器里是远端路径；没有任何一份去碰 Codex 的信任。
 */
describe("the copy synced to an execution host", () => {
  function remoteFiles(remoteRoot: string) {
    const release = installCollaborationSkill();
    try {
      return remoteIntegrationFiles(
        {
          root: remoteRoot,
          node: "/usr/bin/node",
          socket: posix.join(remoteRoot, "relay.sock"),
          endpointFile: posix.join(remoteRoot, "endpoint.json"),
          tokenDir: posix.join(remoteRoot, "tokens"),
        },
        "// bundle\n",
      );
    } finally {
      release();
    }
  }

  it("writes a launcher and a delegating shim per CLI", () => {
    const files = remoteFiles("/srv/armadra/integration/7");
    const byPath = new Map(files.map((entry) => [entry.path, entry]));
    const run = remoteRun("/srv/armadra/integration/7");
    const claude = byPath.get(posix.join(run, "claude"));
    expect(claude?.mode).toBe(0o755);
    const layout = artifactLayout(
      "/srv/armadra/integration/7",
      "claude",
      posix.join,
    );
    expect(claude?.content).toContain(
      `--settings ${layout.settings as string}`,
    );
    expect(
      byPath.get("/srv/armadra/integration/7/shims/claude")?.content,
    ).toContain(`exec ${posix.join(run, "claude")} claude "$@"`);
    const codex = byPath.get(posix.join(run, "codex"))?.content ?? "";
    expect(codex).toContain("--dangerously-bypass-hook-trust");
    expect(codex).toContain("hooks.SessionStart=");
  });

  it.runIf(posixOnly)("injects through the synced shim, run by /bin/sh", () => {
    const remoteRoot = join(root, "remote");
    for (const entry of remoteFiles(remoteRoot)) {
      mkdirSync(join(entry.path, ".."), { recursive: true });
      writeFileSync(entry.path, entry.content, "utf8");
      chmodSync(entry.path, entry.mode);
    }
    const out = join(root, "out.json");
    const realDir = join(root, "host bin");
    fakeCli(realDir, "claude", out);
    const shims = join(remoteRoot, "shims");
    const { seen } = run(
      [join(shims, "claude"), "--model", "opus"],
      {
        ...baseEnv(`${shims}:${realDir}:/usr/bin:/bin`),
        [LAUNCH_GATE]: "node-1",
      },
      out,
    );
    const layout = artifactLayout(remoteRoot, "claude", posix.join);
    expect(seen.argv.slice(0, 4)).toEqual([
      "--model",
      "opus",
      "--settings",
      layout.settings,
    ]);
    expect(seen.path.split(":")).not.toContain(shims);
  });
});
