/**
 * Turning the Host's answer plus the release manifest into one offer
 * (design §2.2), ported from the Rust shell this one replaced.
 *
 * The two checks are asked in that order on purpose. The Host is the only side
 * that understands release channels and the `armadra-compatibility` fence, so
 * it decides *whether* there is an update; the updater is the only side that
 * verifies a package signature, so it decides whether the bytes may be
 * installed. This module is the seam between them, and it refuses anything
 * that would let one answer be used to justify the other:
 *
 * - the manifest is only read from the same release the Host described, over
 *   the same origin, so an answer cannot redirect the updater elsewhere;
 * - the manifest's version has to be the version the Host offered;
 * - the bundle the manifest points at has to be an artifact the Host listed,
 *   because that artifact is where the sha256 comes from — a digest supplied
 *   by the same document as the bytes checks nothing;
 * - a manifest entry signed by a key this build does not carry is refused
 *   before anything is fetched.
 *
 * What changed with electron-updater, and what did not: the manifest may be
 * either this release pipeline's own `latest.json` (written by
 * `tools/release/updater-manifest.mjs`, minisign-signed) or electron-updater's
 * `latest*.yml`, and the minisign key-id comparison only has something to
 * compare when a minisign public key is configured — which a build whose trust
 * comes from the platform code signature does not have. Every other rule above
 * is unchanged, including the one that matters most: the digest comes from the
 * Host's artifact list or there is no offer.
 */

import { createHash } from "node:crypto";

import type { Offer, Reason } from "./machine";
import type { HostVerdict } from "./verdict";

/** A result that carries a stable reason token rather than a message. */
export type Resolved<T> =
  | { ok: true; value: T }
  | { ok: false; reason: Reason };

function fail<T>(reason: Reason): Resolved<T> {
  return { ok: false, reason };
}

function done<T>(value: T): Resolved<T> {
  return { ok: true, value };
}

/** One artifact as the Host reported it (`UpdateArtifact` of `updates.proto`). */
export interface HostArtifact {
  component: string;
  target: string;
  url: string;
  sizeBytes: number;
  /** Lowercase hex as published. Empty when the release said nothing. */
  sha256: string;
  signed: boolean;
}

/**
 * The parts of `CheckForUpdateResponse` the shell acts on. The page has
 * already refused an incoherent response before handing it over; this shape
 * still treats every field as untrusted, because "already validated" is how
 * validation stops happening.
 */
export interface HostAnswer {
  /** The offered release, "0.2.0" or "0.2.0-beta.1". */
  version: string;
  notesUrl: string;
  artifacts: HostArtifact[];
}

export function emptyAnswer(): HostAnswer {
  return { version: "", notesUrl: "", artifacts: [] };
}

/** Where a target's electron-updater feed is, and which bytes it is. */
export interface FeedRef {
  url: string;
  /** Lowercase hex, as `latest.json` published it. */
  sha256: string;
}

/** One platform entry of a manifest, whichever dialect it was written in. */
interface ManifestEntry {
  signature: string;
  url: string;
  /**
   * `latest.json` names the target's feed; `null` when the entry came from a
   * feed itself, or when a `latest.json` entry named none.
   */
  feed: FeedRef | null;
  dialect: "json" | "feed";
}

interface ParsedManifest {
  version: string;
  entries: ManifestEntry[];
}

/**
 * The largest manifest this shell will read. `latest.json` describes six
 * targets; anything approaching this is not a manifest.
 */
export const MANIFEST_LIMIT_BYTES = 64 * 1024;

/** Every target a release builds for (`tools/release/artifacts.mjs::TARGETS`). */
export const TARGETS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "linux-aarch64",
  "windows-x86_64",
  "windows-aarch64",
] as const;

/**
 * electron-updater 的通道名，下载前设给 `autoUpdater.channel`。与
 * `tools/release/artifacts.mjs::updaterChannel` 同一条规则：一次发布里六个目标
 * 共用一个目录，按目标起通道名，每个目标才有自己的那份清单。
 */
export function updaterChannel(target: string): string {
  return `latest-${target}`;
}

/**
 * 某目标的 electron-updater 清单在发布里的文件名——electron-updater 自己对
 * `updaterChannel(target)` 算出的名字（`<channel><平台后缀>.yml`）。与
 * `tools/release/artifacts.mjs::updaterFeedFile` 一致，`offer.test.ts` 拿钉住
 * 版本的 electron-updater 核对。
 */
