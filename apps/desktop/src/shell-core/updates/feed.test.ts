/**
 * 发布出来的 electron-updater 清单，用钉住版本的 electron-updater 自己读一遍
 * （外部服务 §3.2：「yml 存在、名字改写正确、electron-updater 真能下载」）。
 *
 * 文件名规则是 electron-updater 的私有实现（`<channel><平台后缀>.yml`、macOS 按
 * URL 里有没有 "arm64" 挑包），所以这里不复述它，而是直接调它的
 * `GenericProvider` / `MacUpdater.filterFilesForArch`：升级 electron-updater 改了
 * 规则，这里先红。网络只到回环上的假发布服务，签名密钥本次现生成、用完即弃。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TARGETS,
  allowPrerelease,
  channelFrom,
  compareVersions,
  feedFor,
  feedName,
  pointer,
  readRollout,
  releaseSourceFor,
  releaseUrl,
  releaseVerdict,
  resolve,
  rolloutAccepts,
  shellTarget,
  updaterChannel,
  verifyFeed,
} from "./offer";

vi.mock("electron", () => ({ autoUpdater: {}, app: {} }));

/* ----------------------- the release tooling, untyped ---------------------- */

const TOOLS = new URL("../../../../../tools/release/", import.meta.url);

interface Tools {
  artifacts: { updaterFeedFile(target: string): string };
  dryRun: {
    stageAssets(options: { directory: string; version: string }): string[];
  };
  minisign: { generateKey(): unknown };
  sign: {
    signDirectory(options: {
      directory: string;
      key: unknown;
      version: string;
      onlyMissing?: boolean;
    }): string[];
  };
  manifest: {
    writeManifest(options: {
      directory: string;
      version: string;
      notes: string;
      targets: readonly string[];
      downloadUrl: (name: string) => string;
      rollout?: { percent: number; seed?: string };
    }): unknown;
  };
  checksums: { writeChecksums(directory: string): Promise<unknown> };
  server: {
    startMockReleaseServer(options: {
      releases: { directory: string; tag: string; body: string }[];
      port?: number;
    }): Promise<{
      base: string;
      source: string;
      notModified: number;
      close(): Promise<void>;
    }>;
  };
}

async function tools(): Promise<Tools> {
  const load = (name: string) =>
    import(/* @vite-ignore */ new URL(name, TOOLS).href);
  return {
    artifacts: await load("artifacts.mjs"),
    dryRun: await load("dry-run.mjs"),
    minisign: await load("minisign.mjs"),
    sign: await load("sign.mjs"),
    manifest: await load("updater-manifest.mjs"),
    checksums: await load("checksums.mjs"),
    server: await load("mock-release-server.mjs"),
  };
}

/* ------------------------- electron-updater, real ------------------------- */

type UpdaterModules = {
  GenericProvider: typeof import("electron-updater/out/providers/GenericProvider").GenericProvider;
  getChannelFilename: typeof import("electron-updater/out/util").getChannelFilename;
  MacUpdater: typeof import("electron-updater/out/MacUpdater").MacUpdater;
  findFile: typeof import("electron-updater/out/providers/Provider").findFile;
};

async function updaterModules(): Promise<UpdaterModules> {
  const generic = await import(
    "electron-updater/out/providers/GenericProvider"
  );
  const util = await import("electron-updater/out/util");
  const mac = await import("electron-updater/out/MacUpdater");
  const provider = await import("electron-updater/out/providers/Provider");
  return {
    GenericProvider: generic.GenericProvider,
    getChannelFilename: util.getChannelFilename,
    MacUpdater: mac.MacUpdater,
    findFile: provider.findFile,
  };
}

