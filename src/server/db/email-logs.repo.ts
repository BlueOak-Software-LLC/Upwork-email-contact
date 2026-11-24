import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { isMissingSchema } from "@/server/db/schema-guard";
import type {
  EmailLogRow,
  EmailLogStatus,
  Maybe,
  Paged,
  TrackingState,
} from "@/types/domain";
import { ApiError } from "@/server/http/errors";
import { TRACKING_MIGRATION } from "@/server/db/tracking.repo";

/**
 * The delivery log: one row per recipient per send, and since 0005 the row a
 * tracking token belongs to.
 *
 * `status` describes DELIVERY only (queued/sent/failed/bounced) — "what the
 * provider said". Engagement is the counter columns, read through
 * `lib/tracking.ts`, so no enum had to change and rows written before tracking
 * report as `untracked` rather than lying about the past.
 *
 * Every read here degrades quietly when the 0005 columns are absent: an
 * un-migrated deploy should still show its delivery history, not a 502.
 */

/**
 * Two full literal strings, spelled out rather than composed.
 *
 * PostgREST resolves the result type from the *literal* select text, and a
 * composed value (template or concatenation) can widen to `string` at the call
 * site, which silently turns every row into an error type.
 */

/** What a database that has not applied 0005 yet is read with. */
const LEGACY_LOG_COLUMNS =
  "id,contact_id,draft_id,proposal_id,sender_account_id,to_email,from_email,subject,body_text,status,provider,provider_message_id,error,sent_at,created_at";

/** What a migrated database is read with: the delivery columns plus the counters. */
export const LOG_COLUMNS =
  "id,contact_id,draft_id,proposal_id,sender_account_id,to_email,from_email,subject,body_text,status,provider,provider_message_id,error,sent_at,created_at,tracking_token,open_count,click_count,unique_click_count,first_open_at,last_open_at,first_click_at,last_click_at,last_event_at";

export interface ListEmailLogsQuery {
  page: number;
  pageSize: number;
  status?: EmailLogStatus;
  to?: string;
  /** Matches the domain after `@`; the route validates the shape. */
  domain?: string;
  /** Engagement filter, derived from the counters. */
  tracking?: TrackingState;
  draftId?: string;
}

export interface LogWriteInput {
  toEmail: string;
  fromEmail: string;
  subject: string;
  bodyText: string;
  status: EmailLogStatus;
  provider: string;
  trackingToken?: Maybe<string>;
  contactId?: Maybe<string>;
  draftId?: Maybe<string>;
  proposalId?: Maybe<string>;
  senderAccountId?: Maybe<string>;
  providerMessageId?: Maybe<string>;
  error?: Maybe<string>;
  sentAt?: Maybe<string>;
}

