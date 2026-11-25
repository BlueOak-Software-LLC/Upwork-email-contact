import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { requireParamId } from "@/server/http/id";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { completeChatGptJobSchema } from "@/lib/validation/outreach";
import { completeChatGptJob } from "@/server/services/chatgpt.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
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

/**
 * The extension posts the raw answer here. Parsing, sanitising, proposal/draft
 * persistence and all validation happen server-side — the browser never writes
 * a draft directly.
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "job id");
  const input = parseOrThrow(completeChatGptJobSchema, await readJson(request));
  const result = await completeChatGptJob(id, input.responseText);
  return ok(result);
});
