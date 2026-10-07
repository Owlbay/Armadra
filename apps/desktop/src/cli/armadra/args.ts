import { CONTROLLER_METHODS, type ControllerMethod } from "@armadra/shared";
import { CliError } from "./client";

export const HELP =
  "armadra <doctor|workspaces list|connect|disconnect|boards list|board get|graph validate|graph apply|run start|run get|run wait|run cancel|run artifacts> [--json] [--data-dir PATH] [--profile NAME]\nUse an explicit workspace, board or run ID. Graph/run start: --file FILE|- --key KEY. Wait: --cursor N --timeout SECONDS (maximum 60).";
const flags = [
  "json",
  "help",
  "summary",
  "details",
  "data-dir",
  "profile",
  "workspace",
  "board",
  "run",
  "file",
  "key",
  "cursor",
  "timeout",
];
export function parse(argv: readonly string[]): {
  method: ControllerMethod;
  flags: Record<string, string | true>;
} {
  const words: string[] = [];
  const result: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (!word.startsWith("--")) {
      words.push(word);
      continue;
    }
    const key = word.slice(2);
    if (!flags.includes(key) || key in result)
      throw new CliError(
        "invalid_arguments",
        `Unknown or duplicate option: ${word}`,
        2,
      );
    if (["json", "help", "summary", "details"].includes(key))
      result[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new CliError("invalid_arguments", `Missing value for ${word}`, 2);
      result[key] = value;
    }
  }
  const method = words.join(".") || "doctor";
  if (!CONTROLLER_METHODS.includes(method as ControllerMethod))
    throw new CliError("invalid_arguments", "Unknown command; use --help", 2);
  return { method: method as ControllerMethod, flags: result };
}
