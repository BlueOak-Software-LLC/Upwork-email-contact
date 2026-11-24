import { aiResolution, getServerEnv } from "@/lib/env";
import { estimateGroqCost } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import { groqJson } from "@/server/services/groq.client";
import { puterJson } from "@/server/services/ai/puter";
import type {
  AiAttempt,
  AiJsonInput,
  AiProviderName,
  AiResult,
  AiUsage,
} from "@/server/services/ai/types";

/**
 * One entry point for "write me JSON from these messages", with a chain.
 *
 * Two routes reach the same prompt and they fail differently:
 *
 * - **Puter** (default) — no API key of ours, billed to the Puter account
 *   behind `PUTER_AUTH_TOKEN`, no per-minute token ceiling.
 * - **Groq** (fallback) — fast and cheap per token, but the developer tier
 *   allows ~8k tokens/minute and ~200k/day.
 *
 * A Puter failure does not fail the lead. Anything that stops Puter answering —
 * a spent allowance, a revoked token, a 429, a gateway outage, a model that
 * refuses — moves the call to Groq, and the result says so. That is deliberate:
 * the operator sees `fellBackFrom` in the log and the reviewer sees a warning,
 * so a fallback is informative rather than a silent substitution. The one thing
 * it must never be is invisible, because the two providers cost different money
 * in different accounts.
 *
 * Everything above this file (prompts, sanitising, the PPD contract, cost
 * logging) is provider-agnostic on purpose: changing the order is a config
 * change, never a code change.
 */
export async function aiJson<T = Record<string, unknown>>(
  input: AiJsonInput,
): Promise<AiResult<T>> {
  const env = getServerEnv();
  const chain = providerChain(env);
  const maxTokens = input.maxTokens ?? aiResolution(env).maxTokens;

  if (chain.length === 0) {
    throw ApiError.internal(
      `No AI provider configured — ${aiResolution(env).reason}. Set PUTER_AUTH_TOKEN (free, no per-minute ceiling) or GROQ_API_KEY.`,
    );
  }

  const deadline = Date.now() + env.AI_MAX_TOTAL_MS;
  const attempts: AiAttempt[] = [];

  for (const [index, leg] of chain.entries()) {
    const left = deadline - Date.now();
    if (index > 0 && left < env.AI_MIN_ATTEMPT_MS) {
      attempts.push({
        provider: leg.provider,
        model: leg.model,
        ms: 0,
        error: `skipped — the ${env.AI_MAX_TOTAL_MS}ms generation budget was already spent`,
      });
      continue;
    }

    const startedAt = Date.now();
    try {
      const result = await callLeg<T>(leg, {
        ...input,
        // A model id belongs to one provider. `anthropic/claude-sonnet-5-5` is
        // not a Groq model, and carrying an override into the next leg turns a
        // fallback into a second failure — so the override rides only on the
        // leg it was written for, and later legs use their own configuration.
        ...(index === 0 && input.model ? { model: input.model } : { model: undefined }),
        maxTokens,
        // Never hand a provider more time than the whole call has left, or the
        // second attempt arrives after the function was already killed.
        timeoutMs: Math.min(leg.timeoutMs, left),
      });
      if (attempts.length) {
        logger.warn("ai_provider_fallback", {
          answeredBy: leg.provider,
          model: result.model,
          fellBackFrom: attempts.map((a) => `${a.provider}: ${a.error}`),
          ms: Date.now() - startedAt,
        });
      }
      return { ...result, attempts: [...attempts], fellBackFrom: attempts[0]?.provider };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        provider: leg.provider,
        model: leg.model,
        ms: Date.now() - startedAt,
        error: message,
      });
      logger.warn("ai_provider_failed", {
        provider: leg.provider,
        model: leg.model,
        next: chain[index + 1]?.provider ?? "none",
        // Worth stating: the fallback will write this document with a different
        // model than the one the caller named.
        droppedModelOverride: index === 0 && input.model ? input.model : null,
        error: message,
      });
    }
  }

  // Every leg failed: say what each one said, because the fixes differ —
  // "top up the Puter account" and "your Groq key is wrong" are not the same
  // errand, and reporting only the last error sends the operator to the wrong
  // dashboard.
  throw ApiError.upstream(
    `Neither provider could write this document — ${attempts
      .map((a) => `${a.provider}: ${a.error}`)
      .join(" · ")}`,
  );
}

/** One provider in the chain, already resolved to a model and a timeout. */
interface Leg {
  provider: AiProviderName;
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
}

/**
 * The order providers are tried in.
 *
 * `AI_PROVIDER` names the preferred one, `AI_FALLBACK_PROVIDER` (default
 * `auto`) names what to fall through to, and `none` makes the chain one leg
 * deep — the strict mode for when you want a failure to stay a failure.
 *
 * A preferred provider that is not configured does not abort the chain: if the
 * fallback can answer, it answers, and `reason` says the preferred one was
 * unusable. Generation failing because a token expired is not a reason to lose
 * the lead, and it is not a reason to hide the token either.
 */
