import { describe, expect, it } from "vitest";

import type { IdentitySession } from "../api/identity";
import { accessOf, canAnswerFor } from "./use-access";

/**
 * 页面据以摆不摆入口的那份判定：owner 全权；成员按会话里「快照 ∪ 现编的共享」
 * 逐块画布回答；没登录、还没取回来都按成员算。
 */

function session(
  role: string,
  scopes: { permission: string; workspaceId?: string }[],
): IdentitySession {
  return {
    hostId: "h".repeat(32),
    device: {
      deviceId: "d".repeat(32),
      principalId: "p".repeat(32),
      displayName: "",
      role,
      createdAtUnixMs: 1,
      revision: 1,
    },
    scopes: scopes.map((scope) => ({
      permission: scope.permission,
      workspaceId: scope.workspaceId ?? "",
      executionHostId: "",
    })),
    expiresAtUnixMs: 0,
  };
}

describe("accessOf", () => {
  it("owner 什么都能做", () => {
    const access = accessOf(session("owner", []));
    expect(access.member).toBe(false);
    expect(access.can("approval:answer", "w1")).toBe(true);
  });

  it("成员按画布上的授权回答", () => {
    const access = accessOf(
      session("member", [
        { permission: "identity:read" },
        { permission: "canvas:read", workspaceId: "w1" },
        { permission: "approval:answer", workspaceId: "w1" },
      ]),
    );
    expect(access.member).toBe(true);
    expect(access.can("approval:answer", "w1")).toBe(true);
    expect(access.can("approval:answer", "w2")).toBe(false);
    expect(access.can("settings:write")).toBe(false);
  });

  it("没登录与还没取回来都按成员算", () => {
    expect(accessOf(null).member).toBe(true);
    expect(accessOf(undefined).can("canvas:read", "w1")).toBe(false);
  });
});

/**
 * 审批按钮（契约 §23）：driver 什么都答得了；operator 只答自己起的终端上的；
 * editor 自己起不了终端，也就没有「自己的」。
 */
describe("canAnswerFor", () => {
  const ME = "p".repeat(32);
  const OTHER = "q".repeat(32);
  const role = (name: string, permissions: string[]) =>
    accessOf(
      session(
        name === "owner" ? "owner" : "member",
        permissions.map((permission) => ({ permission, workspaceId: "w1" })),
      ),
    );
  const OPERATOR = ["canvas:read", "canvas:write", "terminal:create"];
  const DRIVER = [...OPERATOR, "terminal:drive", "approval:answer"];

  it("owner 与 driver 不看创建者", () => {
    expect(canAnswerFor(role("owner", []), "w1", undefined)).toBe(true);
    expect(canAnswerFor(role("driver", DRIVER), "w1", OTHER)).toBe(true);
    expect(canAnswerFor(role("driver", DRIVER), "w2", OTHER)).toBe(false);
  });

  it("operator 只答自己起的；创建者还没取回来时不摆", () => {
    const operator = role("operator", OPERATOR);
    expect(canAnswerFor(operator, "w1", ME)).toBe(true);
    expect(canAnswerFor(operator, "w1", OTHER)).toBe(false);
    // 空串是本机 owner 起的（自动化冷启动、owner 的协调者）。
    expect(canAnswerFor(operator, "w1", "")).toBe(false);
    expect(canAnswerFor(operator, "w1", undefined)).toBe(false);
    // 换到一块他只是 viewer 的画布上，自己的也不行。
    expect(canAnswerFor(operator, "w2", ME)).toBe(false);
  });

  it("editor 与 viewer 一律不摆", () => {
    expect(
      canAnswerFor(role("editor", ["canvas:read", "canvas:write"]), "w1", ME),
    ).toBe(false);
    expect(canAnswerFor(role("viewer", ["canvas:read"]), "w1", ME)).toBe(false);
  });
});
