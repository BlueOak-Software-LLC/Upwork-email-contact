"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useEditDraft, useSendDraft, useSenderAccounts } from "@/lib/api/outreach-hooks";
import { useChatGptSession } from "@/components/chatgpt/session-provider";
import { summarizeDraftActivity, useDraftActivity } from "@/lib/api/tracking-hooks";
import type { EmailDraftRow, LeadContactRow } from "@/types/lead";
import { PdfViewerModal } from "./pdf-viewer-modal";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api/errors";

/**
 * Step 4 of the pipeline: the draft a human approves.
 *
 * The recipient is editable — any address works, not only the ones in the
 * payload — and custom ones stay traceable as `recipient_source: "custom"`.
 * Sending calls `ensureDraftPdf()`, which compiles the PDF from the
 * **reviewed** PPD and attaches it, then delivers over SMTP with the sender
 * account selected here. `EMAIL_PROVIDER=log` is a hard dry run: nothing is
 * handed to a mail server, which the button label says out loud.
 */
export function DraftCard({
  leadId,
  draft,
  contacts,
  canFollowUp = true,
}: {
  leadId: string;
  draft: EmailDraftRow;
  contacts: LeadContactRow[];
  /** False when a later draft in this thread already exists (or is being written). */
  canFollowUp?: boolean;
}) {
  const send = useSendDraft(leadId);
  const edit = useEditDraft(leadId);
  const accounts = useSenderAccounts();
  const toast = useToast();
  const { enqueue, jobs } = useChatGptSession();
  const [followUpPending, setFollowUpPending] = useState(false);
  const followUpActive = jobs.some(
    (job) =>
      job.kind === "follow_up" &&
      job.contactId === draft.lead_contact_id &&
      (job.status === "queued" || job.status === "running" || job.status === "completing"),
  );

  // What the recipients did, once the draft has actually gone out.
  const activity = useDraftActivity(draft.id, draft.status === "sent");
  const activityLine = summarizeDraftActivity(activity.data ?? []);

  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body_text);
  const [toEmail, setToEmail] = useState(draft.to_email);
  const [cc, setCc] = useState((draft.cc ?? []).join(", "));
  const [senderAccountId, setSenderAccountId] = useState(draft.sender_account_id ?? "");
  // A follow-up continues the thread; do not re-attach the same proposal PDF
  // unless the sender explicitly asks for it.
  const [attachPdf, setAttachPdf] = useState(draft.purpose !== "follow_up");
  const [pdfOpen, setPdfOpen] = useState(false);

  // Adopt the newest server copy whenever we are not mid-edit, so a save (or a
  // mutation elsewhere on the page) updates these fields in place.
  const signature = `${draft.id}:${draft.updated_at ?? draft.created_at ?? ""}`;
  const syncedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (editing || syncedFrom.current === signature) return;
    setSubject(draft.subject);
    setBody(draft.body_text);
    setToEmail(draft.to_email);
    setCc((draft.cc ?? []).join(", "));
    setSenderAccountId(draft.sender_account_id ?? "");
    syncedFrom.current = signature;
  }, [signature, draft, editing]);

  const sent = draft.status === "sent";
  const cancelled = draft.status === "cancelled";
  const emailContacts = contacts.filter((c) => c.is_email);
  const attachments = (draft.attachments ?? []) as unknown[];
  const account = (accounts.data ?? []).find((a) => a.id === (senderAccountId || draft.sender_account_id));

  const dirty =
    subject !== draft.subject ||
    body !== draft.body_text ||
    toEmail.trim().toLowerCase() !== draft.to_email ||
    cc !== (draft.cc ?? []).join(", ") ||
    senderAccountId !== (draft.sender_account_id ?? "");

  const save = async () => {
    await edit.mutateAsync({
      draftId: draft.id,
      patch: {
        ...(subject !== draft.subject ? { subject } : {}),
        ...(body !== draft.body_text ? { bodyText: body } : {}),
        ...(toEmail.trim().toLowerCase() !== draft.to_email ? { toEmail: toEmail.trim() } : {}),
        ...(cc !== (draft.cc ?? []).join(", ")
          ? { cc: cc.split(",").map((v) => v.trim()).filter(Boolean) }
          : {}),
        ...(senderAccountId !== (draft.sender_account_id ?? "")
          ? { senderAccountId: senderAccountId || null }
          : {}),
      },
    });
    setEditing(false);
  };

  const results = send.data?.data.results ?? [];

  return (
    <section className="card space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {draft.sequence > 1 ? `Follow-up ${draft.sequence - 1}` : "First email" }
            <StatusBadge status={draft.status} />
            {draft.sequence > 1 ? (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                touch {draft.sequence}
              </span>
            ) : null}
            {sent && activityLine ? (
              <Link
                href={`/emails/${activity.data?.[0]?.logId ?? ""}`}
                className="rounded-full border border-brand/35 bg-brand/10 px-2 py-0.5 text-[10px] text-brand hover:border-brand/60"
                title="Open the activity for this send"
              >
                {activityLine}
              </Link>
            ) : null}
            {draft.recipient_source === "custom" ? (
              <span className="rounded bg-brand/12 px-1 text-[10px] text-brand">custom address</span>
            ) : draft.recipient_source === "lead_contact" ? (
              <span className="text-[10px] text-muted">from payload</span>
            ) : null}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span className="flex items-center gap-1">
              to <span className="text-ink">{draft.to_email}</span>
              <CopyButton value={draft.to_email} size="icon" label="Copy recipient" />
            </span>
            {draft.cc?.length ? (
              <span>
                · cc <span className="text-ink">{draft.cc.join(", ")}</span>
              </span>
            ) : null}
            {attachments.length ? (
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink/80">
                {attachments.length} PDF attached
              </span>
            ) : (
              <span className="text-[11px]">· PDF attaches on send</span>
            )}
            <span className="text-[11px]">
              · edited <TimeAgo value={draft.updated_at ?? draft.created_at} />
            </span>
          </p>
        </div>

        {!editing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {draft.proposal_id ? (
              <Button size="sm" variant="ghost" onClick={() => setPdfOpen(true)}>
                Preview PDF
              </Button>
            ) : null}
            {sent && draft.proposal_id ? (
              <Button
                size="sm"
                variant="secondary"
                loading={followUpPending || followUpActive}
                disabled={followUpActive || !canFollowUp}
                title={
                  !canFollowUp
                    ? "A newer follow-up already exists for this thread"
                    : followUpActive
                      ? "A follow-up is already being written for this lead"
                      : undefined
                }
                onClick={async () => {
                  setFollowUpPending(true);
                  try {
                    await enqueue({
                      leadId,
                      kind: "follow_up",
                      proposalId: draft.proposal_id,
                      contactId: draft.lead_contact_id,
                      toEmail: draft.to_email,
                      previousDraftId: draft.id,
                    });
                  } catch {
                    // The provider already showed the error toast.
                  } finally {
                    setFollowUpPending(false);
                  }
                }}
              >
                Write follow-up
              </Button>
            ) : null}
            <Button
              size="sm"
              loading={send.isPending}
              disabled={sent || cancelled || dirty}
              title={dirty ? "Save the draft first" : undefined}
              onClick={() => {
                if (dirty) {
                  toast.warn("This draft has unsaved edits", "Save before sending.");
                  return;
                }
                send.mutate(
                  {
                    draftId: draft.id,
                    attachPdf,
                    ...(senderAccountId ? { senderAccountId } : {}),
                  },
                  { onError: () => undefined },
                );
              }}
            >
              {sent
                ? "Sent"
                : cancelled
                  ? "Cancelled"
                  : attachPdf
                    ? "Render PDF + send"
                    : "Send without PDF"}
            </Button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="space-y-4 rounded-lg border border-line bg-canvas p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="To" hint="Any address — it does not have to appear in the payload.">
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
              <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="you@yourdomain.com" />
            </Field>
          </div>

          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>

          <Field
            label="Sender account"
            hint={
              account
                ? `${account.smtp_host}:${account.smtp_port} · ${account.status}`
                : "No account chosen — the default sender from the environment is used."
            }
          >
            <Select value={senderAccountId} onChange={(e) => setSenderAccountId(e.target.value)}>
              <option value="">(use default)</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {a.from_email}
                  {a.status !== "active" ? ` (${a.status})` : ""}
                </option>
              ))}
            </Select>
          </Field>

          {accounts.error ? (
            <p className="text-xs text-warn">
              Sender accounts could not be listed: {errorMessage(accounts.error)}
            </p>
          ) : null}

          <Field label="Message">
            <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setSubject(draft.subject);
                setBody(draft.body_text);
                setToEmail(draft.to_email);
                setCc((draft.cc ?? []).join(", "));
                setSenderAccountId(draft.sender_account_id ?? "");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" loading={edit.isPending} disabled={!dirty} onClick={save}>
              Save draft
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg bg-canvas p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-medium">{draft.subject || "(no subject)"}</div>
              {draft.subject ? <CopyButton value={draft.subject} label="Copy subject" /> : null}
            </div>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted">
              {draft.body_text}
            </pre>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
              <CopyButton value={draft.body_text} label="Copy message" />
              <span>{draft.body_text.split(/\s+/).filter(Boolean).length} words</span>
            </div>
          </div>

          {!sent && !cancelled ? (
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
        </div>
      )}

      {results.length ? (
        <div className="rounded-lg border border-brand/35 bg-brand/8 p-3 text-xs">
          <p className="font-medium text-brand">
            {results.every((r) => r.status === "sent") ? "Delivered" : "Delivery result"}
          </p>
          <ul className="mt-1 space-y-0.5 text-muted">
            {results.map((r, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2">
                <span className={r.status === "sent" ? "text-brand" : "text-warn"}>{r.status}</span>
                <span>{r.to}</span>
                <span className="text-[11px] text-muted/70">via {r.provider}</span>
                {r.error ? <span className="text-danger">{r.error}</span> : null}
              </li>
            ))}
            <li className="pt-1 text-[11px]">
              {results[0]?.provider === "log"
                ? "EMAIL_PROVIDER=log — recorded only, no SMTP socket was opened, so nothing was tracked."
                : results.some((r) => r.tracked)
                  ? `Tracked: ${results.filter((r) => r.tracked).length}/${results.length} recipient${results.length === 1 ? "" : "s"} got a personal pixel. Opens and clicks appear on the activity page.`
                  : "Sent untracked — EMAIL_TRACKING is off, or this deployment\u2019s tracking origin is not reachable."}{" "}
              <Link className="underline" href="/emails">
                see the log
              </Link>
            </li>
          </ul>
        </div>
      ) : null}

      {draft.error ? <p className="text-xs text-danger">{draft.error}</p> : null}

      <PdfViewerModal
        open={pdfOpen}
        onClose={() => setPdfOpen(false)}
        leadId={leadId}
        proposalId={draft.proposal_id}
        title="Attached proposal PDF"
      />
    </section>
  );
}
