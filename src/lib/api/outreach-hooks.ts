"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiFetchBlob } from "./client";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "./errors";
import type {
  EmailDraftRow,
  LeadContactRow,
  LeadRow,
  ProposalRow,
} from "@/types/lead";
import type { SenderAccountDto } from "@/server/db/sender-accounts.repo";

export interface LeadSummary extends LeadRow {
  contact_count?: number;
  proposal_count?: number;
  draft_count?: number;
}

export interface LeadDetailDto {
  lead: LeadRow;
  contacts: LeadContactRow[];
  proposals: ProposalRow[];
  drafts: EmailDraftRow[];
  keyPeople: unknown[];
  contactInformation: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}

export const leadKey = (id: string) => ["lead", id] as const;

/**
 * The single source of truth for one lead page.
 *
 * The server renders the first paint (passed in as `initialData`), then every
 * mutation writes its result back into this cache — so generating, reviewing,
 * drafting or sending updates the screen immediately. Nobody should have to
 * press the browser refresh to see what they just did.
 */
export function useLead(leadId: string, initialData?: LeadDetailDto) {
  return useQuery({
    queryKey: leadKey(leadId),
    queryFn: async () => (await apiFetch<LeadDetailDto>(`/api/leads/${leadId}`)).data,
    initialData,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}

/** Replace the cached lead with a server-returned copy (mutations return it). */
export function useLeadCache(leadId: string) {
  const qc = useQueryClient();
  return (detail: LeadDetailDto) => qc.setQueryData(leadKey(leadId), detail);
}

/**
 * Render the PDF server-side from the reviewed PPD and keep it in memory only
 * long enough to show or download it. Fetched as a blob because the route is
 * header-authenticated, which a bare <iframe src> could not satisfy.
 */
export function useRenderPdf(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      proposalId,
      download,
    }: {
      proposalId?: string;
      download?: boolean;
      attachToDraftId?: string | null;
    }) =>
      apiFetchBlob(`/api/leads/${leadId}/pdf`, {
        proposalId,
        render: true,
        ...(download ? { download: true } : {}),
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: leadKey(leadId) });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(
        "PDF compiled",
        `${(result.blob.size / 1024).toFixed(0)} KB from the reviewed document${
          result.filename ? ` · ${result.filename}` : ""
        }`,
      );
    },
    onError: (error) => {
      toast.error("PDF could not be rendered", errorMessage(error));
    },
  });
}

export interface IngestResponse {
  lead: LeadRow;
  created: boolean;
  contacts: LeadContactRow[];
  proposals: ProposalRow[];
  drafts: EmailDraftRow[];
  warnings: string[];
  generation: {
    attempted: number;
    succeeded: number;
    failed: number;
    skipped?: boolean;
    reason?: string;
  } | null;
}

/**
 * POST /api/leads — the same contract your scraper uses, so a payload can be
 * pasted straight into the dashboard for testing or recovery.
 *
 * Generation mode is a QUERY option (`?auto=true|false`) — it must never be
 * folded into the body, because the body is stored verbatim in
 * `leads.raw_payload`.
 */
export function useIngestLead() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ payload, query }: { payload: Record<string, unknown>; query?: string }) =>
      apiFetch<IngestResponse>("/api/leads", {
        method: "POST",
        body: payload,
        query: query
          ? Object.fromEntries(new URLSearchParams(query))
          : undefined,
      }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: leadKey(data.lead.id) });
      toast.success(
        data.created ? "Lead ingested" : "Lead updated (same dedupe key)",
        `${data.contacts.length} contact(s) · ${
          data.generation?.attempted
            ? `${data.generation.succeeded} document(s) written`
            : data.generation?.reason ?? "no document generated yet"
        }`,
      );
      for (const warning of data.warnings) toast.warn("Ingest warning", warning);
    },
    onError: (error) => toast.error("Ingest failed", errorMessage(error)),
  });
}
export function useLeads(filters: Record<string, string | number | undefined> = {}) {
  return useQuery({
    queryKey: ["leads", filters],
    queryFn: () => apiFetch<LeadSummary[]>("/api/leads", { query: filters }),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useSenderAccounts() {
  return useQuery({
    queryKey: ["sender-accounts"],
    queryFn: async () =>
      (await apiFetch<{ accounts: SenderAccountDto[] }>("/api/sender-accounts")).data.accounts,
    staleTime: 30_000,
  });
}

export function useCreateSenderAccount() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ account: SenderAccountDto }>("/api/sender-accounts", {
        method: "POST",
        body,
      }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["sender-accounts"] });
      toast.success("Sender account added", data.account.from_email);
    },
    onError: (error) => toast.error("Could not add the account", errorMessage(error)),
  });
}

