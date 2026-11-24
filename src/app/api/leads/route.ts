import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok, paged, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import {
  deleteLeadsSchema,
  ingestOptionsSchema,
  listLeadsQuerySchema,
} from "@/lib/validation/outreach";
import { parseLeadPayloads } from "@/lib/validation/lead";
import { leadsRepo } from "@/server/db/leads.repo";
import { ingestLeadPayload, ingestMany } from "@/server/services/lead-ingest.service";
import { removeLeads } from "@/server/services/lead-delete.service";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
/** Generation is not part of ingest any more, but ?auto=true still runs it here. */
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
 * Receive an Upwork research payload (single object or array) and store it.
 * Nothing is generated: the document is written when a person clicks Generate
 * on the lead page, or posts to `/api/leads/:id/generate` themselves.
 *
 * A payload whose `job_id` or job link already exists answers
 * `duplicate: { leadId, matchedBy }` with `created: false` and changes nothing,
 * so a scraper can re-post freely.
 *
 * Query flags:
 *   auto=true       generate on arrival (the old behaviour; default is manual)
 *   dry=true        same as auto=false
 *   regenerate=true force a new proposal version
 *   refresh=true    overwrite the matched lead instead of reporting a duplicate
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
    refresh: options.refresh === "true",
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
    stored: results.filter((r) => r.created).length,
    duplicates: results.filter((r) => r.duplicate).length,
    errors,
    leads: results.map((r) => ({
      id: r.lead.id,
      status: r.lead.status,
      job_title: r.lead.job_title,
      job_id: r.lead.job_id,
      emails_found: r.emailContacts.length,
      drafts: r.drafts.length,
      created: r.created,
      ...(r.duplicate ? { duplicate: r.duplicate } : {}),
      generation: r.generation,
    })),
  });
});

/**
 * API #3 — DELETE /api/leads
 * Permanently remove jobs: the lead rows plus everything that hangs off them
 * (lead_contacts, proposals + their email copy, email_drafts) and the rendered
 * PDFs in the private `proposals` storage bucket.
 *
 * Body: { "ids": ["<lead uuid>", …] }  — 1 to 100 ids, exact ids only.
 *
 * Kept on purpose: `public.contacts` rows you promoted to the CRM, and
 * `public.email_logs` — the delivery audit trail loses its lead/draft/proposal
 * pointers but the send record stays provable.
 *
 * Response is a report, because "it deleted" is not enough for an irreversible
 * call: which ids went, which were already gone, which failed, and how many
 * documents, drafts and PDF files each one took with it.
 */
export const DELETE = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const { ids } = parseOrThrow(deleteLeadsSchema, await readBody(request));

  logger.warn("lead_delete_requested", { count: ids.length });
  const report = await removeLeads(ids);

  return ok({
    ...report,
    kept: {
      crm_contacts: "public.contacts rows are not touched",
      email_logs: "sent-message audit rows survive with their lead pointers nulled",
    },
  });
});
