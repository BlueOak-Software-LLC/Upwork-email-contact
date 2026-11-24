import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import type { AiMessage, AiUsage } from "@/server/services/ai/types";

/**
 * Minimal Gemini client — `v1beta/models/<id>:generateContent`, no SDK.
 *
 * Gemini is the third rung of the ladder: it is only reached when Puter and
 * Groq are both unconfigured or both fail. The key therefore arrives from the
 * effective config (DB or env), never from `process.env` here, so a key saved
 * on /settings/models works without a restart.
 *
 * The wire shape differs from OpenAI's in three ways the caller must not care
 * about:
 *  - system messages are `systemInstruction`, not a `system` role;
 *  - the assistant role is called `model`;
 *  - JSON mode is a `responseMimeType` field, not `response_format`.
 */

export interface GeminiInput {
  messages: AiMessage[];
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface GeminiResult<T> {
  data: T;
  raw: string;
  model: string;
  usage: AiUsage | null;
  completionBudget: number;
  finishReason: string | null;
}

interface GeminiPayload {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

function stripFences(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

/**
 * Gemini rejects a conversation that starts with `model`, and some gateways
 * reject two consecutive turns with the same role. Merge neighbours so the
 * prompt shape is valid regardless of how the caller assembled it.
 */
function toContents(messages: AiMessage[]) {
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: message.content });
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }
  // A system-only prompt still needs a turn.
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Follow the system instruction." }] });
  }
  return contents;
}

function guidance(status: number, payload: GeminiPayload, model: string): string {
  const detail = payload.error?.message ?? "";
  if (status === 400) {
    if (/location is not supported/i.test(detail)) {
      return `Gemini cannot be called from this server's region (${detail}). Keep Puter or Groq configured as the answering provider, or deploy from a supported region.`;
    }
    return `Gemini rejected the request${detail ? ` — ${detail}` : ""}. Check GEMINI_API_KEY and the model id.`;
  }
  if (status === 403) {
    return `Gemini key is not authorised for ${model}. Enable the Generative Language API for this key.`;
  }
  if (status === 404) {
    return `Gemini model "${model}" was not found or is retired${detail ? ` — ${detail}` : ""}. Pick a current model on /settings/models.`;
  }
  if (status === 429) {
    return `Gemini free-tier quota is exhausted for ${model}. Wait for the daily reset or fall back manually.`;
  }
  if (status >= 500) {
    return `Gemini is unavailable (HTTP ${status}). The chain treats this as a failed leg.`;
  }
  return `Gemini returned HTTP ${status}${detail ? ` — ${detail}` : ""}`;
}

export async function geminiJson<T = Record<string, unknown>>(
  input: GeminiInput,
): Promise<GeminiResult<T>> {
  const { apiKey, model, maxTokens, timeoutMs, temperature = 0.4 } = input;
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header rather than ?key= so the secret never lands in a URL log.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: toContents(input.messages),
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      },
    );

    const text = await response.text();
    let payload: GeminiPayload = {};
    try {
      payload = text ? (JSON.parse(text) as GeminiPayload) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const message = guidance(response.status, payload, model);
      logger.error("gemini_request_failed", {
        status: response.status,
        model,
        detail: payload.error?.message ?? text.slice(0, 300),
      });
      throw ApiError.upstream(message);
    }

    const block = payload.promptFeedback?.blockReason;
    const candidate = payload.candidates?.[0];
    if (block || candidate?.finishReason === "SAFETY") {
      throw ApiError.upstream(`Gemini blocked this prompt (${block ?? "SAFETY"}).`);
    }

    const raw = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!raw) {
      throw ApiError.upstream(
        candidate?.finishReason === "MAX_TOKENS"
          ? `Gemini hit the ${maxTokens}-token output limit before writing anything — raise AI_MAX_TOKENS.`
          : "Gemini returned an empty completion",
      );
    }

    let data: T;
    try {
      data = JSON.parse(stripFences(raw)) as T;
    } catch {
      logger.error("gemini_json_parse_failed", { raw: raw.slice(0, 500) });
      throw ApiError.upstream(
        candidate?.finishReason === "MAX_TOKENS"
          ? `Gemini hit the ${maxTokens}-token output limit before finishing the JSON — raise AI_MAX_TOKENS.`
          : "Gemini returned JSON we could not parse",
      );
    }

    const usage = payload.usageMetadata
      ? {
          prompt_tokens: payload.usageMetadata.promptTokenCount ?? 0,
          completion_tokens: payload.usageMetadata.candidatesTokenCount ?? 0,
          ...(payload.usageMetadata.thoughtsTokenCount !== undefined
            ? { reasoning_tokens: payload.usageMetadata.thoughtsTokenCount }
            : {}),
        }
      : null;

    return {
      data,
      raw,
      model,
      usage,
      completionBudget: maxTokens,
      finishReason: candidate?.finishReason ?? null,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw ApiError.upstream(
      controller.signal.aborted
        ? `Gemini timed out after ${timeoutMs}ms`
        : `Gemini call failed: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
