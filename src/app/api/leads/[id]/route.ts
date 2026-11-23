import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { noContent, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { updateLeadSchema } from "@/lib/validation/outreach";
import { leadsRepo } from "@/server/db/leads.repo";

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
  const { id } = await params;
  return ok(await leadsRepo.detail(id));
});

/** PATCH /api/leads/:id — status transitions (and a late job description). */
export const PATCH = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const patch = parseOrThrow(updateLeadSchema, await readJson(request));
  await leadsRepo.updateManual(id, patch);
  return ok(await leadsRepo.detail(id));
});

/** DELETE /api/leads/:id — removes the lead and cascades contacts/proposals/drafts. */
export const DELETE = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const { id } = await params;
  const supabase = (await import("@/lib/supabase/admin")).getAdminClient();
  const { error, count } = await supabase.from("leads").delete({ count: "exact" }).eq("id", id);
  if (error) throw ApiError.upstream(`Failed to delete lead: ${error.message}`);
  if (!count) throw ApiError.notFound(`Lead ${id} not found`);
  return noContent();
});
