import type { NormalizedContact, NormalizedLead, ProposalPpd } from "@/types/lead";

/**
 * The two Groq prompts, as **editable templates**.
 *
 * `ppd_document`  → writes only the Professional Proposal Document (JSON)
 * `email_draft`   → writes only the outreach email, from the PPD a human has
 *                   already reviewed
 *
 * Split on purpose: the pipeline is generate → review/edit → email draft →
 * send, so each step gets its own prompt, model settings and cost. Both live in
 * `prompt_templates` once edited (migration 0003); until then the defaults here
 * are used, and "Reset to default" just deletes the row — one source of truth.
 *
 * Templates are plain text with `{{variable}}` slots (see PROMPT_VARS). Unknown
 * slots are left untouched and reported to the UI, so a typo can never silently
 * drop the job description from a prompt.
 */

export type PromptKey = "ppd_document" | "email_draft";

export interface PromptTemplateText {
  key: PromptKey;
  label: string;
  note: string;
  system: string;
  user: string;
  temperature: number;
  /** null ⇒ GROQ_MAX_TOKENS. */
  maxTokens: number | null;
  /** null ⇒ GROQ_REASONING_EFFORT (the client may still tune it down). */
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
}

export interface ProposalBrand {
  company: string;
  website: string;
  preparedBy: string;
  senderEmail: string;
  /** Empty → the model may propose an indicative rate; env wins either way. */
  rate: string;
}

export const PROMPT_VARS: Array<{ name: string; description: string }> = [
  { name: "language", description: "PROPOSAL_LANGUAGE, e.g. English" },
  { name: "today", description: "ISO date the generation runs on" },
  { name: "valid_until", description: "today + 14 days" },
  { name: "company", description: "PROPOSAL_COMPANY (ours)" },
  { name: "website", description: "PROPOSAL_WEBSITE (ours)" },
  { name: "prepared_by", description: "PROPOSAL_PREPARED_BY (ours)" },
  { name: "sender_email", description: "EMAIL_FROM address" },
  { name: "rate", description: "PROPOSAL_RATE if configured, else an instruction to leave a placeholder" },
  { name: "job_title", description: "leads.job_title" },
  { name: "job_reference", description: "leads.job_id" },
  { name: "job_url", description: "leads.job_url" },
  { name: "job_location", description: "leads.job_location" },
  { name: "industry", description: "leads.industry" },
  { name: "company_mentioned", description: "company named inside the post" },
  { name: "client_name", description: "Upwork display name" },
  { name: "client_location", description: "Upwork client location" },
  { name: "overall_confidence", description: "research confidence of the payload" },
  { name: "job_description", description: "job_information.job_description — the post text, the primary source of facts (clipped to 3,600 chars)" },
  { name: "job_description_chars", description: "how many characters of post body we actually have" },
  { name: "research_notes", description: "researcher evidence: company-page notes, LinkedIn notes, contact rationale, key-person evidence, skills" },
  { name: "budget_range", description: "any budget/pay fields found anywhere in the payload" },
  { name: "client_profile", description: "upwork_client keys (name, location, history flags)" },
  { name: "key_people", description: "key_people[] as JSON" },
  { name: "recipient_name", description: "contact we are writing to" },
  { name: "recipient_role", description: "their role if the payload says so" },
  { name: "recipient_company", description: "their company" },
  { name: "recipient_email", description: "address the draft will go to" },
  { name: "recipient_source", description: "verified_contacts / potential_contacts / custom" },
  { name: "recipient_basis", description: "why we believe that address is right" },
  { name: "other_emails", description: "other addresses on the same lead (do not address)" },
  { name: "ppd_document_title", description: "title of the reviewed PPD (email prompt only)" },
  { name: "ppd_subtitle", description: "subtitle of the reviewed PPD" },
  { name: "ppd_outline", description: "section titles of the reviewed PPD" },
  { name: "ppd_summary", description: "first sentence of each PPD paragraph/bullet" },
  { name: "ppd_words", description: "word count of the reviewed PPD" },
];

