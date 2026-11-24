import { z } from "zod";
import {
  DEFAULT_PROVIDER_ORDER,
  parseProviderOrder,
  type AiProviderId,
} from "@/lib/ai-models";

/**
 * Server-only environment access.
 *
 * - Validated once, lazily (so `next build` on a branch without secrets does
 *   not crash, and errors point at the exact missing variable).
 * - `NEXT_PUBLIC_*` values are re-exported for the browser from
 *   `lib/supabase/client.ts` style helpers instead of being imported here.
 */

const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === "" ? fallback : /^(1|true|yes|on)$/i.test(v),
    );

const ServerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(10),
  // Both names are accepted: `SUPABASE_SECRET_KEY` is the name Vercel's Supabase
  // Integration injects. The resolved value always lands on
  // `SUPABASE_SERVICE_ROLE_KEY` (see `enforceProviderContracts`).
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(),
  SUPABASE_SECRET_KEY: z.string().min(10).optional(),

  // Optional shared secret guarding the /api routes
  API_MASTER_KEY: z.string().min(12).optional(),

  // Encrypts sender-account SMTP passwords before they are stored in Postgres
  APP_ENCRYPTION_KEY: z.string().min(16).optional(),

  // ── Proposal generation: which AI answers the prompt ──────────────────────
  // `auto` walks AI_PROVIDER_ORDER and answers with the first provider that has
  // a credential: Puter, then Groq, then Gemini. A provider with no key is
  // skipped entirely, so a deployment can configure one, two or all three.
  AI_PROVIDER: z.enum(["auto", "puter", "groq", "gemini", "none"]).default("auto"),
  /**
   * What answers when the preferred provider fails — a spent allowance, a
   * revoked token, a 429, a gateway outage, a refusal. `auto` keeps walking the
   * ladder; `none` makes a failure stay a failure.
   */
  AI_FALLBACK_PROVIDER: z.enum(["auto", "puter", "groq", "gemini", "none"]).default("auto"),
  /**
   * The fallback ladder, in order. The requested default is Puter → Groq →
   * Gemini, and any provider without a credential is skipped rather than
   * attempted. Editable without a code change.
   */
  AI_PROVIDER_ORDER: z.string().default("puter,groq,gemini"),
  /**
   * Wall clock for the whole generation, including a fallback attempt. Two
   * frontier calls in a row must still fit inside the route's `maxDuration`,
   * so the chain gets a shared deadline rather than each leg its own.
   */
  AI_MAX_TOTAL_MS: z.coerce.number().int().min(20_000).max(300_000).default(110_000),
  /** A leg with less time left than this is skipped rather than half-tried. */
  AI_MIN_ATTEMPT_MS: z.coerce.number().int().min(5_000).max(60_000).default(20_000),
  /**
   * A Puter auth token (`puter login` prints it; the CLI also reads
   * PUTER_AUTH_TOKEN). It belongs to a Puter account, and that account is
   * billed for the usage — the User-Pays model, so this app holds no AI key of
   * its own and Groq's free-tier ceiling stops being the limit on how many
   * proposals you can write in a day.
   */
  PUTER_AUTH_TOKEN: z.string().min(8).optional(),
  PUTER_API_ORIGIN: z.string().url().default("https://api.puter.com"),
  /**
   * Free Puter model: Nemotron 3 Ultra 550B on OpenRouter's `:free` tier. 1M
   * context and 64K output fit a full PPD, and the model is large enough to be
   * upper-middle quality — no per-token charge on the Puter account. The
   * settings page can override this without a redeploy.
   */
  PUTER_MODEL: z.string().default("openrouter:nvidia/nemotron-3-ultra-550b-a55b:free"),
  /** Second free model tried when the first refuses or is unavailable. */
  PUTER_FALLBACK_MODEL: z.string().default("openrouter:nvidia/nemotron-3.5-lightning:free"),
  /** Completion budget for either provider (was GROQ_MAX_TOKENS). */
  AI_MAX_TOKENS: z.coerce.number().int().min(512).max(65_536).optional(),
  /**
   * Wall-clock budget for one generation call. Frontier writing models are
   * slower than Groq's ASICs, and a 12k-token document takes real time — but
   * this must stay under the route's `maxDuration` (120 s), or the platform
   * kills the function and the lead keeps no reason why.
   */
  AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(115_000).default(105_000),

  // Groq — proposal generation. `llama-3.3-70b-versatile` was retired upstream
  // (404 model_not_found), so the default is a model verified against the API.
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  // Retries share one abort timer: medium reasoning takes ~20 s per attempt on
  // this model, so the budget has to cover a retry pair.
  GROQ_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),
  /**
   * Completion budget for the ONE call that returns both the PPD and the email.
   * GPT-OSS bills its *reasoning* against this same cap — a measured run spent
   * 6,296 of 8,000 tokens thinking before writing ~950 words — so the default
   * leaves real headroom (Groq allows up to 65,536 for gpt-oss-120b).
   */
  GROQ_MAX_TOKENS: z.coerce.number().int().min(512).max(65_536).default(12_000),
  /**
   * Your organization's tokens-per-minute allowance for GROQ_MODEL. A request
   * whose prompt + completion budget exceeds it is rejected with HTTP 413, so we
   * clamp the completion budget to fit. Free/developer tiers are commonly 8k.
   */
  GROQ_TOKENS_PER_MINUTE: z.coerce.number().int().min(1024).default(8_000),
  /**
   * `reasoning_effort` for GPT-OSS. Measured here: "low" ≈ 6 s / $0.0013 but a
   * 500-word document, "medium" ≈ 22 s / $0.0021 with fuller prose, unset
   * (model default) burned 6,296 reasoning tokens and hit the cap. "medium" is
   * the balance. Leave empty for models that do not accept the parameter.
   */
  GROQ_REASONING_EFFORT: z
    .enum(["none", "minimal", "low", "medium", "high"])
    .default("medium"),
  /** List price per million tokens (GPT-OSS 120B): used for cost logging only. */
  GROQ_PRICE_INPUT_PER_M: z.coerce.number().min(0).default(0.15),
  GROQ_PRICE_OUTPUT_PER_M: z.coerce.number().min(0).default(0.6),

  // Gemini — the last fallback. Free-tier `gemini-3.8-flash`; nothing is called
  // when GEMINI_API_KEY is absent, so this is safe to leave unset.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),
  PROPOSAL_LANGUAGE: z.string().default("English"),
  /**
   * Branding stamped onto every PPD. These win over whatever the model wrote,
   * so the LLM is never allowed to state our own company details.
   */
  PROPOSAL_COMPANY: z.string().max(120).default(""),
  PROPOSAL_WEBSITE: z.string().max(200).default(""),
  PROPOSAL_PREPARED_BY: z.string().max(120).default(""),
  /** Writer's role, printed under the name in the PDF and the email sign-off. */
  PROPOSAL_TITLE: z.string().max(120).default(""),
  /** e.g. "USD 45–65/hour — indicative, confirmed after a scoping call". */
  PROPOSAL_RATE: z.string().max(160).default(""),
  /**
   * Off by default: writing a proposal is a decision, not a side effect of a
   * payload arriving. A lead is stored as `received`, and the reviewer clicks
   * "Generate PPD" on the lead page (or POSTs /api/leads/:id/generate). Turn
   * this on only if you want the old ingest-writes-documents behaviour back.
   */
  AUTO_ENRICH_LEADS: booleanish(false),

  // Proposal PDF rendering
  PDF_PROVIDER: z.enum(["pdfme", "none"]).default("pdfme"),
  PDFME_TEMPLATE_PATH: z.string().default("templates/pdfme/proposal-template.json"),

  // Email
  EMAIL_PROVIDER: z.enum(["resend", "smtp", "log"]).default("log"),
  EMAIL_FROM: z.string().min(3).default('"Outreach" <onboarding@resend.dev>'),
  EMAIL_REPLY_TO: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: booleanish(false),

  // Email tracking (open pixel + link clicks) — see 0005_email_tracking.sql
  /**
   * Master switch. A no-op whenever `EMAIL_PROVIDER=log`, because nothing
   * reaches an inbox in a dry run and a pixel that nobody can load is a lie.
   */
  EMAIL_TRACKING: booleanish(true),
  /** Rewrite destinations in the body to `/c/<token>`. Opens work without it. */
  LINK_TRACKING: booleanish(true),
  /**
   * Public HTTPS origin that serves `/o/*` and `/c/*`. Must be this app.
   * Falls back to `NEXT_PUBLIC_APP_URL`. Unsetting it after a send is not
   * cosmetic: every already-delivered email keeps the original URLs.
   */
  TRACKING_DOMAIN: z.string().url().optional(),
  /** Days of `open`/`click` rows kept before `purge_tracking_events` deletes them. */
  TRACKING_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(365),
  /**
   * Guards the retention purge when a scheduler calls it. Generate with
   * `openssl rand -hex 32`; it is never logged and never sent to the browser.
   */
  CRON_SECRET: z.string().min(8).optional(),

  // App
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info"),
});

