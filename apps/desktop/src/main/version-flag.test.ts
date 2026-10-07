import { describe, expect, it } from "vitest";
import { versionLine } from "./version-flag";

describe("versionLine", () => {
  it("answers --version with the name and version on one line", () => {
    expect(
      versionLine(["/opt/Armadra/armadra", "--version"], "Armadra", "0.1.0"),
    ).toBe("Armadra 0.1.0\n");
    expect(
      versionLine(
        ["/opt/Armadra/armadra", "--no-sandbox", "--version"],
        "Armadra",
        "0.1.0",
      ),
    ).toBe("Armadra 0.1.0\n");
  });

  it("stays out of the way of a normal start", () => {
    expect(
      versionLine(["/opt/Armadra/armadra"], "Armadra", "0.1.0"),
    ).toBeNull();
    expect(
      versionLine(
        ["/opt/Armadra/armadra", "--version-check"],
        "Armadra",
        "0.1.0",
      ),
    ).toBeNull();
    // The executable's own path is never read as a flag.
    expect(versionLine(["--version"], "Armadra", "0.1.0")).toBeNull();
  });
});
