import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { savePromptSchema } from "@/lib/validation/outreach";
import { listPrompts, resolvePrompt, savePrompt } from "@/server/services/prompts/registry";
import { PROMPT_VARS } from "@/server/services/prompts/proposal.prompt";

export const dynamic = "force-dynamic";

/**
 * GET /api/prompts
 * The two prompt pairs the dashboard shows and edits, each resolved to either
 * the stored row or the code default, plus the `{{variable}}` reference list.
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const prompts = await listPrompts();
  return ok({
    prompts,
    variables: PROMPT_VARS,
    // Which variable names each template actually uses right now — the editor
    // uses this to warn about typos like {{job_descritpion}}.
    used: prompts.map((p) => ({
      key: p.key,
      system: [...new Set([...p.system.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]!.toLowerCase()))],
      user: [...new Set([...p.user.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]!.toLowerCase()))],
    })),
  });
});

/**
 * PUT /api/prompts — save an edited prompt pair.
 * { key, systemText, userTemplate, temperature, maxTokens, reasoningEffort, note }
 * maxTokens/reasoningEffort are retained in the template shape for old rows, but
 * the ChatGPT session ignores them.
 */
export const PUT = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const input = parseOrThrow(savePromptSchema, await request.json());
  const saved = await savePrompt({
    key: input.key,
    label: input.label || (await resolvePrompt(input.key)).label,
    systemText: input.systemText,
    userTemplate: input.userTemplate,
    temperature: input.temperature,
    maxTokens: input.maxTokens ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    note: input.note ?? null,
  });
  return ok({ prompt: saved });
});
