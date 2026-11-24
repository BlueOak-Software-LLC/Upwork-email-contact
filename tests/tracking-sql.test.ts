import { type PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, createTestDb } from "./helpers/db";

/**
 * The tracking rules that make the numbers mean something live in SQL, not in
 * TypeScript — because two mail clients hitting the pixel in the same instant
 * arrive at two different serverless functions, and only the database can say
 * "that is one open".
 *
 * These tests run the real migration files in a real PostgreSQL engine (PGlite),
 * so they exercise what deploys. They never touch your Supabase project.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/** base64url, 32 chars — the same shape `mintToken()` produces. */
function token(label: string): string {
  const clean = label.replace(/[^A-Za-z0-9_-]/g, "");
  return `${clean}${"x".repeat(Math.max(0, 32 - clean.length))}`.slice(0, 32);
}

interface SentMessage {
  id: string;
  trackingToken: string;
}

async function sentMessage(label = "message"): Promise<SentMessage> {
  const trackingToken = token(`T${label}`);
  const { rows } = await asService<{ id: string }>(
    db,
    `insert into public.email_logs (to_email, from_email, subject, status, provider, sent_at, tracking_token)
     values ('client@example.com', 'us@example.com', 'Proposal for your listing', 'sent', 'smtp', now(), $1)
     returning id`,
    [trackingToken],
  );
  return { id: rows[0]!.id, trackingToken };
}

async function trackedLink(message: SentMessage, label = "link") {
  const tokenValue = token(`L${label}`);
  const { rows } = await asService<{ id: string }>(
    db,
    `insert into public.tracked_links (log_id, token, destination_url, label)
     values ($1, $2, 'https://acme.example.com/portfolio', 'Portfolio') returning id`,
    [message.id, tokenValue],
  );
  return { id: rows[0]!.id, token: tokenValue };
}

/** PGlite hands back a Date object; the app serialises to ISO. Compare the instant. */
function isSameInstant(value: string | Date | null | undefined, iso: string): boolean {
  if (!value) return false;
  return new Date(value).getTime() === new Date(iso).getTime();
}

async function counters(id: string) {
  const { rows } = await asService<{
    open_count: number;
    click_count: number;
    unique_click_count: number;
    last_event_at: string | Date | null;
    first_open_at: string | Date | null;
  }>(
    db,
    "select open_count, click_count, unique_click_count, last_event_at, first_open_at from public.email_logs where id = $1",
    [id],
  );
  return rows[0]!;
}

async function eventCount(id: string, type: string) {
  const { rows } = await asService<{ n: number }>(
    db,
    "select count(*)::int as n from public.tracking_events where log_id = $1 and event_type = $2",
    [id, type],
  );
  return rows[0]!.n;
}

async function totalEvents() {
  const { rows } = await asService<{ n: number }>(
    db,
    "select count(*)::int as n from public.tracking_events",
  );
  return rows[0]!.n;
}

async function record(
  kind: "open" | "click",
  target: string,
  agent: string,
  at = "2026-01-01T10:00:00Z",
) {
  const { rows } = await asService<{ result: Record<string, unknown> }>(
    db,
    "select public.record_tracking_event($1, $2, $3, $4::timestamptz) as result",
    [kind, target, agent, at],
  );
  return rows[0]!.result;
}

