import * as React from "react";

import { useT } from "@/app/preferences-store";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Button } from "@/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { tokenContrast, type ContrastPair } from "../harness";

/**
 * `tokens` 分区（设计展示页 §2.1）：设计系统 §2 的每个语义 token。
 * 色块下方印 token 名与浏览器里实测的对比度——读的是计算样式，不是源文件。
 */

const AGENTS = ["claude", "codex", "opencode", "pi", "omp", "copilot", "ama"];
const SURFACES = [
  "--bg",
  "--panel",
  "--surface-card",
  "--surface-raised",
  "--surface-overlay",
  "--canvas-bg",
  "--term-bg",
];
const TEXTS = ["--text", "--muted-foreground", "--faint"];
const BRAND = ["--brand", "--brand-text", "--brand-solid", "--focus-ring"];
const STATUS: [string, string, string | null][] = [
  ["--danger", "--danger-text", "--danger-soft"],
  ["--warn", "--warn-text", "--warn-soft"],
  ["--caution", "--caution", null],
  ["--success", "--success-text", "--success-soft"],
  ["--agent-working", "--working-text", "--agent-working-soft"],
];
const TYPE_SCALE = [
  "--text-display",
  "--text-title",
  "--text-section",
  "--text-body",
  "--text-caption",
  "--text-code",
];
const RADII = [
  "--r-control",
  "--r-card",
  "--r-panel",
  "--r-dialog",
  "--r-pill",
];
const SHADOWS = [
  "--shadow-pill",
  "--shadow-node",
  "--shadow-overlay",
  "--shadow-dialog",
];
const DURATIONS = ["--dur-fast", "--dur-base", "--dur-slow", "--dur-page"];
const LAYERS = [
  "--z-pills",
  "--z-canvas-overlay",
  "--z-sessions",
  "--z-dock",
  "--z-cluster",
  "--z-banners",
  "--z-tabbar",
  "--z-focus",
  "--z-menu",
  "--z-dialog",
  "--z-focus-page",
  "--z-toast",
  "--z-splash",
];

/** 挂载后量一次：主题由 URL 定，页面开着时不会变。 */
function useMeasured<T>(read: () => T): T | null {
  const [value, setValue] = React.useState<T | null>(null);
  React.useLayoutEffect(() => setValue(read()), [read]);
  return value;
}

function Ratio({ pair }: { pair: Omit<ContrastPair, "kind"> }) {
  const { fg, bg, over, alpha } = pair;
  const read = React.useCallback(
    () =>
      tokenContrast({
        fg,
        bg,
        ...(over === undefined ? {} : { over }),
        ...(alpha === undefined ? {} : { alpha }),
      }),
    [fg, bg, over, alpha],
  );
  const ratio = useMeasured(read);
  return (
    <span className="font-mono text-[length:var(--text-caption)] text-muted-foreground tabular-nums">
      {ratio === null ? "" : ratio.toFixed(1)}
    </span>
  );
}

function TokenName({ name }: { name: string }) {
  return (
    <span className="font-mono text-[length:var(--text-caption)] break-all text-muted-foreground">
      {name}
    </span>
  );
}

