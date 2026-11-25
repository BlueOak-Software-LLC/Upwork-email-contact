import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { created, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { createChatGptJobSchema } from "@/lib/validation/outreach";
import { chatgptJobsRepo } from "@/server/db/chatgpt-jobs.repo";
import { prepareChatGptJob, toChatGptJobDto } from "@/server/services/chatgpt.service";
import { requireParamId } from "@/server/http/id";

export const dynamic = "force-dynamic";

async function readJson(request: NextRequest) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * POST /api/chatgpt/jobs — prepare a prompt for the signed-in ChatGPT tab.
 *
 * No model is called here. The body is the same request as before, except the
 * `model`/`reasoningEffort` knobs are gone: the browser session decides those.
 */
export const POST = withApi(async (request) => {
  const auth = await requireApiKey(request);
  const input = parseOrThrow(createChatGptJobSchema, await readJson(request));
  const createdBy =
    auth.kind === "user" ? auth.id : auth.kind === "service" ? auth.label : "anonymous";

  const result = await prepareChatGptJob({
    ...input,
    createdBy,
  });

  if (result.reused) {
    return ok({
      job: null,
      reused: true,
      proposal: result.proposal,
      message: "An existing PPD for this recipient was reused.",
    });
  }
  return created({ job: result.dto, reused: false });
});

/** GET /api/chatgpt/jobs?leadId=… — the drawer transcript for one lead. */
export const GET = withApi(async (request) => {
  await requireApiKey(request);
  const leadId = requireParamId(new URL(request.url).searchParams.get("leadId") ?? "", "lead id");
  const rows = await chatgptJobsRepo.listForLead(leadId);
  return ok({ jobs: rows.map(toChatGptJobDto) });
});
