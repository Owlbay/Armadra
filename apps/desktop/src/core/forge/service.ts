/**
 * 托管平台域的服务：按远端地址识别平台、管每仓库（或每主机）的配置与令牌、
 * 给出对着这台机器配置的那个 {@link Forge}。
 *
 * 识别顺序（契约 §29.1；GitLab 的差异见 §29.6）：
 *
 *   1. `github.com`（含 `www.` / `ssh.`）→ GitHub；GitHub 凭据里配了企业版根时，
 *      那个根的主机 → GitHub。这两条不看配置表：GitHub 的凭据只在 §5 那一面配。
 *   2. 配置表里写到这个仓库的一行（`<host>/<owner>/<name>`）。
 *   3. 配置表里只写主机的一行（`<host>`）。
 *   4. 都没有：不认识。页面据此不显示「托管」区。
 *
 * 令牌只经 SecretStore（`armadra-forge-<id>`）；响应里只有「有没有令牌」。
 */

import { randomBytes } from "node:crypto";

import type { SecretBackend } from "../secrets/backend";
import {
  PUBLIC_API_BASE,
  apiHost,
  belongsTo,
  normalizeApiBase,
  parseRemote,
  validName,
} from "../github/remote";
import { GITHUB_SOURCE_NONE } from "../github/store";
import type { GithubService } from "../github/service";
import { githubError } from "../github/errors";
import { GithubRepositoryRefSchema } from "../github/schema";
import type { GithubRepositoryRef } from "../github/types";
import { create } from "../contract/message";
import { GiteaForge, giteaApiBase, giteaWebRoot } from "./gitea";
import { GithubForge } from "./github";
import { GitlabForge, gitlabApiBase, gitlabWebRoot } from "./gitlab";
import type { ForgeConfigRecord, ForgeStore } from "./store";
import { loopbackHost } from "./transport";
import {
  CONFIGURABLE_FORGES,
  type ConfigurableForge,
  type Forge,
  type ForgeKind,
  type ForgeRepo,
  forgeError,
} from "./types";

const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/;
const GITHUB_PUBLIC_HOSTS = ["github.com", "www.github.com", "ssh.github.com"];

export type DetectionSource = "github" | "config";

/** `GET /api/forge/repos/{host}/{owner}/{name}` 的答复（§29.2）。 */
export interface ForgeDetection {
  readonly repository: ForgeRepo;
  readonly forge: ForgeKind | null;
  readonly source: DetectionSource | null;
  /** 命中的配置行；GitHub 与不认识时 `null`。 */
  readonly configKey: string | null;
  readonly apiBase: string | null;
  readonly webUrl: string | null;
  /** 现在有没有能用的令牌（不花远端配额，只看存着没有）。 */
  readonly credential: boolean;
  readonly accountLogin: string | null;
}