describe("record_tracking_event · opens", () => {
  it("records an open exactly once for the same client inside the dedupe window", async () => {
    const message = await sentMessage("dedupe");
    const at = "2026-02-01T10:00:00Z";

    expect(await record("open", message.trackingToken, "same-agent", at)).toMatchObject({
      found: true,
      recorded: true,
    });
    expect(await record("open", message.trackingToken, "same-agent", at)).toMatchObject({
      found: true,
      recorded: false,
      duplicate: true,
    });

    expect(await counters(message.id)).toMatchObject({ open_count: 1 });
    expect(await eventCount(message.id, "open")).toBe(1);
  });

  it("counts different clients separately, and the same client again after the window", async () => {
    const message = await sentMessage("clients");
    await record("open", message.trackingToken, "iphone-mail", "2026-02-02T10:00:00Z");
    await record("open", message.trackingToken, "outlook-web", "2026-02-02T10:00:10Z");
    await record("open", message.trackingToken, "iphone-mail", "2026-02-02T10:01:30Z");

    expect(await counters(message.id)).toMatchObject({ open_count: 3 });
  });

  it("caps opens per message per UTC day, and still answers the pixel", async () => {
    const message = await sentMessage("capday");
    const results: Record<string, unknown>[] = [];
    for (let index = 0; index < 45; index += 1) {
      // A distinct user agent per request, so the limiter under test is the cap.
      results.push(await record("open", message.trackingToken, `agent-${index}`, "2026-02-03T08:00:00Z"));
    }
    expect(results.filter((r) => r.recorded === true)).toHaveLength(40);
    expect(results.filter((r) => r.capped === true)).toHaveLength(5);
    expect(await counters(message.id)).toMatchObject({ open_count: 40 });
  });

  it("starts the day cap again after midnight UTC", async () => {
    const message = await sentMessage("caprolls");
    for (let index = 0; index < 41; index += 1) {
      await record("open", message.trackingToken, `a${index}`, "2026-02-04T23:59:00Z");
    }
    const nextDay = await record("open", message.trackingToken, "z", "2026-02-05T00:01:00Z");
    expect(nextDay).toMatchObject({ recorded: true });
    expect(await counters(message.id)).toMatchObject({ open_count: 41 });
  });

  it("seeds first_open_at once and moves last_event_at on every open", async () => {
    const message = await sentMessage("stamps");
    expect((await counters(message.id)).last_event_at).toBeNull();

    await record("open", message.trackingToken, "one", "2026-02-05T06:00:00Z");
    const first = (await counters(message.id)).first_open_at;
    await record("open", message.trackingToken, "two", "2026-02-05T09:00:00Z");

    // The first open wins and never moves, however many follow.
    expect(isSameInstant(first, "2026-02-05T06:00:00Z")).toBe(true);
    expect(isSameInstant((await counters(message.id)).first_open_at, "2026-02-05T06:00:00Z")).toBe(true);
    expect((await counters(message.id)).last_event_at).not.toBeNull();
  });

  it("does not lose an increment when identical events arrive concurrently", async () => {
    const message = await sentMessage("race");
    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        record("open", message.trackingToken, `agent-${index}`),
      ),
    );
    expect(results.filter((r) => r.recorded === true)).toHaveLength(12);
    expect(await counters(message.id)).toMatchObject({ open_count: 12 });
  });

  it("reports found:false for a token that belongs to nobody, and writes no event", async () => {
    const before = await totalEvents();
    expect(await record("open", token("NobodyHere"), "probe")).toMatchObject({
      found: false,
      recorded: false,
    });
    expect(await totalEvents()).toBe(before);
  });

  it("rejects a malformed token before touching a table", async () => {
    const before = await totalEvents();
    for (const bad of ["short", "has spaces and symbols", "q".repeat(200), ""]) {
      expect(await record("open", bad, "probe")).toMatchObject({ found: false, recorded: false });
    }
    expect(await totalEvents()).toBe(before);
  });

  it("refuses an event kind that is not open or click", async () => {
    const message = await sentMessage("badkind");
    await expect(
      asService(db, "select public.record_tracking_event('drop', $1, 'x', now())", [
        message.trackingToken,
      ]),
    ).rejects.toThrow(/invalid event/);
  });

  it("is unreachable for a caller that is not the service role", async () => {
    const message = await sentMessage("guard");
    await expect(
      asAnon(db, "select public.record_tracking_event('open', $1, 'x', now())", [
        message.trackingToken,
      ]),
    ).rejects.toThrow(/forbidden/);
  });
});

