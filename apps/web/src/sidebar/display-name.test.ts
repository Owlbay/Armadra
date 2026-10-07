import { describe, expect, it } from "vitest";

import { displayName } from "./display-name";

const t = ((key: string) =>
  key === "sidebar.defaultName" ? "默认" : key) as never;

describe("displayName", () => {
  it("core 建的默认名按当前语言显示", () => {
    expect(displayName("Default", t)).toBe("默认");
  });

  it("用户起的名字原样显示", () => {
    expect(displayName("实验", t)).toBe("实验");
    expect(displayName("default", t)).toBe("default");
  });
});
