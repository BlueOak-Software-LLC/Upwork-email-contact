import { getAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";
import type { NormalizedLead } from "@/types/lead";
import type {
  EmailDraftRow,
  LeadConfidence,
  LeadContactRow,
  LeadRow,
  LeadStatus,
  ProposalRow,
} from "@/types/lead";
import { ApiError } from "@/server/http/errors";
import { logger } from "@/lib/logger";

export const LEAD_COLUMNS =
  "id,dedupe_key,job_id,job_title,job_url,job_location,industry,company_mentioned,client_name,client_location,job_description,overall_confidence,status,error,received_at,created_at,updated_at";

export const LEAD_CONTACT_COLUMNS =
  "id,lead_id,list_type,name,role,company,contact_type,channel,contact_value,normalized_value,confidence,rationale,source_url,is_email,is_primary,created_at";

/**
 * Detail view additionally pulls the JSONB blobs (heavy, so the list query
 * never selects them).
 */
export const LEAD_DETAIL_COLUMNS =
  `${LEAD_COLUMNS},key_people,contact_information,raw_payload`;

export interface LeadDetail {
  lead: LeadRow;
  contacts: LeadContactRow[];
  proposals: ProposalRow[];
  drafts: EmailDraftRow[];
  keyPeople: unknown[];
  contactInformation: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}

export interface ListLeadsQuery {
  q?: string;
  status?: LeadStatus;
  confidence?: LeadConfidence;
  hasEmail?: boolean;
  page: number;
  pageSize: number;
  sort: "received_at" | "updated_at" | "job_title" | "status" | "overall_confidence";
  order: "asc" | "desc";
}

export const leadsRepo = {
  /**
   * Insert-or-update by `dedupe_key` (job_id when present, else a hash of the
   * job URL/title). Existing contacts are left alone unless `replaceContacts`.
   */
  async upsert(lead: NormalizedLead): Promise<{ row: LeadRow; created: boolean }> {
    const supabase = getAdminClient();

    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("dedupe_key", lead.dedupeKey)
      .maybeSingle();

    const payload = {
      dedupe_key: lead.dedupeKey,
      job_id: lead.jobId,
      job_title: lead.jobTitle,
      job_url: lead.jobUrl,
      job_location: lead.jobLocation,
      industry: lead.industry,
      company_mentioned: lead.companyMentioned,
      client_name: lead.clientName,
      client_location: lead.clientLocation,
      job_description: lead.jobDescription,
      overall_confidence: lead.overallConfidence,
      key_people: lead.keyPeople as unknown as never,
      contact_information: lead.contactInformation as unknown as never,
      raw_payload: lead.rawPayload as unknown as never,
    };

    if (existing) {
      const { data, error } = await supabase
        .from("leads")
        .update({ ...payload, status: "received" as LeadStatus })
        .eq("id", existing.id)
        .select(LEAD_COLUMNS)
        .single();

      if (error) throw ApiError.upstream(`Failed to update lead: ${error.message}`);
      return { row: data as LeadRow, created: false };
    }

    const { data, error } = await supabase
      .from("leads")
      .insert(payload as never)
      .select(LEAD_COLUMNS)
      .single();

    if (error) throw ApiError.upstream(`Failed to insert lead: ${error.message}`);
    return { row: data as LeadRow, created: true };
  },

  async replaceContacts(leadId: string, contacts: NormalizedLead["contacts"]) {
    const supabase = getAdminClient();
    const rows = contacts.map((c) => ({
      lead_id: leadId,
      list_type: c.listType,
      name: c.name,
      role: c.role,
      company: c.company,
      contact_type: c.contactType,
      channel: c.channel,
      contact_value: c.contactValue,
      normalized_value: c.normalizedValue,
      confidence: c.confidence,
      rationale: c.rationale,
      source_url: c.sourceUrl,
      is_email: c.isEmail,
      is_primary: c.isPrimary,
    }));

    const { error: delError } = await supabase
      .from("lead_contacts")
      .delete()
      // Manual rows (typed in the dashboard) survive a re-ingest of the same job.
      .eq("lead_id", leadId)
      .or("contact_type.is.null,contact_type.neq.manual");
    if (delError) logger.warn("contacts_delete_failed", { leadId, error: delError.message });

    const { data: manualRows } = await supabase
      .from("lead_contacts")
      .select(LEAD_CONTACT_COLUMNS)
      .eq("lead_id", leadId)
      .eq("contact_type", "manual");
    const keep = new Set(
      (manualRows ?? []).map((r) =>
        String(r.normalized_value ?? r.contact_value ?? "").toLowerCase(),
      ),
    );
    const fresh = rows.filter(
      (r) => !keep.has(String(r.normalized_value ?? r.contact_value ?? "").toLowerCase()),
    );

    if (fresh.length === 0) return (manualRows ?? []) as LeadContactRow[];

    const { data, error } = await supabase
      .from("lead_contacts")
      .insert(fresh as never)
      .select(LEAD_CONTACT_COLUMNS);

    if (error) throw ApiError.upstream(`Failed to store contacts: ${error.message}`);
    return [...(manualRows ?? []), ...(data ?? [])] as LeadContactRow[];
  },

  /**
   * A recipient a human typed in (the "custom email" path). Reused if the same
   * address is already on the lead, so repeated sends don't pile up rows.
   */
  async upsertManualContact(leadId: string, email: string, name?: string | null) {
    const supabase = getAdminClient();
    const value = email.trim().toLowerCase();

    const { data: existing } = await supabase
      .from("lead_contacts")
      .select(LEAD_CONTACT_COLUMNS)
      .eq("lead_id", leadId)
      .ilike("contact_value", value)
      .maybeSingle();
    if (existing) return { row: existing as LeadContactRow, created: false };

    const { data, error } = await supabase
      .from("lead_contacts")
      .insert({
        lead_id: leadId,
        list_type: "potential",
        name: name ?? null,
        contact_type: "manual",
        channel: "email",
        contact_value: value,
        normalized_value: value,
        rationale: "Added manually in the dashboard",
        is_email: true,
        is_primary: false,
      } as never)
      .select(LEAD_CONTACT_COLUMNS)
      .single();

    if (error) throw ApiError.upstream(`Failed to add recipient: ${error.message}`);
    logger.info("manual_recipient_added", { leadId, email: value });
    return { row: data as LeadContactRow, created: true };
  },

  async list(query: ListLeadsQuery) {
    const supabase = getAdminClient();
    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;

    // The embedded counts are what the list shows as pipeline dots and what the
    // delete dialog prints before an irreversible call ("2 documents, 1 draft,
    // 3 stored PDFs"), so they ride along instead of a second round-trip.
    const richSelect = `${LEAD_COLUMNS}, lead_contacts(count), proposals(count), email_drafts(count)`;
    const plainSelect = `${LEAD_COLUMNS}, lead_contacts(count)`;

    const build = (selection: string) => {
      let builder = supabase
        .from("leads")
        .select(selection, { count: "exact" })
        .order(query.sort, { ascending: query.order === "asc" })
        .range(from, to);

      if (query.status) builder = builder.eq("status", query.status);
      if (query.confidence) builder = builder.eq("overall_confidence", query.confidence);
      if (query.q) {
        const term = query.q.trim();
        if (term) {
          builder = builder.or(
            `job_title.ilike.%${term}%,company_mentioned.ilike.%${term}%,client_name.ilike.%${term}%,industry.ilike.%${term}%,job_description.ilike.%${term}%`,
          );
        }
      }
      return builder;
    };

    let result = await build(richSelect);
    if (result.error) {
      // A database older than 0002 has no proposals/email_drafts to embed: keep
      // the list alive without those counts rather than failing the page.
      logger.warn("lead_list_counts_embed_failed", {
        error: result.error.message,
        note: "falling back to contact counts only",
      });
      result = await build(plainSelect);
    }
    const { data, error, count } = result;
    if (error) throw ApiError.upstream(`Failed to list leads: ${error.message}`);

    const embeddedCount = (value: unknown): number => {
      const first = Array.isArray(value)
        ? (value[0] as { count?: number } | undefined)
        : (value as { count?: number } | undefined);
      return first?.count ?? 0;
    };
    const items = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(
      ({ lead_contacts, proposals, email_drafts, ...rest }) => ({
        ...rest,
        contact_count: embeddedCount(lead_contacts),
        proposal_count: embeddedCount(proposals),
        draft_count: embeddedCount(email_drafts),
      }),
    );

    const total = count ?? items.length;
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  },

  async detail(id: string): Promise<LeadDetail> {
    const supabase = getAdminClient();
    const { data: lead, error } = await supabase
      .from("leads")
      .select(LEAD_DETAIL_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to load lead: ${error.message}`);
    if (!lead) throw ApiError.notFound(`Lead ${id} not found`);

    const [contacts, proposals, drafts] = await Promise.all([
      leadsRepo.contacts(id),
      leadsRepo.proposals(id),
      leadsRepo.drafts(id),
    ]);

    return {
      lead: lead as LeadRow,
      contacts,
      proposals,
      drafts,
      keyPeople: Array.isArray(lead.key_people) ? lead.key_people : [],
      contactInformation:
        lead.contact_information && typeof lead.contact_information === "object"
          ? (lead.contact_information as Record<string, unknown>)
          : {},
      rawPayload:
        lead.raw_payload && typeof lead.raw_payload === "object"
          ? (lead.raw_payload as Record<string, unknown>)
          : {},
    };
  },

  /** Light single-lead read (no JSONB blobs). */
  async byId(id: string): Promise<LeadRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to load lead: ${error.message}`);
    if (!data) throw ApiError.notFound(`Lead ${id} not found`);
    return data as LeadRow;
  },

  async contacts(leadId: string): Promise<LeadContactRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("lead_contacts")
      .select(LEAD_CONTACT_COLUMNS)
      .eq("lead_id", leadId)
      .order("is_email", { ascending: false })
      .order("list_type");
    if (error) throw ApiError.upstream(`Failed to load contacts: ${error.message}`);
    return (data ?? []) as LeadContactRow[];
  },

  async contactById(id: string): Promise<LeadContactRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("lead_contacts")
      .select(LEAD_CONTACT_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to load contact: ${error.message}`);
    if (!data) throw ApiError.notFound(`Contact ${id} not found`);
    return data as LeadContactRow;
  },

  async proposals(leadId: string): Promise<ProposalRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("proposals")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });
    if (error) throw ApiError.upstream(`Failed to load proposals: ${error.message}`);
    return (data ?? []) as ProposalRow[];
  },

  async drafts(leadId: string): Promise<EmailDraftRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });
    if (error) throw ApiError.upstream(`Failed to load drafts: ${error.message}`);
    return (data ?? []) as EmailDraftRow[];
  },

  async setStatus(id: string, status: LeadStatus, error?: string) {
    const supabase = getAdminClient();
    // A long Groq call can outlive the keep-alive connection PostgREST handed us,
    // so the first PATCH sometimes surfaces as "fetch failed". One retry keeps
    // the lead from looking stuck on `received` after a successful generation.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { error: updateError } = await supabase
        .from("leads")
        .update({ status, error: error ?? null })
        .eq("id", id);
      if (!updateError) return;
      if (attempt === 1) {
        logger.warn("lead_status_update_failed", { id, status, error: updateError.message });
        return;
      }
      logger.warn("lead_status_update_retry", { id, status, error: updateError.message });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  },

  /** Human-initiated edits only — never touches the stored payload/contacts. */
  async updateManual(
    id: string,
    patch: { status?: LeadStatus; job_description?: string | null; error?: string | null },
  ): Promise<LeadRow> {
    const supabase = getAdminClient();
    const clean: Database["public"]["Tables"]["leads"]["Update"] = {};
    if (patch.status !== undefined) clean.status = patch.status;
    if (patch.job_description !== undefined) clean.job_description = patch.job_description;
    if (patch.error !== undefined) clean.error = patch.error;
    if (!Object.keys(clean).length) throw ApiError.badRequest("Nothing to update");

    const { data, error } = await supabase
      .from("leads")
      .update(clean)
      .eq("id", id)
      .select(LEAD_COLUMNS)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to update lead: ${error.message}`);
    if (!data) throw ApiError.notFound(`Lead ${id} not found`);
    return data as LeadRow;
  },

  /**
   * Next proposal version for a recipient. `null` means the recipient-less
   * branch: a document written from the post before any address is known.
   */
  async nextVersion(leadContactId: string | null, leadId?: string): Promise<number> {
    const supabase = getAdminClient();
    let query = supabase.from("proposals").select("version").order("version", { ascending: false }).limit(1);
    query =
      leadContactId === null
        ? query.is("lead_contact_id", null)
        : query.eq("lead_contact_id", leadContactId);
    // Versions are per lane *and* per lead: without this the recipient-less lane
    // would read every lead's null-contact rows and start a fresh lead at v3.
    if (leadId) query = query.eq("lead_id", leadId);
    const { data } = await query;
    const latest = data?.[0]?.version;
    return typeof latest === "number" ? latest + 1 : 1;
  },

  async metrics() {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("leads")
      .select("id,status,overall_confidence,received_at");
    if (error) throw ApiError.upstream(`Failed to compute lead metrics: ${error.message}`);

    const rows = (data ?? []) as Array<{
      id: string;
      status: LeadStatus;
      overall_confidence: string;
      received_at: string;
    }>;

    const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1;
      return acc;
    }, {});
    const byConfidence = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.overall_confidence] = (acc[row.overall_confidence] ?? 0) + 1;
      return acc;
    }, {});

    const perDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
      perDay.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10), 0);
    }
    for (const row of rows) {
      const key = String(row.received_at).slice(0, 10);
      if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }

    return {
      total: rows.length,
      byStatus,
      byConfidence,
      last7Days: [...perDay.entries()].map(([day, count]) => ({ day, count })),
    };
  },

  /**
   * What a human should do next, newest first. The overview shows this instead
   * of a wall of counts, because the pipeline only moves when somebody reviews
   * a document or approves a draft.
   *
   * Each block degrades to an empty list: a missing table or column must never
   * take the dashboard down.
   */
  async queue(limit = 12) {
    const supabase = getAdminClient();

    /**
     * The PostgREST builder is thenable but has no `.catch`, and a missing
     * table or column must never take the dashboard down — so every block is
     * awaited through this and degrades to an empty list.
     */
    const safe = async <T,>(
      run: () => PromiseLike<{ data: T[] | null; error?: { message: string } | null }>,
    ): Promise<T[]> => {
      try {
        const result = await run();
        if (result.error) return [];
        return result.data ?? [];
      } catch {
        return [];
      }
    };

    const [unreviewed, reviewedNoEmail, drafts, pdfsPending] = await Promise.all([
      safe<ProposalQueueRow>(() =>
        supabase
          .from("proposals")
          .select("id,lead_id,version,created_at,ppd_reviewed_at")
          .is("ppd_reviewed_at", null)
          .order("created_at", { ascending: false })
          .limit(limit),
      ),
      safe<ReviewedEmailRow>(() =>
        supabase
          .from("proposals")
          .select("id,lead_id,version,ppd_reviewed_at,email_subject")
          .not("ppd_reviewed_at", "is", null)
          .eq("email_subject", "")
          .order("ppd_reviewed_at", { ascending: false })
          .limit(limit),
      ),
      safe<DraftQueueRow>(() =>
        supabase
          .from("email_drafts")
          .select("id,lead_id,proposal_id,subject,to_email,status,updated_at")
          .eq("status", "draft")
          .order("updated_at", { ascending: false })
          .limit(limit),
      ),
      safe<PdfQueueRow>(() =>
        supabase
          .from("proposals")
          .select("id,lead_id,version,pdf_status")
          .eq("pdf_status", "pending")
          .not("ppd_reviewed_at", "is", null)
          .limit(limit),
      ),
    ]);

    const leadIds = [
      ...new Set(
        [...unreviewed, ...reviewedNoEmail, ...drafts, ...pdfsPending]
          .map((row) => row.lead_id)
          .filter((value): value is string => typeof value === "string"),
      ),
    ];

    const titles = new Map<string, string>();
    if (leadIds.length) {
      const rows = await safe<{ id: string; job_title: string | null; dedupe_key: string }>(() =>
        supabase.from("leads").select("id,job_title,dedupe_key").in("id", leadIds),
      );
      for (const lead of rows) {
        titles.set(lead.id, lead.job_title ?? `[untitled] ${lead.dedupe_key.slice(0, 8)}`);
      }
    }

    const title = (leadId: string) => titles.get(leadId) ?? leadId.slice(0, 8);

    return {
      awaitingReview: unreviewed.map((row) => ({
        leadId: row.lead_id,
        proposalId: row.id,
        version: row.version,
        title: title(row.lead_id),
        createdAt: row.created_at,
      })),
      reviewedAwaitingEmail: reviewedNoEmail.map((row) => ({
        leadId: row.lead_id,
        proposalId: row.id,
        version: row.version,
        title: title(row.lead_id),
      })),
      draftsToSend: drafts.map((row) => ({
        leadId: row.lead_id,
        draftId: row.id,
        to: row.to_email,
        subject: row.subject || "(no subject)",
        title: title(row.lead_id),
      })),
      pdfsAwaitingRender: pdfsPending.map((row) => ({
        leadId: row.lead_id,
        proposalId: row.id,
        version: row.version,
        title: title(row.lead_id),
      })),
    };
  },
};

interface ProposalQueueRow {
  id: string;
  lead_id: string;
  version: number;
  created_at: string;
  ppd_reviewed_at: string | null;
}

interface ReviewedEmailRow {
  id: string;
  lead_id: string;
  version: number;
  ppd_reviewed_at: string;
  email_subject: string;
}

interface DraftQueueRow {
  id: string;
  lead_id: string;
  proposal_id: string | null;
  subject: string;
  to_email: string;
  status: string;
  updated_at: string;
}

interface PdfQueueRow {
  id: string;
  lead_id: string;
  version: number;
  pdf_status: string;
}
