import {
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  statSync,
  constants,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  dirname,
  basename,
} from "node:path";

function inside(root, path) {
  const suffix = relative(root, path);
  return (
    suffix === "" ||
    (!suffix.startsWith(".." + sep) && suffix !== ".." && !isAbsolute(suffix))
  );
}
export function checkRealDirectories({
  dataDir,
  codexHome,
  productionHome,
  workspaceRoot,
} = {}) {
  if (!dataDir)
    throw new Error("An explicit isolated data directory is required");
  if (!codexHome || !productionHome)
    throw new Error("An explicit isolated Codex home is required");
  const data = realpathSync(dataDir),
    home = realpathSync(codexHome);
  let production;
  try {
    production = realpathSync(productionHome);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    production = resolve(productionHome);
  }
  if (inside(production, home) || inside(home, production))
    throw new Error("The Codex home overlaps production configuration");
  const temporary = realpathSync(tmpdir());
  if (data === temporary || !inside(temporary, data))
    throw new Error(
      "The data directory must be a dedicated temporary directory",
    );
  for (const name of ["config.toml", "hooks.json", "auth.json"]) {
    const path = join(home, name),
      stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && !inside(home, realpathSync(path)))
      throw new Error(`${name} resolves outside the isolated home`);
    if (stat && !stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`${name} is not a regular file`);
  }
  if (workspaceRoot) {
    const workspace = realpathSync(workspaceRoot);
    if (workspace === data || !inside(data, workspace))
      throw new Error(
        "The existing workspace must be inside the isolated data directory",
      );
  }
  return { dataDir: data, codexHome: home };
}
export function realVersion(agent, text) {
  if (/fixture|fake|deterministic/i.test(text)) return null;
  const match =
    agent === "codex"
      ? /\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(text)
      : agent === "claude" && /Claude Code/i.test(text)
        ? /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(text)
        : null;
  return match?.[1] ?? null;
}
export function scenarioFiles() {
  return {
    "src/slug.mjs":
      'export function slug() { throw new Error("Not implemented"); }\n',
    "test/slug.test.mjs": `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {slug} from '../src/slug.mjs';
const cases=[['Mixed CASE','mixed-case'],['  Hello world  ','hello-world'],['a---b','a-b'],['a_b+c','a-b-c'],['中文 test','test'],['42 cats','42-cats'],['',''],['!!!',''],[' one\\ttwo\\nthree ','one-two-three']];
for(const [input, expected] of cases) test(JSON.stringify(input),()=>assert.equal(slug(input),expected));
`,
  };
}
export function verifyRealReports({
  change,
  review,
  testsUnchanged,
  testExitCode,
}) {
  if (
    typeof change !== "string" ||
    change.trim().length < 20 ||
    /deterministic fixture/i.test(change)
  )
    throw new Error("Missing real implementation change report");
  if (!testsUnchanged)
    throw new Error("The immutable quality test file was modified");
  if (testExitCode !== 0)
    throw new Error("Implementation quality tests failed");
  const result = JSON.parse(review);
  if (
    result.verdict !== "pass" ||
    !Array.isArray(result.issues) ||
    result.issues.length !== 0 ||
    !Array.isArray(result.reviewedFiles) ||
    !["src/slug.mjs", "test/slug.test.mjs", "reports/change.md"].every((file) =>
      result.reviewedFiles?.includes(file),
    )
  )
    throw new Error("The real review did not pass or omitted required files");
  return result;
}

/** Uses native parsed config layers. Unknown/untrusted project state is refused. */
export function trustedProject(configRead, cwd) {
  const canonicalPath = (path) => {
    const absolute = resolve(path);
    try {
      return realpathSync(absolute);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(absolute);
      return parent === absolute
        ? absolute
        : join(canonicalPath(parent), basename(absolute));
    }
  };
  cwd = canonicalPath(cwd);
  const candidates = new Map();
  for (const layer of configRead.layers ?? []) {
    if (layer.disabledReason) continue;
    if (layer.name && !["user", "system", "managed"].includes(layer.name.type))
      continue;
    for (const [path, project] of Object.entries(
      layer.config?.projects ?? {},
    )) {
      const canonical = canonicalPath(path);
      const previous = candidates.get(canonical);
      candidates.set(
        canonical,
        previous && previous !== project.trust_level
          ? "unknown"
          : project.trust_level,
      );
    }
  }
  const matching = [...candidates]
    .filter(([path]) => inside(path, cwd))
    .sort(([a], [b]) => b.length - a.length);
  return matching[0]?.[1] === "trusted";
}

export function parseRealOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (["--execute", "--preflight"].includes(name))
      options[name.slice(2)] = true;
    else if (
      [
        "--data-dir",
        "--codex-home",
        "--workspace",
        "--board",
        "--plugin-root",
      ].includes(name)
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--"))
        throw new Error("Missing real-acceptance option value");
      options[name.slice(2)] = value;
    } else throw new Error("Unknown real-acceptance option");
  }
  if (options.execute && options.preflight)
    throw new Error("Preflight and execute modes are mutually exclusive");
  return options;
}

/** Bounded descriptor read of exactly the version that core checked. */
export function readRealArtifact(root, reference) {
  if (
    reference.type !== "file" ||
    !reference.exists ||
    reference.versionKind !== "contentHash" ||
    reference.size > 65536
  )
    throw new Error("Report reference must be a small hashed file");
  const base = realpathSync(root),
    path = realpathSync(join(base, reference.path));
  if (!inside(base, path))
    throw new Error("Report path resolves outside the workspace");
  const initial = statSync(path);
  if (!initial.isFile() || initial.size > 65536)
    throw new Error("Report reference is not a small regular file");
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size > 65536
    )
      throw new Error("Report reference changed before reading");
    const buffer = Buffer.alloc(opened.size + 1),
      bytes = readSync(descriptor, buffer, 0, buffer.length, 0),
      after = fstatSync(descriptor);
    const contents = buffer.subarray(0, bytes);
    if (
      bytes !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      "sha256:" + createHash("sha256").update(contents).digest("hex") !==
        reference.contentVersion
    )
      throw new Error("Report reference changed while reading");
    return contents.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}
