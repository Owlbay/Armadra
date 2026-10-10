/**
 * The `/armadra-*` slash commands (contract §59, docs/design/claude-mods.md
 * §5.1, package M3).
 *
 * One implementation, three ways in: a command runs `armadra-hook canvas
 * <verb> <words>` — the very client the model runs through Bash and that the
 * canvas MCP server (`armadra-hook mcp`) answers from — and shows what it
 * printed. So the flag rules, the session binding `ack` proves itself with,
 * the timeouts and the wording of every answer and refusal are the client's
 * and the core's, not a copy here. The module only splits what the person
 * typed into words, the way a shell would have before the client saw them.
 *
 * Every command is `immediate`, answered by its own `command.run` hook (a
 * literal matcher, never `next`): a person typing one costs the model no
 * token and never waits for the turn. Under ACP (profile `acp`) the commands
 * are the mod's only addition; the status half stays quiet there.
 *
 * Text for `template.ts`; see `transport.ts` for the rules it is written by.
 */

/** The languages the descriptions are written in (the device setting `ui.locale`). */
export type ModLocale = "zh-CN" | "en";

const DEFAULT_LOCALE: ModLocale = "en";

/**
 * The words, mirrored from `apps/web/src/i18n/mod-commands.ts` (where they
 * belong and are kept in step between the languages); `commands.test.ts`
 * asserts the two tables are equal key by key.
 */
export const COMMAND_MESSAGES: Readonly<
  Record<ModLocale, Readonly<Record<string, string>>>
> = {
  "zh-CN": {
    "mod.command.post": "给连线的节点留一份交接",
    "mod.command.inbox": "查看待收的画布消息",
    "mod.command.ack": "确认收到一条消息",
    "mod.command.send": "把消息送进连线的节点",
    "mod.command.team": "在画布上组一队节点",
    "mod.command.open": "在画布上新建一个节点",
    "mod.command.list": "列出与本节点连线的节点",
    "mod.command.outside": "不在画布节点里",
    "mod.command.unclosed": "引号没有闭合",
    "mod.command.failed": "画布命令没有运行",
  },
  en: {
    "mod.command.post": "Leave a handoff for a linked node",
    "mod.command.inbox": "Read your pending canvas messages",
    "mod.command.ack": "Acknowledge a received message",
    "mod.command.send": "Send a message into a linked node",
    "mod.command.team": "Open a team of nodes on the canvas",
    "mod.command.open": "Open a new node on the canvas",
    "mod.command.list": "List the nodes linked to this one",
    "mod.command.outside": "Not in a canvas node",
    "mod.command.unclosed": "Unclosed quote",
    "mod.command.failed": "The canvas command did not run",
  },
};

export interface ModCommand {
  /** The name without the slash; always `armadra-` first. */
  readonly name: string;
  /** The canvas verb (`POST /control/<verb>`, `armadra-hook canvas <verb>`). */
  readonly verb: string;
  /** The `mod.command.*` key of its description. */
  readonly message: string;
  /** Drawn dim after the name; the client's own usage line for the verb. */
  readonly argumentHint?: string;
}

/** The commands (design §5.1), in the order `/help` lists them. */
export const MOD_COMMANDS: readonly ModCommand[] = [
  {
    name: "armadra-post",
    verb: "post",
    message: "mod.command.post",
    argumentHint: "--to NAME --key KEY --body TEXT",
  },
  {
    name: "armadra-inbox",
    verb: "inbox",
    message: "mod.command.inbox",
    argumentHint: "[--limit N] [--after SEQ]",
  },
  {
    name: "armadra-ack",
    verb: "ack",
    message: "mod.command.ack",
    argumentHint: "--id ID",
  },
  {
    name: "armadra-send",
    verb: "send",
    message: "mod.command.send",
    argumentHint: "--to ID --body TEXT [--key KEY] [--no-queue | --interrupt]",
  },
  {
    name: "armadra-team",
    verb: "team",
    message: "mod.command.team",
    argumentHint: '--member "AGENT|TITLE|TASK"... [--chain]',
  },
  {
    name: "armadra-open",
    verb: "open-agent",
    message: "mod.command.open",
    argumentHint: "--agent ID [--task TEXT]",
  },
  { name: "armadra-list", verb: "list", message: "mod.command.list" },
];

