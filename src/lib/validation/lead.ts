import { createHash } from "node:crypto";
import type {
  ChannelKind,
  ContactList,
  JsonRecord,
  LeadConfidence,
  LeadContactInformation,
  LeadContactItem,
  LeadKeyPerson,
  NormalizedContact,
  NormalizedLead,
} from "@/types/lead";
import { LEAD_CONFIDENCES } from "@/types/lead";

/**
 * The scraper payload is parsed loosely on purpose: every field may be null,
 * missing, numeric, or spelled differently. We normalise into typed rows and
 * still keep the untouched JSON in `leads.raw_payload`.
 */

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-zA-Z]{2,}$/;
const PHONE_RE = /^\+?[\d][\d\s().\-ext]{6,20}$/i;
const URL_RE = /^https?:\/\/\S+$/i;
const GENERIC_MAILBOX = /^(info|contact|hello|support|admin|sales|marketing|enquir|enquiry|enquiries|service|office)@/i;

const CONTACT_LIST_KEYS: ReadonlyArray<[keyof LeadContactInformation, ContactList]> = [
  ["verified_contacts", "verified"],
  ["potential_contacts", "potential"],
  ["company_contact_pages", "company_page"],
  ["linkedin_profiles", "linkedin"],
  ["social_media_profiles", "social"],
];

const RANK: Record<LeadConfidence, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  UNIDENTIFIED: 3,
};

export const str = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

export const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

export const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord => Boolean(item) && typeof item === "object",
      )
    : [];

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => str(v)).filter((v): v is string => Boolean(v));
  const single = str(value);
  return single ? [single] : [];
};

/**
 * Free text out of whatever the scraper sent for it: a string, a number, an
 * array of paragraph strings, or an array of `{ text }` blocks. Paragraphs are
 * joined with a blank line so the prompt keeps its shape.
 */
export function textBlock(value: unknown): string | null {
  const single = str(value);
  if (single) return single;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) =>
        typeof item === "object" && item !== null
          ? str((item as JsonRecord).text ?? (item as JsonRecord).value ?? (item as JsonRecord).content)
          : str(item),
      )
      .filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n\n") : null;
  }
  return null;
}

