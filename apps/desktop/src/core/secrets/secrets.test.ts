import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { tempDir } from "../testing/temp-dir";
import {
  type IpcChannel,
  type LegacySecret,
  type SecretBackend,
  type SecretSealer,
  type SecurityTool,
  SECRETS_MESSAGE,
  SecretStore,
  SecretUnavailable,
  checkSecretName,
  encryptedFileBackend,
  ipcSealer,
  keychainBackend,
  legacyFile,
  loadOrCreateMasterKey,
  masterKeyId,
  migrateLegacySecrets,
  migrationRecordFile,
  plainFileBackend,
  previousKeyFile,
  readMasterKey,
  resolveSecretBackend,
  rotateMasterKey,
  sealedFileBackend,
  secretsDirectory,
} from "./index";
import { copilotLegacySecrets } from "../usage/service";

const posix = process.platform !== "win32";

/** 内存里的后端：迁移与 store 的用例不碰任何真实存储。 */
function memoryBackend(
  kind: SecretBackend["kind"] = "file",
): SecretBackend & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    kind,
    values,
    async get(name) {
      return values.get(name);
    },
    async set(name, value) {
      values.set(name, value);
    },
    async delete(name) {
      values.delete(name);
    },
  };
}

/**
 * 一个假的 `security(1)`：按 (service, account) 存在内存里，并记下每次调用的参数，
 * 好断言值从不出现在命令行上。
 */
