"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSaveProposal, useSenderAccounts } from "@/lib/api/outreach-hooks";
import { useChatGptSession } from "@/components/chatgpt/session-provider";
import { PromptEditor } from "@/components/prompts/prompt-editor";
import { PpdEditor, ppdEditIssues, ppdWordCount } from "./ppd-editor";
import { PdfViewerModal } from "./pdf-viewer-modal";
import type { LeadContactRow, ProposalPpd, ProposalRow } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { useToast } from "@/components/ui/toast";
import { cn, truncate } from "@/lib/utils";

/**
 * The PPD review workspace — steps 1 and 2 of the pipeline.
 *
 *   Generate PPD → review it (structured editor or JSON) → save = reviewed
 *   → preview the PDF compiled from that text → generate the email
 *
 * Every action writes through to the lead cache, so the document, the step
 * chips and the PDF badge change the moment the server accepts them. A draft
 * copy of the PPD lives here until it is saved, and is mirrored to
 * localStorage so a closed tab cannot lose a review pass.
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
  const savePpd = useSaveProposal(leadId);
  const senderAccounts = useSenderAccounts();
  const { enqueue, connection, jobs } = useChatGptSession();
  const toast = useToast();
  const [generating, setGenerating] = useState<"ppd" | "email" | null>(null);

  const [tab, setTab] = useState<Tab>("read");
  const [recipientMode, setRecipientMode] = useState<"lead" | "custom">("lead");
  const [customEmail, setCustomEmail] = useState("");
  const [cc, setCc] = useState("");
  const [pdfOpen, setPdfOpen] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [senderAccountId, setSenderAccountId] = useState("");

  const defaultSenderId = useMemo(() => {
    const rows = senderAccounts.data ?? [];
    return rows.find((row) => row.is_default)?.id ?? rows[0]?.id ?? "";
  }, [senderAccounts.data]);

  // A shared workspace has one server-side default, but each person should get
  // their own identity on a new document. The browser remembers the profile that
  // was explicitly picked here; a proposal that already has a signer still wins.
  const preferredSenderId = useRef<string | null>(null);
  useEffect(() => {
    try {
      preferredSenderId.current = window.localStorage.getItem(SENDER_PREF_KEY);
    } catch {
      /* private mode — fall back to the workspace default */
    }
  }, []);

  useEffect(() => {
    if (senderAccountId) return;
    const rows = senderAccounts.data ?? [];
    const preferred = rows.find((row) => row.id === preferredSenderId.current)?.id;
    const next = preferred || defaultSenderId;
    if (next) setSenderAccountId(next);
  }, [senderAccountId, defaultSenderId, senderAccounts.data]);

  const pickSender = (id: string) => {
    setSenderAccountId(id);
    try {
      window.localStorage.setItem(SENDER_PREF_KEY, id);
    } catch {
      /* ignore quota / private mode */
    }
  };

  const serverPpd = (proposal?.ppd ?? null) as ProposalPpd | null;

  // Reopening a lead should show the profile that actually signed the document,
  // not whichever sender happens to be default today. Once the reviewer changes
  // the picker for this proposal, the ref stops the polling query from resetting it.
  const signedByProposal = useRef<string | null>(null);
  useEffect(() => {
    // Wait for the profile query: on first paint `data` is empty, and marking
    // the proposal as handled then would skip the match once rows arrive.
    if (!proposal || !senderAccounts.isSuccess) return;
    if (signedByProposal.current === proposal.id) return;
    const signed = (proposal.ppd ?? null) as ProposalPpd | null;
    const rows = senderAccounts.data ?? [];
    const email = signed?.sender_email?.trim().toLowerCase();
    const name = signed?.prepared_by?.trim().toLowerCase();
    const match =
      (email ? rows.find((row) => row.from_email.toLowerCase() === email) : undefined) ??
      (name ? rows.find((row) => row.display_name?.toLowerCase() === name) : undefined);
    // A signed document shows its own signer. A fresh or unmatched one falls
    // back to this browser's preferred profile, then the workspace default —
    // otherwise moving to a new lead would keep the previous lead's signer.
    const preferred = rows.find((row) => row.id === preferredSenderId.current)?.id;
    const target = match?.id ?? preferred ?? defaultSenderId;
    if (target) setSenderAccountId(target);
    signedByProposal.current = proposal.id;
  }, [proposal, senderAccounts.data, senderAccounts.isSuccess, defaultSenderId]);

  const proposalKey = proposal
    ? `${proposal.id}:${proposal.ppd_reviewed_at ?? proposal.created_at ?? ""}`
    : "none";

  const [draft, setDraft] = useState<ProposalPpd | null>(serverPpd);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);

  // When the server copy changes (new proposal, saved review, regenerated doc),
  // drop the local draft — unless the reviewer is mid-edit on the same version,
  // in which case their buffer wins and the banner says so.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastKey.current === proposalKey) return;
    const stored = readLocal(leadId, proposal?.id ?? null);
    lastKey.current = proposalKey;
    if (stored && serverPpd && stored.value !== JSON.stringify(serverPpd)) {
      setDraft(stored.value as unknown as ProposalPpd);
      setJsonText(null);
      setRestoredFrom(stored.savedAt);
      return;
    }
    setDraft(serverPpd);
    setJsonText(null);
    setRestoredFrom(null);
  }, [proposalKey, serverPpd, leadId, proposal?.id]);

  const parsedJson = useMemo(() => {
    if (jsonText === null) return { ok: true as const, value: draft };
    try {
      return { ok: true as const, value: JSON.parse(jsonText) as unknown };
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
  }, [jsonText, draft]);

  const effective = (parsedJson.ok ? parsedJson.value : draft) as ProposalPpd | null;
  const dirty =
    Boolean(effective) && Boolean(serverPpd) && JSON.stringify(effective) !== JSON.stringify(serverPpd);

  useEffect(() => {
    if (!dirty || !proposal || !effective) return;
    writeLocal(leadId, proposal.id, effective);
  }, [dirty, effective, leadId, proposal]);

  const busy = savePpd.isPending || generating !== null;
  const ppdRunning = jobs.some(
    (job) =>
      job.kind === "ppd_document" &&
      (job.status === "queued" || job.status === "running" || job.status === "completing"),
  );
  const emailRunning = jobs.some(
    (job) =>
      job.kind === "email_draft" &&
      (job.status === "queued" || job.status === "running" || job.status === "completing"),
  );

  const recipientEmail =
    recipientMode === "custom"
      ? customEmail.trim()
      : (contact?.normalized_value ?? contact?.contact_value ?? "");
  // A payload can carry the post text but no address at all. The document is
  // still worth writing — the address only becomes mandatory at the email step.
  const noRecipientOnLead = contacts.length === 0;

  const reviewed = Boolean(proposal?.ppd_reviewed_at);
  const words = ppdWordCount(effective ?? serverPpd);
  const issues = useMemo(() => (dirty ? ppdEditIssues(effective) : []), [dirty, effective]);

  const save = useCallback(async () => {
    if (!proposal || !effective) return;
    if (!parsedJson.ok) {
      toast.error("The JSON tab has a syntax error", parsedJson.message);
      return;
    }
    await savePpd.mutateAsync({
      proposalId: proposal.id,
      patch: dirty ? { ppd: effective } : { reviewed: true },
      previousPpd: serverPpd,
    });
    clearLocal(leadId, proposal.id);
    setRestoredFrom(null);
    setTab("read");
  }, [proposal, effective, parsedJson, dirty, savePpd, leadId, toast, serverPpd]);

  // ⌘/Ctrl+S saves the review without leaving the keyboard.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  const runPpd = async (body: Record<string, unknown>) => {
    setGenerating("ppd");
    try {
      await enqueue({
        leadId,
        kind: "ppd_document",
        regenerate: true,
        ...body,
      });
    } catch {
      // The provider already showed the error toast.
    } finally {
      setGenerating(null);
    }
  };

  const onGenerateClick = () => {
    const recipient =
      recipientMode === "custom"
        ? { toEmail: recipientEmail }
        : { ...(contact ? { contactId: contact.id } : {}) };
    const body = { ...recipient, senderAccountId: senderAccountId || null };
    if (reviewed && !confirmRegenerate) {
      setConfirmRegenerate(true);
      return;
    }
    setConfirmRegenerate(false);
    void runPpd(body);
  };

  const requestEmailDraft = async () => {
    if (!proposal) return;
    setGenerating("email");
    try {
      await enqueue({
        leadId,
        kind: "email_draft",
        proposalId: proposal.id,
        toEmail: recipientEmail || undefined,
        senderAccountId: senderAccountId || null,
        cc: cc.trim()
          ? cc.split(",").map((value) => value.trim()).filter(Boolean)
          : undefined,
      });
    } catch {
      // The provider already showed the error toast.
    } finally {
      setGenerating(null);
    }
  };

  return (
    <section className="card space-y-4 p-5">
      {/* ── pipeline state ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Professional Proposal Document</h3>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Step done={Boolean(serverPpd)} label="1 · PPD generated" title="The prompt ran in your ChatGPT session; the server parsed and stored the answer" />
            <Step
              done={reviewed}
              label="2 · reviewed"
              title={
                proposal?.ppd_reviewed_at
                  ? `Marked reviewed at ${new Date(proposal.ppd_reviewed_at).toLocaleString()}`
                  : "Saving an edit marks it reviewed — the PDF is only compiled after that"
              }
            />
            <Step done={Boolean(proposal?.email_content)} label="3 · email drafted" />
            <Step
              done={proposal?.pdf_status === "ready"}
              label="4 · PDF"
              title={`pdf_status: ${proposal?.pdf_status ?? "none"}`}
            />
            {proposal?.ppd_reviewed_at ? (
              <span className="text-muted/70">
                reviewed <TimeAgo value={proposal.ppd_reviewed_at} />
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {proposal ? (
            <span className="text-[11px] text-muted">
              v{proposal.version} · {proposal.provider}
              {proposal.model ? `/${proposal.model}` : ""}
            </span>
          ) : null}
          <Button
            size="sm"
            loading={generating === "ppd" || ppdRunning}
            disabled={busy || ppdRunning || (recipientMode === "custom" && !recipientEmail.includes("@"))}
            onClick={onGenerateClick}
          >
            {serverPpd ? (confirmRegenerate ? "Confirm overwrite" : "Regenerate PPD") : "1 · Generate PPD"}
          </Button>
        </div>
      </div>

      {confirmRegenerate ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          <span>
            This document was reviewed
            {dirty ? " and has unsaved edits" : ""}. Regenerating runs the prompt again in your
            ChatGPT session and replaces the text you approved with a new version.
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="danger" loading={generating === "ppd"} onClick={onGenerateClick}>
              Regenerate anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRegenerate(false)}>
              Keep this version
            </Button>
          </span>
        </div>
      ) : null}

      {restoredFrom ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-xs text-brand">
          <span>
            Unsaved edits restored from this browser (buffered{" "}
            <TimeAgo value={restoredFrom} />) — they were never saved to the proposal.
          </span>
          <span className="flex gap-2">
            <Button size="sm" loading={savePpd.isPending} onClick={save}>
              Save them now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (proposal) clearLocal(leadId, proposal.id);
                setDraft(serverPpd);
                setJsonText(null);
                setRestoredFrom(null);
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      ) : null}

      {/* ── recipient (payload contact or a custom address) ────────────── */}
      <div className="grid gap-3 rounded-lg bg-canvas p-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field
            label="Your profile"
            hint="Supplies the name, role and contact block on this PPD and the email sign-off."
          >
            <select
              aria-label="Sender profile"
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm focus-ring"
              value={senderAccountId}
              onChange={(event) => pickSender(event.target.value)}
            >
              {(senderAccounts.data ?? []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.display_name || account.label}
                  {account.role_title ? ` · ${account.role_title}` : ""}
                  {account.is_default ? " · default" : ""}
                </option>
              ))}
            </select>
          </Field>
          {(senderAccounts.data ?? []).length === 0 ? (
            <p className="mt-1 text-[11px] text-warn">
              No sender profile yet — add one in Settings → Senders &amp; profile so the PPD
              prints your real contact details.
            </p>
          ) : null}
        </div>
        <Field
          label="Write for"
          hint={
            noRecipientOnLead
              ? "No address on this lead yet — the document is written from the post text; pick the address at the email step."
              : "Custom addresses are stored as manual contacts on the lead."
          }
        >
          <div className="flex gap-2" role="group" aria-label="Recipient source">
            <Button
              size="sm"
              variant={recipientMode === "lead" ? "primary" : "ghost"}
              aria-pressed={recipientMode === "lead"}
              onClick={() => setRecipientMode("lead")}
            >
              From lead
            </Button>
            <Button
              size="sm"
              variant={recipientMode === "custom" ? "primary" : "ghost"}
              aria-pressed={recipientMode === "custom"}
              onClick={() => setRecipientMode("custom")}
            >
              Custom email
            </Button>
          </div>
        </Field>

        {recipientMode === "lead" ? (
          <Field label="Contact">
            <select
              aria-label="Recipient contact"
              disabled={noRecipientOnLead}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm focus-ring"
              value={contact?.id ?? ""}
              onChange={(e) => {
                if (dirty) {
                  toast.warn("You have unsaved edits", "Saving keeps them on this version.");
                }
                onContactChange(e.target.value);
              }}
            >
              <option value="">Select an email contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.normalized_value ?? c.contact_value} · {c.list_type}
                  {c.contact_type === "manual" ? " · manual" : ""}
                  {c.confidence ? ` · ${c.confidence}` : ""}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Custom email address">
            <Input
              type="email"
              value={customEmail}
              placeholder="client@example.com"
              list={`lead-emails-${leadId}`}
              onChange={(e) => setCustomEmail(e.target.value)}
            />
            <datalist id={`lead-emails-${leadId}`}>
              {contacts
                .filter((c) => c.is_email)
                .map((c) => (
                  <option key={c.id} value={c.normalized_value ?? c.contact_value} />
                ))}
            </datalist>
          </Field>
        )}

        <Field label="Cc (optional, comma separated)" hint="Used when the email draft is generated.">
          <Input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="boss@yourdomain.com" />
        </Field>

        <div className="flex items-end gap-1 text-xs text-muted">
          →{" "}
          <span className={cn("truncate", recipientEmail ? "text-ink" : "text-warn")}>
            {recipientEmail ||
              (noRecipientOnLead
                ? "recipient-less document (post text only)"
                : "no recipient chosen")}
          </span>
          {recipientEmail ? <CopyButton value={recipientEmail} size="icon" label="Copy address" /> : null}
        </div>
      </div>

      {/* ── the document ──────────────────────────────────────────────── */}
      {serverPpd ? (
        <>
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
            <div role="tablist" aria-label="PPD views" className="flex items-center gap-1">
              <TabButton active={tab === "read"} onClick={() => setTab("read")} label="Read" />
              <TabButton active={tab === "edit"} onClick={() => setTab("edit")} label="Edit document" />
              <TabButton active={tab === "json"} onClick={() => setTab("json")} label="JSON" />
              <TabButton active={tab === "prompts"} onClick={() => setTab("prompts")} label="Prompts" />
            </div>
            {dirty ? (
              <Badge tone="warn" className="ml-1">
                unsaved
              </Badge>
            ) : null}
            <Badge tone={proposal?.pdf_status === "ready" ? "brand" : "neutral"}>
              pdf {proposal?.pdf_status ?? "none"}
            </Badge>
            <span className="ml-auto tabular">{words} words</span>
          </div>

          {tab === "read" ? (
            <div role="tabpanel" className="space-y-3">
              {effective ? <PpdDocument ppd={effective} /> : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => setTab("edit")}>
                  Edit this document
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setTab("json")}>
                  View JSON
                </Button>
                {/* The most common review action is approving what the model wrote
                    unchanged, so it needs a button of its own. */}
                {!reviewed ? (
                  <Button
                    size="sm"
                    className="ml-auto"
                    loading={savePpd.isPending}
                    onClick={save}
                  >
                    Approve as reviewed
                  </Button>
                ) : (
                  <span className="ml-auto text-[11px] text-brand">
                    ✓ reviewed — the email step is unlocked
                  </span>
                )}
              </div>
            </div>
          ) : null}

          {tab === "edit" ? (
            <div role="tabpanel" className="space-y-3">
              <p className="text-xs text-muted">
                Changes stay here until you save. Saving stores this text as the reviewed document,
                stamps <code>ppd_reviewed_at</code> and marks any rendered PDF stale — the PDF is
                compiled from exactly what you see here.
              </p>
              {effective ? (
                <PpdEditor
                  ppd={effective}
                  onChange={(next) => {
                    setDraft(next);
                    setJsonText(null);
                  }}
                />
              ) : null}
              <DropHints issues={issues} />
              <SaveBar
                dirty={dirty}
                reviewed={reviewed}
                saving={savePpd.isPending}
                onSave={save}
                onDiscard={() => {
                  setDraft(serverPpd);
                  setJsonText(null);
                  if (proposal) clearLocal(leadId, proposal.id);
                  setRestoredFrom(null);
                  toast.info("Edits discarded", "Showing the stored version again.");
                }}
              />
            </div>
          ) : null}

          {tab === "json" ? (
            <div role="tabpanel" className="space-y-3">
              <p className="text-xs text-muted">
                The same document as JSON. Typing here also updates the structured editor; a syntax
                error blocks saving until it parses.
              </p>
              <textarea
                aria-label="PPD JSON"
                rows={24}
                spellCheck={false}
                value={jsonText ?? JSON.stringify(effective ?? {}, null, 2)}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  try {
                    setDraft(JSON.parse(e.target.value) as unknown as ProposalPpd);
                  } catch {
                    /* keep the last valid draft; the error is shown below */
                  }
                }}
                className={cn(
                  "w-full rounded-lg border bg-canvas p-3 font-mono text-[11px] leading-relaxed focus-ring",
                  parsedJson.ok ? "border-line" : "border-danger/60",
                )}
              />
              {parsedJson.ok ? null : (
                <p className="text-xs text-danger" role="alert">
                  Not valid JSON: {parsedJson.message}
                </p>
              )}
              <DropHints issues={issues} />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setJsonText(null);
                    setDraft(serverPpd);
                  }}
                >
                  Reformat from server copy
                </Button>
                <SaveBar
                  compact
                  dirty={dirty}
                  reviewed={reviewed}
                  saving={savePpd.isPending}
                  disabled={!parsedJson.ok}
                  onSave={save}
                  onDiscard={() => {
                    setJsonText(null);
                    setDraft(serverPpd);
                  }}
                />
              </div>
            </div>
          ) : null}

          {tab === "prompts" ? (
            <div role="tabpanel" className="space-y-3">
              <PromptEditor promptKey="ppd_document" />
              <PromptEditor promptKey="email_draft" />
              <p className="rounded-lg bg-canvas p-3 text-[11px] text-muted">
                Saving a prompt updates the next ChatGPT job for this workspace. The answer is
                read back from the ChatGPT tab, then parsed and stored by the server.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="rounded-lg bg-canvas p-6">
          <p className="text-sm text-muted">
            No PPD yet. Pick who to write for — a contact from the payload, any custom address, or
            nobody at all when the post has no email yet — then hit{" "}
            <b>1 · Generate PPD</b>. Only the document is written: no email, no PDF, so you can
            review and edit it first.
          </p>
          <Button
            className="mt-3"
            size="sm"
            loading={generating === "ppd" || ppdRunning}
            disabled={busy || ppdRunning || (recipientMode === "custom" && !recipientEmail.includes("@"))}
            onClick={() =>
              void runPpd(
                recipientMode === "custom"
                  ? { toEmail: recipientEmail }
                  : { ...(contact ? { contactId: contact.id } : {}) },
              )
            }
          >
            1 · Generate PPD from the post text
          </Button>
        </div>
      )}

      {/* ── step 3: email + PDF preview ───────────────────────────────── */}
      {serverPpd && proposal ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            size="sm"
            variant="secondary"
            loading={generating === "email" || emailRunning}
            disabled={busy || emailRunning || !reviewed || !recipientEmail.includes("@") || dirty}
            onClick={() => void requestEmailDraft()}
            title={
              dirty
                ? "Save the document first — the email is written from the reviewed text"
                : !reviewed
                  ? "Review the document first (save any edit to mark it reviewed)"
                  : undefined
            }
          >
            3 · Generate email draft
          </Button>

          <Button size="sm" variant="ghost" onClick={() => setPdfOpen(true)}>
            Preview PDF
          </Button>

          {connection !== "connected" ? (
            <span className="text-[11px] text-warn">
              ChatGPT extension not connected — the prompt is prepared and kept for the drawer.
            </span>
          ) : null}

          {!reviewed || dirty ? (
            <span className="text-[11px] text-warn">
              {dirty ? "unsaved edits — save before drafting the email" : "not reviewed yet"}
            </span>
          ) : null}

          {proposal.email_subject ? (
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
              subject: <span className="text-ink">{truncate(proposal.email_subject, 58)}</span>
              <CopyButton value={proposal.email_subject} size="icon" label="Copy subject" />
            </span>
          ) : null}
        </div>
      ) : null}



      {proposal?.error ? <p className="text-xs text-danger">{proposal.error}</p> : null}

      <PdfViewerModal
        open={pdfOpen}
        onClose={() => setPdfOpen(false)}
        leadId={leadId}
        proposalId={proposal?.id}
        title={proposal ? `PDF · v${proposal.version}` : "PDF"}
      />
    </section>
  );
}

