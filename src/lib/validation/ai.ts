import { z } from "zod";
import { AI_PROVIDER_IDS } from "@/lib/ai-models";

/**
 * /settings/models payloads.
 *
 * `apiKey` and `clearKey` are mutually exclusive: an empty submit means "keep
 * whatever is stored", and removing a key is its own button so a stray empty
 * input cannot silently turn a provider off.
 */
export const aiProviderSchema = z.enum(AI_PROVIDER_IDS);

export const saveAiSettingsSchema = z
  .object({
    provider: aiProviderSchema,
    /** 8 chars is below every real key; the lower bound only catches typos. */
    apiKey: z.string().trim().min(8).max(4000).optional(),
    clearKey: z.boolean().optional(),
    /** Empty string clears the override back to env/default. */
    model: z.string().trim().max(160).optional(),
    fallbackModel: z.string().trim().max(160).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => !(value.apiKey && value.clearKey), {
    message: "Send either apiKey or clearKey, not both",
    path: ["apiKey"],
  });

export const resetAiSettingsSchema = z.object({ provider: aiProviderSchema });

export type SaveAiSettingsPayload = z.infer<typeof saveAiSettingsSchema>;
export type ResetAiSettingsPayload = z.infer<typeof resetAiSettingsSchema>;
