# Upwork Email Contact

Next.js 15 app that is **both the dashboard and the backend**, on **Supabase** +
**Vercel**:

1. **Ingest** an Upwork research payload (job info, client, key people, contacts) via `POST /api/leads`
2. **Store** every field — raw JSON kept as-is, contacts normalised into rows
3. **Detect** email addresses inside `verified_contacts` / `potential_contacts`
4. **Generate** with Groq: a **PPD** (Professional Proposal Document as *pdfme* JSON) + email **subject/content**
5. **Render** the PPD: `lib/pdfme/compiler.ts` generates a pdfme template from the content (A4, mm, page numbers) → `@pdfme/generator` → Supabase Storage
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
├── templates/pdfme/proposal-template.json # ← reference copy of one compiled doc (Designer import)
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
│   │   ├── pdfme/                         compiler.ts (PPD → template+inputs) + template.ts (types)
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
   * One Groq JSON-mode call (`groq.client.ts`) with the prompt in
     `prompts/proposal.prompt.ts` → returns **both** the PPD and the email
   * `sanitizeProposal(output, ctx)` coerces/clips every block, fills
     `[TO CONFIRM]` placeholders, and **overwrites** company / website / prepared-by /
     job title / job reference from env + the lead, so the model can never state
     our own details or invent a reply address. Any `references` item whose URL is
     not on our allowlist is dropped (the allowlist is empty today ⇒ no references
     ever ship).
   * saves `proposals.ppd` + `email_subject` + `email_content`
   * compiles + renders the PDF (`pdf.service.ts` → `lib/pdfme/compiler.ts`) and
     stores it at `proposals/{leadId}/{proposalId}-v{n}.pdf` (failure recorded, never fatal)
   * creates the `email_drafts` row: subject/content + signature + PDF attachment
6. Lead status updated; per-recipient errors come back in `warnings[]`.

Flags: `?dry=true` (store only), `?auto=false`, `?regenerate=true` (new version),
`?senderAccountId=<uuid>`. Env default: `AUTO_ENRICH_LEADS=true`.

## 5. PPD contract → compiled pdfme template

The document is **block-based**, and the pdfme template is generated from the
content per proposal — no fixed slots, so a proposal can be 2 pages or 8.

```jsonc
// proposals.ppd  (types in src/types/lead.ts; sample: examples/ppd-example.json)
{
  "company": "…", "document_title": "…", "subtitle": "…", "job_title": "…", "job_reference": "…",
  "prepared_for": "…", "prepared_by": "…", "rate": "…", "engagement": "…", "website": "…",
  "closing": "…",
  "sections": [{ "id": "workflow", "title": "Proposed workflow", "blocks": [ /* … */ ] }]
}
```

Seven block types, and nothing else: `paragraph {items[]}`, `bullets {items[]}`,
`numberedSteps {items:[{title,description}]}`, `capabilityMatrix
{items:[{requirement,approach}]}`, `keyValueTable {rows:[{label,value}]}`,
`references {items:[{name,url,verified}]}`, `note {text}`.

### `src/lib/pdfme/compiler.ts` — the template generator

Port of `compile_pdfme.py` from the Blueoak PDFme package. It flows the blocks
down an A4 page in **millimetres** and emits one positioned pdfme `text` field
per **wrapped line** (`paragraph_0007`, `table_key_0031`, …), starting a new page
when the cursor passes `y = 273`, then stamps every page with the rule, the job
title and `n / total`. Output: `{ template, inputs, pages, fieldCount }` where
`inputs` is a **single record for the whole document** (pdfme v6 counts
documents, not pages).

* Verified: for `examples/ppd-example.json` it produces **exactly** the same 3
  pages / 84 fields (same names, coordinates, colours) as the shipped Python
  compiler, and renders a 14.5 KB, 595×842 pt PDF on `@pdfme/generator` 6.2.8.
* Geometry stays inside the page for any length: a 4,243-word document compiled
  to 12 pages / 462 fields with 0 out-of-bounds fields and 0 mismatched keys.
* `templates/pdfme/proposal-template.json` is the **reference copy** of one
  compiled document — import it into <https://pdfme.com/template-design> to
  re-style, or use it as the visual spec. Runtime never reads it; the compiler
  writes an equivalent template per proposal.
