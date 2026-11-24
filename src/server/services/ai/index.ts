import { aiResolution, getServerEnv } from "@/lib/env";
import { estimateGroqCost } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import { AI_PROVIDER_IDS } from "@/lib/ai-models";
import { aiSettingsView, chainReason, loadAiConfig, resolveChain } from "@/server/services/ai/config";
import { geminiJson } from "@/server/services/ai/gemini.client";
import { groqJson } from "@/server/services/groq.client";
import { puterJson } from "@/server/services/ai/puter";
import type {
  AiAttempt,
  AiJsonInput,
  AiLeg,
  AiProviderName,
  AiResult,
  AiUsage,
} from "@/server/services/ai/types";

/**
 * One entry point for "write me JSON from these messages", with a chain.
 *
 * Three routes reach the same prompt, in the order the operator asked for:
 *
 * - **Puter** (first) — the `:free` 550B model is not metered per token, so the
 *   bulk of the work should happen here. Billed to the Puter account behind the
 *   token, with no Groq-style tokens-per-minute wall.
 * - **Groq** (second) — the strongest free-tier model, fast and cheap per token,
 *   but the developer tier allows ~8k tokens/minute.
 * - **Gemini** (last) — free-tier Flash, reached only when the first two are
 *   unconfigured or both fail.
 *
 * A provider without a credential is skipped, never attempted. That is the
 * difference between "Gemini is off" and "Gemini failed": only the second one
 * appears in `attempts`, and only the second one is worth investigating.
 *
 * A Puter failure does not fail the lead. Anything that stops Puter answering —
 * a spent allowance, a revoked token, a 429, a gateway outage, a model that
 * refuses — moves the call down the ladder, and the result says where it
 * landed. That is deliberate: the operator sees `fellBackFrom` in the log and
 * the reviewer sees a warning, so a fallback is informative rather than a
 * silent substitution. The one thing it must never be is invisible, because the
 * providers cost different money in different accounts.
 *
 * Everything above this file (prompts, sanitising, the PPD contract, cost
 * logging) is provider-agnostic on purpose: changing the order is a config
 * change, never a code change.
 */
