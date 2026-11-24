import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/ui/code-block";

export const dynamic = "force-dynamic";
export const metadata = { title: "API" };

interface Endpoint {
  method: string;
  path: string;
  title: string;
  params: string;
  sample: string;
  response: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/api/leads",
    title: "API #1a — receive an Upwork research payload (stores only; generation is a click)",
    params: "auto=true|false · dry=true · regenerate=true · refresh=true · senderAccountId",
    sample: [
      `curl -s -X POST $APP_URL/api/leads -H "content-type: application/json" \\`,
      `  -H "x-api-key: $API_MASTER_KEY" -d '{`,
      `    "job_information": { "job_id": "02212…", "job_title": "3D Hard-Surface Product Animator",`,
      `      "job_description": "We need 12 short photoreal clips of our warehouse robot picking cases off a pallet. Blender or Maya, hard-surface modelling, realistic cloth and cable motion, MP4 plus source files, ~4 minutes finished, 3-week window.",`,
      `      "job_url": "https://www.upwork.com/jobs/~02212…", "industry": "3D animation",`,
      `      "job_location": "Worldwide", "company_mentioned": "Uday Animation Limited" },`,
      `    "upwork_client": { "client_name": "MUS", "location": "Mahe, Seychelles" },`,
      `    "key_people": [ { "name": "Udayan K.", "role": "Founder", "confidence": "HIGH",`,
      `      "linkedin_url": "https://de.linkedin.com/in/udayan-k-1507aa260" } ],`,
      `    "contact_information": {`,
      `      "verified_contacts": [ { "name": "Uday Animation", "contact_type": "Business email",`,
      `        "contact_value": "udaykarmakar@udayanimation.com", "confidence": "HIGH",`,
      `        "notes": "Published on the official website.", "source_url": "https://udayanimation.com/" } ],`,
      `      "potential_contacts": [ { "contact_type": "Email", "contact_value": "info@acme.co",`,
      `        "confidence": "LOW", "reason": "General mailbox." } ],`,
      `      "company_contact_pages": [], "linkedin_profiles": [], "social_media_profiles": [] },`,
      `    "overall_confidence": "HIGH" }'`,
    ].join("\n"),
    response: [
      `Every key is nullable — "" and [] are welcome, a payload of all nulls is accepted.`,
      `job_information.job_description is stored verbatim, folded into the search tsvector`,
      `(migration 0004) and fed to BOTH prompts: the PPD treats it as the source of concrete`,
      `facts and the writer decides the plan; no bracketed placeholders survive`,
      `detail from it. Also read from top-level job_description, job_information.description,`,
      `or an array of paragraph strings / { "text": … } blocks.`,
      ``,
      `DEDUPE: a payload is the same job when job_id matches OR the job link matches:`,
      `the link is compared in canonical form (no www., no fragment, no tracking params) and`,
      `the id embedded in it (~02…) is read out, so a scrape that sends only the link still`,
      `finds a lead stored by id. A match adds nothing and answers:`,
      ``,
      `{ "data": { "lead": { "id": "the stored one", … }, "created": false,`,
      `    "duplicate": { "leadId": "uuid", "matchedBy": "job_id" | "job_url" | "dedupe_key" },`,
      `    "warnings": ["Duplicate of lead … — nothing was added. Post again with refresh…"],`,
      `    "generation": { "attempted": 0, "skipped": true, "reason": "duplicate" } } }`,
      ``,
      `A new job stores leads + lead_contacts (manual contacts survive a re-post) and stops:`,
      ``,
      `{ "data": {`,
      `    "lead": { "id": "uuid", "status": "enriched", "job_description": "We need 12 short…" },`,
      `    "created": true, "contacts_found": 7, "emails_found": 2,`,
      `    "proposals": [], "drafts": [], "warnings": [],`,
      `    "generation": { "attempted": 0, "succeeded": 0, "failed": 0, "skipped": true,`,
      `      "reason": "manual — the lead is stored; click \"Generate PPD\" …" } } }`,
      ``,
      `Nothing is generated: no model tokens are spent until someone clicks Generate on the`,
      `lead page (or POSTs /api/leads/:id/generate). ?auto=true restores the old behaviour`,
      `of writing the PPD inside this request; ?refresh=true overwrites a matched lead.`,
    ].join("\n"),
  },
  {
    method: "GET",
    path: "/api/leads",
    title: "API #1b — leads as JSON for the dashboard",
    params: "q · status · confidence · page · pageSize · sort · order — q also matches job_description",
    sample: `curl -s "$APP_URL/api/leads?status=draft_created&pageSize=25" -H "x-api-key: $API_MASTER_KEY"`,
    response: [
      `{ "data": [ { "id": "uuid", "job_title": "…", "job_id": "02212…",`,
      `      "overall_confidence": "HIGH", "status": "draft_created",`,
      `      "contact_count": 7, "proposal_count": 2, "draft_count": 1 } ],`,
      `  "meta": { "page": 1, "pageSize": 25, "total": 41, "totalPages": 2 } }`,
      ``,
      `The three counts are embedded aggregates, so the list can show the pipeline and`,
      `the delete dialog can state the blast radius without a second round-trip. On a`,
      `database older than 0002 the embed is dropped and only contact_count appears.`,
    ].join("\n"),
  },
  {
    method: "DELETE",
    path: "/api/leads",
    title: "API #1c — remove jobs permanently (list + database + stored PDFs)",
    params: 'body: { ids: ["<lead uuid>", …] } — 1 to 100 exact ids; a filter is never accepted',
    sample: `curl -s -X DELETE $APP_URL/api/leads -H "content-type: application/json" \\`
      + ` -H "x-api-key: $API_MASTER_KEY" -d '{"ids":["$LEAD_ID"]}'`,
    response: [
      `{ "data": { "removed": [ { "id": "uuid", "job_title": "…", "contacts": 3,`,
      `        "proposals": 1, "drafts": 1, "pdfFiles": 1 } ],`,
      `  "missing": ["uuid that was already gone"], "failed": [], "storageErrors": [],`,
      `  "totals": { "leads": 1, "contacts": 3, "proposals": 1, "drafts": 1, "pdfFiles": 1 },`,
      `  "kept": { "crm_contacts": "public.contacts rows are not touched",`,
      `            "email_logs": "sent-message audit rows survive with pointers nulled" } } }`,
      ``,
      `Gone: leads, lead_contacts, proposals (+ reviewed PPD and email copy), email_drafts,`,
      `and every object under proposals/{leadId}/ in storage — a plain row delete would`,
      `orphan those PDFs. Kept: public.contacts you promoted, email_logs delivery proof,`,
      `sender accounts and prompt overrides. No undo, no trash table.`,
      ``,
      `DELETE /api/leads/:id does the same for one id and keeps the 204 contract for scripts.`,
    ].join("\n"),
  },
  {
    method: "GET",
    path: "/api/leads/:id",
    title: "Lead detail: job + contacts + proposals + drafts + raw payload",
    params: "—",
    sample: `curl -s $APP_URL/api/leads/$LEAD_ID -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "lead": …, "contacts": […], "proposals": […], "drafts": […],\n  "keyPeople": […], "contactInformation": { … }, "rawPayload": { … } } }`,
  },
  {
    method: "PATCH",
    path: "/api/leads/:id",
    title: "Status transition, or supply job_description late",
    params: 'body: { status?, job_description?, error? } — any subset',
    sample: `curl -s -X PATCH $APP_URL/api/leads/$LEAD_ID -H "content-type: application/json" \\`
      + ` -H "x-api-key: $API_MASTER_KEY" -d '{"job_description":"Need 4 isometric loops, 20 s, MP4 + webm"}'`,
    response: `{ "data": { …detail…, "hints": ["job_description replaced — the stored PPD predates it;\\n  POST /api/leads/:id/generate {\\"regenerate\\":true} to rewrite from the new text"] } }`,
  },
  {
    method: "POST",
    path: "/api/leads/:id/generate",
    title: "STEP 1 — the model writes the PPD only (from job_information.job_description)",
    params: 'body: { contactId?, toEmail?, regenerate?, model?, reasoningEffort? } — all optional',
    sample: `curl -s -X POST $APP_URL/api/leads/$LEAD_ID/generate -H "content-type: application/json" \\`
      + ` -H "x-api-key: $API_MASTER_KEY" -d '{"toEmail":"someone@else.com"}'`,
    response: [
      `Writes the document and nothing else: no email copy, no draft, no PDF. With neither`,
      `contactId nor toEmail it uses the lead's primary email; if the lead has no address at`,
      `all it still writes a recipient-less PPD (recipient: null) because the post text is`,
      `enough to author it.`,
      ``,
      `{ "data": { "proposal": { "pdf_status": "pending", "email_subject": "" },`,
      `  "ppd": { "document_title", "subtitle", "sections": [ { "id", "title",`,
      `    "blocks": [ { "type": "paragraph|bullets|numberedSteps|capabilityMatrix|keyValueTable|references|note" } ] } ] },`,
      `  "documentWords": 950, "usage": { "prompt_tokens": 1802, "completion_tokens": 3130, "reasoning_tokens": 1065 },`,
      `  "costUsd": 0.00215, "warnings": [], "recipient": { "email", "source": "custom" } | null,`,
      `  "prompt": { "system", "user", "isDefault", "reasoningEffort", "maxTokens", "requestedMaxTokens" },`,
      `  "next": "Review or edit the PPD, then POST /api/leads/:id/generate-email" } }`,
    ].join("\n"),
  },
  {
    method: "POST",
    path: "/api/leads/:id/generate-email",
    title: "STEP 3 — email copy from the reviewed PPD + open the draft",
    params: 'body: { proposalId?, contactId?, toEmail?, cc?, senderAccountId?, createDraft?, reasoningEffort? }',
    sample: `curl -s -X POST $APP_URL/api/leads/$LEAD_ID/generate-email -H "content-type: application/json" \\`
      + ` -H "x-api-key: $API_MASTER_KEY" -d '{"toEmail":"client@example.com","cc":["account@example.com"]}'`,
    response: `{ "data": { "email": { "subject", "content" }, "draft": { "to_email", "cc", "recipient_source": "custom", "attachments": [] },
  "recipient": { "email", "source" }, "usage": { … }, "costUsd": 0.00032, "pdfStatus": "pending",
  "prompt": { … }, "next": "POST /api/drafts/:id/send — this renders the PDF from the reviewed PPD" } }`,
  },
  {
    method: "PATCH",
    path: "/api/proposals/:id",
    title: "STEP 2 — the human review: edit the PPD, stamp it reviewed",
    params: 'body: { ppd?, emailSubject?, emailContent?, reviewed? } — ppd is re-sanitised; a ready PDF goes stale',
    sample: `curl -s -X PATCH $APP_URL/api/proposals/$PROPOSAL_ID -H "content-type: application/json" \\`
      + ` -H "x-api-key: $API_MASTER_KEY" -d '{"ppd": { …the edited document… }}'`,
    response: `{ "data": { "proposal": { "ppd": …, "ppd_reviewed_at": "…", "pdf_status": "pending" },
  "warnings": ["ppd updated — the PDF will be re-rendered from it on the next preview or send",
    "“Deliverables” block 2 (bullets) dropped: it contained no text",
    "“Deliverables”: 1 empty line(s) will be removed from the bullets block"],
  "lead": { …full refreshed detail — the dashboard writes this straight to cache… } } }`,
  },
  {
    method: "POST",
    path: "/api/leads/:id/drafts",
    title: "Write the email yourself (no model call) — any recipient",
    params: "body: { toEmail, cc?, subject, bodyText, proposalId?, senderAccountId? }",
    sample: `curl -s -X POST $APP_URL/api/leads/$LEAD_ID/drafts -H "content-type: application/json" \\`
      + ` -H "x-api-key: $API_MASTER_KEY" -d '{"toEmail":"cto@acme.co","subject":"Re: your post","bodyText":"Hi —"}'`,
    response: `{ "data": { "draft": { "status": "draft", "recipient_source": "custom", "attachments": [] },
  "recipient": { "email", "contactId", "source": "custom" } } }`,
  },
  {
    method: "GET",
    path: "/api/leads/:id/pdf",
    title: "The explicit PDF preview — compiled from the reviewed PPD on demand",
    params: "proposalId · contactId · render=true · url=true · download=true",
    sample: `curl -s -o preview.pdf "$APP_URL/api/leads/$LEAD_ID/pdf?render=true&download=true" -H "x-api-key: $API_MASTER_KEY"`,
    response: [
      `Nothing renders a PDF during generation: ?render=true is the only way to get one before`,
      `a send. The pdfme template is compiled per document by lib/pdfme/compiler.ts from the`,
      `stored PPD, then uploaded to the private "proposals" bucket. 409 when PDF_PROVIDER=none.`,
    ].join("\n"),
  },
  {
    method: "POST",
    path: "/api/email/send",
    title: "API #2 — send an email (env provider or a stored sender account)",
    params: "to, cc, subject, text|html, contactId, senderAccountId, attachments, replyTo",
    sample: [
      `curl -s -X POST $APP_URL/api/email/send -H "content-type: application/json" \\`,
      `  -H "x-api-key: $API_MASTER_KEY" -d '{`,
      `    "to": "client@acme.co", "subject": "Quick question about your project",`,
      `    "text": "Hi Jane, are you free for a 15-min call?",`,
      `    "senderAccountId": "uuid-of-our-mailbox" }'`,
    ].join("\n"),
    response: `{ "data": { "provider": "smtp-account", "requested": 1, "delivered": 1, "failed": 0,\n  "results": [{ "status": "sent", "providerMessageId": "…" }] } }`,
  },
  {
    method: "POST",
    path: "/api/drafts/:id/send",
    title: "STEP 3 — render the PDF from the reviewed PPD, attach, send",
    params: "body: { senderAccountId?, attachPdf? (default true) }",
    sample: `curl -s -X POST $APP_URL/api/drafts/$DRAFT_ID/send -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "draft": { "status": "sent", "sent_at": … }, "results": […],\n  "account": { "label": "Studio Gmail", "from_email": "hello@yourdomain.com" } } }`,
  },
  {
    method: "PATCH",
    path: "/api/drafts/:id",
    title: "Edit a draft — recipient may be any address",
    params: "subject · bodyText · toEmail · cc · senderAccountId · status(draft|queued|cancelled)",
    sample: `curl -s -X PATCH $APP_URL/api/drafts/$DRAFT_ID -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" -d '{"toEmail":"other@acme.co","cc":["boss@yourdomain.com"]}'`,
    response: `{ "data": { "draft": { "id": "uuid", "to_email": "other@acme.co", "recipient_source": "custom", "status": "draft" } } }`,
  },
  {
    method: "GET",
    path: "/api/prompts",
    title: "The two editable prompts + every {{variable}}",
    params: "PUT: { key, systemText, userTemplate, temperature, maxTokens?, reasoningEffort? } · POST /api/prompts/:key/reset",
    sample: `curl -s $APP_URL/api/prompts -H "x-api-key: $API_MASTER_KEY" | jq '.data.prompts[].key'`,
    response: `{ "data": { "prompts": [ { "key": "ppd_document", "system", "user", "isDefault", … },\n  { "key": "email_draft", … } ], "variables": [ { "name", "description" } ],\n  "used": [ { "key", "system": [ … ], "user": [ … ] } ] } }`,
  },
  {
    method: "GET",
    path: "/api/sender-accounts",
    title: "Our sending mailboxes + SMTP config (password never returned)",
    params: "POST: label, fromEmail, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, isDefault, dailyLimit",
    sample: [
      `curl -s -X POST $APP_URL/api/sender-accounts -H "content-type: application/json" \\`,
      `  -H "x-api-key: $API_MASTER_KEY" -d '{ "label": "Studio Gmail",`,
      `    "fromEmail": "hello@yourdomain.com", "smtpHost": "smtp.gmail.com",`,
      `    "smtpPort": 465, "smtpSecure": true, "smtpUser": "hello@yourdomain.com",`,
      `    "smtpPassword": "app-password", "isDefault": true }'`,
    ].join("\n"),
    response: `{ "data": { "account": { "id": "uuid", "has_password": true, "password_mask": "••••e4",\n  "smtp_host": "smtp.gmail.com", "smtp_port": 465 } } }`,
  },
  {
    method: "POST",
    path: "/api/sender-accounts/:id/test",
    title: "SMTP login check (nodemailer verify — sends nothing)",
    params: "—",
    sample: `curl -s -X POST $APP_URL/api/sender-accounts/$ID/test -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "ok": true, "account": "Studio Gmail" } }`,
  },
  {
    method: "GET",
    path: "/api/contacts",
    title: "Manual contact list as JSON",
    params: "q · status · source · tag · page · pageSize · sort · order",
    sample: `curl -s "$APP_URL/api/contacts?status=new" -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": [ … ], "meta": { "page": 1, "pageSize": 20, "total": 128, "totalPages": 7 } }`,
  },
  {
    method: "GET",
    path: "/api/health",
    title: "Liveness + Supabase probe",
    params: "—",
    sample: `curl -s $APP_URL/api/health`,
    response: `{ "data": { "status": "ok", "emailProvider": "log", "ai": { "provider": "puter", "chain": [{ "provider": "puter", "model": "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free" }], "autoEnrich": false }, "checks": { "supabase": { "ok": true } } } }`,
  },
  {
    method: "GET",
    path: "/api/ai/settings",
    title: "Effective provider config — models, key source, chain. Never the keys",
    params: "—",
    sample: `curl -s $APP_URL/api/ai/settings -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "chain": [{ "provider": "puter", "model": "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free" }], "providers": [{ "provider": "puter", "configured": true, "keySource": "database", "modelSource": "default", "inChain": true }], "encryptionReady": true, "storageReady": true } }`,
  },
  {
    method: "PUT",
    path: "/api/ai/settings",
    title: "Save a provider key/model/enabled flag (key encrypted at rest)",
    params: `body: { "provider": "puter", "apiKey?": "…", "model?": "openrouter:…:free", "fallbackModel?": "openrouter:…:free", "enabled?": true }`,
    sample: `curl -s -X PUT $APP_URL/api/ai/settings -H "x-api-key: $API_MASTER_KEY" -H "content-type: application/json" -d '{"provider":"groq","model":"openai/gpt-oss-120b"}'`,
    response: `{ "data": { "chain": [ … ], "providers": [ … ], "reason": null } }`,
  },
  {
    method: "DELETE",
    path: "/api/ai/settings?provider=puter",
    title: "Forget a saved row — back to environment/default",
    params: "provider (puter|groq|gemini)",
    sample: `curl -s -X DELETE "$APP_URL/api/ai/settings?provider=groq" -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "chain": [ … ], "providers": [ … ] } }`,
  },
  {
    method: "POST",
    path: "/api/ai/test",
    title: "Probe the configured chain once — 64 tokens, no database write",
    params: `body: { "prompt?": "…", "model?": "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free" }`,
    sample: `curl -s -X POST $APP_URL/api/ai/test -H "x-api-key: $API_MASTER_KEY" -H "content-type: application/json" -d '{}'`,
    response: `{ "data": { "configured": { "provider": "puter", "chain": [ … ], "reason": null }, "ok": true, "provider": "puter", "model": "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free", "ms": 2140, "usage": { "prompt_tokens": 12, "completion_tokens": 9 }, "costUsd": null, "costBasis": "none", "reply": "{\"ok\":true}" } }`,
  },
  {
    method: "GET",
    path: "/api/email",
    title: "Delivery log with engagement (one row per recipient)",
    params: "page · pageSize · status · to · domain · tracking(untracked|sent|opened|clicked) · draftId",
    sample: `curl -s "$APP_URL/api/email?tracking=opened" -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": [ { "id": "…", "to_email": "client@x.com", "status": "sent", "tracking_token": "…", "open_count": 3, "click_count": 1, "last_event_at": "…", "tracking_state": "opened" } ], "meta": { … } }`,
  },
  {
    method: "GET",
    path: "/api/email/:id",
    title: "One message: delivery row, tracked links, activity timeline",
    params: "id (uuid)",
    sample: `curl -s "$APP_URL/api/email/$LOG_ID" -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "log": { …, "tracking_state": "clicked" }, "links": [ { "label": "acme.com/portfolio", "destination_url": "https://…", "click_count": 2 } ], "events": [ { "event_type": "open", "occurred_at": "…", "user_agent": "…" } ] } }`,
  },
  {
    method: "GET",
    path: "/api/tracking/stats",
    title: "Overview numbers + the effective tracking configuration",
    params: "days (1-90, default 7)",
    sample: `curl -s "$APP_URL/api/tracking/stats?days=14" -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": { "delivered": 24, "tracked": 24, "opens": 41, "uniqueOpeners": 15, "clicks": 6, "uniqueClickers": 5, "openRate": 0.625, "clickThroughRate": 0.208, "series": [ … ], "domains": [{ "domain": "acme.com", "delivered": 4, "opened": 3, "clicks": 1, "openRate": 0.75, "clickRate": 0.25 }], "schemaMissing": false, "configured": { "enabled": true, "linkTracking": true, "domain": "https://…", "retentionDays": 365 } } }`,
  },
  {
    method: "GET",
    path: "/api/tracking/events",
    title: "Raw event stream (opens are image requests, not proof of reading)",
    params: "page · pageSize · type(open|click|sent|reply|meeting|not_interested) · logId",
    sample: `curl -s "$APP_URL/api/tracking/events?type=click" -H "x-api-key: $API_MASTER_KEY"`,
    response: `{ "data": [ { "id": "…", "log_id": "…", "link_id": "…", "event_type": "click", "occurred_at": "…", "user_agent": "…", "link": { "label": "…", "destination_url": "…" } } ], "meta": { … } }`,
  },
  {
    method: "POST",
    path: "/api/tracking/outcome",
    title: "Record what the app cannot observe (no mailbox access)",
    params: `body: { "logId": "uuid", "kind": "reply|meeting|not_interested" }`,
    sample: `curl -s -X POST $APP_URL/api/tracking/outcome -H "x-api-key: $API_MASTER_KEY" -H "content-type: application/json" -d '{"logId":"$LOG_ID","kind":"reply"}'`,
    response: `{ "data": { "logId": "…", "eventId": "…", "kind": "reply" } }`,
  },
  {
    method: "POST",
    path: "/api/maintenance/purge",
    title: "Retention: delete old open/click rows and rebuild counters",
    params: "Authorization: Bearer $CRON_SECRET (scheduler), x-vercel-cron, or x-api-key; body may set { days }",
    sample: `curl -s -X POST $APP_URL/api/maintenance/purge -H "Authorization: Bearer $CRON_SECRET"`,
    response: `{ "data": { "removed": 1842, "before": "2025-11-24T00:00:00.000Z", "days": 365 } }`,
  },
  {
    method: "GET",
    path: "/o/:token.gif",
    title: "Tracking pixel — no auth, no session, always a 1×1 gif",
    params: "token inside the delivered message",
    sample: `curl -si $APP_URL/o/$TRACKING_TOKEN.gif -A "Mozilla/5.0 (iPhone)" | head -12`,
    response: `HTTP/1.1 200 OK\ncontent-type: image/gif\ncache-control: no-store, no-cache, must-revalidate, private, max-age=0\n\n<43-byte transparent GIF>  (a second request from the same client inside 60 s records nothing)`,
  },
  {
    method: "GET",
    path: "/c/:token",
    title: "Tracked link redirect — records the click, then 302s",
    params: "token inside the delivered message",
    sample: `curl -si $APP_URL/c/$LINK_TOKEN | head -6`,
    response: `HTTP/1.1 302 Found\nlocation: https://acme.example.com/portfolio\ncache-control: no-store\nreferrer-policy: no-referrer  (unknown token → 404; a destination that fails the guard → 400, and it is never redirected)`,
  },
];