/** `GET /api/forge/configs` 的一行（§29.3）。 */
export interface PublicForgeConfig {
  readonly repoKey: string;
  readonly forge: ForgeKind;
  readonly apiBase: string;
  readonly credential: boolean;
  readonly accountLogin: string | null;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ConfigureInput {
  readonly forge: string;
  readonly apiBase: string;
  /** 不给 = 保留现有令牌（API 根变了则丢掉）；`""` = 删掉令牌。 */
  readonly token?: string;
  readonly expectedRevision: number;
}

export interface ForgeServiceOptions {
  readonly store: ForgeStore;
  readonly secrets: () => SecretBackend;
  /** 这一轮的 GitHub 域服务；没装（库没过统一迁移）时 `undefined`。 */
  readonly github?: () => GithubService | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export function validHost(host: string): boolean {
  return host.length <= 253 && (HOST_PATTERN.test(host) || loopbackHost(host));
}

/** GitLab 多级子组最深几层（GitLab 自己限 20 层）。 */
export const MAX_NAMESPACE_DEPTH = 20;

/**
 * owner：一段名字，或 GitLab 多级子组的 `group/sub/…`（每段都是合格的名字，
 * 不越级、没有空段）。多段只对 GitLab 有意义，由 {@link ForgeService.detect}
 * 把别的平台挡在外面。
 */
export function validOwner(owner: string): boolean {
  if (owner.length > 255) return false;
  const segments = owner.split("/");
  return (
    segments.length <= MAX_NAMESPACE_DEPTH &&
    segments.every((segment) => validName(segment))
  );
}

/** owner 是不是多级子组。 */
export function nestedOwner(owner: string): boolean {
  return owner.includes("/");
}

/** 一个仓库引用，主机名小写、去掉末尾的点。不合格抛 `invalid`。 */
export function forgeRepo(
  host: string,
  owner: string,
  name: string,
): ForgeRepo {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (!validHost(normalized) || !validOwner(owner) || !validName(name)) {
    throw forgeError("invalid", "REPOSITORY_INVALID");
  }
  return { host: normalized, owner, name };
}

/**
 * 远端地址 → 主机与路径各段（`.git` 去掉）。写法与 `github/remote.ts` 的
 * `parseRemote` 一致（https / http / ssh / git 与 scp），只是把整条路径交出来，
 * 多级子组要用。`web` 表示地址是 http(s)：只有这种才可能带站点的路径前缀。
 */
export function remoteSegments(
  remoteUrl: string,
): { host: string; segments: string[]; web: boolean } | undefined {
  const raw = remoteUrl.trim();
  if (raw === "" || raw.length > 2048 || /\s/.test(raw)) return undefined;
  let host: string;
  let path: string;
  let web = false;
  if (raw.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
      return undefined;
    }
    web = parsed.protocol === "https:" || parsed.protocol === "http:";
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    const at = raw.lastIndexOf("@");
    const rest = at >= 0 ? raw.slice(at + 1) : raw;
    const colon = rest.indexOf(":");
    if (colon <= 0) return undefined;
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  segments[segments.length - 1] = (
    segments[segments.length - 1] as string
  ).replace(/\.git$/, "");
  if (!segments.every((segment) => validName(segment))) return undefined;
  return { host: host.toLowerCase().replace(/\.$/, ""), segments, web };
}

/** 配置行的键：`<host>` 或 `<host>/<owner>/<name>`。不合格抛 `invalid`。 */
export function configKey(host: string, owner?: string, name?: string): string {
  if (owner === undefined || name === undefined) {
    const normalized = host.toLowerCase().replace(/\.$/, "");
    if (!validHost(normalized)) throw forgeError("invalid", "KEY_INVALID");
    return normalized;
  }
  const repo = forgeRepo(host, owner, name);
  return `${repo.host}/${repo.owner}/${repo.name}`;
}

function newSecretId(): string {
  return randomBytes(8).toString("hex");
}

export class ForgeService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: ForgeServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? newSecretId;
  }

  /* --------------------------------- 识别 --------------------------------- */

  /** GitHub 凭据当前对着的 API 根，与它有没有配凭据。 */
  private githubSide(): { base: string; configured: boolean; login: string } {
    const service = this.options.github?.();
    const config = service?.store.config();
    let base = PUBLIC_API_BASE;
    try {
      base = normalizeApiBase(config?.apiBase);
    } catch {
      base = PUBLIC_API_BASE;
    }
    return {
      base,
      configured:
        service !== undefined &&
        config !== undefined &&
        config.source !== GITHUB_SOURCE_NONE,
      login: config?.accountLogin ?? "",
    };
  }

  /** GitHub 管的主机：公有的三个名字，加上凭据里企业版根的主机。 */
  private githubHost(host: string): boolean {
    if (GITHUB_PUBLIC_HOSTS.includes(host)) return true;
    const { base } = this.githubSide();
    return base !== PUBLIC_API_BASE && belongsTo(base, host);
  }

