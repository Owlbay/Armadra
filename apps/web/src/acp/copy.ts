import { toast } from "sonner";

import { t } from "@/app/preferences-store";

/**
 * 写剪贴板。非安全上下文（局域网 http）没有 `navigator.clipboard`，退回一个
 * 临时 `textarea` + `execCommand`；两条都不行时提示一句，答 `false`。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的退路。
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    if (done) return true;
  } catch {
    // 同上。
  }
  toast.error(t("acp.message.copyFailed"));
  return false;
}
