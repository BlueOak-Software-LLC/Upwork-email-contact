import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, paged, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import {
  ingestOptionsSchema,
  listLeadsQuerySchema,
} from "@/lib/validation/outreach";
import { parseLeadPayloads } from "@/lib/validation/lead";
import { leadsRepo } from "@/server/db/leads.repo";
import { ingestLeadPayload, ingestMany } from "@/server/services/lead-ingest.service";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
/** Groq + SMTP per lead: give the function room on Vercel (Pro/fluid: 300). */
export const maxDuration = 120;

async function readBody(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * API #1 — GET /api/leads
 * The ingested research payloads as JSON (job + client + confidence + counts).
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const query = parseOrThrow(
    listLeadsQuerySchema,
    Object.fromEntries(request.nextUrl.searchParams),
  );
  const result = await leadsRepo.list(query);
  return paged(result, withRevalidation(10));
});

/**
 * API #2 — POST /api/leads
 * Receive an Upwork research payload (single object or array), store every
 * field, then — when the payload contains an email in `verified_contacts` or
 * `potential_contacts` — ask Groq for the PPD + email subject/content and open
 * an SMTP draft.
 *
 * Query flags:
 *   auto=false      store only, no generation
 *   dry=true        same as auto=false
 *   regenerate=true force a new proposal version
 *   senderAccountId=<uuid> use a specific sending mailbox for the drafts
 */
export const POST = withApi(async (request: NextRequest) => {
  await requireApiKey(request);

  const options = parseOrThrow(
    ingestOptionsSchema,
    Object.fromEntries(request.nextUrl.searchParams),
  );

  const body = await readBody(request);
  let payloads: unknown[];
  try {
    payloads = parseLeadPayloads(body);
  } catch (error) {
    throw ApiError.badRequest(
      error instanceof Error ? error.message : "Unreadable payload",
    );
  }

  const ingestOptions = {
    autoEnrich: options.auto ? options.auto === "true" : undefined,
    dryRun: options.dry === "true",
    regenerate: options.regenerate === "true",
    senderAccountId: options.senderAccountId,
  };

  logger.info("lead_ingest_requested", {
    count: payloads.length,
    ...ingestOptions,
    autoEnrich: ingestOptions.autoEnrich ?? "env-default",
  });

  // A batch is processed inline: every payload is stored, and generation runs
  // per lead. One failure never aborts the rest — see `errors[]`.
  if (payloads.length === 1) {
    const result = await ingestLeadPayload(payloads[0], ingestOptions);
    return created({
      ...result,
      contacts_found: result.contacts.length,
      emails_found: result.emailContacts.length,
    });
  }

  const { results, errors } = await ingestMany(payloads, ingestOptions);
  return created({
    accepted: payloads.length,
    processed: results.length,
    failed: errors.length,
    errors,
    leads: results.map((r) => ({
      id: r.lead.id,
      status: r.lead.status,
      job_title: r.lead.job_title,
      emails_found: r.emailContacts.length,
      drafts: r.drafts.length,
      generation: r.generation,
    })),
  });
});