export function confidenceOf(value: unknown): LeadConfidence {
  const raw = (str(value) ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return (LEAD_CONFIDENCES as readonly string[]).includes(raw)
    ? (raw as LeadConfidence)
    : "UNIDENTIFIED";
}

export function isEmailLike(value: string | null | undefined): boolean {
  return Boolean(value && EMAIL_RE.test(value.trim().replace(/^mailto:/i, "")));
}

/** The payload's free-text `contact_type`/`type` label plus the value decide the channel. */
export function channelOf(label: string | null, value: string | null): ChannelKind {
  const l = (label ?? "").toLowerCase();
  const v = (value ?? "").trim();
  const bareEmail = v.replace(/^mailto:/i, "");

  if (l.includes("email") || l.includes("mail") || isEmailLike(bareEmail)) return "email";
  if (l.includes("phone") || l.includes("mobile") || l.includes("tel") || l.includes("whatsapp"))
    return "phone";
  if (l.includes("linkedin") || l.includes("twitter") || l.includes("instagram") || l.includes("facebook"))
    return "url";
  if (
    l.includes("url") ||
    l.includes("website") ||
    l.includes("site") ||
    l.includes("page") ||
    l.includes("profile") ||
    l.includes("booking") ||
    l.includes("link") ||
    URL_RE.test(v)
  )
    return "url";
  if (PHONE_RE.test(v)) return "phone";
  return "other";
}

export function normalizeValue(channel: ChannelKind, value: string): string | null {
  const v = value.trim();
  switch (channel) {
    case "email":
      return v.replace(/^mailto:/i, "").toLowerCase() || null;
    case "phone":
      return v.replace(/[^\d+]/g, "") || null;
    case "url":
      return v.replace(/\s+/g, "").toLowerCase() || null;
    default:
      return v.toLowerCase() || null;
  }
}

function itemToContact(item: JsonRecord, listType: ContactList): NormalizedContact | null {
  const contactValue =
    str(item.contact_value) ?? str(item.email) ?? str(item.url) ?? str(item.value);
  if (!contactValue) return null;

  const label = str(item.contact_type) ?? str(item.type);
  const channel = channelOf(label, contactValue);

  return {
    listType,
    name: str(item.name) ?? str(item.full_name),
    role: str(item.role) ?? str(item.title),
    company: str(item.company) ?? str(item.organization),
    contactType: label,
    channel,
    contactValue,
    normalizedValue: normalizeValue(channel, contactValue),
    confidence: item.confidence === undefined ? null : confidenceOf(item.confidence),
    rationale: str(item.notes) ?? str(item.reason) ?? str(item.evidence),
    sourceUrl: str(item.source_url) ?? str(item.sourceUrl),
    isEmail: channel === "email" && isEmailLike(contactValue),
    isPrimary: false,
  };
}

function keyPersonToContact(person: JsonRecord): NormalizedContact | null {
  const linkedin = str(person.linkedin_url) ?? str(person.linkedin);
  const email = str(person.email);
  const value = email ?? linkedin;
  if (!value) return null;

  const channel = channelOf(email ? "email" : "linkedin", value);
  const urls = stringArray(person.source_urls);

  return {
    listType: "key_person",
    name: str(person.name),
    role: str(person.role),
    company: null,
    contactType: email ? "Email" : "LinkedIn profile",
    channel,
    contactValue: value,
    normalizedValue: normalizeValue(channel, value),
    confidence: person.confidence === undefined ? null : confidenceOf(person.confidence),
    rationale: str(person.evidence),
    sourceUrl: str(person.source_url) ?? urls[0] ?? null,
    isEmail: channel === "email" && isEmailLike(value),
    isPrimary: false,
  };
}

function keyPerson(item: JsonRecord): LeadKeyPerson {
  return {
    name: str(item.name),
    role: str(item.role),
    location: str(item.location),
    confidence: str(item.confidence),
    linkedin_url: str(item.linkedin_url),
    evidence: str(item.evidence),
    source_urls: stringArray(item.source_urls),
  };
}

function emptyContactInformation(): LeadContactInformation {
  return {
    verified_contacts: [],
    potential_contacts: [],
    company_contact_pages: [],
    linkedin_profiles: [],
    social_media_profiles: [],
  };
}

export function normalizeLeadPayload(input: unknown): NormalizedLead {
  const raw = record(input);
  const job = record(raw.job_information);
  const client = record(raw.upwork_client);
  const contactInformationRaw = record(raw.contact_information);
  const keyPeopleRaw = records(raw.key_people);

  const contactInformation = emptyContactInformation();
  for (const [key] of CONTACT_LIST_KEYS) {
    contactInformation[key] = records(contactInformationRaw[key]) as unknown as LeadContactItem[];
  }

  const contacts: NormalizedContact[] = [];
  for (const [key, listType] of CONTACT_LIST_KEYS) {
    for (const item of records(contactInformationRaw[key])) {
      const normalized = itemToContact(item, listType);
      if (normalized) contacts.push(normalized);
    }
  }
  for (const person of keyPeopleRaw) {
    const normalized = keyPersonToContact(person);
    if (normalized) contacts.push(normalized);
  }

  const deduped = dedupeContacts(contacts);
  const primary = pickPrimaryEmail(deduped);
  if (primary) primary.isPrimary = true;

  const jobId = str(job.job_id);
  const jobUrl = str(job.job_url);
  const jobTitle = str(job.job_title);
  const clientName = str(client.client_name);
  const jobDescription = str(raw.job_description) ?? str(job.job_description);
  const companyMentioned = str(job.company_mentioned);
  const industry = str(job.industry);

  return {
    dedupeKey: computeDedupeKey({
      jobId,
      jobUrl,
      jobTitle,
      clientName,
      jobDescription,
      companyMentioned,
      industry,
    }),
    jobId,
    jobTitle,
    jobUrl,
    jobLocation: str(job.job_location),
    industry,
    companyMentioned,
    clientName,
    clientLocation: str(client.location),
    jobDescription,
    overallConfidence: confidenceOf(raw.overall_confidence ?? job.overall_confidence),
    keyPeople: keyPeopleRaw.map(keyPerson),
    contactInformation,
    rawPayload: raw,
    contacts: deduped,
    primaryEmail: primary,
  };
}

/**
 * Which row a payload belongs to.
 *
 * `job_id` is the only stable Upwork key, then the URL, then title+client.
 * A payload can carry **none of those** (the scraper sometimes only has the
 * description), so the last resort hashes the description itself — hashing the
 * empty string instead would collapse every such post into one lead and let a
 * later payload silently overwrite an earlier one.
 */
export function computeDedupeKey(parts: {
  jobId: string | null;
  jobUrl: string | null;
  jobTitle: string | null;
  clientName: string | null;
  jobDescription: string | null;
  companyMentioned?: string | null;
  industry?: string | null;
}): string {
  const { jobId, jobUrl, jobTitle, clientName, jobDescription, companyMentioned, industry } = parts;
  if (jobId) return jobId;
  if (jobUrl) return sha1(jobUrl.toLowerCase());
  if (jobTitle || clientName) {
    return sha1(`${(jobTitle ?? "").toLowerCase()}|${(clientName ?? "").toLowerCase()}`);
  }
  const body = (jobDescription ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!body) {
    // Nothing identifying at all: keep each blank payload separate rather than
    // merging unrelated leads on one row.
    return sha1(`blank:${Date.now()}:${Math.random()}`);
  }
  return sha1(
    `desc:${body}|co:${(companyMentioned ?? "").toLowerCase()}|ind:${(industry ?? "").toLowerCase()}`,
  );
}

function dedupeContacts(contacts: NormalizedContact[]): NormalizedContact[] {
  const seen = new Map<string, NormalizedContact>();
  for (const contact of contacts) {
    const key = [
      contact.listType,
      contact.channel,
      (contact.normalizedValue ?? contact.contactValue).toLowerCase(),
    ].join(":");

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, contact);
      continue;
    }
    if (richness(contact) > richness(existing)) {
      seen.set(key, { ...contact, isPrimary: existing.isPrimary || contact.isPrimary });
    }
  }
  return [...seen.values()];
}

