import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError } from "@/server/http/errors";
import { requireParamId } from "@/server/http/id";
import { emailLogsRepo } from "@/server/db/email-logs.repo";
import { trackingRepo } from "@/server/db/tracking.repo";
import { trackingStateOf } from "@/lib/tracking";

export const dynamic = "force-dynamic";

type Ctx = { id: string };

/**
 * GET /api/email/:id — one delivered message, everything known about it.
 *
 * Returns the delivery row, its engagement counters, the tracked links with
 * their click counts, and the event timeline. The body is handed back with any
 * tracking pixel removed: the dashboard previews stored HTML, and rendering a
 * live pixel would record an open for the recipient every time someone on our
 * own side looked at the message.
 */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "email log id");

  const log = await emailLogsRepo.byId(id);
  if (!log) throw ApiError.notFound(`Email log ${id} not found`);

  const [links, events] = await Promise.all([
    trackingRepo.linksForLog(id),
    trackingRepo.eventsForLog(id, 100),
  ]);

  return ok({
    log: { ...log, tracking_state: trackingStateOf(log) },
    links,
    events,
  });
});