/** An executor that does what electron's net does, over `fetch`. */
const executor = {
  async request(options: {
    protocol?: string;
    hostname?: string;
    port?: string | number;
    path?: string;
  }): Promise<string> {
    const port = options.port ? `:${options.port}` : "";
    const url = `${options.protocol}//${options.hostname}${port}${options.path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  },
};

function nodePlatform(target: string): "darwin" | "linux" | "win32" {
  if (target.startsWith("darwin-")) return "darwin";
  if (target.startsWith("windows-")) return "win32";
  return "linux";
}

function providerFor(
  modules: UpdaterModules,
  target: string,
  url: string,
): InstanceType<UpdaterModules["GenericProvider"]> {
  return new modules.GenericProvider(
    { provider: "generic", url },
    // What the provider reads off the updater: the channel the shell sets.
    { channel: updaterChannel(target), isAddNoCacheQuery: false } as never,
    {
      platform: nodePlatform(target),
      executor: executor as never,
      isUseMultipleRangeRequest: false,
    },
  );
}

/** Linux's suffix comes from `process.arch`; the test names the arch instead. */
function withArch<T>(target: string, run: () => T): T {
  const previous = process.env.TEST_UPDATER_ARCH;
  process.env.TEST_UPDATER_ARCH = target.endsWith("-aarch64") ? "arm64" : "x64";
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TEST_UPDATER_ARCH;
    else process.env.TEST_UPDATER_ARCH = previous;
  }
}

/* ---------------------------------- names --------------------------------- */

describe("feed names", () => {
  it("are the names electron-updater itself asks for, and the ones the release publishes", async () => {
    const modules = await updaterModules();
    const { artifacts } = await tools();
    for (const target of TARGETS) {
      const asked = withArch(target, () =>
        modules.getChannelFilename(
          (
            providerFor(
              modules,
              target,
              "https://example.invalid/r/",
            ) as unknown as { channel: string }
          ).channel,
        ),
      );
      expect(asked, target).toBe(feedName(target));
      expect(artifacts.updaterFeedFile(target), target).toBe(feedName(target));
    }
    expect(new Set(TARGETS.map(feedName)).size).toBe(TARGETS.length);
  });

  it("the shell knows its own target", () => {
    expect(shellTarget("darwin", "arm64")).toBe("darwin-aarch64");
    expect(shellTarget("win32", "x64")).toBe("windows-x86_64");
    expect(shellTarget("linux", "arm64")).toBe("linux-aarch64");
    expect(shellTarget("freebsd", "x64")).toBeNull();
    expect(shellTarget("linux", "ia32")).toBeNull();
  });
});

/* ------------------------ check → manifest → verify ------------------------ */

describe("a served release, read the way the shell and electron-updater read it", () => {
  const VERSION = "0.2.0";
  let directory: string;
  let server: Awaited<ReturnType<Tools["server"]["startMockReleaseServer"]>>;

  beforeAll(async () => {
    const t = await tools();
    directory = mkdtempSync(join(tmpdir(), "armadra-feed-"));
    t.dryRun.stageAssets({ directory, version: VERSION });
    const key = t.minisign.generateKey();
    const probe = await t.server.startMockReleaseServer({ releases: [] });
    const port = Number(new URL(probe.base).port);
    await probe.close();
    t.sign.signDirectory({ directory, key, version: VERSION });
    t.manifest.writeManifest({
      directory,
      version: VERSION,
      notes: "",
      targets: TARGETS,
      downloadUrl: (name) =>
        `http://127.0.0.1:${port}/download/v${VERSION}/${encodeURIComponent(name)}`,
      rollout: { percent: 50 },
    });
    await t.checksums.writeChecksums(directory);
    t.sign.signDirectory({
      directory,
      key,
      version: VERSION,
      onlyMissing: true,
    });
    server = await t.server.startMockReleaseServer({
      releases: [{ directory, tag: `v${VERSION}`, body: "" }],
      port,
    });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function index(): Promise<unknown> {
    return (await fetch(`${server.source}/releases`)).json();
  }

  it("electron-updater finds each target's feed and downloads the bundle it names", async () => {
    const modules = await updaterModules();
    const base = `${server.base}/download/v${VERSION}/`;
    for (const target of TARGETS) {
      const provider = providerFor(modules, target, base);
      const info = await withArch(target, () => provider.getLatestVersion());
      expect(info.version, target).toBe(VERSION);
      let files = provider.resolveFiles(info);
      // Protected in the typings; it is the rule MacUpdater applies before it
      // picks a zip, and the one this release's names have to satisfy.
      const filterFilesForArch = (
        modules.MacUpdater as unknown as {
          filterFilesForArch(list: typeof files, arm: boolean): typeof files;
        }
      ).filterFilesForArch;
      if (target.startsWith("darwin-")) {
        // An arm64 Mac and an Intel one both keep the one file this target's
        // feed lists: there is nothing of the other architecture to prefer.
        for (const arm of [true, false]) {
          expect(
            filterFilesForArch(files, arm).length,
            `${target} arm64=${arm}`,
          ).toBe(1);
        }
        files = filterFilesForArch(files, true);
      }
      const extension = target.startsWith("darwin-")
        ? "zip"
        : target.startsWith("windows-")
          ? "exe"
          : "AppImage";
      const file = modules.findFile(files, extension);
      expect(file, target).toBeTruthy();
      const bytes = Buffer.from(
        await (await fetch(file!.url.toString())).arrayBuffer(),
      );
      expect(createHash("sha512").update(bytes).digest("base64"), target).toBe(
        file!.info.sha512,
      );
      expect(bytes.length, target).toBe(file!.info.size);
    }
  });

  it("the shell checks the index, resolves the offer and verifies the feed", async () => {
    const target = "linux-aarch64";
    const verdict = releaseVerdict(await index(), {
      channel: "stable",
      currentVersion: "0.1.0",
      target,
      checkedAtMs: 1,
    });
    expect(verdict.state).toBe("available");
    const at = pointer(verdict.answer, target, true);
    expect(at.ok).toBe(true);
    if (!at.ok) return;
    expect(at.value.url.pathname.endsWith("/latest.json")).toBe(true);
    const manifestText = await (await fetch(at.value.url)).text();
    const offer = resolve(verdict.answer, at.value, manifestText, "", true);
    expect(offer.ok).toBe(true);
    if (!offer.ok) return;
    expect(offer.value.packageUrl.endsWith(`_${target}.AppImage`)).toBe(true);
    expect(readRollout(manifestText)).toEqual({ percent: 50, seed: VERSION });

    const named = feedFor(manifestText, target);
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    const feedUrl = releaseUrl(named.value.url, true);
    expect(feedUrl.ok).toBe(true);
    if (!feedUrl.ok) return;
    const feedText = await (await fetch(feedUrl.value)).text();
    expect(
      verifyFeed(feedText, named.value.sha256, feedUrl.value, offer.value),
    ).toEqual({ ok: true, value: undefined });
    // A feed edited after `latest.json` named it is refused by digest…
    expect(
      verifyFeed(
        `${feedText}\n`,
        named.value.sha256,
        feedUrl.value,
        offer.value,
      ),
    ).toEqual({ ok: false, reason: "digestMismatch" });
    // …and one describing another bundle is refused even without a digest.
    expect(
      verifyFeed(
        feedText.replaceAll(`_${target}.AppImage`, "_linux-x86_64.AppImage"),
        null,
        feedUrl.value,
        offer.value,
      ),
    ).toEqual({ ok: false, reason: "sourceMalformed" });
  });

  it("a second check with the index's ETag costs a 304", async () => {
    const first = await fetch(`${server.source}/releases`);
    const etag = first.headers.get("etag");
    await first.arrayBuffer();
    expect(etag).toBeTruthy();
    const before = server.notModified;
    const again = await fetch(`${server.source}/releases`, {
      headers: { "if-none-match": etag! },
    });
    expect(again.status).toBe(304);
    expect(server.notModified).toBe(before + 1);
  });

  it("a latest.json entry naming another target's feed is no offer", async () => {
    const target = "darwin-aarch64";
    const verdict = releaseVerdict(await index(), {
      channel: "stable",
      currentVersion: "0.1.0",
      target,
      checkedAtMs: 1,
    });
    const at = pointer(verdict.answer, target, true);
    if (!at.ok) throw new Error(at.reason);
    const manifestText = await (await fetch(at.value.url)).text();
    const swapped = manifestText.replace(
      feedName("darwin-aarch64")!,
      feedName("darwin-x86_64")!,
    );
    expect(resolve(verdict.answer, at.value, swapped, "", true)).toEqual({
      ok: false,
      reason: "sourceMalformed",
    });
  });
});