export function useDeleteSenderAccount() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<null>(`/api/sender-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sender-accounts"] });
      toast.success("Sender account removed");
    },
    onError: (error) => toast.error("Could not remove it", errorMessage(error)),
  });
}

export function useTestSenderAccount() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; account: string; error?: string }>(
        `/api/sender-accounts/${id}/test`,
        { method: "POST" },
      ),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["sender-accounts"] });
      if (data.ok) toast.success("SMTP login worked", data.account);
      else toast.error("SMTP login failed", data.error ?? null);
    },
    onError: (error) => toast.error("Test could not run", errorMessage(error)),
  });
}

export interface PromptRunInfo {
  key: "ppd_document" | "email_draft";
  label: string;
  isDefault: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  /** GROQ_MAX_TOKENS / prompt setting before the TPM clamp. */
  requestedMaxTokens: number;
  reasoningEffort: string | null;
  system: string;
  user: string;
  unknownVars: string[];
}

export interface PpdRun {
  proposal: ProposalRow;
  ppd: unknown;
  documentWords: number;
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number } | null;
  costUsd: number | null;
  warnings: string[];
  recipient: { contactId: string; email: string; source: "lead_contact" | "custom" } | null;
  /** Set when the document was written from the post text with no address. */
  recipientNote: string | null;
  pdfStatus: string;
  prompt: PromptRunInfo;
  next: string;
}

export interface EmailRun {
  proposal: ProposalRow;
  email: { subject: string; content: string };
  draft: EmailDraftRow | null;
  draftError: string | null;
  recipient: { email: string; source: "lead_contact" | "custom"; contactId: string };
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number } | null;
  costUsd: number | null;
  warnings: string[];
  pdfStatus: string;
  prompt: PromptRunInfo;
  next: string | null;
}

export function useGenerateProposal(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: {
      contactId?: string;
      toEmail?: string;
      regenerate?: boolean;
      model?: string;
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
    } = {}) =>
      apiFetch<PpdRun>(`/api/leads/${leadId}/generate`, { method: "POST", body }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: leadKey(leadId) });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(
        `PPD v${data.proposal.version} written`,
        `${data.documentWords} words${
          data.recipient ? ` for ${data.recipient.email}` : " with no recipient yet"
        }${data.costUsd !== null ? ` · ~$${data.costUsd.toFixed(5)}` : ""}`,
      );
      for (const warning of data.warnings) toast.warn("PPD warning", warning);
    },
    onError: (error) => toast.error("PPD generation failed", errorMessage(error)),
  });
}

/** Step 2: write the email for the reviewed PPD and open the draft. */
export function useGenerateEmailDraft(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: {
      proposalId?: string;
      contactId?: string;
      toEmail?: string;
      cc?: string[];
      senderAccountId?: string | null;
      createDraft?: boolean;
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
    } = {}) =>
      apiFetch<EmailRun>(`/api/leads/${leadId}/generate-email`, { method: "POST", body }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: leadKey(leadId) });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["email-logs"] });
      if (data.draftError) {
        toast.warn("Email written, draft not created", data.draftError);
      } else {
        toast.success(
          data.draft ? "Email draft created" : "Email copy written to the proposal",
          data.email.subject,
        );
      }
      for (const warning of data.warnings) toast.warn("Email warning", warning);
    },
    onError: (error) => toast.error("Email draft failed", errorMessage(error)),
  });
}

/**
 * The review step: save an edited PPD back onto the proposal.
 *
 * The PATCH answer carries the refreshed lead in full, so the cache is replaced
 * straight from it — the read view, the step chips and the PDF badge change in
 * the same frame the save lands. No refetch, no manual refresh.
 */
export function useSaveProposal(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      proposalId,
      patch,
    }: {
      proposalId: string;
      patch: { ppd?: unknown; emailSubject?: string; emailContent?: string; reviewed?: boolean };
      /** The document as it was before this edit — so a no-op save is visible. */
      previousPpd?: unknown;
    }) =>
      apiFetch<{ proposal: ProposalRow; warnings: string[]; lead: LeadDetailDto }>(
        `/api/proposals/${proposalId}`,
        { method: "PATCH", body: patch },
      ),
    onSuccess: ({ data }, variables) => {
      qc.setQueryData(leadKey(leadId), data.lead);
      qc.invalidateQueries({ queryKey: ["leads"] });

      const row =
        data.lead?.proposals?.find((p) => p.id === variables.proposalId) ?? data.proposal;
      const touchedText = variables.patch.ppd !== undefined;
      const unchanged =
        touchedText && JSON.stringify(variables.previousPpd ?? null) === JSON.stringify(row?.ppd ?? null);

      if (unchanged) {
        // The most confusing failure a reviewer can hit: the request succeeded,
        // the sanitizer decided the edit was invalid, and the text snapped back.
        toast.warn(
          "Saved — but the stored document came back identical",
          data.warnings[0] ??
            "Everything you changed was rewritten by the server. Check the Edit document tab: a block may be empty or a section type unsupported.",
        );
      } else if (touchedText) {
        toast.success(
          `Document updated — ${wordCount(row?.ppd)} words`,
          data.warnings[0] ?? "Marked reviewed. The PDF re-renders from this text on preview or send.",
        );
      } else {
        toast.success(
          "Marked reviewed",
          data.warnings[0] ?? "The email step is unlocked; the PDF renders from this text at send time.",
        );
      }
      for (const warning of data.warnings.slice(1)) toast.warn("Saved with a warning", warning);
    },
    onError: (error) => toast.error("Could not save the document", errorMessage(error)),
  });
}

/** Rough visible-word count of a stored PPD, for the save confirmation. */
function wordCount(ppd: unknown): number {
  const sections = (ppd as { sections?: Array<{ blocks?: Array<Record<string, unknown>> }> })?.sections;
  if (!Array.isArray(sections)) return 0;
  const words: string[] = [];
  for (const section of sections) {
    for (const block of section.blocks ?? []) {
      if (Array.isArray(block.items)) {
        for (const item of block.items) {
          words.push(typeof item === "string" ? item : JSON.stringify(item));
        }
      }
      if (typeof block.text === "string") words.push(block.text);
      if (Array.isArray(block.rows)) words.push(JSON.stringify(block.rows));
    }
  }
  return words.join(" ").split(/\s+/).filter(Boolean).length;
}

/** A hand-written draft to any address, no Groq call. */
export function useCreateManualDraft(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: {
      toEmail: string;
      cc?: string[];
      subject: string;
      bodyText: string;
      proposalId?: string | null;
      senderAccountId?: string | null;
    }) =>
      apiFetch<{ draft: EmailDraftRow; lead?: LeadDetailDto }>(`/api/leads/${leadId}/drafts`, {
        method: "POST",
        body,
      }),
    onSuccess: ({ data }) => {
      if (data.lead) qc.setQueryData(leadKey(leadId), data.lead);
      else qc.invalidateQueries({ queryKey: leadKey(leadId) });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Draft created", `to ${data.draft.to_email}`);
    },
    onError: (error) => toast.error("Could not create the draft", errorMessage(error)),
  });
}

export interface PromptDto {
  key: "ppd_document" | "email_draft";
  label: string;
  note: string;
  system: string;
  user: string;
  temperature: number;
  maxTokens: number | null;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
  isDefault: boolean;
  updatedAt: string | null;
}

export interface PromptLibrary {
  prompts: PromptDto[];
  variables: Array<{ name: string; description: string }>;
  used: Array<{ key: string; system: string[]; user: string[] }>;
}

export function usePrompts() {
  return useQuery({
    queryKey: ["prompts"],
    queryFn: async () => (await apiFetch<PromptLibrary>("/api/prompts")).data,
    staleTime: 30_000,
  });
}

export function useSavePrompt() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: {
      key: PromptDto["key"];
      label?: string;
      systemText: string;
      userTemplate: string;
      temperature?: number;
      maxTokens?: number | null;
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | null;
      note?: string | null;
    }) =>
      apiFetch<{ prompt: PromptDto; warnings?: string[] }>("/api/prompts", {
        method: "PUT",
        body,
      }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["prompts"] });
      qc.invalidateQueries({ queryKey: ["lead"] });
      toast.success(`${data.prompt.label} prompt saved`, "It applies to the next generation.");
      for (const warning of data.warnings ?? []) toast.warn("Saved with a warning", warning);
    },
    onError: (error) => toast.error("Could not save the prompt", errorMessage(error)),
  });
}

export function useResetPrompt() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (key: PromptDto["key"]) =>
      apiFetch<{ prompt: PromptDto; reset: boolean }>(`/api/prompts/${key}/reset`, {
        method: "POST",
        body: {},
      }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["prompts"] });
      qc.invalidateQueries({ queryKey: ["lead"] });
      toast.success(`${data.prompt.label} prompt reset`, "Back to the code default.");
    },
    onError: (error) => toast.error("Could not reset the prompt", errorMessage(error)),
  });
}

export interface SendResult {
  status: string;
  to: string;
  provider: string;
  error: string | null;
}

export function useSendDraft(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      draftId,
      attachPdf = true,
      senderAccountId,
    }: {
      draftId: string;
      attachPdf?: boolean;
      senderAccountId?: string;
    }) =>
      apiFetch<{ draft: EmailDraftRow; results: SendResult[]; lead?: LeadDetailDto }>(
        `/api/drafts/${draftId}/send`,
        { method: "POST", body: { attachPdf, ...(senderAccountId ? { senderAccountId } : {}) } },
      ),
    onSuccess: ({ data }) => {
      if (data.lead) qc.setQueryData(leadKey(leadId), data.lead);
      else qc.invalidateQueries({ queryKey: leadKey(leadId) });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["email-logs"] });

      const provider = data.results[0]?.provider ?? "smtp";
      const notSent = data.results.filter((r) => r.status !== "sent" && r.status !== "queued");
      if (notSent.length) {
        toast.error(
          `${notSent.length} recipient(s) not delivered`,
          notSent.map((r) => `${r.to}: ${r.error ?? r.status}`).join("\n"),
        );
      } else if (provider === "log") {
        toast.warn(
          "Dry run — nothing left this server",
          `EMAIL_PROVIDER=log recorded ${data.results.map((r) => r.to).join(", ")} instead of sending.`,
        );
      } else {
        toast.success(
          "Draft sent",
          `${data.results.map((r) => r.to).join(", ")} · ${provider}`,
        );
      }
    },
    onError: (error) => toast.error("Send failed", errorMessage(error)),
  });
}

export function useEditDraft(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({
      draftId,
      patch,
    }: {
      draftId: string;
      patch: {
        subject?: string;
        bodyText?: string;
        /** Any address — it does not have to come from the payload. */
        toEmail?: string;
        cc?: string[] | null;
        senderAccountId?: string | null;
        status?: "draft" | "queued" | "cancelled";
      };
    }) =>
      apiFetch<{ draft: EmailDraftRow; lead?: LeadDetailDto }>(`/api/drafts/${draftId}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: ({ data }) => {
      if (data.lead) qc.setQueryData(leadKey(leadId), data.lead);
      else qc.invalidateQueries({ queryKey: leadKey(leadId) });
      toast.success("Draft saved", data.draft.subject || "(no subject)");
    },
    onError: (error) => toast.error("Could not save the draft", errorMessage(error)),
  });
}

