import { getAdminClient } from "@/lib/supabase/admin";
import { isMissingSchema, withoutMissingColumns, REVIEW_FLOW_MIGRATION } from "@/server/db/schema-guard";
import type { Database } from "@/types/database";
import type {
  DraftStatus,
  EmailDraftRow,
  LeadRow,
  ProposalRow,
  ProposalOutput,
} from "@/types/lead";
import { ApiError } from "@/server/http/errors";

export const proposalsRepo = {
  /**
   * Persists one proposal version. The email half is optional because the PPD is
   * written first and only drafted after a human reviews it.
   */
  async create({
    leadId,
    leadContactId,
    version,
    output,
    model,
    provider,
    usage,
    pdfPath,
    pdfStatus,
    emailHtml,
    error,
  }: {
    leadId: string;
    /** null ⇒ a recipient-less document (written from the post, no address yet). */
    leadContactId: string | null;
    version: number;
    output: { ppd: ProposalOutput["ppd"]; email?: ProposalOutput["email"] | null };
    model: string | null;
    provider: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    pdfPath?: string | null;
    pdfStatus?: string;
    emailHtml?: string | null;
    error?: string | null;
  }): Promise<ProposalRow> {
    const supabase = getAdminClient();
    const { data, error: insertError } = await supabase
      .from("proposals")
      .insert({
        lead_id: leadId,
        lead_contact_id: leadContactId,
        version,
        provider,
        model,
        ppd: output.ppd as never,
        email_subject: output.email?.subject ?? "",
        email_content: output.email?.content ?? "",
        email_html: emailHtml ?? null,
        pdf_path: pdfPath ?? null,
        pdf_status: pdfStatus ?? "pending",
        prompt_tokens: usage?.prompt_tokens ?? null,
        completion_tokens: usage?.completion_tokens ?? null,
        error: error ?? null,
      })
      .select("*")
      .single();

    if (insertError) {
      throw ApiError.upstream(`Failed to store proposal: ${insertError.message}`);
    }
    return data as ProposalRow;
  },

  async byId(id: string): Promise<ProposalRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("proposals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to load proposal: ${error.message}`);
    if (!data) throw ApiError.notFound(`Proposal ${id} not found`);
    return data as ProposalRow;
  },

  async update(
    id: string,
    patch: Database["public"]["Tables"]["proposals"]["Update"],
  ): Promise<ProposalRow> {
    const supabase = getAdminClient();
    let payload = patch as Record<string, unknown>;
    // Migration 0003 adds ppd_reviewed_at / pdf_generated_at. Until it is
    // applied, drop those keys rather than failing the review or the PDF stamp.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("proposals")
        .update(payload as never)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (!error) {
        if (!data) throw ApiError.notFound(`Proposal ${id} not found`);
        return data as ProposalRow;
      }
      if (!isMissingSchema(error)) {
        throw ApiError.upstream(`Failed to update proposal: ${error.message}`);
      }
      const trimmed = withoutMissingColumns(payload, error);
      if (!trimmed.dropped.length) {
        throw ApiError.upstream(
          `Failed to update proposal: ${error.message} — apply ${REVIEW_FLOW_MIGRATION}`,
        );
      }
      payload = trimmed.payload;
    }
    throw ApiError.upstream(
      `Failed to update proposal after dropping unknown columns — apply ${REVIEW_FLOW_MIGRATION}`,
    );
  },

  async latestForLead(leadId: string): Promise<ProposalRow[]> {
    const rows = await proposalsRepo.listByLead(leadId);
    const byContact = new Map<string, ProposalRow>();
    for (const row of rows) {
      const key = row.lead_contact_id ?? "none";
      const existing = byContact.get(key);
      if (!existing || row.version > existing.version) byContact.set(key, row);
    }
    return [...byContact.values()];
  },

  async listByLead(leadId: string): Promise<ProposalRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("proposals")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });
    if (error) throw ApiError.upstream(`Failed to load proposals: ${error.message}`);
    return (data ?? []) as ProposalRow[];
  },
};

