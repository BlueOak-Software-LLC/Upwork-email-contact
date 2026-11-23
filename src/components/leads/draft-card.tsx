"use client";

import { useState } from "react";
import { useEditDraft, useSendDraft } from "@/lib/api/outreach-hooks";
import { useSenderAccounts } from "@/lib/api/outreach-hooks";
import type { EmailDraftRow } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/badge";

/**
 * Draft + send panel on the lead detail page.
 * Edit → PATCH /api/drafts/:id, Send → POST /api/drafts/:id/send (SMTP from
 * the stored sender account), PDF → GET /api/leads/:id/pdf.
 */
export function DraftCard({
  leadId,
  draft,
}: {
  leadId: string;
  draft: EmailDraftRow;
}) {
  const send = useSendDraft(leadId);
  const edit = useEditDraft(leadId);
  const accounts = useSenderAccounts();

  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body_text);
  const [senderAccountId, setSenderAccountId] = useState(draft.sender_account_id ?? "");

  const sent = draft.status === "sent";

  const save = async () => {
    await edit
      .mutateAsync({
        draftId: draft.id,
        patch: {
          subject: subject !== draft.subject ? subject : undefined,
          bodyText: body !== draft.body_text ? body : undefined,
          senderAccountId:
            senderAccountId !== (draft.sender_account_id ?? "")
              ? senderAccountId || null
              : undefined,
        },
      })
      .catch(() => undefined);
    setEditing(false);
  };

  const mutationError = (edit.error ?? send.error) as Error | null;

  const pdfBase = `/api/leads/${leadId}/pdf`;
  const pdfUrl = draft.proposal_id ? `${pdfBase}?proposalId=${draft.proposal_id}` : pdfBase;
  const pdfDownload = `${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}download=true`;

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Email draft</h3>
          <p className="text-xs text-muted">
            to <span className="text-ink">{draft.to_email}</span>
            {draft.attachments && (draft.attachments as unknown[]).length
              ? ` · ${String((draft.attachments as unknown[]).length)} attachment(s)`
              : ""}
          </p>
        </div>
        <StatusBadge status={draft.status} />
      </div>

      {editing ? (
        <div className="space-y-4">
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Sender account" hint="SMTP credentials come from sender_accounts">
            <Select
              value={senderAccountId}
              onChange={(e) => setSenderAccountId(e.target.value)}
            >
              <option value="">(use default)</option>
              {(accounts.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} — {account.from_email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Message">
            <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={edit.isPending} onClick={save}>
              Save draft
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg bg-canvas p-4">
            <div className="text-sm font-medium">{draft.subject}</div>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
              {draft.body_text}
            </pre>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing(true)}
              disabled={sent}
            >
              Edit
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs font-medium text-muted transition hover:border-brand/60 hover:text-ink"
            >
              Open PDF
            </a>
            <a
              href={pdfDownload}
              className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs font-medium text-muted transition hover:border-brand/60 hover:text-ink"
            >
              Download PDF
            </a>
            <Button
              size="sm"
              className="ml-auto"
              loading={send.isPending}
              disabled={sent}
              onClick={() =>
                send.mutate(draft.id, {
                  onError: () => undefined,
                })
              }
            >
              {sent ? "Sent" : "Send via SMTP"}
            </Button>
          </div>
        </div>
      )}

      {send.data ? (
        <p className="text-xs text-brand">
          Sent to {(send.data.data.results ?? []).map((r) => r.to).join(", ")}
        </p>
      ) : null}
      {draft.error ? <p className="text-xs text-danger">{draft.error}</p> : null}
      {mutationError ? (
        <p className="text-xs text-danger">{mutationError.message}</p>
      ) : null}
    </section>
  );
}
