/**
 * The AI provider surface the settings panel reads.
 *
 * `AiStatus` mirrors `aiStatus()` on the server. It is declared here rather
 * than inferred from a route so the panel fails to compile when a field is
 * renamed, instead of rendering `undefined` quietly.
 */
export interface AiStatus {
  provider: "puter" | "groq" | "none";
  requested: "auto" | "puter" | "groq" | "none";
  model: string;
  fallbackModel: string;
  reason: string | null;
  maxTokens: number;
  timeoutMs: number;
  groqModel: string;
  groqConfigured: boolean;
  puterConfigured: boolean;
  autoEnrich: boolean;
}
