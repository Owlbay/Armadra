import { useQuery } from "@tanstack/react-query";

import { listOrigins } from "../../../api/accounts";
import { useT } from "../../../app/preferences-store";
import { useAccess } from "../../../app/use-access";

/**
 * 主体的签发方（本机 / 某个中转）。只有出现了中转来源才有区分的意义：
 * 全是本机时 `label` 一律答 null，界面不多出一列。
 */
export function useOrigins(principalIds: readonly string[]) {
  const t = useT();
  // 中转登记表只有 owner 读得到（成员读会 403），成员一律不分来源。
  const owner = !useAccess().member;
  const ids = [...new Set(principalIds)].sort();
  const origins = useQuery({
    queryKey: ["accounts", "origins", ids],
    queryFn: () => listOrigins(ids),
    enabled: owner && ids.length > 0,
  });
  const map = origins.data ?? {};
  const mixed = Object.values(map).some((origin) => origin.kind === "relay");
  return {
    mixed,
    /** 列里显示的文字；没有中转来源时为 null。 */
    label(principalId: string): string | null {
      if (!mixed) return null;
      const origin = map[principalId];
      return origin?.kind === "relay"
        ? origin.label
        : t("sharing.origin.local");
    },
  };
}
