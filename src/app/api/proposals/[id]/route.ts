import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { editProposalSchema } from "@/lib/validation/outreach";
import { proposalsRepo } from "@/server/db/outreach.repo";
import { leadsRepo } from "@/server/db/leads.repo";
import { sanitizeEditedPpd } from "@/server/services/proposal.service";
import { describePpdEditDrops } from "@/server/services/proposal-sanitize";
import { textToHtml } from "@/server/services/templates";
import { logger } from "@/lib/logger";
import type { ProposalPpd } from "@/types/lead";
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

/** GET /api/proposals/:id — one version, PPD included. */
export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "proposal id");
  return ok({ proposal: await proposalsRepo.byId(id) });
});

/**
 * PATCH /api/proposals/:id — the review step.
 *
 *   { "ppd": { …the block document, edited by a human… } }   → structure is
 *       re-validated/clipped, `ppd_reviewed_at` is stamped and any rendered PDF
 *       is marked stale (`pdf_status: "pending"`) so the next preview/send
 *       re-renders from the approved text.
 *   { "emailSubject": "…", "emailContent": "…" }             → hand-written copy
 *   { "reviewed": true }                                     → mark reviewed only
 */
export const PATCH = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "proposal id");
  const input = parseOrThrow(editProposalSchema, await readJson(request));
  const existing = await proposalsRepo.byId(id);

  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];

  if (input.ppd !== undefined) {
    const base = existing.ppd as unknown as ProposalPpd;
    const sanitized = sanitizeEditedPpd(input.ppd, base);
    patch.ppd = sanitized;
    patch.ppd_reviewed_at = new Date().toISOString();
    // A reviewed-but-then-edited document invalidates the rendered PDF.
    if (existing.pdf_status === "ready") patch.pdf_status = "pending";
    warnings.push("ppd updated — the PDF will be re-rendered from it on the next preview or send");
    // Nothing may vanish on a reviewer's edit without them being told why.
    warnings.push(...describePpdEditDrops(input.ppd));
  }

  if (input.reviewed && input.ppd === undefined) {
    patch.ppd_reviewed_at = new Date().toISOString();
  }

  if (input.emailSubject !== undefined) patch.email_subject = input.emailSubject;
  if (input.emailContent !== undefined) {
    patch.email_content = input.emailContent;
    patch.email_html = textToHtml(input.emailContent);
  }

  if (!Object.keys(patch).length) throw ApiError.badRequest("Nothing to update");

  const proposal = await proposalsRepo.update(id, patch as never);
  logger.info("proposal_edited", { proposalId: id, fields: Object.keys(patch) });

  return ok({
    proposal,
    warnings,
    lead: await leadsRepo.detail(proposal.lead_id),
  });
});
