// ESLint（flat config）。设计见 docs/design/engineering-standardization.md §4.3、§5。
//
// 渐进策略（§5）：第 1 步除下面列明的边界规则外一律 warn，只报不阻断；
// `pnpm lint` 只在出现 error 时失败。warn 基线记在 docs/status/completion-progress.md。
// 格式交给 Prettier：eslint-config-prettier 放在最后，关掉一切与格式冲突的规则。
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/** 把一组共享配置里的 error 统一降为 warn（第 1 步全 warn）。 */
function warnOnly(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    const rules = {};
    for (const [name, value] of Object.entries(config.rules)) {
      if (value === "error" || value === 2) rules[name] = "warn";
      else if (Array.isArray(value) && (value[0] === "error" || value[0] === 2))
        rules[name] = ["warn", ...value.slice(1)];
      else rules[name] = value;
    }
    return { ...config, rules };
  });
}

const TS = ["**/*.{ts,tsx,mts,cts}"];
const JS = ["**/*.{js,mjs,cjs}"];

// ------------------------------------------------------------ import 边界

/** `@orpc/*` 只能出现在三处门面与 tools/contract/（§2.2.2），其余位置是 error。 */
const ORPC_FACADES = [
  "packages/shared/src/contract/**",
  "apps/desktop/src/core/http/rpc.ts",
  "apps/web/src/api/client.ts",
  "tools/contract/**",
];
const orpcPattern = {
  group: ["@orpc/*"],
  message:
    "@orpc/* 只能经三处门面使用：packages/shared/src/contract/、apps/desktop/src/core/http/rpc.ts、apps/web/src/api/client.ts（工程规范化 §2.2.2）。",
};

/** core 与 session-host 以纯 Node 运行：不碰 electron、不回伸进壳（AGENTS.md）。 */
const electronPattern = {
  group: ["electron", "electron/*"],
  message: "这里以纯 Node 运行，不得 import electron。",
};
const mainPattern = {
  regex: "^(\\.\\./)+main/",
  message: "不得回伸进 ../main/（主进程）。",
};
const shellCorePattern = {
  regex: "^(\\.\\./)+shell-core/",
  message: "core 不得 import ../shell-core/（壳自己的逻辑）。",
};

const restrictImports = (...patterns) => ({
  "no-restricted-imports": ["error", { patterns }],
});

const CORE = [
  "apps/desktop/src/core/**/*.ts",
  "apps/desktop/src/session-host/**/*.ts",
];
const SHELL_CORE = ["apps/desktop/src/shell-core/**/*.ts"];

// ------------------------------------------------- 前端业务代码的禁止事项

/**
 * §4.2「禁止事项」里能用语法选择器表达的部分（§4.3 的 no-restricted-syntax 落点）。
 * 第 1 步全部 warn。名单与 apps/web/src 里的扫描守卫保持一致：
 * `panels/no-raw-dialog-sheet.test.ts`（dialog / sheet 白名单）、
 * `styles/no-literal-color.test.ts`（颜色数据位置）、`panels/no-raw-form-element.test.ts`。
 * 守卫里用 `ui-exempt:` 注释放行的个别位置，在这里仍报 warn（计入基线）。
 */
