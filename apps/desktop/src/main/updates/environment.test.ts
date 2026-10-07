/**
 * What this installation says about its own signature (external services
 * §2.1, §2.2). The rules are tested everywhere with a stand-in for
 * PowerShell; the Windows branch is tested against the real
 * `Get-AuthenticodeSignature` on Windows runners, with an unsigned file and a
 * file signed by a throwaway self-signed certificate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.1.0",
    getAppPath: () => "/nowhere",
  },
}));

const {
  macSignatureState,
  signatureState,
  windowsPowerShellEnv,
  windowsSignatureState,
} = await import("./environment");
type Codesign = import("./environment").Codesign;

describe("Windows: Authenticode decides, and only Valid is signed", () => {
  it("maps PowerShell's status onto the four states", () => {
    const answer = (status: string) => () => `${status}\r\n`;
    expect(windowsSignatureState("C:\\a.exe", answer("Valid"))).toBe("signed");
    expect(windowsSignatureState("C:\\a.exe", answer("NotSigned"))).toBe(
      "unsigned",
    );
    // A self-signed rehearsal certificate, a tampered file, an untrusted
    // chain: none of these is a signature an update may rely on.
    for (const status of [
      "UnknownError",
      "HashMismatch",
      "NotTrusted",
      "NotSupportedFileFormat",
      "Incompatible",
      "",
    ]) {
      expect(windowsSignatureState("C:\\a.exe", answer(status))).toBe(
        "unknown",
      );
    }
  });

  it("a PowerShell that cannot be started is unknown, not unsigned", () => {
    expect(
      windowsSignatureState("C:\\a.exe", () => {
        throw new Error("spawn powershell.exe ENOENT");
      }),
    ).toBe("unknown");
  });

  it("starts Windows PowerShell without an inherited PSModulePath", () => {
    // PowerShell 7's module path makes 5.1 fail to load the module that
    // carries Get-AuthenticodeSignature, silently.
    const env = windowsPowerShellEnv({
      PATH: "C:\\Windows",
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    });
    expect(env).toEqual({ PATH: "C:\\Windows" });
    expect(windowsPowerShellEnv({ psmodulepath: "x" })).toEqual({});
  });

  it("quotes the path as a PowerShell literal", () => {
    const commands: string[] = [];
    windowsSignatureState("C:\\Program Files\\O'Brien\\a.exe", (command) => {
      commands.push(command);
      return "Valid";
    });
    expect(commands[0]).toContain(
      "-LiteralPath 'C:\\Program Files\\O''Brien\\a.exe'",
    );
  });
});

/** A stand-in `codesign`: the verify answer, then the display answer. */
function fakeCodesign(
  verify: { status: number | null; stderr?: string },
  display: { status: number | null; stderr?: string } = { status: 0 },
  calls: (readonly string[])[] = [],
): Codesign {
  return (args) => {
    calls.push(args);
    const answer = args[0] === "--verify" ? verify : display;
    return { status: answer.status, stdout: "", stderr: answer.stderr ?? "" };
  };
}

describe("macOS: codesign --verify --deep --strict decides, ad-hoc is unknown", () => {
  const executable = "/Applications/Armadra.app/Contents/MacOS/Armadra";

  it("verifies the bundle the executable is in", () => {
    const calls: (readonly string[])[] = [];
    expect(
      signatureState(
        "darwin",
        executable,
        true,
        fakeCodesign(
          { status: 0 },
          {
            status: 0,
            stderr:
              "Identifier=dev.armadra\nAuthority=Developer ID Application: X\nTeamIdentifier=ABCDE12345\n",
          },
          calls,
        ),
      ),
    ).toBe("signed");
    expect(calls[0]).toEqual([
      "--verify",
      "--deep",
      "--strict",
      "/Applications/Armadra.app",
    ]);
  });

  it("maps codesign's answers onto the states", () => {
    const bundle = "/Applications/Armadra.app";
    expect(
      macSignatureState(
        bundle,
        fakeCodesign({
          status: 1,
          stderr: "/Applications/Armadra.app: code object is not signed at all",
        }),
      ),
    ).toBe("unsigned");
    expect(
      macSignatureState(
        bundle,
        fakeCodesign(
          { status: 0 },
          { status: 0, stderr: "Signature=adhoc\nTeamIdentifier=not set\n" },
        ),
      ),
    ).toBe("unknown");
    // Tampered, half-signed, or a codesign that would not start.
    expect(
      macSignatureState(
        bundle,
        fakeCodesign({ status: 3, stderr: "a sealed resource is missing" }),
      ),
    ).toBe("unknown");
    expect(macSignatureState(bundle, fakeCodesign({ status: null }))).toBe(
      "unknown",
    );
    expect(
      macSignatureState(
        bundle,
        fakeCodesign({ status: 0 }, { status: 1, stderr: "" }),
      ),
    ).toBe("unknown");
  });
});