  private configFor(repo: ForgeRepo): ForgeConfigRecord | undefined {
    const store = this.options.store;
    return (
      store.get(`${repo.host}/${repo.owner}/${repo.name}`) ??
      store.get(repo.host)
    );
  }

  detect(repo: ForgeRepo): ForgeDetection {
    const nested = nestedOwner(repo.owner);
    if (
      !nested &&
      (GITHUB_PUBLIC_HOSTS.includes(repo.host) || this.githubHost(repo.host))
    ) {
      const side = this.githubSide();
      const publicHost = GITHUB_PUBLIC_HOSTS.includes(repo.host);
      const apiBase = publicHost ? PUBLIC_API_BASE : side.base;
      // 凭据只对它自己那个根有效：配的是企业版时，github.com 的仓库没有令牌。
      const credential = side.configured && side.base === apiBase;
      const webHost = publicHost ? "github.com" : apiHost(apiBase);
      return {
        repository: repo,
        forge: "github",
        source: "github",
        configKey: null,
        apiBase,
        webUrl: `https://${webHost}/${repo.owner}/${repo.name}`,
        credential,
        accountLogin: credential && side.login !== "" ? side.login : null,
      };
    }
    const config = this.configFor(repo);
    // 多级子组只有 GitLab 有：GitHub 主机与 Gitea 配置都不认这种仓库。
    const usable =
      config !== undefined &&
      (!nested || config.forge === "gitlab") &&
      !(nested && this.githubHost(repo.host));
    if (!usable || config === undefined) {
      return {
        repository: repo,
        forge: null,
        source: null,
        configKey: null,
        apiBase: null,
        webUrl: null,
        credential: false,
        accountLogin: null,
      };
    }
    return {
      repository: repo,
      forge: config.forge,
      source: "config",
      configKey: config.repoKey,
      apiBase: config.apiBase,
      webUrl: `${webRoot(config.forge, config.apiBase)}/${repo.owner}/${repo.name}`,
      credential: config.credentialRef !== "",
      accountLogin:
        config.credentialRef !== "" && config.accountLogin !== ""
          ? config.accountLogin
          : null,
    };
  }

  /**
   * 一个 git 远端地址 → 识别结果。地址里的凭据不进答复。
   *
   * 仓库通常是路径最后两段；GitLab 的多级子组（`group/sub/project`）按配置认：
   *
   *   1. 配置表里写到这个仓库的一行，从最长的 owner 往短里找（`<host>/a/b/c`
   *      先于 `<host>/b/c`）；多段的只认 `gitlab` 行。
   *   2. 主机那一行是 `gitlab`：去掉站点根的路径前缀（http(s) 远端、GitLab 装在
   *      子路径下时），其余除最后一段都是 owner。
   *   3. 其余仍按最后两段。
   */
  resolve(remoteUrl: string): ForgeDetection {
    let parsed: { owner: string; name: string; webHost: string };
    try {
      parsed = parseRemote(remoteUrl);
    } catch {
      throw forgeError("invalid", "REMOTE_INVALID");
    }
    const flat = forgeRepo(parsed.webHost, parsed.owner, parsed.name);
    const parts = remoteSegments(remoteUrl);
    if (
      parts === undefined ||
      parts.segments.length <= 2 ||
      this.githubHost(flat.host)
    ) {
      return this.detect(flat);
    }
    const name = parts.segments[parts.segments.length - 1] as string;
    const store = this.options.store;
    for (let start = 0; start < parts.segments.length - 2; start += 1) {
      const owner = parts.segments.slice(start, -1).join("/");
      if (!validOwner(owner)) continue;
      const row = store.get(`${flat.host}/${owner}/${name}`);
      if (row?.forge === "gitlab") {
        return this.detect(forgeRepo(flat.host, owner, name));
      }
    }
    if (store.get(`${flat.host}/${flat.owner}/${flat.name}`) !== undefined) {
      return this.detect(flat);
    }
    const hostRow = store.get(flat.host);
    if (hostRow?.forge !== "gitlab") return this.detect(flat);
    let segments = parts.segments;
    if (parts.web) {
      const prefix = sitePrefix(hostRow.apiBase);
      if (
        prefix.length > 0 &&
        prefix.every((segment, index) => segments[index] === segment)
      ) {
        segments = segments.slice(prefix.length);
      }
    }
    const owner = segments.slice(0, -1).join("/");
    if (segments.length < 2 || !validOwner(owner)) return this.detect(flat);
    return this.detect(forgeRepo(flat.host, owner, name));
  }