* Old flat PPD rows (`deliverables[]`, `timeline_*`, `pricing_option_*`) are
  migrated to sections on the fly, so `?render=true` still works on proposals
  written before this change.
* Rendering runs server-side (`generate`, with a `renderPdf` fallback) and
  uploads to the private `proposals` bucket. It happens **only** on an explicit
  `GET /api/leads/:id/pdf?render=true` preview or inside
  `POST /api/drafts/:id/send` — never during generation — so a PDF can only ever
  be built from a PPD a human has reviewed (`proposals.ppd_reviewed_at`).
  Saving an edited PPD flips a ready PDF back to `pending` so the stale file is
  never sent. `PDF_PROVIDER=none` skips PDFs; the PPD JSON and dashboard work.

### Groq tokens, length and cost (measured on this pipeline)

Groq writes the *content*; the PDF is rendered locally and costs **zero** extra
tokens. `openai/gpt-oss-120b`: 131,072 context / 65,536 max completion tokens,
$0.15 per M input, $0.60 per M output (adjust `GROQ_PRICE_*` when pricing moves).

| `GROQ_REASONING_EFFORT` | wall clock | completion tokens (of which reasoning) | document | est. cost |
| --- | --- | --- | --- | --- |
| `low` | 6 s | 1,577 (28) | ~500 words → 3 pages | $0.00126 |
| `medium` (default) | 16 s | 2,755 (1,124) | ~880 words → **4 pages** | $0.00198 |
| unset (model default ≈ high) | 19 s | 8,000 (**6,296**) | 950 words, then truncated | $0.00511 |

Lessons baked into the code:
* **Reasoning is billed against the same completion cap** as the visible JSON, so
  `GROQ_MAX_TOKENS` (12,000) needs headroom; hitting it raises the
  `completion used N of the M-token budget` warning and a parse error that names
  the knob to turn.
* **Your tier's TPM is the real ceiling.** This key allows 8,000 tokens/minute, so
  a 12k request came back `413 Request too large … Limit 8000, Requested 10090`.
  The client therefore clamps the budget to `GROQ_TOKENS_PER_MINUTE − estimated
  prompt − 256`, and on a 413 it re-reads the limit from the error body, resizes
  and retries once (`groq_tpm_resize`).
* **A global word target does not steer this model** — 1,200–2,000 words produced
  504. The prompt now states per-section counts (3×65-word paragraphs, 6 matrix
  rows, 6 steps of 35–50 words, …), which is what moved it to 880 words / 4 pages.
* json mode occasionally returns `json_validate_failed` with an empty generation:
  two backed-off retries (cooler, then cooler + `reasoning_effort: low`).
* Page-count target: ~800–1,500 words ⇒ 4–6 pages here. `DOC_WORD_TARGET`
  (`proposal-sanitize.ts`) warns outside 700–2,600 words.

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

Supabase (apply migrations in order — `0001`, `0002`, then `0003`):

```bash
supabase link --project-ref <ref> && supabase db push
# or paste each file into the SQL editor. 0002 also creates the private
# `proposals` storage bucket; 0003 adds prompt_templates, proposals.ppd_reviewed_at
# / pdf_generated_at and email_drafts.recipient_source (custom recipients).
# Reading a prompt before 0003 degrades to the code default; stamping a PPD
# review or a custom recipient fails with the migration named in the error.
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
| `GROQ_MAX_TOKENS` / `GROQ_TOKENS_PER_MINUTE` / `GROQ_REASONING_EFFORT` | completion budget; effort is auto-tuned down on a tight TPM allowance |
| `PROPOSAL_COMPANY` / `PROPOSAL_WEBSITE` / `PROPOSAL_PREPARED_BY` / `PROPOSAL_RATE` | branding the model cannot override (falls back to `EMAIL_FROM` parsing) |
| `PDF_PROVIDER` / `PDFME_TEMPLATE_PATH` | `pdfme` \| `none` |
| `EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_REPLY_TO` + `RESEND_API_KEY` or `SMTP_*` | fallback env-based sending; per-account SMTP wins when `senderAccountId` is given |

```bash
npm run dev        # http://localhost:3000
npm run check      # tsc --noEmit + eslint
npm run db:types   # regenerate src/types/database.ts after schema changes
```

## 7. Run it end to end

The pipeline has four steps, and the PDF is deliberately last — nothing is
rendered until a human has approved the document it would be rendered from.

```bash
# 1. our two mailboxes (the SMTP password is encrypted before it reaches Postgres)
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
# → lead + contacts stored; with AUTO_ENRICH_LEADS=true Groq also writes the PPD

