import { getServerEnv } from "@/lib/env";
import { brandConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import type { Json } from "@/types/database";
import { textToHtml } from "@/server/services/templates";
import { ApiError } from "@/server/http/errors";
import { leadsRepo } from "@/server/db/leads.repo";
import { proposalsRepo } from "@/server/db/outreach.repo";
import { chatgptJobsRepo, type ChatGptJobRow } from "@/server/db/chatgpt-jobs.repo";
import {
  bracketWarnings,
  DOC_WORD_TARGET,
  findBracketTokens,
  ppdWordCount,
  sanitizeEmail,
  sanitizePpd,
} from "@/server/services/proposal-sanitize";
import {
  buildPromptVars,
  extractQuestions,
  type PromptKey,
  type ProposalBrand,
} from "@/server/services/prompts/proposal.prompt";
import { resolveSenderBrand } from "@/server/services/sender-profile.service";
import { renderPromptPair, resolvePrompt } from "@/server/services/prompts/registry";
import {
  ppdContext,
  rehydrateNormalizedLead,
  resolveRecipientContact,
  toNormalizedContact,
} from "@/server/services/proposal.service";
import { createDraftForProposal, createFollowUpDraft } from "@/server/services/draft.service";
import type {
  EmailDraftRow,
  LeadContactRow,
  ProposalPpd,
  ProposalRow,
} from "@/types/lead";

/**
 * PPD and email generation through the ChatGPT tab the signed-in user already
 * has. The server only prepares the exact prompt and later validates and stores
 * the answer; no OpenAI/ChatGPT API key exists anywhere in this path.
 */

export type ChatGptJobKind = ChatGptJobRow["kind"];

interface StoredPromptMeta {
  /** Index signature so the object is accepted by the Supabase JSON column. */
  [key: string]: string | number | boolean | null | string[];
  key: PromptKey;
  label: string;
  isDefault: boolean;
  temperature: number;
  maxTokens: number | null;
  unknownVars: string[];
  model: "chatgpt-session";
}

interface PpdJobContext {
  kind: "ppd_document";
  version: number;
  today: string;
  contactId: string | null;
  recipientSource: "lead_contact" | "custom" | "none";
  senderAccountId: string | null;
  brand: ProposalBrand;
}

interface EmailJobContext {
  kind: "email_draft";
  contactId: string;
  toEmail: string;
  recipientSource: "lead_contact" | "custom";
  cc: string[] | null;
  senderAccountId: string | null;
  createDraft: boolean;
  brand: ProposalBrand;
}

interface FollowUpJobContext {
  kind: "follow_up";
  contactId: string;
  toEmail: string;
  recipientSource: "lead_contact" | "custom";
  cc: string[] | null;
  senderAccountId: string | null;
  previousDraftId: string;
  sequence: number;
  threadSubject: string;
  brand: ProposalBrand;
}

type JobContext = PpdJobContext | EmailJobContext | FollowUpJobContext;

export interface ChatGptJobDto {
  id: string;
  leadId: string;
  proposalId: string | null;
  contactId: string | null;
  kind: ChatGptJobKind;
  status: ChatGptJobRow["status"];
  label: string;
  system: string;
  prompt: string;
  promptMeta: StoredPromptMeta;
  responseText: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export function toChatGptJobDto(row: ChatGptJobRow): ChatGptJobDto {
  const meta = (row.prompt_meta ?? {}) as Partial<StoredPromptMeta>;
  return {
    id: row.id,
    leadId: row.lead_id,
    proposalId: row.proposal_id,
    contactId: row.contact_id,
    kind: row.kind,
    status: row.status,
    label: row.prompt_label,
    system: row.prompt_system,
    prompt: row.prompt_user,
    promptMeta: {
      key: (meta.key ?? row.prompt_key) as PromptKey,
      label: meta.label ?? row.prompt_label,
      isDefault: meta.isDefault ?? true,
      temperature: Number(meta.temperature ?? 0.5),
      maxTokens: meta.maxTokens ?? null,
      unknownVars: meta.unknownVars ?? [],
      model: "chatgpt-session",
    },
    responseText: row.response_text,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export interface PrepareJobInput {
  leadId: string;
  kind: ChatGptJobKind;
  proposalId?: string | null;
  contactId?: string | null;
  toEmail?: string | null;
  cc?: string[] | null;
  senderAccountId?: string | null;
  regenerate?: boolean;
  previousDraftId?: string | null;
  createDraft?: boolean;
  createdBy?: string;
}

export type PrepareJobResult =
  | { job: ChatGptJobRow; dto: ChatGptJobDto; reused: false }
  | { job: null; dto: null; reused: true; proposal: ProposalRow };

export async function prepareChatGptJob(input: PrepareJobInput): Promise<PrepareJobResult> {
  // Never let a job from a closed browser block this lead forever.
  await chatgptJobsRepo.cancelStale(input.leadId);
  switch (input.kind) {
    case "ppd_document":
      return preparePpd(input);
    case "email_draft":
      return prepareEmail(input);
    case "follow_up":
      return prepareFollowUp(input);
    default:
      throw ApiError.badRequest(`Unknown generation kind: ${String(input.kind)}`);
  }
}

async function preparePpd(input: PrepareJobInput): Promise<PrepareJobResult> {
  const env = getServerEnv();
  const lead = await leadsRepo.byId(input.leadId);
  const { contact, source } = await resolveRecipientContact(input.leadId, {
    contactId: input.contactId,
    toEmail: input.toEmail,
    requireRecipient: false,
  });

  if (contact && !contact.is_email) {
    throw ApiError.badRequest(`${contact.contact_value} is not an email address`);
  }

  if (input.regenerate === false) {
    const existing = (await leadsRepo.proposals(input.leadId)).filter(
      (p) => (p.lead_contact_id ?? null) === (contact?.id ?? null),
    );
    if (existing[0]) {
      return { job: null, dto: null, reused: true, proposal: existing[0] };
    }
  }

  const version = await leadsRepo.nextVersion(contact?.id ?? null, input.leadId);
  const today = new Date().toISOString().slice(0, 10);
  const brand = await resolveSenderBrand(input.senderAccountId);
  const prompt = await resolvePrompt("ppd_document");
  const rendered = renderPromptPair(
    prompt,
    buildPromptVars({
      lead: rehydrateNormalizedLead(lead, await leadsRepo.contacts(input.leadId)),
      recipient: contact ? toNormalizedContact(contact) : null,
      brand,
      today,
      language: env.PROPOSAL_LANGUAGE,
    }),
  );

  const job = await chatgptJobsRepo.create({
    leadId: input.leadId,
    proposalId: null,
    contactId: contact?.id ?? null,
    kind: "ppd_document",
    promptKey: prompt.key,
    promptLabel: prompt.label,
    promptSystem: rendered.system,
    promptUser: rendered.user,
    promptMeta: promptMeta(prompt, rendered.unknown),
    context: {
      kind: "ppd_document",
      version,
      today,
      contactId: contact?.id ?? null,
      recipientSource: source,
      senderAccountId: input.senderAccountId ?? null,
      brand,
    } as unknown as Json,
    createdBy: input.createdBy ?? "",
  });

  logger.info("chatgpt_ppd_prepared", {
    jobId: job.id,
    leadId: input.leadId,
    contactId: contact?.id ?? null,
    version,
    unknownVars: rendered.unknown,
  });

  return { job, dto: toChatGptJobDto(job), reused: false };
}

async function prepareEmail(input: PrepareJobInput): Promise<PrepareJobResult> {
  const env = getServerEnv();
  const proposal = await resolveProposal(input.leadId, input.proposalId);
  const ppd = proposal.ppd as unknown as ProposalPpd | null;
  if (!ppd) {
    throw ApiError.badRequest(
      "This proposal has no PPD yet. Generate and review the document before writing the email.",
    );
  }
  const lead = await leadsRepo.byId(proposal.lead_id);
  const resolved = await resolveRecipientContact(proposal.lead_id, {
    contactId: input.contactId,
    toEmail: input.toEmail,
    requireRecipient: true,
  });
  const contact = resolved.contact as LeadContactRow;
  const source = resolved.source === "none" ? "custom" : resolved.source;
  const contacts = await leadsRepo.contacts(proposal.lead_id);
  const today = new Date().toISOString().slice(0, 10);
  // A draft may be written from a mailbox other than the lead's default; the
  // selected profile supplies the signature and the real experience text.
  const brand = await resolveSenderBrand(input.senderAccountId);
  const prompt = await resolvePrompt("email_draft");
  const rendered = renderPromptPair(
    prompt,
    buildPromptVars({
      lead: rehydrateNormalizedLead(lead, contacts),
      recipient: toNormalizedContact(contact),
      brand,
      today,
      language: env.PROPOSAL_LANGUAGE,
      ppd,
    }),
  );

  const job = await chatgptJobsRepo.create({
    leadId: proposal.lead_id,
    proposalId: proposal.id,
    contactId: contact.id,
    kind: "email_draft",
    promptKey: prompt.key,
    promptLabel: prompt.label,
    promptSystem: rendered.system,
    promptUser: rendered.user,
    promptMeta: promptMeta(prompt, rendered.unknown),
    context: {
      kind: "email_draft",
      contactId: contact.id,
      toEmail: contact.normalized_value ?? contact.contact_value,
      recipientSource: source,
      cc: input.cc ?? null,
      senderAccountId: input.senderAccountId ?? null,
      createDraft: input.createDraft !== false,
      brand,
    } as unknown as Json,
    createdBy: input.createdBy ?? "",
  });

  logger.info("chatgpt_email_prepared", {
    jobId: job.id,
    leadId: proposal.lead_id,
    proposalId: proposal.id,
    recipient: contact.normalized_value ?? contact.contact_value,
  });

  return { job, dto: toChatGptJobDto(job), reused: false };
}

async function prepareFollowUp(input: PrepareJobInput): Promise<PrepareJobResult> {
  const env = getServerEnv();
  const proposal = await resolveProposal(input.leadId, input.proposalId);
  const ppd = proposal.ppd as unknown as ProposalPpd | null;
  if (!ppd) throw ApiError.badRequest("The proposal document is missing");
  const lead = await leadsRepo.byId(proposal.lead_id);
  const resolved = await resolveRecipientContact(proposal.lead_id, {
    contactId: input.contactId,
    toEmail: input.toEmail,
    requireRecipient: true,
  });
  const contact = resolved.contact as LeadContactRow;
  const source = resolved.source === "none" ? "custom" : resolved.source;
  const allDrafts = await leadsRepo.drafts(proposal.lead_id);
  const sent = allDrafts
    // The thread belongs to the contact, not to one PPD version: a follow-up
    // after a regenerated document must still continue the same conversation.
    .filter((draft) => draft.status === "sent" && (draft.lead_contact_id ?? null) === contact.id)
    .sort((a, b) =>
      String(a.sent_at ?? a.created_at).localeCompare(String(b.sent_at ?? b.created_at)),
    );
  const previous = input.previousDraftId
    ? sent.find((draft) => draft.id === input.previousDraftId)
    : sent[sent.length - 1];
  if (!previous) {
    throw ApiError.badRequest(
      "A follow-up needs an earlier sent email to this contact. Send the first email, then follow up.",
    );
  }
  // A thread is linear. Once a child exists, following up from its parent would
  // fork the conversation (and re-use the wrong Message-ID chain); the child is
  // the only valid starting point until it is cancelled.
  const child = allDrafts.find(
    (draft) => draft.parent_draft_id === previous.id && draft.status !== "cancelled",
  );
  if (child) {
    throw ApiError.badRequest(
      child.status === "sent"
        ? "A newer follow-up was already sent on this thread. Follow up from that message instead."
        : "A follow-up for this message already exists. Send or cancel that draft first.",
    );
  }
  const sequence = Math.max(1, ...sent.map((draft) => draft.sequence ?? 1)) + 1;
  const lastSentAt = previous.sent_at ?? previous.created_at;
  const daysSince = Math.max(
    0,
    Math.floor((Date.now() - new Date(lastSentAt).getTime()) / 86_400_000),
  );
  // Continue the exact thread address, even when a reviewer edited the draft
  // after it was created. The contact id still anchors the history; only the
  // recipient address can differ from the contact row.
  const contactEmail = (contact.normalized_value ?? contact.contact_value).trim().toLowerCase();
  const targetEmail = (input.toEmail?.trim() || previous.to_email).trim().toLowerCase();
  if (!targetEmail.includes("@")) throw ApiError.badRequest(`${targetEmail} is not an email address`);
  const recipientSource: "lead_contact" | "custom" =
    targetEmail === contactEmail && source !== "custom" ? "lead_contact" : "custom";
  const lastSubject = previous.subject.trim();
  const threadSubject = /^re\s*:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`;
  const previousEmails = sent
    .slice(-4)
    .reverse()
    .map((draft) => ({
      subject: draft.subject,
      body: clipText(draft.body_text, 1_400),
      sentAt: (draft.sent_at ?? draft.created_at).slice(0, 10),
      sequence: draft.sequence ?? 1,
    }));

  const today = new Date().toISOString().slice(0, 10);
  // Continue from the same person/mailbox that sent the previous touch.
  const brand = await resolveSenderBrand(previous.sender_account_id ?? input.senderAccountId);
  const prompt = await resolvePrompt("follow_up");
  const normalizedRecipient = toNormalizedContact(contact);
  const promptRecipient =
    targetEmail === normalizedRecipient.normalizedValue
      ? normalizedRecipient
      : { ...normalizedRecipient, normalizedValue: targetEmail, contactValue: targetEmail };
  const rendered = renderPromptPair(
    prompt,
    buildPromptVars({
      lead: rehydrateNormalizedLead(lead, await leadsRepo.contacts(proposal.lead_id)),
      recipient: promptRecipient,
      brand,
      today,
      language: env.PROPOSAL_LANGUAGE,
      ppd,
      history: {
        sequence,
        previousEmails,
        lastSubject,
        lastSentAt: lastSentAt.slice(0, 10),
        daysSinceLastEmail: daysSince,
        threadSubject,
      },
    }),
  );

  const job = await chatgptJobsRepo.create({
    leadId: proposal.lead_id,
    proposalId: proposal.id,
    contactId: contact.id,
    kind: "follow_up",
    promptKey: prompt.key,
    promptLabel: prompt.label,
    promptSystem: rendered.system,
    promptUser: rendered.user,
    promptMeta: promptMeta(prompt, rendered.unknown),
    context: {
      kind: "follow_up",
      contactId: contact.id,
      toEmail: targetEmail,
      recipientSource,
      cc: previous.cc ?? null,
      senderAccountId: previous.sender_account_id ?? null,
      previousDraftId: previous.id,
      sequence,
      threadSubject,
      brand,
    } as unknown as Json,
    createdBy: input.createdBy ?? "",
  });

  logger.info("chatgpt_follow_up_prepared", {
    jobId: job.id,
    leadId: proposal.lead_id,
    proposalId: proposal.id,
    previousDraftId: previous.id,
    sequence,
  });

  return { job, dto: toChatGptJobDto(job), reused: false };
}

export type CompleteJobResult = {
  job: ChatGptJobDto;
  proposal?: ProposalRow;
  ppd?: ProposalPpd;
  email?: {
    subject: string;
    content: string;
    similarProducts: Array<{ name: string; url: string; why: string }>;
  };
  draft?: EmailDraftRow | null;
  draftError?: string | null;
  recipient?: { email: string; source: "lead_contact" | "custom"; contactId: string };
  documentWords?: number;
  warnings: string[];
};

export async function completeChatGptJob(
  jobId: string,
  responseText: string,
): Promise<CompleteJobResult> {
  const answer = responseText.trim();
  if (!answer) throw ApiError.badRequest("Paste the ChatGPT answer before finalising");

  const claimed = await chatgptJobsRepo.claimCompletion(jobId, answer);
  const row = claimed.job;
  if (!claimed.claimed) {
    if (row.status === "completed") {
      return { job: toChatGptJobDto(row), warnings: ["this answer was already stored"] };
    }
    if (row.status === "completing") {
      throw ApiError.conflict("This answer is already being stored by another tab");
    }
    throw ApiError.conflict(`This ChatGPT job is ${row.status} and cannot be completed.`);
  }

  let result: CompleteJobResult;
  try {
    const parsed = parseModelJson(answer);
    const context = row.context as unknown as JobContext;
    if (row.kind === "ppd_document") {
      result = await completePpd(row, parsed, context as PpdJobContext);
    } else if (row.kind === "email_draft") {
      result = await completeEmail(row, parsed, context as EmailJobContext);
    } else {
      result = await completeFollowUp(row, parsed, context as FollowUpJobContext);
    }
  } catch (error) {
    // The answer was bad or the write failed: give the job back so a corrected
    // paste (or a retry) can claim it again instead of blocking the lead.
    await chatgptJobsRepo.releaseCompletion(row.id).catch(() => undefined);
    throw error;
  }

  const completed = await chatgptJobsRepo.finishCompletion(row.id);
  return { ...result, job: toChatGptJobDto(completed) };
}

async function completePpd(
  row: ChatGptJobRow,
  parsed: unknown,
  context: PpdJobContext,
): Promise<CompleteJobResult> {
  const lead = await leadsRepo.byId(row.lead_id);
  const contact = row.contact_id ? await leadsRepo.contactById(row.contact_id) : null;
  const brand = context.brand ?? brandConfig();
  const ppd = sanitizePpd(
    parsed,
    ppdContext(brand, lead, contact, context.today || new Date().toISOString().slice(0, 10)),
  );
  const words = ppdWordCount(ppd);
  const warnings = [
    ...bracketWarnings(findBracketTokens(parsed)),
    ...unknownVarWarnings(row),
  ];
  if (words < Math.round(DOC_WORD_TARGET.min * 0.5)) {
    warnings.push(
      `The answer is short (${words} words). Check the document before sending it; regenerate if sections are missing.`,
    );
  }

  const proposal = await proposalsRepo.create({
    leadId: row.lead_id,
    leadContactId: row.contact_id,
    version: context.version,
    output: { ppd },
    model: "chatgpt-session",
    provider: "chatgpt-session",
    usage: null,
    pdfStatus: "pending",
  });
  // A failed status touch must not make the caller retry: the proposal is
  // already stored, and a retry would collide with its version.
  await leadsRepo.setStatus(row.lead_id, "proposal_ready").catch((error) => {
    logger.warn("chatgpt_ppd_status_failed", {
      jobId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info("chatgpt_ppd_completed", {
    jobId: row.id,
    proposalId: proposal.id,
    version: context.version,
    words,
    warnings,
  });

  return { job: toChatGptJobDto(row), proposal, ppd, documentWords: words, warnings };
}

async function completeEmail(
  row: ChatGptJobRow,
  parsed: unknown,
  context: EmailJobContext,
): Promise<CompleteJobResult> {
  if (!row.proposal_id) throw ApiError.badRequest("This job has no proposal attached");
  const proposal = await proposalsRepo.byId(row.proposal_id);
  const lead = await leadsRepo.byId(proposal.lead_id);
  const ppd = proposal.ppd as unknown as ProposalPpd;
  const brand = context.brand ?? brandConfig();
  const email = sanitizeEmail(parsed, {
    jobTitle: lead.job_title ?? ppd.job_title,
    ppd,
    signature: brand.signature,
    sender: brand,
    jobDescription: lead.job_description ?? "",
    jobQuestions: extractQuestions(lead.job_description),
  });
  const warnings = [
    ...bracketWarnings(findBracketTokens(parsed)),
    ...unknownVarWarnings(row),
  ];

  const saved = await proposalsRepo.update(proposal.id, {
    email_subject: email.subject,
    email_content: email.content,
    email_html: textToHtml(email.content),
    model: "chatgpt-session",
  });

  let draft: EmailDraftRow | null = null;
  let draftError: string | null = null;
  if (context.createDraft !== false) {
    try {
      draft = await createDraftForProposal({
        proposalId: saved.id,
        leadContactId: context.contactId,
        toEmail: context.toEmail,
        recipientSource: context.recipientSource,
        cc: context.cc,
        senderAccountId: context.senderAccountId,
      });
      if (lead.status !== "sent") {
        await leadsRepo.setStatus(saved.lead_id, "draft_created").catch((error) => {
          logger.warn("chatgpt_email_status_failed", {
            jobId: row.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      draftError = error instanceof Error ? error.message : String(error);
      logger.warn("chatgpt_email_draft_failed", { jobId: row.id, proposalId: saved.id, error: draftError });
    }
  }

  return {
    job: toChatGptJobDto(row),
    proposal: saved,
    email,
    draft,
    draftError,
    recipient: {
      email: context.toEmail,
      source: context.recipientSource,
      contactId: context.contactId,
    },
    warnings,
  };
}

async function completeFollowUp(
  row: ChatGptJobRow,
  parsed: unknown,
  context: FollowUpJobContext,
): Promise<CompleteJobResult> {
  if (!row.proposal_id) throw ApiError.badRequest("This job has no proposal attached");
  const proposal = await proposalsRepo.byId(row.proposal_id);
  const lead = await leadsRepo.byId(proposal.lead_id);
  const ppd = proposal.ppd as unknown as ProposalPpd;
  const brand = context.brand ?? brandConfig();
  const email = sanitizeEmail(parsed, {
    jobTitle: lead.job_title ?? ppd.job_title,
    ppd,
    signature: brand.signature,
    sender: brand,
    jobDescription: lead.job_description ?? "",
    jobQuestions: extractQuestions(lead.job_description),
  });
  const warnings = [
    ...bracketWarnings(findBracketTokens(parsed)),
    ...unknownVarWarnings(row),
  ];
  const threadSubject = context.threadSubject || email.subject;
  const finalEmail = { ...email, subject: threadSubject };

  const draft = await createFollowUpDraft({
    proposalId: proposal.id,
    leadContactId: context.contactId,
    toEmail: context.toEmail,
    subject: threadSubject,
    bodyText: finalEmail.content,
    cc: context.cc,
    recipientSource: context.recipientSource,
    senderAccountId: context.senderAccountId,
    parentDraftId: context.previousDraftId,
    sequence: context.sequence,
  });

  return {
    job: toChatGptJobDto(row),
    proposal,
    email: finalEmail,
    draft,
    recipient: {
      email: context.toEmail,
      source: context.recipientSource,
      contactId: context.contactId,
    },
    warnings,
  };
}

function promptMeta(
  prompt: Awaited<ReturnType<typeof resolvePrompt>>,
  unknownVars: string[],
): StoredPromptMeta {
  return {
    key: prompt.key,
    label: prompt.label,
    isDefault: prompt.isDefault,
    temperature: prompt.temperature,
    maxTokens: prompt.maxTokens,
    unknownVars,
    model: "chatgpt-session",
  };
}

function unknownVarWarnings(row: ChatGptJobRow): string[] {
  const meta = (row.prompt_meta ?? {}) as Partial<StoredPromptMeta>;
  return meta.unknownVars?.length
    ? [`the prompt left unknown {{variables}} unsubstituted: ${meta.unknownVars.join(", ")}`]
    : [];
}

async function resolveProposal(leadId: string, proposalId?: string | null) {
  const proposals = await leadsRepo.proposals(leadId);
  const proposal = proposalId
    ? proposals.find((p) => p.id === proposalId)
    : (proposals.find((p) => p.ppd != null) ?? proposals[0]);
  if (!proposal) {
    throw ApiError.notFound("This lead has no PPD yet. Generate the document first.");
  }
  return proposal;
}

/**
 * ChatGPT sometimes wraps the JSON in a fence or a sentence. Find the first
 * balanced object, respecting braces inside strings, and parse that.
 */
export function parseModelJson(text: string): unknown {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const attempts = [cleaned];
  // A short preamble can itself contain a brace (for example "{JSON} below").
  // Try each opening brace until one yields a complete, parseable object.
  let from = 0;
  for (let candidates = 0; candidates < 25; candidates += 1) {
    const start = cleaned.indexOf("{", from);
    if (start < 0) break;
    const end = balancedEnd(cleaned, start);
    if (end > start) attempts.push(cleaned.slice(start, end + 1));
    from = start + 1;
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  throw ApiError.badRequest(
    "ChatGPT did not return a JSON answer. Ask it to answer with the requested JSON object, then paste that here.",
  );
}

function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function clipText(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
