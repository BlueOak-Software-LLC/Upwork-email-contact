import type { ReasoningEffort } from "@/server/services/groq.client";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiProviderName = "puter" | "groq";

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
