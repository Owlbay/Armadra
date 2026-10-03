import * as React from "react";

import { useT } from "@/app/preferences-store";
import { cn } from "@/lib/cn";
import { useCompactLayout } from "@/platform/layout";
import { Button } from "@/ui/button";
import { ScrollArea } from "@/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

import AcpSection from "./sections/acp";
import AuthSection from "./sections/auth";
import CanvasSection from "./sections/canvas";
import CollabSection from "./sections/collab";
import ComponentsSection from "./sections/components";
import CoordinatorSection from "./sections/coordinator";
import GatewaySection from "./sections/gateway";
import IntegrationSection from "./sections/integration";
import MobileSection from "./sections/mobile";
import StatesSection from "./sections/states";
import TokensSection from "./sections/tokens";
import UpdatesSection from "./sections/updates";
import WizardSection from "./sections/wizard";
import WorkflowSection from "./sections/workflow";

/**
 * 分区登记（设计展示页 §2.1）。全部 id 一次登记完：之后各功能包只改自己的
 * `sections/<id>.tsx`（与 `fixtures/<id>.ts`），不再碰这个文件。
 * 顺序就是导航与截图的顺序。
 */
export const SHOWCASE_SECTIONS = [
  ["tokens", TokensSection],
  ["components", ComponentsSection],
  ["canvas", CanvasSection],
  ["acp", AcpSection],
  ["wizard", WizardSection],
  ["coordinator", CoordinatorSection],
  ["workflow", WorkflowSection],
  ["collab", CollabSection],
  ["auth", AuthSection],
  ["gateway", GatewaySection],
  ["mobile", MobileSection],
  ["updates", UpdatesSection],
  ["integration", IntegrationSection],
  ["states", StatesSection],
] as const satisfies readonly (readonly [string, React.ComponentType])[];

export type ShowcaseSectionId = (typeof SHOWCASE_SECTIONS)[number][0];

export const SHOWCASE_SECTION_IDS: readonly ShowcaseSectionId[] =
  SHOWCASE_SECTIONS.map(([id]) => id);

declare global {
  interface Window {
    /** 截图探针按它枚举分区。 */
    __showcaseSections?: readonly string[];
  }
}

function sectionFromHash(): ShowcaseSectionId {
  const id = window.location.hash.slice(1);
  return (SHOWCASE_SECTION_IDS as readonly string[]).includes(id)
    ? (id as ShowcaseSectionId)
    : "tokens";
}

/** 一个分区：标题 + 样本，没有别的说明文字。 */
function Section({ id }: { id: ShowcaseSectionId }) {
  const t = useT();
  const Body = SHOWCASE_SECTIONS.find(([key]) => key === id)![1];
  return (
    <section
      id={id}
      data-showcase-section={id}
      aria-labelledby={`${id}-title`}
      className="flex scroll-mt-6 flex-col gap-4"
    >
      <h2
        id={`${id}-title`}
        className="text-[length:var(--text-title)] leading-6 font-semibold"
      >
        {t(`showcase.section.${id}`)}
      </h2>
      <Body />
    </section>
  );
}

/**
 * 页面就绪：首帧渲染完、字体加载完。探针等 `<html data-showcase-ready>` 再截图，
 * 各分区自己的异步（React Flow 量尺寸）在两帧之内完成。
 */
function useReadyFlag() {
  React.useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled)
            document.documentElement.dataset.showcaseReady = "true";
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);
}

export function ShowcaseApp({ only }: { only: boolean }) {
  const t = useT();
  const compact = useCompactLayout();
  const [active, setActive] = React.useState(sectionFromHash);
  useReadyFlag();

  React.useEffect(() => {
    window.__showcaseSections = SHOWCASE_SECTION_IDS;
    const onHash = () => setActive(sectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  React.useEffect(() => {
    document.title = `${t("showcase.title")} · ${t(`showcase.section.${active}`)}`;
    if (!only) document.getElementById(active)?.scrollIntoView();
  }, [active, only, t]);

  const select = (id: ShowcaseSectionId) => {
    window.location.hash = id;
    setActive(id);
  };

  // `only` 模式：只渲染这一个分区，文档自然流，整页截图不受其他分区影响。
  if (only) {
    return (
      <main className="min-h-screen bg-background p-6 text-foreground">
        <Section id={active} />
      </main>
    );
  }

  const sections = (
    <div className="flex flex-col gap-12 p-6">
      {SHOWCASE_SECTION_IDS.map((id) => (
        <Section key={id} id={id} />
      ))}
    </div>
  );

  if (compact) {
    return (
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="sticky top-0 z-[var(--z-tabbar)] border-b border-border bg-panel p-3">
          <Select
            value={active}
            onValueChange={(id) => select(id as ShowcaseSectionId)}
          >
            <SelectTrigger aria-label={t("showcase.jump")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHOWCASE_SECTION_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`showcase.section.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>
        {sections}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <nav
        aria-label={t("showcase.title")}
        className="settings-navigation flex h-full w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-panel p-3"
      >
        {SHOWCASE_SECTION_IDS.map((id) => (
          <Button
            key={id}
            variant="ghost"
            data-active={id === active}
            aria-current={id === active ? "page" : undefined}
            className={cn(
              "h-8 w-full justify-start px-2 text-[13px] font-normal text-muted-foreground",
              "data-[active=true]:bg-raised data-[active=true]:text-foreground",
            )}
            onClick={() => select(id)}
          >
            <span className="settings-nav-label truncate">
              {t(`showcase.section.${id}`)}
            </span>
          </Button>
        ))}
      </nav>
      <ScrollArea className="min-w-0 flex-1">{sections}</ScrollArea>
    </div>
  );
}
