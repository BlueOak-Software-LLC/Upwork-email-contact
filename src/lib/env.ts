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

  // Prompts are rendered on the server but written in the signed-in ChatGPT
  // tab. The server holds no model credential.
  PROPOSAL_LANGUAGE: z.string().default("English"),
  /**
   * Fallback identity for a fresh install. The real writer identity comes from
   * Settings → Senders & profile; `PROPOSAL_COMPANY` is parsed for old env files
   * and is never printed on a PPD, PDF or email.
   */
  PROPOSAL_COMPANY: z.string().max(120).default(""),
  PROPOSAL_WEBSITE: z.string().max(200).default(""),
  PROPOSAL_PREPARED_BY: z.string().max(120).default(""),
  /** Writer's role, printed under the name in the PDF and the email sign-off. */
  PROPOSAL_TITLE: z.string().max(120).default(""),
  /** e.g. "USD 45–65/hour — indicative, confirmed after a scoping call". */
  PROPOSAL_RATE: z.string().max(160).default(""),
  /**
   * Deprecated and ignored by ingest. Writing a proposal is a decision, not a
   * side effect of a payload arriving: post a lead, then click "Generate PPD"
   * on the lead page (or POST /api/leads/:id/generate). `?auto=true` on
   * POST /api/leads remains the explicit opt-in for an automated caller.
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

  // Blank values in `.env.local` (``API_MASTER_KEY=`` …) mean
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
  if (env.AUTO_ENRICH_LEADS) {
    envWarnings.push(
      "AUTO_ENRICH_LEADS is ignored: ingest never generates a PPD automatically. Click Generate PPD on the lead (or send ?auto=true explicitly). You can remove the variable.",
    );
  }
  // No PROPOSAL_COMPANY warning: the PPD and email are signed by a person from
  // Settings → Senders & profile, and deliberately never print a company.
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
