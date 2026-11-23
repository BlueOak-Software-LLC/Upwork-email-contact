import type { Transporter } from "nodemailer";
import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import type { SmtpCredentials } from "@/server/db/sender-accounts.repo";
import { senderAccountsRepo } from "@/server/db/sender-accounts.repo";

export interface OutgoingAttachment {
  filename: string;
  path: string; // Supabase Storage object path in the `proposals` bucket
  contentType?: string;
}

export interface SmtpSendInput {
  account: SmtpCredentials;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: OutgoingAttachment[];
}

export interface SmtpSendResult {
  providerMessageId: string | null;
  accepted: string[];
}

type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  tls: { rejectUnauthorized: boolean };
  pool: boolean;
  maxConnections: number;
  socketTimeout: number;
  connectionTimeout: number;
};

type NodemailerModule = {
  createTransport: (options: SmtpTransportOptions) => Transporter;
};

let nodemailerPromise: Promise<NodemailerModule> | null = null;

/** Lazy import keeps nodemailer out of the bundle of routes that never send. */
async function loadNodemailer(): Promise<NodemailerModule> {
  nodemailerPromise ??= import("nodemailer").then(
    (m) => (m as unknown as { default?: NodemailerModule }).default ?? (m as unknown as NodemailerModule),
  );
  return nodemailerPromise;
}

/** One transport per credential set; `verify()` is the expensive part. */
const transportCache = new Map<string, Transporter>();

function transportKey(account: SmtpCredentials) {
  return `${account.host}:${account.port}:${account.secure}:${account.user}`;
}

async function createTransportFor(account: SmtpCredentials): Promise<Transporter> {
  const { createTransport } = await loadNodemailer();
  const transport = createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    ...(account.user
      ? { auth: { user: account.user, pass: account.password ?? "" } }
      : {}),
    tls: { rejectUnauthorized: true },
    pool: true,
    maxConnections: 2,
    socketTimeout: 20_000,
    connectionTimeout: 20_000,
  });
  transportCache.set(transportKey(account), transport);
  return transport;
}

async function transportFor(account: SmtpCredentials): Promise<Transporter> {
  return transportCache.get(transportKey(account)) ?? createTransportFor(account);
}

export async function sendViaSmtp(input: SmtpSendInput): Promise<SmtpSendResult> {
  if (input.account.password === null && input.account.user) {
    throw ApiError.internal(
      `Sender account "${input.account.label}" has no stored SMTP password. Re-save it on /settings/senders.`,
    );
  }

  const transport = await transportFor(input.account);
  const attachments = await resolveAttachments(input.attachments ?? []);

  try {
    const info = await transport.sendMail({
      from: input.account.from,
      to: input.to.join(", "),
      ...(input.cc?.length ? { cc: input.cc.join(", ") } : {}),
      replyTo: input.replyTo ?? input.account.replyTo ?? undefined,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
      headers: {
        "X-Mailer-Source": "upwork-email-contact",
        "Auto-Submitted": "auto-generated",
        ...input.headers,
      },
      ...(attachments.length ? { attachments } : {}),
    });

    return { providerMessageId: info.messageId ?? null, accepted: input.to };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("smtp_send_failed", {
      account: input.account.label,
      to: input.to,
      error: message,
    });
    throw ApiError.upstream(`SMTP send failed: ${message}`);
  }
}

/** `transport.verify()` logs in without sending anything. */
export async function verifySmtpAccount(accountId: string) {
  const account = await senderAccountsRepo.credentials(accountId);
  const transport = await createTransportFor(account);

  try {
    await transport.verify();
    await senderAccountsRepo.markVerified(accountId, true);
    return { ok: true as const, account: account.label };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await senderAccountsRepo.markVerified(accountId, false, message);
    return { ok: false as const, account: account.label, error: message };
  }
}

async function resolveAttachments(attachments: OutgoingAttachment[]) {
  if (attachments.length === 0) return [];

  const supabase = getAdminClient();
  const resolved: Array<{
    filename: string;
    content: Buffer;
    contentType: string;
  }> = [];

  for (const attachment of attachments) {
    const { data, error } = await supabase.storage
      .from("proposals")
      .download(attachment.path);

    if (error || !data) {
      logger.warn("attachment_missing", { path: attachment.path, error: error?.message });
      continue;
    }
    resolved.push({
      filename: attachment.filename,
      // nodemailer wants Buffer|string|Readable, not a raw Uint8Array
      content: Buffer.from(await data.arrayBuffer()),
      contentType: attachment.contentType ?? "application/pdf",
    });
  }
  return resolved;
}
