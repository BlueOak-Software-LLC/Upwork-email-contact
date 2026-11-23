import { logger } from "@/lib/logger";

/**
 * Postgres/PostgREST signals that mean "this deployment is behind on migrations".
 *
 * Reads degrade quietly (no `prompt_templates` table ⇒ use the code default).
 * Writes drop only the columns the database does not know yet, retry once and
 * log which migration to run — so an un-migrated deploy still produces
 * documents and drafts rather than 500s.
 */
export const REVIEW_FLOW_MIGRATION = "supabase/migrations/0003_prompt_templates_review_flow.sql";

const MISSING_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "PGRST202", // could not find the table/function in the schema cache
  "PGRST204", // could not find the 'x' column of 'y' in the schema cache
  "PGRST205", // could not find the relationship
]);

type PgError = { code?: string | null; message?: string | null; hint?: string | null };

export function isMissingSchema(error: PgError | null | undefined): boolean {
  if (!error) return false;
  if (error.code && MISSING_CODES.has(error.code)) return true;
  return /could not find the .*column|in the schema cache|does not exist/i.test(error.message ?? "");
}

/**
 * Given a pending insert/update payload and a schema-cache error, return the
 * payload without the identifiers Postgres says it does not have.
 * `Could not find the 'recipient_source' column of 'email_drafts'` → drops
 * `recipient_source` (the table name is not a payload key, so it is ignored).
 */
export function withoutMissingColumns<T extends Record<string, unknown>>(
  payload: T,
  error: PgError,
): { payload: Partial<T>; dropped: string[] } {
  const quoted = [...String(error.message ?? "").matchAll(/'([a-z_][a-z0-9_]*)'/gi)].map((m) => m[1]!);
  const dropped = Object.keys(payload).filter((key) => quoted.includes(key));
  if (!dropped.length) return { payload, dropped: [] };
  const next = { ...payload };
  for (const key of dropped) delete next[key];
  logger.warn("db_columns_missing", { dropped, migration: REVIEW_FLOW_MIGRATION });
  return { payload: next, dropped };
}
