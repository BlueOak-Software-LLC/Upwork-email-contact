import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "./errors";
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
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateContact() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ contact: Contact }>("/api/contacts", { method: "POST", body }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Contact added", data.contact.name ?? data.contact.email);
    },
    onError: (error) => toast.error("Could not add the contact", errorMessage(error)),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiFetch<{ contact: Contact }>(`/api/contacts/${id}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: ({ data }, variables) => {
      // Write the row straight back into the list caches: a status change shows
      // up in the table instantly instead of waiting for the next refetch.
      qc.setQueriesData<{ data: Contact[] } | undefined>(
        { queryKey: ["contacts"] },
        (current) =>
          current
            ? {
                ...current,
                data: current.data.map((row) => (row.id === variables.id ? data.contact : row)),
              }
            : current,
      );
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Contact updated", `${data.contact.email} → ${data.contact.status}`);
    },
    onError: (error) => toast.error("Could not update the contact", errorMessage(error)),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/api/contacts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Contact deleted");
    },
    onError: (error) => toast.error("Could not delete the contact", errorMessage(error)),
  });
}

export function useSendEmail() {
  const qc = useQueryClient();
  const toast = useToast();
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
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["email-logs"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["lead"] });
      if (data.provider === "log") {
        toast.warn(
          "Dry run — nothing was handed to a mail server",
          `EMAIL_PROVIDER=log recorded ${data.delivered} recipient(s).`,
        );
      } else if (data.failed) {
        toast.error(
          `${data.failed} of ${data.requested} failed`,
          data.results
            .filter((r) => r.status !== "sent")
            .slice(0, 4)
            .map((r) => `${r.to}: ${r.error ?? r.status}`)
            .join("\n"),
        );
      } else {
        toast.success(`Sent to ${data.delivered} recipient(s)`, data.message);
      }
    },
    onError: (error) => toast.error("Send failed", errorMessage(error)),
  });
}

export function useEmailLogs(filters: { page?: number; status?: string } = {}) {
  return useQuery({
    queryKey: keys.emailLogs(filters),
    queryFn: () => apiFetch<EmailLogRow[]>("/api/email", { query: filters }),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export type { Paged };
