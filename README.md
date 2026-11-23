# Upwork Email Contact

Next.js 15 app that is **both the dashboard and the backend**, on **Supabase** +
**Vercel**:

1. **Ingest** an Upwork research payload (job info, client, key people, contacts) via `POST /api/leads`
2. **Store** every field — raw JSON kept as-is, contacts normalised into rows
3. **Detect** email addresses inside `verified_contacts` / `potential_contacts`
4. **Generate** with Groq: a **PPD** (Professional Proposal Document as *pdfme* JSON) + email **subject/content**
5. **Render** the PPD to PDF with a pdfme template (`templates/pdfme/proposal-template.json`) into Supabase Storage
6. **Draft** an email (with the PDF attached) and **send it over SMTP** using credentials stored per sender account
7. **Review** everything in the dashboard: lead list → lead detail (job description, email subject + content, PPD)

---

## 1. Stack

| Concern | Choice |
| --- | --- |
| App | Next.js 15 App Router, React 19, TypeScript strict, `src/` + `@/*` |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`, theme tokens in `globals.css`) |
| Data | Supabase Postgres (RLS on, service-role access from the server), Supabase Storage (`proposals` bucket), Supabase Auth (magic link) |
| Client data | TanStack Query v5 hitting our own `/api` routes |
| Validation | Zod v4 for env, inbound payloads, and LLM output coercion |
| LLM | Groq (`llama-3.3-70b-versatile`, JSON mode) — proposal + email generation |
| PDF | pdfme (`@pdfme/generator`) with a repo-owned template |
| Email out | SMTP per sender account (nodemailer) or `resend` / `log` via env |
| Secrets | `API_MASTER_KEY` guards `/api`; SMTP passwords AES-256-GCM encrypted with `APP_ENCRYPTION_KEY` |

## 2. Structure

```
├── supabase/migrations/
│   ├── 0001_init.sql                      contacts, email_logs
│   └── 0002_leads_senders_proposals.sql   sender_accounts, leads, lead_contacts,
│                                          proposals, email_drafts, storage bucket
├── templates/pdfme/proposal-template.json # ← edit/export on pdfme.com, keep field names
├── src/
│   ├── app/
│   │   ├── (dashboard)/                   FRONTEND
│   │   │   ├── page.tsx                   overview (contacts + leads + sends)
│   │   │   ├── leads/page.tsx             ingested payloads, filters, search
│   │   │   ├── leads/[id]/page.tsx        job description + contacts + proposal + draft
│   │   │   ├── contacts/ emails/ settings/senders/ api-docs/
│   │   │   └── actions.ts                 sign-out server action
│   │   ├── api/                           BACKEND (route handlers)
│   │   │   ├── leads/route.ts             GET list (JSON) · POST ingest
│   │   │   ├── leads/[id]/route.ts        GET detail · PATCH status · DELETE
│   │   │   ├── leads/[id]/generate/route.ts   POST Groq → PPD + draft
│   │   │   ├── leads/[id]/pdf/route.ts    GET proposal PDF (render on demand)
│   │   │   ├── drafts/[id]/route.ts       GET · PATCH (edit subject/body/sender)
│   │   │   ├── drafts/[id]/send/route.ts  POST send over SMTP
│   │   │   ├── sender-accounts/route.ts   GET · POST (encrypts SMTP password)
│   │   │   ├── sender-accounts/[id]/…     PATCH · DELETE · POST test (verify)
│   │   │   ├── email/send/route.ts        POST send (API #2)
│   │   │   ├── email/route.ts             GET delivery log
│   │   │   ├── contacts/…                 manual contact list
│   │   │   └── health/route.ts            GET probe
│   │   ├── login/ · auth/callback/        magic-link auth
│   │   └── layout.tsx · globals.css
│   ├── components/
│   │   ├── leads/     leads-view, lead-workspace, proposal-card, draft-card, contacts-list
│   │   ├── contacts/ settings/ dashboard/ layout/ providers/ ui/
│   ├── lib/
│   │   ├── crypto.ts                      AES-256-GCM for stored secrets
│   │   ├── env.ts · env-extras.ts         validated env + groq/pdf config
│   │   ├── pdfme/                         template.ts (JSON import) + mapper.ts (PPD → slots)
│   │   ├── validation/                    lead.ts (payload normaliser), outreach.ts, email.ts, contact.ts
│   │   ├── api/                           client.ts + hooks.ts + outreach-hooks.ts
│   │   └── supabase/                      client / server / admin / middleware
│   ├── server/
│   │   ├── db/            leads.repo · contacts.repo · outreach.repo (proposals+drafts) · sender-accounts.repo · email-logs.repo
│   │   ├── services/      lead-ingest · proposal · proposal-sanitize · draft · email · smtp · pdf · groq.client · templates · prompts/
│   │   ├── http/          withApi · errors · responses · auth · rate-limit
│   │   └── queries.ts     Server-Component reads
│   └── types/             database.ts (generated-style) · lead.ts · domain.ts
```

Layering: `app/api/*` (transport) → `server/services` (orchestration) →
`server/db` (SQL) → `lib/supabase`. Components only ever call `/api`.

## 3. Data model

| Table | Purpose |
| --- | --- |
| `sender_accounts` | Our mailboxes: `from_email`, display name, signature, `smtp_host/port/secure/user`, `smtp_password_cipher` (encrypted), `daily_limit`, `is_default`, `status`, `last_verified_at` |
| `leads` | One row per payload: flattened job/client columns, `key_people`/`contact_information`/`raw_payload` as JSONB, `status`, generated `search` tsvector |
| `lead_contacts` | Every channel: `list_type` (verified/potential/company_page/linkedin/social/key_person), `channel` (email/phone/url/other), `contact_value`, `normalized_value`, `confidence`, `rationale`, `is_email`, `is_primary` |
| `proposals` | Groq output: `ppd` (JSONB → pdfme), `email_subject`, `email_content`, `pdf_path`, `pdf_status`, `version`, token usage |
| `email_drafts` | Draft first: `to_email`, `subject`, `body_text/html`, `attachments`, `sender_account_id`, `status` (draft/queued/sent/failed/cancelled) |
| `email_logs` | Delivery audit (now linked to `draft_id`, `proposal_id`, `sender_account_id`) |

Statuses on a lead: `received → enriched → proposal_ready → draft_created → sent`
(+ `failed`, `archived`).

## 4. The ingest contract

`POST /api/leads` accepts exactly your payload shape (all keys nullable; unknown
keys preserved in `raw_payload`; arrays of payloads accepted too):

```jsonc
{
  "job_information": { "job_id": null, "job_title": null, "job_url": null,
                       "industry": null, "job_location": null, "company_mentioned": null },
  "upwork_client":   { "client_name": null, "location": null },
  "key_people":      [],
  "contact_information": {
    "verified_contacts": [], "potential_contacts": [],
    "company_contact_pages": [], "linkedin_profiles": [], "social_media_profiles": []
  },
  "overall_confidence": "UNIDENTIFIED"
}
```

What happens next (`src/server/services/lead-ingest.service.ts`):

1. `normalizeLeadPayload()` — trims strings, maps `notes`/`reason` → `rationale`,
   `contact_type`/`type` label + value → `channel`, and flags
   `is_email` when the value matches `^[^@\s]+@[^@\s]+\.[a-z]{2,}$`.
2. Upsert `leads` on `dedupe_key` = `job_id`, else SHA-1 of `job_url`, else of
   `job_title + client_name` → re-posting the same job updates instead of duplicating.
3. Replace `lead_contacts` for that lead.
4. **Recipients** = emails found in `verified_contacts` + `potential_contacts`
   (a `key_people` email outranks a generic mailbox), ranked by list → confidence →
   name-known, with `info@/contact@/support@` penalised. Only the top 3 are used.
5. For each recipient → `generateProposal()`:
   * Groq JSON-mode call (`groq.client.ts`) with the prompt in
     `prompts/proposal.prompt.ts`
   * `sanitizeProposal()` coerces/clips every field, fills placeholders (`[TO CONFIRM]`)
     and caps list lengths (6/5/6/5/4/5) so it always fits the template slots
   * saves `proposals.ppd` + `email_subject` + `email_content`
   * renders the PDF (`pdf.service.ts`) and stores it at
     `proposals/{leadId}/{proposalId}-v{n}.pdf` (failure is recorded, never fatal)
   * creates the `email_drafts` row: subject/content + signature + PDF attachment
6. Lead status updated; per-recipient errors come back in `warnings[]`.

Flags: `?dry=true` (store only), `?auto=false`, `?regenerate=true` (new version),
`?senderAccountId=<uuid>`. Env default: `AUTO_ENRICH_LEADS=true`.

## 5. PPD → PDF (pdfme)

* `templates/pdfme/proposal-template.json` — **pdfme v6 shape**:

```jsonc
{
  "pdfmeVersion": "6.2.8",
  "basePdf": { "width": 210, "height": 297, "padding": [0, 0, 0, 0] }, // A4 in mm
  "schemas": [ [ /* page 1 fields */ ], [ /* page 2 */ ], [ /* page 3 */ ] ]
}
```

  84 fields over 3 pages, all `type: "text"`. **All coordinates are millimetres**
  (pdfme converts mm→pt: the rendered page comes out 595×842 pt = A4).
  20 of them are static captions (`readOnly: true`, e.g. `summary_label`,
  `deliverables_label`) and are intentionally *not* part of the PPD contract.
* `src/lib/pdfme/mapper.ts` — `ppdToPdfmeInputs()` returns **one record per
  document** (`[{…}]`), flattened across all pages, because in v6
  `inputs.length` = number of documents, not pages (2 inputs on a 3-page
  template would produce 6 pages). Model lists are expanded into fixed slots
  (`deliverable_1..6`, `approach_1..5`, `includes_1..6`, `assumptions_1..5`,
  `next_step_1..4`, `why_us_1..5`); unused slots are emitted as `""`.
* Re-design at <https://pdfme.com/template-design>, export the JSON, and
  overwrite the file **keeping the field names**. If you add fields, extend
  `ProposalPpd` (`src/types/lead.ts`), `sanitizeProposal()` and the mapper.
* Verified locally: rendering the sample PPD yields a 3-page, 595×842 pt PDF
  (~14 KB) with 0 unsupplied dynamic fields and 0 unknown input keys.
* Rendering runs server-side via `@pdfme/generator` (`generate`, with a
  `renderPdf` fallback for other builds) and uploads to the private `proposals`
  bucket. `GET /api/leads/:id/pdf?render=true` re-renders from the stored PPD —
  handy right after swapping a template.
* `PDF_PROVIDER=none` skips PDFs; the PPD JSON and dashboard view keep working.

> ⚠ **Keep the three pdfme packages on the same exact version.** They are pinned
> `6.2.8` (no caret) in `package.json`: `@pdfme/generator` declares its peers as
> `"latest"`, so `^5.x` + a 6.x `@pdfme/schemas` crashes at import time with
> *“The requested module '@pdfme/common' does not provide an export named
> 'createDynamicLayoutSplitRange'”*. If you bump one, bump all three.

## 6. Setup

```bash
npm install                       # Next 15 + Supabase + Groq(fetch) + pdfme 6.2.8 + nodemailer
cp .env.example .env.local
```

Then verify the toolchain you just installed:

```bash
npm run check          # tsc --noEmit + eslint
npm run build          # production build (24 routes)
node -e "console.log(require('@pdfme/generator') ? 'pdfme ok' : '')"  # no export-mismatch crash
```

Supabase (apply migrations in order — `0001` then `0002`):

```bash
supabase link --project-ref <ref> && supabase db push
# or paste both files into the SQL editor; the 0002 file also creates the
# private `proposals` storage bucket
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # optional demo rows
```

Required env (see `.env.example`):

| Var | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | service role is server-only |
| `API_MASTER_KEY` | `openssl rand -hex 32`; **required in production** — with it unset, `/api` is open in dev and answers `403` in prod |
| `APP_ENCRYPTION_KEY` | `openssl rand -hex 32` — encrypts SMTP passwords at rest |
| `GROQ_API_KEY` | from <https://console.groq.com/keys>. **Rotate any key that was ever pasted into a chat/ticket/ticket-tracker** — this repo never stores it in code |
| `GROQ_MODEL` / `PROPOSAL_LANGUAGE` / `AUTO_ENRICH_LEADS` | generation tuning |
| `PDF_PROVIDER` / `PDFME_TEMPLATE_PATH` | `pdfme` \| `none` |
| `EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_REPLY_TO` + `RESEND_API_KEY` or `SMTP_*` | fallback env-based sending; per-account SMTP wins when `senderAccountId` is given |

```bash
npm run dev        # http://localhost:3000
npm run check      # tsc --noEmit + eslint
npm run db:types   # regenerate src/types/database.ts after schema changes
```

## 7. Run it end to end

```bash
# 1. our two mailboxes (password is encrypted before it reaches Postgres)
curl -s -X POST http://localhost:3000/api/sender-accounts \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"label":"Studio Gmail","fromEmail":"hello@yourdomain.com",
       "smtpHost":"smtp.gmail.com","smtpPort":465,"smtpSecure":true,
       "smtpUser":"hello@yourdomain.com","smtpPassword":"<app password>","isDefault":true}'

