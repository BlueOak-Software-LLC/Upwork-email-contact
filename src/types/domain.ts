import type { Database } from "@/types/database";

export type Maybe<T> = T | null;

export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
export type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];
export type ContactUpdate = Database["public"]["Tables"]["contacts"]["Update"];
export type ContactStatus = Database["public"]["Enums"]["contact_status"];

export type EmailLogRow = Database["public"]["Tables"]["email_logs"]["Row"];
export type EmailLogInsert = Database["public"]["Tables"]["email_logs"]["Insert"];
export type EmailLogStatus = Database["public"]["Enums"]["email_log_status"];

/** Shape the dashboard renders (snake_case straight from Postgres). */
export type Contact = ContactRow;

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DashboardMetrics {
  totalContacts: number;
  newContacts: number;
  contacted: number;
  replied: number;
  replyRate: number; // 0..1
  emailsSent7d: number;
  emailsFailed7d: number;
  byStatus: Record<ContactStatus, number>;
  last7Days: Array<{ day: string; count: number }>;
}

export interface SendEmailInput {
  to: string;
  cc?: string[];
  subject: string;
  /** Either `text` or `html` is required; text is generated from html when omitted. */
  html?: string;
  text?: string;
  replyTo?: string;
  contactId?: string;
  /** Marks the contact as contacted + stamps last_contacted_at. Default true. */
  updateContact?: boolean;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  id: string;
  status: EmailLogStatus;
  provider: string;
  providerMessageId: Maybe<string>;
  to: string;
  subject: string;
  createdAt: string;
  error: Maybe<string>;
}

export const CONTACT_STATUSES = [
  "new",
  "contacted",
  "replied",
  "no_reply",
  "archived",
] as const satisfies readonly ContactStatus[];
