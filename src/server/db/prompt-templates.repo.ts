import { getAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";
import type { PromptKey, PromptTemplateText } from "@/server/services/prompts/proposal.prompt";
import { isMissingSchema, REVIEW_FLOW_MIGRATION } from "@/server/db/schema-guard";
import { ApiError } from "@/server/http/errors";
import { logger } from "@/lib/logger";

export interface PromptTemplateDto extends PromptTemplateText {
  /** false ⇒ a human edited it and this row overrides the code default. */
  isDefault: boolean;
  updatedAt: string | null;
}

type Row = Database["public"]["Tables"]["prompt_templates"]["Row"];

export const promptTemplatesRepo = {
  /**
   * Returns the stored override, or null for "use the code default".
   * A missing table/column set (migration 0003 not applied yet) must not break
   * generation, so those errors degrade to the default with one log line.
   */
  async get(key: PromptKey): Promise<Row | null> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("prompt_templates")
      .select("*")
      .eq("key", key)
      .maybeSingle();
    if (error) {
      if (isMissingSchema(error)) {
        logger.warn("prompt_templates_missing", { key, code: error.code, hint: error.hint });
        return null;
      }
      throw ApiError.upstream(`Failed to load prompt ${key}: ${error.message}`);
    }
    return (data as Row | null) ?? null;
  },

  async save(input: {
    key: PromptKey;
    label: string;
    systemText: string;
    userTemplate: string;
    temperature: number;
    maxTokens: number | null;
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
    note: string | null;
  }): Promise<Row> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("prompt_templates")
      .upsert(
        {
          key: input.key,
          label: input.label,
          system_text: input.systemText,
          user_template: input.userTemplate,
          temperature: input.temperature,
          max_tokens: input.maxTokens,
          reasoning_effort: input.reasoningEffort,
          note: input.note,
        },
        { onConflict: "key" },
      )
      .select("*")
      .single();

    if (error) {
      throw ApiError.upstream(
        isMissingSchema(error)
          ? `Cannot save prompt overrides: the prompt_templates table is missing (${error.message}) — apply ${REVIEW_FLOW_MIGRATION}`
          : `Failed to save prompt ${input.key}: ${error.message}`,
      );
    }
    return data as Row;
  },

  /** "Reset to default" — the code default becomes authoritative again. */
  async remove(key: PromptKey): Promise<boolean> {
    const supabase = getAdminClient();
    const { error, count } = await supabase
      .from("prompt_templates")
      .delete({ count: "exact" })
      .eq("key", key);
    if (error) {
      throw ApiError.upstream(
        isMissingSchema(error)
          ? `Cannot reset prompts: the prompt_templates table is missing (${error.message}) — apply ${REVIEW_FLOW_MIGRATION}`
          : `Failed to reset prompt ${key}: ${error.message}`,
      );
    }
    return Boolean(count);
  },
};
