import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { tempDir } from "../core/testing/temp-dir";
import { SECRETS_MESSAGE, SEALER_ENV } from "../core/secrets/ipc";
import {
  type SafeStorageLike,
  answer,
  attachSecretChannel,
  secretChannel,
  sealerKind,
  sealerEnvironment,
} from "./secrets";

/** 假的 `safeStorage`：可逆、能指定 Linux 后端与「可用」答什么。 */
function storage(
  options: { available?: boolean; backend?: string } = {},
): SafeStorageLike {
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (text) =>
      Buffer.from(`enc:${Buffer.from(text).toString("hex")}`),
    decryptString: (buffer) => {
      const text = buffer.toString();
      if (!text.startsWith("enc:")) throw new Error("internal detail");
      return Buffer.from(text.slice(4), "hex").toString();
    },
    getSelectedStorageBackend: () => options.backend ?? "unknown",
  };
}

describe("桌面壳能给的封存种类", () => {
  it("Windows：DPAPI 可用才用", () => {
    expect(sealerKind(storage(), "win32")).toBe("dpapi");
    expect(sealerKind(storage({ available: false }), "win32")).toBeUndefined();
  });

  it("Linux：只认 libsecret / kwallet，basic_text 即使答「可用」也拒绝", () => {
    expect(sealerKind(storage({ backend: "gnome_libsecret" }), "linux")).toBe(
      "libsecret",
    );
    expect(sealerKind(storage({ backend: "kwallet5" }), "linux")).toBe(
      "libsecret",
    );
    expect(sealerKind(storage({ backend: "kwallet6" }), "linux")).toBe(
      "libsecret",
    );
    expect(
      sealerKind(storage({ backend: "basic_text", available: true }), "linux"),
    ).toBeUndefined();
    expect(
      sealerKind(storage({ backend: "unknown" }), "linux"),
    ).toBeUndefined();
    expect(
      sealerKind(
        storage({ backend: "gnome_libsecret", available: false }),
        "linux",
      ),
    ).toBeUndefined();
  });

  it("macOS：不用 safeStorage，core 维持 security(1)", () => {
    expect(sealerKind(storage(), "darwin")).toBeUndefined();
  });

  it("环境变量：给不了时清成空串，免得继承来的值让 core 等一个不会应答的壳", () => {
    expect(sealerEnvironment("dpapi")).toEqual({ [SEALER_ENV]: "ipc:dpapi" });
    expect(sealerEnvironment(undefined)).toEqual({});
    expect(
      secretChannel(storage({ backend: "basic_text" }), "linux").environment(),
    ).toEqual({ [SEALER_ENV]: "" });
    expect(secretChannel(storage(), "win32").environment()).toEqual({
      [SEALER_ENV]: "ipc:dpapi",
    });
  });
});

describe("应答", () => {
  it("封与解往返，失败只回代码", () => {
    const sealed = answer(storage(), {
      type: SECRETS_MESSAGE,
      id: 1,
      op: "seal",
      data: Buffer.from("value").toString("base64"),
    });
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    const opened = answer(storage(), {
      type: SECRETS_MESSAGE,
      id: 2,
      op: "unseal",
      data: sealed.data,
    });
    expect(opened).toMatchObject({ id: 2, ok: true });
    if (!opened.ok) return;
    expect(Buffer.from(opened.data, "base64").toString()).toBe("value");

    const failed = answer(storage(), {
      type: SECRETS_MESSAGE,
      id: 3,
      op: "unseal",
      data: Buffer.from("garbage").toString("base64"),
    });
    expect(failed).toEqual({
      type: SECRETS_MESSAGE,
      id: 3,
      ok: false,
      code: "unseal_failed",
    });
    expect(JSON.stringify(failed)).not.toContain("internal detail");
  });

  it("经真的 fork 通道：core 那一半的 ipcSealer 拿到壳封的密文再解回来", async () => {
    // 子进程里跑 core 那一半的最小版本：同一条线上形状，打印往返结果。
    const dir = tempDir("armadra-secrets-ipc-");
    const script = join(dir, "child.cjs");
    writeFileSync(
      script,
      `
      let next = 1;
      const pending = new Map();
      process.on("message", (m) => {
        const w = pending.get(m.id);
        if (w) { pending.delete(m.id); w(m); }
      });
      const call = (op, data) => new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        process.send({ type: ${JSON.stringify(SECRETS_MESSAGE)}, id, op, data });
      });
      (async () => {
        const sealed = await call("seal", Buffer.from("round-trip").toString("base64"));
        const opened = await call("unseal", sealed.data);
        process.stdout.write(JSON.stringify({
          sealedHasPlain: Buffer.from(sealed.data, "base64").toString().includes("round-trip"),
          opened: Buffer.from(opened.data, "base64").toString(),
        }));
        process.disconnect();
      })();
      `,
    );
    const child = fork(script, [], { silent: true });
    attachSecretChannel(child, storage());
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    await new Promise((done) => child.on("exit", done));
    expect(JSON.parse(output)).toEqual({
      sealedHasPlain: false,
      opened: "round-trip",
    });
  });
});