/* ------------------------------ index & channel ---------------------------- */

describe("the release index", () => {
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://github.com/o/r/releases/download/t/${name}`,
    size: 10,
    digest: `sha256:${"a".repeat(64)}`,
  });
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-"),
    html_url: `https://github.com/o/r/releases/tag/${tag}`,
    assets: [
      asset("latest.json"),
      asset("latest.json.sig"),
      asset(`Armadra_${tag.slice(1)}_darwin-aarch64.zip`),
      asset(`Armadra_${tag.slice(1)}_darwin-aarch64.zip.sig`),
      asset(feedName("darwin-aarch64")!),
      asset("notes.txt"),
    ],
    ...extra,
  });
  const query = (channel: "stable" | "beta", currentVersion = "0.2.0") => ({
    channel,
    currentVersion,
    target: "darwin-aarch64",
    checkedAtMs: 5,
  });

  it("stable takes the newest published release and skips drafts and prereleases", () => {
    const index = [
      release("v0.4.0", { draft: true }),
      release("v0.3.1-beta.1"),
      release("v0.3.0"),
      release("v0.2.0"),
    ];
    const verdict = releaseVerdict(index, query("stable"));
    expect(verdict.state).toBe("available");
    expect(verdict.answer.version).toBe("0.3.0");
    expect(verdict.answer.notesUrl).toBe(
      "https://github.com/o/r/releases/tag/v0.3.0",
    );
    const byName = Object.fromEntries(
      verdict.answer.artifacts.map((a) => [a.url.split("/").pop(), a]),
    );
    expect(Object.keys(byName).sort()).toEqual(
      [
        "Armadra_0.3.0_darwin-aarch64.zip",
        "latest.json",
        feedName("darwin-aarch64")!,
      ].sort(),
    );
    expect(byName["Armadra_0.3.0_darwin-aarch64.zip"]).toMatchObject({
      component: "desktop",
      target: "darwin-aarch64",
      sha256: "a".repeat(64),
      signed: true,
    });
    expect(byName[feedName("darwin-aarch64")!]).toMatchObject({
      component: "manifest",
      signed: false,
    });
  });

  it("beta also takes prereleases, and the channel follows the setting", () => {
    const index = [release("v0.3.1-beta.1"), release("v0.3.0")];
    expect(releaseVerdict(index, query("beta")).answer.version).toBe(
      "0.3.1-beta.1",
    );
    expect(channelFrom('{"updates":{"channel":"beta"}}')).toBe("beta");
    expect(channelFrom('{"updates":{"channel":"nightly"}}')).toBe("stable");
    expect(channelFrom("not json")).toBe("stable");
    expect(allowPrerelease("beta")).toBe(true);
    expect(allowPrerelease("stable")).toBe(false);
  });

  it("nothing newer is up to date; an index that is not a list is no answer", () => {
    expect(
      releaseVerdict([release("v0.2.0")], query("stable", "0.2.0")).state,
    ).toBe("upToDate");
    expect(
      releaseVerdict({ message: "rate limited" }, query("stable")),
    ).toMatchObject({ state: "unavailable", reasonCode: "SOURCE_MALFORMED" });
  });

  it("orders versions by semver precedence", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("the source is explicit, or derived from a published build's GitHub endpoint", () => {
    expect(
      releaseSourceFor(
        "",
        [
          "https://github.com/AMA-Link/Armadra/releases/latest/download/latest.json",
        ],
        false,
      ),
    ).toBe("https://api.github.com/repos/AMA-Link/Armadra");
    expect(
      releaseSourceFor(
        "http://127.0.0.1:8090/repos/armadra/armadra/",
        [],
        true,
      ),
    ).toBe("http://127.0.0.1:8090/repos/armadra/armadra");
    // Plain HTTP only on loopback, and only when the caller allowed it.
    expect(
      releaseSourceFor("http://127.0.0.1:8090/repos/a/b", [], false),
    ).toBeNull();
    expect(
      releaseSourceFor("", ["https://armadra.dev/updates"], false),
    ).toBeNull();
  });
});

