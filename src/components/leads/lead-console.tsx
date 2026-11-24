"use client";

import Link from "next/link";
import { useState } from "react";
import { useLead, useUpdateLead, type LeadDetailDto } from "@/lib/api/outreach-hooks";
import { LeadWorkspace } from "./lead-workspace";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DeleteLeadsDialog } from "./delete-leads-dialog";
import type { LeadSummary } from "@/lib/api/outreach-hooks";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { useRouter } from "next/navigation";
import { formatDate } from "@/lib/utils";
import { LEAD_STATUSES } from "@/types/lead";

/**
 * Client shell for /leads/[id].
 *
 * The server renders the first paint and hands it over as `initialData`; from
 * then on TanStack Query owns the lead. Every mutation on this page either
 * writes the refreshed lead straight into this cache or invalidates it, so the
 * header, the document, the drafts and the step chips all update without a
 * browser refresh. Focusing the tab revalidates too.
 */
export function LeadConsole({ leadId, initial }: { leadId: string; initial: LeadDetailDto }) {
  const query = useLead(leadId, initial);
  const detail = query.data ?? initial;
  const { lead } = detail;

  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Link href="/leads" className="hover:text-ink focus-ring">
          ← All leads
        </Link>
        <span>/</span>
        <span className="text-muted/70">
          {lead.job_id ? `#${lead.job_id}` : lead.dedupe_key.slice(0, 12)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {query.isFetching ? (
            <span className="flex items-center gap-1 text-[11px] text-brand" aria-live="polite">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
              updating
            </span>
          ) : (
            <span className="text-[11px] text-muted/60">live</span>
          )}
          <Button size="sm" variant="ghost" onClick={() => query.refetch()} loading={query.isFetching}>
            Refresh
          </Button>
        </span>
      </nav>

      {query.error && !query.data ? (
        <EmptyState
          tone="danger"
          icon="✕"
          title="This lead could not be reloaded"
          description={query.error.message}
          action={<Button size="sm" onClick={() => query.refetch()}>Try again</Button>}
        />
      ) : null}

      <header className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-snug">{lead.job_title ?? "[untitled job]"}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
              <StatusBadge status={lead.status} />
              <span>confidence {lead.overall_confidence}</span>
              <span>
                · received <TimeAgo value={lead.received_at} /> ({formatDate(lead.received_at)})
              </span>
              {detail.contacts.length ? <span>· {detail.contacts.length} channels</span> : null}
              {detail.proposals.length ? <span>· {detail.proposals.length} document(s)</span> : null}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <StatusPicker leadId={lead.id} status={lead.status} />
            {lead.job_id ? <CopyButton value={lead.job_id} label="Copy job id" /> : null}
            {lead.job_url ? (
              <a
                href={lead.job_url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-9 items-center rounded-lg border border-line px-4 text-sm font-medium transition hover:border-brand/60 hover:text-brand focus-ring"
              >
                Open Upwork job ↗
              </a>
            ) : null}
            <DeleteLeadButton
              leadId={lead.id}
              title={lead.job_title ?? lead.dedupe_key}
              jobId={lead.job_id}
              counts={{
                contacts: detail.contacts.length,
                proposals: detail.proposals.length,
                drafts: detail.drafts.length,
              }}
            />
          </div>
        </div>

        <dl className="mt-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Client (Upwork)" value={lead.client_name} copyable />
          <Field label="Client location" value={lead.client_location} />
          <Field label="Company mentioned" value={lead.company_mentioned} copyable />
          <Field label="Job reference" value={lead.job_id} copyable />
          <Field label="Job location" value={lead.job_location} />
          <Field label="Industry" value={lead.industry} />
        </dl>

        <DescriptionPanel leadId={leadId} detail={detail} />

        {detail.keyPeople.length > 0 ? (
          <section className="mt-5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Key people</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {detail.keyPeople.map((person, index) => {
                const record = (person ?? {}) as Record<string, unknown>;
                const linkedin = record.linkedin_url ? String(record.linkedin_url) : null;
                return (
                  <li key={index} className="rounded-lg border border-line bg-canvas p-3">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {String(record.name ?? "Unknown")}
                      {record.role ? (
                        <span className="text-xs text-muted">{String(record.role)}</span>
                      ) : null}
                      {record.email ? <CopyButton value={String(record.email)} size="icon" label="Copy email" /> : null}
                    </div>
                    {linkedin ? (
                      <a
                        href={linkedin}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-xs text-brand hover:underline"
                      >
                        LinkedIn ↗
                      </a>
                    ) : null}
                    {record.evidence ? (
                      <p className="mt-1 text-xs text-muted/80">
                        {String(record.evidence).slice(0, 300)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </header>

      <LeadWorkspace detail={detail} />
    </div>
  );
}

/**
 * The post text is what the PPD and the email are written from, so it is
 * editable here: a payload that arrived without `job_description` can be topped
 * up by hand, and the change lands in the cache immediately.
 */
function DescriptionPanel({
  leadId,
  detail,
}: {
  leadId: string;
  detail: LeadDetailDto;
}) {
  const update = useUpdateLead(leadId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(detail.lead.job_description ?? "");

  const description = detail.lead.job_description ?? "";
  const chars = description.length;

  const proposalExists = detail.proposals.length > 0;

  return (
    <section className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Job description
          <span className="normal-case tracking-normal">
            {" "}
            · job_information.job_description · {chars} chars
          </span>
        </h2>
        {chars > 0 ? (
          <Badge tone="brand">feeds the PPD and the email prompt</Badge>
        ) : (
          <Badge tone="warn">empty — generation falls back to title + research notes</Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          {chars > 0 ? <CopyButton value={description} label="Copy text" /> : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(description);
              setEditing((v) => !v);
            }}
          >
            {editing ? "Cancel" : "Edit post text"}
          </Button>
        </span>
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            aria-label="Job description"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-line bg-canvas p-3 text-sm leading-relaxed focus-ring"
            placeholder="Paste the Upwork post body here…"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={update.isPending}
              disabled={text.trim() === description.trim()}
              onClick={() => update.mutate({ job_description: text.trim() || null })}
            >
              Save post text
            </Button>
            <span className="text-[11px] text-muted">
              {proposalExists
                ? "Stored on the lead. The document keeps its current text until you regenerate (step 1)."
                : "Stored on the lead — generate the document next."}
            </span>
          </div>
        </div>
      ) : (
        <p className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-canvas p-4 text-sm leading-relaxed text-ink/90">
          {description ||
            "No post body in this payload. Re-post the same job_information with job_description filled in (it dedupes onto this lead), or paste it with Edit post text."}
        </p>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string | null;
  copyable?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 text-ink/90">
        <span className="min-w-0 truncate">{value ?? "—"}</span>
        {value && copyable ? <CopyButton value={value} size="icon" label={`Copy ${label}`} /> : null}
      </dd>
    </div>
  );
}

/**
 * Pipeline status is human-overritable (a prospect replied — mark it, or archive
 * a dead lead) without touching anything the pipeline wrote itself.
 */
function StatusPicker({ leadId, status }: { leadId: string; status: string }) {
  const update = useUpdateLead(leadId);

  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="hidden sm:inline">status</span>
      <select
        aria-label="Lead status"
        value={status}
        disabled={update.isPending}
        onChange={(event) => update.mutate({ status: event.target.value })}
        className="h-9 rounded-lg border border-line bg-surface px-2 text-xs text-ink transition hover:border-brand/60 focus-ring"
      >
        {LEAD_STATUSES.map((value) => (
          <option key={value} value={value}>
            {value.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Removal lives in the shared dialog so the list and this page state the same
 * blast radius — and so the button is honest about PDFs, which a bare row delete
 * would leave behind in storage.
 */
function DeleteLeadButton({
  leadId,
  title,
  jobId,
  counts,
}: {
  leadId: string;
  title: string;
  jobId: string | null;
  counts: { contacts: number; proposals: number; drafts: number };
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-muted hover:bg-danger/10 hover:text-danger"
        title="Remove this job, its documents, drafts and stored PDFs"
      >
        Remove
      </Button>
      <DeleteLeadsDialog
        open={open}
        onClose={() => setOpen(false)}
        leads={[
          {
            id: leadId,
            job_title: title,
            job_id: jobId,
            contact_count: counts.contacts,
            proposal_count: counts.proposals,
            draft_count: counts.drafts,
          } as unknown as LeadSummary,
        ]}
        onRemoved={() => router.push("/leads")}
      />
    </>
  );
}
