import type { Database } from "@/types/database";

export type LeadConfidence = Database["public"]["Enums"]["lead_confidence"];
export type LeadStatus = Database["public"]["Enums"]["lead_status"];
export type ContactList = Database["public"]["Enums"]["contact_list"];
export type ChannelKind = Database["public"]["Enums"]["channel_kind"];
export type SenderStatus = Database["public"]["Enums"]["sender_status"];
export type DraftStatus = Database["public"]["Enums"]["draft_status"];

export type LeadRow = Database["public"]["Tables"]["leads"]["Row"];
export type LeadContactRow = Database["public"]["Tables"]["lead_contacts"]["Row"];
export type ProposalRow = Database["public"]["Tables"]["proposals"]["Row"];
export type EmailDraftRow = Database["public"]["Tables"]["email_drafts"]["Row"];
export type SenderAccountRow =
  Database["public"]["Tables"]["sender_accounts"]["Row"];

export const LEAD_CONFIDENCES = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNIDENTIFIED",
] as const satisfies readonly LeadConfidence[];

export const LEAD_STATUSES = [
  "received",
  "enriched",
  "proposal_ready",
  "draft_created",
  "sent",
  "failed",
  "archived",
] as const satisfies readonly LeadStatus[];

export type JsonRecord = Record<string, unknown>;

/** What the scraper/caller may post to `POST /api/leads`. */
export interface LeadJobInformation {
  job_id: string | null;
  job_title: string | null;
  job_url: string | null;
  industry: string | null;
  job_location: string | null;
  company_mentioned: string | null;
}

export interface LeadUpworkClient {
  client_name: string | null;
  location: string | null;
}

export type LeadContactItem = {
  name: string | null;
  role: string | null;
  company: string | null;
  contact_type: string | null;
  contact_value: string | null;
  confidence: string | null;
  notes: string | null;
  reason: string | null;
  source_url: string | null;
  url: string | null;
  type: string | null;
};

export type LeadKeyPerson = {
  name: string | null;
  role: string | null;
  location: string | null;
  confidence: string | null;
  linkedin_url: string | null;
  evidence: string | null;
  source_urls: string[];
};

/** `interface` would deny the implicit index signature that `Json` needs. */
export type LeadContactInformation = {
  verified_contacts: LeadContactItem[];
  potential_contacts: LeadContactItem[];
  company_contact_pages: LeadContactItem[];
  linkedin_profiles: LeadContactItem[];
  social_media_profiles: LeadContactItem[];
};

/** Normalised, fully typed view of the payload. */
export interface NormalizedLead {
  dedupeKey: string;
  jobId: string | null;
  jobTitle: string | null;
  jobUrl: string | null;
  jobLocation: string | null;
  industry: string | null;
  companyMentioned: string | null;
  clientName: string | null;
  clientLocation: string | null;
  jobDescription: string | null;
  overallConfidence: LeadConfidence;
  keyPeople: LeadKeyPerson[];
  contactInformation: LeadContactInformation;
  rawPayload: JsonRecord;
  contacts: NormalizedContact[];
  /** Best email to write to: HIGH-confidence verified first, then potential. */
  primaryEmail: NormalizedContact | null;
}

export interface NormalizedContact {
  listType: ContactList;
  name: string | null;
  role: string | null;
  company: string | null;
  contactType: string | null;
  channel: ChannelKind;
  contactValue: string;
  normalizedValue: string | null;
  confidence: LeadConfidence | null;
  rationale: string | null;
  sourceUrl: string | null;
  isEmail: boolean;
  isPrimary: boolean;
}

/** ── pdfme field contract: keys here must exist in the template JSON ───── */
export interface ProposalPpd {
  document_title: string;
  proposal_subtitle: string;
  prepared_for: string;
  client_company: string;
  contact_name: string;
  contact_role: string;
  prepared_by: string;
  prepared_date: string;
  valid_until: string;
  job_title: string;
  job_reference: string;
  job_url: string;
  engagement_summary: string;
  understanding: string;
  scope_title: string;
  deliverables: string[]; // max 6 slots in the template
  approach: string[]; // max 5
  timeline_label_1: string;
  timeline_value_1: string;
  timeline_label_2: string;
  timeline_value_2: string;
  timeline_label_3: string;
  timeline_value_3: string;
  pricing_title: string;
  pricing_option_1_name: string;
  pricing_option_1_price: string;
  pricing_option_1_notes: string;
  pricing_option_2_name: string;
  pricing_option_2_price: string;
  pricing_option_2_notes: string;
  includes: string[]; // max 6
  assumptions: string[]; // max 5
  next_steps: string[]; // max 4
  why_us: string[]; // max 5
  contact_email: string;
  contact_name_signature: string;
  closing_note: string;
  footer_note: string;
}

export interface ProposalOutput {
  ppd: ProposalPpd;
  email: {
    subject: string;
    content: string;
  };
}

export interface IngestResult {
  lead: LeadRow;
  created: boolean;
  contacts: LeadContactRow[];
  emailContacts: LeadContactRow[];
  proposals: ProposalRow[];
  drafts: EmailDraftRow[];
  warnings: string[];
  generation: {
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: boolean;
    reason?: string;
  };
}
