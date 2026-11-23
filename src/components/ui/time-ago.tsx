"use client";

import { useEffect, useState } from "react";
import { cn, formatAbsolute, relative } from "@/lib/utils";

/**
 * Relative timestamp that keeps itself honest — "just now", "12 min ago",
 * "3 h ago", "2 d ago". Re-renders on a shared minute tick so an open tab does
 * not go stale, and the absolute time is always available as a title.
 */
export function TimeAgo({
  value,
  className,
  withSuffix = true,
}: {
  value: string | Date | null | undefined;
  className?: string;
  withSuffix?: boolean;
}) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!value) return <span className={cn("text-muted", className)}>—</span>;

  const absolute = formatAbsolute(value);

  return (
    <time dateTime={new Date(value).toISOString()} title={absolute} className={className}>
      {relative(new Date(value), withSuffix)}
    </time>
  );
}