export async function aiJson<T = Record<string, unknown>>(
  input: AiJsonInput,
): Promise<AiResult<T>> {
  const env = getServerEnv();
  const config = await loadAiConfig(env);
  const chain = resolveChain(config, env);
  const maxTokens = input.maxTokens ?? aiResolution(env).maxTokens;

  if (chain.length === 0) {
    throw ApiError.internal(
      `No AI provider configured — ${chainReason(config, env) ?? "no credential is available"}. Set PUTER_AUTH_TOKEN, GROQ_API_KEY or GEMINI_API_KEY, or add a key on /settings/models.`,
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

    // Reserve a minimum attempt for every provider still waiting behind this
    // one. Without this, a Puter call that consumes its full 105 s leaves 5 s
    // of the 110 s budget and Groq/Gemini are skipped — the chain would exist
    // on paper but be unreachable precisely when Puter is slow. The first leg
    // may use the whole budget when the reserve itself would starve it.
    const reserve = (chain.length - index - 1) * env.AI_MIN_ATTEMPT_MS;
    const reservedLeft = left - reserve;
    const attemptBudget =
      reservedLeft >= env.AI_MIN_ATTEMPT_MS
        ? Math.min(leg.timeoutMs, reservedLeft)
        : Math.min(leg.timeoutMs, left);

    const startedAt = Date.now();
    try {
      const result = await callLeg<T>(
        leg,
        {
          ...input,
          // A model id belongs to one provider. `anthropic/claude-sonnet-5-5` is
          // not a Groq model, and carrying an override into the next leg turns a
          // fallback into a second failure — so the override rides only on the
          // leg it was written for, and later legs use their own configuration.
          ...(index === 0 && input.model ? { model: input.model } : { model: undefined }),
          maxTokens,
          // Never hand a provider more time than the whole call has left, or
          // the second attempt arrives after the function was already killed.
          timeoutMs: attemptBudget,
        },
        config[leg.provider].apiKey!,
      );
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
    `No AI provider could write this document — ${attempts
      .map((a) => `${a.provider}: ${a.error}`)
      .join(" · ")}`,
  );
}

/**
 * The order providers are tried in, resolved from the DB-over-env config.
 *
 * `AI_PROVIDER` names the preferred one, `AI_FALLBACK_PROVIDER` (default
 * `auto`) keeps the whole ladder, and `none` makes the chain one leg deep —
 * the strict mode for when you want a failure to stay a failure.
 *
 * A preferred provider that is not configured does not abort the chain: if the
 * next one can answer, it answers, and `reason` says the preferred one was
 * unusable. Generation failing because a token expired is not a reason to lose
 * the lead, and it is not a reason to hide the token either.
 */
export async function providerChain(env = getServerEnv()): Promise<AiLeg[]> {
  return resolveChain(await loadAiConfig(env), env);
}

/** Why the chain looks the way it does, in the operator's terms. */
export async function aiChainReason(env = getServerEnv()): Promise<string | null> {
  return chainReason(await loadAiConfig(env), env);
}

async function callLeg<T>(
  leg: AiLeg,
  input: AiJsonInput & { maxTokens: number; timeoutMs: number },
  apiKey: string,
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
      fallbackModel: leg.fallbackModel ?? undefined,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      maxTokens: input.maxTokens,
      // Puter's effort vocabulary is a superset of Groq's, so the value is
      // passed through and the model clamps whatever it cannot honour.
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      origin: env.PUTER_API_ORIGIN,
      token: apiKey,
      timeoutMs: input.timeoutMs,
    });
  }

  if (leg.provider === "gemini") {
    const result = await geminiJson<T>({
      messages: input.messages,
      apiKey,
      model: input.model ?? leg.model,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
    });
    return { ...result, provider: "gemini" as const };
  }

  const result = await groqJson<T>({
    messages: input.messages,
    apiKey,
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
 * one rather than silently mixed into the same column. Gemini's free tier
 * reports tokens but not a price, so it is `none` rather than a made-up number.
 */
export function aiCostOf(
  usage: AiUsage | null,
  provider?: AiProviderName,
): {
  usd: number | null;
  basis: "billed" | "estimated" | "none";
} {
  if (!usage) return { usd: null, basis: "none" };
  if (usage.cost_usd !== undefined) return { usd: usage.cost_usd, basis: "billed" };
  if (provider === "gemini" || provider === "puter") return { usd: null, basis: "none" };
  return { usd: estimateGroqCost(usage), basis: "estimated" };
}

/** The state the settings page and the health probe report. */
export async function aiStatus() {
  const env = getServerEnv();
  const config = await loadAiConfig(env);
  const chain = resolveChain(config, env);
  const resolution = aiResolution(env);

  return {
    // The leg that answers first, and the whole ordered chain with the reason
    // each leg is or is not in it — "puter failed so groq answered" is only
    // explainable if the reader can see both were available.
    provider: (chain[0]?.provider ?? "none") as AiProviderName | "none",
    chain: chain.map((leg) => ({ provider: leg.provider, model: leg.model })),
    fallbackProvider: env.AI_FALLBACK_PROVIDER,
    providerOrder: env.AI_PROVIDER_ORDER,
    totalBudgetMs: env.AI_MAX_TOTAL_MS,
    requested: resolution.requested,
    model: chain[0]?.model ?? "",
    fallbackModel: config.puter.fallbackModel ?? "",
    reason: chainReason(config, env),
    maxTokens: resolution.maxTokens,
    timeoutMs: env.AI_TIMEOUT_MS,
    /** Every model stays readable so a lead generated last month can be explained. */
    groqModel: config.groq.model,
    groqConfigured: Boolean(config.groq.apiKey),
    puterModel: config.puter.model,
    puterConfigured: Boolean(config.puter.apiKey),
    geminiModel: config.gemini.model,
    geminiConfigured: Boolean(config.gemini.apiKey),
    autoEnrich: env.AUTO_ENRICH_LEADS,
    settingsUrl: "/settings/models",
    providers: AI_PROVIDER_IDS.map((provider) => ({
      provider,
      configured: Boolean(config[provider].apiKey),
      enabled: config[provider].enabled,
      keySource: config[provider].keySource,
      model: config[provider].model,
      modelSource: config[provider].modelSource,
    })),
  };
}

export type { AiAttempt, AiJsonInput, AiResult, AiUsage } from "@/server/services/ai/types";
export { aiSettingsView };
export { providerChain as chain };
