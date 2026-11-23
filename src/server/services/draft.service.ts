import { draftsRepo, proposalsRepo } from "@/server/db/outreach.repo";
import { leadsRepo } from "@/server/db/leads.repo";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";
import type { Database } from "@/types/database";
import { ApiError } from "@/server/http/errors";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/server/services/email.service";
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
 * `POST /api/drafts/:id/send` (or the dashboard "Send" button).
 */
export async function createDraftForProposal({
  proposalId,
  senderAccountId,
}: {
  proposalId: string;
  senderAccountId?: string | null;
}): Promise<EmailDraftRow> {
  const proposal = await proposalsRepo.byId(proposalId);
  const accountId = senderAccountId ?? (await senderAccountsRepo.defaultAccountId());
  const account = accountId ? await senderAccountsRepo.getPublic(accountId) : null;

  if (!proposal.lead_contact_id) {
    throw ApiError.badRequest("This proposal has no recipient contact attached");
  }

  const contact = await leadsRepo.contactById(proposal.lead_contact_id);
  if (!contact.is_email) {
    throw ApiError.badRequest(`${contact.contact_value} is not an email address`);
  }

  // Idempotent: re-running ingestion refreshes the existing draft instead of
  // creating a second one for the same proposal version.
  const existing = await leadsRepo.drafts(proposal.lead_id);
  const already = existing.find((d) => d.proposal_id === proposal.id && d.status === "draft");
  if (already) {
    return draftsRepo.update(already.id, {
      subject: proposal.email_subject,
      body_text: withSignature(proposal.email_content, account?.signature),
      body_html: textToHtml(withSignature(proposal.email_content, account?.signature)),
      sender_account_id: accountId ?? already.sender_account_id,
    });
  }

  const lead = await leadsRepo.detail(proposal.lead_id);
  const body = withSignature(proposal.email_content, account?.signature);

  const draft = await draftsRepo.create({
    leadId: proposal.lead_id,
    leadContactId: proposal.lead_contact_id,
    proposalId: proposal.id,
    senderAccountId: accountId,
    toEmail: contact.normalized_value ?? contact.contact_value,
    subject: proposal.email_subject,
    bodyText: body,
    bodyHtml: textToHtml(body),
    attachments:
      proposal.pdf_status === "ready" && proposal.pdf_path
        ? [
            {
              path: proposal.pdf_path,
              filename: `Proposal-${slug(lead.lead.job_title)}.pdf`,
              contentType: "application/pdf",
            },
          ]
        : [],
    status: "draft",
  });

  if (lead.lead.status !== "sent") {
    await leadsRepo.setStatus(proposal.lead_id, "draft_created");
  }
  return draft;
}

export async function editDraft(
  id: string,
  patch: {
    subject?: string;
    bodyText?: string;
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
  if (patch.senderAccountId !== undefined) clean.sender_account_id = patch.senderAccountId;
  if (patch.status !== undefined) clean.status = patch.status;

  if (!Object.keys(clean).length) throw ApiError.badRequest("Nothing to update");
  return draftsRepo.update(id, clean);
}

/** Sends an existing draft over SMTP using the stored sender account. */
export async function sendDraft(
  draftId: string,
  opts: { senderAccountId?: string } = {},
) {
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

  try {
    const results = await sendEmail(
      {
        to: draft.to_email,
        subject: draft.subject,
        text: draft.body_text,
        ...(draft.body_html ? { html: draft.body_html } : {}),
        senderAccountId: accountId,
        ...(attachments.length ? { attachments } : {}),
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
