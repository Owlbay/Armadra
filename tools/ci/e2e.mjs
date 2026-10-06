/**
 * End-to-end tiers.
 *
 *   node tools/ci/e2e.mjs --tier a [--only id,id] [--out dir] [--list]
 *
 * Runs every probe in tools/ci/e2e.d/ that belongs to the tier, one after
 * another, and writes <out>/result.json with one record per entry. Any failure
 * makes the exit code non-zero; the remaining entries still run, because one
 * broken probe should not hide what the others would have said.
 *
 * The probes build nothing themselves. The caller builds first:
 *
 *   pnpm libs:build
 *   pnpm --filter @armadra/web build
 *   pnpm --filter @armadra/desktop build
 *   pnpm --filter @armadra/server build
 *   pnpm --filter @armadra/push-relay build
 *
 * The manifest is one file per entry, tools/ci/e2e.d/<id>.json, so packages
 * that add a probe add a file instead of all editing the end of one list. The
 * run order is fixed by the loader: tier by tier, then by id.
 *
 * An entry with `platforms` only runs on those `process.platform` values and is
 * recorded as skipped elsewhere: tier B runs once per operating system in
 * nightly.yml, and a packaged-app probe for one system has nothing to test on
 * another.
 *
 * An entry that `requires` "cloud" needs a local checkout of the private
 * armadra-cloud repository (ARMADRA_DEV_STACK_CLOUD_SRC, or ../armadra-cloud).
 * CI cannot clone it, so without one the entry is recorded as skipped with the
 * reason, not failed; with one the path is handed to the probe in
 * ARMADRA_DEV_STACK_CLOUD_SRC.
 *
 * Tier A needs tmux and a Chrome / Chromium (CHROME_PATH, or the usual install
 * locations). Entries marked `devStack` only run when ARMADRA_DEV_STACK=1 and
 * Docker answers; otherwise they are recorded as skipped, not failed.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findCloudSource } from "../probes/cloud-source.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const MANIFEST_DIR = join(ROOT, "tools/ci/e2e.d");
/** The single-file manifest this directory replaced; it must not come back. */
export const LEGACY_MANIFEST = join(ROOT, "tools/ci/e2e.json");
export const TIERS = ["a", "b"];
export const REQUIREMENTS = ["tmux", "chrome", "docker", "cloud"];
/** `process.platform` values an entry may restrict itself to. */
export const PLATFORMS = ["darwin", "linux", "win32"];

/**
 * Read tools/ci/e2e.d/*.json into `{ entries, problems }`. Each entry keeps the
 * name of its file in `file` so the validator can hold id and file name
 * together. Entries come back tier by tier (a, then b), then sorted by id, so
 * the run order never depends on the order files were added in.
 */
export function loadManifest(
  directory = MANIFEST_DIR,
  legacy = LEGACY_MANIFEST,
) {
  const problems = [];
  if (legacy && existsSync(legacy))
    problems.push(
      "tools/ci/e2e.json is back; move its entries to tools/ci/e2e.d/<id>.json and delete it",
    );
  const entries = [];
  for (const file of readdirSync(directory).sort()) {
    // Hidden files are the file system's, not entries (.DS_Store, ._x.json).
    if (file.startsWith(".")) continue;
    if (!file.endsWith(".json")) {
      problems.push(`${file} is not a .json entry`);
      continue;
    }
    try {
      entries.push({
        ...JSON.parse(readFileSync(join(directory, file), "utf8")),
        file,
      });
    } catch (error) {
      problems.push(`${file} is not valid JSON: ${error.message}`);
    }
  }
  return { entries: sortEntries(entries), problems };
}

/** Tier order first, then id; entries without a usable tier or id sort last. */
export function sortEntries(entries) {
  const rank = (entry) => {
    const index = TIERS.indexOf(entry?.tier);
    return index < 0 ? TIERS.length : index;
  };
  return [...entries].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      String(left?.id ?? "").localeCompare(String(right?.id ?? ""), "en"),
  );
}

