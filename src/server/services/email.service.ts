import { getAdminClient } from "@/lib/supabase/admin";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { SendEmailPayload } from "@/lib/validation/email";
import { ApiError } from "@/server/http/errors";
import { contactsRepo } from "@/server/db/contacts.repo";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";
import { sendViaSmtp } from "@/server/services/smtp.service";
import { resolveEmailProvider } from "@/server/services/email-registry";
import { EmailDeliveryError, type EmailMessage } from "@/server/services/email-providers/types";
import { htmlToText, textToHtml } from "@/server/services/templates";
import type { SendEmailResult } from "@/types/domain";

const MAX_RECIPIENTS = 20;

export interface SendEmailOptions {
  /** Audit linkage written into `email_logs`. */
  draftId?: string | null;
  proposalId?: string | null;
}

/**
 * The only place that talks to an email provider.
 *
 * Two credential sources:
 *  - `senderAccountId` → SMTP from `public.sender_accounts` (dashboard drafts)
 *  - otherwise          → the env provider (`resend` | `smtp` | `log`)
 *
 * `EMAIL_PROVIDER=log` is a hard stop, not a fallback: even with a sender
 * account it decrypts nothing and opens no socket, so a staging run cannot mail
 * a real mailbox by accident.
 *
 * One provider call per recipient (no bcc leakage, per-recipient personalising),
 * every attempt persisted in `public.email_logs`.
 */
export async function sendEmail(
  input: SendEmailPayload,
  options: SendEmailOptions = {},
): Promise<SendEmailResult[]> {
  const env = getServerEnv();
  const recipients = Array.isArray(input.to) ? input.to : [input.to];

  if (recipients.length === 0) throw ApiError.badRequest("`to` must not be empty");
  if (recipients.length > MAX_RECIPIENTS) {
    throw ApiError.badRequest(`At most ${MAX_RECIPIENTS} recipients per request`);
  }

  const account =
    input.senderAccountId && getServerEnv().EMAIL_PROVIDER !== "log"
      ? await senderAccountsRepo.credentials(input.senderAccountId)
      : null;

  const contact = input.contactId
    ? await contactsRepo.byId(input.contactId).catch(() => null)
    : null;
  if (input.contactId && !contact) {
    throw ApiError.notFound(`Contact ${input.contactId} not found`);
  }

  const html = input.html ?? (input.text ? textToHtml(input.text) : undefined);
  const text = input.text ?? (html ? htmlToText(html) : "");
  if (!text && !html) throw ApiError.badRequest("Message body is empty");

  const provider = resolveEmailProvider();
  const from = account?.from ?? env.EMAIL_FROM;
  const results: SendEmailResult[] = [];

  for (const to of recipients) {
    const message: EmailMessage = {
      to: [to],
      ...(input.cc?.length ? { cc: input.cc } : {}),
      from,
      ...(input.replyTo || env.EMAIL_REPLY_TO
        ? { replyTo: input.replyTo ?? env.EMAIL_REPLY_TO }
        : {}),
      subject: input.subject,
      text: text || htmlToText(html ?? ""),
      ...(html ? { html } : {}),
      headers: {
        "X-Mailer-Source": "upwork-email-contact",
        ...(input.headers ?? {}),
        ...(contact ? { "X-Contact-Id": contact.id } : {}),
        ...(options.draftId ? { "X-Draft-Id": options.draftId } : {}),
      },
    };

    let row: SendEmailResult;
    try {
      const sent = account
        ? await sendViaSmtp({
            account,
            to: message.to,
            ...(input.cc?.length ? { cc: input.cc } : {}),
            subject: message.subject,
            text: message.text,
            ...(html ? { html } : {}),
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            headers: message.headers,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          }).then((r) => ({
            provider: "smtp-account",
            providerMessageId: r.providerMessageId,
          }))
        : await provider.send(message);

      row = {
        id: "",
        status: "sent",
        provider: sent.provider,
        providerMessageId: sent.providerMessageId,
        to,
        subject: input.subject,
        createdAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      const reason =
        error instanceof ApiError
          ? error.message
          : error instanceof EmailDeliveryError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown provider failure";
      logger.error("email_send_failed", { provider: account ? "smtp-account" : provider.name, to, reason });
      row = {
        id: "",
        status: "failed",
        provider: account ? "smtp-account" : provider.name,
        providerMessageId: null,
        to,
        subject: input.subject,
        createdAt: new Date().toISOString(),
        error: reason,
      };
    }

    if (!input.skipLog) {
      row.id = await persistLog({
        row,
        input,
        options,
        contactId: contact?.id ?? null,
        from,
        text: message.text,
      });
    } else {
      row.id = crypto.randomUUID();
    }

    if (row.status === "sent" && account) {
      await senderAccountsRepo.incrementSent(account.id);
    }
    results.push(row);
  }

  const delivered = results.filter((r) => r.status === "sent");
  if (delivered.length === 0) {
    throw ApiError.upstream(
      "Email provider rejected every recipient",
      results.map((r) => ({ to: r.to, error: r.error })),
    );
  }

  if (contact && input.updateContact) {
    await contactsRepo.markContacted(contact.id);
  }

  return results;
}

async function persistLog({
  row,
  input,
  options,
  contactId,
  from,
  text,
}: {
  row: SendEmailResult;
  input: SendEmailPayload;
  options: SendEmailOptions;
  contactId: string | null;
  from: string;
  text: string;
}) {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("email_logs")
    .insert({
      contact_id: contactId,
      draft_id: options.draftId ?? input.draftId ?? null,
      proposal_id: options.proposalId ?? input.proposalId ?? null,
      sender_account_id: input.senderAccountId ?? null,
      to_email: row.to,
      from_email: stripDisplayName(from),
      subject: input.subject,
      body_text: text.slice(0, 20_000),
      status: row.status,
      provider: row.provider,
      provider_message_id: row.providerMessageId,
      error: row.error,
      sent_at: row.status === "sent" ? row.createdAt : null,
    })
    .select("id, created_at")
    .single();

  if (error) {
    // Delivery already happened — never fail the request because of the audit row.
    logger.error("email_log_insert_failed", { to: row.to, error: error.message });
    return `unlogged_${row.to}`;
  }
  return data.id as string;
}

function stripDisplayName(from: string) {
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim();
}
