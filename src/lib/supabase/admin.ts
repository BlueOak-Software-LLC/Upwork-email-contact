import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getServerEnv } from "@/lib/env";

let admin: SupabaseClient<Database> | null = null;

/**
 * Service-role client: BYPASSES Row Level Security.
 * Only import from `src/server/**` and `src/app/api/**` — never from a
 * component that can render on the client.
 *
 * Memoised per warm isolate (not per request) — safe because the client holds
 * no user state, only the service credential.
 */
export function getAdminClient(): SupabaseClient<Database> {
  if (admin) return admin;
  const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } =
    getServerEnv();
  admin = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-supabase-from": "upwork-email-contact" } },
  });
  return admin;
}