export function feedName(target: string): string | null {
  const platform = platformKey(target);
  if (platform === null) return null;
  const [system, arch] = platform.split("-");
  const channel = updaterChannel(platform);
  if (system === "darwin") return `${channel}-mac.yml`;
  if (system === "windows") return `${channel}.yml`;
  return `${channel}-linux${arch === "x86_64" ? "" : "-arm64"}.yml`;
}

/**
 * The manifest file names a release publishes: this pipeline's own
 * `latest.json`, and each target's electron-updater feed. The list is closed on
 * purpose — the name is what tells `manifestUrl` which artifact in the Host's
 * list is the manifest — and it is the list a real release carries: the
 * packager's own `latest-mac.yml` / `latest.yml` are rewritten per target by
 * `tools/release/stage-desktop.mjs`, never published under those names.
 */
export const MANIFEST_NAMES: readonly string[] = [
  "latest.json",
  ...TARGETS.map((target) => feedName(target) as string),
];

/**
 * The updater's own spelling of a platform key, from a release target.
 * The two happen to agree today, and this function is where they would stop
 * agreeing rather than in three call sites.
 */
export function platformKey(target: string): string | null {
  const separator = target.indexOf("-");
  if (separator < 0) return null;
  const system = target.slice(0, separator);
  const arch = target.slice(separator + 1);
  if (system !== "darwin" && system !== "linux" && system !== "windows") {
    return null;
  }
  if (arch.length === 0) return null;
  return `${system}-${arch}`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The manifest of the release the Host described.
 *
 * It comes from the Host's own artifact list rather than from configuration,
 * so a beta release is read from the beta release's manifest instead of from
 * whatever address the bundle was built with (design §2.2).
 */
export function manifestUrl(
  answer: HostAnswer,
  allowInsecureLoopback: boolean,
  target?: string,
): Resolved<URL> {
  // Given a target, another target's feed is not a manifest for this one.
  const own = target === undefined ? null : feedName(target);
  const names =
    target === undefined
      ? MANIFEST_NAMES
      : ["latest.json", ...(own === null ? [] : [own])];
  // `latest.json` first: it is the signed one, and it names each feed by
  // digest. A release that only published feeds is still readable.
  const manifests = answer.artifacts.filter(
    (each) => each.component === "manifest",
  );
  let artifact: HostArtifact | undefined;
  for (const name of names) {
    artifact = manifests.find((each) => each.url.endsWith(`/${name}`));
    if (artifact) break;
  }
  if (!artifact) return fail("noArtifactForTarget");
  return releaseUrl(artifact.url, allowInsecureLoopback);
}

/**
 * A URL a release may be fetched from.
 *
 * HTTPS only, except on loopback where a test release server has no
 * certificate to offer and cannot be reached from another machine anyway. The
 * exception is a caller's explicit decision, never inferred from the URL.
 */
export function releaseUrl(
  value: string,
  allowInsecureLoopback: boolean,
): Resolved<URL> {
  const url = parseUrl(value);
  if (!url) return fail("sourceMalformed");
  if (url.protocol === "https:") return done(url);
  if (url.protocol === "http:" && allowInsecureLoopback && isLoopback(url)) {
    return done(url);
  }
  return fail("sourceMalformed");
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]"
  );
}

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

function portOrKnownDefault(url: URL): string {
  return url.port || (DEFAULT_PORTS[url.protocol] ?? "");
}

/**
 * Whether two URLs name files of the same release: same origin, and the same
 * directory. GitHub publishes a release's assets under one
 * `/releases/download/<tag>/` path, so a sibling is the strongest statement
 * available without asking the API a second time.
 */
export function sameRelease(a: URL, b: URL): boolean {
  if (
    a.protocol !== b.protocol ||
    a.hostname !== b.hostname ||
    portOrKnownDefault(a) !== portOrKnownDefault(b)
  ) {
    return false;
  }
  return directory(a) === directory(b);
}

export function directory(url: URL): string {
  const path = url.pathname;
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(0, index + 1);
}

/** Everything the shell knows before it fetches the manifest. */
export interface ManifestPointer {
  url: URL;
  version: string;
  platform: string;
}

