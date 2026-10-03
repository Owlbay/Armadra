import { useT } from "@/app/preferences-store";
import { useCompactLayout } from "@/platform/layout";
import { SectionPlaceholder } from "../placeholder";

/**
 * `mobile` 分区（设计展示页 §2.1）。只在 ≤767 宽有意义：桌面与平板宽度下
 * 用一个 390 宽的 iframe 嵌同一页的 `#mobile&only=1`，iframe 里自然是手机布局。
 * 归移动网页实现包（设计系统 §5.13）：实现包只换 `MobileSamples`。
 */
export default function MobileSection() {
  const t = useT();
  const compact = useCompactLayout();
  if (compact || window.self !== window.top) return <MobileSamples />;
  const query = new URLSearchParams(window.location.search);
  const frame = new URLSearchParams({
    theme: document.documentElement.dataset.theme ?? "dark",
    locale: query.get("locale") ?? "zh-CN",
    only: "1",
  });
  return (
    <iframe
      title={t("showcase.section.mobile")}
      src={`${window.location.pathname}?${frame.toString()}#mobile`}
      className="h-[844px] w-[390px] rounded-[var(--r-panel)] border border-border bg-background"
    />
  );
}

function MobileSamples() {
  return <SectionPlaceholder />;
}
