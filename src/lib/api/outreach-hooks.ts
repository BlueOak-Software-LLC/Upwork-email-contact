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

export function useGenerateProposal(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { contactId?: string; regenerate?: boolean } = {}) =>
      apiFetch<{
        proposal: ProposalRow;
        draft: EmailDraftRow | null;
        draftError: string | null;
        warnings: string[];
      }>(`/api/leads/${leadId}/generate`, { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
    },
  });
}

export function useSendDraft(leadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) =>
      apiFetch<{
        draft: EmailDraftRow;
        results: Array<{ status: string; to: string; error: string | null }>;
      }>(`/api/drafts/${draftId}/send`, { method: "POST", body: {} }),
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
      patch: { subject?: string; bodyText?: string; senderAccountId?: string | null };
    }) =>
      apiFetch<{ draft: EmailDraftRow }>(`/api/drafts/${draftId}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead", leadId] }),
  });
}

export type { ProposalRow, EmailDraftRow };
