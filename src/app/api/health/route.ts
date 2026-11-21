import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { getServerEnv } from "@/lib/env";
import { getAdminClient } from "@/lib/supabase/admin";
import { resolveEmailProvider } from "@/server/services/email-registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 * Liveness + dependency probe (Vercel monitoring / uptime checks / your own script).
 */
export const GET = withApi(async () => {
  const supabase = getAdminClient();
  const { error } = await supabase.from("contacts").select("id", { count: "exact", head: true });

  return ok({
    status: error ? "degraded" : "ok",
    time: new Date().toISOString(),
    version: process.env.npm_package_version ?? "0.1.0",
    env: getServerEnv().NODE_ENV,
    emailProvider: resolveEmailProvider().name,
    checks: {
      supabase: error ? { ok: false, error: error.message } : { ok: true },
    },
  });
});
