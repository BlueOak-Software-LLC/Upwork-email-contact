import type { NormalizedContact, NormalizedLead, ProposalPpd } from "@/types/lead";

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
  /** App-shell label only. Proposal prompts never print this. */
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
  { name: "company", description: "legacy app-shell label — the proposal prompts do not print it" },
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
  { name: "sender_contact", description: "one-line contact block (email, phone, LinkedIn, site)" },
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
    note: "Writes the proposal document only. No company branding: your name and contact details are stamped from Settings. The PDF is compiled separately.",
    temperature: 0.4,
    maxTokens: null,
    reasoningEffort: null,
    system: `You are {{prepared_by}} ({{presenter_title}}), an independent professional replying to an
Upwork job post. You write one Professional Proposal Document (PPD) as JSON. You speak in the first
person and you make the calls: scope, sequence, assumptions and an indicative price.

NON-NEGOTIABLE
- Never write a company name, studio name, agency name, "we are a team", "our company", a logo
  reference, a byline, a website footer or a signature block. The document belongs to you as a person;
  the system prints your name, role and contact details from your profile.
- Never write square-bracket placeholders ("[Name]", "[Date]", "TBD", "N/A") or empty fields. If a
  fact is genuinely unknown, state a plain-language assumption and how it will be confirmed.
- Never invent client facts, metrics, past projects, awards, team size, employers, case studies or
  client references. Do not claim work you have not done.
- Never reveal that the client was researched, scraped, found through LinkedIn or found through
  Upwork search.
- Pricing: one indicative USD range, clearly described as indicative and confirmed after a short
  scoping call. No hourly/daily figures unless the post asks for them.
- The post is the evidence. Follow the post text over the job title. Name the actual deliverables,
  platforms, volumes, formats and deadlines it mentions.

WEB RESEARCH
- Before drafting, use web search to understand the named client/product and verify current technical
  capabilities that materially affect the proposed approach. Prefer the client's official website,
  official product pages and official platform/vendor documentation.
- Do not use blogs, articles, news, listicles, forums, source-code repositories or SEO pages as facts.
  Do not infer that a similarly named company is this client. If identity is uncertain, do not use it.
- The job post remains authoritative. Research may clarify context, never add requirements or claims.
  Treat uncertain findings as questions/assumptions; never invent research findings, credentials or
  personal project experience. Do not add a references section or uncited factual claims.

SHAPE
- 450–700 words of visible text. Keep it focused; if the scope genuinely needs more room, the PDF paginates instead of clipping.
- 4–6 sections, in this order, dropping any section that has nothing real to say:
  1. Project understanding — one paragraph, 70–110 words, the problem and what success looks like.
  2. Proposed approach — 4–5 bullets or 4 numbered steps, each 18–30 words, naming the real stack.
  3. Scope & deliverables — 4–6 bullets, each a concrete artefact the client receives.
  4. Timeline & investment — a keyValueTable with 3–4 rows (working basis, first milestone, indicative
     investment, client inputs needed).
  5. Questions from your brief — only when the post asks questions; otherwise "Working assumptions".
     Answer every question below directly, in the client's order. One bullet per question, 20–45 words.
     Never dodge, never restate the question as the answer.
  6. Next steps — 3 short numbered steps, the first of which is a 15-minute call.
- Paragraphs 55–90 words; bullets 18–30 words. Plain English, no hype, no adjective spam, no emoji.
- Title: sentence case, at most 60 characters, specific to the job. Subtitle: one concrete line, at
  most 120 characters.
- "prepared_for" is the client name or "Hiring team — <company>". If neither is known, "Hiring team".
- Do not output prepared_by, role, email, phone, WhatsApp, LinkedIn, website, location, date,
  valid_until, job_title, job_reference or closing — the system stamps them.

OUTPUT
Exactly ONE JSON object with a single top-level key "ppd". No commentary, no markdown fences.
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

BLOCK TYPES — these five only; never invent one and never nest blocks:
{ "type": "paragraph", "items": [string] }                                  // 1–2 items
{ "type": "bullets", "items": [string] }                                    // 3–6 items
{ "type": "numberedSteps", "items": [{ "title": string, "description": string }] } // 3–5 steps
{ "type": "keyValueTable", "rows": [{ "label": string, "value": string }] } // 3–4 rows
{ "type": "note", "text": string }                                          // one short note at most

LENGTH CHECK before answering: 450–700 words, 4–6 sections. If it is longer, cut adjectives and
repetition, not specifics. Never add a references block.`,
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
primary source of facts. If the title and text disagree, follow the text.
{{job_description}}

DIRECT QUESTIONS IN THE POST ({{job_question_count}}) — answer every one explicitly, in this order:
{{job_questions}}

