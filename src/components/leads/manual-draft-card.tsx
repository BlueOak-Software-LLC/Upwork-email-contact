"use client";

import { useEffect, useState } from "react";
import { useCreateManualDraft } from "@/lib/api/outreach-hooks";
import type { LeadContactRow, ProposalRow } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

/**
 * "Write it myself" path: POST /api/leads/:id/drafts without a model call.
 *
 * Useful when the reviewer would rather type the note than edit the model's
 * copy, and it is also how a custom recipient enters the system — the address
 * becomes a manual contact on the lead and the draft keeps
 * `recipient_source: "custom"` for the audit trail.
 */
export function ManualDraftCard({
  leadId,
  proposal,
  contacts,
  defaultTo,
}: {
  leadId: string;
  proposal: ProposalRow | null;
  contacts: LeadContactRow[];
  defaultTo: string;
}) {
  const create = useCreateManualDraft(leadId);
  const [open, setOpen] = useState(false);
  const [toEmail, setToEmail] = useState(defaultTo);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");

  useEffect(() => {
    if (!toEmail && defaultTo) setToEmail(defaultTo);
  }, [defaultTo, toEmail]);

  const valid = toEmail.includes("@") && subject.trim().length > 2 && bodyText.trim().length > 10;

  return (
    <section className="card p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left focus-ring"
      >
        <span>
          <span className="text-sm font-medium">Write the email yourself</span>
          <span className="mt-0.5 block text-xs text-muted">
            No model call. Attaches the reviewed PPD as a PDF on send, like any other draft.
          </span>
        </span>
        <span className="text-xs text-muted">{open ? "hide" : "open"}</span>
      </button>

      {open ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="To" hint="Any address — it is stored as a manual contact on this lead.">
              <Input
                type="email"
                value={toEmail}
                list={`manual-emails-${leadId}`}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="client@example.com"
              />
              <datalist id={`manual-emails-${leadId}`}>
                {contacts
                  .filter((c) => c.is_email)
                  .map((c) => (
                    <option key={c.id} value={c.normalized_value ?? c.contact_value} />
                  ))}
              </datalist>
            </Field>
            <Field label="Cc (comma separated)">
              <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="boss@yourdomain.com" />
            </Field>
          </div>

          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>

          <Field label="Message">
            <textarea
              rows={10}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas p-3 text-sm leading-relaxed focus-ring"
              placeholder={"Hello,\n\n…\n\nBest regards"}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              loading={create.isPending}
              disabled={!valid}
              onClick={() =>
                create.mutate(
                  {
                    toEmail: toEmail.trim(),
                    subject: subject.trim(),
                    bodyText,
                    ...(cc.trim()
                      ? { cc: cc.split(",").map((v) => v.trim()).filter(Boolean) }
                      : {}),
                    ...(proposal ? { proposalId: proposal.id } : {}),
                  },
                  {
                    onSuccess: () => {
                      setSubject("");
                      setBodyText("");
                      setOpen(false);
                    },
                    onError: () => undefined,
                  },
                )
              }
            >
              Create draft
            </Button>
            {!valid ? (
              <span className="text-[11px] text-muted">
                needs an address, a subject and a message over 10 characters
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {create.data ? (
        <p className="mt-3 text-xs text-brand" aria-live="polite">
          Draft {create.data.data.draft.id.slice(0, 8)} added below.
        </p>
      ) : null}
    </section>
  );
}