curl -s -X POST http://localhost:3000/api/sender-accounts/<id>/test -H "x-api-key: $API_MASTER_KEY"
# → {"data":{"ok":true,"account":"Studio Gmail"}}

# 2. post a real payload (the JSON from your scraper)
curl -s -X POST "http://localhost:3000/api/leads" \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  --data-binary @lead.json
# → lead stored, contacts parsed, Groq wrote the PPD + subject/content, draft created

# 3. review in the dashboard: /leads → click a row
#    (or read it as JSON)
curl -s http://localhost:3000/api/leads/<leadId> -H "x-api-key: $API_MASTER_KEY"

# 4. send the draft over SMTP (PDF attached automatically when present)
curl -s -X POST http://localhost:3000/api/drafts/<draftId>/send -H "x-api-key: $API_MASTER_KEY"

# 5. audit
curl -s "http://localhost:3000/api/email?status=sent" -H "x-api-key: $API_MASTER_KEY"
curl -s -o proposal.pdf "http://localhost:3000/api/leads/<leadId>/pdf?download=true" \
  -H "x-api-key: $API_MASTER_KEY"
```

Dashboard pages: **Overview** · **Leads** (search/filter, click → detail) ·
**Lead detail** (job description, key people, every channel with its evidence,
PPD read view + raw JSON, draft editor, Send) · **Contacts** · **Email log** ·
**Senders** (add/test/remove mailboxes) · **API** (curl reference).

## 8. Deploy to Vercel

```bash
vercel --prod        # or push to GitHub → Import Project
```

1. Framework preset auto-detects **Next.js**; no `vercel.json` needed.
2. Add every var from `.env.example` to *Production* **and** *Preview*.
3. Supabase → Authentication → URL Configuration: add
   `https://<app>.vercel.app/**` + `/auth/callback`.
