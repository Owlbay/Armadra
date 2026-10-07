import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { tempDir } from "../../core/testing/temp-dir";
import { publish, serviceEndpointNow } from "../../core/endpoints";
import { startControllerChannel } from "../../core/controller/channel";
import { ControllerClient, CliError } from "./client";
import { parse } from "./args";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

if (process.platform !== "win32") {
  it("locates a live controller through discovery and detects stale instance hints", async () => {
    const directory = tempDir("armadra cli spaces-");
    const started = await startControllerChannel({
      dataDir: directory,
      instanceId: "live",
      dispatch: async () => ({
        protocolVersion: 1,
        capabilities: ["controller.v1"],
      }),
    });
    if (!started) throw new Error("Unix required");
    closing.push(() => started.close());
    publish(join(directory, "endpoints.json"), "controller", {
      ...serviceEndpointNow("live"),
      socket: join(directory, "controller.sock"),
    });
    const client = new ControllerClient(directory);
    expect((await client.call("doctor", {})).ok).toBe(true);
    publish(join(directory, "endpoints.json"), "controller", {
      ...serviceEndpointNow("old"),
      socket: join(directory, "controller.sock"),
    });
    expect((await client.call("doctor", {})).error?.code).toBe(
      "instance_mismatch",
    );
  });
}

it("fails explicitly on Windows or missing services without starting a core", async () => {
  expect(() => new ControllerClient("unused", "win32")).toThrow(CliError);
  if (process.platform !== "win32")
    await expect(
      new ControllerClient(tempDir("armadra absent-")).call("doctor", {}),
    ).rejects.toMatchObject({ code: "core_unavailable", exitCode: 3 });
});

it("parses explicit targets and stdin input without interpreting prompts as commands", () => {
  expect(
    parse([
      "graph",
      "apply",
      "--board",
      "b",
      "--file",
      "-",
      "--key",
      "k",
      "--json",
    ]),
  ).toMatchObject({
    method: "graph.apply",
    flags: { board: "b", file: "-", key: "k", json: true },
  });
  expect(() => parse(["graph", "apply", "--board"])).toThrow();
  expect(() => parse(["shell", "exec"])).toThrow();
  expect(() => parse(["doctor", "--unknown", "x"])).toThrow();
});
