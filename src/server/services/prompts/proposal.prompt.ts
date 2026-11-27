import type { NormalizedContact, NormalizedLead, ProposalPpd } from "@/types/lead";
import { emailSignatureLines } from "@/lib/email-signature";

/**
 * The PPD, email and follow-up prompts, as **editable templates**.
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

export type PromptKey = "ppd_document" | "email_draft" | "follow_up";

export interface PromptTemplateText {
  key: PromptKey;
  label: string;
  note: string;
  system: string;
  user: string;
  temperature: number;
  /** Legacy field; the ChatGPT session has no completion cap. */
  maxTokens: number | null;
  /** Legacy field; ChatGPT chooses its own thinking level. */
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
}

export interface ProposalBrand {
  /** Company name from the selected sender profile, for the email signature only. */
  company: string;
  website: string;
  preparedBy: string;
  /** The writer's role, printed under the name in the PDF. */
  title: string;
  /** "Luan Le · Senior Software Engineer" — byline used by older surfaces. */
  preparedLine: string;
  senderEmail: string;
  phone: string;
  whatsapp: string;
  linkedin: string;
  location: string;
  /** Relevant professional experience, written by the user in Settings. */
  experience: string;
  /** Comma/newline-separated skills from Settings. */
  skills: string;
  /** Empty → the model proposes an indicative range. */
  rate: string;
  /** Canonical email sign-off, appended by the server, never by the model. */
  signature: string[];
}

export const PROMPT_VARS: Array<{ name: string; description: string }> = [
  { name: "language", description: "PROPOSAL_LANGUAGE, e.g. English" },
  { name: "today", description: "ISO date the generation runs on" },
  { name: "today_long", description: "the same date written out, e.g. 25 November 2026" },
  { name: "valid_until", description: "today + 14 days (ISO)" },
  { name: "valid_until_long", description: "today + 14 days, written out" },
  { name: "company", description: "company name from the selected sender profile, linked email-signature label only" },
  { name: "website", description: "your website from the selected sender profile" },
  { name: "prepared_by", description: "your full name from the selected sender profile" },
  { name: "presenter_title", description: "your role, e.g. Senior Software Engineer" },
  { name: "presenter_role", description: "alias of presenter_title" },
  { name: "prepared_line", description: "name · role — the byline the PDF prints" },
  { name: "sender_email", description: "email address on the selected sender profile" },
  { name: "sender_phone", description: "phone from the selected sender profile" },
  { name: "sender_whatsapp", description: "WhatsApp number or link from the profile" },
  { name: "whatsapp_share_link", description: "prefilled direct WhatsApp share link for the sender" },
  { name: "sender_linkedin", description: "LinkedIn URL from the profile" },
  { name: "sender_location", description: "city/timezone from the profile" },
  { name: "sender_contact", description: "public contact links (WhatsApp and company website only)" },
  { name: "experience_summary", description: "your real experience summary from Settings — use only this, never invent" },
  { name: "skills", description: "your skills list from Settings" },
  { name: "signature", description: "canonical email sign-off block, appended by the server" },
  { name: "rate", description: "your configured rate, else an instruction to propose an indicative range" },
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
  { name: "job_questions", description: "direct questions found in the post, one per line; answer every one" },
  { name: "job_question_count", description: "how many direct questions the post contains" },
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
  { name: "email_sequence", description: "1 = first email, 2+ = follow-up number (follow-up prompt only)" },
  { name: "previous_emails", description: "the earlier emails on this thread, newest first (follow-up prompt only)" },
  { name: "previous_email_count", description: "how many emails have already gone to this contact" },
  { name: "last_subject", description: "subject of the message being followed up (follow-up prompt only)" },
  { name: "last_sent_at", description: "ISO date the previous email was sent" },
  { name: "days_since_last_email", description: "whole days since the previous send" },
  { name: "thread_subject", description: "the subject this follow-up should reply under" },
];

