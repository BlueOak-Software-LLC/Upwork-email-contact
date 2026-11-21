import { z } from "zod";

export const sendEmailSchema = z
  .object({
    to: z.union([
      z.string().trim().toLowerCase().email().max(320),
      z
        .array(z.string().trim().toLowerCase().email().max(320))
        .min(1)
        .max(20),
    ]),
    cc: z
      .array(z.string().trim().toLowerCase().email().max(320))
      .max(10)
      .optional(),
    subject: z.string().trim().min(1).max(300),
    text: z.string().trim().min(1).max(50_000).optional(),
    html: z.string().trim().min(1).max(120_000).optional(),
    replyTo: z.string().trim().email().max(320).optional(),
    /** When set, we look the contact up and stamp last_contacted_at. */
    contactId: z.string().uuid().optional(),
    updateContact: z.boolean().default(true),
    /** Skip writing the row to `email_logs` (used by tests/imports). */
    skipLog: z.boolean().default(false),
    headers: z.record(z.string(), z.string().max(500)).optional(),
  })
  .refine((v) => Boolean(v.text || v.html), {
    message: "Provide `text` and/or `html`",
    path: ["text"],
  });

/** Convenience template path: send a canned outreach note to a contact id. */
export const outreachEmailSchema = z.object({
  contactId: z.string().uuid(),
  subject: z.string().trim().min(1).max(300).optional(),
  text: z.string().trim().min(1).max(20_000),
});

export type SendEmailPayload = z.infer<typeof sendEmailSchema>;
export type OutreachPayload = z.infer<typeof outreachEmailSchema>;
