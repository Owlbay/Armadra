import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTROLLER_LIMITS, type ControllerReply } from "@armadra/shared";
import { resolveDataDir } from "../../core/paths";
import { CliError, ControllerClient, exitCode } from "./client";
import { HELP, parse } from "./args";
import {
  loadProfile,
  saveProfile,
  removeProfile,
  type Profile,
} from "./profiles";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let json = argv.includes("--json");
  try {
    const input = parse(argv);
    if (input.flags.help) {
      process.stdout.write(HELP + "\n");
      return 0;
    }
    json = input.flags.json === true;
    const params: Record<string, unknown> = {};
    for (const key of ["workspace", "board", "run"]) {
      if (input.flags[key]) params[`${key}Id`] = input.flags[key];
    }
    if (input.flags.file) {
      const file = input.flags.file as string;
      const bytes = readFileSync(file === "-" ? 0 : file);
      if (bytes.length > CONTROLLER_LIMITS.bodyBytes)
        throw new CliError("body_limit", "Input exceeds 256 KiB", 2);
      try {
        params.input = JSON.parse(bytes.toString());
      } catch {
        throw new CliError(
          "invalid_arguments",
          "Input file must contain JSON",
          2,
        );
      }
    }
    if (input.method.startsWith("graph.") || input.method === "run.start") {
      if (!params.boardId || !params.input)
        throw new CliError(
          "target_required",
          "Explicit --board and --file are required",
          2,
        );
    }
    if (
      ["graph.apply", "run.start", "run.cancel"].includes(input.method) &&
      !input.flags.key
    )
      throw new CliError(
        "invalid_arguments",
        "Mutation requires --key for safe reconciliation",
        2,
      );
    if (input.flags.details) params.details = true;
    if (input.flags.cursor) params.cursor = Number(input.flags.cursor);
    if (input.method === "run.wait") {
      params.cursor = Number(input.flags.cursor ?? 0);
      params.timeoutSeconds = Number(input.flags.timeout ?? 30);
      if (
        !Number.isSafeInteger(params.cursor) ||
        Number(params.cursor) < 0 ||
        !Number.isFinite(params.timeoutSeconds) ||
        Number(params.timeoutSeconds) < 0 ||
        Number(params.timeoutSeconds) > 60
      )
        throw new CliError(
          "invalid_arguments",
          "Wait requires a nonnegative cursor and timeout of 0–60 seconds",
          2,
        );
    }
    const dataDir = resolve(
      resolveDataDir(input.flags["data-dir"] as string | undefined),
    );
    const client = new ControllerClient(dataDir);
    const bootstrap = ["doctor", "workspaces.list", "connect"].includes(
      input.method,
    );
    const selected = bootstrap
      ? undefined
      : loadProfile(input.flags.profile as string | undefined, dataDir);
    const answer = await client.call(
      input.method,
      params,
      selected?.profile.credential,
      input.flags.key as string | undefined,
      input.method === "run.wait"
        ? Number(params.timeoutSeconds) * 1000 + 5000
        : undefined,
    );
    if (input.method === "connect" && answer.ok) {
      const data = answer.data as Omit<Profile, "schemaVersion" | "dataDir"> & {
        scope: string[];
      };
      const name =
        (input.flags.profile as string | undefined) ?? data.controllerId;
      try {
        saveProfile(name, {
          schemaVersion: 1,
          controllerId: data.controllerId,
          workspaceId: data.workspaceId,
          credential: data.credential,
          dataDir,
        });
      } catch (error) {
        await client.call("disconnect", {}, data.credential);
        throw error;
      }
      answer.data = {
        profile: name,
        workspaceId: data.workspaceId,
        scope: data.scope,
      };
    }
    if (input.method === "disconnect" && answer.ok && selected)
      removeProfile(selected.name);
    print(answer, json);
    return answer.ok ? 0 : exitCode(answer.error!.code);
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError("internal_error", "CLI operation failed", 6);
    print(
      {
        schemaVersion: 1,
        ok: false,
        requestId: "client",
        error: { code: failure.code, message: failure.message },
      },
      json,
    );
    return failure.exitCode;
  }
}
function print(reply: ControllerReply, json: boolean) {
  process.stdout.write(
    json
      ? JSON.stringify(reply) + "\n"
      : reply.ok
        ? JSON.stringify(reply.data) + "\n"
        : `${reply.error!.code}: ${reply.error!.message}\n`,
  );
}
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
)
  void main().then((code) => {
    process.exitCode = code;
  });
