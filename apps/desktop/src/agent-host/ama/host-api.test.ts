import { describe, expect, it } from "vitest";
import { HOST_API_VERSION } from "@armadra/agent/host";
import { hostApi } from "./main";

/**
 * The version lock (docs/design/coordinator-agent.md §2.6): the adapter's
 * `hostApi` is the one the pinned `@armadra/agent` runs. ama refuses a
 * mismatch at start-up (exit 78), so an upgrade that moves it fails here
 * first.
 */
describe("host API version", () => {
  it("matches the pinned @armadra/agent", () => {
    expect(hostApi).toBe(HOST_API_VERSION);
  });
});
