import { getServerEnv, type ServerEnv } from "@/lib/env";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_META,
  DEFAULT_PROVIDER_ORDER,
  parseProviderOrder,
  type AiProviderId,
} from "@/lib/ai-models";
import { aiSettingsRepo } from "@/server/db/ai-settings.repo";
import type {
  AiKeySource,
  AiLeg,
  AiModelSource,
  EffectiveAiConfig,
  EffectiveAiProvider,
} from "@/server/services/ai/types";

/**
 * Effective provider configuration: DB row → environment → built-in free
 * default, in that order.
 *
 * Why the DB wins: the settings page exists so an operator can paste a key and
 * pick a model without a redeploy. Environment variables stay the bootstrap and
 * the break-glass path — deleting the row restores them, which is exactly what
 * "reset to defaults" does.
 */

function envKey(env: ServerEnv, provider: AiProviderId): string | null {
  const value =
    provider === "puter" ? env.PUTER_AUTH_TOKEN : provider === "groq" ? env.GROQ_API_KEY : env.GEMINI_API_KEY;
  return value?.trim() ? value.trim() : null;
}

function envModel(env: ServerEnv, provider: AiProviderId): string {
  if (provider === "puter") return env.PUTER_MODEL;
  if (provider === "groq") return env.GROQ_MODEL;
  return env.GEMINI_MODEL;
}

function envFallbackModel(env: ServerEnv, provider: AiProviderId): string | null {
  return provider === "puter" ? env.PUTER_FALLBACK_MODEL : AI_PROVIDER_META[provider].defaultFallbackModel;
}

/**
 * Whether the operator set this env var explicitly, as opposed to Zod filling
 * in its default. Only used to label a model "environment" vs "default" in the
 * UI — the values themselves are identical.
 */
function envWasSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "";
}

function modelSource(provider: AiProviderId, fromRow: boolean, envName: string): AiModelSource {
  if (fromRow) return "database";
  return envWasSet(envName) ? "environment" : "default";
}

const ENV_MODEL_NAME: Record<AiProviderId, string> = {
  puter: "PUTER_MODEL",
  groq: "GROQ_MODEL",
  gemini: "GEMINI_MODEL",
};

const ENV_FALLBACK_NAME: Record<AiProviderId, string> = {
  puter: "PUTER_FALLBACK_MODEL",
  groq: "GROQ_MODEL",
  gemini: "GEMINI_MODEL",
};

export async function loadAiConfig(env: ServerEnv = getServerEnv()): Promise<EffectiveAiConfig> {
  const rows = await aiSettingsRepo.list();
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  const config = {} as EffectiveAiConfig;

  for (const provider of AI_PROVIDER_IDS) {
    const row = byProvider.get(provider);
    const meta = AI_PROVIDER_META[provider];
    const envCredential = envKey(env, provider);
    const rowCredential = row?.apiKey?.trim() || null;
    const apiKey = rowCredential ?? envCredential;
    const keySource: AiKeySource = rowCredential ? "database" : envCredential ? "environment" : "none";

    const rowModel = row?.model?.trim() || null;
    const rowFallback = row?.fallbackModel?.trim() || null;
    const fallback = rowFallback ?? envFallbackModel(env, provider);

    const effective: EffectiveAiProvider = {
      provider,
      label: meta.label,
      apiKey,
      keySource,
      model: rowModel ?? envModel(env, provider),
      modelSource: modelSource(provider, Boolean(rowModel), ENV_MODEL_NAME[provider]),
      fallbackModel: fallback,
      fallbackModelSource: modelSource(provider, Boolean(rowFallback), ENV_FALLBACK_NAME[provider]),
      enabled: row?.enabled ?? true,
    };
    config[provider] = effective;
  }

  return config;
}

/**
 * Turn the effective config into the ordered ladder actually tried.
 *
 * Rules, in order:
 *  1. `AI_PROVIDER=none` disables generation.
 *  2. `AI_PROVIDER` may pin a provider to the front; `auto` uses the order.
 *  3. `AI_FALLBACK_PROVIDER=none` makes the chain one leg deep (strict mode).
 *  4. Providers that are disabled, or have no credential from either source,
 *     are skipped entirely — never attempted and never counted as a failure.
 */
export function resolveChain(
  config: EffectiveAiConfig,
  env: ServerEnv = getServerEnv(),
): AiLeg[] {
  if (env.AI_PROVIDER === "none") return [];

  const base = parseProviderOrder(env.AI_PROVIDER_ORDER || DEFAULT_PROVIDER_ORDER);
  let order: AiProviderId[] =
    env.AI_PROVIDER === "auto"
      ? base
      : [env.AI_PROVIDER, ...base.filter((provider) => provider !== env.AI_PROVIDER)];

  if (env.AI_FALLBACK_PROVIDER === "none") {
    order = order.slice(0, 1);
  } else if (env.AI_FALLBACK_PROVIDER !== "auto") {
    const fallback = env.AI_FALLBACK_PROVIDER;
    order = [order[0]!, ...(order[0] === fallback ? [] : [fallback])];
  }

  const timeouts: Record<AiProviderId, number> = {
    puter: env.AI_TIMEOUT_MS,
    groq: env.GROQ_TIMEOUT_MS,
    gemini: env.GEMINI_TIMEOUT_MS,
  };

  return order
    .filter((provider) => config[provider].enabled && Boolean(config[provider].apiKey))
    .map((provider) => ({
      provider,
      model: config[provider].model,
      fallbackModel: config[provider].fallbackModel,
      timeoutMs: timeouts[provider],
    }));
}

