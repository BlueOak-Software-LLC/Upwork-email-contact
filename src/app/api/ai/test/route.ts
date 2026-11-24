import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { z } from "zod";
import { aiStatus } from "@/server/services/ai";
import { probeAi } from "@/server/services/ai/probe";

export const dynamic = "force-dynamic";
/** A probe is a real generation call on a frontier model; give it room. */
export const maxDuration = 120;

const schema = z.object({
  /** Words the model must echo back — the shortest honest end-to-end test. */
  prompt: z.string().trim().min(1).max(400).default("Reply with the JSON object {\"ok\": true} and nothing else."),
  model: z.string().trim().max(120).optional(),
});

/**
 * POST /api/ai/test
 *
 * One small call through the *configured* provider and model, reporting latency,
 * tokens and cost. This exists because "is my Groq quota the problem, or is the
 * prompt the problem" cannot be answered from the dashboard otherwise, and a
 * Puter token that was revoked yesterday looks identical to a network failure
 * until something actually calls it.
 *
 * It spends real credit on whichever account backs the provider — 60 tokens on
 * Sonnet-class models is fractions of a cent, which is why the route takes no
 * body by default.
 */
export const POST = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const input = parseOrThrow(schema, await request.json().catch(() => ({})));
  const result = await probeAi(input);
  return ok({ configured: await aiStatus(), ...result });
});