/** 一个色块 + 名字 + 对比度（`pair` 缺省时不印数）。 */
function Swatch({
  token,
  pair,
  children,
}: {
  token: string;
  pair?: Omit<ContrastPair, "kind">;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex w-28 flex-col gap-1" data-token={token}>
      <div
        className="flex h-12 items-center justify-center rounded-[var(--r-control)] border border-border"
        style={{ background: `var(${token})` }}
      >
        {children}
      </div>
      <TokenName name={token} />
      {pair ? <Ratio pair={pair} /> : null}
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[length:var(--text-section)] font-medium">{title}</h3>
      <div className="flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

const CARD = "--surface-card";

export default function TokensSection() {
  const t = useT();
  const [played, setPlayed] = React.useState(false);
  const readLayers = React.useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    return LAYERS.map(
      (name) => [name, style.getPropertyValue(name).trim()] as const,
    );
  }, []);
  const layers = useMeasured(readLayers);

  return (
    <div className="flex flex-col gap-6">
      <Group title={t("showcase.tokens.surfaces")}>
        {SURFACES.map((token) => (
          <Swatch
            key={token}
            token={token}
            pair={{
              fg: token === "--term-bg" ? "--term-fg" : "--text",
              bg: token,
            }}
          />
        ))}
      </Group>

      <Group title={t("showcase.tokens.text")}>
        {TEXTS.map((token) => (
          <div key={token} className="flex w-28 flex-col gap-1">
            <div
              className="flex h-12 items-center rounded-[var(--r-control)] border border-border bg-card px-2 text-[length:var(--text-body)]"
              style={{ color: `var(${token})` }}
            >
              Aa
            </div>
            <TokenName name={token} />
            <Ratio pair={{ fg: token, bg: CARD }} />
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.brand")}>
        {BRAND.map((token) => (
          <Swatch
            key={token}
            token={token}
            pair={
              token === "--brand-solid"
                ? { fg: "--on-accent", bg: token }
                : token === "--focus-ring"
                  ? { fg: token, bg: CARD, alpha: 0.5 }
                  : { fg: token, bg: CARD }
            }
          />
        ))}
        <Swatch
          token="--brand-soft"
          pair={{ fg: "--brand-text", bg: CARD, over: "--brand-soft" }}
        />
      </Group>

      <Group title={t("showcase.tokens.status")}>
        {STATUS.map(([graphic, text, soft]) => (
          <div key={graphic} className="flex gap-1">
            <Swatch token={graphic} pair={{ fg: graphic, bg: CARD }} />
            <div className="flex w-28 flex-col gap-1">
              <div
                className="flex h-12 items-center rounded-[var(--r-control)] border border-border bg-card px-2 text-[length:var(--text-body)] font-medium"
                style={{ color: `var(${text})` }}
              >
                Aa
              </div>
              <TokenName name={text} />
              <Ratio pair={{ fg: text, bg: CARD }} />
            </div>
            {soft ? (
              <Swatch token={soft} pair={{ fg: text, bg: CARD, over: soft }} />
            ) : null}
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.agents")}>
        {AGENTS.map((id) => (
          <div key={id} className="flex w-36 flex-col gap-1">
            <div className="flex h-12 items-center gap-2 rounded-[var(--r-control)] border border-border bg-card px-2">
              <AgentAvatar agentId={id} size={24} />
              <span
                className="text-[length:var(--text-body)] font-medium"
                style={{ color: `var(--agent-${id}-text)` }}
              >
                {id}
              </span>
            </div>
            <TokenName name={`--agent-${id}`} />
            <div className="flex gap-2">
              <Ratio pair={{ fg: `--agent-${id}`, bg: CARD }} />
              <Ratio pair={{ fg: `--agent-${id}-text`, bg: CARD }} />
              <Ratio pair={{ fg: "--on-agent", bg: `--agent-${id}` }} />
            </div>
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.members")}>
        {Array.from({ length: 8 }, (_, index) => `--member-${index + 1}`).map(
          (token) => (
            <Swatch key={token} token={token} pair={{ fg: token, bg: CARD }} />
          ),
        )}
      </Group>

      <Group title={t("showcase.tokens.type")}>
        <div className="flex w-full flex-col gap-2">
          {TYPE_SCALE.map((token) => (
            <div key={token} className="flex items-baseline gap-4">
              <span className="w-32 shrink-0">
                <TokenName name={token} />
              </span>
              <span
                className={token === "--text-code" ? "font-mono" : undefined}
                style={{ fontSize: `var(${token})` }}
              >
                {t("showcase.tokens.sample")}
              </span>
            </div>
          ))}
        </div>
      </Group>

      <Group title={t("showcase.tokens.radius")}>
        {RADII.map((token) => (
          <div key={token} className="flex w-28 flex-col gap-1">
            <div
              className="h-12 border border-border-strong bg-card"
              style={{ borderRadius: `var(${token})` }}
            />
            <TokenName name={token} />
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.shadow")}>
        {SHADOWS.map((token) => (
          <div key={token} className="flex w-32 flex-col gap-2 p-2">
            <div
              className="h-12 rounded-[var(--r-card)] bg-card"
              style={{ boxShadow: `var(${token})` }}
            />
            <TokenName name={token} />
          </div>
        ))}
      </Group>

      <Group title={t("showcase.tokens.motion")}>
        <div className="flex w-full flex-col gap-2">
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setPlayed((value) => !value)}
          >
            {t("showcase.tokens.play")}
          </Button>
          {DURATIONS.map((token) => (
            <div key={token} className="flex items-center gap-4">
              <span className="w-32 shrink-0">
                <TokenName name={token} />
              </span>
              <div className="relative h-6 flex-1 max-w-80">
                <div
                  data-motion-sample
                  className="absolute top-0 left-0 size-6 rounded-[var(--r-pill)] bg-[var(--brand)]"
                  style={{
                    transform: played ? "translateX(280px)" : "none",
                    transition: `transform var(${token}) var(--ease-out)`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </Group>

      <Group title={t("showcase.tokens.z")}>
        <Table className="max-w-sm">
          <TableHeader>
            <TableRow>
              <TableHead>token</TableHead>
              <TableHead className="text-right">z-index</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(layers ?? []).map(([name, value]) => (
              <TableRow key={name}>
                <TableCell className="font-mono text-[length:var(--text-caption)]">
                  {name}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {value}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Group>
    </div>
  );
}
