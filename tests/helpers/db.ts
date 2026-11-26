import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A real PostgreSQL engine running the actual migration files, so the tracking
 * rules that live in SQL (atomic counters, the 60-second open dedupe, the
 * per-day caps, the service-role guard) are tested rather than assumed.
 *
 * Same approach as BlueOak Track's `tests/database.test.ts`. PGlite has no
 * Supabase `auth`/`storage` schemas, so those two seams are stubbed exactly as
 * far as the migrations need: `auth.role()` reads the same setting PostgREST
 * sets from the JWT, and the storage-bucket insert is a no-op for these tests.
 *
 * This never touches your Supabase project and sends no email.
 */

const MIGRATIONS = [
  "0001_init.sql",
  "0002_leads_senders_proposals.sql",
  "0003_prompt_templates_review_flow.sql",
  "0004_job_description_ingestion.sql",
  "0005_email_tracking.sql",
  "0007_lead_list_view.sql",
  "0008_chatgpt_session_followups.sql",
  "0009_chatgpt_completion_claim.sql",
  "0010_sender_profile.sql",
  "0011_retire_ai_settings.sql",
  "0012_sender_company_name.sql",
];

const PREAMBLE = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create function auth.role() returns text language sql as
    $$ select current_setting('request.jwt.claim.role', true) $$;
  create function auth.jwt() returns jsonb language sql as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth to anon, authenticated, service_role;
`;

function apply(sql: string) {
  return sql
    // PGlite ships gen_random_uuid in core; the Supabase extension is not needed.
    .replace(/create extension if not exists "pgcrypto";/g, "")
    // No Supabase Storage schema in a test engine.
    .replace(
      /insert into storage\.buckets[\s\S]*?on conflict \(id\) do nothing;/g,
      "-- storage bucket skipped in tests",
    );
}

export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(PREAMBLE);
  for (const file of MIGRATIONS) {
    const sql = readFileSync(
      fileURLToPath(new URL(`../../supabase/migrations/${file}`, import.meta.url)),
      "utf8",
    );
    await db.exec(apply(sql));
  }
  return db;
}

/** Run a statement as the service role, the only caller the RPCs accept. */
export async function asService<T>(db: PGlite, sql: string, params: unknown[] = []) {
  await db.exec("select set_config('request.jwt.claim.role','service_role', false)");
  return db.query<T>(sql, params as never[]);
}

/** Run a statement as `anon` — used to prove the public RPC guard holds. */
export async function asAnon(db: PGlite, sql: string, params: unknown[] = []) {
  await db.exec("select set_config('request.jwt.claim.role','anon', false)");
  return db.query(sql, params as never[]);
}
