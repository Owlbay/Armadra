import type { CoreServer } from "../http/server";
import type { HandlerResult, RouteMatch, CoreRequest } from "../http/router";
import {
  type SecretBackend,
  type SecretBackendKind,
  SecretStore,
  SecretUnavailable,
} from "../secrets";
import { DomainError, badRequest, jsonObject } from "../workspaces/support";

/**
 * The model keys of the bundled `ama` (docs/design/coordinator-agent.md §7).
 *
 * Stored per provider in the secret backend (`armadra-ama-<provider>`) and
 * nowhere else at rest. They reach ama the way node credentials reach a CLI
 * (contract §20.4, §12.4): the canvas launcher `run/ama` runs
 * `armadra-hook credential --ama`, which presents this node's verified token
 * on the local hook surface and gets `AMA_API_KEY_<PROVIDER>=<key>` lines back;
 * the launcher sets them on the ama process alone and `exec`s it. Never on
 * disk, never in the node shell's environment, never on the launch line or in
 * a log, never in a `/api` answer — those say whether a key is set and where
 * it lives, and nothing else. ama strips every `AMA_*` variable from the
 * processes it starts.
 *
 * The values are held in memory once read (a keychain is a process), and kept
 * current by every write through {@link AmaCredentials.set} / `clear`.
 */

/**
 * The providers ama takes an API key for — its built-in list (ama
 * `docs/providers.md`) minus the ones that need no key (`ollama`, `lmstudio`)
 * or log in instead (`chatgpt`, which ama keeps in its own `auth.json`).
 */
export const AMA_KEY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshot",
  "zhipu",
  "dashscope",
  "openrouter",
  "groq",
  "xai",
  "mistral",
  "minimax",
  "stepfun",
  "volcengine",
  "tencent",
] as const;

export type AmaKeyProvider = (typeof AMA_KEY_PROVIDERS)[number];

export function isAmaKeyProvider(value: string): value is AmaKeyProvider {
  return (AMA_KEY_PROVIDERS as readonly string[]).includes(value);
}

/** The secret-store entry of one provider's key. */
export function amaSecretName(provider: AmaKeyProvider): string {
  return `armadra-ama-${provider}`;
}

/** `GET /api/agents/ama/credentials`. */
export interface AmaCredentialStatus {
  readonly backend: SecretBackendKind;
  readonly providers: readonly {
    readonly id: AmaKeyProvider;
    readonly isSet: boolean;
  }[];
}

/**
 * The variable ama reads one provider's key from: its own
 * `AMA_API_KEY_<PROVIDER>` (every built-in lists one in its `envKeys`), not
 * the vendor's name — a vendor variable the user's shell already exports is
 * left as it is.
 */
export function amaKeyVariable(provider: AmaKeyProvider): string {
  return `AMA_API_KEY_${provider.toUpperCase()}`;
}

/** Every name the launcher may set: it refuses any other in an answer. */
export const AMA_KEY_VARIABLES: readonly string[] =
  AMA_KEY_PROVIDERS.map(amaKeyVariable);

/** One `NAME=value` the launcher sets on the ama process. */
export interface AmaKeyVariable {
  readonly variable: string;
  readonly value: string;
}

export class AmaCredentials {
  private readonly keys = new Map<string, string>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly backend: SecretBackend) {}

  private store(provider: AmaKeyProvider): SecretStore {
    return new SecretStore(this.backend, amaSecretName(provider));
  }

  /** Reads every provider's key into memory once; later calls share it. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const provider of AMA_KEY_PROVIDERS) {
        const value = await this.store(provider).read();
        if (value !== undefined && value !== "") this.keys.set(provider, value);
      }
    })();
    return this.loaded;
  }

  async status(): Promise<AmaCredentialStatus> {
    await this.load();
    return {
      backend: this.backend.kind,
      providers: AMA_KEY_PROVIDERS.map((id) => ({
        id,
        isSet: this.keys.has(id),
      })),
    };
  }

  async set(provider: AmaKeyProvider, apiKey: string): Promise<void> {
    await this.load();
    await this.store(provider).write(apiKey);
    this.keys.set(provider, apiKey);
  }

  async clear(provider: AmaKeyProvider): Promise<void> {
    await this.load();
    await this.store(provider).clear();
    this.keys.delete(provider);
  }

  /**
   * The set keys as the variables ama reads — for the hook surface's
   * `/credential/ama` and nothing else. A value with a line break cannot be
   * one `NAME=value` line and is left out.
   */
  async variables(): Promise<AmaKeyVariable[]> {
    await this.load();
    const out: AmaKeyVariable[] = [];
    for (const provider of AMA_KEY_PROVIDERS) {
      const value = this.keys.get(provider);
      if (value === undefined || /[\r\n\0]/.test(value)) continue;
      out.push({ variable: amaKeyVariable(provider), value });
    }
    return out;
  }
}

let current: AmaCredentials | undefined;

/** Published by the agent domain at assembly; `undefined` in a bare core. */
export function setAmaCredentials(value: AmaCredentials | undefined): void {
  current = value;
}

export function amaCredentials(): AmaCredentials | undefined {
  return current;
}

/* --------------------------------- routes --------------------------------- */

/** A key is one line of printable text; anything else is a paste gone wrong. */
const MAX_KEY_LENGTH = 4_096;

function providerOf(match: RouteMatch): AmaKeyProvider {
  const provider = match.params.provider ?? "";
  if (!isAmaKeyProvider(provider)) {
    throw badRequest(`ama takes no API key for \`${provider}\``);
  }
  return provider;
}

function apiKeyOf(request: CoreRequest): string {
  const value = jsonObject(request.body).apiKey;
  if (typeof value !== "string") throw badRequest("apiKey must be a string");
  const key = value.trim();
  if (
    key === "" ||
    key.length > MAX_KEY_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw badRequest("apiKey must be one non-empty line");
  }
  return key;
}

function answered(
  handle: (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult>,
): (match: RouteMatch, request: CoreRequest) => Promise<HandlerResult> {
  return async (match, request) => {
    try {
      return await handle(match, request);
    } catch (error) {
      if (error instanceof DomainError) {
        const { status, body } = error.response();
        return { status, body };
      }
      if (error instanceof SecretUnavailable) {
        return {
          status: 503,
          body: {
            code: error.code,
            message: "The secret store is unavailable",
          },
        };
      }
      if (error instanceof SyntaxError) {
        return {
          status: 400,
          body: {
            code: "bad_request",
            message: "Request body is not valid JSON",
          },
        };
      }
      throw error;
    }
  };
}

/**
 * `GET /api/agents/ama/credentials`, `PUT` / `DELETE
 * /api/agents/ama/credentials/{provider}` (contract §12.4). Every answer is
 * the status: which providers have a key and which backend holds them —
 * never a key.
 */
export function installAmaCredentialRoutes(
  server: CoreServer,
  credentials: AmaCredentials,
): void {
  server.router.handle(
    "GET",
    "/api/agents/ama/credentials",
    answered(async () => ({ status: 200, body: await credentials.status() })),
  );
  server.router.handle(
    "PUT",
    "/api/agents/ama/credentials/{provider}",
    answered(async (match, request) => {
      const provider = providerOf(match);
      await credentials.set(provider, apiKeyOf(request));
      return { status: 200, body: await credentials.status() };
    }),
  );
  server.router.handle(
    "DELETE",
    "/api/agents/ama/credentials/{provider}",
    answered(async (match) => {
      await credentials.clear(providerOf(match));
      return { status: 200, body: await credentials.status() };
    }),
  );
}