describe("record_tracking_event · clicks", () => {
  it("attributes a click to both the link and the message, counting a link once as unique", async () => {
    const message = await sentMessage("clickboth");
    const link = await trackedLink(message, "clickboth");

    await record("click", link.token, "reader", "2026-02-06T09:00:00Z");
    await record("click", link.token, "reader", "2026-02-06T09:05:00Z");

    const counts = await counters(message.id);
    expect(counts.click_count).toBe(2);
    expect(counts.unique_click_count).toBe(1);

    const { rows } = await asService<{ click_count: number; first_click_at: string }>(
      db,
      "select click_count, first_click_at from public.tracked_links where token = $1",
      [link.token],
    );
    expect(rows[0]!.click_count).toBe(2);
  });

  it("counts each link of a message separately", async () => {
    const message = await sentMessage("twolinks");
    const portfolio = await trackedLink(message, "twolinks-a");
    const pricing = await trackedLink(message, "twolinks-b");

    await record("click", portfolio.token, "reader", "2026-02-07T09:00:00Z");
    await record("click", pricing.token, "reader", "2026-02-07T09:00:10Z");

    expect(await counters(message.id)).toMatchObject({
      click_count: 2,
      unique_click_count: 2,
    });
  });

  it("caps clicks per link per day, which is what still lets the redirect happen", async () => {
    const message = await sentMessage("clickcap");
    const link = await trackedLink(message, "clickcap");
    const results: Record<string, unknown>[] = [];
    for (let index = 0; index < 205; index += 1) {
      results.push(await record("click", link.token, `agent-${index}`, "2026-02-08T08:00:00Z"));
    }
    expect(results.filter((r) => r.recorded === true)).toHaveLength(200);
    expect(results.filter((r) => r.capped === true)).toHaveLength(5);
  });

  it("reports found:false for an unknown link token", async () => {
    expect(await record("click", token("unknownlink"), "probe")).toMatchObject({
      found: false,
      recorded: false,
    });
  });
});

describe("record_log_outcome", () => {
  it("records a reply and folds it into the promoted contact", async () => {
    const contact = await asService<{ id: string }>(
      db,
      "insert into public.contacts (name, email, status) values ('Client', 'reply@example.com', 'contacted') returning id",
    );
    const id = contact.rows[0]!.id;
    const { rows } = await asService<{ id: string }>(
      db,
      `insert into public.email_logs (contact_id, to_email, from_email, subject, status, provider)
       values ($1, 'reply@example.com', 'us@example.com', 'Hi', 'sent', 'smtp') returning id`,
      [id],
    );
    const logId = rows[0]!.id;

    const { rows: result } = await asService<{ outcome: Record<string, unknown> }>(
      db,
      "select public.record_log_outcome($1, 'reply', now()) as outcome",
      [logId],
    );
    expect(result[0]!.outcome).toMatchObject({ found: true, recorded: true });

    const { rows: refreshed } = await asService<{ status: string }>(
      db,
      "select status from public.contacts where id = $1",
      [id],
    );
    expect(refreshed[0]!.status).toBe("replied");
    expect(await eventCount(logId, "reply")).toBe(1);
  });

  it("never downgrades a contact that already replied", async () => {
    const contact = await asService<{ id: string }>(
      db,
      "insert into public.contacts (name, email, status) values ('Busy', 'busy@example.com', 'replied') returning id",
    );
    const { rows } = await asService<{ id: string }>(
      db,
      `insert into public.email_logs (contact_id, to_email, from_email, subject, status, provider)
       values ($1, 'busy@example.com', 'us@example.com', 'Follow-up', 'sent', 'smtp') returning id`,
      [contact.rows[0]!.id],
    );

    await asService(db, "select public.record_log_outcome($1, 'not_interested', now())", [rows[0]!.id]);
    const { rows: refreshed } = await asService<{ status: string }>(
      db,
      "select status from public.contacts where id = $1",
      [contact.rows[0]!.id],
    );
    expect(refreshed[0]!.status).toBe("replied");
  });

  it("refuses an outcome the app cannot observe", async () => {
    await expect(
      asService(db, "select public.record_log_outcome(gen_random_uuid(), 'opened', now())"),
    ).rejects.toThrow(/invalid outcome/);
  });

  it("says so when the message does not exist", async () => {
    const { rows } = await asService<{ outcome: Record<string, unknown> }>(
      db,
      "select public.record_log_outcome(gen_random_uuid(), 'reply', now()) as outcome",
    );
    expect(rows[0]!.outcome).toMatchObject({ found: false });
  });
});

