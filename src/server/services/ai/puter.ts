import { logger } from "@/lib/logger";
import { ApiError } from "@/server/http/errors";
import type { AiMessage, AiResult, AiUsage } from "@/server/services/ai/types";

/**
 * Puter.js from the server, without the SDK.
 *
 * `puter.ai.chat()` in a browser authenticates the *visitor*; on a server there
 * is no visitor, so the SDK's Node entry point takes an auth token and calls the
 * same endpoint the bundle calls:
 *
 *   POST {origin}/drivers/call
 *   content-type: text/plain;actually=json     (their driver contract, not a typo)
 *   { interface, driver, method, args, auth_token }
 *
 * Speaking that directly rather than importing `@heyputer/puter.js` keeps this
 * file dependency-free like the Groq client, works in a Vercel server function
 * (the SDK's Node entry runs its browser bundle inside `node:vm` and reads it
 * off disk, which the serverless trace does not always carry), and keeps the
 * token out of any client bundle by construction — this module is server-only.
 */

const IFACE = "puter-chat-completion";
const DRIVER = "ai-chat";
/** Their gateway rejects `application/json` on this route; it wants this exact string. */
const DRIVER_CONTENT_TYPE = "text/plain;actually=json";

/** Puter's own error codes, which decide whether waiting, switching model or giving up helps. */
type PuterErrorCode =
  | "token_auth_failed"
  | "insufficient_funds"
  | "too_many_requests"
  | "rate_limited"
  | "model_not_found"
  | "invalid_input"
  | string;

interface PuterErrorBody {
  error?: string;
  message?: string;
  code?: PuterErrorCode;
}

/** One generation attempt against one model. */
interface CallArgs {
  messages: AiMessage[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  /**
   * Ask for the OpenAI response shape regardless of the model's release date,
   * so one parser covers the primary model and the fallback.
   */
  normalize?: boolean;
}

export interface PuterRequest {
  messages: AiMessage[];
  model: string;
  fallbackModel?: string;
  temperature?: number;
  maxTokens: number;
  reasoningEffort?: string;
  origin: string;
  token: string;
  timeoutMs: number;
  /** Puter's no-credit test path — used by the suite, never in production. */
  testMode?: boolean;
}

/**
 * `puter.ai.chat()` with a JSON body expected back.
 *
 * The ladder is short on purpose: a model that refuses a proposal brief is
 * switched for the fallback once, and a second refusal is reported instead of
 * burning the caller's allowance on a prompt that clearly will not answer.
 */
export async function puterJson<T = Record<string, unknown>>(
  request: PuterRequest,
): Promise<AiResult<T>> {
  const models = [request.model];
  if (request.fallbackModel && request.fallbackModel !== request.model) {
    models.push(request.fallbackModel);
  }

  let lastError = "";
  for (const [index, model] of models.entries()) {
    try {
      return await completeOnce<T>({ ...request, model });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Only a refusal or an unknown model justifies spending the account's
      // credit on a different model; auth and billing errors will not change.
      const switchable =
        error instanceof PuterCallError &&
        (error.code === "content_filter" ||
          error.code === "model_not_found" ||
          error.status === 404 ||
          error.status >= 500);
      if (!switchable || index === models.length - 1) throw error;
      logger.warn("puter_model_fallback", { from: model, to: models[index + 1], error: lastError });
    }
  }

  throw ApiError.upstream(`Puter call failed: ${lastError || "no model answered"}`);
}

/** A Puter error we can act on: the code decides retry vs. switch vs. stop. */
class PuterCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: PuterErrorCode,
  ) {
    super(message);
    this.name = "PuterCallError";
  }
}

