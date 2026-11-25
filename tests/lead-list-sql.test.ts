import { type PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, createTestDb } from "./helpers/db";

/**
 * 0007 is the difference between "filter after fetching 25 rows" and a real
 * server-side pipeline filter. These tests run the migration in PGlite so the
 * correlated counts, the grant, and the index are exercised as deployed SQL,
 * not inferred from a string match.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

async function lead(title: string, status = "received") {
  const { rows } = await asService<{ id: string }>(
    db,
    `insert into public.leads (dedupe_key, job_title, status, raw_payload)
     values ($1, $2, $3::public.lead_status, '{}'::jsonb) returning id`,
    [title, title, status],
  );
  return rows[0]!.id;
}

async function contact(leadId: string, value: string) {
  await asService(
    db,
    `insert into public.lead_contacts (lead_id, list_type, channel, contact_value, is_email)
     values ($1, 'verified', 'email', $2, true)`,
    [leadId, value],
  );
}

async function proposal(leadId: string, subject: string, version = 1) {
  await asService(
    db,
    `insert into public.proposals (lead_id, version, ppd, email_subject, email_content)
     values ($1, $2, '{}'::jsonb, $3, 'body')`,
    [leadId, version, subject],
  );
}

async function draft(leadId: string, subject: string) {
  await asService(
    db,
    `insert into public.email_drafts (lead_id, to_email, subject, body_text)
     values ($1, 'client@example.com', $2, 'body')`,
    [leadId, subject],
  );
}

async function row(title: string) {
  const { rows } = await asService<{
    contact_count: number;
    proposal_count: number;
    draft_count: number;
  }>(
    db,
    `select contact_count, proposal_count, draft_count
       from public.lead_list where job_title = $1`,
    [title],
  );
  return rows[0]!;
}

describe("0007 lead_list", () => {
  it("counts contacts, proposals and drafts without multiplying rows", async () => {
    const both = await lead("Both ready");
    await contact(both, "one@example.com");
    await contact(both, "two@example.com");
    await proposal(both, "Proposal 1", 1);
    await proposal(both, "Proposal 2", 2);
    await draft(both, "Draft 1");

    const docOnly = await lead("Doc only");
    await proposal(docOnly, "Proposal 1");

    const draftOnly = await lead("Draft only");
    await draft(draftOnly, "Draft 1");

    expect(await row("Both ready")).toEqual({
      contact_count: 2,
      proposal_count: 2,
      draft_count: 1,
    });
    expect(await row("Doc only")).toEqual({
      contact_count: 0,
      proposal_count: 1,
      draft_count: 0,
    });
    expect(await row("Draft only")).toEqual({
      contact_count: 0,
      proposal_count: 0,
      draft_count: 1,
    });
  });

  it("keeps the pipeline predicates and the count query in one statement", async () => {
    const { rows } = await asService<{ total: number }>(
      db,
      `select count(*)::int as total from public.lead_list
        where proposal_count > 0 and draft_count > 0`,
    );
    expect(rows[0]!.total).toBe(1);

    const { rows: docs } = await asService<{ total: number }>(
      db,
      `select count(*)::int as total from public.lead_list
        where proposal_count > 0 and draft_count = 0`,
    );
    expect(docs[0]!.total).toBe(1);
  });

  it("is readable by the service role and closed to anon", async () => {
    const { rows } = await asService<{ n: number }>(
      db,
      "select count(*)::int as n from public.lead_list",
    );
    expect(rows[0]!.n).toBeGreaterThan(0);

    // asAnon only sets the JWT claim that auth.role() reads; privileges need a
    // real role switch, which is what PostgREST does for an anon request.
    await db.exec("set role anon");
    try {
      await expect(
        db.query("select count(*)::int as n from public.lead_list"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  });
});
