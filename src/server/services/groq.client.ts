import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  /** GPT-OSS bills reasoning inside the completion budget — useful for tuning. */
  reasoning_tokens?: number;
}

export interface GroqResult<T> {
  data: T;
  raw: string;
  usage: GroqUsage | null;
  model: string;
  /** The effort actually sent: the client tunes it down when the budget is tight. */
  reasoningEffort: ReasoningEffort;
  /** The completion budget actually sent (TPM-clamped, may be resized after a 413). */
  completionBudget: number;
}

/**
 * Minimal Groq client (OpenAI-compatible) — no SDK dependency, JSON mode on.
 * Uses `response_format: json_object`, so the model must return one object.
 */
export async function groqJson<T = Record<string, unknown>>({
  messages,
  temperature = 0.4,
  maxTokens,
  reasoningEffort: reasoningEffortOverride,
  schemaHint,
  model: modelOverride,
  apiKey: apiKeyOverride,
}: {
  messages: GroqMessage[];
  temperature?: number;
  /** Defaults to `GROQ_MAX_TOKENS`, clamped to the TPM allowance. */
  maxTokens?: number;
  /**
   * Overrides `GROQ_REASONING_EFFORT`. "low" is fast and cheap but terser;
   * "medium"/"high" write longer documents but burn the completion budget on
   * thinking first.
   */
  reasoningEffort?: ReasoningEffort;
  schemaHint?: string;
  /** Overrides `GROQ_MODEL` for this call. */
  model?: string;
  /**
   * Overrides `GROQ_API_KEY`. The settings page stores keys in Postgres, so
   * the chain passes the resolved credential explicitly instead of re-reading
   * the environment here.
   */
  apiKey?: string;
}): Promise<GroqResult<T>> {
  const {
    apiKey: configuredApiKey,
    model: configuredModel,
    baseUrl,
    timeoutMs,
    maxTokens: configuredMax,
    tokensPerMinute,
    reasoningEffort: configuredEffort,
  } = groqConfig();
  const apiKey = apiKeyOverride ?? configuredApiKey;
  const model = modelOverride ?? configuredModel;
  const reasoningEffort = reasoningEffortOverride ?? configuredEffort;
  // A request whose prompt + completion budget passes the tier's TPM allowance
  // comes back as 413, so start under it: ~4 characters per token for the prompt.
  const promptEstimate = Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
  let completionBudget = Math.min(
    maxTokens ?? configuredMax,
    Math.max(1024, tokensPerMinute - promptEstimate - 256),
  );
  // GPT-OSS spends the same completion budget on hidden reasoning as on the
  // document itself, and this tier allows ~8,000 tokens per minute all-in. When
  // the room left after the prompt is small, reasoning has to give way to the
  // answer or the JSON never lands. An explicit per-run effort is always
  // honoured; the configured default is what gets tuned down.
  const autoEffort = (budget: number): ReasoningEffort =>
    budget < 2600 ? "none" : budget < 4200 ? "low" : reasoningEffort;
  let effort: ReasoningEffort = reasoningEffortOverride ?? autoEffort(completionBudget);
  if (!apiKey) {
    throw ApiError.internal(
      "GROQ_API_KEY is not configured — cannot generate proposals. Add it to .env.local.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  type BodyVariant = { tokenParam: "max_completion_tokens" | "max_tokens"; reasoning: boolean };
  // Compatibility ladder: Groq's current names first, then the legacy/less
  // capable shapes, so a proxy or older gateway still gets a usable request.
  const VARIANTS: BodyVariant[] = [
    { tokenParam: "max_completion_tokens", reasoning: true },
    { tokenParam: "max_tokens", reasoning: true },
    { tokenParam: "max_tokens", reasoning: false },
  ];

  const bodyFor = (temp: number, variant: BodyVariant, override?: ReasoningEffort) => {
    // A retry may force a different effort than the budget-derived default.
    const used = override ?? effort;
    // gpt-oss accepts low/medium/high (and its own "auto"); `none` and
    // `minimal` are answered with a 400 that names no parameter we could walk
    // down the ladder for. Dropping the field is how you ask for no reasoning.
    const sendable = variant.reasoning && SENDABLE_EFFORT.has(used);
    return JSON.stringify({
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
      // `max_tokens` is the legacy alias of `max_completion_tokens`.
      [variant.tokenParam]: completionBudget,
      // GPT-OSS spends part of the completion budget on hidden reasoning; on a
      // tight allowance it is dropped so the visible document actually finishes.
      ...(sendable ? { reasoning_effort: used } : {}),
      response_format: { type: "json_object" },
    });
  };

  try {
    // Groq's own body names the offending model, which is the only way to tell
    // a retired `GROQ_MODEL` apart from a wrong `GROQ_API_BASE_URL`.
    const describe = (status: number, text: string) =>
      `Groq returned ${status}${
        status === 401
          ? " — check GROQ_API_KEY (and rotate it if it was ever shared)"
          : status === 404
            ? ` — model "${model}" not found at ${baseUrl} (set GROQ_MODEL to a current one)`
            : status === 413
              ? ` — the request exceeds your ${tokensPerMinute} tokens-per-minute allowance (GROQ_TOKENS_PER_MINUTE); lower GROQ_MAX_TOKENS or upgrade the tier`
              : status === 429
                ? dailyLimit(text)
                  ? " — the DAILY token limit (TPD) for this model is spent; it resets at midnight UTC, so upgrade the Groq tier or generate fewer documents today. Retrying now cannot help."
                  : " — Groq's per-minute window is full; retry in a moment or generate fewer leads at once"
                : ""
      }${text ? ` :: ${text.slice(0, 220)}` : ""}`;

    const send = async (
      temp: number,
      variant: BodyVariant,
      override?: ReasoningEffort,
    ) => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: bodyFor(temp, variant, override),
      });
      const text = response.ok ? "" : await response.text().catch(() => "");
      return { response, text };
    };

    let attempt = await send(temperature, VARIANTS[0]!);
    let response = attempt.response;
    let text = attempt.text;

    // A 400 that names a parameter means the endpoint is older than the body we
    // sent — walk down the ladder instead of failing the generation.
    const paramProblem =
      /max_completion_tokens|reasoning_effort|unknown (parameter|field)|unexpected (parameter|field)|unsupported parameter|not supported/i;
    for (let index = 1; !response.ok && response.status === 400 && paramProblem.test(text) && index < VARIANTS.length; index += 1) {
      logger.warn("groq_request_body_fallback", { model, variant: VARIANTS[index] });
      attempt = await send(temperature, VARIANTS[index]!);
      response = attempt.response;
      text = attempt.text;
    }

    // A 429 on this tier means the per-minute token window is full — usually
    // because we just generated several leads in a row. The window rolls over, so
    // wait it out (respecting Retry-After) instead of failing the lead. A DAILY
    // limit (TPD) is different: it only resets at midnight UTC, so waiting 15 s
    // three times burns the same tokens again and still fails.
    for (
      let attempt = 0;
      !response.ok && response.status === 429 && attempt < 3 && !dailyLimit(text);
      attempt += 1
    ) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : 5_000 * (attempt + 1);
      logger.warn("groq_rate_limited_wait", { model, waitMs, attempt: attempt + 1 });
      await sleep(waitMs);
      const retry = await send(temperature, VARIANTS[0]!);
      response = retry.response;
      text = retry.text;
    }

    // A 413 names the real allowance and the size it rejected, which is the only
    // accurate way to resize the completion budget — retry once with that math.
    if (!response.ok && response.status === 413) {
      const limit = Number(/Limit (\d+)/i.exec(text)?.[1] ?? 0);
      const requested = Number(/Requested (\d+)/i.exec(text)?.[1] ?? 0);
      if (limit > 0) {
        const promptPart = requested > completionBudget ? requested - completionBudget : promptEstimate;
        const resized = Math.max(1024, limit - promptPart - 128);
        if (resized < completionBudget) {
          logger.warn("groq_tpm_resize", { model, limit, requested, completionBudget, resized });
          completionBudget = resized;
          // Fewer tokens left means reasoning has to give way as well.
          if (!reasoningEffortOverride) effort = autoEffort(resized);
          const retry = await send(temperature, VARIANTS[0]!);
          response = retry.response;
          text = retry.text;
        }
      }
    }

    // json_object mode intermittently answers a valid prompt with
    // "Failed to generate/validate JSON" and an empty generation. Two backed-off
    // retries: cooler first, then cooler + low reasoning (the long structured
    // brief is what trips the validator, and reasoning competes with it for the
    // same completion budget).
    const jsonModeProblem = /failed to (generate|validate) json|json_validate_failed/i;
    const recoveries: Array<{ temp: number; effort?: ReasoningEffort; waitMs: number }> = [
      { temp: Math.min(temperature, 0.2), waitMs: 1200 },
      { temp: 0.1, effort: "low", waitMs: 2500 },
      { temp: 0.1, effort: "none", waitMs: 3000 },
    ];
    for (const recovery of recoveries) {
      if (response.ok || response.status !== 400 || rateLimited(text) || !jsonModeProblem.test(text)) break;
      logger.warn("groq_json_mode_retry", { model, effort: recovery.effort ?? "env", temp: recovery.temp });
      await sleep(recovery.waitMs);
      const retry = await send(recovery.temp, VARIANTS[0]!, recovery.effort);
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
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      model?: string;
    };

    const raw = payload.choices?.[0]?.message?.content ?? "";
    if (!raw) throw ApiError.upstream("Groq returned an empty completion");

    let data: T;
    try {
      data = JSON.parse(stripFences(raw)) as T;
    } catch {
      logger.error("groq_json_parse_failed", { raw: raw.slice(0, 500) });
      throw ApiError.upstream(
        payload.choices?.[0]?.finish_reason === "length"
          ? `Groq hit the ${completionBudget}-token completion limit before finishing the JSON — raise GROQ_MAX_TOKENS.`
          : "Groq returned JSON we could not parse",
      );
    }

    return {
      data,
      raw,
      model: payload.model ?? model,
      reasoningEffort: effort,
      completionBudget,
      usage:
        payload.usage?.prompt_tokens !== undefined
          ? {
              prompt_tokens: payload.usage.prompt_tokens,
              completion_tokens: payload.usage.completion_tokens ?? 0,
              ...(payload.usage.completion_tokens_details?.reasoning_tokens !== undefined
                ? {
                    reasoning_tokens:
                      payload.usage.completion_tokens_details.reasoning_tokens,
                  }
                : {}),
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

/**
 * The effort values this model actually accepts. Anything else must be sent as
 * "no reasoning_effort at all", not as the word the caller used.
 */
const SENDABLE_EFFORT = new Set<ReasoningEffort>(["low", "medium", "high"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Groq answers `rate_limit_exceeded` for both the rolling per-minute window and
 * the daily ceiling. Only the per-minute one is worth waiting for, so the body
 * text decides: TPD means the day is done, RPM/TPM means seconds.
 */
function dailyLimit(body: string) {
  return /tokens per day|\(TPD\)/i.test(body);
}

function rateLimited(body: string) {
  return /rate_limit_exceeded|limit reached|tokens per (day|minute|hour)/i.test(body);
}
