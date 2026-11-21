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
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  // Optional shared secret guarding the /api routes
  API_MASTER_KEY: z.string().min(12).optional(),

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

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = ServerEnvSchema.safeParse(process.env);
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
function enforceProviderContracts(env: ServerEnv): ServerEnv {
  if (env.EMAIL_PROVIDER === "resend" && !env.RESEND_API_KEY) {
    throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
  }
  if (env.EMAIL_PROVIDER === "smtp" && !env.SMTP_HOST) {
    throw new Error("EMAIL_PROVIDER=smtp requires SMTP_HOST");
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