function fakeSecurity(): SecurityTool & {
  entries: Map<string, string>;
  calls: string[][];
} {
  const entries = new Map<string, string>();
  const calls: string[][] = [];
  const key = (args: readonly string[]) => {
    const service = args[args.indexOf("-s") + 1] ?? "";
    const account = args.includes("-a") ? args[args.indexOf("-a") + 1] : "*";
    return `${service}\u0000${account}`;
  };
  const find = (args: readonly string[]) => {
    const wanted = key(args);
    if (entries.has(wanted)) return wanted;
    // 只按 service 找时，任何 account 都算。
    if (!args.includes("-a")) {
      const service = wanted.split("\u0000")[0];
      return [...entries.keys()].find((k) => k.startsWith(`${service}\u0000`));
    }
    return undefined;
  };
  const tool = (async (args: readonly string[], stdin?: string) => {
    calls.push([...args]);
    const [verb] = args;
    if (verb === "find-generic-password") {
      const at = find(args);
      return at === undefined
        ? { code: 44, stdout: "" }
        : { code: 0, stdout: `${entries.get(at)}\n` };
    }
    if (verb === "add-generic-password") {
      const [first, second] = (stdin ?? "").split("\n");
      if (first === second) entries.set(key(args), first ?? "");
      return { code: 0, stdout: "" };
    }
    if (verb === "delete-generic-password") {
      const at = find(args);
      if (at === undefined) return { code: 44, stdout: "" };
      entries.delete(at);
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  }) as SecurityTool & { entries: Map<string, string>; calls: string[][] };
  tool.entries = entries;
  tool.calls = calls;
  return tool;
}

/** 一个可逆的假封存：密文里看不出明文。 */
function fakeSealer(kind: SecretSealer["kind"] = "dpapi"): SecretSealer {
  const flip = (input: Buffer) => Buffer.from(input.map((byte) => byte ^ 0x5a));
  return {
    kind,
    seal: async (plain) => Buffer.concat([Buffer.from("SEAL"), flip(plain)]),
    unseal: async (sealed) => {
      if (sealed.subarray(0, 4).toString() !== "SEAL") throw new Error("bad");
      return flip(sealed.subarray(4));
    },
  };
}

describe("名字", () => {
  it("只收 armadra- 前缀与保守字符集", () => {
    expect(checkSecretName("armadra-github-api@github.com")).toBe(
      "armadra-github-api@github.com",
    );
    for (const bad of [
      "Armadra Copilot",
      "copilot",
      "armadra-../x",
      "armadra-a/b",
      "armadra-",
    ]) {
      expect(() => checkSecretName(bad)).toThrow();
    }
  });
});

describe("明文文件后端", () => {
  it("存取删，0600，删不在的也成功", async () => {
    const dir = join(tempDir("armadra-secrets-"), "secrets");
    const backend = plainFileBackend(dir);
    expect(backend.kind).toBe("file");
    expect(await backend.get("armadra-x")).toBeUndefined();
    await backend.set("armadra-x", "value-1");
    expect(await backend.get("armadra-x")).toBe("value-1");
    if (posix) {
      expect(statSync(join(dir, "armadra-x.token")).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    await backend.delete("armadra-x");
    await backend.delete("armadra-x");
    expect(await backend.get("armadra-x")).toBeUndefined();
  });

  it.runIf(posix)("被放宽过权限的文件不再被信任", async () => {
    const dir = tempDir("armadra-secrets-");
    const backend = plainFileBackend(dir);
    await backend.set("armadra-x", "value-1");
    chmodSync(join(dir, "armadra-x.token"), 0o644);
    await expect(backend.get("armadra-x")).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });
});

describe("壳封存的文件后端（dpapi / libsecret）", () => {
  it("信封里只有密文，并记着是谁封的", async () => {
    const dir = tempDir("armadra-secrets-");
    const backend = sealedFileBackend(dir, fakeSealer("dpapi"));
    expect(backend.kind).toBe("dpapi");
    await backend.set("armadra-x", "plain-value");
    const raw = readFileSync(join(dir, "armadra-x.sealed"), "utf8");
    expect(raw).not.toContain("plain-value");
    expect(JSON.parse(raw)).toMatchObject({ v: 1, kind: "dpapi" });
    expect(await backend.get("armadra-x")).toBe("plain-value");
  });

  it("别的后端封的条目报 sealed_by_<kind>，而不是解密异常", async () => {
    const dir = tempDir("armadra-secrets-");
    await sealedFileBackend(dir, fakeSealer("dpapi")).set("armadra-x", "v");
    const other = sealedFileBackend(dir, fakeSealer("libsecret"));
    await expect(other.get("armadra-x")).rejects.toMatchObject({
      reason: "sealed_by_dpapi",
    });
    const server = encryptedFileBackend({
      directory: dir,
      keyFile: join(dir, "master.key"),
      createKey: true,
    });
    await expect(server.get("armadra-x")).rejects.toMatchObject({
      reason: "sealed_by_dpapi",
    });
  });
});

describe("master key 封装（file-encrypted）", () => {
  function setup() {
    const dataDir = tempDir("armadra-secrets-");
    const directory = secretsDirectory(dataDir);
    const keyFile = join(directory, "master.key");
    return { directory, keyFile };
  }

  it("首次使用生成 0600 的钥匙，条目里没有明文", async () => {
    const { directory, keyFile } = setup();
    const backend = encryptedFileBackend({
      directory,
      keyFile,
      createKey: true,
    });
    expect(backend.kind).toBe("file-encrypted");
    await backend.set("armadra-x", "plain-value");
    expect(existsSync(keyFile)).toBe(true);
    if (posix) expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const raw = readFileSync(join(directory, "armadra-x.sealed"), "utf8");
    expect(raw).not.toContain("plain-value");
    expect(JSON.parse(raw).keyId).toBe(masterKeyId(readMasterKey(keyFile)!));
    expect(await backend.get("armadra-x")).toBe("plain-value");
  });

  it("指到别处的钥匙不在时拒绝，而不是另生成一把", () => {
    const { directory } = setup();
    const keyFile = join(directory, "elsewhere.key");
    expect(() => loadOrCreateMasterKey(keyFile, { create: false })).toThrow();
    expect(existsSync(keyFile)).toBe(false);
    const backend = encryptedFileBackend({
      directory,
      keyFile,
      createKey: false,
    });
    return expect(backend.set("armadra-x", "v")).rejects.toThrow();
  });

  it("换了钥匙（不经轮换）报 unknown_master_key，篡改报 corrupt", async () => {
    const { directory, keyFile } = setup();
    const backend = encryptedFileBackend({
      directory,
      keyFile,
      createKey: true,
    });
    await backend.set("armadra-x", "v");
    const path = join(directory, "armadra-x.sealed");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.data = Buffer.from("tampered").toString("base64");
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    await expect(backend.get("armadra-x")).rejects.toMatchObject({
      reason: "corrupt",
    });
    await backend.set("armadra-x", "v");
    writeFileSync(keyFile, `${Buffer.alloc(32, 7).toString("base64")}\n`, {
      mode: 0o600,
    });
    await expect(backend.get("armadra-x")).rejects.toMatchObject({
      reason: "unknown_master_key",
    });
  });

  it("轮换：每个条目用新钥匙重封，旧钥匙不留", async () => {
    const { directory, keyFile } = setup();
    const backend = encryptedFileBackend({
      directory,
      keyFile,
      createKey: true,
    });
    await backend.set("armadra-a", "value-a");
    await backend.set("armadra-b", "value-b");
    // 别的后端封的条目不归这把钥匙管，原样留着。
    await sealedFileBackend(directory, fakeSealer()).set("armadra-c", "c");
    const before = readFileSync(join(directory, "armadra-c.sealed"), "utf8");
    const old = readMasterKey(keyFile)!;
    const next = Buffer.alloc(32, 9);

    expect(rotateMasterKey({ directory, keyFile }, next)).toBe(2);

    expect(readMasterKey(keyFile)!.equals(next)).toBe(true);
    expect(existsSync(previousKeyFile(keyFile))).toBe(false);
    for (const name of ["armadra-a", "armadra-b"]) {
      const envelope = JSON.parse(
        readFileSync(join(directory, `${name}.sealed`), "utf8"),
      );
      expect(envelope.keyId).toBe(masterKeyId(next));
      expect(envelope.keyId).not.toBe(masterKeyId(old));
    }
    expect(await backend.get("armadra-a")).toBe("value-a");
    expect(await backend.get("armadra-b")).toBe("value-b");
    expect(readFileSync(join(directory, "armadra-c.sealed"), "utf8")).toBe(
      before,
    );
  });

  it("中断的轮换留下 .previous，还没重封的条目照样打得开", async () => {
    const { directory, keyFile } = setup();
    const backend = encryptedFileBackend({
      directory,
      keyFile,
      createKey: true,
    });
    await backend.set("armadra-a", "value-a");
    const old = readMasterKey(keyFile)!;
    // 模拟停在「新钥匙已写、条目还没重封」那一步。
    writeFileSync(previousKeyFile(keyFile), `${old.toString("base64")}\n`, {
      mode: 0o600,
    });
    writeFileSync(keyFile, `${Buffer.alloc(32, 3).toString("base64")}\n`, {
      mode: 0o600,
    });
    expect(await backend.get("armadra-a")).toBe("value-a");
    // 再轮换一次就收尾。
    expect(rotateMasterKey({ directory, keyFile })).toBe(1);
    expect(existsSync(previousKeyFile(keyFile))).toBe(false);
    expect(await backend.get("armadra-a")).toBe("value-a");
  });

  it("有一条打不开就整个放弃轮换，什么都不改", async () => {
    const { directory, keyFile } = setup();
    const backend = encryptedFileBackend({
      directory,
      keyFile,
      createKey: true,
    });
    await backend.set("armadra-a", "value-a");
    const path = join(directory, "armadra-a.sealed");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64");
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    const key = readFileSync(keyFile, "utf8");
    expect(() => rotateMasterKey({ directory, keyFile })).toThrow();
    expect(readFileSync(keyFile, "utf8")).toBe(key);
    expect(existsSync(previousKeyFile(keyFile))).toBe(false);
  });
});

describe("钥匙串后端（假 security(1)）", () => {
  it("名字同时是 service 与 account，值从不上命令行", async () => {
    const tool = fakeSecurity();
    const backend = keychainBackend(tool);
    expect(backend.kind).toBe("keychain");
    await backend.set("armadra-copilot", "gho_secret_value");
    expect(tool.entries.get("armadra-copilot\u0000armadra-copilot")).toBe(
      "gho_secret_value",
    );
    expect(tool.calls.flat()).not.toContain("gho_secret_value");
    expect(await backend.get("armadra-copilot")).toBe("gho_secret_value");
    await backend.delete("armadra-copilot");
    await backend.delete("armadra-copilot");
    expect(await backend.get("armadra-copilot")).toBeUndefined();
  });

  it("工具别的失败报不可用，而不是「没有」", async () => {
    const backend = keychainBackend(async () => ({ code: 1, stdout: "" }));
    await expect(backend.get("armadra-x")).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });
});

describe("IPC 封存（core 那一半）", () => {
  /** 一条假的 fork 通道，另一头用一个函数应答。 */
  function channel(
    reply:
      | ((message: { id: number; op: string; data: string }) => unknown)
      | undefined,
  ): IpcChannel & EventEmitter & { sent: unknown[] } {
    const emitter = new EventEmitter() as IpcChannel &
      EventEmitter & { sent: unknown[]; connected: boolean };
    emitter.sent = [];
    emitter.connected = true;
    emitter.send = (message: unknown) => {
      emitter.sent.push(message);
      const answer = reply?.(
        message as { id: number; op: string; data: string },
      );
      if (answer !== undefined) {
        setImmediate(() => emitter.emit("message", answer));
      }
      return true;
    };
    return emitter;
  }

  it("值走 base64、按 id 对上应答", async () => {
    const sealer = ipcSealer(
      "dpapi",
      channel(({ id, op, data }) => ({
        type: SECRETS_MESSAGE,
        id,
        ok: true,
        data:
          op === "seal"
            ? Buffer.from(`S:${Buffer.from(data, "base64")}`).toString("base64")
            : Buffer.from(
                Buffer.from(data, "base64").toString().slice(2),
              ).toString("base64"),
      })),
    );
    const sealed = await sealer.seal(Buffer.from("hello"));
    expect(sealed.toString()).toBe("S:hello");
    expect((await sealer.unseal(sealed)).toString()).toBe("hello");
  });

  it("壳答失败只带代码；超时与断开都报不可用", async () => {
    const failing = ipcSealer(
      "dpapi",
      channel(({ id }) => ({
        type: SECRETS_MESSAGE,
        id,
        ok: false,
        code: "seal_failed",
      })),
    );
    await expect(failing.seal(Buffer.from("x"))).rejects.toMatchObject({
      reason: "seal_failed",
    });

    const silent = ipcSealer("dpapi", channel(undefined), 20);
    await expect(silent.seal(Buffer.from("x"))).rejects.toMatchObject({
      reason: "shell_timeout",
    });

    const pipe = channel(undefined);
    const dropped = ipcSealer("libsecret", pipe, 5_000);
    const waiting = dropped.seal(Buffer.from("x"));
    pipe.emit("disconnect");
    await expect(waiting).rejects.toMatchObject({
      reason: "shell_disconnected",
    });
    await expect(dropped.seal(Buffer.from("x"))).rejects.toMatchObject({
      reason: "shell_disconnected",
    });
  });
});

describe("挑后端", () => {
  const dataDir = () => tempDir("armadra-secrets-");

  it("ARMADRA_SECRET_BACKEND=file 压过一切", () => {
    const injected = memoryBackend("file-encrypted");
    const resolved = resolveSecretBackend({
      dataDir: dataDir(),
      env: { ARMADRA_SECRET_BACKEND: "file" },
      injected,
      platform: "darwin",
    });
    expect(resolved.backend.kind).toBe("file");
  });

  it("ARMADRA_SECRET_BACKEND=file-encrypted 在数据目录里封存，不碰钥匙串", async () => {
    const dir = dataDir();
    const resolved = resolveSecretBackend({
      dataDir: dir,
      env: { ARMADRA_SECRET_BACKEND: "file-encrypted" },
      platform: "darwin",
      security: () => {
        throw new Error("the keychain must not be touched");
      },
    });
    expect(resolved.backend.kind).toBe("file-encrypted");
    await resolved.backend.set("armadra-probe", "sealed-value");
    await expect(resolved.backend.get("armadra-probe")).resolves.toBe(
      "sealed-value",
    );
  });

  it("壳注入的后端（服务器壳）优先于平台默认", () => {
    const injected = memoryBackend("file-encrypted");
    const resolved = resolveSecretBackend({
      dataDir: dataDir(),
      env: {},
      injected,
      platform: "darwin",
    });
    expect(resolved.backend).toBe(injected);
  });

  it("壳说了 safeStorage 但没有通道：拒绝而不是降级成明文", async () => {
    const resolved = resolveSecretBackend({
      dataDir: dataDir(),
      env: { ARMADRA_SECRET_SEALER: "ipc:dpapi" },
      channel: undefined,
      platform: "win32",
    });
    expect(resolved.backend.kind).toBe("dpapi");
    await expect(resolved.backend.set("armadra-x", "v")).rejects.toBeInstanceOf(
      SecretUnavailable,
    );
  });

  it("有通道时是 sealed 文件；macOS 是钥匙串；其余是文件", () => {
    const pipe = Object.assign(new EventEmitter(), {
      send: () => true,
      connected: true,
    }) as unknown as IpcChannel;
    expect(
      resolveSecretBackend({
        dataDir: dataDir(),
        env: { ARMADRA_SECRET_SEALER: "ipc:libsecret" },
        channel: pipe,
        platform: "linux",
      }).backend.kind,
    ).toBe("libsecret");
    expect(
      resolveSecretBackend({
        dataDir: dataDir(),
        env: {},
        platform: "darwin",
        security: fakeSecurity(),
      }).backend.kind,
    ).toBe("keychain");
    expect(
      resolveSecretBackend({ dataDir: dataDir(), env: {}, platform: "linux" })
        .backend.kind,
    ).toBe("file");
    expect(
      resolveSecretBackend({ dataDir: dataDir(), env: {}, platform: "win32" })
        .backend.kind,
    ).toBe("file");
  });
});

describe("旧名字迁移", () => {
  function legacy(
    id: string,
    to: string,
    value: string | undefined,
  ): LegacySecret & { reads: number; removed: boolean } {
    const item = {
      id,
      to,
      reads: 0,
      removed: false,
      async read() {
        item.reads += 1;
        return item.removed ? undefined : value;
      },
      async remove() {
        item.removed = true;
      },
    };
    return item;
  }

  it("搬、读回确认、删旧的、记下；第二次一个旧位置都不敲", async () => {
    const dataDir = tempDir("armadra-secrets-");
    const record = migrationRecordFile(dataDir);
    const backend = memoryBackend();
    const item = legacy("copilot.file", "armadra-copilot", "old-token");

    const first = await migrateLegacySecrets(backend, [item], record);
    expect(first.moved).toEqual(["copilot.file"]);
    expect(backend.values.get("armadra-copilot")).toBe("old-token");
    expect(item.removed).toBe(true);
    expect(JSON.parse(readFileSync(record, "utf8")).migrated).toEqual([
      "copilot.file",
    ]);

    const again = await migrateLegacySecrets(backend, [item], record);
    expect(again.moved).toEqual([]);
    expect(item.reads).toBe(1);
  });

  it("新位置已经有值时新的为准，只清旧的", async () => {
    const dataDir = tempDir("armadra-secrets-");
    const backend = memoryBackend();
    backend.values.set("armadra-copilot", "new-token");
    const item = legacy("copilot.file", "armadra-copilot", "old-token");
    await migrateLegacySecrets(backend, [item], migrationRecordFile(dataDir));
    expect(backend.values.get("armadra-copilot")).toBe("new-token");
    expect(item.removed).toBe(true);
  });

  it("失败不记下，下次再试；旧值留着", async () => {
    const dataDir = tempDir("armadra-secrets-");
    const record = migrationRecordFile(dataDir);
    const broken: SecretBackend = {
      kind: "dpapi",
      get: async () => undefined,
      set: async () => {
        throw new SecretUnavailable("shell_disconnected");
      },
      delete: async () => undefined,
    };
    const item = legacy("copilot.file", "armadra-copilot", "old-token");
    const result = await migrateLegacySecrets(broken, [item], record);
    expect(result.failed).toEqual(["copilot.file"]);
    expect(item.removed).toBe(false);
    expect(existsSync(record)).toBe(false);

    const healthy = memoryBackend("dpapi");
    const retry = await migrateLegacySecrets(healthy, [item], record);
    expect(retry.moved).toEqual(["copilot.file"]);
    expect(healthy.values.get("armadra-copilot")).toBe("old-token");
  });

  it("Copilot 在 macOS：旧 service 名的钥匙串条目与旧文件都搬到 armadra-copilot", async () => {
    const dataDir = tempDir("armadra-secrets-");
    const tool = fakeSecurity();
    tool.entries.set("Armadra Copilot\u0000Armadra Copilot", "gho_keychain");
    mkdirSync(secretsDirectory(dataDir), { recursive: true });
    const oldFile = join(secretsDirectory(dataDir), "Armadra Copilot.token");
    writeFileSync(oldFile, "gho_file", { mode: 0o600 });
    const resolved = resolveSecretBackend({
      dataDir,
      env: {},
      platform: "darwin",
      security: tool,
    });
    let migrations = 0;
    const store = new SecretStore(resolved.backend, "armadra-copilot", () => {
      migrations += 1;
      return migrateLegacySecrets(
        resolved.backend,
        copilotLegacySecrets(resolved),
        migrationRecordFile(dataDir),
      );
    });

    expect(await store.read()).toBe("gho_keychain");
    expect([...tool.entries.keys()]).toEqual([
      "armadra-copilot\u0000armadra-copilot",
    ]);
    expect(existsSync(oldFile)).toBe(false);
    expect(
      JSON.parse(readFileSync(migrationRecordFile(dataDir), "utf8")).migrated,
    ).toEqual(["copilot.file", "copilot.keychain"]);

    // 幂等：再跑一次，钥匙串里没有任何新的调用打到旧名字上。
    const before = tool.calls.length;
    await migrateLegacySecrets(
      resolved.backend,
      copilotLegacySecrets(resolved),
      migrationRecordFile(dataDir),
    );
    expect(tool.calls.length).toBe(before);
    expect(migrations).toBe(1);
  });

  it("文件后端时不去敲钥匙串", () => {
    const resolved = resolveSecretBackend({
      dataDir: tempDir("armadra-secrets-"),
      env: {},
      platform: "linux",
    });
    expect(copilotLegacySecrets(resolved).map((item) => item.id)).toEqual([
      "copilot.file",
    ]);
  });

  it("legacyFile 读不在的文件是 undefined", async () => {
    const dir = tempDir("armadra-secrets-");
    const item = legacyFile("x", "armadra-x", join(dir, "nope.token"));
    expect(await item.read()).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });
});

/**
 * 真的 DPAPI。core 里的 `safeStorage` 只能在 Electron 主进程里跑，vitest 起不了它；
 * 这里用同一个 OS 原语（`ProtectedData`，CurrentUser 作用域）当封存方，证明信封
 * 能装下真的 DPAPI 密文、并且同一个用户打得开。只在 Windows CI 行跑。
 */
describe.runIf(process.platform === "win32")("DPAPI（Windows）", () => {
  function powershell(script: string, input: string): string {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input, encoding: "utf8" },
    ).trim();
  }
  const dpapi: SecretSealer = {
    kind: "dpapi",
    seal: async (plain) =>
      Buffer.from(
        powershell(
          "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($i),$null,'CurrentUser'))",
          plain.toString("base64"),
        ),
        "base64",
      ),
    unseal: async (sealed) =>
      Buffer.from(
        powershell(
          "Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$null,'CurrentUser'))",
          sealed.toString("base64"),
        ),
        "base64",
      ),
  };

  it("真密文存取", async () => {
    const dir = tempDir("armadra-secrets-");
    const backend = sealedFileBackend(dir, dpapi);
    await backend.set("armadra-x", "dpapi-value");
    expect(readFileSync(join(dir, "armadra-x.sealed"), "utf8")).not.toContain(
      "dpapi-value",
    );
    expect(await backend.get("armadra-x")).toBe("dpapi-value");
  }, 60_000);
});
