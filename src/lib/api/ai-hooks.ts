"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";

/**
 * The AI provider surface the settings screens read.
 *
 * `AiStatus` mirrors `aiStatus()` on the server. It is declared here rather
 * than inferred from a route so the panel fails to compile when a field is
 * renamed, instead of rendering `undefined` quietly.
 */
export type AiProvider = "puter" | "groq" | "gemini";

export type AiKeySource = "database" | "environment" | "none";
export type AiModelSource = "database" | "environment" | "default";

export interface AiProviderStatus {
  provider: AiProvider;
  configured: boolean;
  enabled: boolean;
  keySource: AiKeySource;
  model: string;
  modelSource: AiModelSource;
}

export interface AiStatus {
  provider: AiProvider | "none";
  /** The chain actually tried, in order: the first leg answers if it can. */
  chain: Array<{ provider: AiProvider; model: string }>;
  fallbackProvider: "auto" | AiProvider | "none";
  providerOrder: string;
  totalBudgetMs: number;
  requested: "auto" | AiProvider | "none";
  model: string;
  fallbackModel: string;
  /** Why the chain looks like this — null when it is exactly what was asked for. */
  reason: string | null;
  maxTokens: number;
  timeoutMs: number;
  puterModel: string;
  puterConfigured: boolean;
  groqModel: string;
  groqConfigured: boolean;
  geminiModel: string;
  geminiConfigured: boolean;
  autoEnrich: boolean;
  settingsUrl: string;
  providers: AiProviderStatus[];
}

/** One provider card on /settings/models. Keys are never included. */
export interface AiProviderSettings {
  provider: AiProvider;
  label: string;
  credentialLabel: string;
  credentialUrl: string;
  envVar: string;
  configured: boolean;
  keySource: AiKeySource;
  enabled: boolean;
  model: string;
  modelSource: AiModelSource;
  fallbackModel: string | null;
  fallbackModelSource: AiModelSource;
  defaultModel: string;
  defaultFallbackModel: string | null;
  inChain: boolean;
}

export interface AiSettings {
  chain: Array<{ provider: AiProvider; model: string }>;
  order: AiProvider[];
  activeOrder: AiProvider[];
  requested: "auto" | AiProvider | "none";
  fallbackProvider: "auto" | AiProvider | "none";
  providerOrder: string;
  reason: string | null;
  encryptionReady: boolean;
  /** False when 0006_ai_settings.sql has not been applied. */
  storageReady: boolean;
  providers: AiProviderSettings[];
}

export interface SaveAiSettingsInput {
  provider: AiProvider;
  /** Omit to keep the stored key; never send an empty string. */
  apiKey?: string;
  clearKey?: boolean;
  /** Empty string restores the env/default model id. */
  model?: string;
  fallbackModel?: string | null;
  enabled?: boolean;
}

export const aiSettingsKey = ["ai-settings"] as const;

export function useAiSettings(initialData?: AiSettings) {
  return useQuery({
    queryKey: aiSettingsKey,
    queryFn: async () => (await apiFetch<AiSettings>("/api/ai/settings")).data,
    initialData,
    // A save must be visible on the next paint, not after a 10 s cache window.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export function useSaveAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveAiSettingsInput) =>
      (await apiFetch<AiSettings>("/api/ai/settings", { method: "PUT", body: input })).data,
    onSuccess: (data) => queryClient.setQueryData(aiSettingsKey, data),
  });
}

export function useResetAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (provider: AiProvider) =>
      (
        await apiFetch<AiSettings>("/api/ai/settings", {
          method: "DELETE",
          query: { provider },
        })
      ).data,
    onSuccess: (data) => queryClient.setQueryData(aiSettingsKey, data),
  });
}
