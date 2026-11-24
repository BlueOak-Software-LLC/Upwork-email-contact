import { getServerEnv } from "@/lib/env";
import { aiConfigured } from "@/lib/env";
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
  /** Write the PPD automatically (off by default — see `AUTO_ENRICH_LEADS`). */
  autoEnrich?: boolean;
  /** Force a new proposal version even if one exists. */
  regenerate?: boolean;
  /** Persist the lead and contacts only — no model calls. */
  dryRun?: boolean;
  /**
   * Overwrite an existing lead when its `job_id`/link matches, instead of
   * reporting the duplicate and leaving the row alone. Off by default: a
   * re-scrape must not roll a reviewed proposal back to `received`.
   */
  refresh?: boolean;
  /** Kept for API compatibility; the draft stores it once you generate the email. */
  senderAccountId?: string | null;
}

/**
 * The ingest pipeline behind `POST /api/leads`:
 *
 *   payload → normalise → match by job_id / job link → store lead + contacts
 *           → stop. The document is written when a person asks for it.
 *
 * Two deliberate stops. A payload whose `job_id` **or** job link already exists
 * is reported as a duplicate rather than added or overwritten, because the
 * scraper re-posts the same job with different tracking parameters. And nothing
 * is generated on arrival: the email draft, the PDF and the send are human
 * decisions made on the lead page, and so is writing the first draft of the
 * document. `?auto=true` (or `AUTO_ENRICH_LEADS=true`) restores the old
 * ingest-writes-documents behaviour for a caller that wants it.
 * Every step is individually failure-isolated: the lead row is always stored.
 */
export async function ingestLeadPayload(
  payload: unknown,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const env = getServerEnv();
  const normalized = normalizeLeadPayload(payload);

  const { row: lead, created, matchedBy } = await leadsRepo.upsert(normalized, {
    refresh: options.refresh,
  });

  // A duplicate is not re-written, contacts included: replacing them would
  // discard whatever the reviewer corrected on the row we already had.
  if (matchedBy && !created && !options.refresh) {
    const stored = await leadsRepo.contacts(lead.id);
    const emailContacts = stored.filter((c) => c.is_email);
    const reason =
      matchedBy === "job_id"
        ? `job_id ${lead.job_id ?? "(stored)"}`
        : matchedBy === "job_url"
          ? `job link ${lead.job_url ?? "(stored)"}`
          : "the same normalised job";
    return {
      lead,
      created: false,
      duplicate: { leadId: lead.id, matchedBy },
      contacts: stored,
      emailContacts,
      proposals: [],
      drafts: [],
      warnings: [
        `Duplicate of lead ${lead.id} (${reason}) — nothing was added. Post again with "refresh": true to overwrite it, or generate from the existing lead.`,
      ],
      generation: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: true,
        reason: "duplicate",
      },
    };
  }

  const storedContacts = await leadsRepo.replaceContacts(lead.id, normalized.contacts);

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
      : "manual — the lead is stored; click \"Generate PPD\" on the lead page (or POST /api/leads/:id/generate) to write the document";
    await stamp(lead, emailContacts.length ? "enriched" : "received");
    return buildResult(lead, created, storedContacts, emailContacts, [], [], warnings, generation, matchedBy);
  }

  // Recipients: emails from verified_contacts / potential_contacts (a key
  // person's own email outranks a generic mailbox — see emailRecipients).
  const recipients = emailRecipients(normalized.contacts);

  if (recipients.length === 0) {
    if (!aiConfigured()) {
      generation.skipped = true;
      generation.reason = "No recipient email in the payload and no AI provider configured";
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

  if (!aiConfigured()) {
    generation.skipped = true;
    generation.reason = "No AI provider configured (PUTER_AUTH_TOKEN / GROQ_API_KEY) — proposals were not generated";
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
  matchedBy?: "job_id" | "job_url" | "dedupe_key" | null,
): IngestResult {
  return {
    lead,
    created,
    ...(matchedBy && !created ? { duplicate: { leadId: lead.id, matchedBy } } : {}),
    contacts,
    emailContacts,
    proposals,
    drafts,
    warnings,
    generation,
  };
}
