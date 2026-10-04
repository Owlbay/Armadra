import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { previousKeyFile } from "../../desktop/src/core/secrets";
import { tempDir } from "../../desktop/src/core/testing/temp-dir";
import {
  loopbackHost,
  many,
  parseCommandLine,
  parseListen,
  single,
  switched,
} from "./cli";
import { main } from "./main";
import { masterKeyFile, serverSecrets } from "./secrets";

describe("命令行", () => {
  it("没有参数时打印帮助", () => {
    expect(parseCommandLine([]).kind).toBe("help");
    expect(parseCommandLine(["--help"]).kind).toBe("help");
    expect(parseCommandLine(["serve", "-h"]).kind).toBe("help");
  });

  it("拒绝没见过的子命令与 flag", () => {
    expect(parseCommandLine(["start"])).toMatchObject({ kind: "error" });
    // `--run-as` 是 install 的，serve 不认——被忽略的选项比一个错误危险得多。
    expect(parseCommandLine(["serve", "--run-as", "root"])).toMatchObject({
      kind: "error",
    });
  });

  it("`--flag value` 与 `--flag=value` 是同一个 flag", () => {
    const first = parseCommandLine(["serve", "--listen", "0.0.0.0:8443"]);
    const second = parseCommandLine(["serve", "--listen=0.0.0.0:8443"]);
    if (first.kind !== "run" || second.kind !== "run")
      throw new Error("解析失败");
    expect(single(first.values, "--listen")).toBe("0.0.0.0:8443");
    expect(single(second.values, "--listen")).toBe("0.0.0.0:8443");
  });

  it("只有可重复的 flag 能给两次", () => {
    const parsed = parseCommandLine([
      "serve",
      "--public-origin",
      "https://a.example",
      "--public-origin",
      "https://b.example",
    ]);
    if (parsed.kind !== "run") throw new Error("解析失败");
    expect(many(parsed.values, "--public-origin")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(
      parseCommandLine(["serve", "--listen", "a:1", "--listen", "b:2"]),
    ).toMatchObject({ kind: "error" });
  });

  it("开关不带值，缺值是错误", () => {
    const parsed = parseCommandLine(["upgrade", "--rollback", "--confirm"]);
    if (parsed.kind !== "run") throw new Error("解析失败");
    expect(switched(parsed.values, "--rollback")).toBe(true);
    expect(switched(parsed.values, "--confirm")).toBe(true);
    expect(parseCommandLine(["upgrade", "--rollback=1"])).toMatchObject({
      kind: "error",
    });
    expect(parseCommandLine(["logs", "--lines"])).toMatchObject({
      kind: "error",
    });
  });

  it("监听地址：IPv4、IPv6 与拒绝的写法", () => {
    expect(parseListen("127.0.0.1:0")).toEqual({ host: "127.0.0.1", port: 0 });
    expect(parseListen("[::1]:8443")).toEqual({ host: "::1", port: 8443 });
    expect(parseListen("0.0.0.0:65535")).toEqual({
      host: "0.0.0.0",
      port: 65535,
    });
    expect(parseListen("127.0.0.1")).toBeUndefined();
    expect(parseListen("127.0.0.1:70000")).toBeUndefined();
    expect(parseListen(":8443")).toBeUndefined();
  });

  it("回环只认字面量，主机名不算", () => {
    expect(loopbackHost("127.0.0.1")).toBe(true);
    expect(loopbackHost("127.0.0.53")).toBe(true);
    expect(loopbackHost("::1")).toBe(true);
    expect(loopbackHost("localhost")).toBe(true);
    // 别人的 /etc/hosts 说了算的东西不是回环。
    expect(loopbackHost("local.example")).toBe(false);
    expect(loopbackHost("0.0.0.0")).toBe(false);
  });
});

describe("secrets 子命令与邮件 flag 的解析", () => {
  it("secrets 认位置参数，别的子命令仍然不认", () => {
    expect(parseCommandLine(["secrets", "rotate"])).toMatchObject({
      kind: "run",
      command: "secrets",
      positionals: ["rotate"],
    });
    expect(
      parseCommandLine(["secrets", "set", "armadra-smtp", "--data-dir", "/d"]),
    ).toMatchObject({ kind: "run", positionals: ["set", "armadra-smtp"] });
    expect(parseCommandLine(["secrets", "set", "a", "b"])).toMatchObject({
      kind: "error",
    });
    expect(parseCommandLine(["status", "rotate"])).toMatchObject({
      kind: "error",
    });
  });

  it("serve 认 --smtp-url 与 --smtp-from", () => {
    const parsed = parseCommandLine([
      "serve",
      "--smtp-url",
      "smtps://bot@x.test:secret://armadra-smtp@mail.x.test",
      "--smtp-from=noreply@x.test",
    ]);
    if (parsed.kind !== "run") throw new Error("解析失败");
    expect(single(parsed.values, "--smtp-url")).toBe(
      "smtps://bot@x.test:secret://armadra-smtp@mail.x.test",
    );
    expect(single(parsed.values, "--smtp-from")).toBe("noreply@x.test");
  });
});

const here = dirname(fileURLToPath(import.meta.url));

async function cli(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: string } = {},
) {
  let out = "";
  let err = "";
  const code = await main(argv, {
    stdout: (line) => {
      out += line;
    },
    stderr: (line) => {
      err += line;
    },
    env: options.env ?? {},
    moduleDir: here,
    ...(options.stdin === undefined
      ? {}
      : { stdin: async () => options.stdin as string }),
  });
  return { code, out, err };
}

