import { getServerEnv } from "@/lib/env";
import { brandConfig, estimateGroqCost, groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { textToHtml } from "@/server/services/templates";
import { ApiError } from "@/server/http/errors";
import { leadsRepo } from "@/server/db/leads.repo";
import { proposalsRepo } from "@/server/db/outreach.repo";
import { groqJson, type GroqUsage, type ReasoningEffort } from "@/server/services/groq.client";
import {
  assertEmailShape,
  assertPpdShape,
  ppdWordCount,
  sanitizeEmail,
  sanitizePpd,
} from "@/server/services/proposal-sanitize";
import {
  buildPromptVars,
  type ProposalBrand,
} from "@/server/services/prompts/proposal.prompt";
import {
  renderPromptPair,
  resolvePrompt,
  type ResolvedPrompt,
} from "@/server/services/prompts/registry";
import { createDraftForProposal } from "@/server/services/draft.service";
import type {
  EmailDraftRow,
  LeadContactRow,
  LeadRow,
  NormalizedContact,
  NormalizedLead,
  ProposalPpd,
  ProposalRow,
} from "@/types/lead";

/**
 * Proposal generation, split into the two steps the dashboard exposes:
 *
 *   1. `generatePpdDocument()`  → writes `proposals.ppd`            (no email, no PDF)
 *   2. `generateEmailDraft()`   → writes subject/body + opens a draft (custom recipient ok)
 *   3. `POST /api/drafts/:id/send` → compiles + renders the PDF, attaches, sends
 *
 * Nothing renders a PDF before a human has reviewed the PPD, and each step uses
 * its own editable prompt (`prompt_templates`, see /settings/prompts).
 */

export interface PromptRunInfo {
  key: "ppd_document" | "email_draft";
  label: string;
  isDefault: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  /** `GROQ_MAX_TOKENS`/prompt value before the TPM clamp. */
  requestedMaxTokens: number;
  reasoningEffort: string | null;
  /** The exact strings sent, after {{variable}} substitution. */
  system: string;
  user: string;
  /** `{{slots}}` the template used that we have no value for. */
  unknownVars: string[];
}

export interface PpdGenerationResult {
  proposal: ProposalRow;
  ppd: ProposalPpd;
  warnings: string[];
  usage: GroqUsage | null;
  costUsd: number | null;
  documentWords: number;
  prompt: PromptRunInfo;
}

export interface EmailGenerationResult {
  proposal: ProposalRow;
  email: { subject: string; content: string };
  draft: EmailDraftRow | null;
  draftError: string | null;
  recipient: { email: string; source: "lead_contact" | "custom"; contactId: string };
  warnings: string[];
  usage: GroqUsage | null;
  costUsd: number | null;
  prompt: PromptRunInfo;
}

export async function generatePpdDocument({
  lead,
  contact,
  regenerate = false,
  model,
  reasoningEffort,
}: {
  lead: LeadRow;
  contact: LeadContactRow;
  regenerate?: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<PpdGenerationResult> {
  const env = getServerEnv();
  const recipient = toNormalizedContact(contact);
  if (!recipient.isEmail) {
    throw ApiError.badRequest(`${contact.contact_value} is not an email address`);
  }

  const existing = (await leadsRepo.proposals(lead.id)).filter(
    (p) => p.lead_contact_id === contact.id,
  );
  const latest = existing[0]; // newest-first
  if (!regenerate && latest) {
    return {
      proposal: latest,
      ppd: latest.ppd as unknown as ProposalPpd,
      warnings: ["reused the existing proposal version"],
      usage: null,
      costUsd: null,
      documentWords: ppdWordCount(latest.ppd as unknown as ProposalPpd),
      prompt: placeholderPromptInfo("ppd_document", latest.model),
    };
  }

  const version = await leadsRepo.nextVersion(contact.id);
  const today = new Date().toISOString().slice(0, 10);
  const brand = brandConfig();
  const prompt = await resolvePrompt("ppd_document");
  const vars = buildPromptVars({
    lead: rehydrateNormalizedLead(lead, await leadsRepo.contacts(lead.id)),
    recipient,
    brand,
    today,
    language: env.PROPOSAL_LANGUAGE,
  });
  const rendered = renderPromptPair(prompt, vars);
  const maxTokens = prompt.maxTokens ?? groqConfig().maxTokens;
  const modelUsed = model ?? groqConfig().model;

  logger.info("ppd_generation_started", {
    leadId: lead.id,
    contactId: contact.id,
    version,
    model: modelUsed,
    maxTokens,
    reasoningEffort: reasoningEffort ?? prompt.reasoningEffort ?? groqConfig().reasoningEffort,
  });

  const completion = await groqJson<unknown>({
    messages: [
      { role: "system", content: rendered.system },
      { role: "user", content: rendered.user },
    ],
    temperature: prompt.temperature,
    maxTokens,
    ...(reasoningEffort ?? prompt.reasoningEffort
      ? { reasoningEffort: reasoningEffort ?? prompt.reasoningEffort! }
      : {}),
    model,
  });

  const ppd = sanitizePpd(completion.data, ppdContext(brand, lead, contact, today));
  const warnings = [
    ...assertPpdShape(ppd, completion.usage, maxTokens),
    ...unknownVarWarnings(rendered.unknown),
  ];

  const proposal = await proposalsRepo.create({
    leadId: lead.id,
    leadContactId: contact.id,
    version,
    output: { ppd },
    model: completion.model,
    provider: "groq",
    usage: completion.usage,
    // The PDF waits for the review: 'pending' until it is previewed or sent.
    pdfStatus: "pending",
  });

  await leadsRepo.setStatus(lead.id, "proposal_ready");

  const costUsd = completion.usage ? estimateGroqCost(completion.usage) : null;
  logger.info("ppd_generation_completed", {
    proposalId: proposal.id,
    version,
    words: ppdWordCount(ppd),
    usage: completion.usage,
    costUsd,
    warnings,
  });

  return {
    proposal,
    ppd,
    warnings,
    usage: completion.usage,
    costUsd,
    documentWords: ppdWordCount(ppd),
    prompt: promptInfo(prompt, completion, maxTokens, rendered.system, rendered.user, rendered.unknown),
  };
}

/**
 * Step 2 — write the email for a PPD a human has reviewed (or edited), then open
 * the draft. `toEmail` sends the pitch to an address that is not in the payload:
 * it is stored as a manual contact so the audit trail still explains itself.
 */
export async function generateEmailDraft({
  proposalId,
  contactId,
  toEmail,
  cc,
  senderAccountId,
  createDraft = true,
  model,
  reasoningEffort,
}: {
  proposalId: string;
  contactId?: string | null;
  toEmail?: string | null;
  cc?: string[] | null;
  senderAccountId?: string | null;
  createDraft?: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<EmailGenerationResult> {
  const env = getServerEnv();
  const proposal = await proposalsRepo.byId(proposalId);
  const lead = await leadsRepo.byId(proposal.lead_id);
  const ppd = proposal.ppd as unknown as ProposalPpd;

  const { contact, source } = await resolveRecipientContact(proposal.lead_id, {
    contactId: contactId ?? null,
    toEmail,
  });
  const contacts = await leadsRepo.contacts(proposal.lead_id);

  const today = new Date().toISOString().slice(0, 10);
  const brand = brandConfig();
  const prompt = await resolvePrompt("email_draft");
  const vars = buildPromptVars({
    lead: rehydrateNormalizedLead(lead, contacts),
    recipient: toNormalizedContact(contact),
    brand,
    today,
    language: env.PROPOSAL_LANGUAGE,
    ppd,
  });
  const rendered = renderPromptPair(prompt, vars);
  const maxTokens = prompt.maxTokens ?? groqConfig().maxTokens;

  logger.info("email_draft_generation_started", {
    proposalId,
    leadId: proposal.lead_id,
    recipient: contact.normalized_value ?? contact.contact_value,
    source,
    maxTokens,
  });

  const completion = await groqJson<unknown>({
    messages: [
      { role: "system", content: rendered.system },
      { role: "user", content: rendered.user },
    ],
    temperature: prompt.temperature,
    maxTokens,
    ...(reasoningEffort ?? prompt.reasoningEffort
      ? { reasoningEffort: reasoningEffort ?? prompt.reasoningEffort! }
      : {}),
    model,
  });

  const email = sanitizeEmail(completion.data, {
    jobTitle: lead.job_title ?? ppd.job_title,
    ppd,
  });
  const warnings = [
    ...assertEmailShape(email, completion.usage, maxTokens),
    ...unknownVarWarnings(rendered.unknown),
  ];

  const saved = await proposalsRepo.update(proposal.id, {
    email_subject: email.subject,
    email_content: email.content,
    email_html: textToHtml(email.content),
    model: completion.model,
  });

  let draft: EmailDraftRow | null = null;
  let draftError: string | null = null;
  if (createDraft) {
    try {
      draft = await createDraftForProposal({
        proposalId: saved.id,
        leadContactId: contact.id,
        toEmail: contact.normalized_value ?? contact.contact_value,
        recipientSource: source,
        cc: cc ?? null,
        senderAccountId,
      });
      if (lead.status !== "sent") await leadsRepo.setStatus(saved.lead_id, "draft_created");
    } catch (error) {
      // The email text is saved either way; only the draft step failed.
      draftError = error instanceof Error ? error.message : String(error);
      logger.warn("email_draft_creation_failed", { proposalId: saved.id, error: draftError });
    }
  }

  return {
    proposal: saved,
    email,
    draft,
    draftError,
    recipient: {
      email: contact.normalized_value ?? contact.contact_value,
      source,
      contactId: contact.id,
    },
    warnings,
    usage: completion.usage,
    costUsd: completion.usage ? estimateGroqCost(completion.usage) : null,
    prompt: promptInfo(prompt, completion, maxTokens, rendered.system, rendered.user, rendered.unknown),
  };
}

/**
 * Shared recipient resolution: an existing contact by id, the lead's primary
 * email, or a custom address typed by a human (persisted as a manual contact so
 * the lead page still shows where the send went).
 */
export async function resolveRecipientContact(
  leadId: string,
  input: { contactId?: string | null; toEmail?: string | null },
): Promise<{ contact: LeadContactRow; source: "lead_contact" | "custom" }> {
  const contacts = await leadsRepo.contacts(leadId);
  if (input.contactId) {
    const found = contacts.find((c) => c.id === input.contactId);
    if (!found) throw ApiError.notFound(`Contact ${input.contactId} is not on this lead`);
    if (!found.is_email) throw ApiError.badRequest(`${found.contact_value} is not an email address`);
    return { contact: found, source: "lead_contact" };
  }

  if (input.toEmail) {
    const wanted = input.toEmail.trim().toLowerCase();
    const match = contacts.find(
      (c) => (c.normalized_value ?? c.contact_value).toLowerCase() === wanted,
    );
    if (match) return { contact: match, source: "lead_contact" };
    const { row } = await leadsRepo.upsertManualContact(leadId, wanted);
    return { contact: row, source: "custom" };
  }

  const primary =
    contacts.find((c) => c.is_email && c.is_primary) ?? contacts.find((c) => c.is_email);
  if (!primary) {
    throw ApiError.badRequest(
      "No recipient: this lead has no email contact and none was typed in",
    );
  }
  return { contact: primary, source: "lead_contact" };
}

/** Re-validate a human-edited PPD before storing it. Structure is normalised and
 * clipped, but our own identity stays exactly as the reviewed document has it —
 * editing prose must not silently rewrite the branding.
 */
export function sanitizeEditedPpd(ppd: unknown, base: ProposalPpd): ProposalPpd {
  const sanitized = sanitizePpd({ ppd }, {
    company: base.company,
    website: base.website,
    preparedBy: base.prepared_by,
    rate: base.rate === "[TO CONFIRM]" ? "" : base.rate,
    senderEmail: base.company,
    jobTitle: base.job_title || null,
    jobReference: base.job_reference || null,
    recipientName: base.prepared_for,
    recipientCompany: null,
    clientName: null,
    today: new Date().toISOString().slice(0, 10),
    verifiedReferences: [],
  });

  return {
    ...sanitized,
    company: base.company,
    website: base.website,
    prepared_by: base.prepared_by,
    job_title: base.job_title,
    job_reference: base.job_reference,
  };
}

function ppdContext(
  brand: ReturnType<typeof brandConfig>,
  lead: LeadRow,
  contact: LeadContactRow,
  today: string,
) {
  return {
    company: brand.company,
    website: brand.website,
    preparedBy: brand.preparedBy,
    rate: brand.rate,
    senderEmail: brand.senderEmail,
    jobTitle: lead.job_title,
    jobReference: lead.job_id,
    recipientName: contact.name,
    recipientCompany: contact.company,
    clientName: lead.client_name,
    today,
    // We hold no vetted case studies, so any reference the model returns is
    // discarded rather than printed. Extend this from a future references table.
    verifiedReferences: [],
  };
}

function unknownVarWarnings(unknown: string[]): string[] {
  return unknown.length
    ? [`prompt template has unknown {{variables}} left unsubstituted: ${unknown.join(", ")}`]
    : [];
}

/** What actually went on the wire — the client may clamp the budget or effort. */
function promptInfo(
  prompt: ResolvedPrompt,
  completion: { model: string; reasoningEffort: ReasoningEffort; completionBudget: number },
  maxTokens: number,
  system: string,
  user: string,
  unknownVars: string[],
): PromptRunInfo {
  return {
    key: prompt.key,
    label: prompt.label,
    isDefault: prompt.isDefault,
    model: completion.model,
    temperature: prompt.temperature,
    maxTokens: completion.completionBudget || maxTokens,
    requestedMaxTokens: maxTokens,
    reasoningEffort: completion.reasoningEffort,
    system,
    user,
    unknownVars,
  };
}

function placeholderPromptInfo(key: PromptRunInfo["key"], model: string | null): PromptRunInfo {
  return {
    key,
    label: key === "ppd_document" ? "PPD document" : "Email draft",
    isDefault: true,
    model: model ?? groqConfig().model,
    temperature: 0,
    maxTokens: 0,
    requestedMaxTokens: 0,
    reasoningEffort: null,
    system: "",
    user: "",
    unknownVars: [],
  };
}

/**
 * The prompt wants the fully normalised payload; we stored it as JSONB, so
 * rebuild the minimum fields the prompt uses rather than re-parsing.
 */
function rehydrateNormalizedLead(lead: LeadRow, contacts: LeadContactRow[] = []): NormalizedLead {
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
    contacts: contacts.map(toNormalizedContact),
    primaryEmail: (() => {
      const primary =
        contacts.find((c) => c.is_email && c.is_primary) ?? contacts.find((c) => c.is_email);
      return primary ? toNormalizedContact(primary) : null;
    })(),
  };
}

function toNormalizedContact(contact: LeadContactRow): NormalizedContact {
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

export type { ProposalBrand };
