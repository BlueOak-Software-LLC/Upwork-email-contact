import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import type { ProposalOutput, ProposalPpd } from "@/types/lead";
import { ApiError } from "@/server/http/errors";

/**
 * The model is asked for an exact shape, but we never trust it: every field is
 * coerced, clipped to the pdfme template's capacity, and given a placeholder
 * when missing. A missing string must never blank out a whole proposal.
 */

const PLACEHOLDER = "[TO CONFIRM]";

const text = (value: unknown, max: number): string => {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
};

const list = (value: unknown, maxItems: number, maxChars: number): string[] => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|•|;|,(?=\s)/)
      : [];
  const items = raw
    .map((item) =>
      text(
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>).title ??
            (item as Record<string, unknown>).label ??
            (item as Record<string, unknown>).text ??
            JSON.stringify(item)
          : item,
        maxChars,
      ),
    )
    .filter(Boolean)
    .slice(0, maxItems);
  return items;
};

const paragraph = (value: unknown, max: number, fallback: string) =>
  text(value, max) || fallback;

const emailSchema = z.object({
  subject: z.string().min(1),
  content: z.string().min(1),
});

export function sanitizeProposal(raw: unknown): ProposalOutput {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const ppdRaw = (obj.ppd ?? obj.proposal ?? obj.document ?? obj) as Record<string, unknown>;

  const ppd: ProposalPpd = {
    document_title: paragraph(ppdRaw.document_title, 70, `Proposal: ${PLACEHOLDER}`),
    proposal_subtitle: paragraph(ppdRaw.proposal_subtitle, 110, PLACEHOLDER),
    prepared_for: paragraph(ppdRaw.prepared_for, 80, PLACEHOLDER),
    client_company: paragraph(ppdRaw.client_company, 90, PLACEHOLDER),
    contact_name: paragraph(ppdRaw.contact_name, 70, PLACEHOLDER),
    contact_role: paragraph(ppdRaw.contact_role, 70, PLACEHOLDER),
    prepared_by: paragraph(ppdRaw.prepared_by, 80, PLACEHOLDER),
    prepared_date: paragraph(ppdRaw.prepared_date, 30, new Date().toISOString().slice(0, 10)),
    valid_until: paragraph(ppdRaw.valid_until, 30, PLACEHOLDER),
    job_title: paragraph(ppdRaw.job_title, 120, PLACEHOLDER),
    job_reference: paragraph(ppdRaw.job_reference, 60, PLACEHOLDER),
    job_url: paragraph(ppdRaw.job_url, 200, ""),
    engagement_summary: paragraph(ppdRaw.engagement_summary, 700, PLACEHOLDER),
    understanding: paragraph(ppdRaw.understanding, 900, PLACEHOLDER),
    scope_title: paragraph(ppdRaw.scope_title, 60, "Scope of work"),
    deliverables: list(ppdRaw.deliverables, 6, 120),
    approach: list(ppdRaw.approach, 5, 160),
    timeline_label_1: paragraph(ppdRaw.timeline_label_1, 40, "Kick-off"),
    timeline_value_1: paragraph(ppdRaw.timeline_value_1, 90, PLACEHOLDER),
    timeline_label_2: paragraph(ppdRaw.timeline_label_2, 40, "Production"),
    timeline_value_2: paragraph(ppdRaw.timeline_value_2, 90, PLACEHOLDER),
    timeline_label_3: paragraph(ppdRaw.timeline_label_3, 40, "Delivery"),
    timeline_value_3: paragraph(ppdRaw.timeline_value_3, 90, PLACEHOLDER),
    pricing_title: paragraph(ppdRaw.pricing_title, 60, "Indicative pricing"),
    pricing_option_1_name: paragraph(ppdRaw.pricing_option_1_name, 60, PLACEHOLDER),
    pricing_option_1_price: paragraph(ppdRaw.pricing_option_1_price, 40, PLACEHOLDER),
    pricing_option_1_notes: paragraph(ppdRaw.pricing_option_1_notes, 160, PLACEHOLDER),
    pricing_option_2_name: paragraph(ppdRaw.pricing_option_2_name, 60, PLACEHOLDER),
    pricing_option_2_price: paragraph(ppdRaw.pricing_option_2_price, 40, PLACEHOLDER),
    pricing_option_2_notes: paragraph(ppdRaw.pricing_option_2_notes, 160, PLACEHOLDER),
    includes: list(ppdRaw.includes, 6, 120),
    assumptions: list(ppdRaw.assumptions, 5, 160),
    next_steps: list(ppdRaw.next_steps, 4, 140),
    why_us: list(ppdRaw.why_us, 5, 160),
    contact_email: paragraph(ppdRaw.contact_email, 80, PLACEHOLDER),
    contact_name_signature: paragraph(ppdRaw.contact_name_signature, 70, PLACEHOLDER),
    closing_note: paragraph(ppdRaw.closing_note, 220, "Looking forward to your reply."),
    footer_note: paragraph(ppdRaw.footer_note, 200, PLACEHOLDER),
  };

  const emailRaw = (obj.email ?? {}) as Record<string, unknown>;
  const email = emailSchema.safeParse({
    subject: text(emailRaw.subject, 120) || ppd.document_title,
    content:
      text(emailRaw.content, 4000) ||
      text(emailRaw.body, 4000) ||
      `${ppd.engagement_summary}\n\nAre you open to a quick 15-minute call this week?`,
  });

  if (!email.success) {
    throw ApiError.upstream("Groq response had no usable email subject/body");
  }

  return { ppd, email: email.data };
}

/** Guard used before persisting: cheap, readable failure for API callers. */
export function assertProposalShape(output: ProposalOutput) {
  const problems: string[] = [];
  if (!output.email.subject.trim()) problems.push("email.subject is empty");
  if (output.email.content.split(/\s+/).length < 20) problems.push("email.content is too short");
  if (output.ppd.deliverables.length === 0) problems.push("ppd.deliverables is empty");
  if (problems.length) {
    logger.warn("proposal_low_quality", { problems });
  }
  return problems;
}

export function proposalProviderLabel() {
  const env = getServerEnv();
  return { provider: "groq", model: groqConfig().model, language: env.PROPOSAL_LANGUAGE };
}
