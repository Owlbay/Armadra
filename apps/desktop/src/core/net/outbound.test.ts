import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NOT_DIALLED, OUTBOUND, isRegistered } from "./outbound";

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...sources(path));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

/**
 * RFC 2606 / 6761 的保留名字永远不会被真的连到；没有点的「主机」是模板
 * （`https://host/path`），不是地址。
 */
function isRealHost(host: string): boolean {
  if (!host.includes(".")) return false;
  if (/[$<>{}]/.test(host)) return false;
  const labels = host.toLowerCase().split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (["example", "test", "invalid", "localhost", "local"].includes(tld)) {
    return false;
  }
  const second = labels.slice(-2).join(".");
  return !["example.com", "example.net", "example.org"].includes(second);
}

const LITERAL = /https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\-/]*)?/g;

describe("出站地址表", () => {
  it("core 源码里指向真实主机的 https 字面量都在表里", () => {
    const unregistered: string[] = [];
    const seen = new Set<string>();
    for (const file of sources(coreRoot)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(LITERAL)) {
        // 注释里句末的句点不是地址的一部分。
        const literal = match[0].replace(/\.+$/, "");
        let host: string;
        try {
          host = new URL(literal).hostname;
        } catch {
          continue;
        }
        if (!isRealHost(host)) continue;
        seen.add(literal);
        if (!isRegistered(literal)) {
          unregistered.push(`${relative(coreRoot, file)}: ${literal}`);
        }
      }
    }
    expect(unregistered).toEqual([]);
    // 扫描本身不能是空转：表里的地址至少要被扫到。
    expect(seen).toContain(OUTBOUND.modelsCatalog.url);
    expect(seen).toContain(OUTBOUND.githubApi.url);
  });

  it("每条都写了用途与频率，开关指向设置键", () => {
    for (const [id, entry] of Object.entries(OUTBOUND)) {
      // 只有邮件通道不是 HTTPS：SMTP 是它自己的协议（契约 §28）。
      expect(/^(https|smtp):\/\//.test(entry.url), id).toBe(true);
      expect(entry.purpose, id).not.toBe("");
      expect(entry.cadence, id).not.toBe("");
      if (entry.switch !== null) {
        expect(entry.switch, id).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
      }
    }
  });

  it("借用登录令牌的两个额度端点默认关，Codex 默认开但标为非官方", () => {
    expect(OUTBOUND.claudeUsage.defaultOn).toBe(false);
    expect(OUTBOUND.copilotUsage.defaultOn).toBe(false);
    expect(OUTBOUND.copilotDeviceFlow.defaultOn).toBe(false);
    expect(OUTBOUND.codexUsage.defaultOn).toBe(true);
    expect(OUTBOUND.codexUsage.documented).toBe(false);
  });

  it("崩溃上报：DSN 为空即关，缺省关（外部服务 §11.2）", () => {
    expect(OUTBOUND.crashReport.switch).toBe("diagnostics.crashReportDsn");
    expect(OUTBOUND.crashReport.defaultOn).toBe(false);
  });

  it("邮件通道：不配置即不联网，地址是用户给的", () => {
    expect(OUTBOUND.smtp.switch).toBeNull();
    expect(OUTBOUND.smtp.defaultOn).toBe(false);
    expect(OUTBOUND.smtp.url.startsWith("smtp://")).toBe(true);
  });

  it("未登记的地址不算登记，前缀只按路径边界匹配", () => {
    expect(isRegistered("https://models.dev/api.json")).toBe(true);
    expect(isRegistered("https://api.github.com/repos/o/r")).toBe(true);
    expect(isRegistered("https://api.github.com.evil.io/x")).toBe(false);
    expect(isRegistered("https://telemetry.invalid.io/")).toBe(false);
    for (const literal of Object.keys(NOT_DIALLED)) {
      expect(isRegistered(literal)).toBe(true);
    }
  });
});
