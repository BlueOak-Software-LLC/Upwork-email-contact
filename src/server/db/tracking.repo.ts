import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import { isMissingSchema } from "@/server/db/schema-guard";
import { isToken } from "@/server/services/tracking/token";
import type {
  Maybe,
  TrackingEventType,
  TrackingEventRow,
  TrackingOutcome,
  TrackingOutcomeKind,
  TrackedLinkRow,
} from "@/types/domain";

/**
 * Engagement tracking: the pixel/click hot path and the reads behind the
 * dashboard. Ported from BlueOak Track's `server/supabaseStore.ts`, narrowed to
 * what this schema actually needs.
 *
 * Every write goes through a server-only RPC, because the rules that make the
 * numbers mean something — one open per client per minute, a per-day cap, a
 * counter that moves in the same transaction as the event row — belong in the
 * database. Doing that in application code would lose it the first time two
 * mail clients hit the pixel at the same instant.
 */

export const TRACKING_MIGRATION = "supabase/migrations/0005_email_tracking.sql";

const EVENT_COLUMNS =
  "id,log_id,link_id,event_type,occurred_at,user_agent,metadata,link:tracked_links(label,destination_url)";
/** The compact shape `record_tracking_event` returns (see 0005). */
type RawRecordResult = {
  found?: boolean;
  recorded?: boolean;
  duplicate?: boolean;
  capped?: boolean;
  log?: Record<string, unknown>;
  event?: Record<string, unknown>;
  link?: Record<string, unknown> | null;
};

