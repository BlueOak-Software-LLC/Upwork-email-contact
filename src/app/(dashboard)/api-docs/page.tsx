import { Badge } from "@/components/ui/badge";

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
    title: "API #1a — receive an Upwork research payload",
    params: "auto=true|false · dry=true · regenerate=true · senderAccountId",
    sample: [
      `curl -s -X POST $APP_URL/api/leads -H "content-type: application/json" \\`,
      `  -H "x-api-key: $API_MASTER_KEY" -d '{`,
      `    "job_information": { "job_id": "02212…", "job_title": "3D Hard-Surface Product Animator",`,
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
      `Stores everything (leads + lead_contacts), detects the email channels,`,
      `then — because an address sits in verified_contacts / potential_contacts —`,
      `calls Groq and saves the PPD + subject/content + an SMTP-ready draft.`,
      ``,
      `{ "data": {`,
      `    "lead": { "id": "uuid", "status": "draft_created" },`,
      `    "created": true, "contacts_found": 7, "emails_found": 2,`,
      `    "proposals": [{ "id": "uuid", "email_subject": "…", "pdf_status": "ready" }],`,
      `    "drafts":    [{ "id": "uuid", "status": "draft", "to_email": "…" }],`,
      `    "generation": { "attempted": 2, "succeeded": 2, "failed": 0, "skipped": false },`,
      `    "warnings": [] } }`,
    ].join("\n"),
  },
  {
    method: "GET",
    path: "/api/leads",
    title: "API #1b — leads as JSON for the dashboard",
    params: "q · status · confidence · page · pageSize · sort · order",
    sample: `curl -s "$APP_URL/api/leads?status=draft_created&pageSize=25" -H "x-api-key: $API_MASTER_KEY"`,
    response: [
      `{ "data": [ { "id": "uuid", "job_title": "…", "job_id": "02212…",`,
      `      "overall_confidence": "HIGH", "status": "draft_created", "contact_count": 7 } ],`,
      `  "meta": { "page": 1, "pageSize": 25, "total": 41, "totalPages": 2 } }`,
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
    method: "POST",
    path: "/api/leads/:id/generate",
    title: "Groq → PPD (block JSON) + subject/content, then a draft",
    params: 'body: { contactId?, regenerate?, createDraft?, senderAccountId?, model? }',
    sample: `curl -s -X POST $APP_URL/api/leads/$LEAD_ID/generate -H "x-api-key: $API_MASTER_KEY" -d '{}'`,
    response: `{ "data": { "proposal": { "ppd": { "document_title", "sections": [ { "id", "title", "blocks": [ { "type": "paragraph|bullets|numberedSteps|capabilityMatrix|keyValueTable|references|note" } ] } ] } },
  "draft": { "status": "draft" }, "draftError": null, "warnings": [],
  "usage": { "prompt_tokens": 3200, "completion_tokens": 3400 }, "costUsd": 0.00252, "documentWords": 2140 } }`,
  },
  {
    method: "GET",
    path: "/api/leads/:id/pdf",
    title: "Proposal PDF from the per-document compiled pdfme template",
    params: "proposalId · contactId · render=true · url=true · download=true",
    sample: `curl -s -o proposal.pdf "$APP_URL/api/leads/$LEAD_ID/pdf?download=true" -H "x-api-key: $API_MASTER_KEY"`,
    response: [
      `application/pdf bytes, served from the private Supabase Storage bucket`,
      `"proposals". 409 + hint when PDF_PROVIDER=none or nothing was generated yet.`,
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
    title: "The two editable Groq prompts + every {{variable}}",
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
    response: `{ "data": { "status": "ok", "emailProvider": "log", "checks": { "supabase": { "ok": true } } } }`,
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

      {ENDPOINTS.map((ep) => (
        <section key={ep.method + ep.path} className="card space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={ep.method === "GET" ? "brand" : "warn"}>{ep.method}</Badge>
            <code className="text-sm font-medium">{ep.path}</code>
            <span className="ml-auto text-xs text-muted">{ep.title}</span>
          </div>
          <p className="text-xs text-muted">
            <span className="text-muted/70">params:</span> {ep.params}
          </p>
          <pre className="overflow-x-auto rounded-lg bg-canvas p-3 text-[11px] leading-relaxed text-muted">
            {ep.sample}
          </pre>
          <pre className="overflow-x-auto rounded-lg bg-canvas p-3 text-[11px] leading-relaxed text-muted/80">
            {ep.response}
          </pre>
        </section>
      ))}
    </div>
  );
}