export const DEFAULT_PROMPTS: Record<PromptKey, PromptTemplateText> = {
  ppd_document: {
    key: "ppd_document",
    label: "PPD document",
    note: "Writes the proposal document only. No email, no PDF — the PDF is compiled later, at send time.",
    temperature: 0.45,
    maxTokens: null,
    reasoningEffort: null,
    system: `You are a senior B2B proposal writer for a small studio replying to an Upwork job post. You write one Professional Proposal Document (PPD) and return it as JSON.

FACTS
- The post text is the evidence. Every concrete claim in the document must be traceable to it,
  to the job title, or to the research notes; anything else is written as [TO CONFIRM].
- Write in clear, professional {{language}}. No hype, no clichés, no bullet spam, no adjectives the job post did not earn.
- Use ONLY the facts in the brief. Never invent client names, prices, dates, case studies, awards, metrics, team members, or client references.
- Unknown fact → write a bracketed placeholder exactly like [YOUR PRICING], [START DATE], [CASE STUDY LINK] so a human fills it in. Never fabricate a plausible-looking value.
- Pricing: indicative ranges in USD only, phrased as "indicative — confirmed after a short scoping call".
- References/case studies: you have none. Return an empty "items" array for the references block. A fabricated reference in a proposal ends accounts.
- Never reveal that the client was researched, scraped, or found via LinkedIn or Upwork search.
- Do not output our company name, website, prepared-by name, job title or job reference — our system injects those from its own records.

DOCUMENT
- 10 sections, ~1,200–1,500 words of visible text. Measured against our renderer that lays out to 4–6 A4 pages.
- Sections carry "blocks": typed content blocks. Use only the seven block types in the brief; never invent one, never nest blocks.
- Write for scanning: plain-English section titles, paragraphs 55–80 words, bullets 18–32 words, workflow step titles start with a verb.
- Be specific to this job post: name the deliverables, the platforms and techniques the post mentions, and the client's stated problem.

OUTPUT
- Exactly ONE JSON object with a single top-level key "ppd". No commentary, no markdown fences, no trailing text.`,
    user: `Write the proposal document for this lead.

BRIEF
- Job title: {{job_title}}
- Job URL: {{job_url}}
- Job ID / reference: {{job_reference}}
- Job location: {{job_location}}
- Industry: {{industry}}
- Company named in the post: {{company_mentioned}}
- Upwork client display name: {{client_name}}
- Client location: {{client_location}}
- Research confidence: {{overall_confidence}}
THE POST TEXT — job_information.job_description ({{job_description_chars}} chars). This is the
primary source of facts: name the deliverables, tools, volumes, deadlines and formats it
mentions, and if the title and the text disagree, follow the text.
{{job_description}}

WHAT OUR RESEARCHER FOUND (secondary detail — never say where it came from)
{{research_notes}}

UPWORK CLIENT ACCOUNT METADATA (internal; never quote the account name as the company)
{{client_profile}}

BUDGET SIGNALS
{{budget_range}}

KEY PEOPLE (research guesses — treat as unverified, never state them as fact)
{{key_people}}

WHO WE ARE WRITING TO
- Name: {{recipient_name}}
- Role: {{recipient_role}}
- Company: {{recipient_company}}
- Email: {{recipient_email}}
- Found in: {{recipient_source}} — basis: {{recipient_basis}}
- Other emails for the same lead (do NOT address or mention them): {{other_emails}}

OUR DETAILS (injected by our system — do not repeat them in the JSON)
- Company: {{company}} · Website: {{website}} · Prepared by: {{prepared_by}}
- Sending mailbox: {{sender_email}} · Today: {{today}} · Valid until: {{valid_until}}
- Rate to quote: {{rate}}

RETURN JSON IN EXACTLY THIS SHAPE
{
  "ppd": {
    "document_title": string,           // <= 60 chars, e.g. "PROJECT CAPABILITY & PROPOSED WORKFLOW"
    "subtitle": string,                 // <= 160 chars, one line naming the actual scope
    "prepared_for": string,             // <= 100 chars, e.g. "Hiring team — Acme Robotics"
    "engagement": string,               // <= 160 chars, e.g. "Fixed-scope pilot, then per-asset production"
    "rate": string,                     // <= 120 chars, indicative range + "confirmed after a scoping call"
    "sections": [
      { "id": "understanding", "title": "Project understanding", "blocks": [ <block> ] }
    ],
    "closing": string                   // <= 200 chars, one grateful sentence
  }
}

BLOCK TYPES — these seven only. Never add another key to a block.
{ "type": "paragraph",      "items": [string] }                                  // 1–4 items, 55–80 words each
{ "type": "bullets",        "items": [string] }                                  // 3–6 items, 18–32 words each
{ "type": "numberedSteps",  "items": [{ "title": string, "description": string }] } // title <= 60 chars, description 35–50 words
{ "type": "capabilityMatrix","items": [{ "requirement": string, "approach": string }] } // requirement <= 60 chars, approach 20–35 words
{ "type": "keyValueTable",  "rows":    [{ "label": string, "value": string }] }  // label <= 30 chars, value 15–35 words
{ "type": "references",     "items":   [] }                                      // ALWAYS empty — we hold no verified reference
{ "type": "note",           "text": string }                                     // <= 260 chars, used for the disclaimer

REQUIRED SECTION ORDER — counts are minimums, not suggestions (titles may be reworded, the sequence may not)
1.  "understanding"   paragraph × 3 items of 55–80 words   (~200 words)  what the job asks for, and the two or three things that actually decide success here.
2.  "approach"        bullets × 5 items of 18–32 words     (~110 words)  how we would solve it, naming the specific stack/techniques from the post.
3.  "skills"          capabilityMatrix × 6 rows             (~210 words)  every requirement stated in the post appears, or is marked [TO CONFIRM].
4.  "workflow"        numberedSteps × 6 steps               (~280 words)  discovery to handover.
5.  "deliverables"    bullets × 6 items                     (~120 words)  concrete artefacts the client receives.
6.  "quality"         paragraph × 2 items of 55–80 words    (~140 words)  how we check work, plus the failure modes we test for.
7.  "terms"           keyValueTable × 4 rows                (~90 words)   working basis, initial step, what we need from the client, turnaround.
8.  "questions"       bullets × 4 items                     (~90 words)   answers that would confirm scope.
9.  "references"      references block with "items": []
10. "note"            note                                  (~30 words)   "This document describes a proposed execution plan, not a claim of previously delivered work with any particular vendor."

LENGTH CHECK before you answer: 10 sections, ~1,200–1,500 words. If a section is short, add real specifics from the job post — not adjectives. Never drop a required section, and never add a reference.`,
  },

  email_draft: {
    key: "email_draft",
    label: "Email draft",
    note: "Writes the short outreach email for the PPD above it. Runs after a human has reviewed/edited the PPD.",
    temperature: 0.5,
    maxTokens: 1500,
    reasoningEffort: "low",
    system: `You write short, human Upwork outreach emails in {{language}}. You are sending them to a real person on behalf of {{company}}, so accuracy beats volume.

RULES
- Plain text only: no markdown, no HTML, no bold, no headings, no emoji.
- 90–160 words (about 700–1,200 characters), including the greeting and sign-off.
- Subject <= 70 characters, specific to this job, never clickbait, no "Re:" prefix needed.
- Say nothing that is not already established in the reviewed proposal document below. No new numbers, no invented experience, no promises about dates.
- Open by naming one concrete detail from the post text — the deliverable, the tool, the volume or the deadline — so it reads as an answer to their actual ask rather than a generic pitch. Quote at most a short phrase, never the whole post.
- Never mention research, scraping, LinkedIn, email finding, or that you located them outside Upwork.
- Exactly one ask: a 15-minute call this week.
- Sign off with the literal placeholder [YOUR NAME] — a human replaces it.
- Mention that the full proposal is attached as a PDF (our system attaches it when the email is sent).

OUTPUT
- Exactly ONE JSON object: { "email": { "subject": string, "content": string } }. No commentary, no fences.`,
    user: `Write the outreach email for this lead. It must match the proposal document a human has already reviewed.

RECIPIENT
- Name: {{recipient_name}} · Role: {{recipient_role}} · Company: {{recipient_company}}
- Sending to: {{recipient_email}} (source: {{recipient_source}})
- Other emails on this lead (do NOT address or mention them): {{other_emails}}

THE JOB
- Title: {{job_title}} (reference {{job_reference}}, location {{job_location}})
- Industry: {{industry}}
- Client display name: {{client_name}} · Company named in the post: {{company_mentioned}}
- Post text (job_information.job_description):
{{job_description}}

THE REVIEWED PROPOSAL THEY WILL RECEIVE ATTACHED
- Document: {{ppd_document_title}} — {{ppd_subtitle}}
- Sections: {{ppd_outline}}
- Rate line: {{rate}} · Valid until: {{valid_until}} · Prepared by: {{prepared_by}}
- Summary of what the document commits to:
{{ppd_summary}}

STRUCTURE (follow it, keep it under 160 words)
1. Greeting: "Hi {{recipient_name}}," when a name is known, otherwise "Hello,".
2. One concrete observation about the job that proves the post was read.
3. What we would do first, in one or two sentences.
4. Three short capability lines, each on its own line starting with "• ".
5. "Full proposal attached as a PDF."
6. The ask: a 15-minute call this week.
7. Sign-off: "Best regards," then [YOUR NAME].

Return { "email": { "subject": string, "content": string } }.`,
  },
};

