"use client";

import { useEffect, useMemo, useState } from "react";
import { ContactsList } from "./contacts-list";
import { DraftCard } from "./draft-card";
import { ProposalCard } from "./proposal-card";
import { ManualDraftCard } from "./manual-draft-card";
import type { LeadDetailDto } from "@/lib/api/outreach-hooks";
import type { LeadContactRow, ProposalRow } from "@/types/lead";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Client island on /leads/[id]: chooses which email contact to write for and
 * shows that contact's latest proposal + the drafts it produced.
 *
 * Selection survives live updates: a recipient on the lead, a hand-typed
 * address stored as a manual contact, and the recipient-less document lane
 * (`lead_contact_id = null`) are all reachable, and the choice is kept when
 * the cache refreshes underneath.
 */
export function LeadWorkspace({ detail }: { detail: LeadDetailDto }) {
  const emailContacts = useMemo(() => detail.contacts.filter((c) => c.is_email), [detail.contacts]);

  const [selectedId, setSelectedId] = useState<string | null>(
    () => emailContacts.find((c) => c.is_primary)?.id ?? emailContacts[0]?.id ?? null,
  );

  // Keep the selection valid as contacts appear (a custom address is stored as
  // a manual contact the first time it is used).
  useEffect(() => {
    if (!selectedId && emailContacts.length) {
      setSelectedId(emailContacts.find((c) => c.is_primary)?.id ?? emailContacts[0]?.id ?? null);
    }
  }, [emailContacts, selectedId]);

  const contact: LeadContactRow | null =
    emailContacts.find((c) => c.id === selectedId) ?? emailContacts[0] ?? null;

  const proposal: ProposalRow | null = useMemo(() => {
    if (!detail.proposals.length) return null;
    const forContact = contact ? detail.proposals.find((p) => p.lead_contact_id === contact.id) : null;
    const recipientless = detail.proposals.find((p) => p.lead_contact_id === null);
    return (forContact ?? recipientless ?? detail.proposals[0]) as ProposalRow;
  }, [detail.proposals, contact]);

  const drafts = detail.drafts.filter((d) => (proposal ? d.proposal_id === proposal.id : true));

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        <ProposalCard
          leadId={detail.lead.id}
          proposal={proposal}
          contact={contact}
          contacts={emailContacts}
          onContactChange={setSelectedId}
        />

        {drafts.map((draft) => (
          <DraftCard key={draft.id} leadId={detail.lead.id} draft={draft} contacts={detail.contacts} />
        ))}

        <ManualDraftCard
          leadId={detail.lead.id}
          proposal={proposal}
          contacts={detail.contacts}
          defaultTo={contact?.normalized_value ?? contact?.contact_value ?? ""}
        />

        <details className="card p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-muted">
            Raw payload as received
            <Badge>{JSON.stringify(detail.rawPayload).length.toLocaleString()} chars</Badge>
            <span className="ml-auto flex items-center gap-1 text-[11px]">
              copy
              <CopyButton value={JSON.stringify(detail.rawPayload, null, 2)} size="icon" label="Copy raw payload" />
            </span>
          </summary>
          <p className="mt-2 text-xs text-muted">
            Stored verbatim in <code>leads.raw_payload</code> — normalised fields and contacts are
            derived from it, never written back over it.
          </p>
          <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg bg-canvas p-4 text-[11px] leading-relaxed text-muted">
            {JSON.stringify(detail.rawPayload, null, 2)}
          </pre>
        </details>
      </div>

      <aside className="space-y-4">
        <section className="card p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Found channels</h3>
            <Badge>{detail.contacts.length}</Badge>
          </div>
          <div className="mt-4 max-h-[70vh] overflow-y-auto pr-1">
            <ContactsList contacts={detail.contacts} leadId={detail.lead.id} />
          </div>
        </section>

        {emailContacts.length === 0 ? (
          <p className="card p-4 text-xs text-muted">
            No address in <code>verified_contacts</code> or <code>potential_contacts</code>. The
            document is still generated from the post text; pick <b>Custom email</b> above (or at the
            email step) whenever you know where it should go — it gets stored as a manual contact.
          </p>
        ) : null}

        <PipelineSummary detail={detail} />
      </aside>
    </div>
  );
}

function PipelineSummary({ detail }: { detail: LeadDetailDto }) {
  const sent = detail.drafts.filter((d) => d.status === "sent").length;
  const pendingPdf = detail.proposals.filter((p) => p.pdf_status === "pending").length;
  const reviewed = detail.proposals.filter((p) => p.ppd_reviewed_at).length;

  return (
    <section className="card space-y-2 p-5 text-xs">
      <h3 className="text-sm font-medium">Where this lead stands</h3>
      <Row label="Documents" value={`${detail.proposals.length}`} note={`${reviewed} reviewed`} />
      <Row label="Drafts" value={`${detail.drafts.length}`} note={`${sent} sent`} />
      <Row label="PDFs awaiting render" value={`${pendingPdf}`} note="rendered on preview or send" />
      <Row label="Channels" value={`${detail.contacts.length}`} note="from the payload + manual" />
      <p className="pt-1 text-[11px] leading-relaxed text-muted/80">
        Order is fixed: document → review → email → PDF at send time. The model never writes the PDF.
      </p>
    </section>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/50 pb-1.5 last:border-0">
      <span className="text-muted">{label}</span>
      <span className="text-right">
        <span className="tabular text-ink">{value}</span>
        {note ? <span className="ml-1 text-[11px] text-muted/70">· {note}</span> : null}
      </span>
    </div>
  );
}

/** The payload shape this island renders. */
export type { LeadDetailDto };
