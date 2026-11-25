import Link from "next/link";
import {
  ACTIVITY_PERIODS,
  activityTotals,
  type ActivityBucket,
  type ActivityPeriod,
} from "@/lib/activity";
import { cn } from "@/lib/utils";

const SERIES = [
  { key: "leads", label: "Leads", bar: "bg-brand", dot: "bg-brand" },
  { key: "sent", label: "Emails sent", bar: "bg-info", dot: "bg-info" },
  { key: "opens", label: "Opened", bar: "bg-warn", dot: "bg-warn" },
  { key: "clicks", label: "Clicked", bar: "bg-ink/60", dot: "bg-ink/60" },
] as const;

export function ActivityChart({
  period,
  buckets,
  trackingAvailable,
}: {
  period: ActivityPeriod;
  buckets: ActivityBucket[];
  trackingAvailable: boolean;
}) {
  const totals = activityTotals(buckets);
  const max = Math.max(
    1,
    ...buckets.flatMap((bucket) => [bucket.leads, bucket.sent, bucket.opens, bucket.clicks]),
  );
  const windowLabel = ACTIVITY_PERIODS[period].windowLabel;

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-sm font-medium">Activity</h2>
          <p className="mt-1 text-xs text-muted">
            {windowLabel} · leads added, emails sent, unique opens and unique link clicks
          </p>
        </div>
        <nav
          aria-label="Activity grouping"
          className="flex rounded-lg border border-line bg-surface-2 p-0.5"
        >
          {(Object.keys(ACTIVITY_PERIODS) as ActivityPeriod[]).map((key) => (
            <Link
              key={key}
              href={key === "day" ? "/" : "/?period=" + key}
              aria-current={key === period ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition focus-ring",
                key === period
                  ? "bg-brand text-brand-ink"
                  : "text-muted hover:bg-surface-3 hover:text-ink",
              )}
            >
              {ACTIVITY_PERIODS[key].label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="p-5">
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {SERIES.map((series) => (
            <div key={series.key} className="min-w-24">
              <div className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className={cn("h-2 w-2 rounded-full", series.dot)} aria-hidden />
                {series.label}
              </div>
              <div className="mt-0.5 text-xl font-semibold tabular text-ink">
                {totals[series.key].toLocaleString()}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 overflow-x-auto pb-1">
          <div className="min-w-[420px]">
            <div className="relative h-44">
              <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
                {[0, 1, 2, 3].map((line) => (
                  <div key={line} className="border-t border-line/45" />
                ))}
              </div>
              <div className="relative flex h-full items-end gap-1.5">
                {buckets.map((bucket) => (
                  <div
                    key={bucket.key}
                    role="group"
                    aria-label={
                      bucket.fullLabel +
                      ": " +
                      bucket.leads +
                      " leads, " +
                      bucket.sent +
                      " sent, " +
                      bucket.opens +
                      " opened, " +
                      bucket.clicks +
                      " clicked"
                    }
                    title={
                      bucket.fullLabel +
                      " · " +
                      bucket.leads +
                      " leads · " +
                      bucket.sent +
                      " sent · " +
                      bucket.opens +
                      " opened · " +
                      bucket.clicks +
                      " clicked"
                    }
                    className="flex h-full flex-1 items-end justify-center gap-[2px]"
                  >
                    {SERIES.map((series) => {
                      const value = bucket[series.key];
                      const height = value > 0 ? Math.max(3, (value / max) * 100) : 0;
                      return (
                        <span
                          key={series.key}
                          className={cn("w-1.5 rounded-t-sm sm:w-2", series.bar)}
                          style={{ height: height + "%" }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-2 flex gap-1.5" aria-hidden>
              {buckets.map((bucket) => (
                <div key={bucket.key} className="flex-1 text-center text-[10px] text-faint">
                  {bucket.label}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted/80">
          <span>
            {totals.leads + totals.sent + totals.opens + totals.clicks === 0
              ? "No activity in this window yet."
              : "Bars share one scale; " + max.toLocaleString() + " is the tallest bar in this window."}
          </span>
          {!trackingAvailable ? (
            <span className="text-warn">
              Tracking data is not readable — opens and clicks show zero, not &ldquo;nobody opened&rdquo;.
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