/** Structural problems with a manifest, as plain sentences. */
export function validateManifest(manifest, root = ROOT) {
  const problems = [...(manifest?.problems ?? [])];
  const entries = manifest?.entries;
  if (!Array.isArray(entries)) return ["manifest has no entries list"];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const where = `entry ${index + 1}${entry?.id ? ` (${entry.id})` : ""}`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id))
      problems.push(`${where} has no kebab-case id`);
    else if (seen.has(entry.id)) problems.push(`${where} repeats its id`);
    else seen.add(entry.id);
    if (entry.file !== undefined && entry.file !== `${entry.id}.json`)
      problems.push(`${where} lives in ${entry.file}, not <id>.json`);
    if (!TIERS.includes(entry.tier))
      problems.push(
        `${where} has tier ${entry.tier}, not one of ${TIERS.join(", ")}`,
      );
    if (typeof entry.script !== "string" || entry.script === "")
      problems.push(`${where} names no script`);
    else if (!existsSync(join(root, entry.script)))
      problems.push(`${where} runs ${entry.script}, which does not exist`);
    if (
      entry.args !== undefined &&
      (!Array.isArray(entry.args) ||
        entry.args.some((arg) => typeof arg !== "string"))
    )
      problems.push(`${where} has args that are not a list of strings`);
    for (const need of entry.requires ?? [])
      if (!REQUIREMENTS.includes(need))
        problems.push(
          `${where} requires ${need}, which the runner cannot check`,
        );
    if (!(typeof entry.timeoutMinutes === "number" && entry.timeoutMinutes > 0))
      problems.push(`${where} has no positive timeoutMinutes`);
    if (entry.devStack !== undefined && typeof entry.devStack !== "boolean")
      problems.push(`${where} has a devStack that is not a boolean`);
    if (
      entry.platforms !== undefined &&
      !(
        Array.isArray(entry.platforms) &&
        entry.platforms.length > 0 &&
        entry.platforms.every((name) => PLATFORMS.includes(name))
      )
    )
      problems.push(
        `${where} has platforms that are not a non-empty list of ${PLATFORMS.join(", ")}`,
      );
  }
  return problems;
}

/** The Chrome to hand the probes: CHROME_PATH, or the first usual location. */
export function findChrome(env = process.env, platform = process.platform) {
  if (env.CHROME_PATH)
    return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : platform === "win32"
        ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function hasTmux() {
  return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
}

function hasDocker() {
  return (
    spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 })
      .status === 0
  );
}

/** Kill a probe and everything it started (Chrome, core, Vite, tmux clients). */
function killTree(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function runEntry(entry, { root, out, env, log }) {
  const directory = join(out, entry.id);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "output.log");
  const sink = createWriteStream(logPath);
  const args = (entry.args ?? []).map((arg) =>
    arg.replaceAll("{out}", directory),
  );
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(root, entry.script), ...args], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const forward = (chunk) => {
      sink.write(chunk);
      log(chunk);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    let timedOut = false;
    const limit = entry.timeoutMinutes * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 10_000).unref();
    }, limit);
    child.on("error", (error) => forward(`${error.stack ?? error}\n`));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // The probe's own children (Chrome, core) may outlive a crash.
      killTree(child, "SIGKILL");
      sink.end();
      const passed = code === 0 && !timedOut;
      done({
        id: entry.id,
        status: passed ? "passed" : "failed",
        ...(timedOut
          ? { reason: `timed out after ${entry.timeoutMinutes} min` }
          : {}),
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        output: directory,
        log: logPath,
      });
    });
  });
}

/**
 * Run one tier. Returns the summary that is also written to <out>/result.json.
 * `probe` lets tests stand in for tmux / Chrome / Docker detection.
 */