export const draftsRepo = {
  async create(input: {
    leadId: string;
    leadContactId?: string | null;
    proposalId?: string | null;
    senderAccountId?: string | null;
    toEmail: string;
    cc?: string[] | null;
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    attachments?: Array<{ path: string; filename: string; contentType: string }>;
    status?: DraftStatus;
    recipientSource?: "lead_contact" | "custom";
  }): Promise<EmailDraftRow> {
    const supabase = getAdminClient();
    let payload: Record<string, unknown> = {
      lead_id: input.leadId,
      lead_contact_id: input.leadContactId ?? null,
      proposal_id: input.proposalId ?? null,
      sender_account_id: input.senderAccountId ?? null,
      to_email: input.toEmail.toLowerCase(),
      cc: (input.cc ?? []) as never,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: input.bodyHtml ?? null,
      attachments: (input.attachments ?? []) as never,
      status: input.status ?? "draft",
      recipient_source: input.recipientSource ?? "lead_contact",
    };

    // `cc` and `recipient_source` arrive with migration 0003; a custom
    // recipient still gets a draft on an un-migrated database, just without the
    // provenance flag, and the log says which file to run.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("email_drafts")
        .insert(payload as never)
        .select("*")
        .single();

      if (!error) return data as EmailDraftRow;
      if (!isMissingSchema(error)) {
        throw ApiError.upstream(`Failed to create draft: ${error.message}`);
      }
      const trimmed = withoutMissingColumns(payload, error);
      if (!trimmed.dropped.length) {
        throw ApiError.upstream(
          `Failed to create draft: ${error.message} — apply ${REVIEW_FLOW_MIGRATION}`,
        );
      }
      payload = trimmed.payload;
    }
    throw ApiError.upstream(
      `Failed to create draft after dropping unknown columns — apply ${REVIEW_FLOW_MIGRATION}`,
    );
  },

  async byId(id: string): Promise<EmailDraftRow & { lead?: LeadRow }> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_drafts")
      .select("*, lead:leads(*)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to load draft: ${error.message}`);
    if (!data) throw ApiError.notFound(`Draft ${id} not found`);
    return data as unknown as EmailDraftRow & { lead?: LeadRow };
  },

  async update(
    id: string,
    patch: Database["public"]["Tables"]["email_drafts"]["Update"],
  ): Promise<EmailDraftRow> {
    const supabase = getAdminClient();
    let payload = patch as Record<string, unknown>;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("email_drafts")
        .update(payload as never)
        .eq("id", id)
        .select("*")
        .maybeSingle();

      if (!error) {
        if (!data) throw ApiError.notFound(`Draft ${id} not found`);
        return data as EmailDraftRow;
      }
      if (!isMissingSchema(error)) {
        throw ApiError.upstream(`Failed to update draft: ${error.message}`);
      }
      const trimmed = withoutMissingColumns(payload, error);
      if (!trimmed.dropped.length) {
        throw ApiError.upstream(
          `Failed to update draft: ${error.message} — apply ${REVIEW_FLOW_MIGRATION}`,
        );
      }
      payload = trimmed.payload;
    }
    throw ApiError.upstream(
      `Failed to update draft after dropping unknown columns — apply ${REVIEW_FLOW_MIGRATION}`,
    );
  },

  async listByLead(leadId: string): Promise<EmailDraftRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_drafts")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false });
    if (error) throw ApiError.upstream(`Failed to load drafts: ${error.message}`);
    return (data ?? []) as EmailDraftRow[];
  },

  async pendingForSenderToday(senderAccountId: string): Promise<number> {
    const supabase = getAdminClient();
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const { count } = await supabase
      .from("email_drafts")
      .select("id", { count: "exact", head: true })
      .eq("sender_account_id", senderAccountId)
      .eq("status", "sent")
      .gte("sent_at", start.toISOString());
    return count ?? 0;
  },
};