export const DEFAULT_PROMPTS: Record<PromptKey, PromptTemplateText> = {
  ppd_document: {
    key: "ppd_document",
    label: "PPD document",
    note: "Writes the proposal document only: a short, plain-English PPD. Your name and contact details are stamped from Settings. The PDF is compiled separately.",
    temperature: 0.4,
    maxTokens: null,
    reasoningEffort: null,
    system: `You are {{prepared_by}} ({{presenter_title}}), an independent professional replying to an Upwork
job post. Write one clear Professional Proposal Document (PPD) as JSON. Write in the first person
("I"), make the decisions yourself, and keep every sentence specific to this job.

RULES
- No company, agency or team names, no "we", no signature, byline, contact details, logo or footer.
  The system prints your name, role and contact details.
- No square-bracket placeholders, "TBD", "N/A" or empty fields. If a detail is unknown, state one plain
  assumption and how it will be confirmed on a short call.
- Never invent client facts, metrics, past projects, employers, awards or references. Never say the
  client was researched or found outside Upwork.
- The job post is the source of truth. Follow its text over its title, and use its real deliverables,
  platforms, volumes, formats and deadlines.
- Use web search to check the named product or platform and any technical fact the approach depends on.
  Use it to make the approach accurate. Do not add a references section or uncited claims.
- Price: one indicative USD range, described as confirmed after a short scoping call. No hourly rates
  unless the post asks for them.

STRUCTURE — 450–650 words in total, 4–6 sections, in this order (drop a section only if it adds nothing)
1. Project understanding — one paragraph (70–100 words): restate the problem in the client's own terms, the goal, and what success looks like. Describe outcomes, not tasks.
2. Proposed approach — 3–4 numbered steps, each a short title and one or two sentences naming the real tools.
3. Deliverables — 4–6 bullets, each one a concrete item the client receives.
4. Timeline and investment — a keyValueTable with 3–4 rows: working basis, first milestone, indicative
   investment, and what the client needs to provide.
5. Answers to the questions in the post — one bullet per question, in the post's order, 20–40 words each.
   If the post asks no questions, title this section "Working assumptions" and give 2–3 bullets.
6. Next steps — 3 numbered steps. The first is a 15-minute call.

WRITING
- Plain English, short sentences, active voice. No hype, filler, adjective stacking or emoji.
- Title: sentence case, 60 characters or fewer, specific to this job. Subtitle: one concrete line, 120
  characters or fewer.
- "prepared_for": the client name, or "Hiring team · <company>", or "Hiring team" if neither is known.
- Do not output prepared_by, role, email, phone, WhatsApp, LinkedIn, website, location, date,
  valid_until, job_title, job_reference or a closing. The system stamps them.

BLOCKS — use only these five types, never nest blocks:
{ "type": "paragraph", "items": [string] }                                     // 1–2 items
{ "type": "bullets", "items": [string] }                                       // 3–6 items
{ "type": "numberedSteps", "items": [{ "title": string, "description": string }] } // 3–4 steps
{ "type": "keyValueTable", "rows": [{ "label": string, "value": string }] }    // 3–4 rows
{ "type": "note", "text": string }                                             // one short note at most

OUTPUT
Return exactly one JSON object, with no commentary and no markdown fences:
{
  "ppd": {
    "document_title": string,
    "subtitle": string,
    "prepared_for": string,
    "rate": string,
    "sections": [
      { "id": "understanding", "title": "Project understanding", "blocks": [ <block> ] }
    ]
  }
}

Before answering, check the word count (450–650), the section count (4–6), that every question from the
post is answered, and that no brackets, placeholders or references block remain.`,
    user: `Write the proposal document for this lead.

JOB
- Title: {{job_title}}
- Job URL: {{job_url}} · Reference: {{job_reference}}
- Location: {{job_location}} · Industry: {{industry}}
- Client display name: {{client_name}} · {{client_location}}
- Company named in the post: {{company_mentioned}}
- Research confidence: {{overall_confidence}}
- Budget signals: {{budget_range}}

POST TEXT ({{job_description_chars}} characters). This is the primary source of facts:
{{job_description}}

QUESTIONS IN THE POST ({{job_question_count}}). Answer each one, in this order:
{{job_questions}}

SUPPORTING RESEARCH (never say where it came from):
{{research_notes}}

CLIENT METADATA (internal; never quote the Upwork account name as the company):
{{client_profile}}

KEY PEOPLE (unverified; never state them as fact):
{{key_people}}

YOUR PROFILE (use it for judgement only; do not turn it into a CV or claim past work with this client):
{{experience_summary}}
Skills: {{skills}}

WRITER: {{prepared_by}} · {{presenter_title}} (the system prints this; do not repeat it)
RECIPIENT: {{recipient_name}} · {{recipient_role}} · {{recipient_company}}
DATES: today {{today}} · valid until {{valid_until}}
RATE TO QUOTE: {{rate}}

Return { "ppd": { "document_title", "subtitle", "prepared_for", "rate", "sections" } }.`,
  },

  email_draft: {
    key: "email_draft",
    label: "Email draft",
    note: "Writes the Upwork reply that goes with the reviewed PPD: a clear, hands-on pitch with a short list of verified live apps when one fits, and the server-added sign-off.",
    temperature: 0.45,
    maxTokens: null,
    reasoningEffort: null,
    system: `You are {{prepared_by}} ({{presenter_title}}), a hands-on software professional writing one
real, one-to-one Upwork reply in {{language}}. You will take this work over end to end: you build it,
test it, hand it over cleanly and support it afterwards. The email must make that clear and must
read like a person who understood the job, not a template.

RESEARCH
- Use web search on every draft. Find up to 2 third-party live apps or production projects that the client
  can open today and that perform the capability in this post, such as a working call flow, booking flow,
  dashboard or deployed app. Open each destination and verify it works before linking.
- Never link a product overview, features, pricing, solutions, use-case, industry, documentation, help or
  marketing page, even on an official site. The page must be the working app or project itself.
- Link only official public app pages, deployed demos or official Apple App Store / Google Play listings.
  Never link blogs, articles, news, source code, GitHub/GitLab, documentation-only pages, forums,
  review sites, social posts, agencies, affiliate links or URL shorteners. Never invent a URL and never
  link a search result.
- Never say you found, built, own or work for the linked app. The link only shows the client a live
  version of the requirement. Describe your own work, not the app's.
- If no destination verifies, omit every link and do not mention links or research at all.
- Use the writer's profile only for real experience. Never invent employers, clients, metrics, years,
  awards or results.

REQUIREMENTS AND APPROACH
- Extract the client's explicit requirements, constraints, integrations, volumes, formats, deadlines
  and acceptance criteria from the post. Use those facts; never invent scope.
- Follow the reviewed PPD: the same problem, approach, deliverables, assumptions, rate and next step.
  Never contradict it or promise work it does not include.
- Describe your work in depth so the client sees senior experience: the stages in order with week numbers,
  what you build first, the tests you run, acceptance checks, handover, documentation and post-launch
  support. Name the concrete technical decisions you would make for this job. Never invent credentials.
- Answer EVERY question or direct request in the post, in the client's order. A yes/no question gets a
  clear yes or no first, then one sentence of technical support. An instruction is answered the same way.

VOICE AND STRUCTURE
- Write like a real person who read the post and is replying to it: plain, specific and short.
  Confident without hype or false promises. Use real details from the post, not generic praise.
- Plain ASCII punctuation only: straight quotes, hyphens, commas, periods and question marks.
  Never use em dashes, en dashes, curly quotes, bullet symbols, arrows, ellipsis characters,
  emoji or other symbols. Never use exclamation marks.
- Never write about what you cannot show, prove, provide or have not done. Ban phrases such as "I cannot",
  "I can't", "I do not have", "I have not", "no verified", "no examples", "not verified", "unable to" and
  "no experience with". State the approach and the work instead. A plain yes or no answer is fine.
- No markdown bold and no headings. The only markdown allowed is the [Label](URL) link syntax.
- No sales or spam wording: free, guarantee, urgent, act now, limited, 100%, game-changer, unlock,
  seamless, leverage, delve, excited, I'd love, hope this finds you well, click here. No ALL CAPS.
- Write 4 to 5 short paragraphs separated by a blank line, plus at most one short bulleted list of
  links. No bold, no headings.
- Order:
  1. A greeting alone on its own line: "Hi {{recipient_name}}," (or "Hello,").
  2. A hook: one concrete requirement from the post, shown back to the client in your own words.
  3. The hands-on approach: how you would deliver it step by step, in line with the PPD, including
     handover and post-launch support when the post needs them.
  4. A live app for this workflow, only if one verifies. One lead-in sentence such as "A live app for
     this workflow:", then one bullet per link, written as [Label](URL). The label is 2 to 4 words naming
     the app. Never write a bare URL, and never use the URL as its own label:
     - [Feature workflow](https://example.com/feature): shows the call flow this job needs
  5. Answers to the client's questions, then one closing paragraph that mentions the attached PDF
     proposal and asks for one 15-minute call this week. End there.
- 150 to 200 words, excluding the link list and the server-appended sign-off. Short sentences.
- Subject: 60 characters or fewer, plain words, specific to this job, with no "Re:", no "proposal
  attached", no exclamation mark and no false urgency.

SIGN-OFF
- Do not write a sign-off, name, role, company, email address, phone number or contact block. The server
  appends one sign-off with the name, WhatsApp start-chat link, role and company website.

Before returning, check: web search was used; at most 2 links, each a verified live app or production
project (not an overview, docs or blog page), written as [Label](URL) with a 2 to 4 word label, or no links
at all; no em dash, en dash, curly quotes, emoji, bullet symbols, arrows or exclamation marks; no blogs,
source code or invented URLs; no link is claimed as the writer's work; no sentence about what the writer
cannot show or has not done; no mention of research; the email matches the PPD; every question is answered;
there is no sign-off or contact block.

OUTPUT
Return exactly one JSON object, no commentary and no fences:
{ "email": { "subject": string, "content": string } }
"content" is the complete body, including the greeting, excluding the sign-off. Keep blank lines between
paragraphs and keep each list item on its own "- " line.`,
    user: `Write the outreach email for this lead. It must match the proposal a human already reviewed.

RECIPIENT
- {{recipient_name}} · {{recipient_role}} · {{recipient_company}}
- Sending to: {{recipient_email}} (source: {{recipient_source}})
- Other addresses on this lead (do NOT address or mention): {{other_emails}}

THE JOB
- Title: {{job_title}} (reference {{job_reference}}, location {{job_location}})
- Industry: {{industry}}
- Client display name: {{client_name}} · Company named in the post: {{company_mentioned}}
- Budget signals: {{budget_range}}
- Post text:
{{job_description}}

DIRECT QUESTIONS IN THE POST ({{job_question_count}}) — answer every one, in this order:
{{job_questions}}

SECONDARY RESEARCH (never say where it came from):
{{research_notes}}

THE REVIEWED PPD — the email must agree with it
- {{ppd_document_title}} — {{ppd_subtitle}}
- Sections: {{ppd_outline}}
- What it commits to:
{{ppd_summary}}

YOUR REAL EXPERIENCE (use only this; do not turn it into a CV):
{{experience_summary}}
Skills: {{skills}}

THE SIGN-OFF THE SERVER APPENDS (do not repeat it)
{{signature}}

STRUCTURE
1. Greeting alone on its own line.
2. Hook: one specific requirement from the post.
3. Hands-on approach, consistent with the PPD, including handover and support where relevant.
4. Links, only if verified: at most 2, as a bulleted list. Each is written as [Label](URL) with a 2 to 4
   word label naming the page, then a plain note after a colon, for example
   "- [Feature workflow](https://example.com/feature): shows the approval steps". Skip the list if nothing
   could be verified.
5. Answers to every question, in the post's order.
6. The attached PDF proposal and one request for a 15-minute call this week. End there.
Do not include {{whatsapp_share_link}}; the server adds the sign-off with the contact details.

Return { "email": { "subject": string, "content": string } }.`,
  },

  follow_up: {
    key: "follow_up",
    label: "Follow-up email",
    note: "Writes the next touch on an existing thread. Runs only after an earlier email to the same contact has actually been sent.",
    temperature: 0.45,
    maxTokens: null,
    reasoningEffort: null,
    system: `You are {{prepared_by}} ({{presenter_title}}), writing follow-up number {{email_sequence}}
on a real email thread in {{language}}. Continue the conversation; do not restart the pitch.

RULES
- Plain text only: no markdown, no HTML, no bold, no headings, no emoji.
- 55–110 words, shorter than the first email. No "just following up", no "bumping this", no scolding.
- Refer naturally to the earlier note. Add exactly ONE new, useful thing: a concrete first step, a
  relevant detail from the post, a suggested time, or a direct answer to a question still open.
- Use only the writer's real experience and the reviewed proposal. Never invent clients, metrics,
  employers or links.
- Never mention research, scraping, LinkedIn, email finding, or that you located them outside Upwork.
- Do not include a sign-off, name or company; the system appends the canonical signature.
- One ask: a short call or a yes/no reply. Keep the thread subject; the system sets it.
- Never write square brackets, "TBD" or "N/A".

OUTPUT
Exactly ONE JSON object: { "email": { "subject": string, "content": string } }. No commentary, no fences.`,
    user: `Write follow-up number {{email_sequence}} for this thread.

RECIPIENT
- {{recipient_name}} · {{recipient_role}} · {{recipient_company}}
- Sending to: {{recipient_email}}

THE JOB
- Title: {{job_title}} (reference {{job_reference}})
- Post text:
{{job_description}}

DIRECT QUESTIONS STILL WORTH ADDRESSING ({{job_question_count}}):
{{job_questions}}

THE REVIEWED PROPOSAL ALREADY SHARED
- {{ppd_document_title}} — {{ppd_subtitle}}
- What it commits to:
{{ppd_summary}}

EARLIER EMAILS ON THIS THREAD (newest first, {{previous_email_count}} total)
{{previous_emails}}

TIMING
- Previous email sent: {{last_sent_at}} ({{days_since_last_email}} day(s) ago)
- Subject to keep: {{thread_subject}}

WHO IS WRITING
- {{prepared_by}} · {{presenter_title}}
- Real experience (do not invent beyond this):
{{experience_summary}}
- Skills: {{skills}}

WHAT TO WRITE
1. Greeting in its own paragraph.
2. One new specific idea or next step based on the post and reviewed PPD. Use 2–3 concise paragraphs,
   each separated by a blank line; answer any still-open question.
3. Make one short ask and end there. Do not write contact details or a sign-off; the server appends
   one signature with the WhatsApp start-chat link and company website.

Return { "email": { "subject": string, "content": string } }.`,
  },
};

