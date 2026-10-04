#!/usr/bin/env node
// deb 安装验证：`pnpm --filter @armadra/desktop dist` 在 Linux 上产出的 .deb，在
// 一个干净的 ubuntu:22.04 容器里 `apt-get install` 一次，再问一次 `armadra
// --version`。验三件只有装上之后才知道的事：
//
//   1. 包的依赖声明够用：apt 从官方源把它要的库都装得上，装完 `ldd` 没有
//      `not found`（少声明一个库，用户那边是「双击没反应」）。
//   2. 装到的位置与入口：/usr/bin/armadra 指向 /opt/Armadra/armadra。
//   3. 二进制在 22.04（glibc 2.35，发布承诺的基线）上起得来并答出版本——不要显
//      示器、不要数据目录（main/version-flag.ts）。
//   4. 同一目录里有同架构的 AppImage 时，在装好 deb 依赖的同一个容器里用
//      APPIMAGE_EXTRACT_AND_RUN 起它并答出版本：Electron 要的库由 deb 拉齐，剩下
//      能缺的只有 AppImage 运行时自己的依赖（arm64 旧运行时要开发包里的 libz.so，
//      scripts/dist.mjs 的 ARM64_APPIMAGE_TOOLSET）。
//
// 容器是一次性的（--rm），只读挂载 release 目录；不碰本机的 apt 与 /opt。架构
// 跟着 Docker 主机走：x64 runner 验 amd64 包，Apple 芯片上验 arm64 包。
//
// 用法（仓库根目录）：
//   pnpm --filter @armadra/desktop dist
//   node tools/probes/deb-install.mjs [输出目录] [--deb <Armadra_x.y.z_arch.deb>] [--appimage <x.AppImage>] [--image ubuntu:22.04]
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const valued = new Set(["--deb", "--appimage", "--image"]);
const positional = argv.filter(
  (value, index) => !value.startsWith("--") && !valued.has(argv[index - 1]),
);
const output = resolve(positional[0] ?? join(root, "target/deb-install"));
mkdirSync(output, { recursive: true });

const image = option("--image") ?? "ubuntu:22.04";
const version = JSON.parse(
  readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
).version;

function findDeb() {
  const release = join(root, "apps/desktop/release");
  if (!existsSync(release)) return undefined;
  const name = readdirSync(release)
    .filter((file) => file.endsWith(".deb"))
    .sort()
    .at(-1);
  return name ? join(release, name) : undefined;
}

/** deb 的架构（`amd64` / `arm64`）→ electron-builder 给 AppImage 名字里写的那个。 */
export const APPIMAGE_ARCH = { amd64: "x86_64", arm64: "arm64" };

function findAppImage(deb) {
  const arch = /_(amd64|arm64)\.deb$/.exec(basename(deb))?.[1];
  const token = APPIMAGE_ARCH[arch];
  if (!token) return undefined;
  const name = readdirSync(dirname(deb))
    .filter((file) => file.endsWith(`-${token}.AppImage`))
    .sort()
    .at(-1);
  return name ? join(dirname(deb), name) : undefined;
}

// Everything inside the container is one script, so a failure anywhere stops it
// and the markers below say how far it got.
const SCRIPT = `
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends "/pkg/$DEB" >/tmp/apt.log 2>&1 || { tail -n 40 /tmp/apt.log; exit 10; }
echo "@@installed"
echo "@@which $(readlink -f "$(command -v armadra)")"
missing="$(ldd /opt/Armadra/armadra | grep 'not found' || true)"
echo "@@missing $missing"
# root 下 Chromium 不肯起沙箱；--version 在那之前就答了，带上只为不依赖这一点。
armadra --no-sandbox --version > /tmp/version.txt 2>/tmp/version.err || { cat /tmp/version.err; exit 11; }
echo "@@version $(head -n 1 /tmp/version.txt)"
if [ -n "\${APPIMAGE:-}" ]; then
  cp "/pkg/$APPIMAGE" /tmp/armadra.AppImage
  chmod +x /tmp/armadra.AppImage
  (cd /tmp && APPIMAGE_EXTRACT_AND_RUN=1 ./armadra.AppImage --no-sandbox --version > /tmp/appimage.txt 2>/tmp/appimage.err) \
    || { cat /tmp/appimage.err; echo "@@broken-appimage $(head -n 1 /tmp/appimage.err)"; exit 12; }
  echo "@@appimage $(head -n 1 /tmp/appimage.txt)"
fi
`;

const report = { status: "failed", image, checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`,
  );
}

try {
  const deb = option("--deb") ? resolve(option("--deb")) : findDeb();
  if (deb === undefined || !existsSync(deb))
    throw new Error(
      "没有 .deb：先在 Linux 上跑 `pnpm --filter @armadra/desktop dist`",
    );
  report.deb = deb;
  const appImage = option("--appimage")
    ? resolve(option("--appimage"))
    : findAppImage(deb);
  if (appImage !== undefined && dirname(appImage) !== dirname(deb))
    throw new Error("--appimage 要与 deb 在同一目录（容器只挂那一个）");
  report.appImage = appImage;
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${dirname(deb)}:/pkg:ro`,
      "-e",
      `DEB=${basename(deb)}`,
      "-e",
      `APPIMAGE=${appImage === undefined ? "" : basename(appImage)}`,
      image,
      "bash",
      "-c",
      SCRIPT,
    ],
    { encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  writeFileSync(join(output, "container.log"), log);
  process.stdout.write(log);
  if (run.error) throw run.error;
  const marker = (name) =>
    log
      .split("\n")
      .find((line) => line.startsWith(`@@${name}`))
      ?.slice(name.length + 2)
      .trim();
  report.exitCode = run.status;
  check(
    "apt-get install 装得上（依赖都能从官方源解出来）",
    marker("installed") !== undefined,
    run.status,
  );
  check(
    "/usr/bin/armadra 指向 /opt/Armadra/armadra",
    marker("which") === "/opt/Armadra/armadra",
    marker("which"),
  );
  check("ldd 没有找不到的库", marker("missing") === "", marker("missing"));
  check(
    `armadra --version 答出 ${version}`,
    marker("version")?.endsWith(` ${version}`),
    marker("version"),
  );
  if (appImage !== undefined)
    check(
      `AppImage（APPIMAGE_EXTRACT_AND_RUN）答出 ${version}`,
      marker("appimage")?.endsWith(` ${version}`),
      marker("appimage") ?? marker("broken-appimage"),
    );
  else console.log("  skip  同目录没有同架构的 AppImage");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.error(`  FAIL  ${report.error}`);
}
report.status =
  report.error === undefined &&
  report.checks.length > 0 &&
  report.checks.every((entry) => entry.ok)
    ? "ok"
    : "failed";
writeFileSync(
  join(output, "result.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`  ${report.status}  报告 ${join(output, "result.json")}`);
process.exit(report.status === "ok" ? 0 : 1);
