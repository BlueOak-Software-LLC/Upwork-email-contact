import type { PromptTemplateDto } from "@/server/db/prompt-templates.repo";
import { promptTemplatesRepo } from "@/server/db/prompt-templates.repo";
import {
  DEFAULT_PROMPTS,
  PROMPT_KEYS,
  type PromptKey,
} from "./proposal.prompt";

/**
 * Prompt resolution + `{{variable}}` rendering.
 *
 * A stored row wins over the code default; "reset" deletes the row. Rendering
 * reports unknown slots instead of blanking them, so a typo in an edited
 * template shows up in the dashboard rather than silently removing the job
 * description from the request.
 */

export interface ResolvedPrompt extends PromptTemplateDto {
  key: PromptKey;
}

export async function resolvePrompt(key: PromptKey): Promise<ResolvedPrompt> {
  const fallback = DEFAULT_PROMPTS[key];
  const row = await promptTemplatesRepo.get(key);
  if (!row) return { ...fallback, isDefault: true, updatedAt: null };
  return {
    key,
    label: row.label || fallback.label,
    note: row.note ?? fallback.note,
    system: row.system_text,
    user: row.user_template,
    temperature: Number(row.temperature),
    maxTokens: row.max_tokens ?? null,
    reasoningEffort:
      row.reasoning_effort === "low" || row.reasoning_effort === "medium" || row.reasoning_effort === "high"
        ? row.reasoning_effort
        : null,
    isDefault: false,
    updatedAt: row.updated_at,
  };
}

export async function listPrompts(): Promise<ResolvedPrompt[]> {
  return Promise.all(PROMPT_KEYS.map((key) => resolvePrompt(key)));
}

export async function savePrompt(
  input: Parameters<typeof promptTemplatesRepo.save>[0],
): Promise<ResolvedPrompt> {
  await promptTemplatesRepo.save(input);
  return resolvePrompt(input.key);
}

export async function resetPrompt(key: PromptKey): Promise<ResolvedPrompt> {
  await promptTemplatesRepo.remove(key);
  return resolvePrompt(key);
}

const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Which variables a template actually uses (for the editor's hint list). */
export function usedVars(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_RE)].map((m) => m[1]!.toLowerCase()))];
}

export interface RenderedPrompt {
  text: string;
  /** `{{slots}}` in the template with no matching value — kept visible. */
  unknown: string[];
}

export function renderTemplate(template: string, vars: Record<string, string>): RenderedPrompt {
  const unknown = new Set<string>();
  const text = template.replace(VAR_RE, (whole, name: string) => {
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key] ?? "";
    unknown.add(key);
    return whole;
  });
  return { text, unknown: [...unknown] };
}

/** Render both halves of a prompt pair and surface unknown slots once. */
export function renderPromptPair(
  prompt: ResolvedPrompt,
  vars: Record<string, string>,
): { system: string; user: string; unknown: string[] } {
  const system = renderTemplate(prompt.system, vars);
  const user = renderTemplate(prompt.user, vars);
  return {
    system: system.text,
    user: user.text,
    unknown: [...new Set([...system.unknown, ...user.unknown])],
  };
}
