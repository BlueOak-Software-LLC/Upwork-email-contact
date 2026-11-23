import { getServerEnv } from "@/lib/env";
import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import { emailRecipients, normalizeLeadPayload } from "@/lib/validation/lead";
import { leadsRepo } from "@/server/db/leads.repo";
import { generatePpdDocument } from "@/server/services/proposal.service";
import type {
  EmailDraftRow,
  IngestResult,
  LeadContactRow,
  LeadRow,
  LeadStatus,
  ProposalRow,
} from "@/types/lead";

const MAX_GENERATIONS_PER_LEAD = 3;

export interface IngestOptions {
  /** Write the PPD automatically (env AUTO_ENRICH_LEADS by default). */
  autoEnrich?: boolean;
  /** Force a new proposal version even if one exists. */
  regenerate?: boolean;
  /** Persist the lead and contacts only — no Groq calls. */
  dryRun?: boolean;
  /** Kept for API compatibility; the draft stores it once you generate the email. */
  senderAccountId?: string | null;
}

/**
 * The ingest pipeline behind `POST /api/leads`:
 *
 *   payload → normalise → upsert lead → replace lead_contacts
 *           → pick email recipients from verified_contacts + potential_contacts
 *           → Groq: the PPD document only
 *
 * Deliberately stops there. The email draft, the PDF and the send are human
 * decisions made on the lead page (see `generateEmailDraft` / `ensureDraftPdf`),
 * so nothing is rendered or attached before the PPD has been reviewed.
 * Every step is individually failure-isolated: the lead row is always stored.
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
  const proposalsFromRun: ProposalRow[] = [];

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
      : "AUTO_ENRICH_LEADS is disabled — generate the proposal on demand from the lead page";
    await stamp(lead, emailContacts.length ? "enriched" : "received");
    return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
  }

  // Recipients: emails from verified_contacts / potential_contacts (a key
  // person's own email outranks a generic mailbox — see emailRecipients).
  const recipients = emailRecipients(normalized.contacts);

  if (recipients.length === 0) {
    if (!groqConfig().apiKey) {
      generation.skipped = true;
      generation.reason = "No recipient email in the payload and generation is not configured";
      await stamp(lead, "received");
      return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
    }

    // Payloads sometimes carry the post but no address at all. The description
    // is enough to write the document, so do it now and let the reviewer attach
    // any recipient later (`toEmail` on the email step).
    if (!(normalized.jobDescription ?? normalized.jobTitle ?? "").trim()) {
      generation.skipped = true;
      generation.reason = emailContacts.length
        ? "Emails were found but none sit in verified_contacts/potential_contacts, and the post carries no text to write from"
        : "No email address and no job_description/job_title to write from";
      await stamp(lead, "received");
      return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
    }

    warnings.push(
      "No recipient email in the payload — the PPD was written from the post itself; give the email step a `toEmail`",
    );
    generation.attempted = 1;
    const outcome = await writeRecipientlessPpd(lead, options);
    if (outcome.ok) {
      proposalsFromRun.push(outcome.proposal);
      warnings.push(...outcome.warnings);
      generation.succeeded = 1;
      await stamp(lead, "proposal_ready");
    } else {
      generation.failed = 1;
      warnings.push(outcome.error);
      await stamp(lead, "failed", "recipient-less PPD generation failed");
    }
    return buildResult(lead, created, storedContacts, emailContacts, proposalsFromRun, [], warnings, generation);
  }

  if (!groqConfig().apiKey) {
    generation.skipped = true;
    generation.reason = "GROQ_API_KEY is not set — proposals were not generated";
    warnings.push(generation.reason);
    await stamp(lead, "enriched");
    return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation);
  }

  const proposals: ProposalRow[] = [];
  const drafts: EmailDraftRow[] = [];
  const targets = recipients.slice(0, MAX_GENERATIONS_PER_LEAD);

  await stamp(lead, "enriched");

  for (const recipient of targets) {
    const contactRow = matchContact(storedContacts, recipient.normalizedValue ?? recipient.contactValue);
    if (!contactRow) continue;

    generation.attempted += 1;
    try {
      const { proposal, warnings: modelWarnings } = await generatePpdDocument({
        lead,
        contact: contactRow,
        regenerate: options.regenerate,
      });
      proposals.push(proposal);
      if (modelWarnings.length) warnings.push(...modelWarnings);
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

  if (proposals.length) await stamp(lead, "proposal_ready");
  else {
    await stamp(
      lead,
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

/**
 * Persist a pipeline status *and* keep the in-memory row in step with it, so the
 * ingest response never reports the pre-generation status while the dashboard
 * already shows `proposal_ready`.
 */
/**
 * A payload with the post text but no address still deserves a document: write
 * it recipient-less (proposals.lead_contact_id stays null) so the reviewer can
 * read and edit it now and pick the address at the email step.
 */
async function writeRecipientlessPpd(
  lead: LeadRow,
  options: IngestOptions,
): Promise<
  | { ok: true; proposal: ProposalRow; warnings: string[] }
  | { ok: false; error: string }
> {
  try {
    const result = await generatePpdDocument({
      lead,
      contact: null,
      regenerate: options.regenerate,
    });
    return { ok: true, proposal: result.proposal, warnings: result.warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("lead_enrichment_failed", { leadId: lead.id, mode: "recipient-less", error: message });
    return { ok: false, error: message };
  }
}

async function stamp(lead: LeadRow, status: LeadStatus, error?: string) {
  lead.status = status;
  if (error !== undefined) lead.error = error;
  await leadsRepo.setStatus(lead.id, status, error);
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