export const PROMPT_KEYS: PromptKey[] = ["ppd_document", "email_draft"];

/**
 * Everything a template can reference, pre-rendered to plain strings so the
 * template file stays purely textual and safe to edit in a browser.
 */
export function buildPromptVars(args: {
  lead: NormalizedLead;
  recipient: NormalizedContact | null;
  brand: ProposalBrand;
  today: string;
  language: string;
  ppd?: ProposalPpd | null;
}): Record<string, string> {
  const { lead, recipient, brand, today, language, ppd } = args;
  const otherEmails = lead.contacts
    .filter((c) => c.isEmail && c.normalizedValue !== recipient?.normalizedValue)
    .map((c) => c.normalizedValue ?? c.contactValue);

  const recipientEmail = recipient
    ? (recipient.normalizedValue ?? recipient.contactValue)
    : "[no address on file]";

  const vars: Record<string, string> = {
    language,
    today,
    valid_until: addDays(today, 14),
    company: brand.company,
    website: brand.website || "[website not configured]",
    prepared_by: brand.preparedBy,
    sender_email: brand.senderEmail,
    rate: brand.rate
      ? `${brand.rate} (use this wording, do not change the numbers)`
      : "not configured — write [YOUR PRICING] and an indicative range",
    job_title: lead.jobTitle ?? "[UNKNOWN JOB TITLE]",
    job_url: lead.jobUrl ?? "[no url]",
    job_reference: lead.jobId ?? "[no id]",
    job_location: lead.jobLocation ?? "[unspecified]",
    industry: lead.industry ?? "[unspecified]",
    company_mentioned: lead.companyMentioned ?? "[not identified]",
    client_name: lead.clientName ?? "[not identified]",
    client_location: lead.clientLocation ?? "[unspecified]",
    overall_confidence: lead.overallConfidence,
    job_description: indent(
      lead.jobDescription
        ? clip(lead.jobDescription, 3600)
        : "[no post body: job_information.job_description was empty in this payload — write " +
          "from the job title, industry, company and the research notes, and mark anything " +
          "you cannot ground as [TO CONFIRM]]",
    ),
    job_description_chars: String((lead.jobDescription ?? "").length),
    research_notes: bulletBlock(payloadNotes(lead.rawPayload), 900),
    budget_range: bulletBlock(payloadBudget(lead.rawPayload), 260),
    client_profile: bulletBlock(payloadClientProfile(lead.rawPayload), 400),
    key_people: clip(lead.keyPeople.length ? JSON.stringify(lead.keyPeople) : "[]", 1400),
    recipient_name: recipient?.name ?? "[unknown name]",
    recipient_role: recipient?.role ?? "[unknown role]",
    recipient_company:
      recipient?.company ?? lead.companyMentioned ?? "[unknown company]",
    recipient_email: recipientEmail,
    recipient_source: recipient
      ? recipient.listType === "key_person"
        ? "key_people"
        : `${recipient.listType}_contacts (confidence ${recipient.confidence ?? "unrated"})`
      : "custom (typed by a human)",
    recipient_basis: clip(recipient?.rationale ?? "[no note]", 300),
    other_emails: otherEmails.length ? otherEmails.join(", ") : "none",
  };

  if (ppd) {
    vars.ppd_document_title = ppd.document_title;
    vars.ppd_subtitle = ppd.subtitle;
    vars.ppd_outline = ppd.sections.map((s) => s.title || s.id).join(" · ");
    vars.ppd_summary = summarizePpd(ppd);
    vars.ppd_words = String(ppdWordCountLite(ppd));
  } else {
    vars.ppd_document_title = "[no proposal document yet]";
    vars.ppd_subtitle = "";
    vars.ppd_outline = "";
    vars.ppd_summary = "";
    vars.ppd_words = "0";
  }

  return vars;
}

