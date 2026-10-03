import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CdpConnection } from "./connection";
import { spawnChromium, type BrowserProcess } from "./process";

/**
 * A browser that logs a lot before it answers.
 *
 * Chromium writes to stderr whenever it likes. When that went into a pipe
 * nobody read, the pipe filled, the next log line blocked, and the CDP pipe
 * stopped with it: the first command timed out on a Windows runner. The stand-
 * in here writes two megabytes to stderr and only then echoes the CDP pipe
 * back (a command echoed with its id reads as that command's answer).
 */

let scratch = "";
let browser: BrowserProcess | undefined;

afterEach(() => {
  browser?.kill();
  browser = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe.skipIf(process.platform === "win32")("the browser process", () => {
  it(
    "keeps answering after it has logged more than a pipe holds",
    { timeout: 20_000 },
    async () => {
      scratch = mkdtempSync(join(tmpdir(), "armadra-chatty-browser-"));
      const executable = join(scratch, "chatty-browser");
      writeFileSync(
        executable,
        "#!/bin/sh\nhead -c 2000000 /dev/zero | tr '\\0' x >&2\nexec cat <&3 >&4\n",
      );
      chmodSync(executable, 0o755);
      browser = spawnChromium({
        executable,
        profileDir: join(scratch, "profile"),
        width: 800,
        height: 600,
      });
      const connection = new CdpConnection(browser.write, browser.read);
      await expect(
        connection.send("Target.setDiscoverTargets", { discover: true }),
      ).resolves.toBeNull();
      connection.close();
    },
  );
});
