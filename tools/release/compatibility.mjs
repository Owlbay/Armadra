/**
 * The compatibility range a release declares, and the fence it is published in.
 *
 * A GitHub release has nowhere structured to put "which installed versions can
 * move to this one", so it is read out of a fenced JSON block in the release
 * note. A release without the fence is refused rather than assumed compatible
 * (design §1.4): an upgrade whose migration path nobody stated is a data
 * hazard, and silence is not a promise.
 *
 * `compatibility.json` is the only place the range is written, and
 * `version.mjs check` asserts its minimum against the version being released,
 * so the fence in a release note can never disagree with the code that release
 * contains. It carries versions only: there is no cross-process protocol left
 * to declare a major for.
 *
 * One more key lives in the file and never in the fence: `agent`, the pinned
 * `@armadra/agent` the build bundles and the host API its adapter speaks
 * (docs/design/coordinator-agent.md §2.6). `version.mjs check` holds it
 * against the desktop manifest and the lockfile.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The fence marker the release note carries. */
export const FENCE = "armadra-compatibility";

export const COMPATIBILITY_FILE = fileURLToPath(
  new URL("./compatibility.json", import.meta.url),
);

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse a dotted version into something that can be ordered. */
export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? "").trim());
  if (!match) throw new Error(`not a version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
    text: match[0],
  };
}

/**
 * Order two versions the way the updater does: a pre-release sorts below the
 * final release of the same numbers, and pre-release suffixes compare as text.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Keys compatibility.json carries beside the fence. They describe what this
 * release was verified against, not which installs may move to it, so they
 * never enter the release note's fence — which stays strict.
 */
const SIDE_KEYS = ["acp", "agent", "platform", "mobile"];

function readDocument(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Read and validate compatibility.json's fence half. */
export function readCompatibility(path = COMPATIBILITY_FILE) {
  const document = readDocument(path);
  const fence = { ...document };
  for (const key of SIDE_KEYS) {
    if (key in fence) normalizeSide(key, fence[key]);
    delete fence[key];
  }
  return normalize(fence);
}

/**
 * The `acp` key: the ACP protocol version and, per adapter, its program and
 * the version range a real run verified (`null` until one has —
 * docs/design/acp-session-view.md §12). The program names must match
 * `apps/desktop/src/core/acp/adapters.ts`; that test reads this file.
 */
export function readAcpCompatibility(path = COMPATIBILITY_FILE) {
  return normalizeAcp(readDocument(path).acp);
}

function normalizeSide(key, value) {
  if (key === "acp") return normalizeAcp(value);
  if (key === "agent") return normalizeAgentPin(value);
  if (key === "platform") return normalizePlatformPin(value);
  if (key === "mobile") return normalizeMobile(value);
  throw new Error(`unknown compatibility key: ${key}`);
}

export function normalizeAcp(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("acp must be an object");
  if (value.protocolVersion !== 1)
    throw new Error("acp.protocolVersion must be 1");
  const adapters = value.adapters;
  if (adapters === null || typeof adapters !== "object")
    throw new Error("acp.adapters must be an object");
  const result = {};
  for (const [id, entry] of Object.entries(adapters)) {
    if (typeof entry?.program !== "string" || entry.program === "")
      throw new Error(`acp.adapters.${id}.program must be a program name`);
    const verified = entry.verified;
    if (verified === null) {
      result[id] = { program: entry.program, verified: null };
      continue;
    }
    if (typeof verified !== "object")
      throw new Error(`acp.adapters.${id}.verified must be null or a range`);
    const min = parseVersion(verified.min).text;
    const max =
      verified.max === undefined ? undefined : parseVersion(verified.max).text;
    if (max && compareVersions(min, max) > 0)
      throw new Error(`acp.adapters.${id}.verified.min is above max`);
    result[id] = {
      program: entry.program,
      verified: max ? { min, max } : { min },
    };
  }
  return { protocolVersion: 1, adapters: result };
}

/** The package the `agent` key may name. */
export const AGENT_PACKAGE = "@armadra/agent";

/**
 * The `agent` key: `{ package, version, hostApi }`. The version is exact — an
 * upgrade is one explicit change in this file, the desktop manifest and the
 * lockfile together.
 */
export function readAgentPin(path = COMPATIBILITY_FILE) {
  return normalizeAgentPin(readDocument(path).agent);
}

export function normalizeAgentPin(agent) {
  if (agent === null || typeof agent !== "object" || Array.isArray(agent))
    throw new Error("compatibility.json has no agent pin");
  for (const key of Object.keys(agent)) {
    if (!["package", "version", "hostApi"].includes(key))
      throw new Error(`unknown agent pin key: ${key}`);
  }
  if (agent.package !== AGENT_PACKAGE)
    throw new Error(`agent.package must be ${AGENT_PACKAGE}`);
  const version = parseVersion(agent.version).text;
  if (version !== agent.version)
    throw new Error(`agent.version must be an exact version: ${agent.version}`);
  if (!Number.isSafeInteger(agent.hostApi) || agent.hostApi < 1)
    throw new Error("agent.hostApi must be a positive integer");
  return { package: AGENT_PACKAGE, version, hostApi: agent.hostApi };
}

/** The package the `platform` key may name. */
export const PLATFORM_PACKAGE = "@armadra/platform-protocol";

/**
 * The `platform` key (docs/design/platform/dev-stack-and-verification.md
 * §1.3): the protocol package's exact version and wire protocol, the vendored
 * tarball it is installed from with that file's sha256, and the two image
 * tags, which must equal the version. Like `agent` it never enters the fence:
 * installed clients parse the fence strictly.
 */
export function readPlatformPin(path = COMPATIBILITY_FILE) {
  return normalizePlatformPin(readDocument(path).platform);
}

export function normalizePlatformPin(platform) {
  const fail = (message) => {
    throw new Error(message);
  };
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform)
  )
    fail("compatibility.json has no platform pin");
  for (const key of Object.keys(platform)) {
    if (!["package", "version", "protocol", "tarball", "images"].includes(key))
      fail(`unknown platform pin key: ${key}`);
  }
  if (platform.package !== PLATFORM_PACKAGE)
    fail(`platform.package must be ${PLATFORM_PACKAGE}`);
  const version = parseVersion(platform.version).text;
  if (version !== platform.version)
    fail(`platform.version must be an exact version: ${platform.version}`);
  const { major, minor } = platform.protocol ?? {};
  for (const n of [major, minor]) {
    if (!Number.isSafeInteger(n) || n < 0)
      fail("platform.protocol needs integer major and minor");
  }
  const { file, sha256 } = platform.tarball ?? {};
  if (typeof file !== "string" || !/^[\w.-]+\.tgz$/.test(file))
    fail("platform.tarball.file must be a file name under tools/vendor");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
    fail("platform.tarball.sha256 must be 64 lowercase hex digits");
  const images = platform.images ?? {};
  for (const [name, repo] of [
    ["cloud", "ghcr.io/owlbay/armadra-cloud"],
    ["relay", "ghcr.io/owlbay/armadra-relay"],
  ]) {
    if (images[name] !== `${repo}:${version}`)
      fail(`platform.images.${name} must be ${repo}:${version}`);
  }
  return {
    package: PLATFORM_PACKAGE,
    version,
    protocol: { major, minor },
    tarball: { file, sha256 },
    images: { cloud: images.cloud, relay: images.relay },
  };
}

/**
 * The `mobile` key: what the phone / tablet app needs from the host it talks
 * to. The app has its own version line (`apps/mobile/package.json`), so its
 * compatibility with a desktop or server core is decided by protocol, never by
 * the two version numbers being equal. `minimumHostProtocol` is the oldest
 * core protocol the bundled page works against; the page's copy is
 * `apps/web/src/mobile/host-compatibility.ts`, and `version.mjs mobile check`
 * keeps the two and the core's own protocol in step. Not part of the fence.
 */
export function readMobileCompatibility(path = COMPATIBILITY_FILE) {
  return normalizeMobile(readDocument(path).mobile);
}

export function normalizeMobile(mobile) {
  const fail = (message) => {
    throw new Error(message);
  };
  if (mobile === null || typeof mobile !== "object" || Array.isArray(mobile))
    fail("compatibility.json has no mobile entry");
  for (const key of Object.keys(mobile)) {
    if (key !== "minimumHostProtocol") fail(`unknown mobile key: ${key}`);
  }
  const protocol = mobile.minimumHostProtocol ?? {};
  for (const key of Object.keys(protocol)) {
    if (key !== "major" && key !== "minor")
      fail(`unknown mobile.minimumHostProtocol key: ${key}`);
  }
  const { major, minor } = protocol;
  if (!Number.isSafeInteger(major) || major < 1)
    fail("mobile.minimumHostProtocol.major must be an integer from 1");
  if (!Number.isSafeInteger(minor) || minor < 0)
    fail("mobile.minimumHostProtocol.minor must be a non-negative integer");
  return { minimumHostProtocol: { major, minor } };
}

/**
 * Validate a compatibility document. Unknown keys are refused: the fence is
 * parsed strictly on the reading side, so a key it would reject must fail here
 * rather than at the moment a client tries to update.
 */
export function normalize(document) {
  const allowed = new Set(["$comment", "minimumInstalled", "maximumInstalled"]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) throw new Error(`unknown compatibility key: ${key}`);
  }
  const minimum = parseVersion(document.minimumInstalled).text;
  const maximum =
    document.maximumInstalled === undefined || document.maximumInstalled === ""
      ? undefined
      : parseVersion(document.maximumInstalled).text;
  if (maximum && compareVersions(minimum, maximum) > 0)
    throw new Error("minimumInstalled is above maximumInstalled");
  const result = { minimumInstalled: minimum };
  if (maximum) result.maximumInstalled = maximum;
  return result;
}

/**
 * The fenced block appended to a release note. Key order is fixed so two runs
 * of the same release produce the same note, and the JSON is one line so a
 * reader can see at a glance that nothing else is hidden in the fence.
 */
export function renderFence(compatibility) {
  const value = normalize(compatibility);
  const ordered = {
    minimumInstalled: value.minimumInstalled,
    ...(value.maximumInstalled
      ? { maximumInstalled: value.maximumInstalled }
      : {}),
  };
  return "```" + FENCE + "\n" + JSON.stringify(ordered) + "\n```";
}

/** Read the fence back out of a release note. */
export function extractFence(note) {
  const marker = "```" + FENCE;
  const start = String(note ?? "").indexOf(marker);
  if (start < 0) return null;
  const rest = note.slice(start + marker.length);
  const end = rest.indexOf("```");
  return normalize(JSON.parse(end < 0 ? rest : rest.slice(0, end)));
}

/**
 * The release note body: the changelog section for this version, then the
 * fence. Everything outside the fence is for people; nothing parses it.
 */
export function releaseNote({
  version,
  notes,
  compatibility,
  unnotarized = [],
}) {
  const parts = [];
  if (unnotarized.length > 0) {
    // Missing notarisation does not block a release, but it changes what a
    // first install looks like, so it is stated where nobody can miss it.
    parts.push(
      `> Not notarised/signed for: ${unnotarized.join(", ")}. The operating system will warn on first install.`,
    );
  }
  parts.push(String(notes ?? "").trim() || `Armadra ${version}.`);
  parts.push(renderFence(compatibility));
  return parts.join("\n\n") + "\n";
}