4. `GET /api/health` should answer `{"data":{"status":"ok"}}`; wire it to Vercel
   cron/monitoring if you want uptime checks.
5. PDF rendering runs inside the function — set **Maximum Function Duration** to
   ~60s for `/api/leads/*` (`maxDuration = 60` is already exported).
6. Outbound SMTP: Vercel blocks port **25**; use **465** (`smtpSecure=true`) or
   **587**. Gmail/Outlook require an **app password** (2FA on), and Resend/Postmark
   SMTP keys work too.
7. Browser links to `/api/*` (like the PDF button) need the session cookie or an
   `x-api-key`; in production either sign in on the dashboard or use
   `?url=true` to get a signed Storage link instead.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Every route returns 500 `internal_error` — “Invalid environment configuration: API_MASTER_KEY: Too small” | A blank value in `.env.local` (`API_MASTER_KEY=`) is now treated as **unset** (`lib/env.ts` drops empty strings before validating). Pull this fix; previously an empty optional var failed its own constraint. |
| `TypeError: fetch failed` on `/api/*` | The function could not reach `NEXT_PUBLIC_SUPABASE_URL` (offline sandbox, VPN, wrong project ref, or paused project). `/api/health` shows it as `"status":"degraded"` with the reason. |
| `upstream_error … Failed to list leads` | Migration `0002_leads_senders_proposals.sql` not applied yet (tables missing). |
| `pdf_unavailable` (409) from `/api/leads/:id/pdf` | `PDF_PROVIDER=none`, or no proposal generated yet — retry `?render=true`. |
| Crash at import: *“'@pdfme/common' does not provide an export named 'createDynamicLayoutSplitRange'”* | pdfme version skew. Keep `@pdfme/common`, `@pdfme/generator`, `@pdfme/schemas` on the **same exact version** (pinned `6.2.8`, no caret). |
| 500 responses hide the real reason | Outside production, `withApi` now echoes the message + top of the stack in `error.details` so you can debug without attaching a logger. |

