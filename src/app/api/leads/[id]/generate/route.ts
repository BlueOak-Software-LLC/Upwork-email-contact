import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { generateProposalSchema } from "@/lib/validation/outreach";
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
 * STEP 1 — POST /api/leads/:id/generate
 * Prepares the PPD prompt and returns a ChatGPT-session job. The signed-in
 * browser tab writes the answer; `POST /api/chatgpt/jobs/:id/complete` stores it.
 * No OpenAI/ChatGPT API key is involved.
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  const auth = await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  const input = parseOrThrow(generateProposalSchema, await readJsonOrEmpty(request));

  const result = await prepareChatGptJob({
    leadId: id,
    kind: "ppd_document",
    contactId: input.contactId,
    toEmail: input.toEmail,
    regenerate: input.regenerate,
    createdBy: auth.kind === "user" ? auth.id : auth.kind === "service" ? auth.label : "anonymous",
  });

  if (result.reused) return ok({ job: null, reused: true, proposal: result.proposal });
  return created({
    job: result.dto,
    reused: false,
    next: `Run the prompt in ChatGPT, then POST /api/chatgpt/jobs/${result.dto.id}/complete with the answer`,
  });
});

/** GET /api/leads/:id/generate — proposal history for the lead. */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  return ok({ proposals: await leadsRepo.proposals(id) });
});
