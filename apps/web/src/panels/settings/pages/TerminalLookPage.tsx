import * as React from "react";

import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LETTER_SPACING_RANGE,
  TERMINAL_LINE_HEIGHT_RANGE,
  TERMINAL_RENDERERS,
  usePreferencesStore,
  useT,
  type TerminalCursorStyle,
  type TerminalPreferences,
  type TerminalRenderer,
} from "../../../app/preferences-store";
import {
  RELEASE_AFTER_OPTIONS,
  type ReleaseAfter,
} from "../../../terminal/lifecycle";
import { RENDER_BUDGET_CHOICES } from "../../../terminal/render-budget";
import { useMonospaceFonts } from "../../../terminal/surface/fonts";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRow } from "../SettingsRow";
import { CONTROL_WIDTH } from "./GeneralPage";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import { clamp } from "@/lib/math";

/** `Select` 不收空串：跟随系统与自定义各用一个不会是字体名的值。 */
const SYSTEM = "__system";
const CUSTOM = "__custom";
/** 探测超过这么久才画骨架（设计系统 §3.2），快的时候不闪一下。 */
const SKELETON_DELAY_MS = 300;

/**
 * 设置 → 终端（§2.4）：本设备的终端外观。字体与排版、光标、键盘、渲染四组；
 * 改一项 `TerminalSurface` 会重设 xterm options 并 fit 一次。会话策略与电源
 * 是主机设置，在「本机服务」页。
 */