  /**
   * 这个仓库的平台实现。没识别出来、或识别出来却没有令牌，抛 `notConfigured`：
   * 不发匿名请求，免得悄悄只读到公开数据。
   */
  forgeFor(repo: ForgeRepo): Forge {
    const detection = this.detect(repo);
    if (detection.forge === null || !detection.credential) {
      throw forgeError("notConfigured", "NOT_CONFIGURED");
    }
    if (detection.forge === "github") {
      const service = this.options.github?.();
      if (service === undefined) throw forgeError("notConfigured", "NO_GITHUB");
      return new GithubForge(service);
    }
    const config = this.configFor(repo) as ForgeConfigRecord;
    if (config.forge === "github") {
      // 表里的 CHECK 允许它，但 `configure` 从不写它：GitHub 只认 §5 的凭据。
      throw forgeError("notConfigured", "FORGE_UNSUPPORTED");
    }
    return this.client(config.forge, config.apiBase, () =>
      this.token(config.credentialRef),
    );
  }

  private client(
    forge: ConfigurableForge,
    apiBase: string,
    token: () => Promise<string>,
  ): GiteaForge | GitlabForge {
    const options = {
      apiBase,
      token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    };
    return forge === "gitlab"
      ? new GitlabForge(options)
      : new GiteaForge(options);
  }

  private async token(reference: string): Promise<string> {
    if (reference === "") return "";
    try {
      return (await this.options.secrets().get(reference)) ?? "";
    } catch {
      throw forgeError("unavailable", "SECRET_UNAVAILABLE");
    }
  }

  /**
   * 一条指向 Gitea / GitLab 的外部连接（契约 §29.6）用的仓库引用：平台与 API 根
   * 必须就是这台机器对这个仓库的识别结果，API 根与主机从配置里取，不从请求里取。
   * 不符抛 GitHub 域的 `invalid`（连接走的是 `/api/github/link-reference`）。
   */
  referenceRepository(
    forge: "gitea" | "gitlab",
    ref: GithubRepositoryRef | undefined,
  ): GithubRepositoryRef {
    if (ref === undefined) throw githubError("invalid");
    let repo: ForgeRepo;
    try {
      repo = forgeRepo(ref.host, ref.owner, ref.name);
    } catch {
      throw githubError("invalid");
    }
    // GitHub 域的连接表按两段 owner / name 存；多级子组的仓库这一版不连。
    if (nestedOwner(repo.owner)) throw githubError("invalid");
    const detection = this.detect(repo);
    if (detection.forge !== forge || detection.apiBase === null) {
      throw githubError("invalid");
    }
    if (ref.apiBase !== "" && ref.apiBase !== detection.apiBase) {
      throw githubError("invalid");
    }
    return create(GithubRepositoryRefSchema, {
      owner: repo.owner,
      name: repo.name,
      apiBase: detection.apiBase,
      host: repo.host,
    });
  }

  /* --------------------------------- 配置 --------------------------------- */

  configs(): PublicForgeConfig[] {
    return this.options.store.list().map(publicConfig);
  }

