import { z } from "zod";

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
  AUTO_ENRICH_LEADS: booleanish(true),

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
  if (env.AUTO_ENRICH_LEADS && !env.GROQ_API_KEY) {
    envWarnings.push(
      "AUTO_ENRICH_LEADS is on but GROQ_API_KEY is unset: ingested leads are stored without proposals — generate them from the lead page once the key is set.",
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
  return {
    ...env,
    EMAIL_REPLY_TO: env.EMAIL_REPLY_TO || undefined,
  };
}

/** Values safe to ship to the browser. */
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
} as const;
