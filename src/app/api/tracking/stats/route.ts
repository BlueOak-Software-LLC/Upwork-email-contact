import type { NextRequest } from "next/server";
import { z } from "zod";
import { withApi } from "@/server/http/handler";
import { ok, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { trackingRepo } from "@/server/db/tracking.repo";
import { getServerEnv, linkTrackingEnabled, trackingEnabled, trackingOrigin } from "@/lib/env";

export const dynamic = "force-dynamic";

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });

/**
 * GET /api/tracking/stats?days=7
 *
 * Overview numbers. Read the denominators: a rate is stated against *delivered*
 * messages, because "opens ÷ pixels minted" would hide provider failures inside
 * a flattering percentage.
 *
 * `configured` is returned alongside the counts on purpose. An all-zero
 * dashboard means one of three different things — tracking switched off, the
 * domain unreachable, or genuinely nobody opened anything — and the numbers
 * alone cannot tell them apart.
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const q = parseOrThrow(querySchema, Object.fromEntries(request.nextUrl.searchParams));

  const stats = await trackingRepo.stats(q.days);
  const env = getServerEnv();

  return ok(
    {
      ...stats,
      configured: {
        enabled: trackingEnabled(env),
        linkTracking: linkTrackingEnabled(env),
        domain: trackingOrigin(env),
        retentionDays: env.TRACKING_RETENTION_DAYS,
      },
    },
    withRevalidation(10),
  );
});
