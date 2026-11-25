import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAdminClient } from "@/lib/supabase/admin";
import { pdfConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { compileProposalPdfme, type PdfmeInputs } from "@/lib/pdfme/compiler";
import type { PdfmeTemplate } from "@/lib/pdfme/template";
import { resolveSenderBrand } from "@/server/services/sender-profile.service";
import type { ProposalPpd, ProposalRow } from "@/types/lead";

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

  // Identity is read from the stored document (it was stamped from the sender
  // profile when the PPD was generated). Only fields missing from a legacy
  // document fall back to the current default profile; nothing is overwritten,
  // so a PPD approved by its author never changes name under them at send time.
  const stored = (proposal.ppd ?? {}) as Partial<ProposalPpd>;
  const profile = await resolveSenderBrand();
  const today = new Date().toISOString().slice(0, 10);
  const compiled = compileProposalPdfme({
    ...stored,
    prepared_by: stored.prepared_by || profile.preparedBy,
    prepared_role: stored.prepared_role || profile.title,
    sender_email: stored.sender_email || profile.senderEmail,
    sender_phone: stored.sender_phone || profile.phone,
    sender_whatsapp: stored.sender_whatsapp || profile.whatsapp,
    sender_linkedin: stored.sender_linkedin || profile.linkedin,
    sender_website: stored.sender_website || profile.website,
    sender_location: stored.sender_location || profile.location,
    date: stored.date || today,
    valid_until: stored.valid_until || "",
    rate: stored.rate || profile.rate,
  } as ProposalPpd);
  const bytes = await runPdfme(compiled.template, compiled.inputs, await loadFonts());
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
async function runPdfme(
  template: PdfmeTemplate,
  inputs: PdfmeInputs,
  font: Record<string, { data: Uint8Array; fallback?: boolean; subset?: boolean }>,
): Promise<Uint8Array> {
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

  const { text, line, rectangle } = await import("@pdfme/schemas");
  const out = await fn({
    template,
    inputs,
    plugins: { text, line, rectangle },
    options: { font },
  });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

/**
 * Source Sans 3 is readable at 9–10 pt and has a normal, non-designer feel.
 * The files live in `public/fonts` (OFL) and are traced into the serverless
 * bundle by `next.config.ts`; pdfme needs the bytes, not a CSS family name.
 */
let fontCache: Promise<Record<string, { data: Uint8Array; fallback?: boolean; subset?: boolean }>> | null =
  null;

function loadFonts() {
  fontCache ??= loadFontFiles();
  return fontCache;
}

async function loadFontFiles() {
  const dir = path.join(process.cwd(), "public", "fonts");
  const [regular, semibold] = await Promise.all([
    readFile(path.join(dir, "SourceSans3-Regular.ttf")),
    readFile(path.join(dir, "SourceSans3-Semibold.ttf")),
  ]);
  return {
    SourceSans3: { data: new Uint8Array(regular), fallback: true, subset: true },
    SourceSans3Semibold: { data: new Uint8Array(semibold), subset: true },
  };
}

type PdfmeOptions = {
  template: PdfmeTemplate;
  inputs: PdfmeInputs;
  plugins?: Record<string, unknown>;
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

/**
 * Remove every stored PDF for a lead (`proposals/{leadId}/…`).
 *
 * Called before the row is deleted: the path is derived from the lead id, so an
 * object left behind would be unreferenced and unrecoverable from the UI.
 * A missing prefix is not an error — nothing was ever rendered for that lead.
 */
export async function deleteLeadPdfFiles(
  leadId: string,
): Promise<{ deleted: number; errors: string[] }> {
  const { provider } = pdfConfig();
  if (provider === "none") return { deleted: 0, errors: [] };

  const supabase = getAdminClient();
  const listed = await supabase.storage.from(PDF_BUCKET).list(leadId, { limit: 200 });
  if (listed.error || !listed.data?.length) return { deleted: 0, errors: [] };

  const paths = listed.data
    .filter((entry) => entry.id)
    .map((entry) => `${leadId}/${entry.name}`);
  if (!paths.length) return { deleted: 0, errors: [] };

  const removed = await supabase.storage.from(PDF_BUCKET).remove(paths);
  if (removed.error) {
    logger.warn("pdf_storage_delete_failed", { leadId, error: removed.error.message });
    return { deleted: 0, errors: [removed.error.message] };
  }
  logger.info("pdf_storage_deleted", { leadId, files: removed.data?.length ?? paths.length });
  return { deleted: removed.data?.length ?? paths.length, errors: [] };
}
