import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { deleteLeadPdfFiles } from "@/server/services/pdf.service";
import { leadsRepo } from "@/server/db/leads.repo";

/**
 * Permanent removal of a lead — the only destructive path in the app, so it is
 * explicit about **what goes and what stays**.
 *
 * Leaves the database (ON DELETE CASCADE / SET NULL, `0001`–`0004`):
 *   leads · lead_contacts · proposals (+ their email copy) · email_drafts
 * Also deletes the rendered PDF objects from the private `proposals` bucket,
 * which a plain row delete would orphan.
 *
 * Deliberately survives:
 *   public.contacts     — a CRM row you promoted is yours, not the lead's
 *   public.email_logs     — the delivery audit trail; its lead/draft/proposal
 *                          columns are set null, so the send record stays provable
 */

export interface LeadRemoval {
  id: string;
  job_title: string | null;
  contacts: number;
  proposals: number;
  drafts: number;
  pdfFiles: number;
}

export interface LeadRemovalReport {
  removed: LeadRemoval[];
  missing: string[];
  failed: Array<{ id: string; error: string }>;
  storageErrors: string[];
  totals: {
    leads: number;
    contacts: number;
    proposals: number;
    drafts: number;
    pdfFiles: number;
  };
}

export async function removeLeads(ids: string[]): Promise<LeadRemovalReport> {
  const supabase = getAdminClient();
  const report: LeadRemovalReport = {
    removed: [],
    missing: [],
    failed: [],
    storageErrors: [],
    totals: { leads: 0, contacts: 0, proposals: 0, drafts: 0, pdfFiles: 0 },
  };

  for (const id of ids) {
    let counts = { contacts: 0, proposals: 0, drafts: 0, jobTitle: null as string | null };
    try {
      // A plain read (not `leadsRepo.byId`, which throws 404) so an id that is
      // already gone is reported as `missing` instead of `failed`.
      const [{ data: lead }, contacts, proposals, drafts] = await Promise.all([
        supabase.from("leads").select("id, job_title").eq("id", id).maybeSingle(),
        leadsRepo.contacts(id),
        leadsRepo.proposals(id),
        leadsRepo.drafts(id),
      ]);
      if (!lead) {
        report.missing.push(id);
        continue;
      }
      counts = {
        contacts: contacts.length,
        proposals: proposals.length,
        drafts: drafts.length,
        jobTitle: lead.job_title ?? null,
      };
    } catch (error) {
      report.failed.push({ id, error: (error as Error).message.slice(0, 200) });
      continue;
    }

    // Storage first: if the row vanished but the object stayed, nothing can find it.
    const storage = await deleteLeadPdfFiles(id);
    report.storageErrors.push(...storage.errors);

    const { count, error } = await supabase.from("leads").delete({ count: "exact" }).eq("id", id);
    if (error) {
      report.failed.push({ id, error: error.message.slice(0, 200) });
      logger.error("lead_remove_failed", { leadId: id, error: error.message });
      continue;
    }
    if (!count) {
      report.missing.push(id);
      continue;
    }

    report.removed.push({
      id,
      job_title: counts.jobTitle,
      contacts: counts.contacts,
      proposals: counts.proposals,
      drafts: counts.drafts,
      pdfFiles: storage.deleted,
    });
    report.totals.leads += 1;
    report.totals.contacts += counts.contacts;
    report.totals.proposals += counts.proposals;
    report.totals.drafts += counts.drafts;
    report.totals.pdfFiles += storage.deleted;

    logger.warn("lead_removed_permanently", {
      leadId: id,
      jobTitle: counts.jobTitle,
      contacts: counts.contacts,
      proposals: counts.proposals,
      drafts: counts.drafts,
      pdfFiles: storage.deleted,
    });
  }

  return report;
}
