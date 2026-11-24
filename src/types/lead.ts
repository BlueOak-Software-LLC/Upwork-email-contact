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

/**
 * ── PPD contract ── what Groq returns and what the pdfme compiler renders.
 *
 * The document is **block-based**, not fixed-slot: `lib/pdfme/compiler.ts`
 * turns each block into positioned pdfme `text` fields, pre-wraps the lines to
 * the column width and paginates (A4, mm), repeating the footer + `n / total`
 * page number on every page. A 600-word proposal becomes 2 pages and a
 * 3,000-word one becomes 6 — no template edit needed either way.
 *
 * This is the TypeScript port of the `compile_pdfme.py` contract
 * (`blueoak_pdfme_fixed.zip`), so the same content JSON also renders with that
 * script if you prefer the Python designer flow.
 */
export type PpdBlockType =
  | "paragraph"
  | "note"
  | "bullets"
  | "numberedSteps"
  | "capabilityMatrix"
  | "keyValueTable"
  | "references";

export interface PpdParagraphBlock {
  type: "paragraph";
  items: string[];
}
export interface PpdNoteBlock {
  type: "note";
  text: string;
}
export interface PpdBulletsBlock {
  type: "bullets";
  items: string[];
}
export interface PpdStep {
  title: string;
  description: string;
}
export interface PpdNumberedStepsBlock {
  type: "numberedSteps";
  items: PpdStep[];
}
export interface PpdCapability {
  requirement: string;
  approach: string;
}
export interface PpdCapabilityMatrixBlock {
  type: "capabilityMatrix";
  items: PpdCapability[];
}
export interface PpdKeyValue {
  label: string;
  value: string;
}
export interface PpdKeyValueTableBlock {
  type: "keyValueTable";
  rows: PpdKeyValue[];
}
export interface PpdReference {
  name: string;
  url: string;
  verified: boolean;
}
export interface PpdReferencesBlock {
  type: "references";
  items: PpdReference[];
}

export type PpdBlock =
  | PpdParagraphBlock
  | PpdNoteBlock
  | PpdBulletsBlock
  | PpdNumberedStepsBlock
  | PpdCapabilityMatrixBlock
  | PpdKeyValueTableBlock
  | PpdReferencesBlock;

export interface PpdSection {
  id: string;
  title: string;
  blocks: PpdBlock[];
}

export interface ProposalPpd {
  /** Our company — comes from PROPOSAL_COMPANY, never from the model. */
  company: string;
  document_title: string;
  subtitle: string;
  job_title: string;
  job_reference: string;
  prepared_for: string;
  prepared_by: string;
  rate: string;
  engagement: string;
  website: string;
  sections: PpdSection[];
  closing: string;
}

/** The flat v1 PPD that older `proposals.ppd` rows still hold. */
export interface LegacyProposalPpd {
  document_title: string;
  proposal_subtitle: string;
  engagement_summary: string;
  understanding: string;
  deliverables: string[];
  approach: string[];
  includes: string[];
  assumptions: string[];
  next_steps: string[];
  why_us: string[];
  closing_note: string;
  footer_note: string;
  [key: string]: unknown;
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
  /**
   * Set when this payload describes a job already stored: `job_id` or the job
   * link matched an existing row, so nothing was added. The lead in `lead` is
   * the one that was already there.
   */
  duplicate?: { leadId: string; matchedBy: "job_id" | "job_url" | "dedupe_key" };
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
