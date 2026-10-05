// node --test tools/lint-config.test.mjs
//
// 根 eslint.config.js 的边界与禁止事项真的扫得到（工程规范化 §4.3）：每条规则
// 各给一段必须被拦下的样例和一段必须放过的样例。样例用 lintText 喂进去，
// filePath 只决定命中哪组配置，文件本身不必存在。
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));

// 类型感知规则要真实的 tsconfig 成员；样例路径是虚构的，这里只验非类型感知的规则。
const eslint = new ESLint({
  cwd: root,
  overrideConfig: {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
});

async function lint(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  assert.deepEqual(fatal, [], `${filePath} 解析失败`);
  return result.messages;
}

function hits(messages, ruleId) {
  return messages.filter((message) => message.ruleId === ruleId);
}

test("core：electron、../main/、../shell-core/ 与 @orpc/* 都是 error", async () => {
  const messages = await lint(
    "apps/desktop/src/core/sample/probe.ts",
    [
      `import { app } from "electron";`,
      `import { ipcMain } from "electron/main";`,
      `import runtime from "../../main/runtime-process";`,
      `import paths from "../../shell-core/paths";`,
      `import { os } from "@orpc/server";`,
      `export { app, ipcMain, runtime, paths, os };`,
    ].join("\n"),
  );
  const found = hits(messages, "no-restricted-imports");
  assert.deepEqual(
    found.map((message) => [message.line, message.severity]),
    [
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
    ],
  );
});

test("core：普通依赖与包名里带 electron 的不误报", async () => {
  const messages = await lint(
    "apps/desktop/src/core/sample/probe.ts",
    [
      `import { DatabaseSync } from "node:sqlite";`,
      `import { WebSocketServer } from "ws";`,
      `import builder from "electron-builder";`,
      `import { preflight } from "../db/ledger";`,
      `import { PERMISSION_MODES } from "@armadra/shared";`,
      `export { DatabaseSync, WebSocketServer, builder, preflight, PERMISSION_MODES };`,
    ].join("\n"),
  );
  assert.deepEqual(hits(messages, "no-restricted-imports"), []);
});

test("session-host 与 core 同规则；shell-core 只禁 electron 与 ../main/", async () => {
  const sessionHost = await lint(
    "apps/desktop/src/session-host/probe.ts",
    `import { app } from "electron";\nexport { app };\n`,
  );
  assert.equal(hits(sessionHost, "no-restricted-imports").length, 1);
  const shellCore = await lint(
    "apps/desktop/src/shell-core/probe.ts",
    [
      `import { app } from "electron";`,
      `import x from "../main/lifecycle";`,
      `import y from "../shell-core/paths";`,
      `export { app, x, y };`,
    ].join("\n"),
  );
  assert.deepEqual(
    hits(shellCore, "no-restricted-imports").map((message) => message.line),
    [1, 2],
  );
});

test("@orpc/*：门面之外一律 error，三处门面与 tools/contract/ 放行", async () => {
  const code = `import { oc } from "@orpc/contract";\nexport { oc };\n`;
  for (const outside of [
    "apps/web/src/panels/Probe.tsx",
    "apps/web/src/api/probe.ts",
    "apps/server/src/probe.ts",
    "packages/shared/src/api/probe.ts",
    "tools/probe.mjs",
  ]) {
    const found = hits(await lint(outside, code), "no-restricted-imports");
    assert.equal(found.length, 1, outside);
    assert.equal(found[0].severity, 2, outside);
  }
  for (const facade of [
    "packages/shared/src/contract/index.ts",
    "apps/desktop/src/core/http/rpc.ts",
    "apps/web/src/api/client.ts",
    "tools/contract/generate.mjs",
  ]) {
    assert.deepEqual(
      hits(await lint(facade, code), "no-restricted-imports"),
      [],
      facade,
    );
  }
});

test("core 门面 rpc.ts 放开 @orpc/* 但仍守 core 边界", async () => {
  const messages = await lint(
    "apps/desktop/src/core/http/rpc.ts",
    `import { os } from "@orpc/server";\nimport { app } from "electron";\nexport { os, app };\n`,
  );
  assert.deepEqual(
    hits(messages, "no-restricted-imports").map((message) => message.line),
    [2],
  );
});

const FORBIDDEN = [
  ["<button />", "<button>"],
  ['<input type="checkbox" />', "<input>"],
  ["<input />", "<input>"],
  ["<select />", "<select>"],
  ["<textarea />", "<textarea>"],
  ["<dialog />", "<dialog>"],
  ['<div role="dialog" />', 'role="dialog"'],
  ['<Button size="icon" />', "aria-label"],
  ['<div className="z-[5]" />', "z-[N]"],
  ['<div className="bg-card dark:bg-muted" />', "dark:"],
  ['<div title={"#ff8800"} />', "字面色值"],
];

test("页面业务代码：§4.2 的禁止事项各扫得到一次，且只是 warn", async () => {
  for (const [jsx, fragment] of FORBIDDEN) {
    const messages = await lint(
      "apps/web/src/panels/Probe.tsx",
      `export const Probe = () => ${jsx};\n`,
    );
    const found = hits(messages, "no-restricted-syntax");
    assert.equal(found.length, 1, jsx);
    assert.equal(found[0].severity, 1, jsx);
    assert.ok(
      found[0].message.includes(fragment),
      `${jsx} → ${found[0].message}`,
    );
  }
  for (const source of ["@/ui/dialog", "../../ui/alert-dialog", "@/ui/sheet"]) {
    const messages = await lint(
      "apps/web/src/panels/Probe.tsx",
      `import * as M from "${source}";\nexport { M };\n`,
    );
    assert.equal(hits(messages, "no-restricted-syntax").length, 1, source);
  }
  const loader = await lint(
    "apps/web/src/panels/Probe.tsx",
    `import { Loader2, X } from "lucide-react";\nexport { Loader2, X };\n`,
  );
  assert.equal(hits(loader, "no-restricted-syntax").length, 1);
});

test("页面业务代码：合规写法与豁免位置不报", async () => {
  const fine = await lint(
    "apps/web/src/panels/Probe.tsx",
    [
      `import { Button } from "@/ui/button";`,
      `import { ResponsiveDialog } from "./ResponsiveDialog";`,
      `export const Probe = () => (`,
      `  <div className="z-[var(--z-popover)] bg-card">`,
      `    <input type="file" />`,
      `    <input type="hidden" />`,
      `    <Button size="icon" aria-label="x" />`,
      `    <ResponsiveDialog />`,
      `  </div>`,
      `);`,
    ].join("\n"),
  );
  assert.deepEqual(hits(fine, "no-restricted-syntax"), []);
  // ui 原语、测试文件不受禁止事项约束；调色板只放开字面色值。
  for (const exempt of [
    "apps/web/src/ui/probe.tsx",
    "apps/web/src/panels/Probe.test.tsx",
  ]) {
    const messages = await lint(exempt, `export const P = () => <button />;\n`);
    assert.deepEqual(hits(messages, "no-restricted-syntax"), [], exempt);
  }
  const palette = await lint(
    "apps/web/src/canvas/whiteboard/palette.ts",
    `export const RED = "#ff0000";\n`,
  );
  assert.deepEqual(hits(palette, "no-restricted-syntax"), []);
});

test("hooks：条件调用是 error，依赖缺失是 warn", async () => {
  const messages = await lint(
    "apps/web/src/app/use-probe.ts",
    [
      `import { useEffect, useState } from "react";`,
      `function useFlag() { return useState(false)[0]; }`,
      `export function useProbe(wanted: boolean, id: string) {`,
      `  const on = wanted && useFlag();`,
      `  useEffect(() => { console.log(id); }, []);`,
      `  return on;`,
      `}`,
    ].join("\n"),
  );
  assert.equal(hits(messages, "react-hooks/rules-of-hooks")[0]?.severity, 2);
  assert.equal(hits(messages, "react-hooks/exhaustive-deps")[0]?.severity, 1);
});

test("jsx-a11y：img 无 alt 被报告为 warn", async () => {
  const messages = await lint(
    "apps/web/src/panels/Probe.tsx",
    `export const Probe = () => <img src="a.png" />;\n`,
  );
  assert.equal(hits(messages, "jsx-a11y/alt-text")[0]?.severity, 1);
});