async function completeOnce<T>(request: PuterRequest): Promise<AiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const args: CallArgs = {
    messages: request.messages,
    model: request.model,
    // 0 is a real temperature; `undefined` means "the model's own default".
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    max_tokens: request.maxTokens,
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    normalize: true,
  };

  const body = JSON.stringify({
    interface: IFACE,
    driver: DRIVER,
    method: "complete",
    ...(request.testMode ? { test_mode: true } : {}),
    args,
    auth_token: request.token,
  });

  let response: Response;
  try {
    response = await fetch(`${request.origin.replace(/\/+$/, "")}/drivers/call`, {
      method: "POST",
      headers: { "content-type": DRIVER_CONTENT_TYPE, accept: "application/json" },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw ApiError.upstream(
      controller.signal.aborted
        ? `Puter timed out after ${request.timeoutMs}ms (model ${request.model})`
        : `Puter request failed: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  // Read once, then branch: a driver error and a driver answer arrive as the
  // same kind of body, and the status alone does not say which one this is.
  const text = await response.text().catch(() => "");
  if (!response.ok) throw describeFailure(response, text, request);

  const payload = parseBody(text || "{}", response) as PuterResponse;
  const raw = contentText(payload);
  if (!raw) {
    throw new PuterCallError(
      payload.finish_reason === "content_filter"
        ? `Puter model ${request.model} declined this prompt (content_filter) — the fallback model will be tried`
        : `Puter model ${request.model} returned no text (finish_reason: ${payload.finish_reason ?? "unknown"})`,
      response.status,
      payload.finish_reason === "content_filter" ? "content_filter" : "empty_completion",
    );
  }

  let data: T;
  try {
    data = JSON.parse(stripFences(raw)) as T;
  } catch {
    logger.error("puter_json_parse_failed", { model: request.model, raw: raw.slice(0, 500) });
    throw ApiError.upstream(
      payload.finish_reason === "length"
        ? `Puter model ${request.model} hit the ${request.maxTokens}-token cap before finishing the JSON — raise AI_MAX_TOKENS.`
        : `Puter model ${request.model} returned text we could not parse as JSON`,
    );
  }

  return {
    data,
    raw,
    provider: "puter",
    model: request.model,
    usage: usageOf(payload),
    completionBudget: request.maxTokens,
    finishReason: payload.finish_reason ?? null,
  };
}

/** Wire response, narrowed to what this client reads. */
interface PuterResponse {
  message?: { content?: string | Array<{ type?: string; text?: string }> };
  /** Normalized responses use the OpenAI vocabulary; older ones may not. */
  finish_reason?: string;
  usage?: Record<string, number | undefined> & { cost?: number };
  usageDetails?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
  };
}

function parseBody(text: string, response: Response): PuterResponse {
  try {
    return JSON.parse(text) as PuterResponse;
  } catch {
    throw ApiError.upstream(
      `Puter answered HTTP ${response.status} with something that is not JSON: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * `message.content` is a string on a normalized response and an array of
 * content blocks on a vendor-native one. Both are handled because a fallback
 * model served by a different provider can arrive either way.
 */
function contentText(payload: PuterResponse): string {
  const content = payload.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("")
      .trim();
  }
  return "";
}

/**
 * Provider-neutral counts. `usageDetails` carries the same numbers under fixed
 * names for every provider, which is why it is preferred over `usage` — whose
 * keys differ between OpenAI-style and Anthropic-style answers.
 *
 * `usage.cost` is what Puter charged the account in microcents ($0.01 = 1e6),
 * so the number reported here is the real bill rather than a list-price guess.
 */
function usageOf(payload: PuterResponse): AiUsage | null {
  const details = payload.usageDetails;
  const usage = payload.usage;
  const prompt = details?.inputTokens ?? num(usage?.prompt_tokens) ?? num(usage?.input_tokens);
  const completion =
    details?.outputTokens ?? num(usage?.completion_tokens) ?? num(usage?.output_tokens);
  if (prompt === undefined && completion === undefined) return null;
  const costMicrocents = num(usage?.cost);
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    ...(details?.reasoningTokens !== undefined || num(usage?.reasoning_tokens) !== undefined
      ? { reasoning_tokens: details?.reasoningTokens ?? num(usage?.reasoning_tokens) }
      : {}),
    // USD actually charged to the Puter account; 0 means a free model or test mode.
    ...(costMicrocents !== undefined ? { cost_usd: costMicrocents / 1_000_000 } : {}),
  };
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Turn a gateway failure into a sentence that says what to do next. */
function describeFailure(response: Response, text: string, request: PuterRequest) {
  let body: PuterErrorBody = {};
  try {
    body = JSON.parse(text) as PuterErrorBody;
  } catch {
    /* an HTML error page from a proxy: fall through to the status */
  }
  const code = body.code ?? body.error ?? "unknown";
  const detail = (body.message ?? body.error ?? text).slice(0, 220);

  const guidance: Record<string, string> = {
    token_auth_failed:
      "PUTER_AUTH_TOKEN is wrong or revoked — run `puter login` again and copy the new token into .env.local or /settings/models",
    insufficient_funds:
      "the Puter account has spent its monthly allowance — top it up at puter.com/dashboard#billing, or keep GROQ_API_KEY / GEMINI_API_KEY configured so the chain falls through to them",
    email_must_be_confirmed:
      "the Puter account's email is not confirmed, so the API refuses it — confirm it in the Puter dashboard",
    model_not_found: `PUTER_MODEL="${request.model}" is not available on this account`,
    too_many_requests: `rate limited by Puter (${request.model}) — generate a few leads at a time rather than a batch`,
  };

  const note = guidance[code] ?? `returned HTTP ${response.status}`;
  logger.error("puter_request_failed", {
    status: response.status,
    code,
    model: request.model,
    body: detail,
  });

  // 402 and 401 are configuration problems, not upstream faults: a 502 would
  // tell the operator to wait, when what they must do is fix the account.
  // 401/402 are the account's own sentence; everything else carries the body.
  if (response.status === 401 || response.status === 402) {
    return new PuterCallError(`Puter: ${note}`, response.status, code);
  }
  return new PuterCallError(
    `Puter ${note}${detail ? ` :: ${detail}` : ""}`,
    response.status,
    code,
  );
}

function stripFences(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

/** Exported for the tests that assert the failure ladder without a network. */
export const __test = { contentText, usageOf, PuterCallError };
