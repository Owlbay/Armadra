import { useT } from "../../app/preferences-store";
import { useCurrentSource } from "../../sources/context";
import { useRemoteAccess } from "./remote-access";
import type { SettingsScope } from "./nav";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/cn";

/**
 * 作用范围的文案（§2.3）：本设备 / 主机 / 账号；设置作用的 core 在别处时
 * 主机与账号带上那台的名字，`pinnedLocal` 的页恒为「本机」。
 */
export function useScopeLabel(
  scope: SettingsScope,
  pinnedLocal = false,
): string {
  const t = useT();
  const { remote } = useRemoteAccess();
  const name = useCurrentSource().descriptor.label.trim();
  if (pinnedLocal) return t("settings.scope.local");
  if (scope === "device") return t("settings.scope.device");
  const named = remote && name !== "";
  if (scope === "host")
    return named
      ? t("settings.scope.hostNamed", { name })
      : t("settings.scope.host");
  return named
    ? t("settings.scope.accountNamed", { name })
    : t("settings.scope.account");
}

/**
 * 一枚不可点的作用范围徽标。页头一枚说整页；页内个别行与页不同时，行尾
 * 再放一枚同样式的小徽标（与 `LocalSourceBadge` 同一位置）。
 */
export function ScopeBadge({
  scope,
  pinnedLocal,
  className,
}: {
  scope: SettingsScope;
  pinnedLocal?: boolean;
  className?: string;
}) {
  const label = useScopeLabel(scope, pinnedLocal);
  return (
    <Badge
      variant="outline"
      data-settings-scope={pinnedLocal ? "local" : scope}
      className={cn(
        "max-w-48 shrink-0 font-normal text-muted-foreground",
        className,
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
    </Badge>
  );
}
