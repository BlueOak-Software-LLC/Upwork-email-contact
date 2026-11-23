import { getAdminClient } from "@/lib/supabase/admin";
import { pdfConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { compileProposalPdfme, type PdfmeInputs } from "@/lib/pdfme/compiler";
import type { PdfmeTemplate } from "@/lib/pdfme/template";
import type { ProposalRow } from "@/types/lead";

export const PDF_BUCKET = "proposals";

export interface PdfRenderResult {
  path: string | null;
  status: "ready" | "skipped" | "failed";
  bytes?: Uint8Array;
  error?: string;
  pages?: number;
  fields?: number;
}

/**
 * PPD JSON → compiled pdfme template → PDF bytes → Supabase Storage
 * (`proposals/{leadId}/{proposalId}-v{n}.pdf`).
 *
 * The template is built from the content (`lib/pdfme/compiler.ts`), so document
 * length is not capped by a static layout. Set `PDF_PROVIDER=none` to skip
 * rendering (the PPD JSON + detail page keep working).
 */
export async function renderProposalPdf({
  proposal,
}: {
  proposal: ProposalRow;
}): Promise<PdfRenderResult> {
  const { provider } = pdfConfig();
  if (provider === "none") {
    return { path: null, status: "skipped" };
  }

  const compiled = compileProposalPdfme(proposal.ppd as never);
  const bytes = await runPdfme(compiled.template, compiled.inputs);
  const path = `${proposal.lead_id}/${proposal.id}-v${proposal.version}.pdf`;

  const supabase = getAdminClient();
  const { error } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: true });

  if (error) {
    logger.warn("proposal_pdf_upload_failed", { path, error: error.message });
    return {
      path: null,
      status: "failed",
      bytes,
      error: error.message,
      pages: compiled.pages,
      fields: compiled.fieldCount,
    };
  }

  logger.info("proposal_pdf_ready", {
    proposalId: proposal.id,
    path,
    pages: compiled.pages,
    fields: compiled.fieldCount,
  });
  return { path, status: "ready", bytes, pages: compiled.pages, fields: compiled.fieldCount };
}

/**
 * pdfme v6 `@pdfme/generator` exposes `generate` (some builds name it
 * `renderPdf`); support both. `inputs` is one record per **document**.
 */
async function runPdfme(template: PdfmeTemplate, inputs: PdfmeInputs): Promise<Uint8Array> {
  const mod = (await import("@pdfme/generator")) as unknown as {
    renderPdf?: (opts: PdfmeOptions) => Promise<Uint8Array | ArrayBuffer>;
    generate?: (opts: PdfmeOptions) => Promise<Uint8Array | ArrayBuffer>;
    default?: (opts: PdfmeOptions) => Promise<Uint8Array | ArrayBuffer>;
  };
  const fn = mod.renderPdf ?? mod.generate ?? mod.default;
  if (!fn) {
    throw new Error(
      "@pdfme/generator exposes neither renderPdf nor generate — check the installed version.",
    );
  }

  const out = await fn({ template, inputs });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

type PdfmeOptions = {
  template: PdfmeTemplate;
  inputs: PdfmeInputs;
  options?: Record<string, unknown>;
};

/** Bytes for `GET /api/leads/:id/pdf` (falls back to null when not rendered). */
export async function loadProposalPdfBytes(
  path: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.storage.from(PDF_BUCKET).download(path);
  if (error || !data) {
    logger.warn("proposal_pdf_download_failed", { path, error: error?.message });
    return null;
  }
  const buffer = new Uint8Array(await data.arrayBuffer());
  return { bytes: buffer, contentType: "application/pdf" };
}

export async function createProposalPdfUrl(
  path: string,
  expiresIn = 3600,
): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase.storage
    .from(PDF_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error) {
    logger.warn("proposal_pdf_sign_failed", { path, error: error.message });
    return null;
  }
  return data?.signedUrl ?? null;
}