export const trackingRepo = {
  /**
   * Attach the per-recipient redirect links to a delivery-log row.
   *
   * An un-migrated database must not break a send that already happened, so a
   * missing `tracked_links` table is logged and skipped: opens still work, only
   * click tracking goes quiet until 0005 is applied.
   */
  async createLinks(input: {
    logId: string;
    links: Array<{ token: string; destinationUrl: string; label: string }>;
  }): Promise<number> {
    if (input.links.length === 0) return 0;
    const supabase = getAdminClient();
    const { error } = await supabase.from("tracked_links").insert(
      input.links.map((link) => ({
        log_id: input.logId,
        token: link.token,
        destination_url: link.destinationUrl,
        label: link.label,
      })),
    );
    if (error) {
      if (isMissingSchema(error)) {
        logger.warn("db_tracking_links_missing", {
          migration: TRACKING_MIGRATION,
          detail: error.message,
        });
        return 0;
      }
      // A duplicate token would mean a random collision (2^-188) or a bug;
      // neither is worth failing a delivered email over.
      logger.error("tracked_links_insert_failed", { logId: input.logId, error: error.message });
      return 0;
    }
    return input.links.length;
  },

  /** Record one pixel hit or one click. Never throws: a mail client only ever sees the image. */
  async record(
    kind: "open" | "click",
    token: string,
    userAgent: string | null,
  ): Promise<TrackingOutcome> {
    if (!isToken(token)) return { found: false, recorded: false };
    const supabase = getAdminClient();
    const { data, error } = await supabase.rpc("record_tracking_event", {
      p_kind: kind,
      p_token: token,
      p_agent: (userAgent || "").slice(0, 300) || null,
      p_at: new Date().toISOString(),
    });

    if (error) {
      if (isMissingSchema(error)) {
        logger.warn("db_tracking_rpc_missing", {
          migration: TRACKING_MIGRATION,
          detail: error.message,
        });
      } else {
        logger.error("tracking_record_failed", { kind, error: error.message });
      }
      return { found: false, recorded: false };
    }

    const raw = (data ?? {}) as RawRecordResult;
    return {
      found: raw.found === true,
      recorded: raw.recorded === true,
      duplicate: raw.duplicate === true,
      capped: raw.capped === true,
      logId: typeof raw.log?.["id"] === "string" ? (raw.log["id"] as string) : null,
      log: (raw.log as Maybe<TrackingOutcome["log"]>) ?? null,
      eventId: typeof raw.event?.["id"] === "string" ? (raw.event["id"] as string) : null,
      link: (raw.link as Maybe<TrackingOutcome["link"]>) ?? null,
    };
  },

  /** Read-only link lookup for `/c/<token>` — the destination is re-validated at click time. */
  async linkByToken(token: string): Promise<Maybe<TrackedLinkRow>> {
    if (!isToken(token)) return null;
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("tracked_links")
      .select("id,log_id,token,destination_url,label,click_count,first_click_at,last_click_at,created_at")
      .eq("token", token)
      .maybeSingle();
    if (error) {
      if (isMissingSchema(error)) {
        logger.warn("db_tracking_links_missing", {
          migration: TRACKING_MIGRATION,
          detail: error.message,
        });
      } else {
        logger.error("tracked_link_lookup_failed", { error: error.message });
      }
      return null;
    }
    return (data as TrackedLinkRow) ?? null;
  },

  /**
   * Put the send itself on the timeline.
   *
   * `email_logs.sent_at` already knows this; the event row exists so the
   * Activity timeline has a beginning, and because `purge_tracking_events`
   * never deletes non-open/click rows.
   */
  async markSent(logId: string): Promise<void> {
    const supabase = getAdminClient();
    const { error } = await supabase.from("tracking_events").insert({
      log_id: logId,
      event_type: "sent",
      metadata: { source: "provider" },
    });
    if (error && !isMissingSchema(error)) {
      logger.warn("tracking_sent_event_failed", { logId, detail: error.message });
    }
  },

  /** A human says what happened. Returns false when the row or the RPC is unavailable. */
  async recordOutcome(logId: string, kind: TrackingOutcomeKind): Promise<TrackingOutcome> {
    const supabase = getAdminClient();
    const { data, error } = await supabase.rpc("record_log_outcome", {
      p_log_id: logId,
      p_kind: kind,
      p_at: new Date().toISOString(),
    });
    if (error) {
      if (isMissingSchema(error)) {
        logger.warn("db_tracking_rpc_missing", {
          migration: TRACKING_MIGRATION,
          detail: error.message,
        });
        // `unavailable` is what keeps the route honest: "I could not find that
        // message" and "this database has no tracking RPC" are different facts,
        // and the second one is actionable.
        return { found: false, recorded: false, unavailable: true };
      }
      logger.error("tracking_outcome_failed", { logId, kind, error: error.message });
      return { found: false, recorded: false, unavailable: true };
    }
    const raw = (data ?? {}) as RawRecordResult & { log_id?: string };
    return {
      found: raw.found === true,
      recorded: raw.recorded === true,
      logId: raw.log_id ?? logId,
      eventId: typeof raw.event?.["id"] === "string" ? (raw.event["id"] as string) : null,
    };
  },

  /** Timeline for one delivered message, newest first. */
  async eventsForLog(logId: string, limit = 100): Promise<TrackingEventRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("tracking_events")
      .select(EVENT_COLUMNS)
      .eq("log_id", logId)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) {
      if (isMissingSchema(error)) return [];
      throw ApiError.upstream(`Failed to load tracking events: ${error.message}`);
    }
    return (data ?? []) as TrackingEventRow[];
  },

  async listEvents(query: {
    page: number;
    pageSize: number;
    type?: TrackingEventType;
    logId?: string;
  }): Promise<{ items: TrackingEventRow[]; total: number }> {
    const supabase = getAdminClient();
    const from = (query.page - 1) * query.pageSize;
    let builder = supabase
      .from("tracking_events")
      .select(EVENT_COLUMNS, { count: "exact" })
      .order("occurred_at", { ascending: false })
      .range(from, from + query.pageSize - 1);
    if (query.type) builder = builder.eq("event_type", query.type);
    if (query.logId) builder = builder.eq("log_id", query.logId);

    const { data, error, count } = await builder;
    if (error) {
      if (isMissingSchema(error)) return { items: [], total: 0 };
      throw ApiError.upstream(`Failed to list tracking events: ${error.message}`);
    }
    return { items: (data ?? []) as TrackingEventRow[], total: count ?? 0 };
  },

  /** Links of one log row with their click counts, for the detail page. */
  async linksForLog(logId: string): Promise<TrackedLinkRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("tracked_links")
      .select("id,log_id,token,destination_url,label,click_count,first_click_at,last_click_at,created_at")
      .eq("log_id", logId)
      .order("click_count", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) {
      if (isMissingSchema(error)) return [];
      throw ApiError.upstream(`Failed to load tracked links: ${error.message}`);
    }
    return (data ?? []) as TrackedLinkRow[];
  },

  /**
   * Click counts for a set of drafts, newest send only per draft.
   *
   * This is what puts `opened 3×` on the draft card in the lead workspace
   * without loading the whole delivery log.
   */
  async latestByDraft(draftIds: string[]): Promise<Map<string, LatestLogForDraft>> {
    const map = new Map<string, LatestLogForDraft>();
    if (draftIds.length === 0) return map;
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select("id,draft_id,tracking_token,open_count,click_count,last_open_at,last_click_at,last_event_at,status")
      .in("draft_id", draftIds)
      .order("created_at", { ascending: false });
    if (error) {
      if (isMissingSchema(error)) return map;
      throw ApiError.upstream(`Failed to load draft engagement: ${error.message}`);
    }
    for (const row of data ?? []) {
      const draftId = row.draft_id as Maybe<string>;
      if (!draftId) continue;
      const previous = map.get(draftId);
      const current = {
        logId: row.id as string,
        draftId,
        tracked: Boolean(row.tracking_token),
        openCount: Number(row.open_count ?? 0),
        clickCount: Number(row.click_count ?? 0),
        lastOpenAt: (row.last_open_at as Maybe<string>) ?? null,
        lastClickAt: (row.last_click_at as Maybe<string>) ?? null,
        lastEventAt: (row.last_event_at as Maybe<string>) ?? null,
        status: row.status as string,
      };
      // Keep one aggregate per draft across multiple sends (cc, retries).
      if (previous) {
        map.set(draftId, {
          ...previous,
          tracked: previous.tracked || current.tracked,
          openCount: previous.openCount + current.openCount,
          clickCount: previous.clickCount + current.clickCount,
          lastOpenAt: maxOf(previous.lastOpenAt, current.lastOpenAt),
          lastClickAt: maxOf(previous.lastClickAt, current.lastClickAt),
          lastEventAt: maxOf(previous.lastEventAt, current.lastEventAt),
        });
      } else {
        map.set(draftId, current);
      }
    }
    return map;
  },

  /**
   * Overview numbers. Aggregated in JS from the counter columns rather than a
   * view, matching `contactsRepo.metrics()`: the row count here is one per
   * recipient per send, which stays small enough to read directly.
   */
  async stats(days = 7) {
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);

    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select(
        "id,status,created_at,sent_at,tracking_token,open_count,click_count,first_open_at,first_click_at,to_email",
      )
      .gte("created_at", since.toISOString());
    if (error) {
      if (isMissingSchema(error)) {
        // The one failure a zero dashboard must never hide: "nobody opened it"
        // and "the tracking columns do not exist" look identical otherwise.
        logger.warn("db_tracking_stats_missing", {
          migration: TRACKING_MIGRATION,
          detail: error.message,
        });
        return { ...emptyStats(days), schemaMissing: true };
      }
      throw ApiError.upstream(`Failed to compute tracking stats: ${error.message}`);
    }

    const rows = data ?? [];
    const tracked = rows.filter((row) => Boolean(row.tracking_token));
    const opened = tracked.filter((row) => Number(row.open_count ?? 0) > 0);
    const clicked = tracked.filter((row) => Number(row.click_count ?? 0) > 0);
    const opens = opened.reduce((sum, row) => sum + Number(row.open_count), 0);
    const clicks = clicked.reduce((sum, row) => sum + Number(row.click_count), 0);
    const delivered = rows.filter((row) => row.status === "sent");

    // Recipient-domain rollup. Deliverability and engagement differ sharply by
    // mailbox provider (Gmail vs Outlook vs a corporate domain), and the only
    // reliable way to see that is to group the sends that already happened.
    // Open counts stay "unique-ish": the pixel de-duplicates per client per
    // minute in the database, so this is directional rather than exact.
    const byDomain = new Map<
      string,
      { delivered: number; opened: number; clicks: number }
    >();
    for (const row of rows) {
      if (row.status !== "sent") continue;
      const domain = recipientDomain(row.to_email);
      if (!domain) continue;
      const bucket = byDomain.get(domain) ?? { delivered: 0, opened: 0, clicks: 0 };
      bucket.delivered += 1;
      if (Number(row.open_count ?? 0) > 0) bucket.opened += 1;
      if (Number(row.click_count ?? 0) > 0) bucket.clicks += 1;
      byDomain.set(domain, bucket);
    }

    const perDay = new Map<string, { opens: number; clicks: number; sent: number }>();
    const now = Date.now();
    for (let index = days - 1; index >= 0; index -= 1) {
      perDay.set(dayKey(new Date(now - index * 86_400_000)), {
        opens: 0,
        clicks: 0,
        sent: 0,
      });
    }
    const bump = (key: string | null, field: "opens" | "clicks" | "sent", amount = 1) => {
      if (!key || !perDay.has(key)) return;
      const bucket = perDay.get(key)!;
      bucket[field] += amount;
    };
    for (const row of rows) {
      // Graph bars count messages, not raw events: one message with five pixel
      // hits is still one opened email. The cards above still expose total
      // event counts separately.
      if (row.status === "sent") bump(isoDay(row.sent_at ?? row.created_at), "sent", 1);
      if (Number(row.open_count ?? 0) > 0) bump(isoDay(row.first_open_at), "opens", 1);
      if (Number(row.click_count ?? 0) > 0) bump(isoDay(row.first_click_at), "clicks", 1);
    }

    return {
      rangeDays: days,
      sent: delivered.length,
      delivered: delivered.length,
      tracked: tracked.length,
      opens,
      uniqueOpeners: opened.length,
      clicks,
      uniqueClickers: clicked.length,
      openRate: delivered.length ? opened.length / delivered.length : null,
      clickRate: opened.length ? clicked.length / opened.length : null,
      clickThroughRate: delivered.length ? clicked.length / delivered.length : null,
      series: [...perDay.entries()].map(([date, counts]) => ({ date, ...counts })),
      domains: [...byDomain.entries()]
        .map(([domain, counts]) => ({
          domain,
          ...counts,
          openRate: counts.delivered ? counts.opened / counts.delivered : null,
          clickRate: counts.delivered ? counts.clicks / counts.delivered : null,
        }))
        .sort((left, right) => right.delivered - left.delivered || left.domain.localeCompare(right.domain))
        .slice(0, 15),
      schemaMissing: false,
    };
  },

  /** Sent, never opened, at least `days` ago — the Overview attention queue. */
  async staleSends(days = 7, limit = 8): Promise<StaleSend[]> {
    const before = new Date(Date.now() - days * 86_400_000).toISOString();
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select("id,to_email,subject,sent_at,draft_id,open_count,click_count")
      .eq("status", "sent")
      .not("tracking_token", "is", null)
      .eq("open_count", 0)
      .lt("sent_at", before)
      .order("sent_at", { ascending: false })
      .limit(limit);
    if (error) {
      if (!isMissingSchema(error)) {
        logger.warn("tracking_stale_sends_failed", { detail: error.message });
      }
      return [];
    }
    return (data ?? []) as unknown as StaleSend[];
  },

  /** Delete old open/click rows and rebuild counters. Server-only RPC. */
  async purge(before: string): Promise<number> {
    const supabase = getAdminClient();
    const { data, error } = await supabase.rpc("purge_tracking_events", { p_before: before });
    if (error) {
      if (isMissingSchema(error)) {
        throw ApiError.upstream(
          `Retention needs ${TRACKING_MIGRATION}: the purge RPC is not installed.`,
        );
      }
      throw ApiError.upstream(`Tracking purge failed: ${error.message}`);
    }
    return Number(data ?? 0);
  },
};

