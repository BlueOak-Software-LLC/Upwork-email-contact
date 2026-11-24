import type { NextRequest } from "next/server";
import { z } from "zod";
import { withApi } from "@/server/http/handler";
import { paged, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { trackingRepo } from "@/server/db/tracking.repo";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  type: z.enum(["open", "click", "sent", "reply", "meeting", "not_interested"]).optional(),
  logId: z.string().uuid().optional(),
});

/**
 * GET /api/tracking/events
 *
 * The raw signal stream, newest first. Filter `type=open` to see tracked image
 * requests; those are proof that a client fetched an image, not proof that a
 * person read the email — Apple Mail Privacy Protection and corporate link
 * scanners both generate them without any human involved.
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const q = parseOrThrow(querySchema, Object.fromEntries(request.nextUrl.searchParams));

  const result = await trackingRepo.listEvents(q);
  return paged(
    {
      items: result.items,
      page: q.page,
      pageSize: q.pageSize,
      total: result.total,
      totalPages: Math.max(1, Math.ceil(result.total / q.pageSize)),
    },
    withRevalidation(10),
  );
});