/** The manifest to read and the version it has to agree with. */
export function pointer(
  answer: HostAnswer,
  target: string,
  allowInsecureLoopback: boolean,
): Resolved<ManifestPointer> {
  if (!validVersion(answer.version)) return fail("sourceMalformed");
  const platform = platformKey(target);
  if (platform === null) return fail("noArtifactForTarget");
  // A release that publishes nothing for this target is refused here rather
  // than after a fetch: there is no manifest entry that could rescue it.
  const listed = answer.artifacts.some(
    (artifact) =>
      artifact.component === "desktop" && artifact.target === target,
  );
  if (!listed) return fail("noArtifactForTarget");
  const url = manifestUrl(answer, allowInsecureLoopback, target);
  if (!url.ok) return url;
  return done({ url: url.value, version: answer.version, platform });
}

/**
 * Cross-checks the fetched manifest against the Host's answer and produces the
 * one offer both sides describe.
 *
 * `pubkey` is the configured minisign public key; when it names a key id, the
 * manifest entry has to be signed by that key. This is not the signature check
 * — the updater performs that over the downloaded bytes — it only refuses a
 * manifest that was signed by somebody else before any bytes are fetched. An
 * electron-updater build configures no minisign key, so the comparison is
 * skipped there and every other check still applies.
 */
export function resolve(
  answer: HostAnswer,
  target: ManifestPointer,
  manifestText: string,
  pubkey: string,
  allowInsecureLoopback: boolean,
): Resolved<Offer> {
  if (manifestText.length > MANIFEST_LIMIT_BYTES)
    return fail("sourceMalformed");
  const manifest = parseManifest(manifestText, target);
  if (!manifest.ok) return manifest;
  if (
    normalizeVersion(manifest.value.version) !==
    normalizeVersion(target.version)
  ) {
    return fail("sourceMalformed");
  }
  if (manifest.value.entries.length === 0) return fail("noArtifactForTarget");
  const expected = keyIdOfPublicKey(pubkey);
  let first: Resolved<Offer> | null = null;
  for (const entry of manifest.value.entries) {
    const attempt = fromEntry(
      answer,
      target,
      entry,
      expected,
      allowInsecureLoopback,
    );
    if (attempt.ok) return attempt;
    // A manifest that names one bundle reports that bundle's own failure.
    // A `latest*.yml` naming several reports the first, which is the one the
    // updater would have reached for.
    first ??= attempt;
  }
  return first ?? fail("noArtifactForTarget");
}

function fromEntry(
  answer: HostAnswer,
  target: ManifestPointer,
  entry: ManifestEntry,
  expected: string | null,
  allowInsecureLoopback: boolean,
): Resolved<Offer> {
  const packageUrl = releaseUrl(entry.url, allowInsecureLoopback);
  if (!packageUrl.ok) return packageUrl;
  if (!sameRelease(packageUrl.value, target.url))
    return fail("sourceMalformed");
  if (entry.dialect === "json") {
    const feed = checkFeedRef(
      answer,
      target,
      entry.feed,
      allowInsecureLoopback,
    );
    if (!feed.ok) return feed;
  }
  if (expected !== null) {
    const signedBy = keyIdOfSignature(entry.signature);
    if (signedBy === null || signedBy !== expected) {
      return fail("signatureMismatch");
    }
  }
  // The digest has to come from the Host's list, not from the manifest: a
  // digest published beside the bytes only proves the publisher can hash.
  const artifact = answer.artifacts.find(
    (each) => each.component === "desktop" && each.url === entry.url,
  );
  if (!artifact) return fail("sourceMalformed");
  if (!validDigest(artifact.sha256)) return fail("sourceMalformed");
  return done({
    version: normalizeVersion(target.version),
    target: artifact.target,
    manifestUrl: target.url.toString(),
    packageUrl: packageUrl.value.toString(),
    sha256: artifact.sha256.toLowerCase(),
    sizeBytes: artifact.sizeBytes,
    signed: entry.signature.trim().length > 0,
    notesUrl: httpsNotes(answer.notesUrl),
  });
}

/**
 * The feed `latest.json` names for this target has to be the one this target's
 * electron-updater will ask for, in the same release, and — when the Host
 * published a digest for it — the same bytes. Without a feed the download step
 * would 404 on a real release, so a `latest.json` entry without one is no offer.
 */
