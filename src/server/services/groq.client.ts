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
  model: modelOverride,
}: {
  messages: GroqMessage[];
  temperature?: number;
  maxTokens?: number;
  schemaHint?: string;
  /** Overrides `GROQ_MODEL` for this call. */
  model?: string;
}): Promise<GroqResult<T>> {
  const { apiKey, model: configuredModel, baseUrl, timeoutMs } = groqConfig();
  const model = modelOverride ?? configuredModel;
  if (!apiKey) {
    throw ApiError.internal(
      "GROQ_API_KEY is not configured — cannot generate proposals. Add it to .env.local.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const bodyFor = (temp: number) =>
    JSON.stringify({
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
      temperature: temp,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    });

  try {
    // Groq's own body names the offending model, which is the only way to tell
    // a retired `GROQ_MODEL` apart from a wrong `GROQ_API_BASE_URL`.
    const describe = (status: number, text: string) =>
      `Groq returned ${status}${
        status === 401
          ? " — check GROQ_API_KEY (and rotate it if it was ever shared)"
          : status === 404
            ? ` — model "${model}" not found at ${baseUrl} (set GROQ_MODEL to a current one)`
            : status === 429
              ? " — rate limited, retry shortly"
              : ""
      }${text ? ` :: ${text.slice(0, 220)}` : ""}`;

    const send = async (temp: number) => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: bodyFor(temp),
      });
      const text = response.ok ? "" : await response.text().catch(() => "");
      return { response, text };
    };

    let { response, text } = await send(temperature);

    // `json_object` mode intermittently refuses a valid prompt with
    // "Failed to generate JSON"; one cooler retry usually clears it.
    if (!response.ok && response.status === 400 && /failed to generate json/i.test(text)) {
      logger.warn("groq_json_mode_retry", { model });
      const retry = await send(Math.min(temperature, 0.2));
      response = retry.response;
      text = retry.text;
    }

    if (!response.ok) {
      logger.error("groq_request_failed", {
        status: response.status,
        model,
        baseUrl,
        body: text.slice(0, 400),
      });
      throw ApiError.upstream(describe(response.status, text));
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