type RawServerEnv = z.infer<typeof ServerEnvSchema>;

/** Environment after the Supabase key alias above is resolved. */
export type ServerEnv = Omit<
  RawServerEnv,
  "SUPABASE_SERVICE_ROLE_KEY" | "SUPABASE_SECRET_KEY"
> & {
  SUPABASE_SERVICE_ROLE_KEY: string;
};

const envWarnings: string[] = [];

/** Non-fatal configuration problems found while validating the environment. */
export function getEnvDiagnostics(): string[] {
  return envWarnings;
}

export type SupabaseKeyKind =
  | "secret"
  | "publishable"
  | "legacy-jwt"
  | "anon"
  | "missing"
  | "unknown";

/**
 * Classify a Supabase key by its shape only — the key itself is never logged.
 * A publishable key in the service-role slot is the most common silent failure.
 */
export function supabaseKeyKind(value?: string): SupabaseKeyKind {
  if (!value) return "missing";
  if (value.startsWith("sb_publishable_")) return "publishable";
  if (value.startsWith("sb_secret_")) return "secret";
  if (value.length > 100) return "legacy-jwt";
  if (value.startsWith("eyJ")) return "anon";
  return "unknown";
}

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  // Blank values in `.env.local` (``API_MASTER_KEY=``, ``GROQ_API_KEY=`` …) mean
  // "not configured yet", not "a empty string" — drop them before validating,
  // otherwise optional fields fail their own constraints and the whole app 500s.
  const envSource = Object.fromEntries(
    Object.entries(process.env).filter(
      ([, value]) => value !== undefined && String(value).trim() !== "",
    ),
  );

  const parsed = ServerEnvSchema.safeParse(envSource);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment configuration.\n${issues.join("\n")}\n\n` +
        `Copy .env.example to .env.local (or set Vercel env vars) and fill the values above.`,
    );
  }

  cached = enforceProviderContracts(parsed.data);
  return cached;
}

/** Fail fast on provider combinations that would silently drop email. */
function enforceProviderContracts(raw: RawServerEnv): ServerEnv {
  const key = raw.SUPABASE_SERVICE_ROLE_KEY ?? raw.SUPABASE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "No Supabase server key: set SUPABASE_SERVICE_ROLE_KEY to the project's secret key " +
        "(sb_secret_…), or link the Vercel Supabase Integration so SUPABASE_SECRET_KEY is provided.",
    );
  }
  const env: ServerEnv = { ...raw, SUPABASE_SERVICE_ROLE_KEY: key };

  if (
    supabaseKeyKind(key) === "publishable" ||
    key === env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    const msg =
      "SUPABASE_SERVICE_ROLE_KEY holds the publishable/anon key, so every server query runs " +
      "under row-level security: lists come back empty and inserts fail with \"violates " +
      "row-level security policy\". Set the secret key (Supabase → Project Settings → API Keys).";
    envWarnings.push(msg);
    console.warn("[env]", msg);
  }

  if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
    throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
  }
  if (env.EMAIL_PROVIDER === "smtp" && !env.SMTP_HOST) {
    throw new Error("EMAIL_PROVIDER=smtp requires SMTP_HOST");
  }
  if (!env.APP_ENCRYPTION_KEY) {
    // Sender-account passwords cannot be stored safely without it, but the app
    // still runs (env-based SMTP only) — so warn instead of throwing.
    const msg =
      "APP_ENCRYPTION_KEY unset: sender_accounts SMTP passwords cannot be saved. Set `openssl rand -hex 32`.";
    envWarnings.push(msg);
    console.warn("[env]", msg);
  }
  if (env.AUTO_ENRICH_LEADS && !env.PUTER_AUTH_TOKEN && !env.GROQ_API_KEY && !env.GEMINI_API_KEY) {
    envWarnings.push(
      "AUTO_ENRICH_LEADS is on but no AI credential is set in the environment: if none is saved on /settings/models either, ingested leads are stored without proposals — generate them from the lead page once a key exists.",
    );
  }
  if (env.AUTO_ENRICH_LEADS) {
    envWarnings.push(
      "AUTO_ENRICH_LEADS is on: every ingested payload spends tokens on a document nobody has read yet. Leave it off and generate per lead.",
    );
  }
  if (env.GROQ_MAX_TOKENS < 8000) {
    envWarnings.push(
      `GROQ_MAX_TOKENS=${env.GROQ_MAX_TOKENS} is tight: GPT-OSS bills reasoning against the same cap, so a 4–6 page document can run out mid-JSON.`,
    );
  }
  if (env.PDF_PROVIDER === "pdfme" && !env.PROPOSAL_COMPANY) {
    envWarnings.push(
      "PROPOSAL_COMPANY is unset: proposal PDFs fall back to the EMAIL_FROM display name for the header and footer branding.",
    );
  }
  const ai = aiResolution(env);
  if (ai.provider === "none" && ai.requested !== "none") {
    envWarnings.push(
      `No AI credential in the environment (${ai.reason}): leads are still stored, and "Generate PPD" needs a key in .env.local or saved on /settings/models (stored keys are read at request time).`,
    );
  } else if (ai.provider === "puter" && env.PUTER_FALLBACK_MODEL === env.PUTER_MODEL) {
    envWarnings.push("PUTER_FALLBACK_MODEL equals PUTER_MODEL: a refusal has nowhere to go.");
  }
  pushTrackingDiagnostics(env);
  return {
    ...env,
    EMAIL_REPLY_TO: env.EMAIL_REPLY_TO || undefined,
  };
}

/**
 * The origin baked into every pixel and redirect URL, and the honest state of
 * the tracking switch.
 *
 * `trackingEnabled()` is the single answer to "should this send be tracked":
 * it also refuses `log` mode, so a staging run cannot mint live tokens.
 */
export function trackingOrigin(env: ServerEnv = getServerEnv()): string {
  return (env.TRACKING_DOMAIN ?? env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
}

export function trackingEnabled(env: ServerEnv = getServerEnv()): boolean {
  return env.EMAIL_TRACKING && env.EMAIL_PROVIDER !== "log";
}

export function linkTrackingEnabled(env: ServerEnv = getServerEnv()): boolean {
  return trackingEnabled(env) && env.LINK_TRACKING;
}

function pushTrackingDiagnostics(env: ServerEnv) {
  if (!env.EMAIL_TRACKING) return;
  if (env.EMAIL_PROVIDER === "log") {
    envWarnings.push(
      "EMAIL_TRACKING is on but EMAIL_PROVIDER=log: no tracking tokens are minted, because a dry run delivers nothing that could load a pixel.",
    );
    return;
  }
  const origin = trackingOrigin(env);
  const local = /^(https?):\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(origin);
  if (local) {
    envWarnings.push(
      `Tracking origin is ${origin}: a real mailbox cannot reach it, so opens and clicks will never record. Set TRACKING_DOMAIN to the deployed HTTPS URL (curl -I https://<host>/api/health proves it is reachable).`,
    );
  } else if (origin.startsWith("http://")) {
    envWarnings.push(
      `TRACKING_DOMAIN is not HTTPS (${origin}): mail clients block mixed-content images, so the pixel will not load in a delivered email.`,
    );
  }
  if (env.LINK_TRACKING) {
    envWarnings.push(
      "LINK_TRACKING is on: destination URLs found in the email body are rewritten to /c/<token>. Links inside the proposal PDF are never rewritten.",
    );
  }
}

