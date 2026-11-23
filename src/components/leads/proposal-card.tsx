"use client";

import { useState } from "react";
import { useGenerateProposal } from "@/lib/api/outreach-hooks";
import type { LeadContactRow, ProposalRow } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, truncate } from "@/lib/utils";

/**
 * The Professional Proposal Document, rendered from the pdfme field contract
 * (so you can read it without opening the PDF) plus the raw JSON tab.
 */
export function ProposalCard({
  leadId,
  proposal,
  contact,
  contacts,
  onContactChange,
}: {
  leadId: string;
  proposal: ProposalRow | null;
  contact: LeadContactRow | null;
  contacts: LeadContactRow[];
  onContactChange: (id: string) => void;
}) {
  const generate = useGenerateProposal(leadId);
  const [tab, setTab] = useState<"rendered" | "json">("rendered");

  const ppd = (proposal?.ppd ?? null) as Record<string, unknown> | null;
  const busy = generate.isPending;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Proposal (PPD)</h3>
          <select
            aria-label="Recipient contact"
            className="rounded-md border border-line bg-canvas px-2 py-1 text-xs text-muted focus-ring"
            value={contact?.id ?? ""}
            onChange={(e) => onContactChange(e.target.value)}
          >
            <option value="">Select an email contact</option>
            {contacts
              .filter((c) => c.is_email)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.normalized_value ?? c.contact_value} · {c.list_type}
                  {c.confidence ? ` · ${c.confidence}` : ""}
                </option>
              ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          {proposal ? (
            <span className="text-[11px] text-muted">
              v{proposal.version} · {proposal.provider} {proposal.model ? `/${proposal.model}` : ""}
            </span>
          ) : null}
          <Button
            size="sm"
            loading={busy}
            disabled={!contact}
            onClick={() =>
              generate.mutate(
                { contactId: contact?.id, regenerate: true },
                { onError: () => undefined },
              )
            }
          >
            {proposal ? "Regenerate" : "Generate proposal"}
          </Button>
        </div>
      </div>

      {tab === "rendered" ? (
        ppd ? (
          <article className="space-y-5 rounded-lg bg-canvas p-5 text-sm leading-relaxed">
            <header>
              <h4 className="text-lg font-semibold">{String(ppd.document_title ?? "")}</h4>
              <p className="text-xs text-muted">{String(ppd.proposal_subtitle ?? "")}</p>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                {rows(ppd, [
                  "prepared_for",
                  "client_company",
                  "contact_name",
                  "prepared_by",
                  "prepared_date",
                  "valid_until",
                  "job_reference",
                ])}
              </dl>
            </header>

            <Section title="Engagement summary" text={ppd.engagement_summary} />
            <Section title="Our understanding" text={ppd.understanding} />
            <List title={String(ppd.scope_title ?? "Scope of work")} items={ppd.deliverables} />
            <List title="Approach" items={ppd.approach} />
            <List title="Why us" items={ppd.why_us} />

            <div>
              <h5 className="text-xs font-medium uppercase tracking-wide text-muted">
                Timeline
              </h5>
              <dl className="mt-2 grid gap-x-6 text-xs sm:grid-cols-3">
                {rows(ppd, ["timeline_label_1", "timeline_value_1", "timeline_label_2", "timeline_value_2", "timeline_label_3", "timeline_value_3"])}
              </dl>
            </div>

            <div>
              <h5 className="text-xs font-medium uppercase tracking-wide text-muted">
                {String(ppd.pricing_title ?? "Pricing")}
              </h5>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {["1", "2"].map((n) => (
                  <div key={n} className="rounded-lg border border-line p-3">
                    <div className="flex justify-between gap-2 text-xs">
                      <span className="font-medium">{String(ppd[`pricing_option_${n}_name`] ?? "")}</span>
                      <span className="text-muted tabular">
                        {String(ppd[`pricing_option_${n}_price`] ?? "")}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      {String(ppd[`pricing_option_${n}_notes`] ?? "")}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <List title="What's included" items={ppd.includes} />
            <List title="Assumptions" items={ppd.assumptions} />
            <List title="Next steps" items={ppd.next_steps} />

            <footer className="border-t border-line pt-3 text-xs text-muted">
              {String(ppd.closing_note ?? "")}
              <div className="mt-1">{String(ppd.contact_name_signature ?? "")} · {String(ppd.contact_email ?? "")}</div>
            </footer>
          </article>
        ) : (
          <p className="rounded-lg bg-canvas p-6 text-sm text-muted">
            No proposal yet. Pick an email contact above and hit{" "}
            <b>Generate proposal</b> — that calls Groq, stores the PPD and opens an
            SMTP draft.
          </p>
        )
      ) : (
        <pre className="max-h-96 overflow-auto rounded-lg bg-canvas p-4 text-[11px] leading-relaxed text-muted">
          {proposal ? JSON.stringify(proposal.ppd, null, 2) : "null"}
        </pre>
      )}

      <div className="flex items-center gap-2 text-[11px] text-muted">
        <button
          type="button"
          onClick={() => setTab("rendered")}
          className={cn("rounded px-2 py-1", tab === "rendered" ? "bg-surface-2 text-ink" : "hover:text-ink")}
        >
          Read
        </button>
        <button
          type="button"
          onClick={() => setTab("json")}
          className={cn("rounded px-2 py-1", tab === "json" ? "bg-surface-2 text-ink" : "hover:text-ink")}
        >
          PDF JSON (PPD)
        </button>
        {proposal?.pdf_status ? (
          <Badge tone={proposal.pdf_status === "ready" ? "brand" : "neutral"}>
            pdf {proposal.pdf_status}
          </Badge>
        ) : null}
      </div>

      {generate.data ? (
        <p className="text-xs text-brand">
          Proposal v{(generate.data.data.proposal as { version?: number }).version ?? "?"} ready
          {generate.data.data.draft ? " · draft created" : ""}
          {generate.data.data.draftError
            ? ` · draft skipped: ${generate.data.data.draftError}`
            : ""}
        </p>
      ) : null}
      {generate.error ? (
        <p className="text-xs text-danger">{truncate(generate.error.message, 220)}</p>
      ) : null}
      {proposal?.error ? <p className="text-xs text-danger">{proposal.error}</p> : null}
    </section>
  );
}

function Section({ title, text }: { title: string; text?: unknown }) {
  if (!text) return null;
  return (
    <div>
      <h5 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h5>
      <p className="mt-1.5 text-[13px] text-ink/90">{String(text)}</p>
    </div>
  );
}

function List({ title, items }: { title: string; items?: unknown }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  return (
    <div>
      <h5 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h5>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px]">
        {list.map((item, index) => (
          <li key={index}>{String(item)}</li>
        ))}
      </ul>
    </div>
  );
}

function rows(ppd: Record<string, unknown>, keys: string[]) {
  return keys
    .filter((key) => ppd[key] !== undefined && ppd[key] !== null && String(ppd[key]) !== "")
    .map((key) => (
      <div key={key} className="flex justify-between gap-3 border-b border-line/40 py-1">
        <p className="text-xs text-muted">{key.replace(/_/g, " ")}</p>
        <span className="text-right text-ink/90">{String(ppd[key])}</span>
      </div>
    ));
}
