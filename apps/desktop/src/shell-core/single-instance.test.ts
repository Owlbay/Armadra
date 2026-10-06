import path from "node:path";
import { describe, expect, it } from "vitest";

import { instanceProfileDir, joinLinkOfData } from "./single-instance";

const posix = path.posix;
const win = path.win32;

describe("单实例锁按数据目录分", () => {
  it("没指数据目录：用 Electron 默认的 profile（同一把锁）", () => {
    expect(instanceProfileDir([], { HOME: "/home/a" }, "linux", posix)).toBe(
      null,
    );
    expect(
      instanceProfileDir(
        [],
        { HOME: "/home/a", ARMADRA_DATA_DIR: "" },
        "linux",
        posix,
      ),
    ).toBe(null);
  });

  it("指了别的数据目录：profile 放进它的 electron/，不同目录不同锁", () => {
    const a = instanceProfileDir(
      [],
      { HOME: "/home/a", ARMADRA_DATA_DIR: "/tmp/one" },
      "linux",
      posix,
    );
    const b = instanceProfileDir(
      [],
      { HOME: "/home/a", ARMADRA_DATA_DIR: "/tmp/two/" },
      "linux",
      posix,
    );
    expect(a).toBe("/tmp/one/electron");
    expect(b).toBe("/tmp/two/electron");
    expect(
      instanceProfileDir(
        [],
        {
          LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
          ARMADRA_DATA_DIR: "D:\\data",
        },
        "win32",
        win,
      ),
    ).toBe("D:\\data\\electron");
  });

  it("指的就是默认数据目录：与不带变量起的实例共用一把锁", () => {
    expect(
      instanceProfileDir(
        [],
        {
          HOME: "/Users/a",
          ARMADRA_DATA_DIR: "/Users/a/Library/Application Support/Armadra",
        },
        "darwin",
        posix,
      ),
    ).toBe(null);
    expect(
      instanceProfileDir(
        [],
        { HOME: "/home/a", ARMADRA_DATA_DIR: "/home/a/.local/share/armadra" },
        "linux",
        posix,
      ),
    ).toBe(null);
  });

  it("命令行给了 --user-data-dir（探针）时不改", () => {
    const env = { HOME: "/home/a", ARMADRA_DATA_DIR: "/tmp/one" };
    expect(
      instanceProfileDir(
        ["electron", "--user-data-dir=/tmp/p"],
        env,
        "linux",
        posix,
      ),
    ).toBe(null);
    expect(
      instanceProfileDir(
        ["electron", "--user-data-dir", "/tmp/p"],
        env,
        "linux",
        posix,
      ),
    ).toBe(null);
  });

  it("交接数据里的深链只认字符串", () => {
    expect(joinLinkOfData({ joinLink: "armadra://join?x" })).toBe(
      "armadra://join?x",
    );
    expect(joinLinkOfData({ joinLink: null })).toBe(null);
    expect(joinLinkOfData({ joinLink: 1 })).toBe(null);
    expect(joinLinkOfData(undefined)).toBe(null);
    expect(joinLinkOfData("x")).toBe(null);
  });
});