function richness(c: NormalizedContact): number {
  const confidence = c.confidence ?? "UNIDENTIFIED";
  return (
    (3 - RANK[confidence]) * 10 +
    (c.name ? 1 : 0) +
    (c.role ? 1 : 0) +
    (c.company ? 1 : 0) +
    (c.rationale ? 1 : 0) +
    (c.sourceUrl ? 1 : 0)
  );
}

/**
 * Recipients come only from `verified_contacts` / `potential_contacts`
 * (plus an email on a key person, which outranks a generic mailbox).
 */
export function emailRecipients(contacts: NormalizedContact[]): NormalizedContact[] {
  return contacts
    .filter((c) => c.isEmail && ["verified", "potential", "key_person"].includes(c.listType))
    .sort((a, b) => scoreRecipient(b) - scoreRecipient(a));
}

function pickPrimaryEmail(contacts: NormalizedContact[]): NormalizedContact | null {
  const recipients = emailRecipients(contacts);
  return recipients[0] ?? contacts.find((c) => c.isEmail) ?? null;
}

function scoreRecipient(c: NormalizedContact): number {
  const listBonus =
    c.listType === "verified" ? 100 : c.listType === "key_person" ? 60 : c.listType === "potential" ? 40 : 0;
  const confidence = c.confidence ?? "UNIDENTIFIED";
  const confBonus = { HIGH: 30, MEDIUM: 15, LOW: 5, UNIDENTIFIED: 0 }[confidence];
  const genericPenalty = GENERIC_MAILBOX.test(c.normalizedValue ?? "") ? -20 : 0;
  return listBonus + confBonus + genericPenalty + (c.name ? 3 : 0);
}

function sha1(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 40);
}

/** Route guard: accepts one payload object or an array of them. */
export function parseLeadPayloads(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    if (body.length === 0) throw new Error("Empty array");
    if (body.length > 50) throw new Error("Post at most 50 leads per request");
    return body;
  }
  if (body && typeof body === "object") return [body];
  throw new Error("Body must be a lead object or an array of lead objects");
}
