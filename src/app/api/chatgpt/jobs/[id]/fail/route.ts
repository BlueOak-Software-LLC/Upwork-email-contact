import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { requireParamId } from "@/server/http/id";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { failChatGptJobSchema } from "@/lib/validation/outreach";
import { chatgptJobsRepo } from "@/server/db/chatgpt-jobs.repo";
import { toChatGptJobDto } from "@/server/services/chatgpt.service";

export const dynamic = "force-dynamic";
type Ctx = { id: string };

async function readJson(request: NextRequest) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/** The ChatGPT tab could not finish (signed out, blocked, timeout). */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "job id");
  const input = parseOrThrow(failChatGptJobSchema, await readJson(request));
  const row = await chatgptJobsRepo.fail(id, input.error);
  return ok({ job: toChatGptJobDto(row) });
});
