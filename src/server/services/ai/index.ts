import { aiResolution, getServerEnv } from "@/lib/env";
import { estimateGroqCost } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import { groqJson } from "@/server/services/groq.client";
import { puterJson } from "@/server/services/ai/puter";
import type { AiJsonInput, AiResult, AiUsage } from "@/server/services/ai/types";

/**
 * One entry point for "write me JSON from these messages".
 *
 * Two routes exist for the same job and they fail differently, so the choice is
 * made in one place and reported everywhere else:
 *
 * - **Puter** — no API key of ours, billed to the Puter account behind
 *   `PUTER_AUTH_TOKEN`, no per-minute token ceiling. This is what removed the
 *   wall that blocked generation on Groq's free tier.
 * - **Groq** — fast and cheap per token, but the developer tier allows ~8k
 *   tokens per minute and ~200k per day, and a document that wants 12k output
 *   tokens runs into both. Kept as the fallback, not the default.
 *
 * Everything above this file (prompts, sanitising, the PPD contract, cost
 * logging) is provider-agnostic on purpose: switching models is a config change,
 * never a code change.
 */
export async function aiJson<T = Record<string, unknown>>(
  input: AiJsonInput,
): Promise<AiResult<T>> {
  const env = getServerEnv();
  const resolution = aiResolution(env);
  const maxTokens = input.maxTokens ?? resolution.maxTokens;

  if (resolution.provider === "none") {
    throw ApiError.internal(
      `No AI provider configured — ${resolution.reason}. Set PUTER_AUTH_TOKEN (free, no per-minute ceiling) or GROQ_API_KEY.`,
    );
  }

  logger.info("ai_generation_route", {
    provider: resolution.provider,
    model: input.model ?? resolution.model,
    maxTokens,
    requested: resolution.requested,
  });

  if (resolution.provider === "puter") {
    const result = await puterJson<T>({
      messages: input.messages,
      model: input.model ?? resolution.model,
      fallbackModel: env.PUTER_FALLBACK_MODEL,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      maxTokens,
      // Puter's effort vocabulary is a superset of Groq's; "minimal" is the one
      // value the two disagree about, so it is passed through and the model
      // clamps what it cannot honour.
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      origin: env.PUTER_API_ORIGIN,
      token: env.PUTER_AUTH_TOKEN!,
      timeoutMs: env.AI_TIMEOUT_MS,
    });
    return result;
  }

  const result = await groqJson<T>({
    messages: input.messages,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    maxTokens,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.schemaHint ? { schemaHint: input.schemaHint } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  return { ...result, provider: "groq", finishReason: null };
}

/**
 * What a generation run cost, and how confident that number is.
 *
 * Puter reports the real charge; Groq does not, so the estimate is labelled as
 * one rather than silently mixed into the same column.
 */
export function aiCostOf(usage: AiUsage | null): { usd: number | null; basis: "billed" | "estimated" | "none" } {
  if (!usage) return { usd: null, basis: "none" };
  if (usage.cost_usd !== undefined) return { usd: usage.cost_usd, basis: "billed" };
  return { usd: estimateGroqCost(usage), basis: "estimated" };
}

/** The state the settings page and the health probe report. */
export function aiStatus() {
  const env = getServerEnv();
  const resolution = aiResolution(env);
  return {
    provider: resolution.provider,
    requested: resolution.requested,
    model: resolution.model,
    fallbackModel: env.PUTER_FALLBACK_MODEL,
    reason: resolution.reason,
    maxTokens: resolution.maxTokens,
    timeoutMs: env.AI_TIMEOUT_MS,
    /** Groq stays readable so a lead generated last month can be explained. */
    groqModel: env.GROQ_MODEL,
    groqConfigured: Boolean(env.GROQ_API_KEY),
    puterConfigured: Boolean(env.PUTER_AUTH_TOKEN),
    autoEnrich: env.AUTO_ENRICH_LEADS,
  };
}

export type { AiJsonInput, AiResult, AiUsage } from "@/server/services/ai/types";