export async function runTier({
  tier,
  manifest = loadManifest(),
  root = ROOT,
  out = join(root, "target/e2e", tier),
  only,
  env = process.env,
  platform = process.platform,
  probe = {
    tmux: hasTmux,
    chrome: () => findChrome(env),
    docker: hasDocker,
    cloud: () => findCloudSource(env, root),
  },
  devStack = {
    up: () => pnpm(root, ["dev-stack", "up"]),
    down: () => pnpm(root, ["dev-stack", "down"]),
  },
  log = (chunk) => process.stdout.write(chunk),
}) {
  if (!TIERS.includes(tier))
    throw new Error(`unknown tier ${tier}; use one of ${TIERS.join(", ")}`);
  const problems = validateManifest(manifest, root);
  if (problems.length > 0)
    throw new Error(`tools/ci/e2e.d:\n  ${problems.join("\n  ")}`);
  const selected = manifest.entries.filter(
    (entry) => entry.tier === tier && (!only || only.includes(entry.id)),
  );
  if (only) {
    const unknown = only.filter(
      (id) => !selected.some((entry) => entry.id === id),
    );
    if (unknown.length > 0)
      throw new Error(`not in tier ${tier}: ${unknown.join(", ")}`);
  }
  mkdirSync(out, { recursive: true });

  const runsHere = (entry) =>
    entry.platforms === undefined || entry.platforms.includes(platform);
  const needs = (what) =>
    selected.some((entry) => runsHere(entry) && entry.requires?.includes(what));
  const chrome = needs("chrome") ? probe.chrome() : null;
  const tmux = needs("tmux") ? probe.tmux() : false;
  const docker = needs("docker") ? probe.docker() : false;
  const cloud = needs("cloud") ? (probe.cloud?.() ?? null) : null;
  const childEnv = {
    ...env,
    ...(chrome ? { CHROME_PATH: chrome } : {}),
    ...(cloud ? { ARMADRA_DEV_STACK_CLOUD_SRC: cloud } : {}),
  };

  // The dev-stack is brought up once for the whole tier, and only when asked.
  let stack = { state: "off", reason: "ARMADRA_DEV_STACK is not 1" };
  if (selected.some((entry) => runsHere(entry) && entry.devStack)) {
    if (env.ARMADRA_DEV_STACK !== "1")
      stack = { state: "off", reason: "ARMADRA_DEV_STACK is not 1" };
    else if (!probe.docker())
      stack = { state: "off", reason: "Docker is not available" };
    else {
      log("== dev-stack up\n");
      const up = devStack.up();
      stack =
        up === 0
          ? { state: "up" }
          : { state: "failed", reason: `pnpm dev-stack up exited ${up}` };
    }
  }

  const summary = {
    tier,
    status: "passed",
    startedAt: new Date().toISOString(),
    platform: `${platform}-${process.arch}`,
    chrome,
    devStack: stack.state,
    entries: [],
  };
  try {
    for (const entry of selected) {
      log(`\n== ${entry.id}\n`);
      let record;
      const missing = (entry.requires ?? []).filter((need) =>
        need === "chrome"
          ? !chrome
          : need === "tmux"
            ? !tmux
            : need === "docker"
              ? !docker
              : false,
      );
      if (!runsHere(entry)) {
        record = {
          id: entry.id,
          status: "skipped",
          reason: `only on ${entry.platforms.join(", ")}`,
        };
      } else if (entry.devStack && stack.state !== "up") {
        record = {
          id: entry.id,
          status: stack.state === "failed" ? "failed" : "skipped",
          reason: `dev-stack: ${stack.reason}`,
        };
      } else if (entry.requires?.includes("cloud") && !cloud) {
        record = {
          id: entry.id,
          status: "skipped",
          reason:
            "needs a local armadra-cloud checkout (private repo; set ARMADRA_DEV_STACK_CLOUD_SRC)",
        };
      } else if (missing.length > 0) {
        record = {
          id: entry.id,
          status: "failed",
          reason: `missing ${missing.join(", ")}`,
        };
      } else {
        record = await runEntry(entry, { root, out, env: childEnv, log });
      }
      summary.entries.push(record);
      log(
        `== ${entry.id}: ${record.status}${record.reason ? ` (${record.reason})` : ""}\n`,
      );
      writeSummary(out, summary);
    }
  } finally {
    if (stack.state === "up") {
      log("== dev-stack down\n");
      devStack.down();
    }
  }
  summary.status = summary.entries.some((entry) => entry.status === "failed")
    ? "failed"
    : "passed";
  summary.finishedAt = new Date().toISOString();
  writeSummary(out, summary);
  return summary;
}

function writeSummary(out, summary) {
  writeFileSync(
    join(out, "result.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

function pnpm(root, args) {
  try {
    execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    return 0;
  } catch (error) {
    return typeof error.status === "number" ? error.status : 1;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--tier") options.tier = value();
    else if (arg.startsWith("--tier=")) options.tier = arg.slice(7);
    else if (arg === "--only")
      options.only = value().split(",").filter(Boolean);
    else if (arg.startsWith("--only="))
      options.only = arg.slice(7).split(",").filter(Boolean);
    else if (arg === "--out") options.out = resolve(value());
    else if (arg.startsWith("--out=")) options.out = resolve(arg.slice(6));
    else if (arg === "--list") options.list = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.tier)
    throw new Error(
      "usage: node tools/ci/e2e.mjs --tier a|b [--only id,id] [--out dir] [--list]",
    );
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.list) {
    const manifest = loadManifest();
    const problems = validateManifest(manifest);
    if (problems.length > 0) {
      console.error(`tools/ci/e2e.d:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    for (const entry of manifest.entries.filter(
      (item) => item.tier === options.tier,
    ))
      console.log(
        `${entry.id}${entry.devStack ? " (dev-stack)" : ""}${entry.platforms ? ` [${entry.platforms.join(", ")}]` : ""}  ${entry.script}`,
      );
    return 0;
  }
  const summary = await runTier(options);
  console.log(`\ne2e tier ${summary.tier}: ${summary.status}`);
  for (const entry of summary.entries)
    console.log(
      `  ${entry.status.padEnd(7)} ${entry.id}${entry.durationMs !== undefined ? `  ${Math.round(entry.durationMs / 1000)}s` : ""}${entry.reason ? `  ${entry.reason}` : ""}`,
    );
  console.log(
    `  report ${join(options.out ?? join(ROOT, "target/e2e", summary.tier), "result.json")}`,
  );
  // In a workflow the failing ids become a step output, so the job that opens
  // the nightly issue can name them without downloading the artifacts.
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `failed=${summary.entries
        .filter((entry) => entry.status === "failed")
        .map((entry) => entry.id)
        .join(",")}\n`,
    );
  return summary.status === "failed" ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
