import { describe, expect, it } from "vitest";
import { removeTrustState, stateKeys } from "./toml-state";

const table = (key: string) =>
  `[hooks.state."${key}"]\nenabled = true\ntrusted_hash = "sha256:x"\n`;

describe("removing trust tables", () => {
  it("keeps the file's final newline when the last table goes", () => {
    const document = `model = "gpt-5"\n\n${table("/<session-flags>/config.toml:stop:0:0")}`;
    expect(removeTrustState(document, "/<session-flags>/", [])).toBe(
      'model = "gpt-5"\n',
    );
  });

  it("drops only the prefixed keys that do not survive", () => {
    const document = [
      table("/<session-flags>/config.toml:stop:0:0"),
      table("/home/u/.codex/hooks.json:stop:0:0"),
      table("/<session-flags>/config.toml:session_start:0:0"),
    ].join("\n");
    const next = removeTrustState(document, "/<session-flags>/", [
      "/<session-flags>/config.toml:session_start:0:0",
    ]);
    expect(stateKeys(next)).toEqual([
      "/home/u/.codex/hooks.json:stop:0:0",
      "/<session-flags>/config.toml:session_start:0:0",
    ]);
  });

  it("answers the document unchanged when nothing matched", () => {
    const document = `model = "gpt-5"\n\n${table("/home/u/.codex/hooks.json:stop:0:0")}`;
    expect(removeTrustState(document, "/<session-flags>/", [])).toBe(document);
  });
});