/* ───────────────────────────── sub-components ───────────────────────────── */

type Tab = "read" | "edit" | "json" | "prompts";

function Step({ done, label, title }: { done: boolean; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "rounded-full border px-2 py-0.5",
        done ? "border-brand/35 bg-brand/12 text-brand" : "border-line bg-surface-2 text-muted",
      )}
    >
      {done ? "✓ " : ""}
      {label}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-sm transition focus-ring",
        active
          ? "border-line bg-surface-2 font-medium text-ink shadow-[inset_0_-2px_0_var(--color-brand)]"
          : "border-transparent text-muted hover:bg-surface-2/60 hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function SaveBar({
  dirty,
  reviewed,
  saving,
  compact,
  disabled,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  reviewed: boolean;
  saving: boolean;
  compact?: boolean;
  disabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2",
        compact ? ""
        : "justify-end rounded-lg border border-line bg-canvas px-3 py-2",
      )}
    >
      {!compact ? (
        <span className="text-[11px] text-muted">
          {dirty ? (
            <span className="text-warn">Unsaved review edits</span>
          ) : reviewed ? (
            <span className="text-brand">Matches the stored document (already reviewed)</span>
          ) : (
            "Matches the stored document — you can still approve it as reviewed"
          )}
        </span>
      ) : null}
      {dirty ? (
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          Discard
        </Button>
      ) : null}
      <Button
        size="sm"
        variant={dirty || !reviewed ? "primary" : "secondary"}
        loading={saving}
        disabled={Boolean(disabled) || (reviewed && !dirty)}
        title={
          disabled
            ? "Fix the JSON first"
            : reviewed && !dirty
              ? "Nothing to save: this version is already reviewed"
              : undefined
        }
        onClick={onSave}
      >
        {dirty ? "2 · Save & mark reviewed" : reviewed ? "Already reviewed" : "2 · Mark reviewed"}
      </Button>
      <span className="hidden text-[11px] text-muted/70 sm:inline">⌘S</span>
    </div>
  );
}

