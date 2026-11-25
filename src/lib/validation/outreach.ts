import { z } from "zod";
import { LEAD_PIPELINES, LEAD_STATUSES } from "@/types/lead";

export const leadStatusSchema = z.enum(LEAD_STATUSES);

export const leadPipelineSchema = z.enum(LEAD_PIPELINES);

/**
 * ISO timestamp with an offset, or a bare `YYYY-MM-DD` (from a hand-written
 * link). The client sends full local-midnight ISO strings so "today" means the
 * reader's today, not the UTC day.
 */
const dateBound = z
  .string()
  .trim()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Not a valid date" });

export const listLeadsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: leadStatusSchema.optional(),
    pipeline: leadPipelineSchema.optional(),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW", "UNIDENTIFIED"]).optional(),
    from: dateBound.optional(),
    to: dateBound.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    sort: z
      .enum(["created_at", "received_at", "updated_at", "job_title", "status", "overall_confidence"])
      .default("created_at"),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine(
    (value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to),
    { message: "from must be before to", path: ["to"] },
  );

/** Only the human-editable columns; the payload itself is immutable. */
export const updateLeadSchema = z
  .object({
    status: leadStatusSchema.optional(),
    /**
     * `job_information.job_description` supplied late (the scraper sometimes gets
     * the post text only after the first pass). Replacing it does not rewrite any
     * already-generated document — the response says so.
     */
    job_description: z.string().trim().max(200_000).nullable().optional(),
    error: z.string().trim().max(900).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const ingestOptionsSchema = z.object({
  auto: z.enum(["true", "false"]).optional(),
  dry: z.enum(["true", "false"]).optional(),
  regenerate: z.enum(["true", "false"]).optional(),
  /**
   * `refresh=true` overwrites a lead whose job_id/job link matched. Without it
   * a duplicate is reported and left alone, which is what a scraper re-posting
   * the same job wants: never roll a reviewed proposal back to `received`.
   */
  refresh: z.enum(["true", "false"]).optional(),
  senderAccountId: z.string().uuid().optional(),
});

/** Any of "Name <a@b.com>", "a@b.com", "mailto:a@b.com". */
const recipientEmail = z
  .string()
  .trim()
  .transform((value) =>
    value
      .replace(/^mailto:/i, "")
      .replace(/^.*<([^>]+)>.*$/, "$1")
      .trim()
      .toLowerCase(),
  )
  .refine((value) => /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(value), {
    message: "Not a valid email address",
  });

const ccList = z
  .array(recipientEmail)
  .max(10)
  .transform((values) => [...new Set(values)]);

/** Step 1 — the PPD document only. No email, no PDF. */
export const generateProposalSchema = z.object({
  /** Which contact to write for; defaults to the lead's primary email. */
  contactId: z.string().uuid().optional(),
  /**
   * Write the document for an address that is not in the payload. Stored as a
   * manual `lead_contacts` row so the audit trail explains where it came from.
   */
  toEmail: recipientEmail.optional(),
  regenerate: z.boolean().default(true),
});

/** Step 2 — the outreach email for a reviewed PPD, plus the draft it opens. */
export const generateEmailSchema = z.object({
  /** Proposal to write the email for; defaults to the newest on the lead. */
  proposalId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  /** Send-to address; may be a custom one (creates a manual contact). */
  toEmail: recipientEmail.optional(),
  cc: ccList.optional(),
  senderAccountId: z.string().uuid().nullish(),
  /** false → only write subject/body onto the proposal, open no draft. */
  createDraft: z.boolean().default(true),
});

/** The app → ChatGPT-session job. No model API is called. */
export const createChatGptJobSchema = z.object({
  leadId: z.string().uuid(),
  kind: z.enum(["ppd_document", "email_draft", "follow_up"]),
  proposalId: z.string().uuid().nullish(),
  contactId: z.string().uuid().nullish(),
  toEmail: recipientEmail.nullish(),
  cc: ccList.nullish(),
  senderAccountId: z.string().uuid().nullish(),
  regenerate: z.boolean().optional(),
  previousDraftId: z.string().uuid().nullish(),
});

export const completeChatGptJobSchema = z.object({
  responseText: z.string().trim().min(2).max(200_000),
});

export const failChatGptJobSchema = z.object({
  error: z.string().trim().min(1).max(4_000),
});

export const smtpPort = z.coerce.number().int().min(1).max(65535);

const profileUrl = z
  .string()
  .trim()
  .max(300)
  .nullish()
  .refine(
    (value) => !value || /^https?:\/\//i.test(value) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value),
    "Use a full URL, e.g. https://linkedin.com/in/your-name",
  );

export const createSenderAccountSchema = z.object({
  label: z.string().trim().min(1).max(80),
  fromEmail: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().max(120).nullish(),
  replyTo: z.string().trim().toLowerCase().email().max(320).nullish(),
  signature: z.string().trim().max(2000).nullish(),
  roleTitle: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(60).nullish(),
  whatsapp: z.string().trim().max(160).nullish(),
  linkedinUrl: profileUrl,
  website: profileUrl,
  location: z.string().trim().max(120).nullish(),
  experienceSummary: z.string().trim().max(4000).nullish(),
  skills: z.string().trim().max(1500).nullish(),
  smtpHost: z.string().trim().min(1).max(200),
  smtpPort: smtpPort.default(587),
  smtpSecure: z.boolean().default(false),
  smtpUser: z.string().trim().max(320).nullish(),
  smtpPassword: z.string().min(1).max(500),
  dailyLimit: z.coerce.number().int().min(1).max(2000).default(50),
  isDefault: z.boolean().default(false),
});

export const updateSenderAccountSchema = createSenderAccountSchema
  .extend({ smtpPassword: z.string().min(1).max(500).optional() })
  .partial()
  // `.partial()` keeps a Zod default on these four fields, so a PATCH with only
  // profile data would silently reset SMTP/limits/default. Replace them with
  // plain optionals: omitted really means "leave the stored value alone".
  .extend({
    smtpPort: smtpPort.optional(),
    smtpSecure: z.boolean().optional(),
    dailyLimit: z.coerce.number().int().min(1).max(2000).optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const editDraftSchema = z
  .object({
    subject: z.string().trim().min(1).max(300).optional(),
    bodyText: z.string().trim().min(1).max(50_000).optional(),
    /** Re-point the draft at any address, payload contact or not. */
    toEmail: recipientEmail.optional(),
    cc: ccList.nullish(),
    senderAccountId: z.string().uuid().nullable().optional(),
    status: z.enum(["draft", "queued", "cancelled"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const sendDraftSchema = z.object({
  senderAccountId: z.string().uuid().optional(),
  /**
   * true (default) → the proposal PDF is compiled and attached right before the
   * send, and a render failure blocks the send. false → send the text only.
   */
  attachPdf: z.boolean().default(true),
});

/** Save a human-edited PPD (and/or email copy) back onto the proposal. */
export const editProposalSchema = z
  .object({
    ppd: z.unknown().optional(),
    emailSubject: z.string().trim().min(1).max(300).optional(),
    emailContent: z.string().trim().min(1).max(50_000).optional(),
    /** Explicit review marker; sending a `ppd` sets it automatically. */
    reviewed: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

/** A brand-new draft that skips ChatGPT entirely (write it yourself). */
export const manualDraftSchema = z.object({
  toEmail: recipientEmail,
  cc: ccList.optional(),
  subject: z.string().trim().min(1).max(300),
  bodyText: z.string().trim().min(1).max(50_000),
  proposalId: z.string().uuid().nullish(),
  senderAccountId: z.string().uuid().nullish(),
});

export const savePromptSchema = z.object({
  key: z.enum(["ppd_document", "email_draft", "follow_up"]),
  label: z.string().trim().max(80).optional(),
  systemText: z.string().trim().min(10).max(20_000),
  userTemplate: z.string().trim().min(10).max(60_000),
  temperature: z.coerce.number().min(0).max(2).default(0.45),
  maxTokens: z.coerce.number().int().min(512).max(65_536).nullish(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high"]).nullish(),
  note: z.string().trim().max(500).nullish(),
});

/**
 * DELETE /api/leads — permanent, irreversible removal of jobs.
 * `ids` (not a filter) on purpose: a typo in a query must never bulk-delete.
 */
export const deleteLeadsSchema = z.object({
  ids: z
    .array(z.string().uuid("every id must be a full lead uuid"))
    .min(1, "pick at least one lead")
    .max(100, "remove at most 100 leads per call")
    .transform((ids) => [...new Set(ids)]),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
export type CreateSenderAccountInput = z.infer<typeof createSenderAccountSchema>;
export type UpdateSenderAccountInput = z.infer<typeof updateSenderAccountSchema>;
export type EditDraftInput = z.infer<typeof editDraftSchema>;
export type GenerateProposalInput = z.infer<typeof generateProposalSchema>;
export type GenerateEmailInput = z.infer<typeof generateEmailSchema>;
export type EditProposalInput = z.infer<typeof editProposalSchema>;
export type ManualDraftInput = z.infer<typeof manualDraftSchema>;
export type SavePromptInput = z.infer<typeof savePromptSchema>;
export type CreateChatGptJobInput = z.infer<typeof createChatGptJobSchema>;
export type CompleteChatGptJobInput = z.infer<typeof completeChatGptJobSchema>;
export type DeleteLeadsInput = z.infer<typeof deleteLeadsSchema>;
