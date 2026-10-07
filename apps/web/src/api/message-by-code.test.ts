import { describe, expect, it } from "vitest";

import { isRegisteredErrorCode } from "@armadra/shared";

import { localizedFailure } from "./request";

/**
 * GitHub 面的错误码换成 snake_case（契约 §41.1）之后，页面在一个 minor 里两种
 * 拼法都认：大写拼法（还没升级的 core）与 snake_case（现在的码）取同一句话。
 */
const SPELLINGS: readonly (readonly [string, string])[] = [
  ["UNAUTHENTICATED", "unauthenticated"],
  ["PERMISSION_DENIED", "forbidden"],
  ["NOT_FOUND", "not_found"],
  ["CONFLICT", "conflict"],
  ["INVALID_ARGUMENT", "bad_request"],
  ["RESOURCE_EXHAUSTED", "rate_limited"],
  ["UNSUPPORTED", "unsupported"],
  ["UNKNOWN_OUTCOME", "unknown_outcome"],
];

describe("MESSAGE_BY_CODE：两种拼法互相映射", () => {
  for (const [upper, snake] of SPELLINGS) {
    it(`${upper} 与 ${snake} 是同一句话，且都认得`, () => {
      const fallback = "core 的原话";
      const fromUpper = localizedFailure(upper, fallback);
      const fromSnake = localizedFailure(snake, fallback);
      expect(fromUpper).not.toBe(fallback);
      expect(fromUpper).toBe(fromSnake);
      // 新拼法是注册表里的码。
      expect(isRegisteredErrorCode(snake)).toBe(true);
    });
  }

  it("认不出的码仍用 core 给的那句", () => {
    expect(localizedFailure("SOMETHING_ELSE", "原话")).toBe("原话");
    expect(localizedFailure(undefined, "原话")).toBe("原话");
  });
});
