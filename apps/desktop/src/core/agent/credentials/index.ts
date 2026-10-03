import type { DatabaseSync } from "node:sqlite";

import type { SecretBackend } from "../../secrets/backend";
import { CREDENTIAL_KINDS, CREDENTIAL_REF_ENV, kindRow } from "./inject";
import { type CredentialRow, CredentialStore } from "./store";
import { configuredLaunchExe } from "../../hook/install/windows-launcher";

function hasLaunchExe(): boolean {
  return configuredLaunchExe() !== undefined;
}

export * from "./inject";
export { CredentialStore, REF_PATTERN, type CredentialRow } from "./store";

/**
 * 节点凭据域（补全架构 §9.1，契约 §20）：条目、启动前的校验、给启动器的兑换。
 *
 * 由终端域装配（`terminal/install.ts`）：校验发生在起终端那一刻，注入点就是终端
 * 的 `ownedEnvironment`。
 */

/** 一次拒绝：路由与 `POST /api/terminals` 原样答 `{ code, message }`。 */
export class CredentialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface CredentialsOptions {
  readonly database: DatabaseSync;
  readonly secrets: SecretBackend;
  /** 一个节点 Agent id 的基础 CLI（`custom:` 条目按它的 `baseAgent`）。 */
  readonly baseOf: (agentId: string) => string;
  readonly platform?: NodeJS.Platform;
  /**
   * Windows: whether this core has the canvas launcher (`armadra-launch.exe`)
   * that redeems the credential. Without it canvas agents start on a bare
   * line (canvas-launcher §5.3) and a bound credential would silently not
   * apply, so credentials are refused. Defaults to looking for the program.
   */
  readonly windowsLauncher?: () => boolean;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
  readonly now?: () => number;
}

/** 兑换的答复：只给启动器，经本机 hook 通道（§20.4）。 */
export interface Redeemed {
  readonly variable: string;
  readonly value: string;
}

export class CredentialsDomain {
  readonly store: CredentialStore;
  /** 起终端时绑定的条目：nodeId → `{ ref, agentId }`。core 重启后改读节点数据。 */
  private readonly bindings = new Map<
    string,
    { readonly ref: string; readonly agentId: string }
  >();

  constructor(private readonly options: CredentialsOptions) {
    this.store = new CredentialStore(
      options.database,
      options.secrets,
      options.now,
    );
  }

  /**
   * 这台主机能不能存、能不能用凭据。`file` 后端是 0600 明文，一次降级，不拿来放
   * 别人的令牌；Windows 上兑换由 C# 启动器 `armadra-launch.exe` 做，这台机器没有
   * 它（开发树没在 Windows 上 build、打包时没有 csc）时节点终端起的是裸行，凭据
   * 不会生效，所以拒绝。
   */
  availability(): { ok: true } | { ok: false; error: CredentialError } {
    if (this.options.secrets.kind === "file") {
      return {
        ok: false,
        error: new CredentialError(
          409,
          "credential_backend_insecure",
          "The secret store on this host is a plain file; node credentials are refused",
        ),
      };
    }
    if (
      (this.options.platform ?? process.platform) === "win32" &&
      !(this.options.windowsLauncher ?? hasLaunchExe)()
    ) {
      return {
        ok: false,
        error: new CredentialError(
          400,
          "credential_unsupported_here",
          "Node credentials need the canvas launcher (armadra-launch.exe), which this installation does not have",
        ),
      };
    }
    return { ok: true };
  }

  kinds(): { providerId: string; kind: string; enabled: boolean }[] {
    return CREDENTIAL_KINDS.map(({ providerId, kind, enabled }) => ({
      providerId,
      kind,
      enabled,
    }));
  }