describe("secrets rotate / set", () => {
  it("set 从标准输入写条目，值不进输出；rotate 换钥匙后条目照样读得出", async () => {
    const dataDir = tempDir("armadra-secrets-cli-");
    expect((await cli(["secrets", "rotate", "--data-dir", dataDir])).code).toBe(
      1,
    );
    const set = await cli(
      ["secrets", "set", "armadra-smtp", "--data-dir", dataDir],
      {
        stdin: "smtp-pass-1\n",
      },
    );
    expect(set.code).toBe(0);
    expect(set.out).toContain("armadra-smtp");
    expect(set.out + set.err).not.toContain("smtp-pass-1");
    const key = masterKeyFile(dataDir, {}).path;
    const before = readFileSync(key, "utf8");

    const rotated = await cli([
      "secrets",
      "rotate",
      "--data-dir",
      dataDir,
      "--output",
      "json",
    ]);
    expect(rotated.code).toBe(0);
    expect(JSON.parse(rotated.out)).toMatchObject({
      command: "secrets rotate",
      resealed: 1,
      resumed: false,
    });
    expect(readFileSync(key, "utf8")).not.toBe(before);
    expect(existsSync(previousKeyFile(key))).toBe(false);
    await expect(serverSecrets(dataDir, {}).get("armadra-smtp")).resolves.toBe(
      "smtp-pass-1",
    );
  });

  it("中途中断（新钥匙已写、条目还是旧钥匙封的）：再跑一次做完", async () => {
    const dataDir = tempDir("armadra-secrets-cli-");
    await serverSecrets(dataDir, {}).set("armadra-smtp", "smtp-pass-2");
    const key = masterKeyFile(dataDir, {}).path;
    // 照 `rotateMasterKey` 的顺序停在「旧钥匙留成 .previous、新钥匙已写」之后。
    writeFileSync(previousKeyFile(key), readFileSync(key), { mode: 0o600 });
    writeFileSync(key, `${randomBytes(32).toString("base64")}\n`);
    const resumed = await cli(["secrets", "rotate", "--data-dir", dataDir]);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain("接着上次中断的轮换做完");
    expect(existsSync(previousKeyFile(key))).toBe(false);
    await expect(serverSecrets(dataDir, {}).get("armadra-smtp")).resolves.toBe(
      "smtp-pass-2",
    );
  });

  it("拒绝的用法", async () => {
    const dataDir = tempDir("armadra-secrets-cli-");
    expect((await cli(["secrets", "--data-dir", dataDir])).code).toBe(2);
    expect(
      (await cli(["secrets", "rotate", "now", "--data-dir", dataDir])).code,
    ).toBe(2);
    expect(
      (
        await cli(["secrets", "set", "smtp", "--data-dir", dataDir], {
          stdin: "x",
        })
      ).code,
    ).toBe(2);
    expect(
      (
        await cli(["secrets", "set", "armadra-smtp", "--data-dir", dataDir], {
          stdin: "\n",
        })
      ).code,
    ).toBe(2);
    expect(
      (
        await cli(["secrets", "rotate", "--data-dir", dataDir], {
          env: { ARMADRA_SECRET_BACKEND: "file" },
        })
      ).code,
    ).toBe(2);
    // 什么都没写出来。
    expect(
      existsSync(join(dataDir, "secrets"))
        ? readdirSync(join(dataDir, "secrets"))
        : [],
    ).toEqual([]);
  });
});