function checkFeedRef(
  answer: HostAnswer,
  target: ManifestPointer,
  feed: FeedRef | null,
  allowInsecureLoopback: boolean,
): Resolved<void> {
  if (feed === null) return fail("noArtifactForTarget");
  const url = releaseUrl(feed.url, allowInsecureLoopback);
  if (!url.ok) return url;
  if (!sameRelease(url.value, target.url)) return fail("sourceMalformed");
  const name = feedName(target.platform);
  if (name === null || !url.value.pathname.endsWith(`/${name}`)) {
    return fail("sourceMalformed");
  }
  if (!validDigest(feed.sha256)) return fail("sourceMalformed");
  const listed = answer.artifacts.find(
    (each) => each.component === "manifest" && each.url === feed.url,
  );
  if (!listed) return fail("noArtifactForTarget");
  if (
    validDigest(listed.sha256) &&
    listed.sha256.toLowerCase() !== feed.sha256.toLowerCase()
  ) {
    return fail("digestMismatch");
  }
  return done(undefined);
}

/* ----------------------------- the two dialects --------------------------- */

function parseManifest(
  text: string,
  target: ManifestPointer,
): Resolved<ParsedManifest> {
  return text.trimStart().startsWith("{")
    ? parseJsonManifest(text, target)
    : parseElectronManifest(text, target);
}

/** `latest.json`: one entry per platform key, minisign-signed. */
function parseJsonManifest(
  text: string,
  target: ManifestPointer,
): Resolved<ParsedManifest> {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return fail("sourceMalformed");
  }
  if (typeof document !== "object" || document === null) {
    return fail("sourceMalformed");
  }
  const record = document as Record<string, unknown>;
  const platforms = record.platforms;
  const version = typeof record.version === "string" ? record.version : "";
  if (typeof platforms !== "object" || platforms === null) {
    return done({ version, entries: [] });
  }
  const entry = (platforms as Record<string, unknown>)[target.platform];
  if (typeof entry !== "object" || entry === null) {
    return done({ version, entries: [] });
  }
  const shape = entry as Record<string, unknown>;
  return done({
    version,
    entries: [
      {
        signature: typeof shape.signature === "string" ? shape.signature : "",
        url: typeof shape.url === "string" ? shape.url : "",
        feed: readFeedRef(shape.feed),
        dialect: "json",
      },
    ],
  });
}

function readFeedRef(value: unknown): FeedRef | null {
  if (typeof value !== "object" || value === null) return null;
  const shape = value as Record<string, unknown>;
  if (typeof shape.url !== "string" || typeof shape.sha256 !== "string") {
    return null;
  }
  return { url: shape.url, sha256: shape.sha256 };
}

/**
 * electron-updater's `latest*.yml`. Only the two fields that decide anything
 * are read — the version, and the file names, which are relative to the
 * manifest's own directory. Everything that makes the bytes trustworthy comes
 * from elsewhere: the platform code signature the updater verifies, and the
 * sha256 the Host published.
 *
 * Hand-parsed rather than pulled from a YAML library because the document is
 * generated by electron-builder and has exactly this shape; a parser that
 * accepts anchors, aliases and merge keys is a much larger thing to trust with
 * an untrusted document than six lines of string handling.
 */
function parseElectronManifest(
  text: string,
  target: ManifestPointer,
): Resolved<ParsedManifest> {
  let version = "";
  const urls: string[] = [];
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(raw);
    const line = raw.trim();
    if (!indented && !line.startsWith("-")) inFiles = false;
    const version_ = matchScalar(line, "version");
    if (!indented && version_ !== null) {
      version = version_;
      continue;
    }
    if (!indented && line === "files:") {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    const url = matchScalar(line.replace(/^-\s*/, ""), "url");
    if (url !== null) urls.push(url);
  }
  const base = target.url;
  return done({
    version,
    entries: urls.flatMap((url) => {
      const absolute = parseUrl(url) ?? absolutize(url, base);
      return absolute === null
        ? []
        : // No minisign signature exists in this dialect; the entry is unsigned
          // as far as the manifest is concerned, and `Offer.signed` says so.
          [
            {
              signature: "",
              url: absolute.toString(),
              feed: null,
              dialect: "feed" as const,
            },
          ];
    }),
  });
}