const FORBIDDEN = {
  button: {
    selector: "JSXOpeningElement[name.name='button']",
    message: "用 ui/button 的 Button 或 IconButton，不要手写 <button>。",
  },
  input: {
    selector:
      "JSXOpeningElement[name.name='input']:not(:has(JSXAttribute[name.name='type'][value.value=/^(file|hidden)$/]))",
    message:
      "用 ui/input、ui/checkbox 等原语，不要手写 <input>（type=file / hidden 除外）。",
  },
  select: {
    selector: "JSXOpeningElement[name.name='select']",
    message: "用 ui/select，不要手写 <select>。",
  },
  textarea: {
    selector: "JSXOpeningElement[name.name='textarea']",
    message: "用 ui/textarea，不要手写 <textarea>。",
  },
  dialog: {
    selector: "JSXOpeningElement[name.name='dialog']",
    message: "用 ResponsiveDialog，不要手写 <dialog>。",
  },
  roleDialog: {
    selector: "JSXAttribute[name.name='role'][value.value='dialog']",
    message: '用 ResponsiveDialog，不要手写 role="dialog"。',
  },
  dialogImport: {
    selector:
      "ImportDeclaration[source.value=/(^|\\/)ui\\/(dialog|alert-dialog)$/]",
    message:
      "对话框经 panels/ResponsiveDialog，不要直接 import ui/dialog、ui/alert-dialog。",
  },
  sheetImport: {
    selector: "ImportDeclaration[source.value=/(^|\\/)ui\\/sheet$/]",
    message:
      "底部面板经 panels/ResponsiveDialog；右侧抽屉先登记进 no-raw-dialog-sheet 的名单，再 import ui/sheet。",
  },
  loader: {
    selector:
      "ImportDeclaration[source.value='lucide-react'] ImportSpecifier[imported.name=/^Loader2(Icon)?$/]",
    message: "加载态用 ui/spinner 的 Spinner，不要用 Loader2。",
  },
  iconButton: {
    selector:
      "JSXOpeningElement[name.name='Button']:has(JSXAttribute[name.name='size'][value.value=/^icon/]):not(:has(JSXAttribute[name.name='aria-label']))",
    message: "图标按钮要有 aria-label，或改用 IconButton（label 必填）。",
  },
  dark: {
    selector: "Literal[value=/(^|\\s)dark:/]",
    message: "不写 dark: 分支，颜色从 tokens.css 取（设计系统 §1）。",
  },
  darkTemplate: {
    selector: "TemplateElement[value.raw=/(^|\\s)dark:/]",
    message: "不写 dark: 分支，颜色从 tokens.css 取（设计系统 §1）。",
  },
  zIndex: {
    selector: "Literal[value=/(^|[\\s:])z-\\[\\d/]",
    message: "z 轴用 tokens.css 的 --z-*，不要写 z-[N]。",
  },
  literalColor: {
    selector:
      "Literal[value=/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
    message:
      "功能代码不写字面色值；用户可选的颜色数据集中到 palette.ts / appearance.ts。",
  },
};

/** `no-restricted-syntax` 的选项：全部禁止事项，去掉 `omit` 里放行的几条。 */
function forbidden(...omit) {
  return [
    "warn",
    ...Object.entries(FORBIDDEN)
      .filter(([name]) => !omit.includes(name))
      .map(([, entry]) => entry),
  ];
}

const WEB = "apps/web/src/";
/** 业务代码：apps/web/src 下除 ui 原语、测试与展示页夹具外的源码。 */
const WEB_BUSINESS = [`${WEB}**/*.{ts,tsx}`];
const WEB_BUSINESS_EXCLUDED = [
  `${WEB}ui/**`,
  `${WEB}**/*.test.{ts,tsx}`,
  `${WEB}app/test-setup.ts`,
  `${WEB}showcase/fixtures/**`,
];
/** 字面色值的放行位置：用户可选的颜色数据、计算用途与样例数据（同 no-literal-color）。 */
const LITERAL_COLOR_ALLOWED = [
  `${WEB}canvas/whiteboard/palette.ts`,
  `${WEB}terminal/surface/appearance.ts`,
  `${WEB}lib/contrast.ts`,
  `${WEB}showcase/**`,
  `${WEB}canvas/test-support/**`,
  `${WEB}**/*.fixture.{ts,tsx}`,
  `${WEB}**/*fixtures.ts`,
];
/** 只有 ResponsiveDialog 可以 import ui/dialog 与 ui/alert-dialog。 */
const DIALOG_ALLOWED = ["panels/ResponsiveDialog.tsx"];
/** 可以 import ui/sheet 的抽屉（同 no-raw-dialog-sheet 的 SHEET_ALLOWED，只减不增）。 */
const SHEET_ALLOWED = [
  "coordinator/DispatchDrawer.tsx",
  "panels/ExplorerDrawer.tsx",
  "panels/ResourceDrawer.tsx",
  "panels/ResponsiveDialog.tsx",
  "panels/UsageDashboard.tsx",
  "panels/WorkPanelSheet.tsx",
  "panels/automation/AutomationDrawer.tsx",
  "panels/github/GithubDrawer.tsx",
  "panels/handoff/HandoffHistoryDrawer.tsx",
  "panels/problems/ProblemsPanel.tsx",
  "panels/references/ReferencesPanel.tsx",
  "realtime/comments/CommentLayer.tsx",
  "shell/LeftSidebar.tsx",
  "showcase/sections/components.tsx",
  "workflow/WorkflowPanel.tsx",
];