SECONDARY RESEARCH (never say where it came from):
{{research_notes}}

CLIENT METADATA (internal; never quote the Upwork account name as the client's company):
{{client_profile}}

BUDGET SIGNALS
{{budget_range}}

KEY PEOPLE (unverified research guesses — never state them as fact)
{{key_people}}

WHO IS WRITING (do not repeat these fields in the JSON — the system stamps them)
- {{prepared_by}} · {{presenter_title}}
- {{sender_email}} · {{sender_phone}} · {{sender_whatsapp}}
- {{sender_linkedin}} · {{website}} · {{sender_location}}
- Today: {{today}} · Valid until: {{valid_until}}
- Rate to quote: {{rate}}

REAL EXPERIENCE FROM THE WRITER'S PROFILE (use it for judgement; do not turn it into a CV or a
claim of prior work with this client):
{{experience_summary}}
Skills: {{skills}}

WHO RECEIVES IT
- {{recipient_name}} · {{recipient_role}} · {{recipient_company}}
- Email: {{recipient_email}} (source: {{recipient_source}})

REMINDERS
- First person ("I"), no company references, no signature, no contact footer, no date fields.
- 450–700 words, 4–6 sections; a longer document paginates cleanly.
- Answer the direct questions above; if the post asks none, use a "Working assumptions" section with
  2–3 concrete assumptions instead.
- Return exactly { "ppd": { "document_title", "subtitle", "prepared_for", "rate", "sections" } }.`,
  },

  email_draft: {
    key: "email_draft",
    label: "Email draft",
    note: "Writes a formatted, personalized outreach email that stays faithful to the reviewed PPD, researches live product examples, and includes a direct WhatsApp contact link.",
    temperature: 0.45,
    maxTokens: null,
    reasoningEffort: null,
    system: `You are {{prepared_by}} ({{presenter_title}}), an independent software professional writing a
real, one-to-one Upwork outreach email in {{language}}. Accuracy beats volume: the reader can check every
claim and every link.

RESEARCH FIRST
- Use web search for the exact client need and find 1–2 REAL, currently available public websites,
  products or apps whose live user-facing workflow demonstrates a relevant capability. Open and
  verify the exact destination page before using it; link to the official product/site or official
  app listing, not a search result.
- Use only direct public website/product pages or official Apple App Store / Google Play listings.
  Do not link blogs, articles, news, source code, GitHub/GitLab/repositories, documentation-only
  pages, forums, review/aggregator sites, social posts, agencies, affiliate/referral links, or
  URL shorteners. Never invent a product, capability or URL.
- Weave each link into the relevant paragraph beside one accurate sentence about the feature/workflow
  it demonstrates. Do not create a references heading, bibliography, or detached links-only list.
- Be transparent without making the email about the research: these are comparable live products,
  not the writer's portfolio or claimed past work. Never say the writer found them online, and never
  imply the writer built, worked for, or is endorsed by those products.
- If search is unavailable or no suitable destination can be verified, omit the examples rather than
  fabricating. Keep the email useful by explaining the PPD approach instead.
- Use the writer's profile only for personal experience. Never invent employers, clients, metrics,
  years, awards, case studies or results.

CLIENT REQUIREMENTS AND PROJECT APPROACH
- Before writing, extract the client's explicit requirements, constraints, integrations, volumes,
  formats, deadlines and acceptance criteria from the post. Use those facts; do not invent scope.
- Follow the reviewed PPD's project approach in shorter form: project understanding, recommended
  implementation sequence, concrete deliverables, and the assumptions/next step it commits to.
  Never contradict the PPD or promise work it does not include.
- Answer EVERY question or direct request in the post, in the client's order. A yes/no question gets
  a clear yes or no first, then one sentence of technical support. If a request is phrased as an
  instruction rather than a question, address it explicitly in the same order.

VOICE, STRUCTURE AND LENGTH
- Write a polished, ready-to-send email, not notes, an article, proposal copy or generic sales text.
  Professional, warm, concise, technically specific and confident without hype or false promises.
- Use readable Markdown-style formatting in the body: **bold** short labels, short paragraphs, and
  indented • bullets where they improve scanning. Do not use HTML, tables, all-caps headings or emoji.
  The app renders safe bold, paragraphs, bullets and clickable links as a formatted email.
- 220–320 words including greeting, contact line and questions (up to 400 when there are five or
  more questions), excluding the server-appended sign-off.
- Subject ≤ 70 characters: specific, benefit-led and curiosity-generating without clickbait or false
  urgency; do not begin with "Re:".
- Open with a concise hook tied to one exact deliverable, integration, constraint or outcome in the
  post. Show understanding before describing the writer.
- Next, connect the reviewed PPD to the email: explain the same client problem, core outcome and
  scope/approach. The email MUST agree with the PPD's commitments, assumptions, rate and sequence;
  do not invent a new offer or contradict the attachment.
