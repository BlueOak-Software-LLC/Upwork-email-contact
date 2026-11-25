import { brandConfig } from "@/lib/env-extras";
import { ApiError } from "@/server/http/errors";
import { leadsRepo } from "@/server/db/leads.repo";
import { sanitizePpd } from "@/server/services/proposal-sanitize";
import type { ProposalBrand } from "@/server/services/prompts/proposal.prompt";
import type {
  LeadContactRow,
  LeadRow,
  NormalizedContact,
  NormalizedLead,
  ProposalPpd,
} from "@/types/lead";

/**
 * Shared proposal helpers. Generation itself lives in `chatgpt.service.ts`:
 * a signed-in ChatGPT tab writes the answer, never a server-side model API.
 */

/**
 * Shared recipient resolution: an existing contact by id, the lead's primary
 * email, or a custom address typed by a human (persisted as a manual contact so
 * the lead page still shows where the send went).
 */
export async function resolveRecipientContact(
  leadId: string,
  input: {
    contactId?: string | null;
    toEmail?: string | null;
    /**
     * The PPD step may run with no recipient at all (a document written from the
     * post itself, before the scraper has an address). The email step always
     * needs one, since a draft cannot be addressed to nobody.
     */
    requireRecipient?: boolean;
  },
): Promise<{
  contact: LeadContactRow | null;
  source: "lead_contact" | "custom" | "none";
}> {
  const contacts = await leadsRepo.contacts(leadId);
  if (input.contactId) {
    const found = contacts.find((c) => c.id === input.contactId);
    if (!found) throw ApiError.notFound(`Contact ${input.contactId} is not on this lead`);
    if (!found.is_email) throw ApiError.badRequest(`${found.contact_value} is not an email address`);
    return { contact: found, source: "lead_contact" };
  }

  if (input.toEmail) {
    const wanted = input.toEmail.trim().toLowerCase();
    const match = contacts.find(
      (c) => (c.normalized_value ?? c.contact_value).toLowerCase() === wanted,
    );
    if (match) return { contact: match, source: "lead_contact" };
    const { row } = await leadsRepo.upsertManualContact(leadId, wanted);
    return { contact: row, source: "custom" };
  }

  const primary =
    contacts.find((c) => c.is_email && c.is_primary) ?? contacts.find((c) => c.is_email);
  if (!primary) {
    if (input.requireRecipient === false) return { contact: null, source: "none" };
    throw ApiError.badRequest(
      "No recipient: this lead has no email contact and none was typed in",
    );
  }
  return { contact: primary, source: "lead_contact" };
}

/**
 * Re-validate a human-edited PPD before storing it.
 *
 * Prose is normalised and clipped. Identity is never taken from the edited
 * JSON: it is copied from the document that was generated, which already holds
 * the selected sender profile. An old document missing a profile field falls
 * back to the env identity once, then upgrades on the next generation.
 */
export function sanitizeEditedPpd(ppd: unknown, base: ProposalPpd): ProposalPpd {
  const fallback = brandConfig();
  const identity = {
    preparedBy: base.prepared_by || fallback.preparedBy,
    preparedRole: base.prepared_role || fallback.title,
    senderEmail: base.sender_email || fallback.senderEmail,
    senderPhone: base.sender_phone || "",
    senderWhatsapp: base.sender_whatsapp || "",
    senderLinkedin: base.sender_linkedin || "",
    website: base.sender_website || fallback.website,
    senderLocation: base.sender_location || "",
    date: base.date || formatDate(new Date().toISOString().slice(0, 10)),
    validUntil: base.valid_until || "",
  };
  const sanitized = sanitizePpd({ ppd }, {
    ...identity,
    // Legacy fields, kept for the sanitizer contract; nothing prints a company.
    company: "",
    rate: base.rate || fallback.rate || "",
    jobTitle: base.job_title || null,
    jobReference: base.job_reference || null,
    recipientName: base.prepared_for,
    recipientCompany: null,
    clientName: null,
    today: new Date().toISOString().slice(0, 10),
    verifiedReferences: [],
  });

  return {
    ...sanitized,
    ...identity,
    job_title: base.job_title,
    job_reference: base.job_reference,
    engagement: base.engagement,
    rate: base.rate || sanitized.rate,
  };
}

export function ppdContext(
  brand: ProposalBrand,
  lead: LeadRow,
  contact: LeadContactRow | null,
  today: string,
) {
  return {
    company: "",
    website: brand.website,
    preparedBy: brand.preparedBy,
    preparedRole: brand.title,
    senderEmail: brand.senderEmail,
    senderPhone: brand.phone,
    senderWhatsapp: brand.whatsapp,
    senderLinkedin: brand.linkedin,
    senderLocation: brand.location,
    date: formatDate(today),
    validUntil: formatDate(addDays(today, 14)),
    rate: brand.rate,
    jobTitle: lead.job_title,
    jobReference: lead.job_id,
    // A recipient-less post is addressed to the hiring team in general.
    recipientName: contact?.name ?? null,
    recipientCompany: contact?.company ?? lead.company_mentioned ?? null,
    clientName: lead.client_name,
    today,
    // We hold no vetted case studies, so any reference the model returns is
    // discarded rather than printed. Extend this from a future references table.
    verifiedReferences: [],
  };
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 2026-11-25 → 25 November 2026, matching the PDF header. */
function formatDate(iso: string) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * The prompt wants the fully normalised payload; we stored it as JSONB, so
 * rebuild the minimum fields the prompt uses rather than re-parsing.
 */
export function rehydrateNormalizedLead(
  lead: LeadRow,
  contacts: LeadContactRow[] = [],
): NormalizedLead {
  const raw = (lead.raw_payload ?? {}) as Record<string, unknown>;
  return {
    dedupeKey: lead.dedupe_key,
    jobId: lead.job_id,
    jobTitle: lead.job_title,
    jobUrl: lead.job_url,
    jobLocation: lead.job_location,
    industry: lead.industry,
    companyMentioned: lead.company_mentioned,
    clientName: lead.client_name,
    clientLocation: lead.client_location,
    jobDescription: lead.job_description,
    overallConfidence: lead.overall_confidence,
    keyPeople: (Array.isArray(lead.key_people)
      ? lead.key_people
      : []) as unknown as NormalizedLead["keyPeople"],
    contactInformation: (lead.contact_information ??
      {}) as unknown as NormalizedLead["contactInformation"],
    rawPayload: raw as NormalizedLead["rawPayload"],
    contacts: contacts.map(toNormalizedContact),
    primaryEmail: (() => {
      const primary =
        contacts.find((c) => c.is_email && c.is_primary) ?? contacts.find((c) => c.is_email);
      return primary ? toNormalizedContact(primary) : null;
    })(),
  };
}

export function toNormalizedContact(contact: LeadContactRow): NormalizedContact {
  return {
    listType: contact.list_type,
    name: contact.name,
    role: contact.role,
    company: contact.company,
    contactType: contact.contact_type,
    channel: contact.channel,
    contactValue: contact.contact_value,
    normalizedValue: contact.normalized_value,
    confidence: contact.confidence,
    rationale: contact.rationale,
    sourceUrl: contact.source_url,
    isEmail: contact.is_email,
    isPrimary: contact.is_primary,
  };
}

export type { ProposalBrand };
