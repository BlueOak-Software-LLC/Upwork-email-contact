"use client";

import { useMemo, useState } from "react";
import {
  useGenerateEmailDraft,
  useGenerateProposal,
  useSaveProposal,
  type EmailRun,
  type PpdRun,
} from "@/lib/api/outreach-hooks";
import { PromptEditor } from "@/components/prompts/prompt-editor";
import type { LeadContactRow, PpdBlock, PpdSection, ProposalPpd, ProposalRow } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/input";
import { cn, truncate } from "@/lib/utils";

/**
 * The PPD review workspace — step 1 and 2 of the pipeline.
 *
 *   Generate PPD → review/edit the JSON → (optional) preview PDF → Generate email
 *
 * Nothing renders a PDF automatically: `pdf_status` stays `pending` until the
 * reviewer hits Preview (or sends the draft), so the document Groq wrote is the
 * document a human approved. Both prompts are shown and editable inline.
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
  const generatePpd = useGenerateProposal(leadId);
  const generateEmail = useGenerateEmailDraft(leadId);
  const savePpd = useSaveProposal(leadId);

  const [tab, setTab] = useState<"read" | "json" | "prompts">("read");
  const [recipientMode, setRecipientMode] = useState<"lead" | "custom">("lead");
  const [customEmail, setCustomEmail] = useState("");
  const [cc, setCc] = useState("");
  const [ppdText, setPpdText] = useState<string | null>(null);

  const ppd = (proposal?.ppd ?? null) as ProposalPpd | null;
  const jsonValue = ppdText ?? JSON.stringify(proposal?.ppd ?? {}, null, 2);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const ppdRun = generatePpd.data?.data as PpdRun | undefined;
  const emailRun = generateEmail.data?.data as EmailRun | undefined;
  const busy = generatePpd.isPending || savePpd.isPending;

  const recipientEmail =
    recipientMode === "custom" ? customEmail.trim() : (contact?.normalized_value ?? contact?.contact_value ?? "");
  // A payload can carry the post text but no address at all. The document is
  // still worth writing — the address only becomes mandatory at the email step.
  const noRecipientOnLead = contacts.length === 0;

  const warnings = useMemo(
    () => [...(ppdRun?.warnings ?? []), ...(emailRun?.warnings ?? [])],
    [ppdRun, emailRun],
  );

  const reviewed = Boolean(proposal?.ppd_reviewed_at ?? ppdRun?.proposal.ppd_reviewed_at);

  const saveJson = async () => {
    if (!proposal) return;
    try {
      const parsed = JSON.parse(jsonValue) as unknown;
      setJsonError(null);
      setPpdText(null);
      await savePpd.mutateAsync({ proposalId: proposal.id, patch: { ppd: parsed } });
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "Invalid JSON");
    }
  };

  return (
    <section className="card space-y-4 p-5">
      {/* ── pipeline state ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Professional Proposal Document</h3>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Step done={Boolean(ppd)} label="1 · PPD generated" />
            <Step done={reviewed} label="2 · reviewed" />
            <Step done={Boolean(proposal?.email_content)} label="3 · email drafted" />
            <Step done={proposal?.pdf_status === "ready"} label="4 · PDF" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {proposal ? (
            <span className="text-[11px] text-muted">
              v{proposal.version} · {proposal.provider}
              {proposal.model ? `/${proposal.model}` : ""}
            </span>
          ) : null}
          <Button
            size="sm"
            loading={generatePpd.isPending}
            disabled={busy || (recipientMode === "custom" && !recipientEmail.includes("@"))}
            onClick={() =>
              generatePpd.mutate(
                recipientMode === "custom"
                  ? { toEmail: recipientEmail, regenerate: true }
                  : { ...(contact ? { contactId: contact.id } : {}), regenerate: true },
                { onError: () => undefined },
              )
            }
          >
            {ppd ? "Regenerate PPD" : "1 · Generate PPD"}
          </Button>
        </div>
      </div>

      {/* ── recipient (payload contact or a custom address) ────────────── */}
      <div className="grid gap-3 rounded-lg bg-canvas p-3 sm:grid-cols-2">
        <Field
          label="Write for"
          hint={
            noRecipientOnLead
              ? "No address on this lead yet — the document is written from the post text; pick the address at the email step."
              : "Custom addresses are stored as manual contacts on the lead."
          }
        >
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={recipientMode === "lead" ? "primary" : "ghost"}
              onClick={() => setRecipientMode("lead")}
            >
              From lead
            </Button>
            <Button
              size="sm"
              variant={recipientMode === "custom" ? "primary" : "ghost"}
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
              onChange={(e) => onContactChange(e.target.value)}
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

        <div className="flex items-end text-xs text-muted">
          →{" "}
          <span className={cn("ml-1 truncate", recipientEmail ? "text-ink" : "text-warn")}>
            {recipientEmail ||
              (noRecipientOnLead
                ? "recipient-less document (post text only)"
                : "no recipient chosen")}
          </span>
        </div>
      </div>

      {/* ── the document ──────────────────────────────────────────────── */}
      {ppd ? (
        <>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <TabButton active={tab === "read"} onClick={() => setTab("read")}>
              Read
            </TabButton>
            <TabButton active={tab === "json"} onClick={() => setTab("json")}>
              Edit PPD JSON
            </TabButton>
            <TabButton active={tab === "prompts"} onClick={() => setTab("prompts")}>
              Prompts
            </TabButton>
            {proposal?.pdf_status ? (
              <Badge tone={proposal.pdf_status === "ready" ? "brand" : "neutral"}>
                pdf {proposal.pdf_status}
              </Badge>
            ) : null}
          </div>

          {tab === "read" ? <PpdDocument ppd={ppd} /> : null}

          {tab === "json" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted">
                Edit any prose here and save — this is the version the PDF is compiled from. Our
                own company / website / prepared-by are kept from the document, and saving marks
                it reviewed (any rendered PDF is re-generated on the next preview or send).
              </p>
              <textarea
                aria-label="PPD JSON"
                rows={22}
                value={jsonValue}
                onChange={(e) => setPpdText(e.target.value)}
                className="w-full rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed focus-ring"
              />
              {jsonError ? <p className="text-xs text-danger">{jsonError}</p> : null}
              <div className="flex justify-end gap-2">
                {ppdText !== null ? (
                  <Button variant="ghost" size="sm" onClick={() => setPpdText(null)}>
                    Discard edits
                  </Button>
                ) : null}
                <Button size="sm" loading={savePpd.isPending} onClick={saveJson}>
                  2 · Save &amp; mark reviewed
                </Button>
              </div>
            </div>
          ) : null}

          {tab === "prompts" ? (
            <div className="space-y-3">
              <PromptEditor promptKey="ppd_document" />
              <PromptEditor promptKey="email_draft" />
              {ppdRun?.prompt || emailRun?.prompt ? (
                <details className="rounded-lg border border-line p-3 text-xs">
                  <summary className="cursor-pointer font-medium text-muted">
                    Exact prompt sent on the last run
                  </summary>
                  {(emailRun ?? ppdRun)?.prompt ? (
                    <>
                      <p className="mt-2 text-[11px] text-muted">
                        {(emailRun ?? ppdRun)!.prompt.label} · {(emailRun ?? ppdRun)!.prompt.model} ·
                        temp {(emailRun ?? ppdRun)!.prompt.temperature} · max{" "}
                        {(emailRun ?? ppdRun)!.prompt.maxTokens} ·{" "}
                        {(emailRun ?? ppdRun)!.prompt.reasoningEffort ?? "default"} reasoning
                      </p>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-canvas p-3 text-[11px] text-muted">
                        {(emailRun ?? ppdRun)!.prompt.system}
                        {"\n\n"}
                        {(emailRun ?? ppdRun)!.prompt.user}
                      </pre>
                    </>
                  ) : null}
                </details>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="rounded-lg bg-canvas p-6 text-sm text-muted">
          No PPD yet. Pick a recipient (a contact from the payload, or any custom address) and hit{" "}
          <b>1 · Generate PPD</b>. Only the document is written — no email, no PDF — so you can
          review and edit it first.
        </p>
      )}

      {/* ── step 3: email + PDF preview ───────────────────────────────── */}
      {ppd && proposal ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button
            size="sm"
            variant="secondary"
            loading={generateEmail.isPending}
            disabled={!recipientEmail.includes("@")}
            onClick={() =>
              generateEmail.mutate(
                {
                  proposalId: proposal.id,
                  toEmail: recipientEmail || undefined,
                  ...(cc.trim()
                    ? { cc: cc.split(",").map((v) => v.trim()).filter(Boolean) }
                    : {}),
                },
                { onError: () => undefined },
              )
            }
          >
            3 · Generate email draft
          </Button>

          <a
            href={`/api/leads/${leadId}/pdf?proposalId=${proposal.id}&render=true`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs font-medium text-muted transition hover:border-brand/60 hover:text-ink"
          >
            Preview PDF (renders now)
          </a>

          {proposal.email_content ? (
            <span className="text-[11px] text-muted">
              subject: <span className="text-ink">{truncate(proposal.email_subject, 70)}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ── run reports ───────────────────────────────────────────────── */}
      {ppdRun ? (
        <RunReport
          title={`PPD v${ppdRun.proposal.version} ready`}
          lines={[
            `${ppdRun.documentWords} words · ${
              ppdRun.recipient
                ? `${ppdRun.recipient.email} (${ppdRun.recipient.source})`
                : "no recipient (written from the post text)"
            }`,
            ppdRun.usage
              ? `${ppdRun.usage.prompt_tokens}+${ppdRun.usage.completion_tokens} tokens${
                  ppdRun.usage.reasoning_tokens ? ` (${ppdRun.usage.reasoning_tokens} reasoning)` : ""
                }${ppdRun.costUsd !== null ? ` · ~$${ppdRun.costUsd.toFixed(5)}` : ""}`
              : null,
            "PDF not generated yet — it is compiled from this document on preview or send.",
          ]}
        />
      ) : null}

      {emailRun ? (
        <RunReport
          title={emailRun.draft ? "Email draft ready" : "Email copy written to the proposal"}
          tone={emailRun.draftError ? "warn" : "brand"}
          lines={[
            `subject: ${emailRun.email.subject}`,
            `to ${emailRun.recipient.email} (${emailRun.recipient.source})${
              emailRun.draft ? ` · draft ${emailRun.draft.id.slice(0, 8)}` : ""
            }`,
            emailRun.usage
              ? `${emailRun.usage.prompt_tokens}+${emailRun.usage.completion_tokens} tokens${
                  emailRun.costUsd !== null ? ` · ~$${emailRun.costUsd.toFixed(5)}` : ""
                }`
              : null,
            emailRun.draftError ? `draft failed: ${emailRun.draftError}` : null,
            "Sending the draft renders the PDF from the reviewed PPD and attaches it.",
          ]}
        />
      ) : null}

      {warnings.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-warn">
          {warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {generatePpd.error || generateEmail.error || savePpd.error ? (
        <p className="text-xs text-danger">
          {truncate(
            (generatePpd.error ?? generateEmail.error ?? savePpd.error)!.message,
            260,
          )}
        </p>
      ) : null}
      {proposal?.error ? <p className="text-xs text-danger">{proposal.error}</p> : null}
    </section>
  );
}

/* ───────────────────────────── sub-components ───────────────────────────── */

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5",
        done
          ? "border-brand/35 bg-brand/12 text-brand"
          : "border-line bg-surface-2 text-muted",
      )}
    >
      {label}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-1",
        active ? "bg-surface-2 text-ink" : "hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function RunReport({
  title,
  lines,
  tone = "brand",
}: {
  title: string;
  lines: Array<string | null>;
  tone?: "brand" | "warn";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs",
        tone === "brand" ? "border-brand/35 bg-brand/8" : "border-warn/35 bg-warn/8",
      )}
    >
      <p className={cn("font-medium", tone === "brand" ? "text-brand" : "text-warn")}>{title}</p>
      <ul className="mt-1 space-y-0.5 text-muted">
        {lines.filter(Boolean).map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function PpdDocument({ ppd }: { ppd: ProposalPpd }) {
  const meta = [
    ["Prepared for", ppd.prepared_for],
    ["Prepared by", ppd.prepared_by],
    ["Proposed rate", ppd.rate],
    ["Engagement", ppd.engagement],
    ["Job reference", ppd.job_reference],
  ].filter(([, value]) => value);

  return (
    <article className="space-y-5 rounded-lg bg-canvas p-5 text-sm leading-relaxed">
      <header>
        <p className="text-[11px] font-medium uppercase tracking-wide text-brand">
          {ppd.company} / Professional Proposal
        </p>
        <h4 className="mt-1 text-lg font-semibold">{ppd.document_title}</h4>
        <p className="text-xs text-muted">{ppd.subtitle}</p>
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
          {ppd.website ? ` · ${ppd.website}` : ""}
        </p>
      </footer>
    </article>
  );
}

function SectionView({ section }: { section: PpdSection }) {
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

function BlockView({ block }: { block: PpdBlock }) {
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
