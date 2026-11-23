import { draftsRepo, proposalsRepo } from "@/server/db/outreach.repo";
import { leadsRepo } from "@/server/db/leads.repo";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";
import type { Database } from "@/types/database";
import { ApiError } from "@/server/http/errors";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/server/services/email.service";
import { renderProposalPdf } from "@/server/services/pdf.service";
import { textToHtml } from "@/server/services/templates";
import type { EmailDraftRow, ProposalRow } from "@/types/lead";

function slug(value: string | null | undefined) {
  return (value ?? "proposal")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Draft first, send later — nothing leaves the building without an explicit
 * `POST /api/drafts/:id/send` (or the dashboard "Send" button), and the proposal
 * PDF is only compiled when it is actually needed (see `ensureDraftPdf`).
 */
export async function createDraftForProposal({
  proposalId,
  leadContactId,
  toEmail,
  cc,
  recipientSource = "lead_contact",
  senderAccountId,
}: {
  proposalId: string;
  leadContactId?: string | null;
  /** Custom address typed by a human; defaults to the contact on the proposal. */
  toEmail?: string | null;
  cc?: string[] | null;
  recipientSource?: "lead_contact" | "custom";
  senderAccountId?: string | null;
}): Promise<EmailDraftRow> {
  const proposal = await proposalsRepo.byId(proposalId);
  const accountId = senderAccountId ?? (await senderAccountsRepo.defaultAccountId());
  const account = accountId ? await senderAccountsRepo.getPublic(accountId) : null;

  const contactId = leadContactId ?? proposal.lead_contact_id;
  if (!contactId) {
    throw ApiError.badRequest("This proposal has no recipient contact attached");
  }

  const contact = await leadsRepo.contactById(contactId);
  const recipient =
    toEmail?.trim().toLowerCase() ?? contact.normalized_value ?? contact.contact_value;
  if (!recipient || !recipient.includes("@")) {
    throw ApiError.badRequest(`${recipient ?? "recipient"} is not an email address`);
  }

  const body = withSignature(proposal.email_content, account?.signature);

  // Idempotent: re-running generation refreshes the existing draft instead of
  // creating a second one for the same proposal version.
  const existing = await leadsRepo.drafts(proposal.lead_id);
  const already = existing.find((d) => d.proposal_id === proposal.id && d.status === "draft");
  if (already) {
    return draftsRepo.update(already.id, {
      to_email: recipient,
      subject: proposal.email_subject,
      body_text: body,
      body_html: textToHtml(body),
      sender_account_id: accountId ?? already.sender_account_id,
      ...(cc ? { cc: cc as never } : {}),
      recipient_source: recipientSource,
    });
  }

  const lead = await leadsRepo.detail(proposal.lead_id);

  const draft = await draftsRepo.create({
    leadId: proposal.lead_id,
    leadContactId: contactId,
    proposalId: proposal.id,
    senderAccountId: accountId,
    toEmail: recipient,
    subject: proposal.email_subject,
    bodyText: body,
    bodyHtml: textToHtml(body),
    // Empty on purpose: the PDF is compiled by `ensureDraftPdf` right before the
    // send, from the PPD the reviewer approved — not from a pre-review generation.
    attachments: [],
    status: "draft",
    recipientSource,
    ...(cc ? { cc: cc as never } : {}),
  });

  if (lead.lead.status !== "sent") {
    await leadsRepo.setStatus(proposal.lead_id, "draft_created");
  }
  return draft;
}

/**
 * Compile + upload the proposal PDF if the draft doesn't have one yet, then put
 * it on the draft as an attachment. Called by the explicit "Preview PDF" action
 * and again by `sendDraft`, so the document a reviewer approved is the document
 * that gets attached.
 */
export async function ensureDraftPdf(draftId: string): Promise<{
  path: string | null;
  status: "ready" | "skipped" | "failed";
  pages?: number;
  error?: string;
}> {
  const draft = await draftsRepo.byId(draftId);
  if (!draft.proposal_id) {
    return { path: null, status: "skipped", error: "draft has no proposal attached" };
  }

  const proposal = await proposalsRepo.byId(draft.proposal_id);
  const existing =
    proposal.pdf_status === "ready" && proposal.pdf_path ? proposal.pdf_path : null;
  const path = existing ?? null;

  let finalPath = path;
  let status: "ready" | "skipped" | "failed" = path ? "ready" : proposal.pdf_status as never;
  let pages: number | undefined;
  let error: string | undefined;

  if (!finalPath) {
    const rendered = await renderProposalPdf({ proposal });
    finalPath = rendered.path;
    status = rendered.status;
    pages = rendered.pages;
    error = rendered.error;
    if (rendered.status === "ready" && rendered.path) {
      await proposalsRepo.update(proposal.id, {
        pdf_path: rendered.path,
        pdf_status: "ready",
        pdf_generated_at: new Date().toISOString(),
      });
    }
  }

  if (finalPath) {
    const lead = await leadsRepo.detail(proposal.lead_id);
    await draftsRepo.update(draft.id, {
      attachments: [
        {
          path: finalPath,
          filename: `Proposal-${slug(lead.lead.job_title)}.pdf`,
          contentType: "application/pdf",
        },
      ] as never,
    });
  }

  return { path: finalPath, status, pages, error };
}

export async function editDraft(
  id: string,
  patch: {
    subject?: string;
    bodyText?: string;
    toEmail?: string;
    cc?: string[] | null;
    senderAccountId?: string | null;
    status?: "draft" | "queued" | "cancelled";
  },
): Promise<EmailDraftRow> {
  const draft = await draftsRepo.byId(id);
  if (draft.status === "sent") {
    throw ApiError.conflict("This draft has already been sent and can no longer be edited");
  }

  const clean: Database["public"]["Tables"]["email_drafts"]["Update"] = {};
  if (patch.subject !== undefined) clean.subject = patch.subject;
  if (patch.bodyText !== undefined) {
    clean.body_text = patch.bodyText;
    clean.body_html = textToHtml(patch.bodyText);
  }
  if (patch.toEmail !== undefined) {
    const value = patch.toEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(value)) {
      throw ApiError.badRequest(`"${patch.toEmail}" is not a valid email address`);
    }
    clean.to_email = value;
    // The address no longer has to come from the payload at all.
    clean.recipient_source = "custom";
  }
  if (patch.cc !== undefined) clean.cc = (patch.cc ?? []) as never;
  if (patch.senderAccountId !== undefined) clean.sender_account_id = patch.senderAccountId;
  if (patch.status !== undefined) clean.status = patch.status;

  if (!Object.keys(clean).length) throw ApiError.badRequest("Nothing to update");
  return draftsRepo.update(id, clean);
}

