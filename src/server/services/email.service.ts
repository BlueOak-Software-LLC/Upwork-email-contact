import {
  getServerEnv,
  linkTrackingEnabled,
  trackingEnabled,
  trackingOrigin,
  type ServerEnv,
} from "@/lib/env";
import { logger } from "@/lib/logger";
import type { SendEmailPayload } from "@/lib/validation/email";
import { ApiError } from "@/server/http/errors";
import { contactsRepo } from "@/server/db/contacts.repo";
import { emailLogsRepo } from "@/server/db/email-logs.repo";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";
import { trackingRepo } from "@/server/db/tracking.repo";
import { sendViaSmtp } from "@/server/services/smtp.service";
import { resolveEmailProvider } from "@/server/services/email-registry";
import { EmailDeliveryError, type EmailMessage } from "@/server/services/email-providers/types";
import { htmlToText, textToHtml } from "@/server/services/templates";
import { buildTrackedHtml, type TrackedLinkInput } from "@/server/services/tracking/build";
import { discoverLinks } from "@/server/services/tracking/links";
import { mintToken, pixelUrl } from "@/server/services/tracking/token";
import type { SendEmailResult } from "@/types/domain";

const MAX_RECIPIENTS = 20;

export interface SendEmailOptions {
  /** Audit linkage written into `email_logs`. */
  draftId?: string | null;
  proposalId?: string | null;
  /**
   * Override the environment switch for this call. `false` sends a real,
   * untracked message; `true` cannot force tracking on, because a pixel nobody
   * can reach would only produce false numbers.
   */
  track?: boolean;
}

/** What one recipient's message was built with, before it left. */
export interface TrackedSendPlan {
  domain: string;
  linkTargets: Array<{ destinationUrl: string; label: string }>;
  /** True when `/c/<token>` rewrites were applied to the body. */
  links: boolean;
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
 * a real mailbox by accident. Tracking is off in that mode for the same reason —
 * nothing reaches an inbox that could ever load a pixel.
 *
 * One provider call per recipient (no bcc leakage, per-recipient personalising),
 * which is also what makes the tracking per-recipient: every message carries its
 * own pixel token, so an open identifies *who* read it.
 *
 * Order per recipient: **open the audit row → mint and store the tokens → build
 * the body → call the provider → stamp the row.** The row must exist before the
 * bytes go out, because the pixel URL inside those bytes has to resolve to
 * something the moment a client fetches it.
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
    input.senderAccountId && env.EMAIL_PROVIDER !== "log"
      ? await senderAccountsRepo.credentials(input.senderAccountId)
      : null;

  const contact = input.contactId
    ? await contactsRepo.byId(input.contactId).catch(() => null)
    : null;
  if (input.contactId && !contact) {
    throw ApiError.notFound(`Contact ${input.contactId} not found`);
  }

  const plainText = input.text ?? (input.html ? htmlToText(input.html) : "");
  const baseHtml = input.html ?? (input.text ? textToHtml(input.text) : undefined);
  if (!plainText && !baseHtml) throw ApiError.badRequest("Message body is empty");

  const provider = resolveEmailProvider();
  const from = account?.from ?? env.EMAIL_FROM;
  const plan = planTracking(env, baseHtml, plainText, options, input);
  const results: SendEmailResult[] = [];

