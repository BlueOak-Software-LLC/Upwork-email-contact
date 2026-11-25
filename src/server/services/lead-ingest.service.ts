import { normalizeLeadPayload } from "@/lib/validation/lead";
import { leadsRepo } from "@/server/db/leads.repo";
import type {
  EmailDraftRow,
  IngestResult,
  LeadContactRow,
  LeadRow,
  LeadStatus,
  ProposalRow,
} from "@/types/lead";

export interface IngestOptions {
  /** Accepted for API compatibility; generation is always manual now. */
  autoEnrich?: boolean;
  /** Accepted for API compatibility; the job carries the version. */
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
 * document. The old `?auto=true` flag and AUTO_ENRICH_LEADS env are ignored:
 * prompts only run in the signed-in ChatGPT tab when a person asks for one.
 * Every step is individually failure-isolated: the lead row is always stored.
 */
export async function ingestLeadPayload(
  payload: unknown,
  options: IngestOptions = {},
): Promise<IngestResult> {
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

  // Manual by default, always. The lead is stored and the dashboard shows it;
  // generation starts only when a person clicks Generate PPD/email, because it
  // now runs in their own signed-in ChatGPT tab rather than on the server.
  const generation = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: true,
    reason: options.dryRun
      ? "dryRun"
      : "manual — the lead is stored; click \"Generate PPD\" on the lead page to run the prompt in your ChatGPT session",
  };

  await stamp(lead, emailContacts.length ? "enriched" : "received");
  return buildResult(
    lead,
    created,
    storedContacts,
    emailContacts,
    proposalsFromRun,
    [],
    warnings,
    generation,
    matchedBy,
  );
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

/** Persist a pipeline status and keep the in-memory row in step with it. */
async function stamp(lead: LeadRow, status: LeadStatus, error?: string) {
  lead.status = status;
  if (error !== undefined) lead.error = error;
  await leadsRepo.setStatus(lead.id, status, error);
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
