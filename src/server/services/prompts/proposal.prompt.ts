import type { NormalizedContact } from "@/types/lead";
import type { NormalizedLead } from "@/types/lead";

/**
 * Prompt pair that produces the PPD (pdfme JSON script) + the outreach email.
 * Keep the JSON contract in `proposal.service.ts` (zod) in sync with this.
 */

export function systemPrompt(language = "English") {
  return `You are a senior B2B proposal writer for a small studio that replies to Upwork job posts.

Rules
- Write in clear, professional ${language}. No hype, no bullet spam, no marketing clichés.
- Use ONLY the facts provided. Never invent client names, prices, deadlines, case studies, awards, metrics, or client references.
- When a fact is unknown, write a bracketed placeholder exactly like [YOUR PRICING] or [START DATE] so a human can fill it in.
- Prices: propose ranges only, in USD, and label them "indicative — confirmed after a short scoping call".
- Never mention that the client was scraped, researched, found via LinkedIn, or that their email was guessed. The email must read like a normal reply to an Upwork job post.
- Email rules: subject <= 70 chars, specific to the job, not clickbait. Body 120-190 words, plain text, no markdown, no HTML. One clear ask (a 15-minute call). Greet by first name if known, otherwise use a neutral greeting. Include one concrete observation about the job and one relevant capability. Sign off with [YOUR NAME].
- Output ONE JSON object. No commentary, no markdown fences.`;
}

export function userPrompt(
  lead: NormalizedLead,
  recipient: NormalizedContact,
  senderName: string,
  today: string,
): string {
  const emails = lead.contacts.filter((c) => c.isEmail).map((c) => c.normalizedValue);

  return `Generate a proposal package for this lead.

LEAD
- Job title: ${lead.jobTitle ?? "[UNKNOWN JOB TITLE]"}
- Job URL: ${lead.jobUrl ?? "[no url]"}
- Job ID / reference: ${lead.jobId ?? "[no id]"}
- Job location: ${lead.jobLocation ?? "[unspecified]"}
- Industry: ${lead.industry ?? "[unspecified]"}
- Company mentioned in post: ${lead.companyMentioned ?? "[not identified]"}
- Upwork client display name: ${lead.clientName ?? "[not identified]"}
- Client location: ${lead.clientLocation ?? "[unspecified]"}
- Overall research confidence: ${lead.overallConfidence}
- Job description:
${indent(clip(lead.jobDescription ?? "[not provided to us]", 2500))}

KEY PEOPLE (identity guesses from research — treat as unverified)
${JSON.stringify(clip(String(lead.keyPeople.length ? JSON.stringify(lead.keyPeople) : "[]"), 2000), null, 0)}

RECIPIENT
- Contact name: ${recipient.name ?? "[unknown name]"}
- Role: ${recipient.role ?? "[unknown role]"}
- Company: ${recipient.company ?? lead.companyMentioned ?? "[unknown company]"}
- Email: ${recipient.normalizedValue ?? recipient.contactValue}
- Where it was found: ${recipient.listType} (${recipient.confidence ?? "unrated"})
- Basis of that finding: ${clip(recipient.rationale ?? "[no note]", 400)}

OUR DETAILS
- We are: ${senderName}
- Today's date: ${today}
- Proposal validity: 14 days from today
- Other emails for the same lead (do NOT address them): ${emails.length ? emails.join(", ") : "none"}

Return JSON with EXACTLY these keys:
{
  "ppd": {
    "document_title": string,                 // <= 60 chars, e.g. "Proposal: 3D Hard-Surface Product Animation"
    "proposal_subtitle": string,              // <= 90 chars
    "prepared_for": string,                   // recipient name or company
    "client_company": string,
    "contact_name": string,
    "contact_role": string,
    "prepared_by": ${JSON.stringify(senderName)},
    "prepared_date": "${today}",
    "valid_until": string,                    // ISO date, 14 days out
    "job_title": string,
    "job_reference": string,
    "job_url": string,
    "engagement_summary": string,             // 45-80 words, what we understand + what we propose
    "understanding": string,                  // 60-110 words, the job's problem in our own words
    "scope_title": string,                    // <= 50 chars
    "deliverables": string[],                 // max 6, each <= 90 chars
    "approach": string[],                     // max 5, each <= 110 chars
    "timeline_label_1": string, "timeline_value_1": string,
    "timeline_label_2": string, "timeline_value_2": string,
    "timeline_label_3": string, "timeline_value_3": string,
    "pricing_title": string,
    "pricing_option_1_name": string, "pricing_option_1_price": string, "pricing_option_1_notes": string,
    "pricing_option_2_name": string, "pricing_option_2_price": string, "pricing_option_2_notes": string,
    "includes": string[],                     // max 6
    "assumptions": string[],                  // max 5
    "next_steps": string[],                   // max 4
    "why_us": string[],                       // max 5
    "contact_email": ${JSON.stringify(senderNameEmailHint(senderName))},
    "contact_name_signature": string,
    "closing_note": string,                   // <= 120 chars
    "footer_note": string                     // <= 120 chars
  },
  "email": { "subject": string, "content": string }
}`;
}

function senderNameEmailHint(senderName: string) {
  return `"[YOUR REPLY EMAIL]" (we will replace with the sending mailbox: ${senderName})`;
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