/** Values safe to ship to the browser. */
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
} as const;

/** Which provider will actually answer the next generation call, and why. */
export type AiProviderName = AiProviderId | "none";

export interface AiResolution {
  provider: AiProviderName;
  /** What `AI_PROVIDER` asked for (`auto` resolved to the provider below). */
  requested: "auto" | AiProviderId | "none";
  model: string;
  /** Set when the request could not be honoured, for the settings UI to show. */
  reason: string | null;
  /** Completion budget shared by the whole chain. */
  maxTokens: number;
}

/** Env-only credential check. The DB-backed resolver in `services/ai/config` supersedes it. */
function envHasCredential(env: ServerEnv, provider: AiProviderId): boolean {
  if (provider === "puter") return Boolean(env.PUTER_AUTH_TOKEN);
  if (provider === "groq") return Boolean(env.GROQ_API_KEY);
  return Boolean(env.GEMINI_API_KEY);
}

function envModelOf(env: ServerEnv, provider: AiProviderId): string {
  if (provider === "puter") return env.PUTER_MODEL;
  if (provider === "groq") return env.GROQ_MODEL;
  return env.GEMINI_MODEL;
}

/**
 * The single env-level answer to "what writes proposals here".
 *
 * `auto` walks `AI_PROVIDER_ORDER` (default Puter → Groq → Gemini) and picks the
 * first provider with a credential. This function can only see environment
 * variables; keys saved on /settings/models live in Postgres, so the async
 * `aiStatus()` in `services/ai` is the authoritative runtime view. Keeping this
 * one env-only means startup diagnostics stay synchronous.
 */
