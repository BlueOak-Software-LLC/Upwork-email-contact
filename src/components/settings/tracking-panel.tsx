"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { useRunCleanup, useTrackingStats } from "@/lib/api/tracking-hooks";

/**
 * The one place that answers "is tracking actually working, or am I looking at
 * zeros?"
 *
 * Configuration alone cannot tell the difference between disabled, unreachable
 * and simply unread — so the page states the effective settings, proves the
 * retention RPC runs, and hands you a pixel URL you can open yourself.
 */
export function TrackingPanel({
  env,
  verificationToken,
}: {
  env: {
    EMAIL_TRACKING: boolean;
    LINK_TRACKING: boolean;
    provider: string;
    domain: string;
    retentionDays: number;
    production: boolean;
  };
  verificationToken: string | null;
}) {
  const stats = useTrackingStats(14);
  const cleanup = useRunCleanup();
  const [lastRun, setLastRun] = useState<string | null>(null);

  const data = stats.data?.data;
  const reachable = !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(env.domain);
  const effective = env.EMAIL_TRACKING && env.provider !== "log";

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Is tracking on?</h3>
            <p className="mt-1 text-xs text-muted">
              Effective state of this deployment, not what <code>.env.local</code> says.
            </p>
          </div>
          <Badge tone={effective ? (reachable ? "brand" : "warn") : "neutral"}>
            {effective ? (reachable ? "on" : "on, but unreachable") : "off"}
          </Badge>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <Item
            label="EMAIL_TRACKING"
            value={env.EMAIL_TRACKING ? "true" : "false"}
            note={
              env.provider === "log"
                ? "ignored: EMAIL_PROVIDER=log sends nothing, so there is no inbox that could load a pixel"
                : "mints a per-recipient pixel for every send"
            }
          />
          <Item
            label="LINK_TRACKING"
            value={env.LINK_TRACKING ? "true" : "false"}
            note="rewrites http(s) URLs found in the body to /c/<token>; the attached PDF is never rewritten"
          />
          <Item
            label="TRACKING_DOMAIN"
            value={env.domain}
            note={
              reachable
                ? "must be this deployment, over HTTPS, reachable without a login"
                : "a mailbox cannot reach a loopback address — opens will read zero until you set the deployed origin"
            }
            tone={reachable ? undefined : "warn"}
          />
          <Item
            label="TRACKING_RETENTION_DAYS"
            value={String(env.retentionDays)}
            note="open/click rows older than this are deleted by the purge; outcomes and delivery rows are never"
          />
        </dl>

        {env.production ? null : (
          <p className="mt-3 text-[11px] text-muted/80">
            NODE_ENV is <code>{env.provider === "log" ? "dry-run" : "live"}</code> on this instance.
            Tracking numbers only mean something once a real message reaches a real inbox.
          </p>
        )}
      </section>

      <section className="card p-5">
        <h3 className="text-sm font-medium">Last 14 days</h3>
        {data ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-4">
            <Figure label="Delivered" value={String(data.delivered)} />
            <Figure
              label="Opened"
              value={String(data.uniqueOpeners)}
              hint={data.openRate === null ? "—" : `${Math.round(data.openRate * 100)}%`}
            />
            <Figure
              label="Clicked"
              value={String(data.uniqueClickers)}
              hint={data.clickThroughRate === null ? "—" : `${Math.round(data.clickThroughRate * 100)}%`}
            />
            <Figure label="Pixel requests" value={String(data.opens)} hint="not the same as readers" />
          </div>
        ) : stats.isPending ? (
          <p className="mt-3 text-xs text-muted">loading…</p>
        ) : (
          <p className="mt-3 text-xs text-danger">
            {stats.error instanceof Error ? stats.error.message : "Could not read tracking stats."}
          </p>
        )}
        {data?.schemaMissing ? (
          <p className="mt-3 rounded-lg border border-danger/35 bg-danger/8 p-3 text-[11px] text-danger">
            <code>0005_email_tracking.sql</code> is not applied to this project: the tracking
            columns, <code>tracked_links</code>, <code>tracking_events</code> and the record/purge
            RPCs do not exist yet. Every number above is therefore unavailable, not zero. Apply the
            migration and reload.
          </p>
        ) : data && data.delivered > 0 && data.tracked === 0 ? (
          <p className="mt-3 text-[11px] text-warn">
            Not one delivered message in this window carries a pixel: tracking was switched off, or
            those sends predate the migration.
          </p>
        ) : null}
      </section>

      {data && data.domains.length > 0 ? (
        <section className="card overflow-hidden">
          <div className="p-5 pb-3">
            <h3 className="text-sm font-medium">Recipient domains</h3>
            <p className="mt-1 text-xs text-muted">
              Delivered mail grouped by the domain after <code>@</code>. Open rates differ by mailbox
              provider — a low number on one domain is a deliverability signal, not necessarily a
              weak subject line.
            </p>
          </div>
          <Table>
            <THead>
              <Tr>
                <Th>Domain</Th>
                <Th className="text-right">Delivered</Th>
                <Th className="text-right">Opened</Th>
                <Th className="text-right">Open rate</Th>
                <Th className="text-right">Clicked</Th>
              </Tr>
            </THead>
            <TBody>
              {data.domains.map((row) => (
                <Tr key={row.domain}>
                  <Td>
                    <code className="text-[11px] text-ink">{row.domain}</code>
                  </Td>
                  <Td className="text-right">{row.delivered}</Td>
                  <Td className="text-right">{row.opened}</Td>
                  <Td className="text-right">
                    {row.openRate === null ? "—" : `${Math.round(row.openRate * 100)}%`}
                  </Td>
                  <Td className="text-right">{row.clicks}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      ) : null}

      <section className="card p-5">
        <h3 className="text-sm font-medium">Verify it yourself</h3>
        <p className="mt-1 text-xs text-muted">
          Open the pixel address in a new tab. A transparent 1×1 image means the route works; the
          counter on that message moves by one, which is the part worth checking.
        </p>
        <div className="mt-3 space-y-2 text-xs">
          {verificationToken ? (
            <p className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-canvas px-1.5 py-0.5">
                {`${env.domain}/o/${verificationToken}.gif`}
              </code>
              <a
                className="text-brand hover:underline"
                href={`/o/${verificationToken}.gif`}
                target="_blank"
                rel="noreferrer"
              >
                open it now →
              </a>
              <span className="text-muted/70">
                (this counts as an open for that recipient — do it once, not on a loop)
              </span>
            </p>
          ) : (
            <p className="text-muted">
              No tracked message exists yet, so there is nothing to point at. Send one first.
            </p>
          )}
          <p className="text-muted/80">
            Rules that live in the database, not here: one open per client per 60 seconds, 40 opens
            and 200 clicks per message per day, and a capped click still redirects.
          </p>
        </div>
      </section>

      <section className="card p-5">
        <h3 className="text-sm font-medium">Storage and retention</h3>
        <p className="mt-1 text-xs text-muted">
          <code>tracking_events</code> grows with every image request. Run the cleanup to prove the
          RPC is installed and can execute — a scheduled job that silently fails is the classic way
          a tracking table becomes a problem.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            loading={cleanup.isPending}
            onClick={() =>
              void cleanup
                .mutateAsync()
                .then(({ data: result }) =>
                  setLastRun(`${result.removed} removed · window ${result.days} days`),
                )
                .catch(() => undefined)
            }
          >
            Run cleanup now
          </Button>
          {lastRun ? <span className="text-xs text-muted">{lastRun}</span> : null}
          <Link href="/emails" className="text-xs text-brand hover:underline">
            Email log →
          </Link>
        </div>
        {!env.retentionDays ? (
          <p className="mt-2 text-[11px] text-warn">
            Retention window is unset — the purge would delete nothing useful.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Item({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "warn";
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-faint">{label}</dt>
      <dd className={tone === "warn" ? "text-sm font-medium text-warn" : "text-sm font-medium"}>
        {value}
      </dd>
      <dd className="mt-0.5 text-[11px] text-muted">{note}</dd>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="text-2xl font-semibold tabular">{value}</div>
      {hint ? <div className="text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}