export function providerChain(env = getServerEnv()): Leg[] {
  const legs: Record<AiProviderName, Leg> = {
    puter: {
      provider: "puter",
      model: env.PUTER_MODEL,
      fallbackModel: env.PUTER_FALLBACK_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
    },
    groq: { provider: "groq", model: env.GROQ_MODEL, timeoutMs: env.GROQ_TIMEOUT_MS },
  };
  const configured: Record<AiProviderName, boolean> = {
    puter: Boolean(env.PUTER_AUTH_TOKEN),
    groq: Boolean(env.GROQ_API_KEY),
  };

  if (env.AI_PROVIDER === "none") return [];

  const primary: AiProviderName =
    env.AI_PROVIDER === "puter" || env.AI_PROVIDER === "groq"
      ? env.AI_PROVIDER
      : configured.puter
        ? "puter"
        : "groq";

  const fallback: AiProviderName | null =
    env.AI_FALLBACK_PROVIDER === "none"
      ? null
      : env.AI_FALLBACK_PROVIDER === "auto"
        ? primary === "puter"
          ? "groq"
          : "puter"
        : env.AI_FALLBACK_PROVIDER;

  const order = [...new Set([primary, fallback].filter(Boolean) as AiProviderName[])];
  return order.filter((name) => configured[name]).map((name) => legs[name]);
}

/** Why the chain looks the way it does, in the operator's terms. */
export function aiChainReason(env = getServerEnv()): string | null {
  const resolution = aiResolution(env);
  if (env.AI_PROVIDER === "none") return "AI_PROVIDER=none — generation is disabled";
  if (providerChain(env).length === 0) return resolution.reason ?? "No provider configured";
  if (
    (env.AI_PROVIDER === "puter" || env.AI_PROVIDER === "auto") &&
    !env.PUTER_AUTH_TOKEN &&
    env.GROQ_API_KEY
  ) {
    return "PUTER_AUTH_TOKEN is not set, so Groq answers first. Run `puter login` and paste the token to make Puter the default.";
  }
  return null;
}

async function callLeg<T>(
  leg: Leg,
  input: AiJsonInput & { maxTokens: number; timeoutMs: number },
): Promise<AiResult<T>> {
  logger.info("ai_generation_route", {
    provider: leg.provider,
    model: input.model ?? leg.model,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
  });

  if (leg.provider === "puter") {
    const env = getServerEnv();
    return puterJson<T>({
      messages: input.messages,
      model: input.model ?? leg.model,
      fallbackModel: leg.fallbackModel,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      maxTokens: input.maxTokens,
      // Puter's effort vocabulary is a superset of Groq's, so the value is
      // passed through and the model clamps whatever it cannot honour.
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      origin: env.PUTER_API_ORIGIN,
      token: env.PUTER_AUTH_TOKEN!,
      timeoutMs: input.timeoutMs,
    });
  }

  const result = await groqJson<T>({
    messages: input.messages,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    maxTokens: input.maxTokens,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.schemaHint ? { schemaHint: input.schemaHint } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  return { ...result, provider: "groq" as const, finishReason: null };
}

/**
 * What a generation run cost, and how confident that number is.
 *
 * Puter reports the real charge; Groq does not, so the estimate is labelled as
 * one rather than silently mixed into the same column.
 */
export function aiCostOf(usage: AiUsage | null): {
  usd: number | null;
  basis: "billed" | "estimated" | "none";
} {
  if (!usage) return { usd: null, basis: "none" };
  if (usage.cost_usd !== undefined) return { usd: usage.cost_usd, basis: "billed" };
  return { usd: estimateGroqCost(usage), basis: "estimated" };
}

/** The state the settings page and the health probe report. */
export function aiStatus() {
  const env = getServerEnv();
  const resolution = aiResolution(env);
  const chain = providerChain(env);
  return {
    // The leg that answers first, and the whole ordered chain with the reason
    // each leg is or is not in it — "puter failed so groq answered" is only
    // explainable if the reader can see both were available.
    provider: (chain[0]?.provider ?? "none") as AiProviderName | "none",
    chain: chain.map((leg) => ({ provider: leg.provider, model: leg.model })),
    fallbackProvider: env.AI_FALLBACK_PROVIDER,
    totalBudgetMs: env.AI_MAX_TOTAL_MS,
    requested: resolution.requested,
    model: chain[0]?.model ?? "",
    fallbackModel: env.PUTER_FALLBACK_MODEL,
    reason: aiChainReason(env),
    maxTokens: resolution.maxTokens,
    timeoutMs: env.AI_TIMEOUT_MS,
    /** Groq stays readable so a lead generated last month can be explained. */
    groqModel: env.GROQ_MODEL,
    groqConfigured: Boolean(env.GROQ_API_KEY),
    puterConfigured: Boolean(env.PUTER_AUTH_TOKEN),
    autoEnrich: env.AUTO_ENRICH_LEADS,
  };
}

export type { AiAttempt, AiJsonInput, AiResult, AiUsage } from "@/server/services/ai/types";
export { providerChain as chain };
