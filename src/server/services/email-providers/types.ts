export interface EmailMessage {
  to: string[];
  cc?: string[];
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface SendResponse {
  provider: string;
  providerMessageId: string | null;
}

/**
 * Adapter contract — add a provider (Postmark, SES, Mailgun…) by implementing
 * this interface and registering it in `./index.ts`.
 */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResponse>;
}

export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}
