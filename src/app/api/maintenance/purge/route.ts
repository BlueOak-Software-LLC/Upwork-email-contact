import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { trackingRepo } from "@/server/db/tracking.repo";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({ days: z.coerce.number().int().min(7).max(3650).optional() })
  .default({});

/**
 * POST /api/maintenance/purge — delete old `open`/`click` rows and rebuild the
 * counters from what is left.
 *
 * Three accepted callers, because a scheduler cannot hold a session cookie:
 *   1. `Authorization: Bearer $CRON_SECRET` (cron, CI, `curl`)
 *   2. Vercel's own scheduler marker (`x-vercel-cron: 1`)
 *   3. a signed-in dashboard user or the API key — so the button in the
 *      tracking panel proves the job works without waiting for the schedule
 *
 * Outcomes (`reply`, `meeting`, `not_interested`), the delivery log and every
 * sent body survive: retention trims high-volume pixel traffic, not the record
 * of what we sent to whom. Deleting a lead's row is a separate, explicit act.
 *
 * The window always comes from `TRACKING_RETENTION_DAYS` unless an authenticated
 * caller asks for a different one, so an unexpected extra run can only re-delete
 * rows that had already expired.
 */
export const POST = withApi(async (request: NextRequest) => {
  const byScheduler = schedulerCaller(request);
  if (!byScheduler) await requireApiKey(request);

  // A scheduler sends no body; a dashboard caller may override the window.
  let days = getServerEnv().TRACKING_RETENTION_DAYS;
  const raw = await request.text();
  if (raw.trim() && !byScheduler) {
    const parsed = parseOrThrow(bodySchema, safeJson(raw));
    if (parsed.days) days = parsed.days;
  } else if (raw.trim()) {
    logger.warn("maintenance_purge_body_ignored", { note: "scheduler callers use the env window" });
  }

  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  const removed = await trackingRepo.purge(before);
  logger.info("tracking_purge", { removed, before, days, caller: byScheduler ? "scheduler" : "api" });

  return ok({ removed, before, days });
});

function schedulerCaller(request: NextRequest): boolean {
  if (request.headers.get("x-vercel-cron") === "1") return true;
  const secret = getServerEnv().CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return bearer.length > 0 && secretsEqual(bearer, secret);
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}
