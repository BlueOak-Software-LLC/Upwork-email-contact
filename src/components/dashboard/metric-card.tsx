import type { ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  delta,
  hint,
  tone = "default",
  children,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  hint?: string;
  tone?: "default" | "good" | "bad";
  children?: ReactNode;
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        {delta ? (
          <span
            className={cn(
              "text-xs font-medium",
              tone === "good" && "text-brand",
              tone === "bad" && "text-danger",
              tone === "default" && "text-muted",
            )}
          >
            {delta}
          </span>
        ) : null}
      </CardHeader>
      <CardValue>{value}</CardValue>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      {children}
    </Card>
  );
}

/** Tiny CSS bar chart — no chart library needed for 7 columns. */
export function SparkBars({ data }: { data: Array<{ day: string; count: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="mt-4 flex h-16 items-end gap-1.5">
      {data.map((d) => (
        <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
          <div
            className="w-full rounded-sm bg-brand/70 transition-[height] duration-500"
            style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }}
            title={`${d.day}: ${d.count}`}
          />
          <span className="text-[10px] text-muted">{d.day.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