export default function ApiDocsPage() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-medium text-muted">Backend API</h2>
        <p className="text-xs text-muted/80">
          Route Handlers under <code>src/app/api/**</code> — the same code runs as Vercel
          server functions. Errors always return{" "}
          <code>{`{ "error": { "code", "message", "details?" } }`}</code>. Auth:{" "}
          <code>x-api-key</code> header (or a signed-in session).
        </p>
      </div>

      <nav className="card flex flex-wrap gap-x-4 gap-y-1 p-4 text-[11px]">
        {ENDPOINTS.map((ep) => (
          <a
            key={ep.method + ep.path}
            href={`#${ep.method}-${ep.path.replace(/[^a-z0-9]/gi, "-")}`}
            className="text-muted transition hover:text-brand"
          >
            {ep.method} {ep.path}
          </a>
        ))}
      </nav>

      {ENDPOINTS.map((ep) => (
        <section
          key={ep.method + ep.path}
          id={`${ep.method}-${ep.path.replace(/[^a-z0-9]/gi, "-")}`}
          className="card scroll-mt-24 space-y-3 p-5"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={ep.method === "GET" ? "brand" : "warn"}>{ep.method}</Badge>
            <code className="text-sm font-medium">{ep.path}</code>
            <span className="ml-auto text-xs text-muted">{ep.title}</span>
          </div>
          <p className="text-xs text-muted">
            <span className="text-muted/70">params:</span> {ep.params}
          </p>
          <CodeBlock code={ep.sample} label="Copy request" />
          <CodeBlock code={ep.response} label="Copy shape" collapseAt={8} />
        </section>
      ))}
    </div>
  );
}
