/**
 * 节点凭据的 `kind` 表与注入（补全架构 §9.1，CLI 协作 §7.3）。
 *
 * ## 表是封闭的
 *
 * 一个 `kind` 设哪个环境变量由这里写死，用户只能从表里选，不能自己填变量名——
 * 否则「凭据」就成了往 CLI 进程里注入任意变量的口子（`PATH`、`NODE_OPTIONS`、
 * `LD_PRELOAD`……）。第一版只开 Claude `oauth-token` 与 Copilot `github-token`：
 * 两家都是官方文档化的变量、优先于已存的登录、不写文件（§7.3「最小可行范围」）。
 * 其余几行先入表、`enabled: false`，等 §7.4 的 T4–T7 用真实账号测过优先级再开。
 *
 * ## 值怎么到 CLI
 *
 * 节点终端的环境里只有 {@link CREDENTIAL_REF_ENV}——条目的**名字**，不是值。画布
 * 启动器 `run/<cli>` 看到它时调 `armadra-hook credential`，后者带节点 token 经本机
 * hook 通道向 core 兑换，启动器在自己的进程里把值设成表里的变量再 `exec` CLI。
 * 所以值不进节点 shell 的环境、不进启动行与 shell 历史、不落盘；唯一带值的是那条
 * 本机回环的兑换答复（契约 §20.4）。CLI 再起的子进程会继承这个变量——这是环境
 * 变量注入固有的边界，设置页的风险说明与契约都写明了。
 */

/** 节点终端环境里的那个变量：条目名，启动器据此去兑换。 */
export const CREDENTIAL_REF_ENV = "ARMADRA_CREDENTIAL_REF";

/** SecretStore 条目名的前缀：`armadra-credential-<ref>`。 */
export const SECRET_PREFIX = "armadra-credential-";

export interface CredentialKindRow {
  /** 基础 CLI 的 id（`custom:` 条目按它的 `baseAgent`）。 */
  readonly providerId: string;
  readonly kind: string;
  /** 设给 CLI 进程的变量。只在 core 里，不上线。 */
  readonly variable: string;
  /** `false`：待 §7.4 实测，设置页灰掉，core 拒绝新建与启动。 */
  readonly enabled: boolean;
}

/** 第一版的映射表（CLI 协作 §7.3）。改动这里要同步契约 §20.1。 */
export const CREDENTIAL_KINDS: readonly CredentialKindRow[] = Object.freeze([
  {
    providerId: "claude",
    kind: "oauth-token",
    variable: "CLAUDE_CODE_OAUTH_TOKEN",
    enabled: true,
  },
  // 交互模式第一次用 API key 要确认一次、结果写进全局配置（§7.3 风险）：待 T1。
  {
    providerId: "claude",
    kind: "api-key",
    variable: "ANTHROPIC_API_KEY",
    enabled: false,
  },
  {
    providerId: "copilot",
    kind: "github-token",
    variable: "COPILOT_GITHUB_TOKEN",
    enabled: true,
  },
  // 交互 TUI 认不认、与 `auth.json` 谁优先：待 T4。
  {
    providerId: "codex",
    kind: "api-key",
    variable: "CODEX_API_KEY",
    enabled: false,
  },
  // 环境变量能不能压过 `auth.json` / `agent.db` 里的同一家：待 T5 / T6 / T7。
  ...(["pi", "omp"] as const).flatMap((providerId) => [
    {
      providerId,
      kind: "api-key:anthropic",
      variable: "ANTHROPIC_API_KEY",
      enabled: false,
    },
    {
      providerId,
      kind: "api-key:openai",
      variable: "OPENAI_API_KEY",
      enabled: false,
    },
    {
      providerId,
      kind: "api-key:moonshot",
      variable: "MOONSHOT_API_KEY",
      enabled: false,
    },
  ]),
  {
    providerId: "opencode",
    kind: "api-key:anthropic",
    variable: "ANTHROPIC_API_KEY",
    enabled: false,
  },
  {
    providerId: "opencode",
    kind: "api-key:openai",
    variable: "OPENAI_API_KEY",
    enabled: false,
  },
] satisfies CredentialKindRow[]);

/** 表里的一行；不在表里是 `undefined`。 */
export function kindRow(
  providerId: string,
  kind: string,
): CredentialKindRow | undefined {
  return CREDENTIAL_KINDS.find(
    (row) => row.providerId === providerId && row.kind === kind,
  );
}

/**
 * 一家 CLI 的启动器可能要设的变量（启用与未启用的都算）：启动器只认这几个名字，
 * 兑换答复里出现别的名字时拒绝启动，而不是照设。
 */
export function variablesFor(providerId: string): readonly string[] {
  return [
    ...new Set(
      CREDENTIAL_KINDS.filter((row) => row.providerId === providerId).map(
        (row) => row.variable,
      ),
    ),
  ];
}

/** 一个条目在 SecretStore 里的名字。 */
export function secretName(ref: string): string {
  return `${SECRET_PREFIX}${ref}`;
}