describe("purge_tracking_events", () => {
  it("deletes old open/click rows and rebuilds every counter", async () => {
    const message = await sentMessage("purge");
    const link = await trackedLink(message, "purge");

    await record("open", message.trackingToken, "a", "2025-01-01T00:00:00Z");
    await record("open", message.trackingToken, "b", "2025-01-02T00:00:00Z");
    await record("click", link.token, "a", "2025-01-03T00:00:00Z");
    await record("open", message.trackingToken, "c", "2026-01-01T00:00:00Z");

    const { rows } = await asService<{ removed: number }>(
      db,
      "select public.purge_tracking_events($1::timestamptz) as removed",
      ["2025-06-01T00:00:00Z"],
    );
    expect(rows[0]!.removed).toBe(3);

    const counts = await counters(message.id);
    expect(counts.open_count).toBe(1);
    expect(counts.click_count).toBe(0);
    expect(counts.unique_click_count).toBe(0);
    expect(isSameInstant(counts.first_open_at, "2026-01-01T00:00:00Z")).toBe(true);
    expect(isSameInstant(counts.last_event_at, "2026-01-01T00:00:00Z")).toBe(true);

    const { rows: linkRow } = await asService<{ click_count: number; first_click_at: string | null }>(
      db,
      "select click_count, first_click_at from public.tracked_links where token = $1",
      [link.token],
    );
    expect(linkRow[0]).toEqual({ click_count: 0, first_click_at: null });
  });

  it("keeps recorded outcomes and the delivery row itself", async () => {
    const message = await sentMessage("keepoutcomes");
    await asService(db, "select public.record_log_outcome($1, 'meeting', now())", [message.id]);
    await asService(db, "select public.purge_tracking_events(now() + interval '1 day')");

    expect(await eventCount(message.id, "meeting")).toBe(1);
    const { rows } = await asService<{ n: number }>(
      db,
      "select count(*)::int as n from public.email_logs where id = $1",
      [message.id],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("is idempotent: a second run in the same window removes nothing more", async () => {
    const message = await sentMessage("idempotent");
    await record("open", message.trackingToken, "old", "2024-01-01T00:00:00Z");

    const window = "2024-06-01T00:00:00Z";
    const first = await asService<{ removed: number }>(
      db,
      "select public.purge_tracking_events($1::timestamptz) as removed",
      [window],
    );
    const second = await asService<{ removed: number }>(
      db,
      "select public.purge_tracking_events($1::timestamptz) as removed",
      [window],
    );
    expect(Number(first.rows[0]!.removed)).toBeGreaterThanOrEqual(1);
    expect(second.rows[0]!.removed).toBe(0);
    expect(await counters(message.id)).toMatchObject({ open_count: 0, last_event_at: null });
  });

  it("is unreachable for anon", async () => {
    await expect(asAnon(db, "select public.purge_tracking_events(now())")).rejects.toThrow(/forbidden/);
  });
});

describe("schema guarantees the routes rely on", () => {
  it("makes a tracking token unique per row", async () => {
    await sentMessage("dupToken");
    await expect(sentMessage("dupToken")).rejects.toThrow(/unique|duplicate/i);
  });

  it("makes a link token unique, so /c/<token> can never be ambiguous", async () => {
    const first = await sentMessage("linkdup-a");
    const second = await sentMessage("linkdup-b");
    await trackedLink(first, "sameLinkToken");
    await expect(trackedLink(second, "sameLinkToken")).rejects.toThrow(/unique|duplicate/i);
  });

  it("stores no IP address, and truncates the user agent to 300 characters", async () => {
    const message = await sentMessage("agenttruncate");
    await record("open", message.trackingToken, "Mozilla/5.0 ".repeat(40));

    const { rows } = await asService<{ user_agent: string; metadata: Record<string, string> }>(
      db,
      "select user_agent, metadata from public.tracking_events where log_id = $1",
      [message.id],
    );
    expect(rows[0]!.user_agent).toHaveLength(300);
    expect(rows[0]!.metadata.source).toBe("tracking-pixel");
  });

  it("drops a message's links and events when the delivery row goes", async () => {
    const message = await sentMessage("cascade");
    await trackedLink(message, "cascade");
    await record("open", message.trackingToken, "agent");

    await asService(db, "delete from public.email_logs where id = $1", [message.id]);
    const { rows } = await asService<{ links: number; events: number }>(
      db,
      `select
        (select count(*) from public.tracked_links where log_id = $1)::int as links,
        (select count(*) from public.tracking_events where log_id = $1)::int as events`,
      [message.id],
    );
    expect(rows[0]).toEqual({ links: 0, events: 0 });
  });

  it("leaves rows sent before tracking (null token) alone", async () => {
    const { rows } = await asService<{ id: string }>(
      db,
      `insert into public.email_logs (to_email, from_email, subject, status, provider, tracking_token)
       values ('old@example.com', 'us@example.com', 'Before 0005', 'sent', 'smtp', null) returning id`,
    );
    expect(rows[0]!.id).toBeTruthy();
    expect(await counters(rows[0]!.id)).toMatchObject({ open_count: 0, last_event_at: null });
  });
});
