import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { ApiError } from "@/server/http/errors";

export type AuthContext =
  | { kind: "service"; label: string }
  | { kind: "user"; id: string; email?: string }
  | { kind: "anonymous" };

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Two accepted credentials:
 *  1. `x-api-key` matching API_MASTER_KEY (server-to-server: scripts, Zapier, cron)
 *  2. a valid Supabase user session cookie (the dashboard itself)
 *
 * When API_MASTER_KEY is unset we run in "open dev" mode and accept everything,
 * which keeps `npm run dev` friction-free. Production builds must set it
 * (`requireApiKey` throws otherwise).
 */
export async function authenticate(request: NextRequest): Promise<AuthContext> {
  const env = getServerEnv();
  const headerKey = request.headers.get("x-api-key");
  if (env.API_MASTER_KEY && headerKey && safeEqual(headerKey, env.API_MASTER_KEY)) {
    return { kind: "service", label: "api-key" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    return { kind: "user", id: user.id, email: user.email ?? undefined };
  }

  return { kind: "anonymous" };
}

/**
 * Guard used by every /api route.
 *
 * - production: `API_MASTER_KEY` is mandatory, anonymous callers are rejected
 * - development: with no `API_MASTER_KEY` set the routes are open, so the
 *   dashboard works before you have credentials (never deploy that way)
 */
export async function requireApiKey(request: NextRequest): Promise<AuthContext> {
  const ctx = await authenticate(request);
  if (ctx.kind !== "anonymous") return ctx;

  const { API_MASTER_KEY, NODE_ENV } = getServerEnv();

  if (!API_MASTER_KEY && NODE_ENV !== "production") {
    logger.warn("api_open_dev_mode", {
      path: new URL(request.url).pathname,
      note: "API_MASTER_KEY unset — allowed because NODE_ENV is not production",
    });
    return ctx;
  }

  if (!API_MASTER_KEY) {
    throw ApiError.forbidden(
      "API_MASTER_KEY is not configured; set it before exposing this endpoint.",
    );
  }
  throw ApiError.unauthorized("Provide the `x-api-key` header or sign in.");
}

export function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
