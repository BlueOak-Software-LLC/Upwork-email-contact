import { apiFetch } from "./client";
import type { EmailDraftRow, ProposalPpd, ProposalRow } from "@/types/lead";

export type ChatGptJobKind = "ppd_document" | "email_draft" | "follow_up";
export type ChatGptJobStatus =
  | "queued"
  | "running"
  | "completing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChatGptJobDto {
  id: string;
  leadId: string;
  proposalId: string | null;
  contactId: string | null;
  kind: ChatGptJobKind;
  status: ChatGptJobStatus;
  label: string;
  /** System instructions (kept separate so the drawer can show just the ask). */
  system: string;
  prompt: string;
  promptMeta: {
    key: "ppd_document" | "email_draft" | "follow_up";
    label: string;
    isDefault: boolean;
    temperature: number;
    maxTokens: number | null;
    unknownVars: string[];
    model: string;
  };
  responseText: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ChatGptCompleteResult {
  job: ChatGptJobDto;
  proposal?: ProposalRow;
  ppd?: ProposalPpd;
  email?: { subject: string; content: string };
  draft?: EmailDraftRow | null;
  draftError?: string | null;
  documentWords?: number;
  warnings: string[];
}

export interface CreateChatGptJobInput {
  leadId: string;
  kind: ChatGptJobKind;
  proposalId?: string | null;
  contactId?: string | null;
  toEmail?: string | null;
  cc?: string[] | null;
  senderAccountId?: string | null;
  regenerate?: boolean;
  previousDraftId?: string | null;
}

export async function createChatGptJob(input: CreateChatGptJobInput) {
  return (
    await apiFetch<{ job: ChatGptJobDto | null; reused: boolean; proposal?: ProposalRow }>(
      "/api/chatgpt/jobs",
      { method: "POST", body: input },
    )
  ).data;
}

export async function listChatGptJobs(leadId: string) {
  return (await apiFetch<{ jobs: ChatGptJobDto[] }>(`/api/chatgpt/jobs?leadId=${leadId}`)).data;
}

export async function startChatGptJob(jobId: string) {
  return (
    await apiFetch<{ job: ChatGptJobDto; claimed: boolean }>(`/api/chatgpt/jobs/${jobId}/start`, {
      method: "POST",
    })
  ).data;
}

export async function completeChatGptJob(jobId: string, responseText: string) {
  return (
    await apiFetch<ChatGptCompleteResult>(`/api/chatgpt/jobs/${jobId}/complete`, {
      method: "POST",
      body: { responseText },
    })
  ).data;
}

export async function failChatGptJob(jobId: string, error: string) {
  return (
    await apiFetch<{ job: ChatGptJobDto }>(`/api/chatgpt/jobs/${jobId}/fail`, {
      method: "POST",
      body: { error },
    })
  ).data;
}

export async function cancelChatGptJob(jobId: string) {
  return (
    await apiFetch<{ job: ChatGptJobDto }>(`/api/chatgpt/jobs/${jobId}/cancel`, { method: "POST" })
  ).data;
}
