import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * The authenticated tracking API — what the dashboard and a script can call.
 *
 * The distinction that matters most here is between three failures that all
 * look like "nothing happened": the row is gone, the migration is not applied,
 * and the caller is not allowed. Each gets its own status code and its own
 * sentence, because each has a different next action.
 */

const recordOutcome = vi.fn();
const listEvents = vi.fn();
const linksForLog = vi.fn();
const eventsForLog = vi.fn();
const purge = vi.fn();
const stats = vi.fn();
const list = vi.fn();
const byId = vi.fn();

vi.mock("@/server/db/tracking.repo", () => ({
  TRACKING_MIGRATION: "supabase/migrations/0005_email_tracking.sql",
  trackingRepo: {
    recordOutcome: (id: string, kind: string) => recordOutcome(id, kind),
    listEvents: (q: unknown) => listEvents(q),
    linksForLog: (id: string) => linksForLog(id),
    eventsForLog: (id: string, limit: number) => eventsForLog(id, limit),
    purge: (before: string) => purge(before),
    stats: (days: number) => stats(days),
  },
}));

vi.mock("@/server/db/email-logs.repo", () => ({
  emailLogsRepo: {
    list: (q: unknown) => list(q),
    byId: (id: string) => byId(id),
  },
}));

vi.mock("@/server/http/auth", () => ({
  requireSessionUser: async () => null,
  // Mirrors the real contract: a missing or wrong key is refused, never
  // silently treated as a signed-in user. The error classes are imported when
  // called, because the mock factory runs before any module has settled.
  requireApiKey: async (request: NextRequest) => {
    if (request.headers.get("x-api-key") === "good-key") {
      return { kind: "service", label: "api-key" };
    }
    const { ApiError } = await import("@/server/http/errors");
    throw ApiError.unauthorized("Provide the `x-api-key` header or sign in.");
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CRON = "s3cr3t-value-for-tests-only";
const LOG_ID = "6b3f1a44-9c0d-4e3a-9b1c-2f5d8a7e1b30";

/** Next hands route handlers a context; the static routes never read it. */
const ctx = { params: Promise.resolve({}) } as never;

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * A real `Request` plus the two Next-only properties the routes touch:
 * `nextUrl` for query strings and `cookies` for session lookup.
 */
function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): NextRequest {
  const headers = new Headers({ "x-api-key": "good-key", ...init.headers });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const url = `http://localhost:3000${path}`;
  const stub = new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }) as NextRequest;
  Object.defineProperty(stub, "nextUrl", { value: new URL(url) });
  Object.defineProperty(stub, "cookies", { value: { get: () => undefined, getAll: () => [] } });
  return stub;
}

const outcomeRoute = async () => (await import("@/app/api/tracking/outcome/route")).POST;
const statsRoute = async () => (await import("@/app/api/tracking/stats/route")).GET;
const purgeRoute = async () => (await import("@/app/api/maintenance/purge/route")).POST;
const emailListRoute = async () => (await import("@/app/api/email/route")).GET;
const emailDetailRoute = async () => (await import("@/app/api/email/[id]/route")).GET;

beforeEach(() => {
  vi.resetModules();
  // getServerEnv() is deliberately strict, so a route test has to look like a
  // configured deployment rather than an empty process.
  process.env.CRON_SECRET = CRON;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-long-enough-for-tests";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-long-enough-for-tests";
  process.env.NEXT_PUBLIC_APP_URL = "https://track.example.com";
  process.env.EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "proposals@example.com";
  process.env.SMTP_PASS = "an-app-password-for-tests";
  process.env.EMAIL_TRACKING = "true";
  process.env.LINK_TRACKING = "true";
  delete process.env.API_MASTER_KEY;
  delete process.env.TRACKING_RETENTION_DAYS;
  for (const mock of [
    recordOutcome,
    listEvents,
    linksForLog,
    eventsForLog,
    purge,
    stats,
    list,
    byId,
  ]) {
    mock.mockReset();
  }
});

const sampleLog = {
  id: LOG_ID,
  status: "sent",
  to_email: "client@example.com",
  subject: "Proposal",
  body_text: "Hi",
  tracking_token: "TokenOwnedByThisMessage0123456789",
  open_count: 2,
  click_count: 1,
  unique_click_count: 1,
  first_open_at: "2026-01-01T10:00:00.000Z",
  last_open_at: "2026-01-01T11:00:00.000Z",
  first_click_at: "2026-01-01T12:00:00.000Z",
  last_click_at: "2026-01-01T12:00:00.000Z",
  last_event_at: "2026-01-01T12:00:00.000Z",
} as unknown as Record<string, unknown>;

describe("POST /api/tracking/outcome", () => {
  it("records an outcome and returns the event id", async () => {
    recordOutcome.mockResolvedValue({ found: true, recorded: true, logId: LOG_ID, eventId: "e-1" });
    const POST = await outcomeRoute();

    const response = await POST(
      request("/api/tracking/outcome", {
        method: "POST",
        body: { logId: LOG_ID, kind: "reply" },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { logId: LOG_ID, eventId: "e-1", kind: "reply" },
    });
  });

  it("404s a row that is really gone", async () => {
    recordOutcome.mockResolvedValue({ found: false, recorded: false });
    const POST = await outcomeRoute();

    const response = await POST(
      request("/api/tracking/outcome", {
        method: "POST",
        body: { logId: LOG_ID, kind: "reply" },
      }),
      ctx,
    );
    expect(response.status).toBe(404);
    expect(recordOutcome).toHaveBeenCalledWith(LOG_ID, "reply");
  });

  it("502s an un-migrated database instead of blaming the row", async () => {
    recordOutcome.mockResolvedValue({ found: false, recorded: false, unavailable: true });
    const POST = await outcomeRoute();

    const body = await (
      await POST(
        request("/api/tracking/outcome", {
          method: "POST",
          body: { logId: LOG_ID, kind: "reply" },
        }),
        ctx,
      )
    ).json();
    expect(body.error.code).toBe("upstream_error");
    expect(body.error.message).toMatch(/0005_email_tracking.sql/);
    expect(body.error.message).not.toMatch(/deleted/);
  });

  it("refuses kinds the app cannot observe", async () => {
    const POST = await outcomeRoute();

    const badKind = await POST(
      request("/api/tracking/outcome", {
        method: "POST",
        body: { logId: LOG_ID, kind: "opened" },
      }),
      ctx,
    );
    expect(badKind.status).toBe(422);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("refuses an id it cannot parse before touching the database", async () => {
    const POST = await outcomeRoute();

    const response = await POST(
      request("/api/tracking/outcome", { method: "POST", body: { logId: "6b3f1a44", kind: "reply" } }),
      ctx,
    );
    expect(response.status).toBe(422);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("requires a credential", async () => {
    const POST = await outcomeRoute();

    const response = await POST(
      request("/api/tracking/outcome", {
        method: "POST",
        headers: { "x-api-key": "" },
        body: { logId: LOG_ID, kind: "reply" },
      }),
      ctx,
    );
    expect(response.status).toBe(401);
    expect(recordOutcome).not.toHaveBeenCalled();
  });
});

describe("GET /api/tracking/stats", () => {
  it("returns the counts together with the effective configuration", async () => {
    stats.mockResolvedValue({
      rangeDays: 7,
      sent: 4,
      delivered: 4,
      tracked: 3,
      opens: 9,
      uniqueOpeners: 2,
      clicks: 1,
      uniqueClickers: 1,
      openRate: 0.5,
      clickRate: 0.5,
      clickThroughRate: 0.25,
      series: [],
      domains: [
        { domain: "acme.com", delivered: 3, opened: 2, clicks: 1, openRate: 2 / 3, clickRate: 1 / 3 },
      ],
      schemaMissing: false,
    });
    const GET = await statsRoute();
    const response = await GET(request("/api/tracking/stats"), ctx);
    const json = await response.json();

    expect(json.data.openRate).toBe(0.5);
    // Domain rollup travels untouched; the page decides how to present it.
    expect(json.data.domains).toEqual([
      { domain: "acme.com", delivered: 3, opened: 2, clicks: 1, openRate: 2 / 3, clickRate: 1 / 3 },
    ]);
    // The flag travels with the numbers so a zero dashboard stays explainable.
    expect(json.data.configured).toEqual({
      enabled: true,
      linkTracking: true,
      domain: "https://track.example.com",
      retentionDays: 365,
    });
    expect(stats).toHaveBeenCalledWith(7);
  });

  it("refuses a window it would rather not scan", async () => {
    const GET = await statsRoute();
    const response = await GET(request("/api/tracking/stats?days=999"), ctx);
    expect(response.status).toBe(422);
    expect(stats).not.toHaveBeenCalled();

    const clamped = await GET(request("/api/tracking/stats?days=30"), ctx);
    expect(clamped.status).toBe(200);
    expect(stats).toHaveBeenCalledWith(30);
  });
});

describe("GET /api/email", () => {
  it("passes the engagement filter down and derives the state", async () => {
    list.mockResolvedValue({
      items: [sampleLog as never],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    const GET = await emailListRoute();

    const response = await GET(request("/api/email?tracking=opened"), ctx);
    const json = await response.json();

    expect(list.mock.calls[0]![0]).toMatchObject({ tracking: "opened", page: 1, pageSize: 25 });
    // Counters win over delivery status: clicked beats opened beats sent.
    expect(json.data[0].tracking_state).toBe("clicked");
    expect(json.meta).toMatchObject({ total: 1 });
  });

  it("normalises a recipient-domain filter before querying", async () => {
    list.mockResolvedValue({
      items: [sampleLog as never],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    const GET = await emailListRoute();
    const response = await GET(request("/api/email?domain=ACME.com"), ctx);

    expect(response.status).toBe(200);
    expect(list.mock.calls[0]![0]).toMatchObject({ domain: "acme.com" });
  });

  it("rejects a domain that is not a hostname", async () => {
    const GET = await emailListRoute();
    for (const bad of ["acme", "acme..com", "-acme.com", "acme.com/path"]) {
      const response = await GET(request(`/api/email?domain=${encodeURIComponent(bad)}`), ctx);
      expect(response.status).toBe(422);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("labels a pre-migration row as untracked rather than unopened", async () => {
    list.mockResolvedValue({
      items: [{ ...sampleLog, tracking_token: null } as never],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    const GET = await emailListRoute();
    const json = await (await GET(request("/api/email"), ctx)).json();
    expect(json.data[0].tracking_state).toBe("untracked");
  });

  it("rejects a filter it cannot honour before touching the database", async () => {
    const GET = await emailListRoute();
    const response = await GET(request("/api/email?tracking=maybe"), ctx);
    expect(response.status).toBe(422);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("GET /api/email/:id", () => {
  it("returns the delivery row, its links and its timeline", async () => {
    byId.mockResolvedValue(sampleLog as never);
    linksForLog.mockResolvedValue([
      { id: "l1", destination_url: "https://acme.example/x", click_count: 1 },
    ]);
    eventsForLog.mockResolvedValue([
      { id: "e1", event_type: "open", occurred_at: "2026-01-01T10:00:00Z" },
    ]);

    const GET = await emailDetailRoute();
    const json = await (await GET(request(`/api/email/${LOG_ID}`), idParams(LOG_ID))).json();

    expect(json.data.log.tracking_state).toBe("clicked");
    expect(json.data.links).toHaveLength(1);
    expect(json.data.events).toHaveLength(1);
  });

  it("404s an unknown id and refuses a malformed one at the edge", async () => {
    byId.mockResolvedValue(null);
    const GET = await emailDetailRoute();

    const gone = await GET(request(`/api/email/${LOG_ID}`), idParams(LOG_ID));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "not_found" } });

    // A truncated id is a client mistake, answered without a database
    // round-trip that would only fail with a 502.
    const malformed = await GET(request("/api/email/6b3f1a44"), idParams("6b3f1a44"));
    expect(malformed.status).toBe(400);
    const malformedBody = await malformed.json();
    expect(malformedBody.error.code).toBe("bad_request");
    expect(byId).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/maintenance/purge", () => {
  it("accepts the scheduler bearer secret and uses the configured window", async () => {
    purge.mockResolvedValue(12);
    process.env.TRACKING_RETENTION_DAYS = "90";
    const POST = await purgeRoute();

    const response = await POST(
      request("/api/maintenance/purge", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON}`, "x-api-key": "" },
      }),
      ctx,
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.removed).toBe(12);
    expect(json.data.days).toBe(90);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("refuses a wrong secret and no secret at all", async () => {
    const POST = await purgeRoute();

    const wrong = await POST(
      request("/api/maintenance/purge", {
        method: "POST",
        headers: { authorization: "Bearer not-the-secret", "x-api-key": "" },
      }),
      ctx,
    );
    expect(wrong.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();

    const bare = await POST(
      request("/api/maintenance/purge", { method: "POST", headers: { "x-api-key": "" } }),
      ctx,
    );
    expect(bare.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it("trusts Vercel's own scheduler marker", async () => {
    purge.mockResolvedValue(0);
    const POST = await purgeRoute();

    const response = await POST(
      request("/api/maintenance/purge", {
        method: "POST",
        headers: { "x-vercel-cron": "1", "x-api-key": "" },
      }),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it("lets an authenticated caller choose the window, but never a silly one", async () => {
    purge.mockResolvedValue(0);
    const POST = await purgeRoute();

    const ok = await POST(
      request("/api/maintenance/purge", { method: "POST", body: { days: 30 } }),
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(purge.mock.calls[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const tooSmall = await POST(
      request("/api/maintenance/purge", { method: "POST", body: { days: 2 } }),
      ctx,
    );
    expect(tooSmall.status).toBe(422);
  });
});
