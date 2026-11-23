import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { generateEmailSchema } from "@/lib/validation/outreach";
import { leadsRepo } from "@/server/db/leads.repo";
import { generateEmailDraft } from "@/server/services/proposal.service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
 * STEP 2 — POST /api/leads/:id/generate-email
 * Writes the outreach email from the **reviewed** PPD (own editable prompt) and
 * opens the draft. The PDF is still not produced; `POST /api/drafts/:id/send`
 * compiles and attaches it.
 *
 * Body (all optional):
 *   { "proposalId": "uuid" }   default: newest proposal on the lead
 *   { "toEmail": "a@b.com" }   custom recipient (not limited to payload emails)
 *   { "cc": ["a@b.com"] }
 *   { "senderAccountId": "uuid" | null }
 *   { "createDraft": false }   only write subject/body onto the proposal
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const input = parseOrThrow(generateEmailSchema, await readJsonOrEmpty(request));

  const proposals = await leadsRepo.proposals(id);
  const proposal = input.proposalId
    ? proposals.find((p) => p.id === input.proposalId)
    : (proposals.find((p) => p.ppd != null) ?? proposals[0]);

  if (!proposal) {
    throw ApiError.notFound(
      "This lead has no PPD yet — POST /api/leads/:id/generate first, review it, then write the email",
    );
  }

  const result = await generateEmailDraft({
    proposalId: proposal.id,
    contactId: input.contactId,
    toEmail: input.toEmail,
    cc: input.cc,
    senderAccountId: input.senderAccountId,
    createDraft: input.createDraft,
    model: input.model,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  });

  return created({
    proposal: result.proposal,
    email: result.email,
    draft: result.draft,
    draftError: result.draftError,
    recipient: result.recipient,
    usage: result.usage,
    costUsd: result.costUsd,
    warnings: result.warnings,
    pdfStatus: result.proposal.pdf_status,
    prompt: result.prompt,
    next: result.draft
      ? `POST /api/drafts/${result.draft.id}/send — this renders the PDF from the reviewed PPD and attaches it`
      : null,
  });
});