# ── STEP 1 · the document only ────────────────────────────────────────────
curl -s -X POST http://localhost:3000/api/leads/<leadId>/generate \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"toEmail":"client@example.com"}'        # or {"contactId":"<uuid from the payload>"}
# → ppd JSON, words/tokens/cost, pdf_status: "pending", no draft, no PDF

# ── STEP 2 · review it (dashboard tab "Edit PPD JSON", or PATCH here) ─────
curl -s -X PATCH http://localhost:3000/api/proposals/<proposalId> \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"ppd": { …the edited document… }}'
# → stamps ppd_reviewed_at; a previously rendered PDF is marked stale

# optional look before you commit to the email:
curl -s -o preview.pdf "http://localhost:3000/api/leads/<leadId>/pdf?render=true&download=true" \
  -H "x-api-key: $API_MASTER_KEY"

# ── STEP 3 · the email, written from the reviewed document ────────────────
curl -s -X POST http://localhost:3000/api/leads/<leadId>/generate-email \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"toEmail":"client@example.com","cc":["account@yourdomain.com"]}'
# → subject + plain-text body + a draft addressed to ANY mailbox you name

# ── STEP 4 · send: the PDF is compiled here and attached ──────────────────
curl -s -X POST http://localhost:3000/api/drafts/<draftId>/send -H "x-api-key: $API_MASTER_KEY"
curl -s -X POST http://localhost:3000/api/drafts/<draftId>/send \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" -d '{"attachPdf":false}'

# 5. audit
curl -s "http://localhost:3000/api/email?status=sent" -H "x-api-key: $API_MASTER_KEY"
curl -s http://localhost:3000/api/prompts -H "x-api-key: $API_MASTER_KEY"
```

Dashboard pages: **Overview** · **Leads** (search/filter, click → detail) ·
**Lead detail** (job description, key people, every channel with its evidence,
the four-step PPD workspace: read view · JSON editor · recipient picker with a
free-text address · both prompts inline) · **Email draft card** (to/cc/subject
/body, "render PDF + send") · **Contacts** · **Email log** · **Senders** ·
**Settings → Prompts** · **API** (curl reference).

### The two prompts

`GET/PUT /api/prompts` and `/settings/prompts` expose `ppd_document` (writes the
block PPD) and `email_draft` (writes subject/body from the reviewed PPD). Both
are stored in `prompt_templates` — a row only exists once you edit it, so a
reset falls back to the code default in
`src/server/services/prompts/proposal.prompt.ts`. Every prompt is a `{{variable}}`
template (`{{job_title}}`, `{{research_notes}}`, `{{rate}}`, `{{ppd_summary}}`, …;
`GET /api/prompts` lists them) and the exact text sent on the last run is kept
with the generation report so you can see what produced what. Unknown slots are
reported instead of silently blanked.

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
| `Cannot save prompt overrides: the prompt_templates table is missing … apply supabase/migrations/0003_prompt_templates_review_flow.sql` (502 from `PUT /api/prompts`) | Migration **0003** not applied. Until then prompt reads fall back to the code defaults, generation still works, and the review stamp / custom-recipient provenance are dropped from the write with a `db_columns_missing` log line — but you cannot save edited prompts. |
| PDF arrives unchanged after you edited the PPD | Cannot happen by design: saving a PPD flips `pdf_status` back to `pending`, and the PDF is re-compiled from the stored document at the next preview or send. If `ppd_reviewed_at` never appears in the response, 0003 is missing. |
| A draft send went out when you expected a dry run | `EMAIL_PROVIDER=log` is now a **hard stop**: with it set to `log`, a stored `senderAccountId` is not even decrypted and no SMTP socket is opened (`services/email.service.ts`). Set it back to `smtp` when you want real delivery. |
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
