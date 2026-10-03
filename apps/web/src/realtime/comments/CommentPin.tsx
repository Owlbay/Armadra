import * as React from "react";

import { cn } from "@/lib/cn";
import { Button } from "@/ui/button";
import { memberColorVar } from "@/ui/member-dot";

/**
 * 评论钉（设计系统 §4）：24px 圆，`--card` 底、2px 成员色边、里面是计数；
 * 有未解决的线程时右上一个 `--brand` 小点，全部解决后整体 `--faint`；
 * 缩放 < 0.5 只画一个点。按 `1 / zoom` 反缩放，屏幕上尺寸不变。
 */
export interface CommentPinProps
  extends Omit<React.ComponentProps<typeof Button>, "children" | "color"> {
  /** 这枚钉上的评论条数（含回复）。 */
  count: number;
  /** 这枚钉上还有没解决的线程。 */
  open: boolean;
  /** 成员色序号（第一个线程的作者）。 */
  color: number;
  label: string;
  /** 只画点（缩放 < 0.5）。 */
  dot?: boolean;
}

export const CommentPin = React.forwardRef<HTMLButtonElement, CommentPinProps>(
  function CommentPin(
    { count, open, color, label, dot = false, className, style, ...props },
    ref,
  ) {
    const border = open ? memberColorVar(color) : "var(--faint)";
    return (
      <Button
        ref={ref}
        type="button"
        variant="ghost"
        aria-label={label}
        data-comment-pin
        data-open={open ? "true" : undefined}
        className={cn(
          "relative rounded-full border-2 bg-card p-0 font-medium text-foreground shadow-sm hover:bg-card",
          dot
            ? "size-2.5 border-0"
            : "size-6 text-[length:var(--text-caption)]",
          !open && "text-muted-foreground",
          className,
        )}
        style={{
          borderColor: border,
          ...(dot ? { background: border } : {}),
          ...style,
        }}
        {...props}
      >
        {!dot && (count > 99 ? "99+" : count)}
        {!dot && open && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-card bg-[var(--brand)]"
          />
        )}
      </Button>
    );
  },
);
