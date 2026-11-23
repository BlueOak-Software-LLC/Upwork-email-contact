import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { generateProposalSchema } from "@/lib/validation/outreach";
import { leadsRepo } from "@/server/db/leads.repo";
import { generatePpdDocument, resolveRecipientContact } from "@/server/services/proposal.service";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // Groq (with retries)

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

async function readJsonOrEmpty(request: NextRequest) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * STEP 1 — POST /api/leads/:id/generate
 * Groq writes **only the PPD document**. No email copy, no draft and no PDF:
 * those wait until a human has reviewed the document (`generate-email`, `send`).
 *
 * Body (all optional):
 *   { "contactId": "uuid" }        write for a specific contact on the lead
 *   { "toEmail": "a@b.com" }       write for a custom address (stored as a
 *                                  manual contact so the trail explains itself)
 *   { "regenerate": true }         force a new version (default true)
 *   { "model": "…", "reasoningEffort": "low|medium|high" }
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const input = parseOrThrow(generateProposalSchema, await readJsonOrEmpty(request));

  const lead = await leadsRepo.byId(id);
  const { contact, source } = await resolveRecipientContact(id, {
    contactId: input.contactId,
    toEmail: input.toEmail,
    // A post with a description but no address still gets a document; the email
    // step is where an address becomes mandatory.
    requireRecipient: false,
  });

  const result = await generatePpdDocument({
    lead,
    contact,
    regenerate: input.regenerate,
    model: input.model,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  });

  return created({
    proposal: result.proposal,
    ppd: result.ppd,
    documentWords: result.documentWords,
    usage: result.usage,
    costUsd: result.costUsd,
    warnings: result.warnings,
    recipient: contact
      ? {
          contactId: contact.id,
          email: contact.normalized_value ?? contact.contact_value,
          source,
        }
      : null,
    // Written from the post itself when no address was supplied.
    recipientNote:
      contact === null
        ? "no recipient yet — the document is addressed to the hiring team; give the email step a toEmail"
        : null,
    // The document is intentionally not rendered yet.
    pdfStatus: result.proposal.pdf_status,
    prompt: result.prompt,
    next: `Review or edit the PPD, then POST /api/leads/${id}/generate-email`,
  });
});

/** GET /api/leads/:id/generate — proposal history for the lead. */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  return ok({ proposals: await leadsRepo.proposals(id) });
});
