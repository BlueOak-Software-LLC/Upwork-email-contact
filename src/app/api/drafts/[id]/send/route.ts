import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { parseOrThrow } from "@/server/http/errors";
import { sendDraftSchema } from "@/lib/validation/outreach";
import { sendDraft } from "@/server/services/draft.service";
import { requireParamId } from "@/server/http/id";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // PDF render + SMTP

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

/**
 * POST /api/drafts/:id/send — STEP 3 of the pipeline.
 * Compiles the PDF from the **reviewed** PPD (unless a preview already rendered
 * one), attaches it, delivers over SMTP with the stored sender account, writes
 * an `email_logs` row and moves the lead to `sent`.
 *
 * Body: {} | { "senderAccountId": "uuid" } | { "attachPdf": false }
 */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "draft id");
  const body = await request.text();
  const input = parseOrThrow(
    sendDraftSchema,
    body.trim() ? JSON.parse(body) : {},
  );
  return ok(
    await sendDraft(id, {
      ...(input.senderAccountId ? { senderAccountId: input.senderAccountId } : {}),
      attachPdf: input.attachPdf,
    }),
  );
});
