import type { NextRequest } from "next/server";
import { z } from "zod";
import { withApi } from "@/server/http/handler";
import { paged, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { emailLogsRepo } from "@/server/db/email-logs.repo";
import { trackingStateOf } from "@/lib/tracking";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["queued", "sent", "failed", "bounced"]).optional(),
  to: z.string().trim().email().optional(),
  /**
   * Engagement, derived from the tracking counters. `untracked` is honest about
   * the rows that were sent before 0005_email_tracking.sql existed.
   */
  tracking: z.enum(["untracked", "sent", "opened", "clicked"]).optional(),
  draftId: z.string().uuid().optional(),
});

/**
 * GET /api/email
 * Delivery history (one row per recipient) that powers the /emails page.
 *
 * Each row carries both halves of the story now:
 *   • delivery — `status`, `provider`, `provider_message_id`, `error`
 *   • engagement — `open_count`, `click_count`, the timestamps, and
 *     `tracking_state` derived from them
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const q = parseOrThrow(querySchema, Object.fromEntries(request.nextUrl.searchParams));
  const result = await emailLogsRepo.list(q);

  return paged(
    {
      items: result.items.map((item) => ({ ...item, tracking_state: trackingStateOf(item) })),
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
    withRevalidation(10),
  );
});