In dev, `/api/*` is open when `API_MASTER_KEY` is empty (logged as `api_open_dev_mode`);
the same config in production answers `403` until you set a key.

## 10. Security notes

* The Groq key you pasted into chat should be **rotated** — treat it as public.
* SMTP passwords are `v1:iv:tag:ciphertext` AES-256-GCM; without
  `APP_ENCRYPTION_KEY` they cannot be saved or decrypted (changing the key
  invalidates stored passwords — re-save the accounts).
* `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and is only read from `src/server/**`;
  RLS stays enabled on every table with no public policies.
* Email bodies, PPDs and raw payloads contain personal data — keep the bucket
  private, and add retention if your jurisdiction needs it.
* Generation is untrusted input → LLM → stored text: the prompt forbids inventing
  prices/facts, and `sanitizeProposal()` caps lengths; still, **a human reviews the
  draft before `POST /api/drafts/:id/send`**. Nothing sends automatically.

## 11. Next steps

* [ ] Replace the sample `deliverables`/`pricing` wording with your real service catalogue
* [ ] Add `job_description` to the scraper payload so proposals get the full text
* [ ] Move bulk generation to a queue (Inngest/QStash) if you ingest >20 leads/hour
* [ ] Reply detection: IMAP polling or inbound webhook → set `status = replied`
* [ ] Flip `REQUIRE_SESSION = true` in `src/lib/supabase/middleware.ts` once auth users exist