export interface LatestLogForDraft {
  logId: string;
  draftId: string;
  tracked: boolean;
  openCount: number;
  clickCount: number;
  lastOpenAt: Maybe<string>;
  lastClickAt: Maybe<string>;
  lastEventAt: Maybe<string>;
  status: string;
}

/** A delivered message that has been sitting unopened. */
export interface StaleSend {
  id: string;
  to_email: string;
  subject: string;
  sent_at: string | null;
  draft_id: string | null;
  open_count: number;
  click_count: number;
}

function emptyStats(days: number) {
  const perDay: Array<{ date: string; opens: number; clicks: number; sent: number }> = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    perDay.push({
      date: dayKey(new Date(Date.now() - index * 86_400_000)),
      opens: 0,
      clicks: 0,
      sent: 0,
    });
  }
  return {
    rangeDays: days,
    schemaMissing: true,
    sent: 0,
    delivered: 0,
    tracked: 0,
    opens: 0,
    uniqueOpeners: 0,
    clicks: 0,
    uniqueClickers: 0,
    openRate: null as number | null,
    clickRate: null as number | null,
    clickThroughRate: null as number | null,
    series: perDay,
    domains: [] as Array<{
      domain: string;
      delivered: number;
      opened: number;
      clicks: number;
      openRate: number | null;
      clickRate: number | null;
    }>,
  };
}

/** `Name <a@b.com>` and `a@b.com` both yield `b.com`; anything else is dropped. */
function recipientDomain(value: string | null): string | null {
  const match = /@([^@>\s,;]+)/.exec(value ?? "");
  return match?.[1]?.toLowerCase() ?? null;
}

function isoDay(value: string | Date | null): string | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** UTC day bucket — the same convention the caps in the RPC use. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function maxOf(left: Maybe<string>, right: Maybe<string>): Maybe<string> {
  if (!left) return right;
  if (!right) return left;
  return new Date(right) > new Date(left) ? right : left;
}
