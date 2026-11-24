import { getServerEnv } from "@/lib/env";
import { brandConfig, groqConfig } from "@/lib/env-extras";
import { aiResolution } from "@/lib/env";
import { logger } from "@/lib/logger";
import { textToHtml } from "@/server/services/templates";
import { ApiError } from "@/server/http/errors";
import { leadsRepo } from "@/server/db/leads.repo";
import { proposalsRepo } from "@/server/db/outreach.repo";
import type { ReasoningEffort } from "@/server/services/groq.client";
import { aiCostOf, aiJson } from "@/server/services/ai";
import type { AiUsage } from "@/server/services/ai/types";
import {
  assertEmailShape,
  assertPpdShape,
  bracketWarnings,
  DOC_WORD_TARGET,
  findBracketTokens,
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
  usage: AiUsage | null;
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
  usage: AiUsage | null;
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
  /** null ⇒ write the document from the post alone (no address known yet). */
  contact: LeadContactRow | null;
  regenerate?: boolean;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<PpdGenerationResult> {
  const env = getServerEnv();
  const recipient = contact ? toNormalizedContact(contact) : null;
  if (contact && !recipient!.isEmail) {
    throw ApiError.badRequest(`${contact.contact_value} is not an email address`);
  }

  const existing = (await leadsRepo.proposals(lead.id)).filter(
    (p) => (p.lead_contact_id ?? null) === (contact?.id ?? null),
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

  const version = await leadsRepo.nextVersion(contact?.id ?? null, lead.id);
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
  const ai = aiResolution();
  const maxTokens = prompt.maxTokens ?? ai.maxTokens;
  const modelUsed = model ?? ai.model;

  logger.info("ppd_generation_started", {
    leadId: lead.id,
    contactId: contact?.id ?? null,
    version,
    provider: ai.provider,
    model: modelUsed,
    maxTokens,
    reasoningEffort: reasoningEffort ?? prompt.reasoningEffort ?? groqConfig().reasoningEffort,
  });

  const callModel = (effort?: ReasoningEffort) =>
    aiJson<unknown>({
      messages: [
        { role: "system", content: rendered.system },
        { role: "user", content: rendered.user },
      ],
      temperature: prompt.temperature,
      maxTokens,
      ...(effort ?? reasoningEffort ?? prompt.reasoningEffort
        ? { reasoningEffort: effort ?? reasoningEffort ?? prompt.reasoningEffort! }
        : {}),
      model,
    });

  let completion = await callModel();
  const ctx = ppdContext(brand, lead, contact, today);
  let ppd = sanitizePpd(completion.data, ctx);

  /**
   * GPT-OSS bills hidden reasoning inside the same completion budget as the
   * answer, so a run can think itself into a stub: cap hit (or nearly) and a
   * document far below the floor. Rather than storing that, spend the thinking
   * on the page — retry once at `low` and once with reasoning off.
   */
  const starved = () => {
    const spent = completion.usage?.completion_tokens ?? 0;
    const reasoned = completion.usage?.reasoning_tokens ?? 0;
    return (
      ppdWordCount(ppd) < Math.round(DOC_WORD_TARGET.min * 0.55) &&
      (spent >= completion.completionBudget - 32 || reasoned > spent * 0.6)
    );
  };

  if (starved()) {
    for (const step of ["low", "none"] as ReasoningEffort[]) {
      if (completion.reasoningEffort === step) continue;
      logger.warn("ppd_reasoning_starved_retry", {
        leadId: lead.id,
        version,
        words: ppdWordCount(ppd),
        from: completion.reasoningEffort,
        to: step,
        usage: completion.usage,
      });
      completion = await callModel(step);
      ppd = sanitizePpd(completion.data, ctx);
      if (!starved()) break;
    }
  }

  const brackets = findBracketTokens(completion.data);
  const warnings = [
    ...assertPpdShape(ppd, completion.usage, maxTokens),
    ...bracketWarnings(brackets),
    ...unknownVarWarnings(rendered.unknown),
    ...providerFallbackWarnings(completion),
  ];

  const proposal = await proposalsRepo.create({
    leadId: lead.id,
    leadContactId: contact?.id ?? null,
    version,
    output: { ppd },
    model: completion.model,
    // Recorded per proposal: a lead generated last month on Groq and one today
    // on Puter must be tellable apart from the row alone.
    provider: completion.provider,
    usage: completion.usage,
    // The PDF waits for the review: 'pending' until it is previewed or sent.
    pdfStatus: "pending",
  });

  await leadsRepo.setStatus(lead.id, "proposal_ready");

  const cost = aiCostOf(completion.usage);
  logger.info("ppd_generation_completed", {
    proposalId: proposal.id,
    version,
    words: ppdWordCount(ppd),
    provider: completion.provider,
    usage: completion.usage,
    costUsd: cost.usd,
    // `billed` is Puter's real charge to the account; `estimated` is Groq's
    // list-price math over the reported tokens.
    costBasis: cost.basis,
    warnings,
  });

  return {
    proposal,
    ppd,
    warnings,
    usage: completion.usage,
    costUsd: cost.usd,
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

  const resolved = await resolveRecipientContact(proposal.lead_id, {
    contactId: contactId ?? null,
    toEmail,
    requireRecipient: true,
  });
  if (!resolved.contact) {
    throw ApiError.badRequest(
      "The email step needs a recipient: pass toEmail (any address) or contactId",
    );
  }
  const contact: LeadContactRow = resolved.contact;
  const source: "lead_contact" | "custom" = resolved.source === "none" ? "custom" : resolved.source;
  const contacts = await leadsRepo.contacts(proposal.lead_id);

  const today = new Date().toISOString().slice(0, 10);
  const brand = brandConfig();
  const prompt = await resolvePrompt("email_draft");
  const vars = buildPromptVars({
    lead: rehydrateNormalizedLead(lead, contacts),
    recipient: toNormalizedContact(contact!),
    brand,
    today,
    language: env.PROPOSAL_LANGUAGE,
    ppd,
  });
  const rendered = renderPromptPair(prompt, vars);
  const ai = aiResolution();
  const maxTokens = prompt.maxTokens ?? ai.maxTokens;

  logger.info("email_draft_generation_started", {
    provider: ai.provider,
    proposalId,
    leadId: proposal.lead_id,
    recipient: contact.normalized_value ?? contact.contact_value,
    source,
    maxTokens,
  });

  const completion = await aiJson<unknown>({
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
    signature: brand.signature,
  });
  const warnings = [
    ...providerFallbackWarnings(completion),
    ...assertEmailShape(email, completion.usage, maxTokens),
    ...bracketWarnings(findBracketTokens(completion.data)),
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
    costUsd: aiCostOf(completion.usage).usd,
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
  input: {
    contactId?: string | null;
    toEmail?: string | null;
    /**
     * The PPD step may run with no recipient at all (a document written from the
     * post itself, before the scraper has an address). The email step always
     * needs one, since a draft cannot be addressed to nobody.
     */
    requireRecipient?: boolean;
  },
): Promise<{
  contact: LeadContactRow | null;
  source: "lead_contact" | "custom" | "none";
}> {
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
    if (input.requireRecipient === false) return { contact: null, source: "none" };
    throw ApiError.badRequest(
      "No recipient: this lead has no email contact and none was typed in",
    );
  }
  return { contact: primary, source: "lead_contact" };
}

/**
 * Re-validate a human-edited PPD before storing it.
 *
 * Prose is normalised and clipped, and our identity comes from the **current**
 * environment: a document generated before `PROPOSAL_*` was configured upgrades
 * to the real company, byline and site on its next save, and a rate the model
 * left as a bracket stops being one. Lead facts (job title/reference) stay as
 * reviewed, because those belong to the post, not to us.
 */
export function sanitizeEditedPpd(ppd: unknown, base: ProposalPpd): ProposalPpd {
  const brand = brandConfig();
  const company = brand.raw.company || base.company;
  const website = brand.raw.website || base.website;
  const preparedBy = brand.preparedLine || base.prepared_by;
  const sanitized = sanitizePpd({ ppd }, {
    company,
    website,
    preparedBy,
    rate: brand.raw.rate || "",
    senderEmail: brand.senderEmail || base.company,
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
    company,
    website,
    prepared_by: preparedBy,
    job_title: base.job_title,
    job_reference: base.job_reference,
  };
}

function ppdContext(
  brand: ReturnType<typeof brandConfig>,
  lead: LeadRow,
  contact: LeadContactRow | null,
  today: string,
) {
  return {
    company: brand.company,
    website: brand.website,
    // The byline carries the role, so the PDF and the document sign as a person
    // with a title rather than a bare name.
    preparedBy: brand.preparedLine || brand.preparedBy,
    rate: brand.rate,
    senderEmail: brand.senderEmail,
    jobTitle: lead.job_title,
    jobReference: lead.job_id,
    // A recipient-less post is addressed to the hiring team in general.
    recipientName: contact?.name ?? null,
    recipientCompany: contact?.company ?? lead.company_mentioned ?? null,
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
/**
 * Say out loud when the preferred provider did not answer.
 *
 * The document is still good — a different model wrote it — but the reviewer
 * should know the cheaper-or-configured route was unavailable, because the next
 * ten leads will cost money in a different account.
 */
function providerFallbackWarnings(completion: AiResultLike): string[] {
  if (!completion.attempts?.length) return [];
  const tried = completion.attempts
    .map((a) => `${a.provider} (${a.model}) failed after ${a.ms}ms: ${a.error}`)
    .join(" · ");
  return [
    `Answered by ${completion.provider} after a fallback: ${tried}. Check the provider keys on /settings/models (and the Puter allowance) if this repeats.`,
  ];
}

interface AiResultLike {
  provider?: "puter" | "groq" | "gemini";
  attempts?: Array<{ provider: string; model: string; ms: number; error: string }>;
}

function promptInfo(
  prompt: ResolvedPrompt,
  completion: {
    model: string;
    reasoningEffort?: ReasoningEffort;
    completionBudget: number;
  },
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
    reasoningEffort: completion.reasoningEffort ?? null,
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
    model: model ?? aiResolution().model,
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
