import { z } from "zod";
import type { NextRequest } from "next/server";
import { withApi } from "@/server/http/handler";
import { fail, ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { ApiError, parseOrThrow } from "@/server/http/errors";
import { leadsRepo } from "@/server/db/leads.repo";
import { proposalsRepo } from "@/server/db/outreach.repo";
import { requireParamId } from "@/server/http/id";
import {
  createProposalPdfUrl,
  loadProposalPdfBytes,
  renderProposalPdf,
} from "@/server/services/pdf.service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Route params: `withApi<P>` wraps P as `{ params: Promise<P> }`. */
type Ctx = { id: string };

const flag = (fallback = false) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    // Without this transform, `?url=false` parses to the *string* "false", which
    // is truthy — so every branch guard reading it as a boolean takes the wrong path.
    .transform((v) => v === "true");

const querySchema = z.object({
  proposalId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  download: flag(),
  render: flag(),
  url: flag(),
});

/**
 * GET /api/leads/:id/pdf
 * Returns the stored proposal PDF. In the review-first flow the normal PDF is
 * only compiled at send time, so this endpoint doubles as the explicit
 * **preview**: `?render=true` compiles it from the stored (reviewed) PPD.
 * `?url=true` returns a short signed Storage link instead of bytes.
 */
export const GET = withApi<Ctx>(async (request: NextRequest, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "lead id");
  const query = parseOrThrow(querySchema, Object.fromEntries(request.nextUrl.searchParams));

  const proposals = await leadsRepo.proposals(id);
  const proposal = pickProposal(proposals, query);
  if (!proposal) {
    throw ApiError.notFound("This lead has no proposal yet — POST /api/leads/:id/generate first");
  }

  if (query.url && proposal.pdf_path) {
    const signed = await createProposalPdfUrl(proposal.pdf_path);
    if (!signed) throw ApiError.upstream("Could not sign the PDF URL");
    return ok({ url: signed, proposalId: proposal.id, path: proposal.pdf_path });
  }

  let path = proposal.pdf_path;

  if (!path || query.render) {
    const rendered = await renderProposalPdf({ proposal });
    if (rendered.status !== "ready" || !rendered.path) {
      return fail(
        409,
        "pdf_unavailable",
        rendered.status === "skipped"
          ? "PDF rendering is disabled (PDF_PROVIDER=none). The PPD JSON is still available in the proposal."
          : `PDF rendering failed: ${rendered.error ?? "unknown error"}`,
      );
    }
    path = rendered.path;
    await proposalsRepo.update(proposal.id, {
      pdf_path: rendered.path,
      pdf_status: "ready",
      pdf_generated_at: new Date().toISOString(),
    });
    if (rendered.bytes) {
      return pdfResponse(rendered.bytes, proposal.version, query.download);
    }
  }

  const loaded = path ? await loadProposalPdfBytes(path) : null;
  if (!loaded) {
    throw ApiError.notFound(
      `No stored PDF for this proposal (${proposal.pdf_status}). Retry with ?render=true`,
    );
  }
  return pdfResponse(loaded.bytes, proposal.version, query.download);
});

function pickProposal(
  proposals: Awaited<ReturnType<typeof leadsRepo.proposals>>,
  query: z.infer<typeof querySchema>,
) {
  if (query.proposalId) return proposals.find((p) => p.id === query.proposalId) ?? null;
  const scoped = query.contactId
    ? proposals.filter((p) => p.lead_contact_id === query.contactId)
    : proposals;
  return scoped[0] ?? null; // listings come newest-first
}

function pdfResponse(bytes: Uint8Array, version: number, download: boolean) {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="proposal-v${version}.pdf"`,
      "cache-control": "private, max-age=60",
    },
  });
}
