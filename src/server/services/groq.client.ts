import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqResult<T> {
  data: T;
  raw: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  model: string;
}

/**
 * Minimal Groq client (OpenAI-compatible) — no SDK dependency, JSON mode on.
 * Uses `response_format: json_object`, so the model must return one object.
 */
export async function groqJson<T = Record<string, unknown>>({
  messages,
  temperature = 0.4,
  maxTokens = 3000,
  schemaHint,
}: {
  messages: GroqMessage[];
  temperature?: number;
  maxTokens?: number;
  schemaHint?: string;
}): Promise<GroqResult<T>> {
  const { apiKey, model, baseUrl, timeoutMs } = groqConfig();
  if (!apiKey) {
    throw ApiError.internal(
      "GROQ_API_KEY is not configured — cannot generate proposals. Add it to .env.local.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: schemaHint
          ? [
              ...messages,
              {
                role: "system",
                content: `Respond with a single JSON object only, no markdown fences, matching exactly this shape:\n${schemaHint}`,
              },
            ]
          : messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.error("groq_request_failed", {
        status: response.status,
        model,
        body: text.slice(0, 400),
      });
      throw ApiError.upstream(
        `Groq returned ${response.status}${
          response.status === 401
            ? " — check GROQ_API_KEY (and rotate it if it was ever shared)"
            : response.status === 429
              ? " — rate limited, retry shortly"
              : ""
        }`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const raw = payload.choices?.[0]?.message?.content ?? "";
    if (!raw) throw ApiError.upstream("Groq returned an empty completion");

    let data: T;
    try {
      data = JSON.parse(stripFences(raw)) as T;
    } catch {
      logger.error("groq_json_parse_failed", { raw: raw.slice(0, 500) });
      throw ApiError.upstream("Groq returned JSON we could not parse");
    }

    return {
      data,
      raw,
      model: payload.model ?? model,
      usage:
        payload.usage?.prompt_tokens !== undefined
          ? {
              prompt_tokens: payload.usage.prompt_tokens,
              completion_tokens: payload.usage.completion_tokens ?? 0,
            }
          : null,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw ApiError.upstream(
      controller.signal.aborted
        ? `Groq timed out after ${timeoutMs}ms`
        : `Groq call failed: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function stripFences(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
