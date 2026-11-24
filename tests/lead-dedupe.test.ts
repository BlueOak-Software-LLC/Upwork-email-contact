import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Duplicate detection on ingest.
 *
 * The user's report was specific: the same job arrived twice, once with
 * `job_id` and once with only the link, and both were stored. These tests hold
 * the two lookups apart — the repository's match, and the service's decision to
 * leave the existing row alone.
 */

const rows: Array<Record<string, unknown>> = [];
const calls: string[] = [];

/**
 * A PostgREST-shaped in-memory stand-in.
 *
 * Only the handful of methods `leadsRepo` actually chains are implemented, and
 * every call is recorded so a test can prove which column was queried — the
 * difference between "matched on job_id" and "matched on job_url" is the whole
 * point of this suite.
 */
function fakeClient() {
  let pending: { column: string; values: unknown[] } | null = null;
  let target: { column: string; value: unknown } | null = null;
  let pendingUpdate: Record<string, unknown> | null = null;
  let matcher: ((row: Record<string, unknown>) => boolean) | null = null;

  const api: Record<string, unknown> = {};
  api.select = () => api;
  api.order = () => api;
  api.limit = () => api;
  api.in = (column: string, values: unknown[]) => {
    pending = { column, values };
    calls.push(`in:${column}`);
    return api;
  };
  api.eq = (column: string, value: unknown) => {
    target = { column, value };
    return api;
  };
  api.maybeSingle = () => {
    const filter = pending;
    pending = null;
    if (!filter) return Promise.resolve({ data: null, error: null });
    const hit = rows.find((row) =>
      matcher ? matcher(row) : filter.values.includes(String(row[filter.column] ?? "")),
    );
    matcher = null;
    return Promise.resolve({ data: hit ?? null, error: null });
  };
  api.single = () => {
    if (pendingUpdate) {
      const found = target ? rows.find((row) => row[target!.column] === target!.value) : undefined;
      const payload = pendingUpdate;
      pendingUpdate = null;
      target = null;
      calls.push("update:leads");
      if (found) Object.assign(found, payload);
      return Promise.resolve(found ? { data: found, error: null } : { data: null, error: { message: "no row" } });
    }
    if (target) {
      const found = rows.find((row) => row[target!.column] === target!.value);
      target = null;
      return Promise.resolve(found ? { data: found, error: null } : { data: null, error: { message: "no row" } });
    }
    return Promise.resolve({ data: rows[rows.length - 1] ?? null, error: null });
  };
  api.insert = (payload: Record<string, unknown>) => {
    calls.push("insert:leads");
    rows.push({
      id: `lead-${rows.length + 1}`,
      status: "received",
      received_at: new Date().toISOString(),
      ...payload,
    });
    return api;
  };
  // `.update(payload).eq("id", x)` — the target arrives after the payload, so
  // the write is deferred to `.single()` the way PostgREST applies it.
  api.update = (payload: Record<string, unknown>) => {
    pendingUpdate = payload;
    return api;
  };
  api.delete = () => {
    calls.push("delete:lead_contacts");
    return api;
  };
  api.or = () => api;
  api.ilike = (column: string, pattern: string) => {
    calls.push(`ilike:${column}`);
    // Substring match against the same rows, mirroring `%id%`.
    const needle = pattern.replace(/%/g, "");
    pending = { column, values: [needle] };
    matcher = (row) => String(row[column] ?? "").toLowerCase().includes(needle.toLowerCase());
    return api;
  };
  api.upsert = () => Promise.resolve({ data: null, error: null });

  return { from: () => api };
}

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => fakeClient(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BASE_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-long-enough-for-tests",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-long-enough-for-tests",
  NEXT_PUBLIC_APP_URL: "https://track.example.com",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.example.com",
  PUTER_AUTH_TOKEN: "a-puter-token-value",
};

function payloadFor(overrides: Record<string, unknown> = {}) {
  return {
    job_information: {
      job_title: "3D animator for a warehouse robot",
      job_description: "12 short clips of an autonomous mobile robot picking cases.",
      job_location: "Remote",
      ...overrides,
    },
    client_information: { client_name: "Forkline Tech", company_name: "Forkline Tech" },
    verified_contacts: [{ name: "Dana", "email ": "dana@forkline.io" }],
  };
}

beforeEach(() => {
  rows.length = 0;
  calls.length = 0;
  vi.resetModules();
  for (const [key, value] of Object.entries(BASE_ENV)) process.env[key] = value;
});

async function ingest() {
  return (await import("@/server/services/lead-ingest.service")).ingestLeadPayload;
}

async function repo() {
  return (await import("@/server/db/leads.repo")).leadsRepo;
}

