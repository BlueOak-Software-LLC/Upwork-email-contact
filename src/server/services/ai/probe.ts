import { getServerEnv } from "@/lib/env";
import { aiChainReason, aiCostOf, aiJson, aiStatus, providerChain } from "@/server/services/ai";

/**
 * A minimal round trip through whatever provider is configured.
 *
 * Deliberately tiny: 64 completion tokens, one instruction, no database write.
 * It answers the operator's first question after a failed generation — can this
 * deployment reach this model with this credential at all — without pretending
 * to test the proposal prompt, which is a different and much more expensive
 * thing.
 */
export async function probeAi(input: {
  prompt: string;
  model?: string;
}): Promise<{
  ok: boolean;
  provider: string;
  model: string;
  ms: number;
  usage: unknown;
  costUsd: number | null;
  costBasis: string;
  reply: string;
  error: string | null;
  /** Providers tried before this one answered, oldest first. */
  attempts: Array<{ provider: string; model: string; ms: number; error: string }>;
  chain: string[];
}> {
  const env = getServerEnv();
  const startedAt = Date.now();

  const chain = providerChain(env);
  // The probe answers with whichever provider ends up writing it, so it must
  // not name a model the fallback provider does not have: only an explicit
  // caller override is passed down, and `aiJson` applies it to the first leg.
  const base = {
    provider: chain[0]?.provider ?? "none",
    model: input.model?.trim() || chain[0]?.model || "",
    chain: chain.map((leg) => leg.provider),
  };

  if (chain.length === 0) {
    return {
      ...base,
      provider: "none",
      model: "",
      ms: Date.now() - startedAt,
      ok: false,
      usage: null,
      costUsd: null,
      costBasis: "none",
      reply: "",
      attempts: [],
      error: aiChainReason(env) ?? "No AI provider configured",
    };
  }

  try {
    const completion = await aiJson<Record<string, unknown>>({
      messages: [{ role: "user", content: input.prompt }],
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      // Enough to answer, small enough that nobody worries about running it.
      maxTokens: 64,
      temperature: 0,
      reasoningEffort: "none",
    });
    const cost = aiCostOf(completion.usage);
    return {
      ...base,
      // Report who actually answered, not who was configured first.
      provider: completion.provider,
      model: completion.model,
      ms: Date.now() - startedAt,
      ok: true,
      usage: completion.usage,
      costUsd: cost.usd,
      costBasis: cost.basis,
      reply: completion.raw.slice(0, 400),
      attempts: completion.attempts ?? [],
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      ms: Date.now() - startedAt,
      ok: false,
      usage: null,
      costUsd: null,
      costBasis: "none",
      reply: "",
      attempts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The status the settings panel renders, with the probe's own summary. */
export function aiPanelStatus() {
  return aiStatus();
}
