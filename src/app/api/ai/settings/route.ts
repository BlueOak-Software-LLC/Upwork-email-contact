import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { resetAiSettingsSchema, saveAiSettingsSchema } from "@/lib/validation/ai";
import { aiSettingsRepo } from "@/server/db/ai-settings.repo";
import { aiSettingsView } from "@/server/services/ai/config";

export const dynamic = "force-dynamic";

/**
 * GET /api/ai/settings — effective providers (never the keys themselves).
 * PUT /api/ai/settings — save a key/model/enabled flag, or clear a key.
 * DELETE /api/ai/settings?provider=puter — forget the row, back to env/default.
 *
 * Every response returns the *recomputed* effective view, so the page can show
 * "configured via database" immediately rather than guessing.
 */
async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  return ok(await aiSettingsView());
});

export const PUT = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const input = parseOrThrow(saveAiSettingsSchema, await readJson(request));

  await aiSettingsRepo.save({
    provider: input.provider,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.clearKey !== undefined ? { clearKey: input.clearKey } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.fallbackModel !== undefined ? { fallbackModel: input.fallbackModel } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });

  return ok(await aiSettingsView());
});

export const DELETE = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const input = parseOrThrow(
    resetAiSettingsSchema,
    Object.fromEntries(request.nextUrl.searchParams),
  );
  await aiSettingsRepo.reset(input.provider);
  return ok(await aiSettingsView());
});
