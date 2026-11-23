import { getServerEnv } from "@/lib/env";
import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { textToHtml } from "@/server/services/templates";
import { ApiError } from "@/server/http/errors";
import { leadsRepo } from "@/server/db/leads.repo";
import { proposalsRepo } from "@/server/db/outreach.repo";
import { groqJson } from "@/server/services/groq.client";
import {
  assertProposalShape,
  sanitizeProposal,
} from "@/server/services/proposal-sanitize";
import { systemPrompt, userPrompt } from "@/server/services/prompts/proposal.prompt";
import { renderProposalPdf } from "@/server/services/pdf.service";
import type { LeadContactRow, LeadRow, NormalizedLead, ProposalRow } from "@/types/lead";

export interface GenerateProposalResult {
  proposal: ProposalRow;
  warnings: string[];
}

/**
 * Groq → PPD (pdfme JSON) + subject/content → proposals row → best-effort PDF.
 * Callers: the ingest pipeline (auto) and `POST /api/leads/:id/generate` (manual).
 */
export async function generateProposal({
  lead,
  contact,
  regenerate = false,
}: {
  lead: LeadRow;
  contact: LeadContactRow;
  regenerate?: boolean;
}): Promise<GenerateProposalResult> {
  const env = getServerEnv();
  const normalized = rehydrateNormalizedLead(lead);
  const recipient = toNormalizedContact(contact);

  if (!recipient.isEmail) {
    throw ApiError.badRequest(`${contact.contact_value} is not an email address`);
  }

  // Idempotency: without `regenerate` we reuse the newest proposal instead of
  // spending tokens twice on the same contact.
  const existing = (await leadsRepo.proposals(lead.id)).filter(
    (p) => p.lead_contact_id === contact.id,
  );
  const latest = existing[0]; // listings are newest-first
  if (!regenerate && latest) {
    return { proposal: latest, warnings: ["reused the existing proposal version"] };
  }

  // Always bump: keeps re-runs safe against the (lead_contact_id, version)
  // unique index, and `regenerate` simply means “make a new version now”.
  const version = await leadsRepo.nextVersion(contact.id);
  const today = new Date().toISOString().slice(0, 10);
  const senderName = env.EMAIL_FROM;

  logger.info("proposal_generation_started", {
    leadId: lead.id,
    contactId: contact.id,
    model: groqConfig().model,
    version,
  });

  const completion = await groqJson<unknown>({
    messages: [
      { role: "system", content: systemPrompt(env.PROPOSAL_LANGUAGE) },
      { role: "user", content: userPrompt(normalized, recipient, senderName, today) },
    ],
    temperature: 0.45,
    maxTokens: 3500,
  });

  const output = sanitizeProposal(completion.data);
  const warnings = assertProposalShape(output);

  const proposal = await proposalsRepo.create({
    leadId: lead.id,
    leadContactId: contact.id,
    version,
    output,
    model: completion.model,
    provider: "groq",
    usage: completion.usage,
    pdfStatus: "pending",
    emailHtml: textToHtml(output.email.content),
  });

  // PDF is a nice-to-have: a rendering failure must not lose the proposal.
  const pdf = await renderProposalPdf({ proposal })
    .then((r) => r)
    .catch((error: Error) => {
      logger.warn("proposal_pdf_failed", { proposalId: proposal.id, error: error.message });
      return { path: null, status: "failed" as const, error: error.message };
    });

  const updated = await proposalsRepo
    .update(proposal.id, { pdf_path: pdf.path, pdf_status: pdf.status })
    .catch(() => proposal);

  return { proposal: updated, warnings };
}

/**
 * The prompt wants the fully normalised payload; we stored it as JSONB, so
 * rebuild the minimum fields the prompt uses rather than re-parsing.
 */
function rehydrateNormalizedLead(lead: LeadRow): NormalizedLead {
  const raw = (lead.raw_payload ?? {}) as Record<string, unknown>;
  return {
    dedupeKey: lead.dedupe_key,
    jobId: lead.job_id,
    jobTitle: lead.job_title,
    jobUrl: lead.job_url,
    jobLocation: lead.job_location,
    industry: lead.industry,
    companyMentioned: lead.company_mentioned,
    clientName: lead.client_name,
    clientLocation: lead.client_location,
    jobDescription: lead.job_description,
    overallConfidence: lead.overall_confidence,
    keyPeople: (Array.isArray(lead.key_people)
      ? lead.key_people
      : []) as unknown as NormalizedLead["keyPeople"],
    contactInformation: (lead.contact_information ??
      {}) as unknown as NormalizedLead["contactInformation"],
    rawPayload: raw as NormalizedLead["rawPayload"],
    contacts: [] as NormalizedLead["contacts"],
    primaryEmail: null,
  };
}

function toNormalizedContact(contact: LeadContactRow) {
  return {
    listType: contact.list_type,
    name: contact.name,
    role: contact.role,
    company: contact.company,
    contactType: contact.contact_type,
    channel: contact.channel,
    contactValue: contact.contact_value,
    normalizedValue: contact.normalized_value,
    confidence: contact.confidence,
    rationale: contact.rationale,
    sourceUrl: contact.source_url,
    isEmail: contact.is_email,
    isPrimary: contact.is_primary,
  };
}
