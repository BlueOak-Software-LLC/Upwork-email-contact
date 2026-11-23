"use client";

import { useMemo, useState } from "react";
import { ContactsList } from "./contacts-list";
import { DraftCard } from "./draft-card";
import { ProposalCard } from "./proposal-card";
import type { LeadDetailDto } from "@/lib/api/outreach-hooks";
import type { LeadContactRow, ProposalRow } from "@/types/lead";
import { Badge } from "@/components/ui/badge";

/**
 * Client island on /leads/[id]: chooses which email contact to write for and
 * shows that contact's latest proposal + the drafts it produced.
 */
export function LeadWorkspace({ detail }: { detail: LeadDetailDto }) {
  const emailContacts = useMemo(
    () => detail.contacts.filter((c) => c.is_email),
    [detail.contacts],
  );

  const [selectedId, setSelectedId] = useState<string | null>(
    () =>
      emailContacts.find((c) => c.is_primary)?.id ??
      emailContacts[0]?.id ??
      null,
  );

  const contact: LeadContactRow | null =
    emailContacts.find((c) => c.id === selectedId) ?? emailContacts[0] ?? null;

  const proposal: ProposalRow | null =
    detail.proposals.find((p) => p.lead_contact_id === contact?.id) ??
    detail.proposals[0] ??
    null;

  const drafts = detail.drafts.filter((d) =>
    proposal ? d.proposal_id === proposal.id : true,
  );

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
          <DraftCard
            key={draft.id}
            leadId={detail.lead.id}
            draft={draft}
            contacts={detail.contacts}
          />
        ))}

        <details className="card p-4">
          <summary className="cursor-pointer text-sm font-medium text-muted">
            Raw payload as received
          </summary>
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
            <ContactsList contacts={detail.contacts} />
          </div>
        </section>

        {emailContacts.length === 0 ? (
          <p className="card p-4 text-xs text-muted">
            No address in <code>verified_contacts</code> or{" "}
            <code>potential_contacts</code>, so nothing was drafted. Open a proposal
            after you add one to the payload.
          </p>
        ) : null}
      </aside>
    </div>
  );
}
