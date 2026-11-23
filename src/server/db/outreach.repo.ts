import { getAdminClient } from "@/lib/supabase/admin";
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
    leadContactId: string;
    version: number;
    output: ProposalOutput;
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
        email_subject: output.email.subject,
        email_content: output.email.content,
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
    const { data, error } = await supabase
      .from("proposals")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to update proposal: ${error.message}`);
    if (!data) throw ApiError.notFound(`Proposal ${id} not found`);
    return data as ProposalRow;
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
    subject: string;
    bodyText: string;
    bodyHtml?: string | null;
    attachments?: Array<{ path: string; filename: string; contentType: string }>;
    status?: DraftStatus;
  }): Promise<EmailDraftRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_drafts")
      .insert({
        lead_id: input.leadId,
        lead_contact_id: input.leadContactId ?? null,
        proposal_id: input.proposalId ?? null,
        sender_account_id: input.senderAccountId ?? null,
        to_email: input.toEmail.toLowerCase(),
        subject: input.subject,
        body_text: input.bodyText,
        body_html: input.bodyHtml ?? null,
        attachments: (input.attachments ?? []) as never,
        status: input.status ?? "draft",
      })
      .select("*")
      .single();

    if (error) throw ApiError.upstream(`Failed to create draft: ${error.message}`);
    return data as EmailDraftRow;
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
    const { data, error } = await supabase
      .from("email_drafts")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to update draft: ${error.message}`);
    if (!data) throw ApiError.notFound(`Draft ${id} not found`);
    return data as EmailDraftRow;
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
