import type {
  Database,
  TrackingEventType as DbTrackingEventType,
  TrackingState as DbTrackingState,
} from "@/types/database";

export type Maybe<T> = T | null;

export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
export type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];
export type ContactUpdate = Database["public"]["Tables"]["contacts"]["Update"];
export type ContactStatus = Database["public"]["Enums"]["contact_status"];

export type EmailLogRow = Database["public"]["Tables"]["email_logs"]["Row"];
export type EmailLogInsert = Database["public"]["Tables"]["email_logs"]["Insert"];
export type EmailLogStatus = Database["public"]["Enums"]["email_log_status"];

export type TrackingEventType = DbTrackingEventType;
export type TrackingState = DbTrackingState;

export type TrackedLinkRow = Database["public"]["Tables"]["tracked_links"]["Row"];
export type TrackingEventRow = Database["public"]["Tables"]["tracking_events"]["Row"] & {
  /** PostgREST embed of the link an event belongs to. */
  link?: Maybe<Pick<TrackedLinkRow, "label" | "destination_url">>;
};

/** What a `record_tracking_event` / `record_log_outcome` call answered. */
export interface TrackingOutcome {
  found: boolean;
  recorded: boolean;
  /** Same client asking again inside the dedupe window — not a new open. */
  duplicate?: boolean;
  /** Per-day cap reached; the click still redirects, the open still returns the image. */
  capped?: boolean;
  /** The RPC or column this call needs is not installed — say so, do not blame the row. */
  unavailable?: boolean;
  logId?: Maybe<string>;
  eventId?: Maybe<string>;
  log?: Maybe<Pick<EmailLogRow, "id" | "status" | "to_email" | "subject" | "open_count" | "click_count">>;
  link?: Maybe<Pick<TrackedLinkRow, "id" | "token" | "destination_url" | "label" | "click_count">>;
}

/** Outcomes a human records by hand — the app never reads a mailbox. */
export type TrackingOutcomeKind = "reply" | "meeting" | "not_interested";

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
  /** True when this recipient's copy carries its own tracking pixel. */
  tracked?: boolean;
  /** The `/o/<token>.gif` secret for this recipient. */
  trackingToken?: Maybe<string>;
  /** Absolute pixel address, as it was written into the message. */
  pixelUrl?: Maybe<string>;
}

export const CONTACT_STATUSES = [
  "new",
  "contacted",
  "replied",
  "no_reply",
  "archived",
] as const satisfies readonly ContactStatus[];
