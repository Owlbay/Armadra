if (!import.meta.env.DEV) throw new Error("design showcase is dev-only");

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";

import "../styles/app.css";
import "../styles/nodes.css";
import "./force-state.css";
import { usePreferencesStore } from "@/app/preferences-store";
import type { Locale } from "@/i18n";
import { ShowcaseApp } from "./ShowcaseApp";
import { installShowcaseContrast, ShowcaseProviders } from "./harness";

/**
 * 设计展示页入口（设计展示页 §2）。第一行的守卫是双保险的一半：入口本来就
 * 不在生产构建的 `input` 里（`vite.config.ts`），万一以后有人把它加进去，
 * 页面也只会在加载时抛错，不会把假数据渲染给用户。
 *
 * 不连 core、不开 WebSocket：数据全部来自 `fixtures/`。主题与语言只写进
 * 内存里的 store，不落 localStorage——展示页与开发中的应用同源，写进去会
 * 改掉开发者自己的偏好。
 */

const query = new URLSearchParams(window.location.search);

function themeFromQuery(): "dark" | "light" {
  const value = query.get("theme");
  if (value === "dark" || value === "light") return value;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function localeFromQuery(): Locale {
  return query.get("locale") === "en" ? "en" : "zh-CN";
}

const theme = themeFromQuery();
const locale = localeFromQuery();
usePreferencesStore.setState({ theme, systemTheme: theme, locale });
document.documentElement.dataset.theme = theme;
document.documentElement.style.colorScheme = theme;
document.documentElement.lang = locale;
installShowcaseContrast();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
    >
      <ShowcaseProviders>
        <ShowcaseApp only={query.get("only") === "1"} />
      </ShowcaseProviders>
    </MotionConfig>
  </StrictMode>,
);
