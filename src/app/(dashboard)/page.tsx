import Link from "next/link";
import { MetricCard, SparkBars } from "@/components/dashboard/metric-card";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getMetrics, getRecentContacts } from "@/server/queries";
import { leadsRepo } from "@/server/db/leads.repo";
import { formatDate } from "@/lib/utils";
import type { Contact, DashboardMetrics } from "@/types/domain";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

type LeadMetrics = NonNullable<Awaited<ReturnType<typeof leadsRepo.metrics>>>;

export default async function OverviewPage() {
  const [metrics, recent, leadMetrics] = await Promise.all([
    attempt<DashboardMetrics | null>(() => getMetrics(), null),
    attempt<Contact[]>(() => getRecentContacts(6), []),
    attempt<LeadMetrics | null>(() => leadsRepo.metrics(), null),
  ]);

  if (!metrics) return <SetupRequired />;

  return (
    <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Leads ingested"
          value={leadMetrics?.total ?? "—"}
          hint={
            leadMetrics
              ? `${leadMetrics.byStatus.draft_created ?? 0} drafted · ${
                  leadMetrics.byStatus.sent ?? 0
                } sent`
              : "Nothing posted to /api/leads yet"
          }
        >
          {leadMetrics ? <SparkBars data={leadMetrics.last7Days} /> : null}
          <div className="mt-3">
            <Link href="/leads" className="text-xs text-brand hover:underline">
              Open leads →
            </Link>
          </div>
        </MetricCard>

        <MetricCard
          label="Total contacts"
          value={metrics.totalContacts}
          hint={`${metrics.newContacts} waiting for first touch`}
        >
          <SparkBars data={metrics.last7Days} />
        </MetricCard>

        <MetricCard
          label="Emails sent (7d)"
          value={metrics.emailsSent7d}
          delta={metrics.emailsFailed7d ? `${metrics.emailsFailed7d} failed` : "no failures"}
          tone={metrics.emailsFailed7d ? "bad" : "good"}
          hint="From public.email_logs"
        />

        <MetricCard
          label="Replies"
          value={metrics.replied}
          hint={`${metrics.contacted} contacts in the funnel`}
        />

        <MetricCard
          label="Reply rate"
          value={`${Math.round(metrics.replyRate * 100)}%`}
          tone={metrics.replyRate > 0.1 ? "good" : "default"}
          hint="replied ÷ contacted"
        />

        <MetricCard
          label="High-confidence leads"
          value={leadMetrics?.byConfidence.HIGH ?? 0}
          tone="good"
          hint={
            leadMetrics
              ? `${leadMetrics.byConfidence.LOW ?? 0} low · ${
                  leadMetrics.byConfidence.UNIDENTIFIED ?? 0
                } unidentified`
              : "No confidence data yet"
          }
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="text-sm font-medium">Latest contacts</h2>
            <Link href="/contacts" className="text-xs text-brand hover:underline">
              Open table →
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted">
              No rows in <code>public.contacts</code> yet.
            </p>
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Company</Th>
                  <Th>Status</Th>
                  <Th>Added</Th>
                </Tr>
              </THead>
              <TBody>
                {recent.map((c) => (
                  <Tr key={c.id}>
                    <Td>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted">{c.email}</div>
                    </Td>
                    <Td className="text-muted">{c.company ?? "—"}</Td>
                    <Td>
                      <StatusBadge status={c.status} />
                    </Td>
                    <Td className="tabular text-muted">{formatDate(c.created_at)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        <div className="card">
          <h2 className="text-sm font-medium">Pipeline</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {Object.entries(metrics.byStatus).map(([status, count]) => {
              const pct = metrics.totalContacts
                ? Math.round((count / metrics.totalContacts) * 100)
                : 0;
              return (
                <li key={status}>
                  <div className="flex justify-between">
                    <StatusBadge status={status} />
                    <span className="tabular text-muted">
                      {count} · {pct}%
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-brand/80"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          {leadMetrics ? (
            <>
              <h2 className="mt-6 text-sm font-medium">Lead status</h2>
              <ul className="mt-3 space-y-2 text-xs">
                {Object.entries(leadMetrics.byStatus).map(([status, count]) => (
                  <li key={status} className="flex justify-between">
                    <StatusBadge status={status} />
                    <span className="tabular text-muted">{count}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}

async function attempt<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function SetupRequired() {
  return (
    <div className="card max-w-2xl p-6">
      <h2 className="text-base font-semibold">Almost there — connect Supabase</h2>
      <p className="mt-2 text-sm text-muted">
        The dashboard reads <code>public.contacts</code>, <code>public.email_logs</code>{" "}
        and <code>public.leads</code> through our own <code>/api</code> routes. To see data:
      </p>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-muted">
        <li>
          Run{" "}
          <code className="rounded bg-surface-2 px-1">
            supabase/migrations/0001_init.sql
          </code>{" "}
          and then{" "}
          <code className="rounded bg-surface-2 px-1">
            0002_leads_senders_proposals.sql
          </code>{" "}
          in the SQL editor (or <code>supabase db push</code>).
        </li>
        <li>
          Copy <code className="rounded bg-surface-2 px-1">.env.example</code> to{" "}
          <code className="rounded bg-surface-2 px-1">.env.local</code> — project URL, anon key,
          service-role key, <code>APP_ENCRYPTION_KEY</code>, <code>GROQ_API_KEY</code>.
        </li>
        <li>
          Restart <code className="rounded bg-surface-2 px-1">npm run dev</code>, then{" "}
          <code className="rounded bg-surface-2 px-1">POST /api/leads</code> with a payload.
        </li>
      </ol>
      <p className="mt-4 text-xs text-muted/80">
        Tip: load <code>supabase/seed.sql</code> for sample contacts and use{" "}
        <code>examples/lead-example.json</code> for a sample lead.
      </p>
    </div>
  );
}
