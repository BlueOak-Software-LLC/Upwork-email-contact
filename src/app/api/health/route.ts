import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { getEnvDiagnostics, getServerEnv, supabaseKeyKind } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";
import { resolveEmailProvider } from "@/server/services/email-registry";
import { aiStatus } from "@/server/services/ai";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 * Liveness + dependency probe (Vercel monitoring / uptime checks / your own script).
 */
export const GET = withApi(async () => {
  const env = getServerEnv();
  const keyKind = supabaseKeyKind(env.SUPABASE_SERVICE_ROLE_KEY);
  // `anon`/`publishable` keys obey RLS, so reads return nothing and writes fail.
  const bypassesRls = keyKind === "secret" || keyKind === "legacy-jwt";

  const supabase = getAdminClient();
  const { error } = await supabase.from("contacts").select("id", { count: "exact", head: true });

  return ok({
    status: error || !bypassesRls ? "degraded" : "ok",
    time: new Date().toISOString(),
    version: process.env.npm_package_version ?? "0.1.0",
    env: env.NODE_ENV,
    emailProvider: resolveEmailProvider().name,
    // Which model writes proposals, and whether it can be reached: the two
    // things that explain a failed "Generate PPD" click.
    ai: await aiStatus(),
    checks: {
      supabase: error ? { ok: false, error: error.message } : { ok: true },
      // Distinguishes "database is empty" from "we are not allowed to see it".
      serviceKey: { kind: keyKind, bypassesRls },
      warnings: getEnvDiagnostics(),
    },
  });
});