export const emailLogsRepo = {
  async list(query: ListEmailLogsQuery): Promise<Paged<EmailLogRow>> {
    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;
    const supabase = getAdminClient();

    // Two explicit queries rather than one factory that takes a column string:
    // PostgREST resolves the result type from the *literal* select text, so a
    // `string` parameter would collapse both branches to an error type.
    const common = <T extends { eq(c: string, v: unknown): T; ilike(c: string, v: string): T }>(
      builder: T,
    ): T => {
      let out = builder;
      if (query.status) out = out.eq("status", query.status);
      if (query.to) out = out.ilike("to_email", `%${query.to}%`);
      // Anchored at the end so `acme.com` does not also match `notacme.com`.
      if (query.domain) out = out.ilike("to_email", `%@${query.domain}`);
      if (query.draftId) out = out.eq("draft_id", query.draftId);
      return out;
    };

    const trackedQuery = () =>
      common(
        supabase
          .from("email_logs")
          .select(LOG_COLUMNS, { count: "exact" })
          .order("created_at", { ascending: false })
          .range(from, to),
      );

    const first = query.tracking
      ? await applyTrackingFilter(trackedQuery(), query.tracking)
      : await trackedQuery();

    if (first.error) {
      if (!isMissingSchema(first.error)) {
        throw ApiError.upstream(`Failed to load email logs: ${first.error.message}`);
      }
      warnMissingSchema(first.error);
      if (query.tracking) {
        throw ApiError.badRequest(`Filtering by tracking status needs ${TRACKING_MIGRATION}.`);
      }
      const retry = await common(
        supabase
          .from("email_logs")
          .select(LEGACY_LOG_COLUMNS, { count: "exact" })
          .order("created_at", { ascending: false })
          .range(from, to),
      );
      if (retry.error) throw ApiError.upstream(`Failed to load email logs: ${retry.error.message}`);
      return page((retry.data ?? []) as EmailLogRow[], query, retry.count ?? 0);
    }

    return page((first.data ?? []) as EmailLogRow[], query, first.count ?? 0);
  },

  /** Full row including tracking counters, for `/emails/[id]`. */
  async byId(id: string): Promise<Maybe<EmailLogRow>> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select(LOG_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error && !isMissingSchema(error)) {
      throw ApiError.upstream(`Failed to load email log: ${error.message}`);
    }
    if (error) {
      warnMissingSchema(error);
      const legacy = await supabase
        .from("email_logs")
        .select(LEGACY_LOG_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (legacy.error) throw ApiError.upstream(`Failed to load email log: ${legacy.error.message}`);
      return (legacy.data as Maybe<EmailLogRow>) ?? null;
    }
    return (data as Maybe<EmailLogRow>) ?? null;
  },

  /** The row plus the contact it went to. */
  async withContact(id: string) {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select(`${LOG_COLUMNS}, contact:contacts(id,name,email,company,status)`)
      .eq("id", id)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to load email log: ${error.message}`);
    return data as Maybe<EmailLogRow & { contact?: Record<string, unknown> }>;
  },

  /**
   * Insert the audit row BEFORE the provider is called, and hand back its id.
   *
   * Two real bugs this closes:
   *  - a pixel hit that arrived while the send was still in flight had no row
   *    to attach to, so the first open by the fastest reader was thrown away;
   *  - the pixel URL is *inside* the message, so its token and therefore its
   *    row have to exist before the bytes go out.
   *
   * Returns null when the insert failed. A database hiccup downgrades the send
   * to untracked; it never blocks a message that is ready to leave.
   */
  async open(input: LogWriteInput): Promise<Maybe<string>> {
    const id = await this.create({ ...input, status: "queued" });
    return id;
  },

  /**
   * Stamp the outcome of the provider call onto the row `open()` created.
   *
   * The `status = 'queued'` condition makes this a claim: a second, racing send
   * cannot rewrite the first one's history, and a row already marked `sent`
   * stays as the record of the send that actually delivered.
   */
  async finalize(
    id: string,
    result: {
      status: EmailLogStatus;
      provider: string;
      providerMessageId?: Maybe<string>;
      error?: Maybe<string>;
      sentAt?: Maybe<string>;
    },
  ): Promise<boolean> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .update({
        status: result.status,
        provider: result.provider,
        provider_message_id: result.providerMessageId ?? null,
        error: result.error ?? null,
        sent_at: result.status === "sent" ? (result.sentAt ?? new Date().toISOString()) : null,
      })
      .eq("id", id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();

    if (error) {
      logger.error("email_log_finalize_failed", { id, error: error.message });
      return false;
    }
    return Boolean(data);
  },

  /**
   * One-shot insert. Also the 0005-aware retry: an unknown `tracking_token`
   * column drops the token and the send continues, untracked.
   */
  async create(input: LogWriteInput): Promise<Maybe<string>> {
    const supabase = getAdminClient();
    const payload = {
      contact_id: input.contactId ?? null,
      draft_id: input.draftId ?? null,
      proposal_id: input.proposalId ?? null,
      sender_account_id: input.senderAccountId ?? null,
      to_email: input.toEmail,
      from_email: input.fromEmail,
      subject: input.subject,
      body_text: input.bodyText.slice(0, 20_000),
      status: input.status,
      provider: input.provider,
      provider_message_id: input.providerMessageId ?? null,
      error: input.error ?? null,
      sent_at: input.status === "sent" ? (input.sentAt ?? new Date().toISOString()) : null,
      tracking_token: input.trackingToken ?? null,
    };

    const { data, error } = await supabase
      .from("email_logs")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      if (isMissingSchema(error)) {
        warnMissingSchema(error);
        const { tracking_token: _dropped, ...legacy } = payload;
        const retry = await supabase.from("email_logs").insert(legacy).select("id").single();
        if (retry.error) {
          // Delivery already happened — never fail the request over the audit row.
          logger.error("email_log_insert_failed", { to: input.toEmail, error: retry.error.message });
          return null;
        }
        return retry.data.id as string;
      }
      logger.error("email_log_insert_failed", { to: input.toEmail, error: error.message });
      return null;
    }
    return data.id as string;
  },

  /** Delivery counts for the Overview cards. */
  async metrics(days = 7) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - (days - 1));
    since.setUTCHours(0, 0, 0, 0);

    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select("id,status,created_at,tracking_token,open_count,click_count");
    if (error) {
      if (isMissingSchema(error)) {
        warnMissingSchema(error);
        const legacy = await supabase.from("email_logs").select("id,status,created_at");
        if (legacy.error) throw ApiError.upstream(`Failed to compute email metrics: ${legacy.error.message}`);
        return summarize((legacy.data ?? []) as EmailLogRow[], since);
      }
      throw ApiError.upstream(`Failed to compute email metrics: ${error.message}`);
    }
    return summarize((data ?? []) as EmailLogRow[], since);
  },
};

interface Filterable {
  eq(column: string, value: unknown): this;
  gt(column: string, value: unknown): this;
  is(column: string, value: null): this;
  not(column: string, operator: string, value: unknown): this;
}

/** Engagement filters, expressed as counter comparisons. */
function applyTrackingFilter<T extends Filterable>(builder: T, tracking: TrackingState): T {
  switch (tracking) {
    case "untracked":
      return builder.is("tracking_token", null) as T;
    case "sent":
      return builder
        .not("tracking_token", "is", null)
        .eq("open_count", 0)
        .eq("click_count", 0) as T;
    case "opened":
      return builder.not("open_count", "eq", 0).eq("click_count", 0) as T;
    case "clicked":
      return builder.gt("click_count", 0) as T;
    default:
      return builder;
  }
}

function summarize(rows: EmailLogRow[], since: Date) {
  const recent = rows.filter((row) => new Date(String(row.created_at)) >= since);
  return {
    sent7d: recent.filter((row) => row.status === "sent").length,
    failed7d: recent.filter((row) => row.status === "failed").length,
    total: rows.length,
  };
}

function page(items: EmailLogRow[], query: ListEmailLogsQuery, total: number): Paged<EmailLogRow> {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

let warned = false;

function warnMissingSchema(error: { message?: string | null }) {
  if (warned) return;
  warned = true;
  logger.warn("db_columns_missing", { migration: TRACKING_MIGRATION, detail: error.message ?? "" });
}
