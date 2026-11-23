import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { noContent, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { updateLeadSchema } from "@/lib/validation/outreach";
import { leadsRepo } from "@/server/db/leads.repo";
import { requireParamId } from "@/server/http/id";

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

/**
 * GET /api/leads/:id
 * Everything the dashboard detail page needs: lead + contacts + proposals
 * (PPD included) + drafts + the untouched raw payload.
 */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  return ok(await leadsRepo.detail(id));
});

/**
 * PATCH /api/leads/:id — status transitions, and a late job_description.
 * A payload that arrives without the post body can be topped up here; the
 * response says whether an existing document predates the new text.
 */
export const PATCH = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  const patch = parseOrThrow(updateLeadSchema, await readJson(request));
  await leadsRepo.updateManual(id, patch);
  const detail = await leadsRepo.detail(id);

  const hints: string[] = [];
  if (patch.job_description !== undefined) {
    hints.push(
      detail.proposals.length
        ? "job_description replaced — the stored PPD predates it; POST /api/leads/:id/generate {\"regenerate\":true} to rewrite from the new text"
        : "job_description stored — POST /api/leads/:id/generate to write the document from it",
    );
  }

  return ok({ ...detail, hints });
});

/** DELETE /api/leads/:id — removes the lead and cascades contacts/proposals/drafts. */
export const DELETE = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  const supabase = (await import("@/lib/supabase/admin")).getAdminClient();
  const { error, count } = await supabase.from("leads").delete({ count: "exact" }).eq("id", id);
  if (error) throw ApiError.upstream(`Failed to delete lead: ${error.message}`);
  if (!count) throw ApiError.notFound(`Lead ${id} not found`);
  return noContent();
});
