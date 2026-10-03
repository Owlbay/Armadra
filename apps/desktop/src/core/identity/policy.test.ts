import { describe, expect, it } from "vitest";
import { IdentityRefusal, identityFailure } from "./errors";
import {
  checkBreach,
  commonPasswords,
  effectiveMinLength,
  enforcePasswordPolicy,
  passwordViolation,
} from "./policy";

describe("口令策略", () => {
  it("随包的常见口令表有一万条，注释行不算", () => {
    const list = commonPasswords();
    expect(list.size).toBe(10_000);
    expect(list.has("password123")).toBe(true);
    expect([...list].some((entry) => entry.startsWith("#"))).toBe(false);
  });

  it("长度按码点数，下限可配 10–64、越界夹回", () => {
    expect(effectiveMinLength(undefined)).toBe(12);
    expect(effectiveMinLength(4)).toBe(10);
    expect(effectiveMinLength(99)).toBe(64);
    expect(effectiveMinLength(12.5)).toBe(12);
    expect(passwordViolation("短短短短短短短短短短短", {})).toBe(
      "password_too_short",
    );
    expect(passwordViolation("长长长长长长长长长长长长", {})).toBeUndefined();
    expect(passwordViolation("ten chars!", { minLength: 10 })).toBeUndefined();
    expect(passwordViolation("ten chars!", {})).toBe("password_too_short");
  });

  it("不得含账号名，不分大小写；三个字符以下的名字不参与", () => {
    expect(passwordViolation("my-Alice-is-long", { names: ["alice"] })).toBe(
      "password_contains_name",
    );
    expect(
      passwordViolation("ab-is-long-enough", { names: ["ab"] }),
    ).toBeUndefined();
  });

  it("常见口令按小写精确比对", () => {
    expect(passwordViolation("Password123", { minLength: 10 })).toBe(
      "password_too_common",
    );
    expect(passwordViolation("QwertyUIOP", { minLength: 10 })).toBe(
      "password_too_common",
    );
    expect(passwordViolation("correct horse battery", {})).toBeUndefined();
  });

  it("拒绝是 400，code 就是规则名", () => {
    let caught: unknown;
    try {
      enforcePasswordPolicy("password1234", { minLength: 10 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityRefusal);
    expect(identityFailure(caught)).toMatchObject({
      status: 400,
      code: "password_too_common",
    });
  });

  it("泄露检查的调用点在，实现留给 G3-8", async () => {
    await expect(checkBreach("anything at all")).resolves.toBe("skipped");
  });
});