/**
 * What the server would clip or drop from the pending edit, shown before the
 * reviewer saves — the fix for “I edited it and my change disappeared”.
 */
function DropHints({ issues }: { issues: string[] }) {
  if (!issues.length) return null;
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs" role="status">
      <p className="font-medium text-warn">
        {issues.length} thing(s) the document compiler will change on save
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  );
}


/* ───────────────────────── localStorage review buffer ─────────────────── */

const bufferPrefix = "ppd-buffer:";
const SENDER_PREF_KEY = "sender-profile:preferred";

function readLocal(leadId: string, proposalId: string | null) {
  if (typeof window === "undefined" || !proposalId) return null;
  try {
    const raw = window.localStorage.getItem(`${bufferPrefix}${leadId}:${proposalId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value: unknown; savedAt: string };
    return parsed;
  } catch {
    return null;
  }
}

function writeLocal(leadId: string, proposalId: string, value: unknown) {
  try {
    window.localStorage.setItem(
      `${bufferPrefix}${leadId}:${proposalId}`,
      JSON.stringify({ value, savedAt: new Date().toISOString() }),
    );
  } catch {
    /* private mode / quota — the in-memory draft still protects the session */
  }
}

function clearLocal(leadId: string, proposalId: string) {
  try {
    window.localStorage.removeItem(`${bufferPrefix}${leadId}:${proposalId}`);
  } catch {
    /* ignore */
  }
}

/* ───────────────────────────── document view ───────────────────────────── */

export function PpdDocument({ ppd }: { ppd: ProposalPpd }) {
  const meta = [
    ["Prepared for", ppd.prepared_for],
    ["Date", ppd.date],
    ["Valid until", ppd.valid_until],
    ["Proposed rate", ppd.rate],
    ["Job reference", ppd.job_reference],
  ].filter(([, value]) => value);
  const contact = [
    ppd.sender_email,
    ppd.sender_phone,
    ppd.sender_whatsapp,
    ppd.sender_linkedin,
    ppd.sender_website,
    ppd.sender_location,
  ].filter(Boolean);

  return (
    <article className="space-y-5 rounded-lg bg-canvas p-5 text-sm leading-relaxed">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-brand">
              Professional Proposal
            </p>
            <h4 className="mt-1 text-lg font-semibold">{ppd.document_title}</h4>
            <p className="text-xs text-muted">{ppd.subtitle}</p>
          </div>
          <div className="text-right text-xs">
            <p className="font-semibold text-ink">{ppd.prepared_by}</p>
            {ppd.prepared_role ? <p className="text-muted">{ppd.prepared_role}</p> : null}
          </div>
        </div>
        {meta.length ? (
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {meta.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 border-b border-line/40 py-1">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right text-ink/90">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </header>

      {(ppd.sections ?? []).map((section) => (
        <SectionView key={section.id} section={section} />
      ))}

      <footer className="border-t border-line pt-3 text-xs text-muted">
        <p>{ppd.closing}</p>
        <p className="mt-1">
          {ppd.prepared_by}
          {ppd.prepared_role ? ` · ${ppd.prepared_role}` : ""}
        </p>
        {contact.length ? <p className="mt-0.5 break-words">{contact.join(" · ")}</p> : null}
      </footer>
    </article>
  );
}

function SectionView({ section }: { section: ProposalPpd["sections"][number] }) {
  return (
    <div>
      {section.title ? (
        <h5 className="text-xs font-medium uppercase tracking-wide text-muted">{section.title}</h5>
      ) : null}
      <div className={cn("space-y-3", section.title && "mt-2")}>
        {(section.blocks ?? []).map((block, index) => (
          <BlockView key={`${section.id}-${index}`} block={block} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: ProposalPpd["sections"][number]["blocks"][number] }) {
  switch (block.type) {
    case "paragraph":
      return (
        <div className="space-y-2">
          {block.items.map((item, index) => (
            <p key={index} className="text-[13px] text-ink/90">
              {item}
            </p>
          ))}
        </div>
      );
    case "note":
      return <p className="text-[12px] italic text-muted">{block.text}</p>;
    case "bullets":
      return (
        <ul className="list-disc space-y-1 pl-5 text-[13px]">
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "numberedSteps":
      return (
        <ol className="space-y-2">
          {block.items.map((step, index) => (
            <li key={index} className="text-[13px]">
              <span className="tabular text-brand">{String(index + 1).padStart(2, "0")}</span>{" "}
              <span className="font-medium">{step.title}</span>
              {step.description ? <p className="mt-0.5 text-ink/80">{step.description}</p> : null}
            </li>
          ))}
        </ol>
      );
    case "capabilityMatrix":
      return <TwoColumn rows={block.items.map((i) => [i.requirement, i.approach] as const)} />;
    case "keyValueTable":
      return <TwoColumn rows={block.rows.map((r) => [r.label, r.value] as const)} />;
    case "references":
      return block.items.length ? (
        <ul className="space-y-1 text-[13px]">
          {block.items.map((ref, index) => (
            <li key={index}>
              <a className="text-brand underline" href={ref.url} target="_blank" rel="noreferrer">
                {ref.name || ref.url}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] italic text-muted">No verified references included.</p>
      );
  }
}

function TwoColumn({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div className="divide-y divide-line/60 rounded-lg border border-line">
      {rows.map(([label, value], index) => (
        <div key={index} className="grid gap-1 px-3 py-2 text-[13px] sm:grid-cols-[190px_1fr]">
          <span className="font-medium text-ink">{label}</span>
          <span className="text-ink/85">{value}</span>
        </div>
      ))}
    </div>
  );
}