export function aiResolution(env = getServerEnv()): AiResolution {
  const maxTokens = env.AI_MAX_TOKENS ?? env.GROQ_MAX_TOKENS;
  const order = parseProviderOrder(env.AI_PROVIDER_ORDER || DEFAULT_PROVIDER_ORDER);

  const pick = (provider: AiProviderName, reason: string | null): AiResolution => ({
    provider,
    requested: env.AI_PROVIDER,
    model: provider === "none" ? "" : envModelOf(env, provider),
    reason,
    maxTokens,
  });

  if (env.AI_PROVIDER === "none") {
    return pick("none", "AI_PROVIDER=none — generation is disabled");
  }

  let candidates: AiProviderId[] =
    env.AI_PROVIDER === "auto"
      ? order
      : [env.AI_PROVIDER, ...order.filter((provider) => provider !== env.AI_PROVIDER)];

  if (env.AI_FALLBACK_PROVIDER === "none") {
    candidates = candidates.slice(0, 1);
  } else if (env.AI_FALLBACK_PROVIDER !== "auto") {
    const fallback = env.AI_FALLBACK_PROVIDER;
    candidates = [candidates[0]!, ...(candidates[0] === fallback ? [] : [fallback])];
  }

  const requested = candidates[0];
  const provider = candidates.find((candidate) => envHasCredential(env, candidate));

  if (!provider) {
    const envVar = requested === "puter" ? "PUTER_AUTH_TOKEN" : requested === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
    return pick(
      "none",
      requested && candidates.length === 1 && env.AI_PROVIDER !== "auto"
        ? `${envVar} is not set`
        : "No AI provider has a credential — set PUTER_AUTH_TOKEN, GROQ_API_KEY or GEMINI_API_KEY",
    );
  }

  if (provider === requested) return pick(provider, null);

  const missing =
    requested === "puter" ? "PUTER_AUTH_TOKEN" : requested === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
  return pick(provider, `${missing} is not set — ${provider} answers instead`);
}

/** True when some provider can answer a generation call right now. */
export function aiConfigured(env = getServerEnv()) {
  return aiResolution(env).provider !== "none";
}