/** Sends an existing draft over SMTP using the stored sender account. */
export async function sendDraft(
  draftId: string,
  opts: { senderAccountId?: string; attachPdf?: boolean } = {},
) {
  const attachPdf = opts.attachPdf ?? true;
  const draft = await draftsRepo.byId(draftId);
  if (draft.status === "sent") throw ApiError.conflict("Draft already sent");
  if (draft.status === "cancelled") throw ApiError.badRequest("Draft was cancelled");

  const accountId =
    opts.senderAccountId ??
    draft.sender_account_id ??
    (await senderAccountsRepo.defaultAccountId());
  if (!accountId) {
    throw ApiError.badRequest(
      "No sender account configured — add one under /settings/senders first.",
    );
  }

  const account = await senderAccountsRepo.getPublic(accountId);
  const sentToday = await draftsRepo.pendingForSenderToday(accountId);
  if (sentToday >= account.daily_limit) {
    throw ApiError.rateLimited(3600);
  }

  const attachments = Array.isArray(draft.attachments)
    ? (draft.attachments as Array<{
        path: string;
        filename: string;
        contentType?: string;
      }>)
    : [];

  // The PDF is compiled here — after the reviewer approved the PPD — unless an
  // explicit "Preview PDF" already produced one.
  let finalAttachments = attachments;
  if (attachPdf && draft.proposal_id && finalAttachments.length === 0) {
    const pdf = await ensureDraftPdf(draft.id);
    if (pdf.status === "failed") {
      throw ApiError.upstream(
        `Refusing to send without the proposal PDF: ${pdf.error ?? "rendering failed"}. Fix the PDF (or send without the attachment from the draft panel).`,
      );
    }
    const refreshed = await draftsRepo.byId(draft.id);
    finalAttachments = Array.isArray(refreshed.attachments)
      ? (refreshed.attachments as Array<{
          path: string;
          filename: string;
          contentType?: string;
        }>)
      : [];
  }

  try {
    const results = await sendEmail(
      {
        to: draft.to_email,
        subject: draft.subject,
        text: draft.body_text,
        ...(draft.body_html ? { html: draft.body_html } : {}),
        senderAccountId: accountId,
        ...(finalAttachments.length ? { attachments: finalAttachments } : {}),
        updateContact: false,
        skipLog: false,
      },
      { draftId: draft.id, proposalId: draft.proposal_id },
    );

    await draftsRepo.update(draft.id, {
      status: "sent",
      sender_account_id: accountId,
      sent_at: new Date().toISOString(),
      error: null,
    });
    await leadsRepo.setStatus(draft.lead_id, "sent");

    logger.info("draft_sent", { draftId: draft.id, to: draft.to_email, account: account.label });
    return { draft: await draftsRepo.byId(draft.id), results, account };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await draftsRepo
      .update(draft.id, { status: "failed", error: message.slice(0, 900) })
      .catch(() => undefined);
    logger.error("draft_send_failed", { draftId: draft.id, error: message });
    throw error;
  }
}

function withSignature(content: string, signature?: string | null) {
  if (!signature) return content;
  return content.endsWith(signature) ? content : `${content.trimEnd()}\n\n${signature}`;
}

export type ProposalForRow = ProposalRow;
