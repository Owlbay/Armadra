import { EventEmitter } from "node:events";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runServeShell, serveArguments, serveLaunch } from "./serve-launch";

describe("serveArguments", () => {
  it("answers the rest of the line for `serve` as the first argument", () => {
    expect(serveArguments(["/app/Armadra", "serve"])).toEqual([]);
    expect(
      serveArguments(["/app/Armadra", "serve", "--listen", "127.0.0.1:0"]),
    ).toEqual(["--listen", "127.0.0.1:0"]);
  });

  it("takes --serve anywhere and drops only that flag", () => {
    expect(
      serveArguments(["electron", ".", "--serve", "--data-dir", "/x"]),
    ).toEqual([".", "--data-dir", "/x"]);
  });

  it("leaves every other launch to the desktop", () => {
    expect(serveArguments(["/app/Armadra"])).toBeNull();
    expect(serveArguments(["/app/Armadra", "--version"])).toBeNull();
    expect(serveArguments(["/app/Armadra", "armadra://join?x=1"])).toBeNull();
    // `serve` as a value, not the subcommand.
    expect(
      serveArguments(["/app/Armadra", "--user-data-dir", "serve"]),
    ).toBeNull();
  });
});

describe("serveLaunch", () => {
  const resourcesPath = join("/", "Applications", "Armadra.app", "Resources");
  const base = { execPath: "/app/Armadra", resourcesPath };

  it("runs the packaged server shell as Node with the packaged page and migrations", () => {
    const launch = serveLaunch(["--listen", "127.0.0.1:0"], {
      ...base,
      env: { PATH: "/usr/bin" },
    });
    const server = join(resourcesPath, "server");
    expect(launch.command).toBe("/app/Armadra");
    expect(launch.entry).toBe(join(server, "main.js"));
    expect(launch.args).toEqual([
      join(server, "main.js"),
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--web-root",
      join(server, "web"),
    ]);
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.env.PATH).toBe("/usr/bin");
    expect(launch.env.ARMADRA_CORE_MIGRATIONS_DIR).toBe(
      join(resourcesPath, "migrations"),
    );
    expect(launch.env.NODE_PATH).toBe(
      join(resourcesPath, "app.asar.unpacked", "node_modules"),
    );
  });

  it("keeps a web root, migrations directory and NODE_PATH the caller chose", () => {
    const launch = serveLaunch(["--web-root=/srv/web"], {
      ...base,
      env: { ARMADRA_CORE_MIGRATIONS_DIR: "/m", NODE_PATH: "/n" },
    });
    expect(launch.args.filter((a) => a.startsWith("--web-root"))).toEqual([
      "--web-root=/srv/web",
    ]);
    expect(launch.env.ARMADRA_CORE_MIGRATIONS_DIR).toBe("/m");
    expect(launch.env.NODE_PATH).toBe(
      [join(resourcesPath, "app.asar.unpacked", "node_modules"), "/n"].join(
        delimiter,
      ),
    );
  });
});

describe("runServeShell", () => {
  function fake() {
    const child = Object.assign(new EventEmitter(), { kill: () => true });
    const calls: { command: string; args: string[]; options: unknown }[] = [];
    const exits: number[] = [];
    const errors: string[] = [];
    const deps = {
      execPath: "/app/Armadra",
      resourcesPath: "/r",
      env: {},
      exists: () => true,
      start: ((command: string, args: string[], options: unknown) => {
        calls.push({ command, args, options });
        return child;
      }) as never,
      exit: (code: number) => exits.push(code),
      stderr: (line: string) => errors.push(line),
    };
    return { child, calls, exits, errors, deps };
  }

  it("spawns with inherited stdio and exits with the child's code", () => {
    const f = fake();
    runServeShell(["--no-pairing"], f.deps);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].options).toMatchObject({ stdio: "inherit" });
    f.child.emit("exit", 3, null);
    expect(f.exits).toEqual([3]);
  });

  it("refuses without the packaged entry, naming it", () => {
    const f = fake();
    expect(runServeShell([], { ...f.deps, exists: () => false })).toBeNull();
    expect(f.calls).toEqual([]);
    expect(f.exits).toEqual([1]);
    expect(f.errors.join("")).toContain(join("/r", "server", "main.js"));
  });

  it("reports a child that cannot start", () => {
    const f = fake();
    runServeShell([], f.deps);
    f.child.emit("error", new Error("spawn ENOENT"));
    expect(f.exits).toEqual([1]);
    expect(f.errors.join("")).toContain("spawn ENOENT");
  });
});
