import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { generateProposalSchema } from "@/lib/validation/outreach";
import { leadsRepo } from "@/server/db/leads.repo";
import { generateProposal } from "@/server/services/proposal.service";
import { createDraftForProposal } from "@/server/services/draft.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Groq + optional PDF render

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
 * POST /api/leads/:id/generate
 * Run Groq for one email contact of this lead: PPD + subject/content →
 * `proposals` row (+ PDF when configured) → `email_drafts` row.
 *
 * Body (all optional): { "contactId": "uuid", "regenerate": true,
 *                        "createDraft": true, "senderAccountId": "uuid" }
 * Without contactId we use the primary email (verified > potential, HIGH first).
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const input = parseOrThrow(generateProposalSchema, await readJsonOrEmpty(request));

  const detail = await leadsRepo.detail(id);
  const candidates = detail.contacts.filter((c) => c.is_email);
  if (candidates.length === 0) {
    throw ApiError.badRequest(
      "No email contact on this lead — verified_contacts and potential_contacts had no usable address",
    );
  }

  const contact = input.contactId
    ? candidates.find((c) => c.id === input.contactId)
    : (candidates.find((c) => c.is_primary) ?? candidates[0]);

  if (!contact) throw ApiError.notFound(`Contact ${input.contactId} is not an email of this lead`);

  const { proposal, warnings } = await generateProposal({
    lead: detail.lead,
    contact,
    regenerate: input.regenerate,
  });

  let draft = null;
  let draftError: string | null = null;
  if (input.createDraft) {
    try {
      draft = await createDraftForProposal({
        proposalId: proposal.id,
        senderAccountId: input.senderAccountId,
      });
    } catch (error) {
      // The proposal is saved; only the draft step failed (usually no sender account).
      draftError = error instanceof Error ? error.message : String(error);
    }
  }

  return created({
    proposal,
    draft,
    draftError,
    warnings,
    contact: { id: contact.id, email: contact.normalized_value ?? contact.contact_value },
  });
});

/** GET /api/leads/:id/generate — current proposals for the lead. */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  return ok({ proposals: await leadsRepo.proposals(id) });
});
