import { ColorDot, type ColorDotProps } from "@/ui/color-dot";

/** 成员色环的长度（设计系统 §2.5）。 */
export const MEMBER_COLOR_COUNT = 8;

/** 第 n 个成员（从 1 起）的颜色变量；超过八个按环回绕。 */
export function memberColorVar(index: number): string {
  const zeroBased = Math.trunc(index) - 1;
  const n =
    (((zeroBased % MEMBER_COLOR_COUNT) + MEMBER_COLOR_COUNT) %
      MEMBER_COLOR_COUNT) +
    1;
  return `var(--member-${n})`;
}

export interface MemberDotProps extends Omit<ColorDotProps, "color" | "title"> {
  /** 成员序号：自己是 1，其他人按加入顺序从 2 起。 */
  index: number;
  /** 成员名，做 `title`。 */
  name: string;
}

/** 成员色点（设计系统 §3.3 薄封装）：`ColorDot` 预设 `--member-n`。 */
export function MemberDot({ index, name, size = 8, ...props }: MemberDotProps) {
  return (
    <ColorDot
      data-member={index}
      color={memberColorVar(index)}
      size={size}
      title={name}
      {...props}
    />
  );
}