describe("matching by either identifier", () => {
  it("recognises a stored job_id in a link that carries only the URL", async () => {
    const lead = await repo();
    const first = payloadFor({ job_id: "021234567890abcdef" });
    const stored = await lead.upsert((await normalize())(first));
    expect(stored.created).toBe(true);

    // Same post, scraped differently: no job_id field, link with tracking noise.
    const second = payloadFor({
      job_id: undefined,
      job_url: "https://www.upwork.com/jobs/~021234567890abcdef?src=saved",
    });
    const again = await lead.upsert((await normalize())(second));

    expect(again.created).toBe(false);
    expect(again.matchedBy).toBe("job_id");
    expect(again.row.id).toBe(stored.row.id);
    expect(rows).toHaveLength(1);
  });

  it("recognises a stored link when the payload arrives with an id", async () => {
    const lead = await repo();
    await lead.upsert(
      (await normalize())(
        payloadFor({ job_url: "https://www.upwork.com/jobs/~02ABCDEF01234567" }),
      ),
    );

    const second = await lead.upsert(
      (await normalize())(payloadFor({ job_id: "abcdef01234567", job_url: undefined })),
    );
    expect(second.created).toBe(false);
    expect(second.matchedBy).toBe("job_id");
  });

  it("matches the same link written with different tracking parameters", async () => {
    const lead = await repo();
    await lead.upsert(
      (await normalize())(
        payloadFor({ job_url: "https://www.upwork.com/jobs/~02999?src=share&utm_medium=x" }),
      ),
    );
    const second = await lead.upsert(
      (await normalize())(payloadFor({ job_url: "https://upwork.com/jobs/~02999/" })),
    );
    expect(second.created).toBe(false);
    // Neither payload carried job_id, so the link is what matched.
    expect(second.matchedBy).toBe("job_url");
  });

  it("matches a bare link with no id in it by URL alone", async () => {
    const lead = await repo();
    await lead.upsert(
      (await normalize())(payloadFor({ job_url: "https://boards.example.com/role/need-a-3d-artist" })),
    );
    const second = await lead.upsert(
      (await normalize())(
        payloadFor({ job_url: "https://www.boards.example.com/role/need-a-3d-artist?ref=tw" }),
      ),
    );
    expect(second.created).toBe(false);
    expect(second.matchedBy).toBe("job_url");
  });

  it("stores a genuinely different job", async () => {
    const lead = await repo();
    await lead.upsert((await normalize())(payloadFor({ job_id: "aaa111" })));
    const second = await lead.upsert((await normalize())(payloadFor({ job_id: "bbb222" })));
    expect(second.created).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("overwrites only when refresh is asked for", async () => {
    const lead = await repo();
    const stored = await lead.upsert((await normalize())(payloadFor({ job_id: "ccc333" })));

    const refreshed = await lead.upsert(
      (await normalize())(payloadFor({ job_id: "ccc333", job_title: "Updated title" })),
      { refresh: true },
    );
    expect(refreshed.created).toBe(false);
    expect(refreshed.matchedBy).toBe("job_id");
    expect(calls).toContain("update:leads");
    expect(rows.find((r) => r.id === stored.row.id)?.job_title).toBe("Updated title");

    const untouched = calls.filter((c) => c === "update:leads").length;
    await lead.upsert((await normalize())(payloadFor({ job_id: "ccc333" })));
    expect(calls.filter((c) => c === "update:leads").length).toBe(untouched);
  });
});

describe("ingest behaviour on a duplicate", () => {
  it("adds nothing, generates nothing, and says how to force it", async () => {
    const run = await ingest();
    const first = await run(payloadFor({ job_id: "ddd444" }));
    expect(first.created).toBe(true);

    const second = await run(payloadFor({ job_id: "ddd444" }));
    expect(second.created).toBe(false);
    expect(second.duplicate).toEqual({ leadId: first.lead.id, matchedBy: "job_id" });
    expect(second.generation).toMatchObject({ attempted: 0, skipped: true, reason: "duplicate" });
    expect(second.warnings.join(" ")).toMatch(/refresh.*true/s);
    expect(rows).toHaveLength(1);
  });

  it("does not touch the stored contacts on a duplicate", async () => {
    const lead = await repo();
    const stored = await lead.upsert((await normalize())(payloadFor({ job_id: "eee555" })));
    rows.find((r) => r.id === stored.row.id)!.job_title = "Title the reviewer corrected";

    const run = await ingest();
    await run(payloadFor({ job_id: "eee555", job_title: "Original scrape title" }));

    expect(rows.find((r) => r.id === stored.row.id)!.job_title).toBe(
      "Title the reviewer corrected",
    );
  });
});

describe("ingest is manual by default", () => {
  it("stores the lead and spends no tokens", async () => {
    const generate = vi.fn();
    vi.doMock("@/server/services/proposal.service", () => ({ generatePpdDocument: generate }));

    const run = await ingest();
    const result = await run(payloadFor({ job_id: "fff666" }));

    expect(result.created).toBe(true);
    expect(result.generation.skipped).toBe(true);
    expect(result.generation.reason).toMatch(/Generate PPD/);
    expect(generate).not.toHaveBeenCalled();
    // Status reflects what is known, not what was generated.
    expect(["received", "enriched"]).toContain(result.lead.status);
  });

  it("generates on arrival when the caller asks for it", async () => {
    const proposal = { id: "p1", lead_id: "x", lead_contact_id: null, version: 1 };
    vi.doMock("@/server/services/proposal.service", () => ({
      generatePpdDocument: vi.fn().mockResolvedValue({ proposal, warnings: [], ppd: {} }),
    }));

    const run = await ingest();
    const result = await run(payloadFor({ job_id: "ggg777" }), { autoEnrich: true });
    expect(result.generation.attempted).toBeGreaterThan(0);
  });
});

/** `normalizeLeadPayload` lives in validation; the repo takes its output. */
async function normalize() {
  const { normalizeLeadPayload } = await import("@/lib/validation/lead");
  return (payload: unknown) => normalizeLeadPayload(payload);
}
