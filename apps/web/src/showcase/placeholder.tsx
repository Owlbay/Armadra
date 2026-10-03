import { Skeleton } from "@/ui/skeleton";

/**
 * 功能分区在实现包落地之前的样子：三块骨架，不写任何「待实现」之类的字
 * （设计系统的硬性规则）。实现包把自己的 `sections/<id>.tsx` 整个换掉，
 * 不再引用它；全部换完之后这个文件可以删掉。
 */
export function SectionPlaceholder() {
  return (
    <div data-showcase-placeholder className="grid gap-3 sm:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-[var(--r-card)] border border-border bg-card p-4"
        >
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
