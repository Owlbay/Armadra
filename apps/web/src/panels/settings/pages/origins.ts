import { useQuery } from "@tanstack/react-query";

import { listOrigins } from "../../../api/accounts";
import { useT } from "../../../app/preferences-store";

/**
 * 主体的签发方（本机 / 某个中转）。只有出现了中转来源才有区分的意义：
 * 全是本机时 `label` 一律答 null，界面不多出一列。
 */
export function useOrigins(principalIds: readonly string[]) {
  const t = useT();
  const ids = [...new Set(principalIds)].sort();
  const origins = useQuery({
    queryKey: ["accounts", "origins", ids],
    queryFn: () => listOrigins(ids),
    enabled: ids.length > 0,
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
