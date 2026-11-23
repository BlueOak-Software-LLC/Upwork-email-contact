import { getServerEnv } from "@/lib/env";
import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { emailRecipients, normalizeLeadPayload } from "@/lib/validation/lead";
import { leadsRepo } from "@/server/db/leads.repo";
import { generateProposal } from "@/server/services/proposal.service";
import { createDraftForProposal } from "@/server/services/draft.service";
import type {
  EmailDraftRow,
  IngestResult,
  LeadContactRow,
  LeadRow,
  ProposalRow,
} from "@/types/lead";

const MAX_GENERATIONS_PER_LEAD = 3;

export interface IngestOptions {
  /** Generate proposals + drafts automatically (env AUTO_ENRICH_LEADS by default). */
  autoEnrich?: boolean;
  /** Force a new proposal version even if one exists. */
  regenerate?: boolean;
  /** Persist the lead and contacts only — no Groq calls, no drafts. */
  dryRun?: boolean;
  senderAccountId?: string | null;
}

/**
 * The ingest pipeline behind `POST /api/leads`:
 *
 *   payload → normalise → upsert lead → replace lead_contacts
 *           → pick email recipients from verified_contacts + potential_contacts
 *           → Groq: PPD + subject/content (per recipient)
 *           → render PDF (best effort) → create SMTP draft
 *
 * Every step is individually failure-isolated so one bad contact never loses
 * the payload: the lead row is always stored first.
 */
export async function ingestLeadPayload(
  payload: unknown,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const env = getServerEnv();
  const normalized = normalizeLeadPayload(payload);

  const { row: lead, created } = await leadsRepo.upsert(normalized);
  const storedContacts = await leadsRepo.replaceContacts(
    lead.id,
    normalized.contacts,
  );

  const emailContacts = storedContacts.filter((c) => c.is_email);
  const warnings: string[] = [];

  const autoEnrich =
    (options.autoEnrich ?? env.AUTO_ENRICH_LEADS) && !options.dryRun;

  const generation = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: false,
    reason: undefined as string | undefined,
  };

  if (!autoEnrich) {
    generation.skipped = true;
    generation.reason = options.dryRun
      ? "dryRun"
      : "AUTO_ENRICH_LEADS is disabled — generate on demand from the lead page";
    await leadsRepo.setStatus(lead.id, emailContacts.length ? "enriched" : "received");
    return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
  }

  // Recipients: emails from verified_contacts / potential_contacts (a key
  // person's own email outranks a generic mailbox — see emailRecipients).
  const recipients = emailRecipients(normalized.contacts);

  if (recipients.length === 0) {
    generation.skipped = true;
    generation.reason = emailContacts.length
      ? "Emails were found but none sit in verified_contacts/potential_contacts"
      : "No email address in the payload";
    await leadsRepo.setStatus(lead.id, "received");
    return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
  }

  if (!groqConfig().apiKey) {
    generation.skipped = true;
    generation.reason = "GROQ_API_KEY is not set — proposals were not generated";
    warnings.push(generation.reason);
    await leadsRepo.setStatus(lead.id, "enriched");
    return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
  }

  const proposals: ProposalRow[] = [];
  const drafts: EmailDraftRow[] = [];
  const targets = recipients.slice(0, MAX_GENERATIONS_PER_LEAD);

  await leadsRepo.setStatus(lead.id, "enriched");

  for (const recipient of targets) {
    const contactRow = matchContact(storedContacts, recipient.normalizedValue ?? recipient.contactValue);
    if (!contactRow) continue;

    generation.attempted += 1;
    try {
      const { proposal, warnings: modelWarnings } = await generateProposal({
        lead,
        contact: contactRow,
        regenerate: options.regenerate,
      });
      proposals.push(proposal);
      if (modelWarnings.length) warnings.push(...modelWarnings);

      if (proposal.lead_contact_id) {
        const draft = await createDraftForProposal({
          proposalId: proposal.id,
          senderAccountId: options.senderAccountId,
        });
        drafts.push(draft);
      }
      generation.succeeded += 1;
    } catch (error) {
      generation.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${contactRow.contact_value}: ${message}`);
      logger.warn("lead_enrichment_failed", {
        leadId: lead.id,
        contactId: contactRow.id,
        error: message,
      });
    }
  }

  if (drafts.length) await leadsRepo.setStatus(lead.id, "draft_created");
  else if (proposals.length) await leadsRepo.setStatus(lead.id, "proposal_ready");
  else {
    await leadsRepo.setStatus(
      lead.id,
      "failed",
      generation.failed ? `${generation.failed} generation(s) failed` : undefined,
    );
  }

  return buildResult(lead, created, storedContacts, emailContacts, proposals, drafts, warnings, generation);
}

export async function ingestMany(payloads: unknown[], options: IngestOptions) {
  const results: IngestResult[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  for (const [index, payload] of payloads.entries()) {
    try {
      results.push(await ingestLeadPayload(payload, options));
    } catch (error) {
      errors.push({
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { results, errors };
}

function matchContact(
  stored: LeadContactRow[],
  value: string | null,
): LeadContactRow | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return (
    stored.find((c) => (c.normalized_value ?? c.contact_value).toLowerCase() === lower) ??
    stored.find((c) => c.contact_value.toLowerCase() === lower)
  );
}

function buildResult(
  lead: LeadRow,
  created: boolean,
  contacts: LeadContactRow[],
  emailContacts: LeadContactRow[],
  proposals: ProposalRow[],
  drafts: EmailDraftRow[],
  warnings: string[],
  generation: IngestResult["generation"],
): IngestResult {
  return {
    lead,
    created,
    contacts,
    emailContacts,
    proposals,
    drafts,
    warnings,
    generation,
  };
}