function absolutize(relative: string, base: URL): URL | null {
  try {
    return new URL(relative, base);
  } catch {
    return null;
  }
}

/** `key: value`, with the quotes electron-builder sometimes writes. */
function matchScalar(line: string, key: string): string | null {
  if (!line.startsWith(`${key}:`)) return null;
  const value = line.slice(key.length + 1).trim();
  if (value.length === 0) return null;
  const unquoted =
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
      ? value.slice(1, -1)
      : value;
  return unquoted.length > 0 ? unquoted : null;
}

/* --------------------------------- digests -------------------------------- */

/**
 * The digest check the shell performs itself after the transfer (design §2.2).
 * A mismatch discards the bytes even when the signature passed, because the
 * two statements are made by different parties about different things.
 *
 * It is the second, independent statement about the bytes: electron-updater
 * has already verified the platform signature, and this is the sha256 the
 * *Host* published for the same file (inventory §2 item 20).
 */
export function verifyDigest(
  bytes: Uint8Array,
  expectedHex: string,
): Resolved<void> {
  if (!validDigest(expectedHex)) return fail("sourceMalformed");
  return verifyDigestHex(sha256Hex(bytes), expectedHex);
}

/** The same check when the bytes were hashed while they streamed past. */
export function verifyDigestHex(
  actualHex: string,
  expectedHex: string,
): Resolved<void> {
  if (!validDigest(expectedHex)) return fail("sourceMalformed");
  return actualHex.toLowerCase() === expectedHex.toLowerCase()
    ? done(undefined)
    : fail("digestMismatch");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validDigest(value: string): boolean {
  return value.length === 64 && /^[0-9a-fA-F]{64}$/.test(value);
}

/* -------------------------------- versions -------------------------------- */

/** "0.2.0" or "0.2.0-beta.1"; a leading "v" is tolerated and dropped. */
export function validVersion(value: string): boolean {
  const normalized = normalizeVersion(value);
  const separator = normalized.indexOf("-");
  const core = separator < 0 ? normalized : normalized.slice(0, separator);
  const pre = separator < 0 ? null : normalized.slice(separator + 1);
  const parts = core.split(".");
  if (parts.length !== 3) return false;
  const numeric = parts.every(
    (part) =>
      part.length > 0 &&
      part.length <= 9 &&
      /^[0-9]+$/.test(part) &&
      (part.length === 1 || !part.startsWith("0")),
  );
  if (!numeric) return false;
  if (pre === null) return true;
  return pre.length > 0 && pre.length <= 64 && /^[0-9A-Za-z.-]+$/.test(pre);
}

export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v+/, "");
}

/** A release-notes link is shown to a person, so it is https or it is nothing. */
function httpsNotes(value: string): string {
  const url = parseUrl(value);
  return url && url.protocol === "https:" ? url.toString() : "";
}

/* -------------------------------- minisign -------------------------------- */

const KEY_ID_BYTES = 8;

/**
 * The key id inside a minisign public key. The cross-check it guards is the
 * right one for a release that publishes `latest.json`, which
 * `tools/release/assemble.mjs` still signs with this repository's own key.
 *
 * A base64-wrapped key file and a plain two-line one are both accepted, so a
 * hand-edited configuration fails loudly at the comparison rather than
 * silently skipping it.
 *
 * Returned as lowercase hex rather than bytes so `===` is the comparison.
 */
export function keyIdOfPublicKey(pubkey: string): string | null {
  const body = minisignBody(pubkey);
  // "Ed" + key id + 32-byte public key.
  return body === null ? null : idOf(body, 32);
}

/**
 * The key id inside a minisign detached signature, as carried by a manifest
 * entry. Both the raw signature file and a base64 wrapping of it are read,
 * because a release pipeline may write either.
 */
export function keyIdOfSignature(signature: string): string | null {
  const body = minisignBody(signature);
  // "Ed" + key id + 64-byte signature.
  return body === null ? null : idOf(body, 64);
}

/**
 * The key id of a minisign body of the expected shape. A body of the wrong
 * length is not a key with an odd tail; it is a different thing.
 */
