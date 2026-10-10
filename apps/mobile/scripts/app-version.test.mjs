import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  ANDROID_VERSION_FILE,
  IOS_VERSION_FILE,
  MAX_BUILD_NUMBER,
  buildNumber,
  mobileVersion,
  nativeVersionFiles,
  parseMobileVersion,
  writeNativeVersion,
} from "./app-version.mjs";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(mobileRoot, path), "utf8");

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** 只有 package.json 与两个原生目录的手机壳副本。 */
function shell(version) {
  const root = mkdtempSync(join(tmpdir(), "armadra-mobile-version-"));
  dirs.push(root);
  mkdirSync(join(root, "ios"));
  mkdirSync(join(root, "android/app"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

/** 一个按 `{ 命令: 输出 }` 回答的假 git。 */
function fakeGit(answers) {
  return (args) => {
    const key = args.join(" ");
    if (!(key in answers)) throw new Error(`unexpected git ${key}`);
    return answers[key];
  };
}

const FULL_CLONE = {
  "rev-parse --is-shallow-repository": "false",
  "rev-list --count HEAD": "3185",
};

describe("移动端版本名", () => {
  it("商店版本名取 X.Y.Z，预发布后缀去掉", () => {
    expect(parseMobileVersion("1.0.0")).toBe("1.0.0");
    expect(parseMobileVersion("0.3.0-beta.1")).toBe("0.3.0");
    expect(() => parseMobileVersion("1.0")).toThrow();
    expect(() => parseMobileVersion("01.0.0")).toThrow();
  });

  it("仓库里的版本与桌面套件同一条线", () => {
    const desktop = JSON.parse(
      readFileSync(join(mobileRoot, "../../package.json"), "utf8"),
    ).version;
    const mobile = mobileVersion();
    expect(mobile).toBe(desktop);
  });
});

describe("构建号", () => {
  it("ARMADRA_BUILD_NUMBER 优先，不问 git", () => {
    expect(
      buildNumber({
        env: { ARMADRA_BUILD_NUMBER: "4021" },
        git: () => {
          throw new Error("should not run git");
        },
      }),
    ).toBe(4021);
  });

  it("没给时取提交数：同一提交同一个数", () => {
    const git = fakeGit(FULL_CLONE);
    expect(buildNumber({ env: {}, git })).toBe(3185);
    expect(buildNumber({ env: {}, git })).toBe(3185);
  });

  it("提交越多号越大", () => {
    const later = fakeGit({ ...FULL_CLONE, "rev-list --count HEAD": "3186" });
    expect(buildNumber({ env: {}, git: later })).toBeGreaterThan(
      buildNumber({ env: {}, git: fakeGit(FULL_CLONE) }),
    );
  });

  it("浅克隆拒绝，不写一个偏小的号", () => {
    const git = fakeGit({
      ...FULL_CLONE,
      "rev-parse --is-shallow-repository": "true",
      "rev-list --count HEAD": "1",
    });
    expect(() => buildNumber({ env: {}, git })).toThrow(/fetch-depth: 0/);
  });

  it("不在 git 里又没给号就报错", () => {
    expect(() =>
      buildNumber({
        env: {},
        git: () => {
          throw new Error("not a git repository");
        },
      }),
    ).toThrow(/ARMADRA_BUILD_NUMBER/);
  });

  it("号必须是不超过 Android 上限的正整数", () => {
    for (const bad of ["0", "-3", "12a", "1.5", String(MAX_BUILD_NUMBER + 1)])
      expect(() =>
        buildNumber({ env: { ARMADRA_BUILD_NUMBER: bad }, git: () => "" }),
      ).toThrow();
    expect(
      buildNumber({ env: { ARMADRA_BUILD_NUMBER: String(MAX_BUILD_NUMBER) } }),
    ).toBe(MAX_BUILD_NUMBER);
  });

  it("真 git：在这个检出里数得出（CI 的单测作业也可能是浅克隆）", () => {
    let counted = 0;
    try {
      counted = buildNumber({ env: {} });
    } catch (error) {
      expect(String(error)).toMatch(/fetch-depth: 0|ARMADRA_BUILD_NUMBER/);
      return;
    }
    expect(counted).toBeGreaterThan(0);
  });
});

describe("写给原生工程", () => {
  it("两份文件带同一个版本名与构建号", () => {
    const files = nativeVersionFiles({ version: "1.2.3", build: 77 });
    expect(files[IOS_VERSION_FILE]).toMatch(/^MARKETING_VERSION = 1\.2\.3$/m);
    expect(files[IOS_VERSION_FILE]).toMatch(/^CURRENT_PROJECT_VERSION = 77$/m);
    expect(files[ANDROID_VERSION_FILE]).toMatch(/^versionName=1\.2\.3$/m);
    expect(files[ANDROID_VERSION_FILE]).toMatch(/^versionCode=77$/m);
  });

  it("从 package.json 写出两份文件", () => {
    const root = shell("2.4.6");
    const result = writeNativeVersion({
      root,
      env: { ARMADRA_BUILD_NUMBER: "512" },
    });
    expect(result).toEqual({ version: "2.4.6", build: 512 });
    expect(readFileSync(join(root, IOS_VERSION_FILE), "utf8")).toContain(
      "MARKETING_VERSION = 2.4.6",
    );
    expect(readFileSync(join(root, ANDROID_VERSION_FILE), "utf8")).toContain(
      "versionCode=512",
    );
  });

  it("预发布版本写成核心 X.Y.Z，构建号区分", () => {
    const root = shell("1.1.0-rc.1");
    expect(
      writeNativeVersion({ root, env: { ARMADRA_BUILD_NUMBER: "1" } }),
    ).toEqual({ version: "1.1.0", build: 1 });
  });

  it("不是 semver 的版本写不出去", () => {
    const root = shell("1.1");
    expect(() =>
      writeNativeVersion({ root, env: { ARMADRA_BUILD_NUMBER: "1" } }),
    ).toThrow(/X\.Y\.Z/);
  });

  it("两份生成文件都不入库", () => {
    const ignore = readFileSync(join(mobileRoot, "../../.gitignore"), "utf8");
    expect(ignore).toContain(`apps/mobile/${IOS_VERSION_FILE}`);
    expect(ignore).toContain(`apps/mobile/${ANDROID_VERSION_FILE}`);
  });

  it("sync 先写版本再 cap sync", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(
      scripts.sync.indexOf("app-version.mjs write"),
    ).toBeGreaterThanOrEqual(0);
    expect(scripts.sync.indexOf("app-version.mjs write")).toBeLessThan(
      scripts.sync.indexOf("cap sync"),
    );
  });
});

/**
 * xcconfig 的 `#include` 解析（只解这里用得到的：`#include "相对路径"` 与 `KEY = value`），
 * 用来证明工程的版本只从生成的那份文件来。
 */
function resolveXcconfig(path, seen = new Set()) {
  if (seen.has(path)) throw new Error(`include loop at ${path}`);
  seen.add(path);
  const settings = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const include = /^#include\??\s+"([^"]+)"/.exec(line.trim());
    if (include) {
      Object.assign(
        settings,
        resolveXcconfig(join(dirname(path), include[1]), seen),
      );
      continue;
    }
    const setting = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line.trim());
    if (setting) settings[setting[1]] = setting[2];
  }
  return settings;
}

