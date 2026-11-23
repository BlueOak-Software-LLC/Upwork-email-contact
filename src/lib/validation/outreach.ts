import { z } from "zod";
import { LEAD_STATUSES } from "@/types/lead";

export const leadStatusSchema = z.enum(LEAD_STATUSES);

export const listLeadsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: leadStatusSchema.optional(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW", "UNIDENTIFIED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z
    .enum(["received_at", "updated_at", "job_title", "status", "overall_confidence"])
    .default("received_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/** Only the human-editable columns; the payload itself is immutable. */
export const updateLeadSchema = z
  .object({
    status: leadStatusSchema,
    job_description: z.string().trim().max(200_000).nullable().optional(),
    error: z.string().trim().max(900).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const ingestOptionsSchema = z.object({
  auto: z.enum(["true", "false"]).optional(),
  dry: z.enum(["true", "false"]).optional(),
  regenerate: z.enum(["true", "false"]).optional(),
  senderAccountId: z.string().uuid().optional(),
});

export const generateProposalSchema = z.object({
  /** Which contact to write for; defaults to the lead's primary email. */
  contactId: z.string().uuid().optional(),
  regenerate: z.boolean().default(true),
  createDraft: z.boolean().default(true),
  senderAccountId: z.string().uuid().optional(),
  /**
   * Override `GROQ_MODEL` for this one call — handy when Groq retires a model
   * and you want to test a replacement before changing the environment.
   */
  model: z.string().trim().min(1).max(120).optional(),
});

export const smtpPort = z.coerce.number().int().min(1).max(65535);

export const createSenderAccountSchema = z.object({
  label: z.string().trim().min(1).max(80),
  fromEmail: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().max(120).nullish(),
  replyTo: z.string().trim().toLowerCase().email().max(320).nullish(),
  signature: z.string().trim().max(2000).nullish(),
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
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const editDraftSchema = z
  .object({
    subject: z.string().trim().min(1).max(300).optional(),
    bodyText: z.string().trim().min(1).max(50_000).optional(),
    senderAccountId: z.string().uuid().nullable().optional(),
    status: z.enum(["draft", "queued", "cancelled"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const sendDraftSchema = z.object({
  senderAccountId: z.string().uuid().optional(),
});

export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
export type CreateSenderAccountInput = z.infer<typeof createSenderAccountSchema>;
export type UpdateSenderAccountInput = z.infer<typeof updateSenderAccountSchema>;
export type EditDraftInput = z.infer<typeof editDraftSchema>;
export type GenerateProposalInput = z.infer<typeof generateProposalSchema>;
