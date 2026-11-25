import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { generateEmailSchema } from "@/lib/validation/outreach";
import { leadsRepo } from "@/server/db/leads.repo";
import { prepareChatGptJob } from "@/server/services/chatgpt.service";
import { requireParamId } from "@/server/http/id";

export const dynamic = "force-dynamic";
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
 * Prepares the outreach email prompt for the reviewed PPD. The ChatGPT session
 * writes it; finalising opens the draft from the server side.
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  const auth = await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  const input = parseOrThrow(generateEmailSchema, await readJsonOrEmpty(request));

  const proposals = await leadsRepo.proposals(id);
  const proposal = input.proposalId
    ? proposals.find((p) => p.id === input.proposalId)
    : (proposals.find((p) => p.ppd != null) ?? proposals[0]);
  if (!proposal) {
    throw ApiError.notFound(
      "This lead has no PPD yet — generate the document, review it, then write the email",
    );
  }

  const result = await prepareChatGptJob({
    leadId: id,
    kind: "email_draft",
    proposalId: proposal.id,
    contactId: input.contactId,
    toEmail: input.toEmail,
    cc: input.cc,
    senderAccountId: input.senderAccountId,
    createDraft: input.createDraft,
    createdBy: auth.kind === "user" ? auth.id : auth.kind === "service" ? auth.label : "anonymous",
  });

  if (result.reused) return ok({ job: null, reused: true, proposal: result.proposal });
  return created({
    job: result.dto,
    reused: false,
    next: `Run the prompt in ChatGPT, then POST /api/chatgpt/jobs/${result.dto.id}/complete with the answer`,
  });
});