describe("the staged rollout", () => {
  it("takes about the share it names, the same way every time for one install", () => {
    const ids = Array.from({ length: 2000 }, (_, n) => `install-${n}`);
    const rollout = { percent: 25, seed: "0.3.0" };
    const taken = ids.filter((id) => rolloutAccepts(rollout, id)).length;
    expect(taken / ids.length).toBeGreaterThan(0.2);
    expect(taken / ids.length).toBeLessThan(0.3);
    for (const id of ids.slice(0, 50)) {
      expect(rolloutAccepts(rollout, id)).toBe(rolloutAccepts(rollout, id));
    }
    // A cohort only grows as the percentage does.
    const wider = { percent: 50, seed: "0.3.0" };
    for (const id of ids) {
      if (rolloutAccepts(rollout, id))
        expect(rolloutAccepts(wider, id)).toBe(true);
    }
  });

  it("no rollout is everyone; zero is nobody; a new seed draws again", () => {
    expect(rolloutAccepts(null, "x")).toBe(true);
    expect(rolloutAccepts({ percent: 100, seed: "s" }, "x")).toBe(true);
    expect(rolloutAccepts({ percent: 0, seed: "s" }, "x")).toBe(false);
    const ids = Array.from({ length: 200 }, (_, n) => `id-${n}`);
    const a = ids.filter((id) =>
      rolloutAccepts({ percent: 50, seed: "a" }, id),
    );
    const b = ids.filter((id) =>
      rolloutAccepts({ percent: 50, seed: "b" }, id),
    );
    expect(a).not.toEqual(b);
    expect(readRollout('{"rollout":{"percent":150,"seed":"s"}}')).toEqual({
      percent: 100,
      seed: "s",
    });
    expect(readRollout('{"version":"1.0.0"}')).toBeNull();
  });
});
