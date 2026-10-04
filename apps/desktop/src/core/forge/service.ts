/**
 * 托管平台域的服务：按远端地址识别平台、管每仓库（或每主机）的配置与令牌、
 * 给出对着这台机器配置的那个 {@link Forge}。
 *
 * 识别顺序（契约 §29.1）：
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
import { GiteaForge, giteaApiBase, giteaWebRoot } from "./gitea";
import { GithubForge } from "./github";
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

/** 一个仓库引用，主机名小写、去掉末尾的点。不合格抛 `invalid`。 */
export function forgeRepo(
  host: string,
  owner: string,
  name: string,
): ForgeRepo {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  if (!validHost(normalized) || !validName(owner) || !validName(name)) {
    throw forgeError("invalid", "REPOSITORY_INVALID");
  }
  return { host: normalized, owner, name };
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
    if (GITHUB_PUBLIC_HOSTS.includes(repo.host) || this.githubHost(repo.host)) {
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
    if (config === undefined) {
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
      webUrl: `${giteaWebRoot(config.apiBase)}/${repo.owner}/${repo.name}`,
      credential: config.credentialRef !== "",
      accountLogin:
        config.credentialRef !== "" && config.accountLogin !== ""
          ? config.accountLogin
          : null,
    };
  }

  /** 一个 git 远端地址 → 识别结果。地址里的凭据不进答复。 */
  resolve(remoteUrl: string): ForgeDetection {
    let parsed: { owner: string; name: string; webHost: string };
    try {
      parsed = parseRemote(remoteUrl);
    } catch {
      throw forgeError("invalid", "REMOTE_INVALID");
    }
    return this.detect(forgeRepo(parsed.webHost, parsed.owner, parsed.name));
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
    if (config.forge === "gitea") {
      return this.gitea(config.apiBase, () => this.token(config.credentialRef));
    }
    // GitLab 由 G5-15 接上；表里先有这一种，免得以后改迁移。
    throw forgeError("notConfigured", "FORGE_UNSUPPORTED");
  }

  private gitea(apiBase: string, token: () => Promise<string>): GiteaForge {
    return new GiteaForge({
      apiBase,
      token,
      ...(this.options.fetch === undefined
        ? {}
        : { fetch: this.options.fetch }),
    });
  }

  private async token(reference: string): Promise<string> {
    if (reference === "") return "";
    try {
      return (await this.options.secrets().get(reference)) ?? "";
    } catch {
      throw forgeError("unavailable", "SECRET_UNAVAILABLE");
    }
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
    // GitHub 的主机由 §5 的凭据管；在这里给它另配一个平台只会让两处说法打架。
    if (this.githubHost(host)) throw forgeError("invalid", "GITHUB_HOST");
    const apiBase = giteaApiBase(input.apiBase);
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
      accountLogin = await this.gitea(apiBase, async () => token).viewer();
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
