import { getAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";
import { ApiError } from "@/server/http/errors";
import { isMissingSchema } from "@/server/db/schema-guard";

export const CHATGPT_JOBS_MIGRATION =
  "supabase/migrations/0008_chatgpt_session_followups.sql and 0009_chatgpt_completion_claim.sql";

export type ChatGptJobRow = Database["public"]["Tables"]["chatgpt_jobs"]["Row"];
export type ChatGptJobKind = ChatGptJobRow["kind"];
export type ChatGptJobStatus = ChatGptJobRow["status"];

function schemaError(error: { message: string; code?: string | null; hint?: string | null }): ApiError {
  if (isMissingSchema(error)) {
    return ApiError.upstream(
      `ChatGPT session jobs are not available yet: apply ${CHATGPT_JOBS_MIGRATION} in Supabase, then retry.`,
    );
  }
  return ApiError.upstream(`ChatGPT job store failed: ${error.message}`);
}

export const chatgptJobsRepo = {
  async create(input: {
    leadId: string;
    proposalId: string | null;
    contactId: string | null;
    kind: ChatGptJobKind;
    promptKey: string;
    promptLabel: string;
    promptSystem: string;
    promptUser: string;
    promptMeta: Database["public"]["Tables"]["chatgpt_jobs"]["Insert"]["prompt_meta"];
    context: Database["public"]["Tables"]["chatgpt_jobs"]["Insert"]["context"];
    createdBy: string;
  }): Promise<ChatGptJobRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .insert({
        lead_id: input.leadId,
        proposal_id: input.proposalId,
        contact_id: input.contactId,
        kind: input.kind,
        prompt_key: input.promptKey,
        prompt_label: input.promptLabel,
        prompt_system: input.promptSystem,
        prompt_user: input.promptUser,
        prompt_meta: input.promptMeta,
        context: input.context,
        created_by: input.createdBy,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === "23505") {
        throw ApiError.conflict(
          input.kind === "ppd_document"
            ? "A PPD generation for this lead is already queued or running. Finish or cancel it first."
            : input.kind === "follow_up"
              ? "A follow-up generation for this lead is already queued or running. Finish or cancel it first."
              : "An email generation for this lead is already queued or running. Finish or cancel it first.",
        );
      }
      throw schemaError(error);
    }
    return data as ChatGptJobRow;
  },

  async get(id: string): Promise<ChatGptJobRow | null> {
    const supabase = getAdminClient();
    const { data, error } = await supabase.from("chatgpt_jobs").select("*").eq("id", id).maybeSingle();
    if (error) throw schemaError(error);
    return (data as ChatGptJobRow | null) ?? null;
  },

  async listForLead(leadId: string, limit = 30): Promise<ChatGptJobRow[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .select("*")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw schemaError(error);
    return (data as ChatGptJobRow[] | null) ?? [];
  },

  /**
   * Claim a queued job, or reopen a failed one for a manual paste. The
   * conditional update is the lock: two dashboard tabs can call this at the
   * same time, but only the one that flipped `queued`/`failed` → `running` may
   * send the prompt to its ChatGPT tab. `claimed: false` means another browser
   * already owns the run.
   */
  async start(id: string): Promise<{ job: ChatGptJobRow; claimed: boolean }> {
    const supabase = getAdminClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .update({
        status: "running",
        started_at: now,
        error: null,
        response_text: null,
      })
      .eq("id", id)
      .in("status", ["queued", "failed"])
      .select("*")
      .maybeSingle();
    if (error) throw schemaError(error);
    if (data) return { job: data as ChatGptJobRow, claimed: true };

    const current = await this.get(id);
    if (!current) throw ApiError.notFound("ChatGPT job not found");
    if (current.status === "running" || current.status === "completing" || current.status === "completed") {
      return { job: current, claimed: false };
    }
    throw ApiError.conflict(`This ChatGPT job is ${current.status} and cannot be started.`);
  },

  /**
   * Atomically reserve finalisation. Only the request that flips queued/running
   * to `completing` may write the proposal/draft, so two tabs holding the same
   * answer cannot insert two rows. `claimed: false` means another request owns
   * the write (or the job is already terminal).
   */
  async claimCompletion(
    id: string,
    responseText: string,
  ): Promise<{ job: ChatGptJobRow; claimed: boolean }> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .update({ status: "completing", response_text: responseText, error: null })
      .eq("id", id)
      .in("status", ["queued", "running"])
      .is("response_text", null)
      .select("*")
      .maybeSingle();
    if (error) throw schemaError(error);
    if (data) return { job: data as ChatGptJobRow, claimed: true };

    const current = await this.get(id);
    if (!current) throw ApiError.notFound("ChatGPT job not found");
    return { job: current, claimed: false };
  },

  /** Called only after the proposal/draft was written successfully. */
  async finishCompletion(id: string): Promise<ChatGptJobRow> {
    const supabase = getAdminClient();
    // The proposal/draft is already written. Retry a transient status update a
    // couple of times rather than leaving the job stuck in `completing`.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("chatgpt_jobs")
        .update({ status: "completed", completed_at: new Date().toISOString(), error: null })
        .eq("id", id)
        .in("status", ["completing", "completed"])
        .select("*")
        .maybeSingle();
      if (!error && data) return data as ChatGptJobRow;
      if (error && attempt === 2) throw schemaError(error);
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    const current = await this.get(id);
    if (!current) throw ApiError.notFound("ChatGPT job not found");
    if (current.status === "completed") return current;
    throw ApiError.conflict(`This ChatGPT job is ${current.status} and cannot be completed.`);
  },

  /** A validation/SQL failure releases the claim so a corrected answer can retry. */
  async releaseCompletion(id: string): Promise<void> {
    const supabase = getAdminClient();
    const { error } = await supabase
      .from("chatgpt_jobs")
      .update({ status: "running", response_text: null, error: null })
      .eq("id", id)
      .eq("status", "completing");
    if (error) throw schemaError(error);
  },

  async fail(id: string, message: string): Promise<ChatGptJobRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .update({ status: "failed", error: message.slice(0, 2_000) })
      .eq("id", id)
      .in("status", ["queued", "running"])
      .select("*")
      .maybeSingle();
    if (error) throw schemaError(error);
    if (data) return data as ChatGptJobRow;
    const current = await this.get(id);
    if (!current) throw ApiError.notFound("ChatGPT job not found");
    return current;
  },

  /**
   * A closed laptop or a crashed browser cannot mark its job failed. Anything
   * still queued/running after 45 minutes is stale and must not block the next
   * generation for that lead forever (the browser budget is 20 minutes).
   */
  async cancelStale(leadId: string, maxAgeMs = 45 * 60 * 1000): Promise<number> {
    const supabase = getAdminClient();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .update({ status: "cancelled", error: "Timed out waiting for the ChatGPT tab" })
      .eq("lead_id", leadId)
      .in("status", ["queued", "running", "completing"])
      .lt("created_at", cutoff)
      .select("id");
    if (error) throw schemaError(error);
    return data?.length ?? 0;
  },

  async cancel(id: string): Promise<ChatGptJobRow> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("chatgpt_jobs")
      .update({ status: "cancelled" })
      .eq("id", id)
      .in("status", ["queued", "running"])
      .select("*")
      .maybeSingle();
    if (error) throw schemaError(error);
    if (data) return data as ChatGptJobRow;
    const current = await this.get(id);
    if (!current) throw ApiError.notFound("ChatGPT job not found");
    if (current.status === "cancelled") return current;
    throw ApiError.conflict(`This ChatGPT job is ${current.status} and cannot be cancelled.`);
  },
};
