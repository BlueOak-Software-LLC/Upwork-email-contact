import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  Contact,
  ContactStatus,
  EmailLogRow,
  Paged,
  SendEmailResult,
} from "@/types/domain";

export const keys = {
  contacts: (params: object) => ["contacts", params] as const,
  contact: (id: string) => ["contacts", "detail", id] as const,
  emailLogs: (params: object) => ["email-logs", params] as const,
};

export interface ContactFilters {
  q?: string;
  status?: ContactStatus | "";
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: "asc" | "desc";
}

export function useContacts(filters: ContactFilters = {}) {
  return useQuery({
    queryKey: keys.contacts(filters),
    queryFn: () =>
      apiFetch<Contact[]>("/api/contacts", {
        query: filters as Record<string, string | number | undefined>,
      }),
    // The table is interactive; keep lists fresh for a short window only.
    staleTime: 15_000,
  });
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ contact: Contact }>("/api/contacts", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiFetch<{ contact: Contact }>(`/api/contacts/${id}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: keys.contact(variables.id) });
    },
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<null>(`/api/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useSendEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      to: string | string[];
      subject: string;
      text?: string;
      html?: string;
      contactId?: string;
    }) =>
      apiFetch<{
        provider: string;
        requested: number;
        delivered: number;
        failed: number;
        results: SendEmailResult[];
        message: string;
      }>("/api/email/send", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["email-logs"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}

export function useEmailLogs(filters: { page?: number; status?: string } = {}) {
  return useQuery({
    queryKey: keys.emailLogs(filters),
    queryFn: () => apiFetch<EmailLogRow[]>("/api/email", { query: filters }),
  });
}

export type { Paged };
