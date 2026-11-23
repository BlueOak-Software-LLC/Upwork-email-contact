import Link from "next/link";
import { notFound } from "next/navigation";
import { LeadWorkspace } from "@/components/leads/lead-workspace";
import { StatusBadge } from "@/components/ui/badge";
import { leadsRepo } from "@/server/db/leads.repo";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const detail = await leadsRepo.detail(id).catch(() => null);
  if (!detail) notFound();

  const { lead } = detail;
  const descriptionChars = (lead.job_description ?? "").length;

  return (
    <div className="space-y-5">
      <nav className="flex items-center gap-2 text-xs text-muted">
        <Link href="/leads" className="hover:text-ink focus-ring">
          ← All leads
        </Link>
        <span>/</span>
        <span className="text-muted/70">
          {lead.job_id ? `#${lead.job_id}` : lead.dedupe_key.slice(0, 12)}
        </span>
      </nav>

      <header className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-snug">
              {lead.job_title ?? "[untitled job]"}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
              <StatusBadge status={lead.status} />
              <span>confidence {lead.overall_confidence}</span>
              <span>· received {formatDate(lead.received_at)}</span>
            </div>
          </div>

          {lead.job_url ? (
            <a
              href={lead.job_url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-line px-4 text-sm font-medium transition hover:border-brand/60 hover:text-brand focus-ring"
            >
              Open Upwork job ↗
            </a>
          ) : null}
        </div>

        <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Client (Upwork)" value={lead.client_name} />
          <Field label="Client location" value={lead.client_location} />
          <Field label="Company mentioned" value={lead.company_mentioned} />
          <Field label="Job reference" value={lead.job_id} />
          <Field label="Job location" value={lead.job_location} />
          <Field label="Industry" value={lead.industry} />
        </dl>

        <section className="mt-5">
          <h2 className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
            Job description
            <span className="normal-case tracking-normal">
              · job_information.job_description · {descriptionChars} chars
            </span>
            {descriptionChars > 0 ? (
              <span className="rounded bg-brand/12 px-1.5 py-0.5 normal-case tracking-normal text-brand">
                fed into the PPD and the email prompt
              </span>
            ) : (
              <span className="rounded bg-warn/12 px-1.5 py-0.5 normal-case tracking-normal text-warn">
                empty — the document falls back to title + research notes
              </span>
            )}
          </h2>
          <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-canvas p-4 text-sm leading-relaxed text-ink/90">
            {lead.job_description ??
              "No post body in this payload. Re-post the same job_information with job_description filled in (it dedupes onto this lead by job_id), or send it to PATCH /api/leads/" +
                lead.id}
          </p>
        </section>

        {detail.keyPeople.length > 0 ? (
          <section className="mt-5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
              Key people
            </h2>
            <ul className="mt-2 space-y-2 text-sm">
              {detail.keyPeople.map((person, index) => (
                <li key={index} className="rounded-lg border border-line bg-canvas p-3">
                  <div className="font-medium">
                    {String((person as Record<string, unknown>).name ?? "Unknown")}
                    <span className="ml-2 text-xs text-muted">
                      {String((person as Record<string, unknown>).role ?? "")}
                    </span>
                  </div>
                  {(person as Record<string, unknown>).linkedin_url ? (
                    <a
                      href={String((person as Record<string, unknown>).linkedin_url)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-brand hover:underline"
                    >
                      LinkedIn ↗
                    </a>
                  ) : null}
                  {(person as Record<string, unknown>).evidence ? (
                    <p className="mt-1 text-xs text-muted/80">
                      {String((person as Record<string, unknown>).evidence).slice(0, 300)}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </header>

      <LeadWorkspace detail={detail} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-ink/90">{value ?? "—"}</dd>
    </div>
  );
}
