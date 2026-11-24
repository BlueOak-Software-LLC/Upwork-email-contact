import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { TRANSPARENT_GIF } from "@/server/services/tracking/token";
import { isPublic } from "@/lib/supabase/middleware";

/**
 * The public tracking routes: what a mail client and a clicking recipient see.
 *
 * The repository is stubbed here so these tests are about HTTP semantics —
 * status, headers, fail-open behaviour, and the rule that nothing is recorded
 * without a well-formed token. The SQL rules behind the repo have their own
 * suite (`tracking-sql.test.ts`) running on a real PostgreSQL.
 */

const record = vi.fn();
const linkByToken = vi.fn();

vi.mock("@/server/db/tracking.repo", () => ({
  TRACKING_MIGRATION: "supabase/migrations/0005_email_tracking.sql",
  trackingRepo: {
    record: (...args: unknown[]) => record(...args),
    linkByToken: (...args: unknown[]) => linkByToken(...args),
  },
}));

const VALID = "ValidTokenForRouteTests0123456789";
const GIF_HEADERS = [
  "content-type",
  "cache-control",
  "pragma",
  "expires",
  "x-content-type-options",
] as const;

function request(path: string, userAgent = "Mozilla/5.0 iPhone"): NextRequest {
  return new Request(`http://localhost:3000${path}`, {
    headers: { "user-agent": userAgent, "x-forwarded-for": "203.0.113.7" },
  }) as unknown as NextRequest;
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

beforeEach(() => {
  record.mockReset();
  linkByToken.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

async function openRoute() {
  const mod = await import("@/app/o/[token]/route");
  return mod;
}

async function clickRoute() {
  const mod = await import("@/app/c/[token]/route");
  return mod;
}

describe("GET /o/<token>.gif", () => {
  it("always answers with a 1×1 gif and no-cache headers", async () => {
    const { GET } = await openRoute();
    record.mockResolvedValue({ found: true, recorded: true, logId: "log-1" });

    const response = await GET(request(`/o/${VALID}.gif`), ctx(`${VALID}.gif`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from(TRANSPARENT_GIF));
    expect([...body.slice(0, 6)]).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  });

  it("records the token without its .gif suffix, truncated user agent included", async () => {
    const { GET } = await openRoute();
    record.mockResolvedValue({ found: false, recorded: false });
    await GET(request(`/o/${VALID}.gif`, "a".repeat(500)), ctx(`${VALID}.gif`));

    expect(record).toHaveBeenCalledWith("open", VALID, expect.stringContaining("a"));
    expect(record.mock.calls[0]![2]).toHaveLength(300);
  });

  it("answers the same gif for a malformed token and never queries the database", async () => {
    const { GET } = await openRoute();
    for (const bad of ["short.gif", "has spaces.gif", "%2e%2e.gif", ".gif"]) {
      const response = await GET(request(`/o/${bad}`), ctx(bad));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/gif");
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("still answers a gif when the database is down — a 500 would show a broken image", async () => {
    const { GET } = await openRoute();
    record.mockRejectedValue(new Error("connect() failed"));

    const response = await GET(request(`/o/${VALID}.gif`), ctx(`${VALID}.gif`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
  });

  it("treats HEAD as a prefetch, not as an open", async () => {
    const { HEAD } = await openRoute();
    const response = await HEAD(request(`/o/${VALID}.gif`), ctx(`${VALID}.gif`));

    expect(record).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    // A HEAD must carry exactly the GET headers and no body.
    for (const header of GIF_HEADERS) expect(response.headers.has(header)).toBe(true);
    expect(await response.text()).toBe("");
  });
});

describe("GET /c/<token>", () => {
  const destination = "https://acme.example.com/portfolio";

  it("records the click and redirects to the destination", async () => {
    const { GET } = await clickRoute();
    linkByToken.mockResolvedValue({ id: "l1", destination_url: destination, label: "Portfolio" });
    record.mockResolvedValue({ found: true, recorded: true });

    const response = await GET(request(`/c/${VALID}`), ctx(VALID));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(destination);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(record).toHaveBeenCalledWith("click", VALID, expect.any(String));
  });

  it("redirects even when the event was capped or the database threw", async () => {
    const { GET } = await clickRoute();
    linkByToken.mockResolvedValue({ id: "l1", destination_url: destination, label: "Portfolio" });

    record.mockResolvedValue({ found: true, recorded: false, capped: true });
    expect((await GET(request(`/c/${VALID}`), ctx(VALID))).status).toBe(302);

    record.mockRejectedValue(new Error("schema cache miss"));
    const response = await GET(request(`/c/${VALID}`), ctx(VALID));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(destination);
  });

  it("never redirects to a destination that fails the guard at click time", async () => {
    const { GET } = await clickRoute();
    for (const bad of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3000/admin",
      "javascript:alert(1)",
      "http://[::1]/",
    ]) {
      linkByToken.mockResolvedValue({ id: "l1", destination_url: bad, label: "x" });
      record.mockClear();
      const response = await GET(request(`/c/${VALID}`), ctx(VALID));
      expect(response.status, bad).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("404s an unknown token instead of guessing a destination", async () => {
    const { GET } = await clickRoute();
    linkByToken.mockResolvedValue(null);
    const response = await GET(request(`/c/${VALID}`), ctx(VALID));
    expect(response.status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });

  it("does not record a click for a malformed token", async () => {
    const { GET } = await clickRoute();
    const response = await GET(request(`/c/nope`), ctx("nope"));
    expect(response.status).toBe(404);
    expect(linkByToken).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("does not record a HEAD prefetch but still redirects", async () => {
    const { HEAD } = await clickRoute();
    linkByToken.mockResolvedValue({ id: "l1", destination_url: destination, label: "Portfolio" });
    const response = await HEAD(request(`/c/${VALID}`), ctx(VALID));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(destination);
    expect(record).not.toHaveBeenCalled();
  });
});

describe("public surface (middleware)", () => {
  /**
   * `REQUIRE_SESSION` is false today, so a redirect would never fire. When it is
   * flipped, these paths are the difference between tracking working and every
   * recipient being bounced to a login page they cannot reach from an email
   * client — so the invariant is asserted before it is load-bearing.
   */
  it.each(["/o/Ab3dE5fG7hI9jK1lM3nO5pQ7rS9tU1v.gif", "/c/Ab3dE5fG7hI9jK1lM3nO5pQ7rS9tU1v", "/api/health", "/api/email/send"])(
    "%s stays reachable without a session",
    (path) => {
      expect(isPublic(path)).toBe(true);
    },
  );

  it.each(["/emails", "/leads", "/api/tracking/stats", "/api/maintenance/purge", "/settings/tracking"])(
    "%s is gated once auth is switched on",
    (path) => {
      expect(isPublic(path)).toBe(false);
    },
  );

  it("does not treat a prefix collision as public", async () => {
    // "/o" must not open "/oauth", and "/c" must not open "/contacts".
    expect(isPublic("/oauth")).toBe(false);
    expect(isPublic("/contacts")).toBe(false);
    expect(isPublic("/options")).toBe(false);
  });
});