describe("iOS 工程", () => {
  const pbxproj = read("ios/App/App.xcodeproj/project.pbxproj");

  it("目标与工程的构建设置里不再写死版本", () => {
    expect(pbxproj).not.toMatch(/MARKETING_VERSION\s*=/);
    expect(pbxproj).not.toMatch(/CURRENT_PROJECT_VERSION\s*=/);
  });

  it("工程级 Debug / Release 都以带版本的 xcconfig 为基础", () => {
    const configs = [
      ...pbxproj.matchAll(
        /\/\* (Debug|Release) \*\/ = \{\s*isa = XCBuildConfiguration;\s*(?:baseConfigurationReference = [0-9A-F]{24} \/\* ([\w.]+) \*\/;)?\s*buildSettings = \{\s*ALWAYS_SEARCH_USER_PATHS/g,
      ),
    ];
    expect(configs.map((match) => [match[1], match[2]])).toEqual([
      ["Debug", "debug.xcconfig"],
      ["Release", "version.xcconfig"],
    ]);
    expect(pbxproj).toMatch(
      /\/\* version\.xcconfig \*\/ = \{isa = PBXFileReference; lastKnownFileType = text\.xcconfig; name = version\.xcconfig; path = \.\.\/version\.xcconfig; sourceTree = SOURCE_ROOT; \}/,
    );
  });

  it("两条 xcconfig 链都解出生成文件里的版本，叠加个人签名配置不改它", () => {
    const root = shell("0.0.0");
    for (const name of ["debug.xcconfig", "version.xcconfig"])
      writeFileSync(join(root, "ios", name), read(`ios/${name}`));
    writeNativeVersion({ root, env: { ARMADRA_BUILD_NUMBER: "9" } });
    // 生成文件里换成真版本以外的值，证明值确实来自它。
    writeFileSync(
      join(root, IOS_VERSION_FILE),
      nativeVersionFiles({ version: "3.1.4", build: 9 })[IOS_VERSION_FILE],
    );
    for (const name of ["debug.xcconfig", "version.xcconfig"]) {
      const settings = resolveXcconfig(join(root, "ios", name));
      expect(settings.MARKETING_VERSION).toBe("3.1.4");
      expect(settings.CURRENT_PROJECT_VERSION).toBe("9");
    }
    expect(
      resolveXcconfig(join(root, "ios/debug.xcconfig")).CAPACITOR_DEBUG,
    ).toBe("true");
    // `-xcconfig ~/armadra-ios-build/personal.xcconfig` 这类外加配置只管签名与包名。
    const personal = {
      DEVELOPMENT_TEAM: "TEAM",
      CODE_SIGN_STYLE: "Automatic",
      PRODUCT_BUNDLE_IDENTIFIER: "example.armadra",
    };
    const merged = {
      ...resolveXcconfig(join(root, "ios/version.xcconfig")),
      ...personal,
    };
    expect(merged.MARKETING_VERSION).toBe("3.1.4");
  });

  it("Info.plist 从构建设置取版本", () => {
    for (const plist of [
      "ios/App/App/Info.plist",
      "ios/App/NotificationService/Info.plist",
    ]) {
      const text = read(plist);
      expect(text).toMatch(
        /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/,
      );
      expect(text).toMatch(
        /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/,
      );
    }
  });
});

/**
 * `app/build.gradle` 的派生：按它的读法（`Properties.load` 读 `version.properties`）
 * 在 JS 里重放一遍，并钉住它不再从 semver 推版本号、也不再认旧的覆盖变量。
 */
describe("Android 工程", () => {
  const gradle = read("android/app/build.gradle");

  it("versionName / versionCode 都来自生成的 version.properties", () => {
    expect(gradle).toContain("file('version.properties')");
    expect(gradle).toMatch(/versionCode\s+appVersion\.versionCode/);
    expect(gradle).toMatch(/versionName\s+appVersion\.versionName/);
    expect(gradle).not.toContain("ARMADRA_VERSION_CODE");
    expect(gradle).not.toContain("JsonSlurper");
    expect(gradle).not.toMatch(/\* 10000/);
  });

  it("没有生成文件时让构建失败并指出该跑什么", () => {
    expect(gradle).toMatch(/throw new GradleException\([^)]*app-version\.mjs/);
  });

  it("生成的 properties 按 gradle 的读法解出版本", () => {
    const root = shell("1.0.0");
    writeNativeVersion({ root, env: { ARMADRA_BUILD_NUMBER: "3200" } });
    const props = Object.fromEntries(
      readFileSync(join(root, ANDROID_VERSION_FILE), "utf8")
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("=")),
    );
    expect(props).toEqual({ versionName: "1.0.0", versionCode: "3200" });
    // 旧方案的 0.2.4 是 204；新号来自提交数，远大于它，升级不会被系统当成降级。
    expect(Number(props.versionCode)).toBeGreaterThan(204);
  });
});