function idOf(body: Buffer, payload: number): string | null {
  if (body.length !== 2 + KEY_ID_BYTES + payload) return null;
  const magic = body.subarray(0, 2).toString("latin1");
  if (magic !== "Ed" && magic !== "ED") return null;
  return body.subarray(2, 2 + KEY_ID_BYTES).toString("hex");
}

function minisignBody(value: string): Buffer | null {
  const text = decodedText(value);
  return text === null ? null : firstBase64Body(text);
}

/**
 * The value as text: either it already is a minisign file, or it is one
 * base64-encoded.
 */
function decodedText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("comment:")) return trimmed;
  const decoded = decodeBase64(trimmed);
  if (decoded === null) return null;
  const text = decoded.toString("utf8");
  // Node's base64 decoder is lenient where Rust's is strict; a round trip is
  // what tells a real encoding from a string that merely contains the
  // alphabet, and invalid UTF-8 is not a key file either.
  return Buffer.from(text, "utf8").equals(decoded) ? text : null;
}

/** The first line of a minisign file that is not a comment. */
function firstBase64Body(text: string): Buffer | null {
  for (const line of text.split(/\r?\n/).map((each) => each.trim())) {
    if (line.length === 0 || line.includes("comment:")) continue;
    const decoded = decodeBase64(line);
    if (decoded !== null) return decoded;
  }
  return null;
}

/** Strict base64: what Node accepted has to re-encode to what it was given. */
function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : null;
}

/* ------------------------- the feed, before transfer ----------------------- */

/** The feed `latest.json` names for a target. */
export function feedFor(
  manifestText: string,
  target: string,
): Resolved<FeedRef> {
  const platform = platformKey(target);
  if (platform === null) return fail("noArtifactForTarget");
  let document: unknown;
  try {
    document = JSON.parse(manifestText);
  } catch {
    return fail("sourceMalformed");
  }
  const platforms = (document as { platforms?: unknown } | null)?.platforms;
  const entry =
    typeof platforms === "object" && platforms !== null
      ? (platforms as Record<string, unknown>)[platform]
      : undefined;
  const feed = readFeedRef(
    typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>).feed
      : undefined,
  );
  return feed === null ? fail("noArtifactForTarget") : done(feed);
}

/**
 * The feed electron-updater is about to read, checked by the shell first: the
 * bytes `latest.json` named (when it named any), the version on offer, and the
 * one bundle the offer is about. electron-updater fetches the same file again a
 * moment later; over HTTPS from one release that window is accepted, and the
 * bundle's sha256 is still checked against the Host's digest afterwards.
 */
export function verifyFeed(
  feedText: string,
  expectedSha256: string | null,
  feedUrl: URL,
  pending: Offer,
): Resolved<void> {
  if (feedText.length > MANIFEST_LIMIT_BYTES) return fail("sourceMalformed");
  if (expectedSha256 !== null) {
    const actual = sha256Hex(Buffer.from(feedText, "utf8"));
    const verified = verifyDigestHex(actual, expectedSha256);
    if (!verified.ok) return verified;
  }
  const parsed = parseElectronManifest(feedText, {
    url: feedUrl,
    version: pending.version,
    platform: pending.target,
  });
  if (!parsed.ok) return parsed;
  if (normalizeVersion(parsed.value.version) !== pending.version) {
    return fail("sourceMalformed");
  }
  const first = parsed.value.entries[0];
  if (!first) return fail("noArtifactForTarget");
  return first.url === pending.packageUrl
    ? done(undefined)
    : fail("sourceMalformed");
}

/* --------------------------------- rollout -------------------------------- */

/** `latest.json`'s `rollout`, or `null` when the release goes to everyone. */
export interface Rollout {
  percent: number;
  seed: string;
}

export function readRollout(manifestText: string): Rollout | null {
  let document: unknown;
  try {
    document = JSON.parse(manifestText);
  } catch {
    return null;
  }
  const rollout = (document as { rollout?: unknown } | null)?.rollout;
  if (typeof rollout !== "object" || rollout === null) return null;
  const shape = rollout as Record<string, unknown>;
  const percent = shape.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return {
    percent: Math.min(100, Math.max(0, percent)),
    seed: typeof shape.seed === "string" ? shape.seed : "",
  };
}

