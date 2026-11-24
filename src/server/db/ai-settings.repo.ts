import "server-only";
import { isAiProviderId, AI_PROVIDER_IDS, type AiProviderId } from "@/lib/ai-models";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/server/http/errors";
import { isMissingSchema } from "@/server/db/schema-guard";
import type { Database } from "@/types/database";

/**
 * Storage for the values the operator changes on /settings/models.
 *
 * The table is optional by design: a deployment that has not applied 0006 still
 * generates documents from `.env.local`, because `list()` degrades to an empty
 * array on a missing table. Only an explicit save needs the migration, and that
 * path says so instead of failing silently.
 */
export const AI_SETTINGS_MIGRATION = "supabase/migrations/0006_ai_settings.sql";

const COLUMNS = "provider,api_key_cipher,model,fallback_model,enabled,updated_at";

export interface AiSettingRow {
  provider: AiProviderId;
  /** Decrypted in memory only; never serialised to an API response. */
  apiKey: string | null;
  model: string | null;
  fallbackModel: string | null;
  enabled: boolean;
  updatedAt: string | null;
}

export interface SaveAiSettingInput {
  provider: AiProviderId;
  /** Omit to keep the stored key; empty string is treated as "keep". */
  apiKey?: string;
  /** Explicit removal of a stored key, falling back to the env var. */
  clearKey?: boolean;
  /** Omit to keep the stored model; empty string clears it back to env/default. */
  model?: string | null;
  fallbackModel?: string | null;
  enabled?: boolean;
}

type RawRow = {
  provider: string;
  api_key_cipher: string | null;
  model: string | null;
  fallback_model: string | null;
  enabled: boolean;
  updated_at: string | null;
};

function toRow(raw: RawRow): AiSettingRow | null {
  if (!isAiProviderId(raw.provider)) return null;
  let apiKey: string | null = null;
  if (raw.api_key_cipher) {
    try {
      apiKey = decryptSecret(raw.api_key_cipher);
    } catch (error) {
      // A rotated APP_ENCRYPTION_KEY must not take generation down: the provider
      // is then treated as unconfigured and the chain moves to the next one.
      logger.error("ai_settings_decrypt_failed", {
        provider: raw.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    provider: raw.provider,
    apiKey,
    model: raw.model,
    fallbackModel: raw.fallback_model,
    enabled: raw.enabled,
    updatedAt: raw.updated_at,
  };
}

export const aiSettingsRepo = {
  /** Every saved row, decrypted. Missing table / wrong key degrades to fewer rows. */
  async list(): Promise<AiSettingRow[]> {
    try {
      const supabase = getAdminClient();
      const { data, error } = await supabase.from("ai_settings").select(COLUMNS);
      if (error) {
        if (isMissingSchema(error)) {
          logger.debug("ai_settings_table_missing", { migration: AI_SETTINGS_MIGRATION });
        } else {
          logger.error("ai_settings_read_failed", { error: error.message });
        }
        return [];
      }
      return ((data ?? []) as RawRow[]).map(toRow).filter((row): row is AiSettingRow => row !== null);
    } catch (error) {
      logger.error("ai_settings_read_threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  },

  /**
   * Whether 0006 has been applied. The settings page uses this to warn before a
   * save fails; an ordinary read error returns `true` so a transient network
   * problem never masquerades as a missing migration.
   */
  async storageReady(): Promise<boolean> {
    try {
      const supabase = getAdminClient();
      const { error } = await supabase.from("ai_settings").select("provider").limit(1);
      if (!error) return true;
      if (isMissingSchema(error)) {
        logger.debug("ai_settings_table_missing", { migration: AI_SETTINGS_MIGRATION });
        return false;
      }
      logger.error("ai_settings_probe_failed", { error: error.message });
      return true;
    } catch (error) {
      logger.error("ai_settings_probe_threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  },

  async save(input: SaveAiSettingInput): Promise<void> {
    const supabase = getAdminClient();
    const { data: existing, error: readError } = await supabase
      .from("ai_settings")
      .select("api_key_cipher")
      .eq("provider", input.provider)
      .maybeSingle();

    if (readError && !isMissingSchema(readError)) {
      throw ApiError.upstream(`Failed to read AI settings: ${readError.message}`);
    }

    let cipher = (existing as { api_key_cipher: string | null } | null)?.api_key_cipher ?? null;
    if (input.clearKey) {
      cipher = null;
    } else if (input.apiKey !== undefined && input.apiKey.trim() !== "") {
      try {
        cipher = encryptSecret(input.apiKey.trim());
      } catch (error) {
        throw ApiError.badRequest(
          error instanceof Error
            ? error.message
            : "APP_ENCRYPTION_KEY is required to store provider keys.",
        );
      }
    }

    const patch = {
      provider: input.provider,
      api_key_cipher: cipher,
      model: input.model !== undefined ? input.model?.trim() || null : undefined,
      fallback_model:
        input.fallbackModel !== undefined ? input.fallbackModel?.trim() || null : undefined,
      enabled: input.enabled,
      updated_at: new Date().toISOString(),
    };

    // Undefined means "leave the stored value alone". PostgREST would insert
    // NULL for an omitted column on a fresh row, which is exactly what we want
    // for model/fallback only when the operator actually cleared it — so filter
    // undefined keys out of the payload rather than relying on the insert.
    const payload = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );

    const { error } = await supabase
      .from("ai_settings")
      .upsert(payload as Database["public"]["Tables"]["ai_settings"]["Insert"], {
        onConflict: "provider",
      });

    if (error) {
      if (isMissingSchema(error)) {
        throw ApiError.badRequest(
          `AI settings need ${AI_SETTINGS_MIGRATION}. Apply the migration and save again.`,
        );
      }
      throw ApiError.upstream(`Failed to save AI settings: ${error.message}`);
    }

    logger.info("ai_settings_saved", {
      provider: input.provider,
      keyChanged: input.clearKey || (input.apiKey !== undefined && input.apiKey.trim() !== ""),
      enabled: input.enabled ?? null,
    });
  },

  /** Remove the row so the provider falls back to env/defaults again. */
  async reset(provider: AiProviderId): Promise<void> {
    const supabase = getAdminClient();
    const { error } = await supabase.from("ai_settings").delete().eq("provider", provider);
    if (error && !isMissingSchema(error)) {
      throw ApiError.upstream(`Failed to reset AI settings: ${error.message}`);
    }
    logger.info("ai_settings_reset", { provider });
  },

  /** Providers with a row, for diagnostics. */
  async providers(): Promise<AiProviderId[]> {
    const rows = await this.list();
    const found = new Set(rows.map((row) => row.provider));
    return AI_PROVIDER_IDS.filter((provider) => found.has(provider));
  },
};