/** The table for `locale`; an unknown one reads as English. */
export function commandMessages(
  locale: ModLocale | undefined,
): Readonly<Record<string, string>> {
  return COMMAND_MESSAGES[
    locale !== undefined && locale in COMMAND_MESSAGES ? locale : DEFAULT_LOCALE
  ];
}

/**
 * The commands' declarations: the table in `locale` and the functions that
 * split the arguments and run the client.
 */
export function commandDeclarations(locale?: ModLocale): string {
  const messages = commandMessages(locale);
  const word = (key: string): string => {
    const text = messages[key];
    if (text === undefined) throw new Error(`no ${key}`);
    return text;
  };
  // One literal call per command: the engine reads a command as answered
  // by its own hook only when its name is registered by a literal.
  const registrations = MOD_COMMANDS.map((command) => {
    const spec: Record<string, unknown> = {
      name: command.name,
      description: word(command.message),
      ...(command.argumentHint === undefined
        ? {}
        : { argumentHint: command.argumentHint }),
      immediate: true,
    };
    return `    await $.command.register(${JSON.stringify(spec)}).catch(() => undefined);\n`;
  }).join("");
  const words = {
    outside: word("mod.command.outside"),
    unclosed: word("mod.command.unclosed"),
    failed: word("mod.command.failed"),
  };
  return (
    `
const ARMADRA_COMMAND_WORDS = ${JSON.stringify(words)};

// The slash commands, described in the device's interface language; declared
// for this session only where a canvas node runs the mod. A refused name
// leaves the others.
async function armadraCommandsStart($: EngineInterface): Promise<void> {
  try {
    if (!armadraIsId(await $.env.get("ARMADRA_NODE_ID"))) return;
${registrations}  } catch {
    // Without the commands the session is the same session.
  }
}
` + COMMAND_FUNCTIONS
  );
}

const COMMAND_FUNCTIONS = String.raw`
// What the person typed after the name, split into words as a POSIX shell
// would have split it for the client: blanks separate, '…' is literal, "…"
// keeps \" \\ \$ and \` escaped, a backslash outside quotes takes the next
// character. Nothing is expanded. An unclosed quote answers undefined.
function armadraWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let open = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\" && i + 1 < text.length && "\"\\$\x60".includes(text[i + 1] as string)) {
        word += text[i + 1] as string;
        i += 1;
      } else {
        word += char;
      }
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (open) words.push(word);
      word = "";
      open = false;
      continue;
    }
    open = true;
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "\\") {
      if (i + 1 < text.length) {
        word += text[i + 1] as string;
        i += 1;
      }
    } else {
      word += char;
    }
  }
  if (quote !== undefined) return undefined;
  if (open) words.push(word);
  return words;
}

// One command: the client's verb with the person's words, and what it printed
// (stdout when it succeeded, its one-line refusal when not). Never throws.
async function armadraCommand($: EngineInterface, verb: string, args: string): Promise<CommandRunResult> {
  try {
    if (!armadraIsId(await $.env.get("ARMADRA_NODE_ID"))) {
      return { text: ARMADRA_COMMAND_WORDS.outside };
    }
    const words = armadraWords(args);
    if (words === undefined) return { text: ARMADRA_COMMAND_WORDS.unclosed };
    const ran = await $.process.run([ARMADRA_CLIENT, "canvas", verb, ...words], {
      timeoutMs: 60000,
    });
    const text = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim();
    return text === "" ? {} : { text };
  } catch {
    return { text: ARMADRA_COMMAND_WORDS.failed };
  }
}
`;

/** What the one `session.start` hook (`template.ts`) starts for the commands. */
export const COMMAND_SESSION_START = "armadraCommandsStart($)";

/**
 * The registrations: one `command.run` hook per command, its matcher the literal name, answering
 * for itself — `claude plugin validate` reads each as "answers its own
 * command", not as a gate.
 */
export const COMMAND_REGISTRATIONS = MOD_COMMANDS.map(
  (command) =>
    `  on("command.run", { command: "${command.name}" }, async ($, e) =>
    armadraCommand($, "${command.verb}", e.args));
`,
).join("");
