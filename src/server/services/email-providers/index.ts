import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  EmailDeliveryError,
  type EmailMessage,
  type EmailProvider,
  type SendResponse,
} from "./types";

/** Default provider: records the send without delivering it. Safe for dev + CI. */
export const logProvider: EmailProvider = {
  name: "log",
  async send(message: EmailMessage): Promise<SendResponse> {
    const id = `log_${Date.now().toString(36)}`;
    logger.info("email_dry_run", {
      id,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      bytes: message.text.length + (message.html?.length ?? 0),
    });
    return { provider: "log", providerMessageId: id };
  },
} satisfies EmailProvider;

/** Resend API (https://resend.com). Loaded lazily to keep cold starts small. */
export const resendProvider: EmailProvider = {
  name: "resend",
  async send(message) {
    const { RESEND_API_KEY } = getServerEnv();
    const { Resend } = await import("resend");
    const client = new Resend(RESEND_API_KEY);

    const { data, error } = await client.emails.send({
      from: message.from as `${string}@${string}`,
      to: message.to,
      ...(message.cc?.length ? { cc: message.cc } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      headers: message.headers,
    });

    if (error || !data) {
      throw new EmailDeliveryError(
        `Resend rejected the message: ${error?.message ?? "no id returned"}`,
        "resend",
        error,
      );
    }
    return { provider: "resend", providerMessageId: data.id };
  },
};

/** Any SMTP relay (Gmail app password, Postmark SMTP, SES SMTP, Mailtrap…). */
export const smtpProvider: EmailProvider = {
  name: "smtp",
  async send(message) {
    const env = getServerEnv();
    const nodemailer = (await import("nodemailer")).default;

    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      ...(env.SMTP_USER
        ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
        : {}),
    });

    const info = await transport.sendMail({
      from: env.EMAIL_FROM,
      to: message.to.join(", "),
      ...(message.cc?.length ? { cc: message.cc.join(", ") } : {}),
      ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      headers: message.headers,
    });

    return { provider: "smtp", providerMessageId: info.messageId ?? null };
  },
};