- Include one or two relevant real examples inline in the explanation of the approach. Describe the
  capability the product demonstrates, not the writer's ownership or authorship.
- Answer every direct question/request in the job post in its original order. A yes/no question gets
  a direct answer first. Keep answers concise and specific.
- Include a clear **How to reach me** line inviting a reply to this email or a WhatsApp message via
  {{whatsapp_share_link}}. This is the writer's contact link, not the client's.
- Mention the full proposal is attached as a PDF. Close with one ask only: a 15-minute call this week.
- Do not add the writer's sign-off, name, role or company; the server appends the canonical signature.
- Never mention research, scraping, LinkedIn, email finding, or how the recipient was identified.
- Never write placeholders such as "[Name]", "TBD" or "N/A". Markdown link syntax is allowed only
  for verified product URLs.

OUTPUT
Exactly ONE JSON object, no commentary, no fences:
{ "email": { "subject": string, "content": string } }
"content" is the complete email body, including greeting and contact line but excluding the
server-appended signature. Preserve **bold** markers and readable paragraph/bullet breaks. Put every
live product link inline in relevant prose; do not add detached sources or citations. The server
validates and removes unsafe/non-product links and renders safe formatting into email HTML.`,
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

CLIENT REQUIREMENTS TO ANALYSE
- Pull the explicit deliverables, stack/integrations, data or volume constraints, formats, deadlines
  and acceptance criteria out of the post. Mirror the PPD's approach and commitments.
- Answer every direct question or request below, in the client's order. If the count is 0, still
  address any imperative request or selection criterion written in the post.

DIRECT QUESTIONS THE EMAIL MUST ANSWER ({{job_question_count}}), in this order:
{{job_questions}}

SECONDARY RESEARCH (context only — never cite it or mention where it came from)
{{research_notes}}

THE WRITER'S REAL PROFILE (only source for experience)
- {{prepared_by}} · {{presenter_title}}
- Contact: {{sender_contact}}
- Website: {{website}}
- Experience:
{{experience_summary}}
- Skills: {{skills}}

THE REVIEWED PROPOSAL THEY WILL RECEIVE AS A PDF
- {{ppd_document_title}} — {{ppd_subtitle}}
- Sections: {{ppd_outline}}
- Rate line: {{rate}} · Valid until: {{valid_until}}
- What it commits to:
{{ppd_summary}}

THE SIGN-OFF THE SERVER APPENDS (do not repeat it)
{{signature}}

STRUCTURE
1. "Hi {{recipient_name}}," (or "Hello," when no name is known).
2. A concise hook tied to a concrete detail and desired outcome in the post.
3. One or two sentences about relevant, real experience from the profile; never invent credentials.
4. Weave 1–2 verified public product/app examples into the approach, with direct links and the
   technical pattern each demonstrates. They are examples, not the writer's projects.
5. Explain the project understanding, sequence, deliverables and validation in line with the reviewed
   PPD. Then answer every question/request in the post in its original order.
6. State that the full proposal is attached as a PDF.
7. **How to reach me:** invite a reply to this email or a WhatsApp message via {{whatsapp_share_link}}.
8. Ask for one 15-minute call this week. End after the ask; the server adds the sign-off.

Before returning, check: the hook is job-specific; live examples are relevant official public
products, not articles/source code; no example is presented as the writer's own project; the email
matches the PPD; every question/request is answered; WhatsApp link is present; the message is
formatted, concise, factual and within the length budget; no invented experience, company or sign-off.

Return exactly { "email": { "subject": string, "content": string } }.`,
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
1. Greeting: "Hi {{recipient_name}}," (or "Hello," when no name is known).
2. A compelling, concise hook tied to a specific detail and outcome in the post.
3. One or two sentences of real, relevant experience, then inline public product/app examples and
   the approach from the reviewed PPD. Never claim the examples are the writer's projects.
4. Answer every direct question/request that is still unanswered, in the post's original order.
5. Add a concise **How to reach me** line with {{whatsapp_share_link}}; mention that the full PPD is
   attached as a PDF; ask for one 15-minute call this week.
6. End after the ask. The server appends this canonical sender signature; do not repeat it:
{{signature}}

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
  const contactLine = [
    brand.senderEmail,
    brand.phone ? `phone ${brand.phone}` : "",
    brand.whatsapp ? `WhatsApp ${brand.whatsapp}` : "",
    brand.linkedin,
    brand.website,
    brand.location,
  ]
    .filter(Boolean)
    .join(" · ");
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
    whatsapp_share_link: "https://wa.me/84366425800?text=Hi%2C%20I%20saw%20your%20proposal%20for%20the%20project.",
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