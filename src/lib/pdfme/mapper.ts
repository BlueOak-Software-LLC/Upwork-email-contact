import type { ProposalPpd } from "@/types/lead";

/**
 * PPD → pdfme `inputs`.
 *
 * pdfme v6 model: `template.schemas` is the page list of ONE document, and
 * `inputs` is a list of **documents**. So a proposal is a single flat record
 * containing every field of all three pages, wrapped in an array: `[record]`.
 *
 * Long lists from the model are expanded into fixed slots (`deliverable_1..6`,
 * `approach_1..5`, …) because template geometry is static; unused slots are
 * emitted as empty strings so nothing shifts.
 *
 * FIELD NAMES ARE THE CONTRACT — if you redesign the template on pdfme.com,
 * keep these keys (or update this mapper + `ProposalPpd` together). Fields
 * marked `readOnly` in the template are static captions and are never sent.
 */

const SLOTS = {
  deliverables: 6,
  approach: 5,
  includes: 6,
  assumptions: 5,
  next_steps: 4,
  why_us: 5,
} as const;

export type PdfmeInputs = Array<Record<string, string>>;

export function ppdToPdfmeInputs(
  ppd: ProposalPpd,
  meta?: { generatedAt?: string },
): PdfmeInputs {
  const record: Record<string, string> = {
    // header / meta
    doc_title: ppd.document_title,
    proposal_subtitle: ppd.proposal_subtitle,
    prepared_for: ppd.prepared_for,
    client_company: ppd.client_company,
    contact_name: ppd.contact_name,
    contact_role: ppd.contact_role,
    prepared_by: ppd.prepared_by,
    prepared_date: ppd.prepared_date,
    valid_until: ppd.valid_until,
    job_title: ppd.job_title,
    job_reference: ppd.job_reference,
    job_url: ppd.job_url,

    // narrative
    engagement_summary: ppd.engagement_summary,
    understanding: ppd.understanding,
    scope_title: ppd.scope_title,
    ...slots(ppd.deliverables, SLOTS.deliverables, "deliverable_"),

    approach: "", // caption is static; only the slots carry content
    ...slots(ppd.approach, SLOTS.approach, "approach_"),

    // timeline (labels are dynamic: "Kick-off", "Production", …)
    t1_label: ppd.timeline_label_1,
    t1_value: ppd.timeline_value_1,
    t2_label: ppd.timeline_label_2,
    t2_value: ppd.timeline_value_2,
    t3_label: ppd.timeline_label_3,
    t3_value: ppd.timeline_value_3,

    // pricing
    pricing_title: ppd.pricing_title,
    option_1_name: ppd.pricing_option_1_name,
    option_1_price: ppd.pricing_option_1_price,
    option_1_notes: ppd.pricing_option_1_notes,
    option_2_name: ppd.pricing_option_2_name,
    option_2_price: ppd.pricing_option_2_price,
    option_2_notes: ppd.pricing_option_2_notes,
    ...slots(ppd.includes, SLOTS.includes, "includes_"),
    ...slots(ppd.assumptions, SLOTS.assumptions, "assumptions_"),
    ...slots(ppd.next_steps, SLOTS.next_steps, "next_step_"),

    // page 3
    ...slots(ppd.why_us, SLOTS.why_us, "why_us_"),
    contact_email: ppd.contact_email,
    contact_name_signature: ppd.contact_name_signature,
    closing_note: ppd.closing_note,
    footer_note: ppd.footer_note,

    page_1_footer: meta?.generatedAt
      ? `Generated ${meta.generatedAt} — indicative scope, confirmed after a scoping call.`
      : "",
  };

  delete record.approach; // static caption lives in the template
  return [record];
}

function slots(
  items: string[] | undefined,
  count: number,
  prefix: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    out[`${prefix}${i + 1}`] = items?.[i] ?? "";
  }
  return out;
}

export const PPD_SLOT_COUNTS = SLOTS;