/** PATCH /api/leads/:id — status change, or a late job_description. */
export function useUpdateLead(leadId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (patch: {
      status?: string;
      job_description?: string | null;
      error?: string | null;
    }) =>
      apiFetch<LeadDetailDto & { hints?: string[] }>(`/api/leads/${leadId}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: (response) => {
      qc.setQueryData(leadKey(leadId), response.data);
      qc.invalidateQueries({ queryKey: ["leads"] });
      const hints = response.data.hints ?? [];
      if (hints.length) toast.info("Lead updated", hints.join("\n"));
      else toast.success("Lead updated");
    },
    onError: (error) => toast.error("Could not update the lead", errorMessage(error)),
  });
}

/** DELETE /api/leads/:id — used by the destructive action on the lead page. */
/** What `DELETE /api/leads` reports back for an irreversible call. */
export interface LeadRemovalReport {
  removed: Array<{
    id: string;
    job_title: string | null;
    contacts: number;
    proposals: number;
    drafts: number;
    pdfFiles: number;
  }>;
  missing: string[];
  failed: Array<{ id: string; error: string }>;
  storageErrors: string[];
  totals: { leads: number; contacts: number; proposals: number; drafts: number; pdfFiles: number };
}

/**
 * Take rows out of every list cache and drop their detail caches.
 *
 * Deleting then waiting for a refetch makes rows disappear ~400 ms later, which
 * reads as "did it work?". Editing the cache answers immediately; the
 * invalidation afterwards only corrects the page totals.
 */
function purgeLeads(qc: ReturnType<typeof useQueryClient>, ids: string[]) {
  const gone = new Set(ids);
  for (const [key] of qc.getQueriesData<{ data?: LeadSummary[]; meta?: { total?: number } }>({
    queryKey: ["leads"],
  })) {
    qc.setQueryData(key, (old: { data?: LeadSummary[]; meta?: { total?: number } } | undefined) => {
      if (!old || !Array.isArray(old.data)) return old;
      const rows = old.data.filter((row) => !gone.has(row.id));
      const delta = old.data.length - rows.length;
      return {
        ...old,
        data: rows,
        meta: old.meta
          ? { ...old.meta, total: Math.max(0, (old.meta.total ?? old.data.length) - delta) }
          : old.meta,
      };
    });
  }
  for (const id of ids) qc.removeQueries({ queryKey: leadKey(id) });
  qc.invalidateQueries({ queryKey: ["leads"] });
  qc.invalidateQueries({ queryKey: ["email-logs"] });
  qc.invalidateQueries({ queryKey: ["overview"] });
}

function reportRemoval(toast: ReturnType<typeof useToast>, report: LeadRemovalReport) {
  const t = report.totals;
  if (t.leads) {
    toast.success(
      `${t.leads} ${t.leads === 1 ? "job" : "jobs"} removed permanently`,
      `${t.proposals} document(s), ${t.drafts} draft(s), ${t.contacts} contact(s) and ${t.pdfFiles} stored PDF file(s) went with ` +
        `${t.leads === 1 ? "it" : "them"}. CRM contacts and sent-message log rows stay.`,
    );
  }
  if (report.missing.length) {
    toast.warn(
      `${report.missing.length} id(s) were already gone`,
      report.missing.map((id) => id.slice(0, 8)).join(", "),
    );
  }
  for (const failure of report.failed) {
    toast.error(`Could not remove ${failure.id.slice(0, 8)}`, failure.error);
  }
  for (const error of report.storageErrors) {
    toast.warn("Database rows are gone, but PDF storage cleanup failed", error);
  }
}

/** Remove a batch of jobs. `ids` are exact lead uuids — never a filter. */
export function useDeleteLeads() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<LeadRemovalReport>("/api/leads", { method: "DELETE", body: { ids } }),
    onSuccess: ({ data }, ids) => {
      purgeLeads(qc, data.removed.map((r) => r.id));
      if (!data.removed.length && !data.failed.length && !data.missing.length) {
        toast.warn("Nothing was removed", `No lead matched ${ids.length} id(s)`);
      }
      reportRemoval(toast, data);
    },
    onError: (error) => toast.error("Nothing was removed", errorMessage(error)),
  });
}

export function useDeleteLead() {
  const remove = useDeleteLeads();
  return {
    ...remove,
    mutate: (leadId: string, options?: Parameters<typeof remove.mutate>[1]) =>
      remove.mutate([leadId], options),
    mutateAsync: (leadId: string) => remove.mutateAsync([leadId]),
  };
}

export type { ProposalRow, EmailDraftRow };