  /**
   * 起终端前的校验：条目在、属于节点的基础 CLI、种类已启用、不是 SSH 节点、这台
   * 主机可用。不取值——值在启动器兑换时现取。
   */
  check(ref: string, agentId: string, ssh: boolean): CredentialRow {
    if (ssh) {
      throw new CredentialError(
        400,
        "credential_unsupported_here",
        "A node credential cannot be sent over SSH",
      );
    }
    const available = this.availability();
    if (!available.ok) throw available.error;
    const row = this.store.get(ref);
    if (row === undefined) {
      throw new CredentialError(
        400,
        "credential_mismatch",
        "The node credential does not exist",
      );
    }
    const base = this.options.baseOf(agentId);
    if (row.providerId !== base) {
      throw new CredentialError(
        400,
        "credential_mismatch",
        `The node credential belongs to ${row.providerId}, not ${base}`,
      );
    }
    if (kindRow(row.providerId, row.kind)?.enabled !== true) {
      throw new CredentialError(
        400,
        "credential_kind_disabled",
        `Credential kind ${row.kind} is not enabled`,
      );
    }
    return row;
  }

  /**
   * 节点终端环境里凭据的那一半：只有条目名 {@link CREDENTIAL_REF_ENV}。
   *
   * `requested` 来自 `POST /api/terminals`：校验不过就抛，终端不起。其余几条路
   * （唤醒、依赖编排、冷启动）没有请求，读节点数据里的绑定；那里校验不过不拦终端，
   * 照样带上名字——兑换时会拒绝、启动器拒绝起 CLI，而不是悄悄用默认登录起。
   */
  environment(
    nodeId: string,
    agentId: string,
    ssh: boolean,
    requested: string | undefined,
    bound: string | undefined,
  ): readonly (readonly [string, string])[] {
    if (requested !== undefined) {
      this.check(requested, agentId, ssh);
      this.bindings.set(nodeId, { ref: requested, agentId });
      return [[CREDENTIAL_REF_ENV, requested]];
    }
    this.bindings.delete(nodeId);
    if (bound === undefined || ssh) return [];
    this.bindings.set(nodeId, { ref: bound, agentId });
    return [[CREDENTIAL_REF_ENV, bound]];
  }

  /**
   * 启动器的兑换（契约 §20.4）。调用方已验过节点 token；这里只认这个节点此刻绑定
   * 的那一条，重新校验，再现取值。日志只记节点与条目名。
   */
  async redeem(
    nodeId: string,
    ref: string,
    persisted: { ref?: string; agentId?: string },
  ): Promise<Redeemed> {
    const binding =
      this.bindings.get(nodeId) ??
      (persisted.ref !== undefined && persisted.agentId !== undefined
        ? { ref: persisted.ref, agentId: persisted.agentId }
        : undefined);
    if (binding === undefined || binding.ref !== ref) {
      throw new CredentialError(
        403,
        "forbidden",
        "This node is not bound to that credential",
      );
    }
    const row = this.check(ref, binding.agentId, false);
    const variable = kindRow(row.providerId, row.kind)?.variable as string;
    let value: string | undefined;
    try {
      value = await this.store.value(ref);
    } catch {
      throw new CredentialError(
        503,
        "credential_unavailable",
        "The secret store could not open the node credential",
      );
    }
    if (value === undefined) {
      throw new CredentialError(
        409,
        "credential_unset",
        "The node credential has no value",
      );
    }
    this.store.touch(ref);
    this.options.log?.("node credential taken", { nodeId, ref });
    return { variable, value };
  }
}

let assembled: CredentialsDomain | undefined;

/** 这一轮 core 的凭据域；装配前是 `undefined`。 */
export function credentialsDomain(): CredentialsDomain | undefined {
  return assembled;
}

export function setCredentialsDomain(
  domain: CredentialsDomain | undefined,
): void {
  assembled = domain;
}

/** 节点数据里的绑定：`agent.id` 与 `agent.account.credentialRef`。 */
export function persistedBinding(
  database: DatabaseSync,
  nodeId: string,
): { ref?: string; agentId?: string } {
  try {
    const row = database
      .prepare(
        "SELECT json_extract(data_json, '$.agent.account.credentialRef') AS ref, " +
          "json_extract(data_json, '$.agent.id') AS agent_id FROM nodes WHERE id = ?",
      )
      .get(nodeId) as unknown as
      | { ref: unknown; agent_id: unknown }
      | undefined;
    if (row === undefined) return {};
    return {
      ...(typeof row.ref === "string" && row.ref !== ""
        ? { ref: row.ref }
        : {}),
      ...(typeof row.agent_id === "string" && row.agent_id !== ""
        ? { agentId: row.agent_id }
        : {}),
    };
  } catch {
    return {};
  }
}
