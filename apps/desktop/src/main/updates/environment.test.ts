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

const { signatureState, windowsPowerShellEnv, windowsSignatureState } =
  await import("./environment");

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

describe("the other platforms", () => {
  it("macOS reads _CodeSignature; Linux has nothing to read; unpackaged is unsigned", () => {
    const root = mkdtempSync(join(tmpdir(), "armadra-signature-"));
    try {
      const contents = join(root, "Armadra.app", "Contents");
      const executable = join(contents, "MacOS", "Armadra");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      expect(signatureState("darwin", executable, true)).toBe("unsigned");
      mkdirSync(join(contents, "_CodeSignature"), { recursive: true });
      writeFileSync(join(contents, "_CodeSignature", "CodeResources"), "");
      expect(signatureState("darwin", executable, true)).toBe("signed");
      expect(signatureState("linux", "/opt/Armadra/armadra", true)).toBe(
        "notApplicable",
      );
      expect(signatureState("darwin", executable, false)).toBe("unsigned");
      expect(signatureState("freebsd", "/usr/local/bin/armadra", true)).toBe(
        "unknown",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
