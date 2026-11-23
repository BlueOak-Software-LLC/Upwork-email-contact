"use client";

import { useEffect, useState } from "react";
import {
  useEditDraft,
  useSendDraft,
  useSenderAccounts,
} from "@/lib/api/outreach-hooks";
import type { EmailDraftRow, LeadContactRow } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/badge";

/**
 * Step 4 of the pipeline: the draft a human approves.
 *
 * Recipient is editable — you can send to any address, not only the ones in the
 * Upwork payload. Sending calls `ensureDraftPdf()`, which compiles the PDF from
 * the **reviewed** PPD and attaches it, then delivers over SMTP using the
 * sender account selected here (AES-256-GCM credentials in `sender_accounts`).
 */
export function DraftCard({
  leadId,
  draft,
  contacts,
}: {
  leadId: string;
  draft: EmailDraftRow;
  contacts: LeadContactRow[];
}) {
  const send = useSendDraft(leadId);
  const edit = useEditDraft(leadId);
  const accounts = useSenderAccounts();

  const [editing, setEditing] = useState(draft.status === "draft");
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body_text);
  const [toEmail, setToEmail] = useState(draft.to_email);
  const [cc, setCc] = useState((draft.cc ?? []).join(", "));
  const [senderAccountId, setSenderAccountId] = useState(draft.sender_account_id ?? "");
  const [attachPdf, setAttachPdf] = useState(true);

  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body_text);
    setToEmail(draft.to_email);
    setCc((draft.cc ?? []).join(", "));
    setSenderAccountId(draft.sender_account_id ?? "");
  }, [draft]);

  const sent = draft.status === "sent";
  const emailContacts = contacts.filter((c) => c.is_email);

  const pdfBase = `/api/leads/${leadId}/pdf`;
  const pdfUrl = draft.proposal_id ? `${pdfBase}?proposalId=${draft.proposal_id}` : pdfBase;
  const hasPdf = Boolean(draft.attachments && (draft.attachments as unknown[]).length);

  const save = async () => {
    await edit
      .mutateAsync({
        draftId: draft.id,
        patch: {
          subject: subject !== draft.subject ? subject : undefined,
          bodyText: body !== draft.body_text ? body : undefined,
          toEmail: toEmail.trim().toLowerCase() !== draft.to_email ? toEmail.trim() : undefined,
          cc: cc !== (draft.cc ?? []).join(", ")
            ? cc
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : undefined,
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

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Email draft</h3>
          <p className="text-xs text-muted">
            to <span className="text-ink">{draft.to_email}</span>
            {draft.cc?.length ? (
              <>
                {" "}
                · cc <span className="text-ink">{draft.cc.join(", ")}</span>
              </>
            ) : null}
            {draft.recipient_source === "custom" ? (
              <span className="ml-1 rounded bg-brand/12 px-1 text-[10px] text-brand">
                custom address
              </span>
            ) : draft.recipient_source === "lead_contact" ? (
              <span className="ml-1 text-[10px]">from payload</span>
            ) : null}
            {hasPdf
              ? ` · ${String((draft.attachments as unknown[]).length)} attachment(s)`
              : " · PDF attaches on send"}
          </p>
        </div>
        <StatusBadge status={draft.status} />
      </div>

      {editing ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="To"
              hint="Any address — it does not have to appear in the payload."
            >
              <Input
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                list={`draft-recipients-${leadId}`}
                placeholder="client@example.com"
              />
              <datalist id={`draft-recipients-${leadId}`}>
                {emailContacts.map((contact) => (
                  <option key={contact.id} value={contact.normalized_value ?? contact.contact_value} />
                ))}
              </datalist>
            </Field>
            <Field label="Cc (comma separated)">
              <Input
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="account@yourdomain.com"
              />
            </Field>
          </div>

          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>

          <Field label="Sender account" hint="SMTP credentials come from sender_accounts">
            <Select value={senderAccountId} onChange={(e) => setSenderAccountId(e.target.value)}>
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
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs font-medium text-muted transition hover:border-brand/60 hover:text-ink"
            >
              Preview / render PDF
            </a>
            <Button
              size="sm"
              className="ml-auto"
              loading={send.isPending}
              disabled={sent}
              onClick={() =>
                send.mutate(
                  {
                    draftId: draft.id,
                    attachPdf,
                    ...(senderAccountId ? { senderAccountId } : {}),
                  },
                  { onError: () => undefined },
                )
              }
            >
              {sent ? "Sent" : attachPdf ? "Render PDF + send" : "Send without PDF"}
            </Button>
          </div>
        </div>
      )}

      {!sent ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={attachPdf}
            onChange={(e) => setAttachPdf(e.target.checked)}
            className="accent-brand"
          />
          Compile the PDF from the reviewed PPD and attach it on send
        </label>
      ) : null}

      {send.data ? (
        <div className="rounded-lg bg-brand/10 p-3 text-xs">
          <p className="text-brand">
            Sent to {(send.data.data.results ?? []).map((r) => r.to).join(", ")}
          </p>
          <p className="mt-1 text-muted">
            The PDF was compiled from the reviewed PPD at send time —{" "}
            <a className="underline" href={pdfUrl} target="_blank" rel="noreferrer">
              open it
            </a>
            .
          </p>
        </div>
      ) : null}

      {draft.error ? <p className="text-xs text-danger">{draft.error}</p> : null}
      {mutationError ? <p className="text-xs text-danger">{mutationError.message}</p> : null}
    </section>
  );
}
