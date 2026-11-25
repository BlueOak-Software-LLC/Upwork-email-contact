import { z } from "zod";
import { CONTACT_STATUSES } from "@/types/domain";

export const contactStatusSchema = z.enum(CONTACT_STATUSES);

const trimmed = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max);

export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : (v ?? null)));

export const createContactSchema = z.object({
  name: trimmed(1, 160),
  email: z.string().trim().toLowerCase().email().max(320),
  company: nullableText(200),
  role: nullableText(160),
  status: contactStatusSchema.default("new"),
  source: trimmed(1, 60).default("manual"),
  tags: z.array(trimmed(1, 40)).max(25).default([]),
  notes: nullableText(4000),
});

export const updateContactSchema = createContactSchema
  .partial()
  // As with sender PATCH, `.partial()` would re-apply create-time defaults and
  // silently reset status/source/tags when only one field is edited.
  .extend({
    status: contactStatusSchema.optional(),
    source: trimmed(1, 60).optional(),
    tags: z.array(trimmed(1, 40)).max(25).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });

export const listContactsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: contactStatusSchema.optional(),
  source: z.string().trim().max(60).optional(),
  tag: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z
    .enum(["created_at", "updated_at", "name", "email", "status", "last_contacted_at"])
    .default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const bulkIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