export const PROMPT_KEYS: PromptKey[] = ["ppd_document", "email_draft", "follow_up"];

/**
 * Everything a template can reference, pre-rendered to plain strings so the
 * template file stays purely textual and safe to edit in a browser.
 */
export interface FollowUpHistory {
  sequence: number;
  previousEmails: Array<{ subject: string; body: string; sentAt: string; sequence: number }>;
  lastSubject: string;
  lastSentAt: string;
  daysSinceLastEmail: number;
  threadSubject: string;
}

export function buildPromptVars(args: {
  lead: NormalizedLead;
  recipient: NormalizedContact | null;
  brand: ProposalBrand;
  today: string;
  language: string;
  ppd?: ProposalPpd | null;
  history?: FollowUpHistory | null;
}): Record<string, string> {
  const { lead, recipient, brand, today, language, ppd, history } = args;
  const otherEmails = lead.contacts
    .filter((c) => c.isEmail && c.normalizedValue !== recipient?.normalizedValue)
    .map((c) => c.normalizedValue ?? c.contactValue);

  const recipientEmail = recipient
    ? (recipient.normalizedValue ?? recipient.contactValue)
    : "(no address on file — the email step will need one)";

  const validUntil = addDays(today, 14);
  const questions = extractQuestions(lead.jobDescription);
  const contactLine = emailSignatureLines({
    company: brand.company,
    website: brand.website,
  }).slice(1).join(" · ");
  const vars: Record<string, string> = {
    language,
    today,
    today_long: formatLongDate(today),
    valid_until: validUntil,
    valid_until_long: formatLongDate(validUntil),
    company: brand.company,
    website: brand.website || "(not provided)",
    prepared_by: brand.preparedBy || "(name not configured)",
    presenter_title: brand.title || "(role not configured)",
    presenter_role: brand.title || "(role not configured)",
    prepared_line: brand.preparedLine || brand.preparedBy || "(name not configured)",
    signature: brand.signature?.length ? indent(brand.signature.join("\n")) : "  Best regards,",
    sender_email: brand.senderEmail,
    sender_phone: brand.phone || "(not provided)",
    sender_whatsapp: brand.whatsapp || "(not provided)",
    whatsapp_share_link: "https://wa.me/84366425800",
    sender_linkedin: brand.linkedin || "(not provided)",
    sender_location: brand.location || "(not provided)",
    sender_contact: contactLine || "(not provided)",
    experience_summary: indent(
      brand.experience ||
        "(not provided — do not invent experience; rely only on the reviewed proposal and the post)",
    ),
    skills: brand.skills || "(not provided)",
    rate: brand.rate
      ? `${brand.rate} (use this wording, do not change the numbers)`
      : "not configured — propose an indicative USD range for this scope yourself and note it is " +
        "confirmed after a short scoping call",
    job_title: lead.jobTitle ?? "(the post had no title — derive one from the body)",
    job_url: lead.jobUrl ?? "(no url on the lead)",
    job_reference: lead.jobId ?? "(no id on the lead)",
    job_location: lead.jobLocation ?? "(not specified)",
    industry: lead.industry ?? "(not specified)",
    company_mentioned: lead.companyMentioned ?? "(not identified — never guess one)",
    client_name: lead.clientName ?? "(not identified)",
    client_location: lead.clientLocation ?? "(not specified)",
    overall_confidence: lead.overallConfidence,
    job_description: indent(
      lead.jobDescription
        ? clip(lead.jobDescription, 3600)
        : "(no post body: job_information.job_description was empty in this payload — write from " +
          "the job title, industry, company named in the post and the research notes, and turn " +
          "every detail you cannot ground into an assumption or a Question)",
    ),
    job_description_chars: String((lead.jobDescription ?? "").length),
    job_questions: questions.length
      ? indent(questions.map((question, index) => `${index + 1}. ${question}`).join("\n"))
      : "  (none — the post contains no direct questions)",
    job_question_count: String(questions.length),
    research_notes: bulletBlock(payloadNotes(lead.rawPayload), 900),
    budget_range: bulletBlock(payloadBudget(lead.rawPayload), 260),
    client_profile: bulletBlock(payloadClientProfile(lead.rawPayload), 400),
    key_people: clip(lead.keyPeople.length ? JSON.stringify(lead.keyPeople) : "[]", 1400),
    recipient_name: recipient?.name ?? "there",
    recipient_role: recipient?.role ?? "(role not stated)",
    recipient_company:
      recipient?.company ?? lead.companyMentioned ?? "(company not identified)",
    recipient_email: recipientEmail,
    recipient_source: recipient
      ? recipient.listType === "key_person"
        ? "key_people"
        : `${recipient.listType}_contacts (confidence ${recipient.confidence ?? "unrated"})`
      : "custom (typed by a human)",
    recipient_basis: clip(recipient?.rationale ?? "(no note from the researcher)", 300),
    other_emails: otherEmails.length ? otherEmails.join(", ") : "none",
  };

  if (ppd) {
    vars.ppd_document_title = ppd.document_title;
    vars.ppd_subtitle = ppd.subtitle;
    vars.ppd_outline = ppd.sections.map((s) => s.title || s.id).join(" · ");
    vars.ppd_summary = summarizePpd(ppd);
    vars.ppd_words = String(ppdWordCountLite(ppd));
  } else {
    vars.ppd_document_title = "(no proposal document yet)";
    vars.ppd_subtitle = "";
    vars.ppd_outline = "";
    vars.ppd_summary = "";
    vars.ppd_words = "0";
  }

  vars.email_sequence = String(history?.sequence ?? 1);
  vars.previous_email_count = String(history?.previousEmails.length ?? 0);
  vars.last_subject = history?.lastSubject || "(no earlier subject)";
  vars.last_sent_at = history?.lastSentAt || "(not sent yet)";
  vars.days_since_last_email = String(history?.daysSinceLastEmail ?? 0);
  vars.thread_subject = history?.threadSubject || "(new thread)";
  vars.previous_emails = indent(
    clip(
      history?.previousEmails.length
        ? history.previousEmails
            .map(
              (email) =>
                `#${email.sequence} · sent ${email.sentAt}\nSubject: ${email.subject}\n${email.body}`
            )
            .join("\n\n---\n\n")
        : "(no earlier email \u2014 this is the first touch)",
      6000,
    ),
  );

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

function formatLongDate(iso: string) {
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
 * Pull the direct questions out of the post so both the PPD and the email can
 * answer them in order, instead of the model quietly skipping one.
 */
export function extractQuestions(value: string | null | undefined, max = 40): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const questions: string[] = [];
  const sentences = value
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.replace(/^[\s>*#•\-–—\d.)]+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    // A quoted question (`"Can you start Monday?"`) still counts.
    const question = sentence
      .replace(/^["'“‘]+/, "")
      .replace(/["'”’)\]]+$/g, "")
      .trim();
    if (!question.endsWith("?") || question.length < 3 || question.length > 320) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(question);
    if (questions.length >= max) break;
  }
  return questions;
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
  return lines.length ? indent(clip(lines.join("\n"), max)) : "  (none provided)";
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