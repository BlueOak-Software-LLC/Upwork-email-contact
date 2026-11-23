import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One empty/failed-state block for every list and card, so a screen that has
 * nothing to show always says why and what to do next.
 */
export function EmptyState({
  icon = "○",
  title,
  description,
  action,
  tone = "neutral",
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "warn" | "danger";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-6 py-12 text-center",
        tone === "danger" && "text-danger",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid h-10 w-10 place-items-center rounded-full border text-base",
          tone === "danger"
            ? "border-danger/40 bg-danger/10"
            : tone === "warn"
              ? "border-warn/40 bg-warn/10"
              : "border-line bg-surface-2 text-muted",
        )}
      >
        {icon}
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
