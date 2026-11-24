"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useDeleteLeads, type LeadSummary } from "@/lib/api/outreach-hooks";
import { truncate } from "@/lib/utils";

/**
 * Permanent removal of jobs — from the list *and* the database.
 *
 * The point of this dialog is that it states the blast radius before you
 * commit: the embedded counts come from `GET /api/leads`, so "2 documents,
 * 1 draft, 4 contacts" is what `DELETE /api/leads` will actually remove, and
 * what it will not (CRM contacts, sent-message log rows) is named too. Bulk
 * removals ask for the word `delete` because there is no undo.
 */
export function DeleteLeadsDialog({
  open,
  onClose,
  leads,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  leads: LeadSummary[];
  onRemoved?: (ids: string[]) => void;
}) {
  const [phrase, setPhrase] = useState("");
  const remove = useDeleteLeads();

  const totals = leads.reduce(
    (acc, lead) => ({
      contacts: acc.contacts + (lead.contact_count ?? 0),
      proposals: acc.proposals + (lead.proposal_count ?? 0),
      drafts: acc.drafts + (lead.draft_count ?? 0),
    }),
    { contacts: 0, proposals: 0, drafts: 0 },
  );

  const needsPhrase = leads.length > 5;
  const armed = !needsPhrase || phrase.trim().toLowerCase() === "delete";

  const close = () => {
    setPhrase("");
    onClose();
  };

  const confirm = async () => {
    const ids = leads.map((lead) => lead.id);
    const response = await remove.mutateAsync(ids);
    if (response) {
      onRemoved?.(ids);
      setPhrase("");
      onClose();
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        leads.length === 1
          ? `Remove “${truncate(leads[0]?.job_title ?? "untitled job", 44)}”?`
          : `Remove ${leads.length} jobs permanently?`
      }
      description="This deletes the rows from Supabase and the rendered PDFs from storage. There is no undo and no trash folder."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={remove.isPending}>
            Keep them
          </Button>
          <Button variant="danger" onClick={confirm} loading={remove.isPending} disabled={!armed}>
            {remove.isPending
              ? "Removing…"
              : leads.length === 1
                ? "Remove this job"
                : `Remove ${leads.length} jobs`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line bg-canvas p-3 text-sm">
          {leads.slice(0, 12).map((lead) => (
            <li key={lead.id} className="flex items-baseline justify-between gap-3">
              <span className="truncate text-ink">
                {truncate(lead.job_title ?? "(no title — description-only post)", 52)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-faint">
                {lead.job_id ? `#${lead.job_id}` : lead.id.slice(0, 8)}
              </span>
            </li>
          ))}
          {leads.length > 12 ? (
            <li className="text-xs text-faint">…and {leads.length - 12} more</li>
          ) : null}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-lg border border-danger/40 bg-danger/10 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-danger">
              Deleted with them
            </h4>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              <li>
                <b className="text-ink tabular">{leads.length}</b> lead row{leads.length === 1 ? "" : "s"}{" "}
                + the raw research payload
              </li>
              <li>
                <b className="text-ink tabular">{totals.proposals}</b> proposal document
                {totals.proposals === 1 ? "" : "s"} and their email copy
              </li>
              <li>
                <b className="text-ink tabular">{totals.drafts}</b> email draft
                {totals.drafts === 1 ? "" : "s"}
              </li>
              <li>
                <b className="text-ink tabular">{totals.contacts}</b> contact channel
                {totals.contacts === 1 ? "" : "s"} found in the payload
              </li>
              <li>every stored PDF for these leads (counted in the result)</li>
            </ul>
          </section>

          <section className="rounded-lg border border-line bg-surface-2/50 p-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Left alone
            </h4>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              <li>
                <b className="text-ink">CRM contacts</b> — a row you promoted to{" "}
                <code className="font-mono text-[10px]">public.contacts</code> is yours, not the
                lead&apos;s
              </li>
              <li>
                <b className="text-ink">Sent-message log</b> — <code className="font-mono text-[10px]">email_logs</code>{" "}
                rows stay as delivery proof, with their lead pointers nulled
              </li>
              <li>
                <b className="text-ink">Sender accounts</b> and saved prompts
              </li>
            </ul>
          </section>
        </div>

        <p className="text-[11px] leading-relaxed text-faint">
          If your scraper posts the same job again later it comes back as a fresh lead — dedupe runs on{" "}
          <code className="font-mono text-[10px]">job_id</code>, then the URL, title+client and post
          body.
        </p>

        {needsPhrase ? (
          <div>
            <label className="text-xs text-muted" htmlFor="delete-confirm-phrase">
              {leads.length} rows is a lot: type <code className="font-mono text-[11px]">delete</code>{" "}
              to arm the button.
            </label>
            <Input
              id="delete-confirm-phrase"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder="delete"
              autoComplete="off"
              className="mt-1 font-mono text-sm"
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
