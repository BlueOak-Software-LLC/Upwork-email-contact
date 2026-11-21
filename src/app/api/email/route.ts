import type { NextRequest } from "next/server";
import { z } from "zod";
import { withApi } from "@/server/http/handler";
import { paged, withRevalidation } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { emailLogsRepo } from "@/server/db/email-logs.repo";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["queued", "sent", "failed", "bounced"]).optional(),
  to: z.string().trim().email().optional(),
});

/**
 * GET /api/email
 * Delivery history (one row per recipient) that powers the /emails page.
 */
export const GET = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const q = parseOrThrow(querySchema, Object.fromEntries(request.nextUrl.searchParams));
  const result = await emailLogsRepo.list(q);
  return paged(result, withRevalidation(10));
});
