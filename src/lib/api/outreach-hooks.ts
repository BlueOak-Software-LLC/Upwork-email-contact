import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  EmailDraftRow,
  LeadContactRow,
  LeadRow,
  ProposalRow,
} from "@/types/lead";
import type { SenderAccountDto } from "@/server/db/sender-accounts.repo";

export interface LeadSummary extends LeadRow {
  contact_count?: number;
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

export function useLeads(filters: Record<string, string | number | undefined> = {}) {
  return useQuery({
    queryKey: ["leads", filters],
    queryFn: () => apiFetch<LeadSummary[]>("/api/leads", { query: filters }),
    staleTime: 15_000,
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
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ account: SenderAccountDto }>("/api/sender-accounts", {
        method: "POST",
        body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-accounts"] }),
  });
}

export function useDeleteSenderAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<null>(`/api/sender-accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-accounts"] }),
  });
}

export function useTestSenderAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; account: string; error?: string }>(
        `/api/sender-accounts/${id}/test`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-accounts"] }),
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
  return useMutation({
    mutationFn: (body: {
      contactId?: string;
      toEmail?: string;
      regenerate?: boolean;
      model?: string;
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
    } = {}) =>
      apiFetch<PpdRun>(`/api/leads/${leadId}/generate`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["proposal"] });
    },
  });
}

/** Step 2: write the email for the reviewed PPD and open the draft. */
export function useGenerateEmailDraft(leadId: string) {
  const qc = useQueryClient();
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
    },
  });
}

/** The review step: save an edited PPD back onto the proposal. */
export function useSaveProposal(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      proposalId,
      patch,
    }: {
      proposalId: string;
      patch: { ppd?: unknown; emailSubject?: string; emailContent?: string; reviewed?: boolean };
    }) =>
      apiFetch<{ proposal: ProposalRow; warnings: string[] }>(`/api/proposals/${proposalId}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}

/** A hand-written draft to any address, no Groq call. */
export function useCreateManualDraft(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      toEmail: string;
      cc?: string[];
      subject: string;
      bodyText: string;
      proposalId?: string | null;
      senderAccountId?: string | null;
    }) => apiFetch<{ draft: EmailDraftRow }>(`/api/leads/${leadId}/drafts`, { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead", leadId] }),
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
    }) => apiFetch<{ prompt: PromptDto }>("/api/prompts", { method: "PUT", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompts"] }),
  });
}

export function useResetPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: PromptDto["key"]) =>
      apiFetch<{ prompt: PromptDto; reset: boolean }>(`/api/prompts/${key}/reset`, {
        method: "POST",
        body: {},
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prompts"] }),
  });
}

export function useSendDraft(leadId: string) {
  const qc = useQueryClient();
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
      apiFetch<{
        draft: EmailDraftRow;
        results: Array<{ status: string; to: string; provider: string; error: string | null }>;
      }>(`/api/drafts/${draftId}/send`, {
        method: "POST",
        body: { attachPdf, ...(senderAccountId ? { senderAccountId } : {}) },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["email-logs"] });
    },
  });
}

export function useEditDraft(leadId: string) {
  const qc = useQueryClient();
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
      apiFetch<{ draft: EmailDraftRow }>(`/api/drafts/${draftId}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead", leadId] }),
  });
}

export type { ProposalRow, EmailDraftRow };
