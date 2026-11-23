import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { editDraftSchema } from "@/lib/validation/outreach";
import { draftsRepo } from "@/server/db/outreach.repo";
import { editDraft } from "@/server/services/draft.service";

export const dynamic = "force-dynamic";

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

async function readJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    throw ApiError.badRequest("Body must be valid JSON");
  }
}

/** GET /api/drafts/:id — the stored draft (subject, body, sender, PDF link). */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  return ok({ draft: await draftsRepo.byId(id) });
});

/**
 * PATCH /api/drafts/:id — edit before sending.
 * { "subject": "…", "bodyText": "…", "toEmail": "any@address.com",
 *   "cc": ["a@b.com"], "senderAccountId": "uuid|null",
 *   "status": "draft|queued|cancelled" }
 * `toEmail` is not limited to the addresses in the payload.
 */
export const PATCH = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const input = parseOrThrow(editDraftSchema, await readJson(request));
  return ok({
    draft: await editDraft(id, {
      subject: input.subject,
      bodyText: input.bodyText,
      toEmail: input.toEmail,
      cc: input.cc ?? undefined,
      senderAccountId: input.senderAccountId,
      status: input.status,
    }),
  });
});