/**
 * Whether this installation is inside a staged rollout (external services
 * §3.4). The hash of seed and install id is a number in [0, 100); it is the
 * same for one installation across checks of one release, and a new seed draws
 * the cohort again. No rollout means everyone.
 */
export function rolloutAccepts(
  rollout: Rollout | null,
  installId: string,
): boolean {
  if (rollout === null || rollout.percent >= 100) return true;
  if (rollout.percent <= 0) return false;
  const digest = createHash("sha256")
    .update(`${rollout.seed}\n${installId}`)
    .digest();
  const bucket = (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
  return bucket < rollout.percent;
}

/* ------------------------------ the channel ------------------------------- */

/** `updates.channel`. `beta` takes prereleases; anything else is `stable`. */
export type Channel = "stable" | "beta";

export function channelFrom(settings: Uint8Array | string): Channel {
  let document: unknown;
  try {
    document = JSON.parse(
      typeof settings === "string"
        ? settings
        : Buffer.from(settings).toString("utf8"),
    );
  } catch {
    return "stable";
  }
  const updates = (document as { updates?: unknown } | null)?.updates;
  const channel =
    typeof updates === "object" && updates !== null
      ? (updates as Record<string, unknown>).channel
      : undefined;
  return channel === "beta" ? "beta" : "stable";
}

/** What the channel means for which releases are considered. */
export function allowPrerelease(channel: Channel): boolean {
  return channel === "beta";
}

/** Whether `updates.autoCheck` is on; on unless it says otherwise. */
export function autoCheckFrom(settings: Uint8Array | string): boolean {
  try {
    const document = JSON.parse(
      typeof settings === "string"
        ? settings
        : Buffer.from(settings).toString("utf8"),
    ) as { updates?: { autoCheck?: unknown } } | null;
    const value = document?.updates?.autoCheck;
    return typeof value === "boolean" ? value : true;
  } catch {
    return true;
  }
}

/* ----------------------------- the release index --------------------------- */

/** Semver precedence, for the two versions `validVersion` accepts. */
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const normalized = normalizeVersion(value);
    const dash = normalized.indexOf("-");
    const core = (dash < 0 ? normalized : normalized.slice(0, dash))
      .split(".")
      .map(Number);
    const pre = dash < 0 ? [] : normalized.slice(dash + 1).split(".");
    return { core, pre };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index += 1) {
    const delta = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length
      ? 0
      : left.pre.length === 0
        ? 1
        : -1;
  }
  for (
    let index = 0;
    index < Math.max(left.pre.length, right.pre.length);
    index += 1
  ) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^[0-9]+$/.test(x) && /^[0-9]+$/.test(y);
    if (numeric && Number(x) !== Number(y))
      return Math.sign(Number(x) - Number(y));
    if (!numeric && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The component a published name declares (`artifacts.mjs::assetComponent`). */
export function assetComponent(name: string): string {
  if (name === "SHA256SUMS" || MANIFEST_NAMES.includes(name)) return "manifest";
  const separator = name.indexOf("_");
  if (separator < 0) return "";
  const prefix = name.slice(0, separator);
  if (prefix === "Armadra") return "desktop";
  if (prefix === "armadra-web") return "web";
  return "";
}

/** The target a published name declares (`artifacts.mjs::assetTarget`). */
export function assetTarget(name: string): string {
  const lower = name.toLowerCase();
  for (const system of ["darwin", "linux", "windows"]) {
    const index = lower.indexOf(`${system}-`);
    if (index < 0) continue;
    if (index > 0 && /[a-z0-9]/.test(lower[index - 1] ?? "")) continue;
    const match = /^[a-z0-9_]+/.exec(lower.slice(index + system.length + 1));
    if (!match) continue;
    return `${system}-${match[0]}`;
  }
  return "";
}

/** What the shell asks of the release index. */
export interface ReleaseQuery {
  channel: Channel;
  /** The version this shell runs. */
  currentVersion: string;
  target: string;
  checkedAtMs: number;
}

/**
 * The release index (GitHub's `GET /repos/{owner}/{repo}/releases`) read into
 * the verdict `check()` already understands: the newest published release on
 * this channel that is newer than what runs, with every asset as a Host
 * artifact. Drafts are never considered; prereleases only on `beta`.
 *
 * The digest of each asset comes from the index's `digest` field
 * ("sha256:<hex>"), which GitHub computes on upload — not from a file the
 * publisher wrote beside it.
 */
export function releaseVerdict(
  index: unknown,
  query: ReleaseQuery,
): HostVerdict {
  const base = {
    reasonCode: "",
    retryAfterMs: 0,
    checkedAtMs: query.checkedAtMs,
    target: query.target,
    answer: emptyAnswer(),
  };
  if (!Array.isArray(index)) {
    return { ...base, state: "unavailable", reasonCode: "SOURCE_MALFORMED" };
  }
  const prerelease = allowPrerelease(query.channel);
  let best: { version: string; release: Record<string, unknown> } | null = null;
  for (const entry of index) {
    if (typeof entry !== "object" || entry === null) continue;
    const release = entry as Record<string, unknown>;
    if (release.draft === true) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = normalizeVersion(tag);
    if (!validVersion(version)) continue;
    // A tag with "-" is a prerelease whatever the flag says (design §1.1).
    const isPrerelease = release.prerelease === true || version.includes("-");
    if (isPrerelease && !prerelease) continue;
    if (best === null || compareVersions(version, best.version) > 0) {
      best = { version, release };
    }
  }
  if (
    best === null ||
    !validVersion(query.currentVersion) ||
    compareVersions(best.version, query.currentVersion) <= 0
  ) {
    return { ...base, state: "upToDate" };
  }
  const assets = Array.isArray(best.release.assets) ? best.release.assets : [];
  const names = new Set(
    assets.map((asset) =>
      typeof (asset as { name?: unknown })?.name === "string"
        ? (asset as { name: string }).name
        : "",
    ),
  );
  const artifacts: HostArtifact[] = [];
  for (const asset of assets) {
    if (typeof asset !== "object" || asset === null) continue;
    const shape = asset as Record<string, unknown>;
    const name = typeof shape.name === "string" ? shape.name : "";
    if (name === "" || name.endsWith(".sig")) continue;
    const component = assetComponent(name);
    if (component === "") continue;
    const digest = typeof shape.digest === "string" ? shape.digest : "";
    artifacts.push({
      component,
      target: component === "desktop" ? assetTarget(name) : "",
      url:
        typeof shape.browser_download_url === "string"
          ? shape.browser_download_url
          : "",
      sizeBytes: typeof shape.size === "number" ? shape.size : 0,
      sha256: digest.startsWith("sha256:") ? digest.slice(7).toLowerCase() : "",
      signed: names.has(`${name}.sig`),
    });
  }
  return {
    ...base,
    state: "available",
    answer: {
      version: best.version,
      notesUrl:
        typeof best.release.html_url === "string" ? best.release.html_url : "",
      artifacts,
    },
  };
}

/* ------------------------------- the source ------------------------------- */

/**
 * The release index to ask, from what this build was configured with.
 *
 * An explicit source (`ARMADRA_UPDATER_SOURCE`, the GitHub-API-shaped
 * `…/repos/{owner}/{repo}` the dev-stack `release` service also serves) wins.
 * Otherwise a published build's updater endpoint
 * (`https://github.com/{owner}/{repo}/releases/…`, injected by the release
 * workflow) names the repository, and its API is asked. Anything else names no
 * index this shell knows how to read, and nothing is asked.
 */
export function releaseSourceFor(
  explicit: string,
  endpoints: readonly string[],
  allowInsecureLoopback: boolean,
): string | null {
  const trimmed = explicit.trim().replace(/\/+$/, "");
  if (trimmed.length > 0) {
    const url = releaseUrl(trimmed, allowInsecureLoopback);
    return url.ok ? trimmed : null;
  }
  for (const endpoint of endpoints) {
    const url = parseUrl(endpoint);
    if (url === null || url.protocol !== "https:") continue;
    if (url.hostname !== "github.com") continue;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) continue;
    return `https://api.github.com/repos/${owner}/${repo}`;
  }
  return null;
}

/** The release target of the running shell, from Node's own spelling. */
export function shellTarget(platform: string, arch: string): string | null {
  const system =
    platform === "darwin"
      ? "darwin"
      : platform === "win32"
        ? "windows"
        : platform === "linux"
          ? "linux"
          : null;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  return system === null || cpu === null ? null : `${system}-${cpu}`;
}