/** Why the chain looks the way it does, in the operator's terms. */
export function chainReason(
  config: EffectiveAiConfig,
  env: ServerEnv = getServerEnv(),
): string | null {
  if (env.AI_PROVIDER === "none") return "AI_PROVIDER=none — generation is disabled";

  const chain = resolveChain(config, env);
  if (chain.length === 0) {
    // In strict mode the only provider that *could* answer is the head of the
    // order. Name that one instead of listing all three keys: the operator may
    // have a perfectly good Groq key that strict mode deliberately ignores.
    if (env.AI_FALLBACK_PROVIDER === "none") {
      const only =
        env.AI_PROVIDER === "auto"
          ? parseProviderOrder(env.AI_PROVIDER_ORDER || DEFAULT_PROVIDER_ORDER)[0]!
          : env.AI_PROVIDER;
      if (!config[only].apiKey) {
        return `${AI_PROVIDER_META[only].envVar} is not set — AI_FALLBACK_PROVIDER=none leaves no fallback.`;
      }
      if (!config[only].enabled) {
        return `${AI_PROVIDER_META[only].label} is disabled on /settings/models and AI_FALLBACK_PROVIDER=none leaves no fallback.`;
      }
    }

    const unconfigured = AI_PROVIDER_IDS.filter((provider) => !config[provider].apiKey);
    const disabled = AI_PROVIDER_IDS.filter(
      (provider) => config[provider].apiKey && !config[provider].enabled,
    );
    if (unconfigured.length === AI_PROVIDER_IDS.length) {
      return "No AI provider is configured — add a Puter token, Groq key or Gemini key on /settings/models.";
    }
    if (disabled.length) {
      return `Every configured provider is disabled (${disabled
        .map((provider) => AI_PROVIDER_META[provider].label)
        .join(", ")}). Enable one on /settings/models.`;
    }
    return `No enabled AI provider has a credential (${unconfigured
      .map((provider) => AI_PROVIDER_META[provider].envVar)
      .join(", ")} unset). Check /settings/models.`;
  }

  const requested =
    env.AI_PROVIDER === "auto"
      ? parseProviderOrder(env.AI_PROVIDER_ORDER || DEFAULT_PROVIDER_ORDER)[0]
      : env.AI_PROVIDER;

  if (requested && requested !== chain[0]!.provider) {
    const preferred = config[requested];
    if (!preferred.apiKey) {
      return `${AI_PROVIDER_META[requested].envVar} is not set, so ${chain[0]!.provider} answers first.`;
    }
    if (!preferred.enabled) {
      return `${AI_PROVIDER_META[requested].label} is disabled on /settings/models, so ${chain[0]!.provider} answers first.`;
    }
    return `${AI_PROVIDER_META[requested].label} is not in the active chain (check AI_PROVIDER_ORDER and AI_FALLBACK_PROVIDER), so ${chain[0]!.provider} answers first.`;
  }

  return null;
}

/**
 * Everything /settings/models and /settings/ai need to render — and deliberately
 * nothing a browser could use to recover a key. `configured` and `keySource`
 * answer "did my save take effect?" without echoing the secret.
 */
export async function aiSettingsView(env: ServerEnv = getServerEnv()) {
  const [config, storageReady] = await Promise.all([
    loadAiConfig(env),
    aiSettingsRepo.storageReady(),
  ]);
  const chain = resolveChain(config, env);

  return {
    chain: chain.map((leg) => ({ provider: leg.provider, model: leg.model })),
    order: parseProviderOrder(env.AI_PROVIDER_ORDER || DEFAULT_PROVIDER_ORDER),
    activeOrder: chain.map((leg) => leg.provider),
    requested: env.AI_PROVIDER,
    fallbackProvider: env.AI_FALLBACK_PROVIDER,
    providerOrder: env.AI_PROVIDER_ORDER,
    reason: chainReason(config, env),
    encryptionReady: Boolean(env.APP_ENCRYPTION_KEY),
    storageReady,
    providers: AI_PROVIDER_IDS.map((provider) => {
      const item = config[provider];
      const meta = AI_PROVIDER_META[provider];
      return {
        provider,
        label: meta.label,
        credentialLabel: meta.credentialLabel,
        credentialUrl: meta.credentialUrl,
        envVar: meta.envVar,
        configured: Boolean(item.apiKey),
        keySource: item.keySource,
        enabled: item.enabled,
        model: item.model,
        modelSource: item.modelSource,
        fallbackModel: item.fallbackModel,
        fallbackModelSource: item.fallbackModelSource,
        defaultModel: meta.defaultModel,
        defaultFallbackModel: meta.defaultFallbackModel,
        inChain: chain.some((leg) => leg.provider === provider),
      };
    }),
  };
}

export type AiSettingsView = Awaited<ReturnType<typeof aiSettingsView>>;
