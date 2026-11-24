import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { recordOutcomeSchema } from "@/lib/validation/tracking";
import { trackingRepo } from "@/server/db/tracking.repo";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/**
 * POST /api/tracking/outcome — record something the app cannot observe.
 *
 * `{ "logId": "uuid", "kind": "reply" | "meeting" | "not_interested" }`
 *
 * This app never reads a mailbox, so a reply is a human statement. It matters
 * because the Overview reply rate otherwise stays a manual CRM number: the
 * tracked open tells you the message was fetched, the outcome tells you whether
 * it was worth anything.
 *
 * `reply`/`meeting` also set the promoted contact to `replied`, and
 * `not_interested` to `no_reply` — never downgrading a contact already marked
 * as replied, which the RPC enforces.
 */
export const POST = withApi(async (request: NextRequest) => {
  await requireApiKey(request);
  const input = parseOrThrow(recordOutcomeSchema, await readJson(request));

  const result = await trackingRepo.recordOutcome(input.logId, input.kind);
  if (result.unavailable) {
    // Never report a missing migration as a missing message: the row is there,
    // and telling the user to go look for it wastes their time.
    throw ApiError.upstream(
      `Recording outcomes needs supabase/migrations/0005_email_tracking.sql — apply it, then reload the API schema cache.`,
    );
  }
  if (!result.found) {
    throw ApiError.notFound(`Email log ${input.logId} not found — was it deleted?`);
  }

  logger.info("tracking_outcome", { logId: input.logId, kind: input.kind });
  return ok({ logId: result.logId, eventId: result.eventId, kind: input.kind });
});
