import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError } from "@/server/http/errors";
import { resetPrompt } from "@/server/services/prompts/registry";
import { DEFAULT_PROMPTS, type PromptKey } from "@/server/services/prompts/proposal.prompt";

export const dynamic = "force-dynamic";

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { key: string };

/**
 * POST /api/prompts/:key/reset — drop the stored row so the code default in
 * `prompts/proposal.prompt.ts` applies again.
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { key } = await params;
  if (!(key in DEFAULT_PROMPTS)) {
    throw ApiError.notFound(`Unknown prompt "${key}" — expected ${Object.keys(DEFAULT_PROMPTS).join(" or ")}`);
  }
  return ok({ prompt: await resetPrompt(key as PromptKey), reset: true });
});