  async configure(
    repoKey: string,
    input: ConfigureInput,
  ): Promise<PublicForgeConfig> {
    if (!(CONFIGURABLE_FORGES as readonly string[]).includes(input.forge)) {
      throw forgeError("invalid", "FORGE_INVALID");
    }
    const forge = input.forge as ConfigurableForge;
    const host = repoKey.split("/")[0] as string;
    // 多级子组只有 GitLab 有（键 `<host>/<group>/<sub>/<name>`）。
    if (forge !== "gitlab" && repoKey.split("/").length > 3) {
      throw forgeError("invalid", "NAMESPACE_UNSUPPORTED");
    }
    // GitHub 的主机由 §5 的凭据管；在这里给它另配一个平台只会让两处说法打架。
    if (this.githubHost(host)) throw forgeError("invalid", "GITHUB_HOST");
    const apiBase =
      forge === "gitlab"
        ? gitlabApiBase(input.apiBase)
        : giteaApiBase(input.apiBase);
    if (apiBase === undefined) throw forgeError("invalid", "API_BASE_INVALID");
    if (
      input.token !== undefined &&
      input.token !== "" &&
      !TOKEN_PATTERN.test(input.token)
    ) {
      throw forgeError("invalid", "TOKEN_INVALID");
    }
    const store = this.options.store;
    const current = store.get(repoKey);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw forgeError("conflict", "REVISION_MISMATCH");
    }

    let credentialRef = current?.credentialRef ?? "";
    let accountLogin = current?.accountLogin ?? "";
    let stale = "";
    let created = "";
    if (input.token === "") {
      stale = credentialRef;
      credentialRef = "";
      accountLogin = "";
    } else if (input.token !== undefined) {
      const token = input.token;
      // 先核验再存：不存一个远端不认的令牌，也不声称一个没连上过的账号。
      accountLogin = await this.client(
        forge,
        apiBase,
        async () => token,
      ).viewer();
      if (credentialRef === "") {
        credentialRef = `armadra-forge-${this.newId()}`;
        created = credentialRef;
      }
      try {
        await this.options.secrets().set(credentialRef, token);
      } catch {
        throw forgeError("unavailable", "SECRET_UNAVAILABLE");
      }
    } else if (current !== undefined && current.apiBase !== apiBase) {
      // API 根换了而没给新令牌：旧令牌不能被发到新地址去。
      stale = credentialRef;
      credentialRef = "";
      accountLogin = "";
    }

    let saved: ForgeConfigRecord;
    try {
      saved = store.put({
        repoKey,
        forge,
        apiBase,
        credentialRef,
        accountLogin,
        expectedRevision: input.expectedRevision,
        atMs: this.now(),
      });
    } catch (error) {
      if (created !== "") await this.dropSecret(created);
      throw error;
    }
    if (stale !== "") await this.dropSecret(stale);
    return publicConfig(saved);
  }

  async remove(repoKey: string, expectedRevision: number): Promise<void> {
    const removed = this.options.store.delete(repoKey, expectedRevision);
    if (removed.credentialRef !== "")
      await this.dropSecret(removed.credentialRef);
  }

  private async dropSecret(reference: string): Promise<void> {
    try {
      await this.options.secrets().delete(reference);
    } catch {
      // 删不掉的条目没有行再指向它；下次同名不会被复用（id 是随机的）。
    }
  }
}

/** 站点根的路径各段（GitLab 装在子路径下时非空）。 */
function sitePrefix(apiBase: string): string[] {
  try {
    return new URL(gitlabWebRoot(apiBase)).pathname
      .split("/")
      .filter((segment) => segment !== "");
  } catch {
    return [];
  }
}

/** API 根 → 站点根。 */
export function webRoot(forge: ForgeKind, apiBase: string): string {
  return forge === "gitlab" ? gitlabWebRoot(apiBase) : giteaWebRoot(apiBase);
}

function publicConfig(record: ForgeConfigRecord): PublicForgeConfig {
  return {
    repoKey: record.repoKey,
    forge: record.forge,
    apiBase: record.apiBase,
    credential: record.credentialRef !== "",
    accountLogin:
      record.credentialRef !== "" && record.accountLogin !== ""
        ? record.accountLogin
        : null,
    revision: record.revision,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}