describe("the other platforms", () => {
  it("Linux has nothing to read; unpackaged is unsigned", () => {
    expect(signatureState("linux", "/opt/Armadra/armadra", true)).toBe(
      "notApplicable",
    );
    expect(
      signatureState(
        "darwin",
        "/Applications/Armadra.app/Contents/MacOS/Armadra",
        false,
      ),
    ).toBe("unsigned");
    expect(signatureState("freebsd", "/usr/local/bin/armadra", true)).toBe(
      "unknown",
    );
  });
});

/**
 * The real `codesign` on a throwaway bundle: unsigned, then ad-hoc signed
 * (`-s -` uses no identity and no keychain).
 */
describe.runIf(process.platform === "darwin")(
  "codesign on this macOS machine",
  () => {
    let root = "";
    let bundle = "";

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "armadra-codesign-"));
      bundle = join(root, "Probe.app");
      const contents = join(bundle, "Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      writeFileSync(
        join(contents, "Info.plist"),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
          '<plist version="1.0"><dict>' +
          "<key>CFBundleExecutable</key><string>Probe</string>" +
          "<key>CFBundleIdentifier</key><string>dev.armadra.probe</string>" +
          "<key>CFBundlePackageType</key><string>APPL</string>" +
          "</dict></plist>\n",
      );
      writeFileSync(join(contents, "MacOS", "Probe"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("an unsigned bundle is unsigned, an ad-hoc one unknown", () => {
      expect(macSignatureState(bundle)).toBe("unsigned");
      execFileSync("/usr/bin/codesign", ["-s", "-", "--force", bundle], {
        stdio: "pipe",
      });
      expect(macSignatureState(bundle)).toBe("unknown");
    });
  },
);

/**
 * The real thing. A `.ps1` is the smallest file Authenticode signs; the
 * certificate is created for this test in the current user's store and
 * removed again afterwards.
 */
describe.runIf(process.platform === "win32")(
  "Get-AuthenticodeSignature on this Windows machine",
  () => {
    let root = "";
    let thumbprint = "";

    function ps(command: string): string {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'; ${command}`,
        ],
        { encoding: "utf8", timeout: 60_000, env: windowsPowerShellEnv() },
      ).trim();
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "armadra-authenticode-"));
      writeFileSync(join(root, "unsigned.ps1"), "Write-Output 'unsigned'\r\n");
      writeFileSync(join(root, "self-signed.ps1"), "Write-Output 'signed'\r\n");
      thumbprint = ps(
        "$c = New-SelfSignedCertificate -Type CodeSigningCert " +
          "-Subject 'CN=Armadra Test Signing' -CertStoreLocation Cert:\\CurrentUser\\My; " +
          `Set-AuthenticodeSignature -LiteralPath '${join(root, "self-signed.ps1")}' -Certificate $c | Out-Null; ` +
          "$c.Thumbprint",
      );
    }, 120_000);

    afterAll(() => {
      if (thumbprint !== "") {
        ps(
          `Remove-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${thumbprint}' -ErrorAction SilentlyContinue`,
        );
      }
      rmSync(root, { recursive: true, force: true });
    });

    it("a file with no signature is unsigned", () => {
      expect(windowsSignatureState(join(root, "unsigned.ps1"))).toBe(
        "unsigned",
      );
    });

    it("a self-signed certificate is unknown: the chain is not trusted", () => {
      expect(thumbprint).toMatch(/^[0-9A-F]{40}$/);
      expect(windowsSignatureState(join(root, "self-signed.ps1"))).toBe(
        "unknown",
      );
    });
  },
);
