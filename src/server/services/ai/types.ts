import type { AiProviderId } from "@/lib/ai-models";
import type { ReasoningEffort } from "@/server/services/groq.client";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiProviderName = AiProviderId;

/** Where the credential for one provider came from. */
export type AiKeySource = "database" | "environment" | "none";

/** Where the model id came from, so the settings page can say "default". */
export type AiModelSource = "database" | "environment" | "default";

/** One configured provider after DB-over-env resolution. */
export interface EffectiveAiProvider {
  provider: AiProviderName;
  label: string;
  apiKey: string | null;
  keySource: AiKeySource;
  model: string;
  modelSource: AiModelSource;
  fallbackModel: string | null;
  fallbackModelSource: AiModelSource;
  /** A DB row can switch a provider off without deleting its key. */
  enabled: boolean;
}

export type EffectiveAiConfig = Record<AiProviderName, EffectiveAiProvider>;

/** One rung of the generation ladder. */
export interface AiLeg {
  provider: AiProviderName;
  model: string;
  fallbackModel?: string | null;
  timeoutMs: number;
}

export interface AiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Reasoning/thinking tokens, when the model bills them separately. */
  reasoning_tokens?: number;
  /**
   * Real charge in USD when the provider reports one (Puter bills the account
   * behind the token). Groq usage is priced from the list rates instead, so this
   * stays undefined and the caller says which it is.
   */
  cost_usd?: number;
}

/** One provider that was tried, whether or not it answered. */
export interface AiAttempt {
  provider: AiProviderName;
  model: string;
  ms: number;
  error: string;
}

export interface AiResult<T> {
  data: T;
  raw: string;
  provider: AiProviderName;
  model: string;
  usage: AiUsage | null;
  /** The completion budget actually sent. */
  completionBudget: number;
  /** `stop` | `length` | `content_filter` | provider-specific. */
  finishReason?: string | null;
  /** Groq reports the effort it used after budget-driven tuning. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Providers tried before this one answered, oldest first. Empty when the
   * preferred provider did the work; non-empty means the cheaper-or-configured
   * route was unavailable and something else paid for it.
   */
  attempts?: AiAttempt[];
  /** Which provider failed first, when there was a fallback. */
  fellBackFrom?: AiProviderName;
}

export interface AiJsonInput {
  messages: AiMessage[];
  temperature?: number;
  /** Defaults to the configured completion budget. */
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort;
  /** Per-call model override; must be a model the selected provider knows. */
  model?: string;
  /**
   * Groq's `response_format` hint carries the shape in prose. Ignored by Puter,
   * whose models follow the same instruction from the system prompt.
   */
  schemaHint?: string;
}