/** 按文件放行 import 的覆盖配置；放在通用配置之后，同一规则以后者为准。 */
const WEB_IMPORT_OVERRIDES = [
  ...new Set([...DIALOG_ALLOWED, ...SHEET_ALLOWED]),
].map((file) => {
  const omit = [];
  if (DIALOG_ALLOWED.includes(file)) omit.push("dialogImport");
  if (SHEET_ALLOWED.includes(file)) omit.push("sheetImport");
  if (file.startsWith("showcase/")) omit.push("literalColor");
  return {
    files: [`${WEB}${file}`],
    rules: { "no-restricted-syntax": forbidden(...omit) },
  };
});

// ---------------------------------------------------------------- config

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/gen/**",
      "**/*.d.ts",
      ".pnpm-store/**",
      ".claude/**",
      "target/**",
      "target-main/**",
      "docs/**",
      "apps/desktop/release/**",
      "apps/desktop/resources/**",
      "tools/release/templates/**",
      "tools/dev-stack/.data/**",
      // 不在 E0 的覆盖范围：手机壳（原生工程 + Capacitor）与推送中继。
      "apps/mobile/**",
      "apps/push-relay/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },

  // 全仓：JS 推荐 + typescript-eslint 推荐（非类型感知），全部 warn。
  ...warnOnly([js.configs.recommended]),
  ...warnOnly(tseslint.configs.recommended),
  {
    files: [...TS, ...JS],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      ...restrictImports(orpcPattern),
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // 探针与测试脚本里有大量 page.evaluate 回调，函数体在浏览器里跑。
  {
    files: ["tools/probes/**", "apps/desktop/src/**/*.test.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // 页面：浏览器环境、React hooks、jsx-a11y。
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  ...warnOnly([
    { files: ["apps/web/src/**/*.tsx"], ...jsxA11y.flatConfigs.recommended },
  ]),
  {
    files: WEB_BUSINESS,
    ignores: WEB_BUSINESS_EXCLUDED,
    rules: { "no-restricted-syntax": forbidden() },
  },
  {
    files: LITERAL_COLOR_ALLOWED,
    ignores: WEB_BUSINESS_EXCLUDED,
    rules: { "no-restricted-syntax": forbidden("literalColor") },
  },
  ...WEB_IMPORT_OVERRIDES,

  // core / session-host / shell-core 的 import 边界（error：现状为 0，守住不回退）。
  {
    files: CORE,
    rules: restrictImports(
      orpcPattern,
      electronPattern,
      mainPattern,
      shellCorePattern,
    ),
  },
  {
    files: SHELL_CORE,
    rules: restrictImports(orpcPattern, electronPattern, mainPattern),
  },
  // 门面：放开 @orpc/*；core 门面仍守 core 边界。
  {
    files: ORPC_FACADES,
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["apps/desktop/src/core/http/rpc.ts"],
    rules: restrictImports(electronPattern, mainPattern, shellCorePattern),
  },

  // 类型感知规则先只开 core/http、web api/、shared（§5），warn。
  {
    files: [
      "apps/desktop/src/core/http/**/*.ts",
      "apps/web/src/api/**/*.ts",
      "packages/shared/src/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },

  prettier,
);
