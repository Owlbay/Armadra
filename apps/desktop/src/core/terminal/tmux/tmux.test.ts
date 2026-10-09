import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_PREFIX, sessionKey } from "../backend";
import { agentPath, childEnvironment } from "../environment";
import { killTmuxServer } from "../../testing/temp-dir";
import {
  MINIMUM_VERSION,
  defaultTerminal,
  detect,
  ensureConf,
  parseVersion,
  renderedConf,
} from "./config";
import {
  LIST_ALIVE_FORMAT,
  enterOnly,
  parseAliveLine,
  pastePlan,
} from "./control";
import { TmuxBackend } from "./backend";

/**
 * The tmux backend's specification, ported one for one from
 * the pre-merge implementation.
 *
 * Everything that needs a live tmux server is guarded the same way the Rust
 * suite guards it — skipped when `tmux >= 3.2` is not on PATH — and binds its
 * socket under a tempdir it owns. That is not hygiene for its own sake: this
 * repository is developed from inside its own tmux-backed terminals, and a
 * test that reached for the real data directory would be driving the
 * developer's live sessions.
 */

const temporaries: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "armadra-tmux-"));
  temporaries.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    killTmuxServer(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("version detection", () => {
  it("compares against the floor", () => {
    expect(parseVersion("3.2a")).toEqual([3, 2]);
    expect(parseVersion("3.7b")).toEqual([3, 7]);
    expect(parseVersion("tmux 2.8")).toEqual([2, 8]);
    expect(parseVersion("3")).toEqual([3, 0]);
    expect(parseVersion("master")).toBeUndefined();
    expect(parseVersion("3.2a")?.[1]).toBeGreaterThanOrEqual(
      MINIMUM_VERSION[1],
    );
  });

  it("refuses on Windows without looking for a binary", () => {
    const detection = detect("win32");
    expect(detection.usable).toBe(false);
    expect(detection.reason).toContain("Windows");
  });
});

describe("the generated configuration", () => {
  it("is written once and then left alone", () => {
    const directory = tempDir();
    const conf = join(directory, "tmux.conf");
    ensureConf(conf);
    const written = statSync(conf).mtimeMs;
    expect(readFileSync(conf, "utf8")).toContain("prefix None");

    ensureConf(conf);
    expect(statSync(conf).mtimeMs).toBe(written);

    // A conf from an older build is replaced, not merged.
    writeFileSync(conf, "set -g status on\n");
    ensureConf(conf);
    expect(readFileSync(conf, "utf8")).toBe(renderedConf());
  });

  it.skipIf(process.platform === "win32")(
    "locks the directory to 0700 and the file to 0600",
    () => {
      const directory = tempDir();
      const conf = join(directory, "tmux.conf");
      ensureConf(conf);
      expect(statSync(conf).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    },
  );

  /**
   * Contract §18.3: true colour and the "resize to the smallest *attached*
   * client, not the smallest that ever attached" rule both live in the conf.
   */
  it("carries the compatibility options", () => {
    const conf = renderedConf();
    expect(conf).toContain('set -ga terminal-overrides ",*:Tc"');
    expect(conf).toContain('set -ga terminal-features ",xterm-256color:RGB"');
    expect(conf).toContain("set -g aggressive-resize on");
    expect(conf).toContain("set -g window-size latest");
    expect(conf).not.toContain("{terminal}");
  });

  /**
   * Contract §18.3 amendment: the client must never be put into mouse mode,
   * focus-reporting mode or the alternate screen, or the page loses native
   * selection and starts typing `\e[<0;8;3M` into whatever is running.
   */
  it("keeps selection, scrollback and the clipboard", () => {
    const conf = renderedConf();
    expect(conf).toContain("set -g mouse off");
    expect(conf).toContain("set -g focus-events off");
    expect(conf).not.toContain("set -g mouse on");
    expect(conf).not.toContain("set -g focus-events on");
    expect(conf).toContain('set -ga terminal-overrides ",*:smcup@:rmcup@"');
    expect(conf).toContain("set -g set-clipboard on");
    expect(conf).toContain('set -as terminal-features ",xterm*:clipboard"');
    expect(conf).toContain("set -gq allow-passthrough on");
  });

  /**
   * MINIMUM_VERSION is 3.2, so every option the conf sets without `-q` must
   * exist in 3.2: an unknown one opens each new session on tmux's
   * config-error screen, which eats the first keystrokes (Ubuntu 22.04's 3.2a).
   */
  it("sets options newer than the minimum tmux only quietly", () => {
    const newerThanMinimum = ["allow-passthrough"];
    for (const line of renderedConf().split("\n")) {
      const match = line.match(/^set(?:-option)? -(\w+) ([a-z-]+)/);
      if (match && newerThanMinimum.includes(match[2] ?? ""))
        expect(match[1], line).toContain("q");
    }
  });

  it("probes the default terminal and falls back", () => {
    const terminal = defaultTerminal();
    expect(["tmux-256color", "screen-256color"]).toContain(terminal);
    expect(renderedConf()).toContain(`set -g default-terminal "${terminal}"`);
  });
});

describe("listing", () => {
  /**
   * `session_activity` is bumped to `now` by every client attach, independent
   * of pane output, and is therefore useless as an idle judgement.
   */
  it("reads window_activity, not session_activity", () => {
    expect(LIST_ALIVE_FORMAT).toContain("#{window_activity}");
    expect(LIST_ALIVE_FORMAT).not.toContain("#{session_activity}");
  });

  it("ignores sessions that are not ours", () => {
    expect(
      parseAliveLine("armadra-a-b-1 1 1770000000", SESSION_PREFIX),
    ).toEqual({ name: "armadra-a-b-1", attached: true });
    expect(
      parseAliveLine("armadra-a-b-1 0 1770000000", SESSION_PREFIX),
    ).toEqual({ name: "armadra-a-b-1", attached: false });
    expect(
      parseAliveLine("someones-own-session 1 1", SESSION_PREFIX),
    ).toBeUndefined();
    expect(parseAliveLine("", SESSION_PREFIX)).toBeUndefined();
  });
});

describe("the paste plan", () => {
  /**
   * The copy-mode guard and the paste itself must be one tmux invocation, and
   * `-r` must be present so embedded newlines survive as `\n`.
   */
  it("guards copy-mode in the same call and keeps newlines", () => {
    const plan = pastePlan(
      "armadra-buf",
      "/tmp/armadra-buf.txt",
      "armadra-session",
      true,
    );
    expect(plan).toHaveLength(3);
    expect(plan[0]).toEqual([
      "load-buffer",
      "-b",
      "armadra-buf",
      "/tmp/armadra-buf.txt",
    ]);
    expect(plan[1]).toEqual([
      "if-shell",
      "-F",
      "#{pane_in_mode}",
      "send-keys -X cancel",
      ";",
      "paste-buffer",
      "-p",
      "-r",
      "-d",
      "-b",
      "armadra-buf",
      "-t",
      "armadra-session",
    ]);
    expect(plan[2]).toEqual(["send-keys", "-t", "armadra-session", "Enter"]);
  });

  it("skips Enter when it was not requested", () => {
    expect(
      pastePlan("armadra-buf", "/tmp/armadra-buf.txt", "s", false),
    ).toHaveLength(2);
  });

  /**
   * The Enter of an empty paste is the whole request. `load-buffer` of an
   * empty file creates no buffer, so the `paste-buffer -b` behind it used to
   * fail with "no buffer" and the route answered 500 — for "press Enter".
   */
  it("presses Enter on its own, with no buffer to load", () => {
    expect(enterOnly("armadra-session")).toEqual([
      "send-keys",
      "-t",
      "armadra-session",
      "Enter",
    ]);
  });
});

/* ------------------------- test server isolation -------------------------- */

describe("isolation", () => {
  /**
   * The production path, not a fixture: `childEnvironment` is what every tmux
   * child is spawned through, so this asserts what a real session inherits.
   * `TMUX`/`TMUX_PANE` simulate a suite launched from inside a live tmux pane
   * — the normal case for this repository's own development — and must not
   * survive the filter.
   */
  it("strips an ambient tmux client from the child environment", () => {
    const env = childEnvironment({
      ambient: {
        ...process.env,
        TMUX: "/tmp/tmux-0/default,1234,0",
        TMUX_PANE: "%0",
      },
    });
    expect(env.map(([key]) => key)).not.toContain("TMUX");
    expect(env.map(([key]) => key)).not.toContain("TMUX_PANE");
  });

  it("binds its socket under its own tempdir", () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    expect(backend.socket.startsWith(directory)).toBe(true);
    expect(resolve(backend.socket)).not.toContain("Application Support");
  });

  /**
   * By review: prove the pattern matches the construction it is meant to
   * catch, and not its neighbours, before trusting it to scan anything.
   */
  it("has a pattern that catches a bare -L socket and nothing else", () => {
    const bareSocket = /["']-L["']/;
    expect(bareSocket.test('args(["-L", "armadra"])')).toBe(true);
    expect(bareSocket.test('["-L", name]')).toBe(true);
    expect(bareSocket.test('args(["-S", socketPath])')).toBe(false);
    expect(bareSocket.test("// production binds -S, never -L")).toBe(false);
  });

  /**
   * Scans every source file of this directory — this guard excepted, since it
   * is the one file allowed to spell the pattern out — for a bare `-L`
   * socket, the shared per-user default that an absolute `-S <path>` exists to
   * avoid needing. It cannot stop a new offender being written, but it makes
   * writing one a decision that fails CI rather than one nobody noticed.
   */
  it("finds no bare -L socket in this directory", () => {
    const bareSocket = /["']-L["']/;
    // `pathname`, not `fileURLToPath`, would hand Windows "/D:/…" — a string
    // no `existsSync` will ever agree with.
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const files = ["backend.ts", "config.ts", "control.ts"];
    const offenders = files.filter((name) => {
      const path = join(directory, name);
      expect(existsSync(path)).toBe(true);
      return bareSocket.test(readFileSync(path, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});

/* -------------------------- a real tmux server ---------------------------- */

const tmuxAvailable = detect().usable;

describe.skipIf(!tmuxAvailable)("against a real tmux", () => {
  it("binds the socket file under the tempdir and destroys what it made", async () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("isolation-guard");
    await backend.create({
      sessionKey: key,
      workspaceId: "isolation-guard-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 80, rows: 24 },
    });
    expect(existsSync(join(directory, "tmux.sock"))).toBe(true);

    const alive = await backend.list();
    expect(alive.map((entry) => entry.name)).toContain(
      // `isolatio` is the workspace head, `on-guard` the key TAIL.
      "armadra-isolatio-on-guard-1",
    );

    await backend.terminate(key, "session");
    expect(await backend.list()).toEqual([]);
  }, 30_000);

  it("refuses an attach that carries a stale generation", async () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("generation-guard");
    await backend.create({
      sessionKey: key,
      workspaceId: "generation-guard-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 80, rows: 24 },
    });
    await expect(
      backend.attach(key, 0, { cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ status: 409 });
    await backend.terminate(key, "session");
  }, 30_000);

  /**
   * 多端尺寸（ui-acp-refresh §7.3 E-1）：一端改自己的客户端不动别端，也不动窗口；窗口只
   * 由 `resize` 显式设置。
   */
  it("resizes one viewer's client without touching the others or the window", async () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("viewer-sizes");
    const handle = await backend.create({
      sessionKey: key,
      workspaceId: "viewer-sizes-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 120, rows: 40 },
    });
    const name = handle.backendRef!;
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-S", backend.socket, ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: agentPath(process.env) },
      }).trim();
    const clients = () =>
      tmux("list-clients", "-t", name, "-F", "#{client_width}x#{client_height}")
        .split("\n")
        .sort();
    const window = () =>
      tmux(
        "display-message",
        "-p",
        "-t",
        name,
        "#{window_width}x#{window_height}",
      );

    expect(tmux("show-options", "-w", "-v", "-t", name, "window-size")).toBe(
      "manual",
    );
    const desk = await backend.attach(key, 1, { cols: 120, rows: 40 });
    const phone = await backend.attach(key, 1, { cols: 120, rows: 40 });
    await backend.resizeViewer(key, phone.attachmentId, { cols: 40, rows: 12 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(clients()).toEqual(["120x40", "40x12"]);
    expect(window()).toBe("120x40");

    await backend.resize(key, { cols: 100, rows: 30 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(window()).toBe("100x30");
    expect(clients()).toEqual(["120x40", "40x12"]);

    await backend.detach(key, desk.attachmentId);
    await backend.detach(key, phone.attachmentId);
    await backend.terminate(key, "session");
  }, 30_000);

  /**
   * 契约 §53：tmux 吞掉它不认识的 OSC，所以程序状态从 `pipe-pane` 读——没有
   * 客户端挂着也读得到，裸序列与 DCS 透传包着的都在。
   */
  it("taps the pane's raw output, OSC 7501 included, with nobody attached", async () => {
    const directory = tempDir();
    const backend = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("program-tap");
    const seen: Buffer[] = [];
    backend.programTap.subscribe((tapped, generation, chunk) => {
      if (tapped === key && generation === 1) seen.push(chunk);
    });
    const handle = await backend.create({
      sessionKey: key,
      workspaceId: "program-tap-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 80, rows: 24 },
    });
    const name = handle.backendRef!;
    const fifo = join(directory, "program-taps", `${name}.fifo`);
    expect(statSync(fifo).isFIFO()).toBe(true);
    expect(statSync(fifo).mode & 0o077).toBe(0);

    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-S", backend.socket, ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: agentPath(process.env) },
      }).trim();
    tmux(
      "send-keys",
      "-t",
      name,
      "printf '\\033]7501;state=working:progress=40\\033\\\\'; " +
        "printf '\\033Ptmux;\\033\\033]7501;state=blocked\\033\\033\\\\\\033\\\\'; " +
        "printf '\\033]9;4;1;55\\007'",
      "Enter",
    );
    const text = () => Buffer.concat(seen).toString("latin1");
    for (let tries = 0; tries < 50 && !text().includes("9;4;1;55"); tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(text()).toContain("\u001b]7501;state=working:progress=40\u001b\\");
    expect(text()).toContain("\u001bPtmux;\u001b\u001b]7501;state=blocked");
    expect(text()).toContain("\u001b]9;4;1;55\u0007");

    // The answer goes into the pane as input, not as tmux keys.
    tmux("send-keys", "-t", name, "cat -v", "Enter");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await backend.programTap.answer(key, Buffer.from("\u001b]7501;?\u001b\\"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tmux("capture-pane", "-p", "-t", name)).toContain("^[]7501;?^[\\");

    await backend.terminate(key, "session");
    expect(existsSync(fifo)).toBe(false);
  }, 30_000);

  it("re-taps a session it adopts after a restart", async () => {
    const directory = tempDir();
    const first = new TmuxBackend({ dataDir: directory, version: "test" });
    const key = sessionKey("program-adopt");
    const handle = await first.create({
      sessionKey: key,
      workspaceId: "program-adopt-workspace",
      generation: 1,
      cwd: directory,
      shell: "/bin/sh",
      args: [],
      env: [],
      size: { cols: 80, rows: 24 },
    });
    await first.detachAll();
    const second = new TmuxBackend({ dataDir: directory, version: "test" });
    const seen: Buffer[] = [];
    second.programTap.subscribe((_key, _generation, chunk) => seen.push(chunk));
    await second.adopt(key, handle.backendRef!, 1);
    execFileSync(
      "tmux",
      [
        "-S",
        second.socket,
        "send-keys",
        "-t",
        handle.backendRef!,
        "printf '\\033]7501;state=done\\007'",
        "Enter",
      ],
      { env: { ...process.env, PATH: agentPath(process.env) } },
    );
    const text = () => Buffer.concat(seen).toString("latin1");
    for (
      let tries = 0;
      tries < 50 && !text().includes("state=done");
      tries += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(text()).toContain("\u001b]7501;state=done\u0007");
    await second.terminate(key, "session");
  }, 30_000);
});