  for (const to of recipients) {
    // One token set per recipient: a forwarded email cannot borrow this one's
    // counters, and an open points at exactly one address.
    const token = plan ? mintToken() : null;
    const links: TrackedLinkInput[] = plan
      ? plan.linkTargets.map((target) => ({ ...target, token: mintToken() }))
      : [];

    const html = buildBody({ baseHtml, plan, token, links });
    // The plain-text alternative always uses the destination URLs, never `/c/`
    // redirects: a text part cannot render an image, and a wall of tracking
    // URLs in a readable message is a bad trade.
    const text = plainText || (html ? htmlToText(html) : "");

    // The audit row exists before the send, so a pixel fetched during the
    // provider round-trip has something to land on. A failure here downgrades
    // the message to untracked; it never blocks mail that is ready to leave.
    let logId: string | null = null;
    if (!input.skipLog) {
      try {
        logId = await emailLogsRepo.open({
          toEmail: to,
          fromEmail: stripDisplayName(from),
          subject: input.subject,
          bodyText: text,
          status: "queued",
          provider: account ? "smtp-account" : provider.name,
          ...(token ? { trackingToken: token } : {}),
          ...(input.contactId ? { contactId: contact?.id ?? null } : {}),
          draftId: options.draftId ?? input.draftId ?? null,
          proposalId: options.proposalId ?? input.proposalId ?? null,
          senderAccountId: input.senderAccountId ?? null,
        });
        if (logId && links.length) {
          await trackingRepo.createLinks({
            logId,
            links: links.map((link) => ({
              token: link.token,
              destinationUrl: link.destinationUrl,
              label: link.label,
            })),
          });
        }
      } catch (error) {
        logId = null;
        logger.error("email_log_open_failed", {
          to,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const message: EmailMessage = {
      to: [to],
      ...(input.cc?.length ? { cc: input.cc } : {}),
      from,
      ...(input.replyTo || env.EMAIL_REPLY_TO
        ? { replyTo: input.replyTo ?? env.EMAIL_REPLY_TO }
        : {}),
      subject: input.subject,
      text,
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
        id: logId ?? "",
        status: "sent",
        provider: sent.provider,
        providerMessageId: sent.providerMessageId,
        to,
        subject: input.subject,
        createdAt: new Date().toISOString(),
        error: null,
        tracked: Boolean(token),
        trackingToken: token,
        pixelUrl: token && plan ? pixelUrl(plan.domain, token) : null,
      };

      if (logId) {
        await emailLogsRepo.finalize(logId, {
          status: "sent",
          provider: sent.provider,
          providerMessageId: sent.providerMessageId,
          sentAt: row.createdAt,
        });
        if (token) await trackingRepo.markSent(logId);
      } else if (!input.skipLog) {
        // The pre-insert failed (or was impossible): record the delivery in one
        // statement instead, so the audit trail still exists — untracked.
        row.tracked = false;
        row.id = await writeFallbackLog({
          row,
          input,
          options,
          contactId: contact?.id ?? null,
          from,
          text,
          token,
        });
      }
    } catch (error) {
      const reason =
        error instanceof ApiError
          ? error.message
          : error instanceof EmailDeliveryError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown provider failure";
      logger.error("email_send_failed", {
        provider: account ? "smtp-account" : provider.name,
        to,
        reason,
      });
      row = {
        id: logId ?? "",
        status: "failed",
        provider: account ? "smtp-account" : provider.name,
        providerMessageId: null,
        to,
        subject: input.subject,
        createdAt: new Date().toISOString(),
        error: reason,
        tracked: false,
        trackingToken: null,
        pixelUrl: null,
      };
      // A failed row keeps its token: if the provider actually accepted the
      // message and only the response was lost, an open still resolves to it.
      if (logId) {
        await emailLogsRepo.finalize(logId, {
          status: "failed",
          provider: row.provider,
          error: reason,
        });
      } else if (!input.skipLog) {
        row.id = await writeFallbackLog({
          row,
          input,
          options,
          contactId: contact?.id ?? null,
          from,
          text,
          token,
        });
      }
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

/**
 * Decide once per call what tracking this message gets.
 *
 * Returns null when the send must be plain: switched off, in `log` mode,
 * skipping the audit row, or a body with no HTML part to carry the pixel.
 *
 * `skipLog` matters more than it looks. A token that belongs to no row can
 * never be attributed — `/o/<token>.gif` would find nothing — so minting one
 * would put a live tracking pixel into a client's inbox for no reason at all.
 *
 * A plain-text-only message cannot record opens either: most clients do not
 * fetch images for a text part, so saying so beats minting a token that will
 * sit at zero forever.
 */
function planTracking(
  env: ServerEnv,
  baseHtml: string | undefined,
  text: string,
  options: SendEmailOptions,
  input: SendEmailPayload,
): TrackedSendPlan | null {
  if (options.track === false) return null;
  if (input.skipLog) return null;
  if (!trackingEnabled(env)) return null;
  if (!baseHtml) return null;

  const withLinks = linkTrackingEnabled(env);
  const linkTargets = withLinks ? discoverLinks({ text, html: baseHtml }) : [];
  if (withLinks && linkTargets.length === 0) {
    logger.info("tracking_no_link_candidates", { note: "open pixel only" });
  }
  return { domain: trackingOrigin(env), linkTargets, links: linkTargets.length > 0 };
}

function buildBody({
  baseHtml,
  plan,
  token,
  links,
}: {
  baseHtml: string | undefined;
  plan: TrackedSendPlan | null;
  token: string | null;
  links: TrackedLinkInput[];
}): string | undefined {
  if (!baseHtml) return undefined;
  if (!plan || !token) return baseHtml;

  const built = buildTrackedHtml({ html: baseHtml, token, domain: plan.domain, links });
  if (built.unused.length) {
    logger.info("tracking_links_unused", {
      count: built.unused.length,
      note: "validated destinations that the body never mentions",
    });
  }
  return built.html;
}

/**
 * The path a database hiccup on `email_logs` takes: the message was still
 * delivered, so try one more time to record it — including its token, so a
 * later open is not orphaned.
 */
async function writeFallbackLog({
  row,
  input,
  options,
  contactId,
  from,
  text,
  token,
}: {
  row: SendEmailResult;
  input: SendEmailPayload;
  options: SendEmailOptions;
  contactId: string | null;
  from: string;
  text: string;
  token: string | null;
}): Promise<string> {
  const id = await emailLogsRepo.create({
    toEmail: row.to,
    fromEmail: stripDisplayName(from),
    subject: input.subject,
    bodyText: text,
    status: row.status,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    error: row.error,
    sentAt: row.status === "sent" ? row.createdAt : null,
    ...(token ? { trackingToken: token } : {}),
    ...(contactId ? { contactId } : {}),
    draftId: options.draftId ?? input.draftId ?? null,
    proposalId: options.proposalId ?? input.proposalId ?? null,
    senderAccountId: input.senderAccountId ?? null,
  });
  return id ?? `unlogged_${row.to}`;
}

function stripDisplayName(from: string) {
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim();
}