/** First sentence of each paragraph/bullet — enough to keep the email honest. */
function summarizePpd(ppd: ProposalPpd, maxChars = 2200): string {
  const lines: string[] = [];
  for (const section of ppd.sections) {
    for (const block of section.blocks) {
      const push = (value: string) => {
        const sentence = value.split(/(?<=[.?!])\s/)[0]?.trim();
        if (sentence) lines.push(`- ${section.title ? `${section.title}: ` : ""}${sentence}`);
      };
      if (block.type === "paragraph" || block.type === "bullets") block.items.forEach(push);
      if (block.type === "note") push(block.text);
      if (block.type === "numberedSteps") block.items.forEach((s) => push(`${s.title}. ${s.description}`));
      if (block.type === "capabilityMatrix")
        block.items.forEach((c) => push(`${c.requirement}: ${c.approach}`));
      if (block.type === "keyValueTable") block.rows.forEach((r) => push(`${r.label}: ${r.value}`));
    }
  }
  return indent(clip(lines.join("\n"), maxChars));
}

function ppdWordCountLite(ppd: ProposalPpd): number {
  return ppd.sections
    .flatMap((s) => s.blocks)
    .flatMap((b) => {
      if (b.type === "paragraph" || b.type === "bullets") return b.items;
      if (b.type === "note") return [b.text];
      if (b.type === "numberedSteps") return b.items.map((i) => `${i.title} ${i.description}`);
      if (b.type === "capabilityMatrix") return b.items.map((i) => `${i.requirement} ${i.approach}`);
      if (b.type === "keyValueTable") return b.rows.map((r) => `${r.label} ${r.value}`);
      return [];
    })
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function clip(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)} …[truncated]` : value;
}

function indent(value: string) {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/* ── payload research extraction ───────────────────────────────────────────
 * The research JSON is ingested verbatim into `leads.raw_payload`, so these
 * helpers read it straight from there rather than depending on extra columns.
 * Everything degrades to "[none provided]" instead of failing generation.
 * ──────────────────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Render collected strings as `- ` bullets inside a clip() budget. */
function bulletBlock(values: string[], max: number): string {
  const lines = values.map((value) => `- ${value.replace(/\s+/g, " ").trim()}`).filter((l) => l !== "- ");
  return lines.length ? indent(clip(lines.join("\n"), max)) : "  [none provided]";
}

/**
 * Grounding notes the researcher wrote: page/profile `notes`, contact
 * `rationale`, skill evidence — the sentences that say what the company
 * actually does. Longest first is deliberate: it keeps the most specific facts.
 */
function payloadNotes(raw: Record<string, unknown>): string[] {
  const ci = asRecord(raw.contact_information);
  const out: string[] = [];

  const collect = (items: unknown[], label: string) => {
    for (const entry of items) {
      const record = asRecord(entry);
      const note = typeof record.notes === "string" ? record.notes : typeof record.rationale === "string" ? record.rationale : null;
      if (note) out.push(`${label} — ${note}`);
      const evidence = record.evidence;
      if (typeof evidence === "string" && evidence !== note) out.push(`${label} evidence — ${evidence}`);
    }
  };

  collect(asArray(ci.company_contact_pages), "company page");
  collect(asArray(ci.linkedin_profiles), "linkedin");
  collect(asArray(ci.verified_contacts), "verified contact");
  collect(asArray(ci.potential_contacts), "potential contact");
  collect(asArray(raw.key_people), "key person");

  const ji = asRecord(raw.job_information);
  for (const key of ["skills", "requirements", "deliverables", "responsibilities"]) {
    const value = ji[key];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out.push(`${key} — ${(value as string[]).join("; ")}`);
    } else if (typeof value === "string" && value) {
      out.push(`${key} — ${value}`);
    }
  }

  const summary = typeof raw.research_summary === "string" ? raw.research_summary : null;
  if (summary) out.unshift(`research summary — ${summary}`);

  return out
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort((a, b) => Math.min(b.length, 400) - Math.min(a.length, 400))
    .slice(0, 14);
}

function payloadBudget(raw: Record<string, unknown>): string[] {
  const ji = asRecord(raw.job_information);
  const candidates: unknown[] = [
    ji.budget,
    ji.budget_range,
    ji.pay,
    raw.budget,
    raw.amount,
    asRecord(raw.upwork_client).budget_range,
  ];
  return candidates
    .map((value) => (typeof value === "string" ? value : value ? JSON.stringify(value) : ""))
    .filter(Boolean)
    .slice(0, 4);
}

function payloadClientProfile(raw: Record<string, unknown>): string[] {
  const client = asRecord(raw.upwork_client);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(client)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
    } else if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string")) {
      lines.push(`${key}: ${(value as string[]).slice(0, 8).join("; ")}`);
    }
  }
  const hiring = asRecord(raw.hiring_activity ?? raw.recent_hires ?? raw.hires);
  if (Object.keys(hiring).length) lines.push(`hiring activity: ${JSON.stringify(hiring).slice(0, 300)}`);
  return lines.slice(0, 10);
}
