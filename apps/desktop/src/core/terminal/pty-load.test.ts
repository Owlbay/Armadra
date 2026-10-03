import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { nodePtyCandidates, requireNodePty } from "./pty";

/**
 * The Windows session host is a bundle copied out of the asar
 * (`<resources>/session-host/host.cjs`) and cannot find node-pty by name; the
 * package is in `<resources>/app.asar.unpacked/node_modules/node-pty`.
 */
describe("loading node-pty", () => {
  const MODULE = { spawn: () => undefined };

  it("looks beside the asar for a bundle that lives outside it", () => {
    expect(nodePtyCandidates(join("R", "session-host"))).toEqual([
      join("R", "app.asar.unpacked", "node_modules", "node-pty"),
    ]);
  });

  it("takes the package by name first", () => {
    const asked: string[] = [];
    const loaded = requireNodePty(
      (id) => {
        asked.push(id);
        return MODULE;
      },
      ["/elsewhere"],
      () => true,
    );
    expect(loaded).toBe(MODULE);
    expect(asked).toEqual(["node-pty"]);
  });

  it("falls back to the unpacked copy when the name does not resolve", () => {
    const unpacked = join("R", "app.asar.unpacked", "node_modules", "node-pty");
    const loaded = requireNodePty(
      (id) => {
        if (id === unpacked) return MODULE;
        throw new Error(`Cannot find module '${id}'`);
      },
      ["/missing", unpacked],
      (path) => path === unpacked,
    );
    expect(loaded).toBe(MODULE);
  });

  it("reports the by-name failure when nothing loads", () => {
    expect(() =>
      requireNodePty(
        () => {
          throw new Error("Cannot find module 'node-pty'");
        },
        ["/missing"],
        () => false,
      ),
    ).toThrow(/node-pty 无法加载.*Cannot find module 'node-pty'/);
  });
});