export function TerminalLookPage() {
  const t = useT();
  const terminal = usePreferencesStore((state) => state.terminal);
  const set = usePreferencesStore((state) => state.setTerminalPreference);
  // 能同时开几个 WebGL 上下文是这台机器的属性，不是账号偏好。
  const renderBudget = usePreferencesStore((state) => state.renderBudget);
  const setRenderBudget = usePreferencesStore((state) => state.setRenderBudget);

  return (
    <>
      <SettingsGroup title={t("terminal.settings.group.type")}>
        <FontRows terminal={terminal} set={set} />
        <SpacingRow terminal={terminal} set={set} />
        <PreviewRow terminal={terminal} />
      </SettingsGroup>

      <SettingsGroup title={t("terminal.settings.group.cursor")}>
        <SettingsRow label={t("terminal.settings.cursor")}>
          <Select
            value={terminal.cursorStyle}
            onValueChange={(value) =>
              set("cursorStyle", value as TerminalCursorStyle)
            }
          >
            <SelectTrigger
              aria-label={t("terminal.settings.cursor")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem key={style} value={style}>
                  {t(`terminal.cursor.${style}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.cursorBlink")}>
          <Switch
            checked={terminal.cursorBlink}
            aria-label={t("terminal.settings.cursorBlink")}
            onCheckedChange={(next) => set("cursorBlink", next)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("terminal.settings.group.keyboard")}>
        <SettingsRow label={t("terminal.settings.optionAsMeta")}>
          <Switch
            checked={terminal.macOptionIsMeta}
            aria-label={t("terminal.settings.optionAsMeta")}
            onCheckedChange={(next) => set("macOptionIsMeta", next)}
          />
        </SettingsRow>

        <SettingsRow label={t("terminal.settings.copyOnSelect")}>
          <Switch
            checked={terminal.copyOnSelect}
            aria-label={t("terminal.settings.copyOnSelect")}
            onCheckedChange={(next) => set("copyOnSelect", next)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("terminal.settings.group.render")}>
        <SettingsRow label={t("terminal.settings.renderer")}>
          <Select
            value={terminal.renderer}
            onValueChange={(value) =>
              set("renderer", value as TerminalRenderer)
            }
          >
            <SelectTrigger
              aria-label={t("terminal.settings.renderer")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {TERMINAL_RENDERERS.map((renderer) => (
                <SelectItem key={renderer} value={renderer}>
                  {t(`terminal.settings.renderer.${renderer}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        {/* 名额只约束纯 WebGL 档；`auto` 自带上限，DOM 下没有意义。 */}
        {terminal.renderer === "webgl" && (
          <SettingsRow
            label={t("terminal.settings.renderBudget")}
            footnote={t("terminal.settings.renderBudgetHint")}
          >
            <Select
              value={String(renderBudget)}
              onValueChange={(value) => setRenderBudget(Number(value))}
            >
              <SelectTrigger
                aria-label={t("terminal.settings.renderBudget")}
                size="sm"
                className={CONTROL_WIDTH}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[var(--z-dialog)]">
                {RENDER_BUDGET_CHOICES.map((slots) => (
                  <SelectItem key={slots} value={String(slots)}>
                    {slots}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}

        <SettingsRow label={t("terminal.settings.repaintThrottle")}>
          <Switch
            checked={terminal.repaintThrottle === "lowZoom"}
            aria-label={t("terminal.settings.repaintThrottle")}
            onCheckedChange={(next) =>
              set("repaintThrottle", next ? "lowZoom" : "off")
            }
          />
        </SettingsRow>

        <SettingsRow
          label={t("terminal.settings.releaseAfter")}
          footnote={t("terminal.settings.releaseAfterHint")}
        >
          <Select
            value={terminal.releaseAfter}
            onValueChange={(value) =>
              set("releaseAfter", value as ReleaseAfter)
            }
          >
            <SelectTrigger
              aria-label={t("terminal.settings.releaseAfter")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              {RELEASE_AFTER_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`terminal.settings.releaseAfter.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

type SetTerminal = <K extends keyof TerminalPreferences>(
  key: K,
  value: TerminalPreferences[K],
) => void;

/**
 * 存着的字体 → `Select` 上的那一项：空串是跟随系统；正好是探测到的名字就落
 * 到那一项；别的都是自定义（存的是自由文本）。
 */
export function fontChoice(
  stored: string,
  detected: readonly string[] | null,
): string {
  const value = stored.trim();
  if (value === "") return SYSTEM;
  if (detected?.includes(value)) return value;
  return CUSTOM;
}

/** 当前生效的终端字体栈（`--font-code`），做自定义输入框的占位。 */
function effectiveFontStack(): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--font-code")
    .replace(/\s+/g, " ")
    .trim();
}

function useDelayed(active: boolean, ms: number): boolean {
  const [late, setLate] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return late;
}

function FontRows({
  terminal,
  set,
}: {
  terminal: TerminalPreferences;
  set: SetTerminal;
}) {
  const t = useT();
  const detected = useMonospaceFonts();
  const slow = useDelayed(detected === null, SKELETON_DELAY_MS);
  // 选了「自定义…」但还没写字：存的仍是旧值，界面先停在自定义上。
  const [editing, setEditing] = React.useState(false);
  const stored = terminal.fontFamily;
  const storedChoice = fontChoice(stored, detected);
  const choice = editing ? CUSTOM : storedChoice;
  const placeholder = React.useMemo(effectiveFontStack, []);
  // 探测还没回来时，存着的名字先当一项列着，不让 Select 跳成「自定义」。
  const pending = detected === null && !editing && stored.trim() !== "";
  const options = detected ?? (pending ? [stored.trim()] : []);
  const shown = pending ? stored.trim() : choice;

  return (
    <>
      <SettingsRow label={t("terminal.settings.font")}>
        {detected === null && slow ? (
          <Skeleton
            data-testid="terminal-font-loading"
            className={`h-8 ${CONTROL_WIDTH}`}
          />
        ) : (
          <Select
            value={shown}
            onValueChange={(value) => {
              if (value === CUSTOM) {
                setEditing(true);
                return;
              }
              setEditing(false);
              set("fontFamily", value === SYSTEM ? "" : value);
            }}
          >
            <SelectTrigger
              aria-label={t("terminal.settings.font")}
              size="sm"
              className={CONTROL_WIDTH}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[var(--z-dialog)]">
              <SelectItem value={SYSTEM}>
                {t("terminal.settings.fontSystem")}
              </SelectItem>
              {options.map((name) => (
                <SelectItem key={name} value={name}>
                  <span style={{ fontFamily: `'${name}', monospace` }}>
                    {name}
                  </span>
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>
                {t("terminal.settings.fontCustom")}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
      </SettingsRow>

      {choice === CUSTOM && (
        <SettingsRow label={t("terminal.settings.fontStack")}>
          <Input
            className="h-8 w-[280px] max-w-full font-mono text-xs"
            aria-label={t("terminal.settings.fontStack")}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            value={stored}
            onChange={(event) => set("fontFamily", event.target.value)}
          />
        </SettingsRow>
      )}
    </>
  );
}

function SpacingRow({
  terminal,
  set,
}: {
  terminal: TerminalPreferences;
  set: SetTerminal;
}) {
  const t = useT();
  const id = React.useId();
  const fields = [
    {
      key: "fontSize",
      label: t("terminal.settings.fontSize"),
      range: TERMINAL_FONT_SIZE_RANGE,
      step: 1,
    },
    {
      key: "lineHeight",
      label: t("terminal.settings.lineHeight"),
      range: TERMINAL_LINE_HEIGHT_RANGE,
      step: 0.05,
    },
    {
      key: "letterSpacing",
      label: t("terminal.settings.letterSpacing"),
      range: TERMINAL_LETTER_SPACING_RANGE,
      step: 0.5,
    },
  ] as const;

  return (
    <div className="settings-row flex min-h-12 w-full flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      {fields.map((field) => (
        <div key={field.key} className="flex items-center gap-2">
          <Label
            htmlFor={`${id}-${field.key}`}
            className="text-[13px] font-normal text-foreground"
          >
            {field.label}
          </Label>
          <Input
            id={`${id}-${field.key}`}
            type="number"
            className="h-8 w-[76px] text-xs tabular-nums"
            min={field.range[0]}
            max={field.range[1]}
            step={field.step}
            value={terminal[field.key]}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next))
                set(field.key, clamp(next, field.range[0], field.range[1]));
            }}
          />
        </div>
      ))}
    </div>
  );
}

function PreviewRow({ terminal }: { terminal: TerminalPreferences }) {
  const t = useT();
  const family = terminal.fontFamily.trim();
  return (
    <div className="px-4 py-3">
      <pre
        aria-label={t("terminal.settings.preview")}
        data-testid="terminal-font-preview"
        className="overflow-x-auto rounded-md bg-[var(--term-bg)] px-3 py-2 text-[var(--term-fg)]"
        style={{
          fontFamily: family
            ? `${family}, var(--font-code)`
            : "var(--font-code)",
          fontSize: terminal.fontSize,
          lineHeight: terminal.lineHeight,
          letterSpacing: terminal.letterSpacing,
        }}
      >
        {t("terminal.settings.previewSample")}
      </pre>
    </div>
  );
}
