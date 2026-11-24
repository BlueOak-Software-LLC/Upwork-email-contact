import Link from "next/link";
import type { Metadata } from "next";
import { emailLogsRepo } from "@/server/db/email-logs.repo";
import { getTrackingOverview } from "@/server/queries";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { truncate } from "@/lib/utils";
import { describeOpens, rate, TRACKING_TONE, trackingStateLabel, trackingStateOf } from "@/lib/tracking";
import { LiveRefresh } from "@/components/layout/live-refresh";
import type { EmailLogRow, TrackingState } from "@/types/domain";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Email log" };

const TRACKING_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "Any activity" },
  { value: "clicked", label: "Clicked" },
  { value: "opened", label: "Opened, not clicked" },
  { value: "sent", label: "Sent, not opened" },
  { value: "untracked", label: "Not tracked" },
];

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EmailsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const activityFilter = pick(params.tracking);
  const status = pick(params.status);
  const domain = pick(params.domain)?.toLowerCase();

  // Keep the two filters composable: a tracking link must not silently drop the
  // domain, and the domain form must not silently drop the activity filter.
  const filteredHref = (next: { tracking?: string; domain?: string }) => {
    const query = new URLSearchParams();
    if (next.tracking) query.set("tracking", next.tracking);
    if (next.domain) query.set("domain", next.domain);
    const value = query.toString();
    return value ? `/emails?${value}` : "/emails";
  };

  const [logs, stats] = await Promise.all([
    emailLogsRepo
      .list({
        page: 1,
        pageSize: 100,
        ...(status ? { status: status as EmailLogRow["status"] } : {}),
        ...(activityFilter ? { tracking: activityFilter as TrackingState } : {}),
        ...(domain ? { domain } : {}),
      })
      .catch(() => null),
    getTrackingOverview(7),
  ]);

  if (!logs) {
    return (
      <div className="card">
        <EmptyState
          tone="danger"
          icon="✕"
          title="public.email_logs could not be read"
          description="Apply the migrations (0005 adds the tracking columns) and set the Supabase env vars, then reload — this page re-runs the query on focus."
        />
      </div>
    );
  }

  const items = logs.items;
  const tracked = items.filter((log) => Boolean(log.tracking_token));
  const opened = tracked.filter((log) => Number(log.open_count) > 0);
  const clicked = tracked.filter((log) => Number(log.click_count) > 0);

  return (
    <div className="space-y-4">
      <LiveRefresh intervalMs={30_000} />

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium text-muted">Delivery and activity</h2>
          <p className="text-xs text-muted/80">
            One row per recipient. <b>Status</b> is what the provider said;{" "}
            <b>Activity</b> is what the tracked pixel and links reported.
          </p>
        </div>
        <span className="text-xs text-muted tabular">
          {logs.total} total · showing {items.length}
        </span>
      </div>

      <div className="card p-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Figure label="Tracked here" value={String(tracked.length)} hint={`of ${items.length} shown`} />
          <Figure
            label="Opened"
            value={String(opened.length)}
            hint={`${rate(opened.length, tracked.length)} of tracked`}
          />
          <Figure
            label="Clicked"
            value={String(clicked.length)}
            hint={`${rate(clicked.length, opened.length)} of openers`}
          />
          <Figure
            label="No image part"
            value={String(items.length - tracked.length)}
            hint="sent before tracking, or untracked on purpose"
          />
        </div>
        {stats?.schemaMissing ? (
          <p className="mt-3 text-[11px] text-danger">
            <code>0005_email_tracking.sql</code> is not applied: the delivery rows are readable but
            their activity columns are not, so every Activity cell below reads
            &ldquo;not tracked&rdquo; whatever happened.
          </p>
        ) : tracked.length === 0 ? (
          <p className="mt-3 text-[11px] text-warn">
            Nothing on this page carries a tracking pixel. Check{" "}
            <code>EMAIL_TRACKING</code>, and that <code>TRACKING_DOMAIN</code> is a public HTTPS
            origin a recipient can reach — a pixel nobody can load always reads zero.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-faint">Activity</span>
        {TRACKING_FILTERS.map((filter) => (
          <Link
            key={filter.value}
            href={filteredHref({ ...(filter.value ? { tracking: filter.value } : {}), ...(domain ? { domain } : {}) })}
            className={
              filter.value === (activityFilter ?? "")
                ? "rounded-full border border-brand/40 bg-brand/12 px-2.5 py-0.5 text-[11px] text-brand"
                : "rounded-full border border-line-soft px-2.5 py-0.5 text-[11px] text-muted hover:border-line hover:text-ink"
            }
          >
            {filter.label}
          </Link>
        ))}
      </div>

      <form action="/emails" method="get" className="flex flex-wrap items-end gap-2">
        {activityFilter ? <input type="hidden" name="tracking" value={activityFilter} /> : null}
        <label className="space-y-1">
          <span className="block text-[11px] uppercase tracking-wide text-faint">Recipient domain</span>
          <input
            type="text"
            name="domain"
            defaultValue={domain ?? ""}
            placeholder="acme.com"
            spellCheck={false}
            className="h-8 w-56 rounded-lg border border-line bg-canvas px-2.5 text-xs text-ink outline-none transition hover:border-line-strong focus:border-brand/70 focus-ring"
          />
        </label>
        <button
          type="submit"
          className="h-8 rounded-lg border border-line bg-surface-2 px-3 text-xs text-ink transition hover:border-brand/60"
        >
          Filter
        </button>
        {domain ? (
          <Link
            href={filteredHref({ ...(activityFilter ? { tracking: activityFilter } : {}) })}
            className="pb-1.5 text-xs text-muted hover:text-ink"
          >
            clear domain
          </Link>
        ) : null}
      </form>

      <div className="card overflow-hidden">
        {items.length === 0 ? (
          <EmptyState
            title="Nothing matches this filter"
            description={
              <>
                Every <code>POST /api/email/send</code> and every draft send writes one row per
                recipient here, with provider, message id, error text and its tracking counters.
              </>
            }
            action={
              <Link href="/leads" className="text-xs text-brand hover:underline">
                Go to a lead and send a draft →
              </Link>
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Status</Th>
                <Th>Activity</Th>
                <Th>To</Th>
                <Th>Subject</Th>
                <Th>Provider</Th>
                <Th>When</Th>
              </Tr>
            </THead>
            <TBody>
              {items.map((log) => {
                const state = trackingStateOf(log);
                return (
                  <Tr key={log.id}>
                    <Td>
                      <StatusBadge status={log.status} />
                    </Td>
                    <Td>
                      <Link href={`/emails/${log.id}`} className="group block">
                        <Badge tone={TRACKING_TONE[state]}>{trackingStateLabel(state)}</Badge>
                        <div className="mt-1 text-[11px] text-muted/80 group-hover:text-ink">
                          {describeActivity(log)}
                        </div>
                      </Link>
                    </Td>
                    <Td className="font-medium">
                      <span className="flex items-center gap-1.5">
                        {log.to_email}
                        <CopyButton value={log.to_email} size="icon" label="Copy recipient" />
                      </span>
                      {log.draft_id ? (
                        <div className="text-[11px] font-normal text-muted/70">
                          draft {String(log.draft_id).slice(0, 8)}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-muted">
                      <Link href={`/emails/${log.id}`} className="hover:text-ink">
                        {truncate(log.subject, 48)}
                      </Link>
                    </Td>
                    <Td className="text-muted">
                      {log.provider === "log" ? (
                        <span className="rounded bg-warn/12 px-1.5 py-0.5 text-[11px] text-warn">
                          log only (dry run)
                        </span>
                      ) : log.provider === "pending" ? (
                        <span className="rounded bg-info/12 px-1.5 py-0.5 text-[11px] text-info">
                          sending…
                        </span>
                      ) : (
                        log.provider
                      )}
                      <div className="text-[11px] text-muted/60">
                        {log.provider_message_id ? truncate(log.provider_message_id, 24) : "—"}
                      </div>
                    </Td>
                    <Td className="text-xs text-muted">
                      <TimeAgo value={log.created_at} />
                      {log.last_event_at ? (
                        <div className="text-[11px] text-brand/80">
                          activity <TimeAgo value={log.last_event_at} />
                        </div>
                      ) : null}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </div>

      <p className="text-[11px] text-muted/70">
        An <b>opened</b> row means a client fetched the tracking image. Privacy proxies and link
        scanners do that without a human reading anything, so treat it as a signal worth acting on,
        not as proof.
      </p>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="text-2xl font-semibold tabular">{value}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </div>
  );
}

function describeActivity(log: EmailLogRow): string {
  if (!log.tracking_token) return "no pixel in this message";
  const opens = Number(log.open_count);
  const clicks = Number(log.click_count);
  if (!opens && !clicks) return "not opened yet";
  const parts = [opens ? describeOpens(opens) : "", clicks ? `${clicks} click${clicks === 1 ? "" : "s"}` : ""];
  if (log.last_open_at) parts.push(`last ${new Date(log.last_open_at).toLocaleString()}`);
  return parts.filter(Boolean).join(" · ");
}

function pick(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() ? raw.trim() : undefined;
}
