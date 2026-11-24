import { aiResolution, getServerEnv } from "@/lib/env";
import { aiCostOf, aiJson, aiStatus } from "@/server/services/ai";

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
}> {
  const env = getServerEnv();
  const resolution = aiResolution(env);
  const model = input.model?.trim() || resolution.model;
  const startedAt = Date.now();

  const base = { provider: resolution.provider, model };

  if (resolution.provider === "none") {
    return {
      ...base,
      ms: Date.now() - startedAt,
      ok: false,
      usage: null,
      costUsd: null,
      costBasis: "none",
      reply: "",
      error: resolution.reason ?? "No AI provider configured",
    };
  }

  try {
    const completion = await aiJson<Record<string, unknown>>({
      messages: [{ role: "user", content: input.prompt }],
      model,
      // Enough to answer, small enough that nobody worries about running it.
      maxTokens: 64,
      temperature: 0,
      reasoningEffort: "none",
    });
    const cost = aiCostOf(completion.usage);
    return {
      ...base,
      ms: Date.now() - startedAt,
      ok: true,
      usage: completion.usage,
      costUsd: cost.usd,
      costBasis: cost.basis,
      reply: completion.raw.slice(0, 400),
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The status the settings panel renders, with the probe's own summary. */
export function aiPanelStatus() {
  return aiStatus();
}
