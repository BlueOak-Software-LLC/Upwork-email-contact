/**
 * The AI provider surface the settings panel reads.
 *
 * `AiStatus` mirrors `aiStatus()` on the server. It is declared here rather
 * than inferred from a route so the panel fails to compile when a field is
 * renamed, instead of rendering `undefined` quietly.
 */
export type AiProvider = "puter" | "groq" | "none";

export interface AiStatus {
  provider: AiProvider;
  /** The chain actually tried, in order: the first leg answers if it can. */
  chain: Array<{ provider: AiProvider; model: string }>;
  fallbackProvider: "auto" | "puter" | "groq" | "none";
  totalBudgetMs: number;
  requested: "auto" | "puter" | "groq" | "none";
  model: string;
  fallbackModel: string;
  /** Why the chain looks like this — null when it is exactly what was asked for. */
  reason: string | null;
  maxTokens: number;
  timeoutMs: number;
  groqModel: string;
  groqConfigured: boolean;
  puterConfigured: boolean;
  autoEnrich: boolean;
}
