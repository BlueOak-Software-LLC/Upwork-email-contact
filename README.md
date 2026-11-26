# Upwork Email Contact

Next.js 15 app that is **both the dashboard and the backend**, on **Supabase** +
**Vercel**:

1. **Ingest** an Upwork research payload (job info, client, key people, contacts) via `POST /api/leads`
2. **Store** every field — raw JSON kept as-is, contacts normalised into rows
3. **Detect** email addresses inside `verified_contacts` / `potential_contacts`
4. **Generate in your ChatGPT session**: the companion extension runs the prompt in the signed-in tab, and the server stores the **PPD** (Professional Proposal Document as *pdfme* JSON) + email **subject/content**
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
| Generation | **The user's signed-in ChatGPT tab** through `chatgpt-extension/`. No OpenAI/ChatGPT API key and no model API call from the server. The server prepares durable jobs, then parses/sanitises the answer |
| PDF | pdfme (`@pdfme/generator`) with a repo-owned template |
| Email out | SMTP per sender account (nodemailer) or `resend` / `log` via env |
| Email tracking | 1×1 pixel per recipient + `/c/` link redirects, recorded by Postgres RPCs (§7) |
| Secrets | `API_MASTER_KEY` guards `/api`; SMTP passwords are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY` |

## 2. Structure

```
├── supabase/migrations/
│   ├── 0001_init.sql                      contacts, email_logs
│   ├── 0002_leads_senders_proposals.sql   sender_accounts, leads, lead_contacts,
│   │                                      proposals, email_drafts, storage bucket
│   ├── 0003_prompt_templates_review_flow.sql  prompt_templates, ppd_reviewed_at,
│   │                                          pdf_generated_at, recipient_source
│   ├── 0004_job_description_ingestion.sql job_description in the search tsvector,
│   │                                      recipient-less proposal version lane,
│   │                                      leads_awaiting_recipient view
│   ├── 0005_email_tracking.sql            email_logs engagement columns,
│   │                                      tracked_links, tracking_events,
│   │                                      record_tracking_event / record_log_outcome /
│   │                                      purge_tracking_events (service role only)
│   ├── 0006_ai_settings.sql               legacy table from the removed model API; unused
│   ├── 0007_lead_list_view.sql            counted public.lead_list view + created_at index
│   ├── 0008_chatgpt_session_followups.sql  chatgpt_jobs, follow-up draft columns,
│   │                                      follow_up prompt key
│   ├── 0009_chatgpt_completion_claim.sql  completing status + one-winner finalise
│   ├── 0010_sender_profile.sql            sender profile fields: role, phone,
│   │                                      WhatsApp, LinkedIn, website, location,
│   │                                      experience, skills
│   └── 0011_retire_ai_settings.sql        drops the unused API-key table,
│                                          defaults proposals to chatgpt-session
├── chatgpt-extension/                     MV3 bridge: types the prompt in the signed-in ChatGPT tab
├── public/fonts/                          Source Sans 3 (OFL) used by the PDF compiler
├── templates/pdfme/proposal-template.json # ← reference copy of one compiled doc (Designer import)
├── src/
│   ├── app/
│   │   ├── (dashboard)/                   FRONTEND
│   │   │   ├── page.tsx                   overview (contacts + leads + sends + opens)
│   │   │   ├── leads/page.tsx             ingested payloads, filters, search
│   │   │   ├── leads/[id]/page.tsx        job description + contacts + proposal + draft
│   │   │   ├── contacts/ emails/ emails/[id]/ settings/senders/ settings/prompts/
│   │   │   │   settings/tracking/ api-docs/
│   │   │   └── actions.ts                 sign-out server action
│   │   ├── o/[token]/route.ts             GET pixel (public, no session, always a gif)
│   │   ├── c/[token]/route.ts             GET tracked link → record click → 302 (public)
│   │   ├── api/                           BACKEND (route handlers)
│   │   │   ├── leads/route.ts             GET list (JSON) · POST ingest
│   │   │   ├── leads/[id]/route.ts        GET detail · PATCH status · DELETE
│   │   │   ├── leads/[id]/generate/route.ts   POST step 1 → prepare PPD ChatGPT job
│   │   │   ├── leads/[id]/generate-email/route.ts  POST step 2 → prepare email job
│   │   │   ├── leads/[id]/pdf/route.ts    GET proposal PDF (render on demand)
│   │   │   ├── chatgpt/jobs/route.ts     POST prepare · GET jobs for a lead
│   │   │   ├── chatgpt/jobs/[id]/…       start · complete · fail · cancel
│   │   │   ├── drafts/[id]/route.ts       GET · PATCH (edit subject/body/sender)
│   │   │   ├── drafts/[id]/send/route.ts  POST send over SMTP
│   │   │   ├── sender-accounts/route.ts   GET · POST (encrypts SMTP password)
│   │   │   ├── sender-accounts/[id]/…     PATCH · DELETE · POST test (verify)
│   │   │   ├── email/send/route.ts        POST send (API #2)
│   │   │   ├── email/route.ts             GET delivery log (+ engagement filter)
│   │   │   ├── email/[id]/route.ts        GET one message: row + links + timeline
│   │   │   ├── tracking/stats/route.ts    GET overview numbers + effective config
│   │   │   ├── tracking/events/route.ts   GET raw open/click stream
│   │   │   ├── tracking/outcome/route.ts  POST reply / meeting / not_interested
│   │   │   ├── maintenance/purge/route.ts POST retention sweep (CRON_SECRET)
│   │   │   ├── contacts/…                 manual contact list
│   │   │   └── health/route.ts            GET probe
│   │   ├── login/ · auth/callback/        magic-link auth
│   │   └── layout.tsx · globals.css
│   ├── components/
│   │   ├── leads/     leads-view, lead-workspace, proposal-card, draft-card, contacts-list
│   │   ├── chatgpt/   session-provider, session-drawer, session-trigger
│   │   ├── contacts/ settings/ (senders · prompts · tracking) dashboard/ layout/ providers/ ui/
│   ├── lib/
│   │   ├── job-ref.ts                     canonical job_id / job_url: the dedupe identity
│   │   ├── crypto.ts                      AES-256-GCM for stored secrets
│   │   ├── env.ts · env-extras.ts         validated env + pdf/brand config
│   │   ├── pdfme/                         compiler.ts (PPD → template+inputs) + template.ts (types)
│   │   ├── validation/                    lead.ts (payload normaliser), outreach.ts, email.ts, contact.ts
│   │   ├── api/                           client.ts + hooks.ts + outreach-hooks.ts + chatgpt.ts
│   │   ├── chatgpt/                       extension bridge, job API types, prompt handoff
│   │   ├── services/lead-delete.service.ts  permanent removal + PDF storage cleanup
│   │   └── supabase/                      client / server / admin / middleware
│   ├── server/
│   │   ├── db/            leads.repo · contacts.repo · outreach.repo (proposals+drafts) · sender-accounts.repo · email-logs.repo · tracking.repo · chatgpt-jobs.repo
│   │   ├── services/      lead-ingest · proposal · proposal-sanitize · draft · email · smtp · pdf · templates · prompts/ · tracking/ · chatgpt.service
│   │   ├── http/          withApi · errors · responses · auth · rate-limit · id
│   │   └── queries.ts     Server-Component reads
│   ├── types/             database.ts (generated-style) · lead.ts · domain.ts
│   └── tests/             tracking-sql (real Postgres via PGlite) · tracking-body ·
│                          tracking-routes · tracking-api · email-tracking · proposal-ppd ·
│                          chatgpt-parse · chatgpt-jobs-sql · sender-profile · email-threading
├── scripts/check-tracking.mjs  # npm run check:tracking — is 0005 applied and reachable?
```

Layering: `app/api/*` (transport) → `server/services` (orchestration) →
`server/db` (SQL) → `lib/supabase`. Components only ever call `/api`.

## 3. Data model

| Table | Purpose |
| --- | --- |
| `sender_accounts` | Our mailboxes: `from_email`, display name, signature, `smtp_host/port/secure/user`, `smtp_password_cipher` (encrypted), `daily_limit`, `is_default`, `status`, `last_verified_at` |
| `leads` | One row per payload: flattened job/client columns, `key_people`/`contact_information`/`raw_payload` as JSONB, `status`, generated `search` tsvector |
| `lead_contacts` | Every channel: `list_type` (verified/potential/company_page/linkedin/social/key_person), `channel` (email/phone/url/other), `contact_value`, `normalized_value`, `confidence`, `rationale`, `is_email`, `is_primary` |
| `proposals` | ChatGPT-session output: `ppd` (JSONB → pdfme), `email_subject`, `email_content`, `pdf_path`, `pdf_status`, `version` |
| `email_drafts` | Draft first: `to_email`, `subject`, `body_text/html`, `attachments`, `sender_account_id`, `status` (draft/queued/sent/failed/cancelled) |
| `email_logs` | Delivery audit (now linked to `draft_id`, `proposal_id`, `sender_account_id`) + engagement: `tracking_token`, `open_count`, `click_count`, `unique_click_count`, `first/last_open_at`, `first/last_click_at`, `last_event_at`. `status` stays delivery-only — `sent` and `opened` are different axes |
| `tracked_links` | One row per clickable URL per message: `log_id`, `token`, `destination_url`, `label`, `position`, `click_count`, `last_clicked_at`. `on delete cascade` with the message |
| `tracking_events` | Append-only timeline (`open`, `click`, `sent`, `reply`, `meeting`, `not_interested`): `log_id`, `link_id`, `occurred_at`, `user_agent`, `meta`. No IP column, ever |
| `chatgpt_jobs` | Durable prompt hand-off: `kind` (`ppd_document`/`email_draft`/`follow_up`), `status` (`queued`→`running`→`completing`→`completed`), `prompt_system`/`prompt_user`, `context`, `response_text`, `error`. One live job per `(lead_id, kind)`; only the request that claims `completing` writes the proposal/draft; stale jobs expire after 45 minutes |
| RPCs | `record_tracking_event(kind, token, agent, at)`, `record_log_outcome(log_id, kind, at)`, `purge_tracking_events(before)` — `security definer`, `grant revoke from public/anon/authenticated`, service role only |

Statuses on a lead: `received → enriched → proposal_ready → draft_created → sent`
(+ `failed`, `archived`).

Engagement is never stored in `email_logs.status`. It is derived, in this order:
`click_count > 0 → clicked`, `open_count > 0 → opened`, `tracking_token is null → untracked`,
otherwise `sent`. So a message that bounced and was somehow opened still reports the bounce.

## 7. Email tracking

Every delivered message gets a 24-byte URL-safe token and a 1×1 transparent GIF at the bottom of
its HTML body:

```
<img src="https://<TRACKING_DOMAIN>/o/<token>.gif" width="1" height="1" alt=""
     style="display:none" aria-hidden="true">
```

When a mail client loads that image, `GET /o/<token>.gif` records an `open` and returns the GIF —
`200`, `image/gif`, `cache-control: no-store`, for a valid token, a forged one, a rate-limited one
and a broken database alike. A reply that leaks "that token does not exist" is a oracle for
enumerating who received what, so the endpoint never distinguishes anything.

With `LINK_TRACKING=true`, every `http(s)` link in the body is rewritten to
`https://<TRACKING_DOMAIN>/c/<link-token>` and the destination is stored in `tracked_links`.
`GET /c/<token>` re-validates the destination at click time, records the click and issues a `302`.

### What makes the numbers worth reading

`public.record_tracking_event()` (in `supabase/migrations/0005_email_tracking.sql`) is the only
writer, and it does four things a naive `update ... open_count = open_count + 1` cannot:

- **Dedupes**: an identical `open` for the same message from the same truncated user-agent within
  60 seconds is dropped. Gmail Image Proxy, Outlook's Safe Links and Apple's privacy proxy each
  fetch the pixel on their own schedule; counting them would double every open.
- **Caps**: 40 opens per message per day, 200 clicks per link per day. A bot that hammers the URL
  cannot turn a 0 % open rate into a 100 % one.
- **Locks**: `select ... for update` on the message row, so two simultaneous proxy fetches cannot
  lose a count.
- **Refuses**: a token that is not 22–64 URL-safe characters returns `found:false` without touching
  a row; the endpoints run no arbitrary SQL and store no IP.

Unique openers are counted as distinct messages opened (`email_logs.first_open_at is not null`);
unique clickers are messages with at least one click. `click_count` counts every click, while
`unique_click_count` counts distinct links — that difference is the "opened twice, clicked once"
signal.

### Recipient domains

`GET /api/tracking/stats` accepts `days` from 1 to 365 (the Overview's 12-month graph uses
the full year). It also rolls the window up by the domain after `@` in `to_email`:
`delivered`, `opened`, `clicks`, `openRate`, `clickRate`, busiest first (top 15). `/settings/tracking`
renders it as **Recipient domains**, because a low open rate on `outlook.com` or one corporate
domain is a deliverability signal, not a weak subject line. The same grouping filters the delivery
log: `/emails?domain=acme.com`, or `GET /api/email?domain=acme.com` (validated server-side,
matched against the end of `to_email` so `acme.com` does not also match `notacme.com`).

This adds no new data collection: the domain is derived from the recipient address already stored on
the row. `NULL`/`log`-only sends simply do not appear in the rollup.

### Where tracking is deliberately off

| Case | Why |
| --- | --- |
| `EMAIL_PROVIDER=log` | nothing reaches an inbox; a pixel that cannot load would train you to ignore zeros |
| `track: false` / `EMAIL_TRACKING=false` | one send, or the whole app |
| `skipLog: true` | the token would belong to no row, so the event would be written off |
| body with no HTML part | `textToHtml()` output is tracked, but a plain-text-only body cannot render a pixel — and no `<img>` tag pasted into a plain body is ever re-activated |
| dashboard preview | `/emails/[id]` renders the stored body with the pixel stripped (`stripTrackingPixels`); the Overview "what a recipient gets" sample uses `preview: true`, which mints no token |
| the proposal PDF | its links go to your portfolio, not through us; rewriting them would put a redirector between a client and the work |

Manual outcomes (`reply`, `meeting`, `not_interested`) exist because the app sends mail but never
reads a mailbox. They are recorded on the same timeline as opens and clicks, so "opened 4×, replied,
booked" is one story in one table.

### Turning it on

```bash
# 1. apply the migration once (Supabase SQL editor, after 0001–0004)
#    supabase/migrations/0005_email_tracking.sql

# 2. tracked links use the branded domain (default; set it only to change it)
TRACKING_DOMAIN=https://email.blueoaksoftware.cloud
EMAIL_TRACKING=true
LINK_TRACKING=true
TRACKING_RETENTION_DAYS=365
CRON_SECRET=$(openssl rand -hex 32)   # only for the purge endpoint

# 3. ask the database whether that is true
npm run check:tracking
```

`check:tracking` reads `.env.local`, probes `email_logs`, `tracked_links`, `tracking_events` and the
RPCs through PostgREST, and prints what is missing — it calls `record_tracking_event` with a token
that belongs to nothing (which answers `found:false` and writes no row), sends no email, and prints
no secret. PostgREST confirms the RPC signatures by name, so a wrong parameter list shows up here
rather than as a silent 502 in production.

Retention: `POST /api/maintenance/purge` (bearer `CRON_SECRET`, `x-vercel-cron: 1`, or an API key)
deletes event rows older than `TRACKING_RETENTION_DAYS` and then **recomputes every counter** from
the events that remain, under an advisory lock. A send from last year keeps "opened 3×, clicked 1×"
without keeping the request log. Add to `vercel.json` when you want it automatic:

```json
{ "crons": [{ "path": "/api/maintenance/purge", "schedule": "0 4 * * *" }] }
```

### Two things that will bite you

1. **Vercel Deployment Protection.** If "Real requests only" is on, `GET /o/…gif` returns `401` to
   every recipient and every counter stays at zero forever. Exempt the two prefixes under
   Vercel → Project → Settings → Deployment Protection → Protected Functions (`/o/*`, `/c/*`).
   Our own middleware already treats both as public — `PUBLIC_PATHS` in
   `src/lib/supabase/middleware.ts` — and the matcher excludes `*.gif`, so nothing on our side can
   require a session there. The risk is entirely Vercel's edge in front of us.
2. **Opens are not reads.** An open means one image request from an unknown client. Some providers
   pre-fetch every image; some block all of them. Report opens as activity, never as interest — the
   dashboard says "tracked opens" rather than "views" everywhere, and `/emails/[id]` keeps the raw
   user-agent list next to the counters so you can see who actually fetched it.

## 4. The ingest contract

`POST /api/leads` is listed in the middleware's public paths because the scraper
has no Supabase session cookie. That does **not** make it unauthenticated: the
route calls `requireApiKey` and accepts only `x-api-key: $API_MASTER_KEY` (or a
signed-in user). Without this exception the production middleware redirected the
scraper to `/login` before the route could read the key.

`POST /api/leads` accepts exactly your payload shape — every key nullable, empty
strings and empty arrays welcome, unknown keys preserved verbatim in
`raw_payload`, and a bare array of payloads accepted too:

```jsonc
{
  "job_information": {
    "job_id": null,
    "job_title": null,
    "job_description": null,   // ← the post text: what the PPD and the email are written from
    "job_url": null,
    "industry": null,
    "job_location": null,
    "company_mentioned": null
  },
  "upwork_client":   { "client_name": null, "location": null },
  "key_people":      [],
  "contact_information": {
    "verified_contacts": [], "potential_contacts": [],
    "company_contact_pages": [], "linkedin_profiles": [], "social_media_profiles": []
  },
  "overall_confidence": ""     // HIGH | MEDIUM | LOW | UNIDENTIFIED | "" (→ UNIDENTIFIED)
}
```

The five `contact_information` lists accept objects (the documented shape) or
bare strings; a string is promoted to `{ "url": … }` for the three link lists
and to `{ "contact_value": … }` for verified/potential contacts, so a scraper
that writes a plain list of URLs does not lose them.

**`job_information.job_description` is the primary input for generation.** It is
stored as-is in `leads.job_description` (migration `0004` also folds it into the
`search` tsvector, and `/api/leads?q=` matches it), clipped to 3,600 characters
when embedded, and injected into **both** prompts — `ppd_document` (labelled
"THE POST TEXT", the rule being that every claim about the client traces to it, the
title or the research notes, while the plan itself — timeline, milestones, formats,
indicative range — is the writer's to decide, with no bracketed placeholders) and
`email_draft` (which must open by naming one concrete detail from it, mirrors
the reviewed PPD's approach, puts 1–2 verified reference links inline in the
experience paragraph, answers every question, and returns exactly
`{ "email": { "subject", "content" } }`). It is also accepted at the top
level (`job_description`), as `job_information.description`, and as an array of
paragraph strings or `{ "text": … }` blocks. A payload with no description is not
an error: the prompt then says so explicitly and writes from title + industry +
company + research notes.

What happens next (`src/server/services/lead-ingest.service.ts`):

> `examples/lead-description-only.json` is this envelope with only a post body
> filled in — every other field null — and it still produces a reviewable
> document.

1. `normalizeLeadPayload()` — trims strings, maps `notes`/`reason` → `rationale`,
   `contact_type`/`type` label + value → `channel`, flags `is_email` on
   `^[^@\s]+@[^@\s]+\.[a-z]{2,}$`, and turns `""` into null rather than an error.
2. **Match before inserting** (`leadsRepo.findByJobRef`, `src/lib/job-ref.ts`).
   A payload is the same job when **either** identifier matches: `job_id`, or the
   job link. Both are compared in canonical form — the link loses `www.`, the
   fragment and tracking parameters (`?src=`, `utm_…`), and the id is read out of
   the path when it is embedded there (`/jobs/~02<id>` → `<id>`, `?job_id=<id>` →
   `<id>`) — because Upwork gives the same post two different-looking URLs. The
   stored `job_id` is normalised the same way, so `~02…` never becomes a second
   identity. Order of proof: `job_id` equality → `job_url` equality → `dedupe_key`
   → one `%id%` substring probe of `job_url` (a lead stored from a link alone has
   `job_id = null`, so an id-only payload could not otherwise find it; it runs
   only after the equality probes miss, and only for ids of 6+ characters).
   A match **adds nothing and changes nothing** — no status reset, no contact
   rewrite — and answers `duplicate: { leadId, matchedBy }`; `?refresh=true` is
   the explicit way to overwrite. If neither identifier is present, `dedupe_key`
   falls back to SHA-1 of `job_title + client_name`, then of the **description +
   company + industry**: hashing the empty string instead would fold unrelated
   posts into one row and let a later payload silently overwrite an earlier one.
3. `replaceContacts` rewrites `lead_contacts` but **keeps manual contacts**
   (addresses a human typed in), so re-ingesting never deletes a recipient you chose.
4. **Recipients** = emails in `verified_contacts` + `potential_contacts` (a
   `key_people` email outranks a generic mailbox), ranked list → confidence →
   name-known, `info@/contact@/support@` penalised, top 3 used.
5. **Nothing is generated by default.** The lead is stored (`received`, or
   `enriched` when it has a channel) and the pipeline stops. Only an explicit
   `?auto=true` asks this request to write: each recipient then gets **step 1
   only**, a PPD from `generatePpdDocument()`. No email copy, no draft, no PDF.
   `AUTO_ENRICH_LEADS` no longer turns this on; setting it now logs an
   `ignored` diagnostic so an old deployment cannot silently spend tokens.
   * **No address in the payload but the post text is there** → one
     recipient-less PPD is still written (`proposals.lead_contact_id is null`,
     its own version lane from `0004`) and the response warns
     *"the PPD was written from the post itself; give the email step a `toEmail`"*.
   * Nothing to write from at all → `generation.skipped` with the reason.
6. Model output goes through `sanitizePpd(raw, ctx)`: block types coerced, lengths
   clipped, and company / website / prepared-by / job title / job reference
   **overwritten** from env + the lead, so the model can never state our details
   or invent a reply address. `references` entries whose URL is not on our
   allowlist are dropped (allowlist empty ⇒ nothing ships).
7. Lead status is stamped (and returned) as `proposal_ready`; per-recipient errors
   come back in `warnings[]`.

Flags: `?auto=true` (the only way to generate inside this request),
`?dry=true` (store only), `?regenerate=true` (new version),
`?refresh=true` (overwrite a matched lead instead of reporting it),
`?senderAccountId=<uuid>`. A payload arrives, nothing is generated, and the
reviewer clicks **Generate PPD** in the lead workspace.

## 5. PPD contract → compiled pdfme template

The document is **block-based**, and the pdfme template is generated from the
content per proposal — no fixed slots. The prompt targets 450–700 words for
focus, and the compiler paginates to **as many A4 pages as the reviewed content
needs** instead of clipping a longer document.

```jsonc
// proposals.ppd  (types in src/types/lead.ts; sample: examples/ppd-example.json)
{
  "document_title": "…", "subtitle": "…", "prepared_for": "…",
  "prepared_by": "…", "prepared_role": "…",
  "sender_email": "…", "sender_phone": "…", "sender_whatsapp": "…",
  "sender_linkedin": "…", "sender_website": "…", "sender_location": "…",
  "date": "…", "valid_until": "…", "job_title": "…", "job_reference": "…",
  "rate": "…", "engagement": "…", "closing": "…",
  "sections": [{ "id": "workflow", "title": "Proposed workflow", "blocks": [ /* … */ ] }]
}
```

There is no company field. The person is the document: name, role, email, phone,
WhatsApp, LinkedIn, website and location are stamped from the sender profile
selected in the lead workspace (Settings → Senders & profile).

Seven block types, and nothing else: `paragraph {items[]}`, `bullets {items[]}`,
`numberedSteps {items:[{title,description}]}`, `capabilityMatrix
{items:[{requirement,approach}]}`, `keyValueTable {rows:[{label,value}]}`,
`references {items:[{name,url,verified}]}`, `note {text}`.

### `src/lib/pdfme/compiler.ts` — the template generator

It flows the blocks down an A4 page in **millimetres** and emits one positioned
pdfme `text` field per **wrapped line** (`paragraph_0007`, `table_key_0031`, …).
The layout is deliberately simple: a navy identity band (name, role, contact), a
title/subtitle, a prepared-for/date block, then sections. Section headings stay
with the first block, and a key/value table is never split across a page break.
Output: `{ template, inputs, pages, fieldCount }` where `inputs` is a **single
record for the whole document** (pdfme v6 counts documents, not pages).

* Font: **Source Sans 3** (OFL, `public/fonts/`) is registered through
  `options.font`; `fontName` selects the regular or semibold face. A familiar,
  readable sans is the point — no designer display face.
* Pagination: the builder opens a new page whenever a block does not fit and
  repeats the footer with the new page number. Nothing is clipped; the prompt
  separately targets 450–700 words / 4–6 sections for focus.
* `templates/pdfme/proposal-template.json` is the **reference copy** of one
  compiled document — import it into <https://pdfme.com/template-design> to
  re-style, or use it as the visual spec. Runtime never reads it; the compiler
  writes an equivalent template per proposal.
* Old flat PPD rows (`deliverables[]`, `timeline_*`, `pricing_option_*`) are
  migrated to sections on the fly, so `?render=true` still works on proposals
  written before this change. Legacy `company`/`website` values are ignored.
* Rendering runs server-side (`generate` with the text/line/rectangle plugins and
  the bundled fonts) and uploads to the private `proposals` bucket. It happens
  **only** on an explicit `GET /api/leads/:id/pdf?render=true` preview or inside
  `POST /api/drafts/:id/send` — never during generation — so a PDF can only ever
  be built from a PPD a human has reviewed (`proposals.ppd_reviewed_at`).
  Saving an edited PPD flips a ready PDF back to `pending` so the stale file is
  never sent. `PDF_PROVIDER=none` skips PDFs; the PPD JSON and dashboard work.

### Identity, placeholders and the sign-off

Everything that says **who is writing** comes from the selected sender profile —
never from the model, and never from a bracket a human has to fill in:

| Place | What it prints |
| --- | --- |
| PDF identity band | full name, role, email, phone, WhatsApp, LinkedIn, website, location |
| PDF client/date block | `prepared_for`, date, valid-until, job reference |
| PDF footer | name · role · email and `Page n of total` |
| `ppd.prepared_by` / `prepared_role` / `sender_*` / `date` / `valid_until` | stamped by `sanitizePpd` / `sanitizeEditedPpd`; model output for these fields is discarded |
| Every email | `Best regards,` / name / role / contact line — appended by `sanitizeEmail()` **after** the model stops writing, and any sign-off the model invented is cut (only the last few short lines are considered, so "Thanks for the detailed post." in the body survives) |

No company or studio name appears anywhere. The profile is chosen per lead in
the PPD card; without an explicit choice the default active sender is used.
Environment `PROPOSAL_*` values are only a fallback for a fresh install with no
sender row yet.

The prompt tells the writer to **decide** rather than hedge: timeline, milestone
split, revision rounds, file formats, tooling and an indicative USD range are
written as recommendations, and a detail that genuinely cannot come from the post
turns into a plain sentence ("we would confirm the pallet dimensions at kickoff")
or a line in Questions. Square brackets, `TBD` and `N/A` are forbidden outright.

Nothing depends on the model obeying. `deBracket()` in
`src/server/services/proposal-sanitize.ts` runs on every string the model or an
editor produces:

| Token | Becomes |
| --- | --- |
| `[TO CONFIRM]`, `TBC`, `TBD`, `[...]`, `[?]`, `[TODO: …]` | "to be confirmed on the kickoff call" |
| `[YOUR NAME]`, `[YOUR COMPANY]`, `[WEBSITE]`, `[EMAIL]` | the sender profile name, role, site and email |
| `[YOUR PRICING]`, `[RATE]`, `[BUDGET]` | "indicative — confirmed after a short scoping call" |
| `[START DATE]`, any all-caps token | the kickoff wording |
| `[client logo files]` | "the client logo files" — the meaning stays, the brackets go |

A phrase the sentence already contains is **dropped instead of inserted**, so
`"[YOUR PRICING] indicative — confirmed after a scoping call"` collapses to one
copy. If a bracket somehow survives, `assertPpdShape` reports it as a sanitizer
bug ("report this, do not fill them by hand") rather than telling you to complete
a form field, and `findBracketTokens()` counts what the model left so the
rewritten lines get re-read.

Older documents upgrade themselves: saving a PPD keeps the identity stored on the
document (or the current profile when a field is missing), and
`renderProposalPdf()` fills only missing identity fields at render time. A PPD
approved by its author never changes name under them at send time.

### No model API — the signed-in ChatGPT session writes the answer

PPD and email generation no longer call Puter, Groq, Gemini or OpenAI. The
server only renders the prompt; the companion extension in
`chatgpt-extension/` types it into the ChatGPT tab the user is already signed in
to, waits for the answer, and posts the raw text back. The server parses,
sanitises and stores it exactly as before, so the PPD contract and review flow
are unchanged.

1. The dashboard prepares a row in `chatgpt_jobs` and returns the prompt.
2. The extension receives it over `chrome.runtime.connect(EXTENSION_ID)`, reuses
   the ChatGPT tab and conversation already open, types the prompt once, starts it,
   reports **waiting** immediately, and reads the completed assistant turn.
   Copy is only taken after the stop control disappears and only when the
   clipboard holds the JSON shape the job needs; otherwise Copy is clicked again.
3. The content script saves the answer and retries until the worker acknowledges
   it; the dashboard then posts it to `/api/chatgpt/jobs/:id/complete`. That route
   parses JSON, applies `sanitizePpd`/`sanitizeEmail`, and writes the proposal or
   draft. A failed parse stays retryable instead of half-saving a document.

Everything is visible in the **ChatGPT session** drawer: connection state, queue,
prompt transcript, progress, a timestamped **Extension log** (Queue, Open,
Prompt, Input, Sent, Wait, Answer, Copy, Handoff, Result, Done), errors,
Cancel/Run, and a textarea for pasting
an answer by hand when the extension cannot be installed. There is deliberately no
iframe: ChatGPT cannot be embedded usefully, so the drawer shows the job and the
extension drives the real tab in the background.

**Setup:** load `chatgpt-extension/` unpacked (see its README), keep
`NEXT_PUBLIC_CHATGPT_EXTENSION_ID=phieeciapeplplficoclmjenfbmbdcke`, and sign in
to ChatGPT once in that browser profile. Each user brings their own session; the
server never sees ChatGPT cookies. `APP_ENCRYPTION_KEY` is now only for SMTP
passwords.

**Prompt templates** live in `/settings/prompts`: `ppd_document`, `email_draft`
and `follow_up`. They are global (any dashboard user can edit them), so treat
that page as workspace configuration. Token/temperature fields still exist on
old rows but the ChatGPT session ignores them. A saved `email_draft` row wins
over the code default: after upgrading, reset it on Settings → Prompts (or
delete the row) to receive the new exact `subject`/`content` contract and the
inline-reference instructions.

**Console logs.** The server prints exactly two JSON lines in normal operation:
`leads_received` (the lead payloads accepted by `POST /api/leads`) and
`chatgpt_response_received` (the answer handed back by the extension). Request
lines, prompt preparation, status touches, tracking and other internal steps are
suppressed centrally in `src/lib/logger.ts`; set `LOG_LEVEL=debug` to see the
full trail while debugging. The `EMAIL_PROVIDER=log` dry run no longer prints the
message body either — the row at `/emails` is the record.

The default PPD prompt asks for 450–700 words in 4–6 sections, and explicitly
forbids company branding, invented case studies and bracketed placeholders. The
default email prompt asks for 180–260 technical words (up to 380 when there are
five or more questions), uses web search only for real official product/app-store
references (never presented as the writer's own work), puts those links inline
in the experience/approach paragraph, and answers
every question in the client's order before the single 15-minute-call ask.
When the post contains direct questions, `extractQuestions()` sends them as
`{{job_questions}}` and the prompt requires one direct answer per question.

The default email prompt does three things a model usually skips:

1. **Researches real products** that solve the client's problem. Only official
   product sites, official docs, `apps.apple.com` and `play.google.com` are
   accepted; blogs, listicles, review/aggregator sites, social posts, agencies,
   affiliate/referral URLs and shorteners are rejected by the prompt **and** by
   `sanitizeEmail()`. If the model cannot verify a product, it returns an empty
   list instead of inventing a URL.
2. **Uses only real experience** from the selected profile
   (`experience_summary` / `skills`). Invented employers, metrics or years are
   forbidden.
3. **Answers every direct question** from the job post, in order, before asking
   for a call. The client should not have to repeat the brief.

**Follow-ups** are separate `email_drafts` rows: `sequence` (1, 2, …),
`parent_draft_id` and `purpose` (`initial`/`follow_up`). A follow-up is offered
only after a `sent` draft to the same contact, and the prompt includes the
previous emails so the new message continues the thread instead of starting over.
On SMTP sends the previous message's RFC `Message-ID` is forwarded as
`In-Reply-To` / `References`, so mail clients group the follow-up with the first
message instead of relying on the subject alone.

**Several people or tabs on one lead.** Preparing is serialised by a unique live
job per `(lead_id, kind)`. Claiming `queued → running` decides which browser may
type the prompt, and only `running → completing` may write the proposal/draft.
The owning tab resumes its own run after a reload (per-tab `sessionStorage`);
other tabs show the same job and wait for the result instead of typing it again.
> ⚠ **Keep the three pdfme packages on the same exact version.** They are pinned
> `6.2.8` (no caret) in `package.json`: `@pdfme/generator` declares its peers as
> `"latest"`, so `^5.x` + a 6.x `@pdfme/schemas` crashes at import time with
> *“The requested module '@pdfme/common' does not provide an export named
> 'createDynamicLayoutSplitRange'”*. If you bump one, bump all three.

## 6. The dashboard (review-first UX)

Everything a human touches lives under `src/app/(dashboard)` and reads through
`/api` only — never Supabase directly — so validation, encryption and logging
stay on the server.

**Engagement.** `/emails` is one row per recipient with delivery on the left and
activity on the right (`not tracked` / `sent` / `opened` / `clicked`, with open and
click counts and the last event), filterable by either axis. `/emails/<id>` is the
story of a single message: counters, the tracked links with their own click counts,
the raw event timeline with user-agents, the body as sent (pixel removed), and
buttons to record `reply` / `meeting` / `not_interested`. The lead workspace shows
the same thing compactly under a sent draft, and `/settings/tracking` states what
the app is configured to do — including whether the database has the columns to
record any of it.

**Generation is a click.** Ingest stores; it does not write. A lead with no
document shows **1 · Generate PPD** in the workspace (and its pipeline dot reads
"no document yet" in the list), which prepares the prompt and hands it to the
ChatGPT session. It stops at the document — no email copy, no PDF until you have
reviewed it. The **ChatGPT** pill in the top bar opens the session drawer: queue,
progress, errors, Cancel/Run and manual paste. `/settings/prompts` is where the
PPD, email and follow-up templates are edited for the whole workspace.

**Finding a lead.** `/leads` keeps the whole view in the URL — `q`,
`pipeline`, `confidence`, `from`, `to`, `sort`, `order` and `page` — so a
filtered page can be bookmarked or shared. Date presets (today, yesterday, this
week, last week, this month, last month, and wider rolling/quarter/year
windows) are computed in the **browser's local calendar** and sent as ISO
bounds, which avoids the off-by-one-day surprise of a UTC-only preset. The
pipeline filter is derived server-side from the counted `public.lead_list`
view: **Email sent** = `status = 'sent'`, **Doc/Draft both ready** = a proposal
and a draft exist, **Doc ready** = proposal without draft, **Draft ready** =
draft without proposal. Search, date, confidence and pipeline are combined
before the exact count and range, so the numbered pager (Prev · 1 … 5 … 10 ·
Next, 25 rows) never promises a page that the filter cannot fill. The default
sort is `created_at desc`; a page beyond the end clamps to the last real page
instead of returning a 502.

**Activity graph.** The Overview renders leads created, emails sent, unique
opens and unique tracked-link clicks as grouped bars, with `?period=day`
(last 7 days), `week` (12 rolling weeks) and `month` (12 calendar months).
The four metric cards stay on the last 7 days; the chart's period is
independent, and a missing tracking schema shows a warning instead of a row of
zeroes that would imply nobody opened anything. Unique counts mean one open or
one click per message, even when a recipient reloads an image or clicks twice.

**Data freshness.** `/leads/[id]` is server-rendered for the first paint, then
handed to TanStack Query (`useLead(leadId, initialData)`), which every mutation
either writes into directly or invalidates:

| Action | Where the cache is updated |
| --- | --- |
| Save / mark reviewed a PPD | `PATCH /api/proposals/:id` returns the whole refreshed lead → `setQueryData` |
| Create or edit a draft, send | returns `lead` when present → `setQueryData`, else invalidate |
| Generate PPD / email, render PDF | invalidate `["lead", id]` + `["leads"]` |
| Status or late `job_description` | `PATCH /api/leads/:id` → `setQueryData` |
| Contacts | `useUpdateContact` patches the row into the list caches |
| Overview, email log (server components) | `<LiveRefresh />` re-runs them on focus / reconnect / 30 s |

So the document you just edited, the `✓ reviewed` step chip, the
`pdf pending → ready` badge, the new draft card and the header status all change
in place. Focusing the tab revalidates. Nothing needs F5.

**Feedback.** `src/components/ui/toast.tsx` is a dependency-free live region
(`role=status`, errors `role=alert`), pushed from inside the query hooks so every
screen gets the same wording: what ran, for whom, how many words, what it cost,
and what happens next. `EMAIL_PROVIDER=log` announces itself as a dry run instead
of pretending a message went out.

**Review workspace** (`components/leads/proposal-card.tsx`, four tabs):

- **Read** — the document as it will be typeset, plus *Approve as reviewed* for
  the common case of accepting the model's text unchanged.
- **Edit document** (`ppd-editor.tsx`) — block-aware editor: sections and blocks
  can be added, removed and reordered; paragraphs, bullets, numbered steps,
  requirement→approach matrices and label/value tables each get their own
  inputs. `prepared_by / prepared_role / sender_* / date / valid_until /
  job_title / job_reference` are shown locked, because `sanitizeEditedPpd()`
  re-applies them server-side anyway.
- **JSON** — same document as text; a syntax error blocks the save and says why.
- **Prompts** — both prompt pairs inline, with click-to-insert `{{variables}}`
  and a budget warning when `max_tokens` is below what that step needs.

The draft buffer is mirrored to `localStorage` per proposal, so a closed tab
cannot lose a review pass, and ⌘/Ctrl-S saves.

**Nothing disappears silently.** An edit that the compiler must clip or drop
(empty block, empty lines, unverified reference, over the per-section cap) is
listed *before* saving (`ppdEditIssues`) and again as `warnings[]` on the PATCH
response (`describePpdEditDrops`) — which the toast layer shows.

**Removal.** Each `/leads` row has a `✕` (revealed on hover/focus) and a checkbox;
selecting any number opens `delete-leads-dialog.tsx`, which prints what is about
to be deleted (rows, documents, drafts, channels, stored PDFs — from the embedded
counts in `GET /api/leads`) next to what survives (promoted CRM contacts, the
`email_logs` delivery trail, sender accounts, prompts). More than five ids asks
for the word `delete`. The list rows disappear from the cache on the response, so
there is no half-second of a dead row — which required `apiFetch` to send
`cache: "no-store"`: the read routes answer `Cache-Control: private, max-age=10`
for scrapers, and the post-mutation refetch happily replayed the pre-delete rows.

**Other screens.** `/leads` rows are clickable with a four-dot pipeline chip and
an *Ingest payload* dialog (paste the scraper JSON, `auto` override, live char
count, honest 30–60 s progress note when generation runs inline). `/settings/senders`
shows which mailbox has no stored password and uses a modal for destructive
actions instead of `window.confirm`. `/emails` marks dry-run rows. The overview
leads with an **attention queue**: documents awaiting review, reviewed docs with
no email, drafts ready to send, PDFs marked stale after an edit — each linking to
the step that clears it. Navigation collapses into a drawer below `md`.

## 8. Setup

```bash
npm install                       # Next 15 + Supabase + pdfme 6.2.8 + nodemailer
cp .env.example .env.local
```

Then verify the toolchain you just installed:

```bash
npm run check          # tsc --noEmit + eslint
npm test               # 180 tests: migrations 0007–0011 and tracking SQL on a real Postgres, the send path, routes, ChatGPT parsing, PATCH semantics, PPD sanitising, follow-up Message-ID threading and a two-page PDF render
npm run build          # production build — 27 route handlers + 11 dashboard pages
node -e "console.log(require('@pdfme/generator') ? 'pdfme ok' : '')"  # no export-mismatch crash
```

Supabase (apply migrations in order — `0001` through `0011`):

```bash
supabase link --project-ref <ref> && supabase db push
# or paste each file into the SQL editor. 0002 also creates the private
# `proposals` storage bucket; 0003 adds prompt_templates, proposals.ppd_reviewed_at
# / pdf_generated_at and email_drafts.recipient_source (custom recipients);
# 0004 folds job_information.job_description into leads.search, gives recipient-less
# proposals their own version lane and adds the leads_awaiting_recipient view;
# 0005 adds the engagement columns on email_logs plus tracked_links, tracking_events
# and the record/purge RPCs (see §7 — without it the dashboard shows activity as
# unavailable, not as zeros);
# 0006 is the legacy ai_settings table; apply it only if an older deployment
# already has it. Nothing in the ChatGPT-session flow reads or writes it.
# 0007 adds public.lead_list (correlated contact/proposal/draft counts) and a
# created_at index. Without it the lead list still renders: date/sort/slice use
# the old query and a pipeline filter scans a bounded window in memory, so apply
# it for exact counts and for "doc ready" filters over a large table.
# 0008 adds chatgpt_jobs, the follow-up columns on email_drafts, and the
# follow_up prompt key. PPD/email/follow-up generation needs it.
# 0009 adds the `completing` job state and keeps it in the one-live-job index,
# so two tabs holding the same answer cannot write the proposal/draft twice.
# 0010 adds the sender profile columns used by the PPD header, the PDF and the
# email sign-off (role, phone, WhatsApp, LinkedIn, website, location, experience,
# skills). Apply it before generating; otherwise the API logs a missing-column
# error and the profile falls back to the environment.
# 0011 drops the unused ai_settings key table (if it was ever created) and
# defaults new proposals to provider chatgpt-session. Safe to run last.
# The app runs on 0001+0002 alone: prompt reads fall back to the code defaults and
# the 0003/0004 columns the app writes are dropped with a `db_columns_missing` log
# line naming this file — but saving edited prompts then returns 502.
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # optional demo rows
```

Required env (see `.env.example`):

| Var | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | service role is server-only |
| `API_MASTER_KEY` | `openssl rand -hex 32`; **required in production** — with it unset, `/api` is open in dev and answers `403` in prod |
| `APP_ENCRYPTION_KEY` | `openssl rand -hex 32` — encrypts SMTP passwords at rest |
| `NEXT_PUBLIC_CHATGPT_EXTENSION_ID` | id of the bundled extension (`phieeciapeplplficoclmjenfbmbdcke`); override only if you replace its manifest key |
| `PROPOSAL_LANGUAGE` / `AUTO_ENRICH_LEADS` | prompt language; `AUTO_ENRICH_LEADS` is **deprecated and ignored**: ingest always stores, and a person clicks Generate |
| `PROPOSAL_COMPANY` | **legacy**; the PPD and email never print a company. Kept only so old env files parse |
| `PROPOSAL_WEBSITE` | fallback website when no sender profile exists. Profile fields win |
| `PROPOSAL_PREPARED_BY` | fallback writer name when no sender profile exists |
| `PROPOSAL_TITLE` | fallback role when no sender profile exists |
| `PROPOSAL_RATE` | optional fallback rate; empty means the writer proposes an indicative USD range |
| `PDF_PROVIDER` / `PDFME_TEMPLATE_PATH` | `pdfme` \| `none` |
| `EMAIL_TRACKING` / `LINK_TRACKING` | open pixel and `/c/` link rewrites; both default on, both forced off by `EMAIL_PROVIDER=log` |
| `TRACKING_DOMAIN` | public HTTPS origin a recipient can reach; defaults to `NEXT_PUBLIC_APP_URL`, and a loopback/HTTP value is reported by `npm run check:tracking` |
| `TRACKING_RETENTION_DAYS` | how long raw open/click rows survive the purge (default 365; counters are rebuilt after it) |
| `CRON_SECRET` | `openssl rand -hex 32` — bearer token for `POST /api/maintenance/purge` |
| `EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_REPLY_TO` + `RESEND_API_KEY` or `SMTP_*` | fallback env-based sending; per-account SMTP wins when `senderAccountId` is given |
| `REQUIRE_SESSION` | development only: `true` exercises the login gate. Production always requires Supabase Auth |

Production gates the dashboard behind Supabase Auth. Create/invite the people who
will use it in **Supabase → Authentication → Users** before deploying; the login
page sends a magic link. Development stays open unless `REQUIRE_SESSION=true`.

```bash
npm run dev        # http://localhost:3000
npm run check      # tsc --noEmit + eslint
npm run db:types   # regenerate src/types/database.ts after schema changes
```

## 9. Run it end to end

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
# → lead + contacts stored, nothing generated: AUTO_ENRICH_LEADS is ignored and
#   ?auto=true is ignored too. Generation starts only from the lead page.
#   A second post of the same job_id / job link answers duplicate + matchedBy and
#   adds nothing (npm test covers all six shapes; check with two identical posts).

# 2b. a payload with the post body but no identifiers and no contacts still gets
#     a document: it is written recipient-less (proposals.lead_contact_id = null)
curl -s -X POST "http://localhost:3000/api/leads" \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  --data-binary @examples/lead-description-only.json

# 2c. the scraper sometimes gets the post text later — supply it by hand. Any
#     subset of { status, job_description, error } is accepted; the response
#     tells you whether an existing document predates the new text.
curl -s -X PATCH "http://localhost:3000/api/leads/<leadId>" \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"job_description":"30-second logo sting, After Effects, MP4 + transparent mov."}'

# 2d. remove jobs for good — rows, generated documents, drafts, channels and
#     the stored PDFs. Exact ids only (1-100 per call); there is no undo.
curl -s -X DELETE http://localhost:3000/api/leads \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"ids":["<leadId>"]}'
# → { removed: [{ contacts, proposals, drafts, pdfFiles }], missing, failed, totals }
# kept on purpose: public.contacts you promoted, email_logs delivery proof,
# sender accounts, prompt overrides. One id? DELETE /api/leads/<leadId> → 204.

# ── STEP 1 · prepare the document prompt ─────────────────────────────────
curl -s -X POST http://localhost:3000/api/leads/<leadId>/generate \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"toEmail":"client@example.com"}'        # or {"contactId":"<uuid from the payload>"}
# omit both → the lead's primary email; no email on the lead at all → a
# recipient-less PPD is still prepared from job_information.job_description
# → 201 { job, next }; no model API is called here
# the extension/drawer runs the prompt, then posts the raw answer:
curl -s -X POST http://localhost:3000/api/chatgpt/jobs/<jobId>/complete \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"text":"…the complete ChatGPT answer…"}'
# → parsed ppd JSON, pdf_status: "pending", no draft, no PDF

# ── STEP 2 · review it (dashboard tab "Edit PPD JSON", or PATCH here) ─────
curl -s -X PATCH http://localhost:3000/api/proposals/<proposalId> \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"ppd": { …the edited document… }}'
# → stamps ppd_reviewed_at; a previously rendered PDF is marked stale

# optional look before you commit to the email:
curl -s -o preview.pdf "http://localhost:3000/api/leads/<leadId>/pdf?render=true&download=true" \
  -H "x-api-key: $API_MASTER_KEY"

# ── STEP 3 · prepare the email prompt, then complete it ───────────────────
curl -s -X POST http://localhost:3000/api/leads/<leadId>/generate-email \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" \
  -d '{"toEmail":"client@example.com","cc":["account@yourdomain.com"]}'
# → 201 { job, next }; completing it opens a draft addressed to ANY mailbox

# ── STEP 4 · send: the PDF is compiled here and attached ──────────────────
curl -s -X POST http://localhost:3000/api/drafts/<draftId>/send -H "x-api-key: $API_MASTER_KEY"
curl -s -X POST http://localhost:3000/api/drafts/<draftId>/send \
  -H "content-type: application/json" -H "x-api-key: $API_MASTER_KEY" -d '{"attachPdf":false}'

# 5. audit
curl -s "http://localhost:3000/api/email?status=sent" -H "x-api-key: $API_MASTER_KEY"
curl -s http://localhost:3000/api/prompts -H "x-api-key: $API_MASTER_KEY"

# ── STEP 5 · activity (needs 0005 + a public HTTPS TRACKING_DOMAIN) ───────
curl -s "http://localhost:3000/api/email?tracking=opened" -H "x-api-key: $API_MASTER_KEY"
curl -s "http://localhost:3000/api/tracking/stats?days=7" -H "x-api-key: $API_MASTER_KEY"
npm run check:tracking   # names the missing piece, if any
# a real open cannot be simulated from this machine — the pixel URL is only
# reachable by the recipient's mail client, so verify it after a live send:
#   curl -si $TRACKING_DOMAIN/o/<tracking_token>.gif | head -6
# → 200 image/gif, and the message's Activity cell in /emails ticks up.
```

Dashboard pages: **Overview** (activity graph by day/week/month) · **Leads** (search, date/pipeline filters, numbered pages, click → detail) ·
**Lead detail** (job description, key people, every channel with its evidence,
the four-step PPD workspace: read view · JSON editor · recipient picker with a
free-text address · both prompts inline) · **Email draft card** (to/cc/subject
/body, "render PDF + send") · **Contacts** · **Email log** · **Senders** ·
**Settings → Prompts** · **API** (curl reference).

### The three prompts

`GET/PUT /api/prompts` and `/settings/prompts` expose `ppd_document` (writes the
block PPD), `email_draft` (writes the technical subject/body from the reviewed PPD, with reference links inline and exactly `{ "email": { "subject", "content" } }`) and
`follow_up` (writes the next message on an existing thread). All three
are stored in `prompt_templates` — a row only exists once you edit it, so a
reset falls back to the code default in
`src/server/services/prompts/proposal.prompt.ts`. Every prompt is a `{{variable}}`
template (`{{job_title}}`, `{{research_notes}}`, `{{rate}}`, `{{ppd_summary}}`, …;
`GET /api/prompts` lists them) and the exact text sent on the last run is kept
with the generation report so you can see what produced what. Unknown slots are
reported instead of silently blanked.

## 10. Deploy to Vercel

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

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Every route returns 500 `internal_error` — “Invalid environment configuration: API_MASTER_KEY: Too small” | A blank value in `.env.local` (`API_MASTER_KEY=`) is now treated as **unset** (`lib/env.ts` drops empty strings before validating). Pull this fix; previously an empty optional var failed its own constraint. |
| The scraper gets a `302`/`307` to `/login` (HTML) instead of JSON from `POST /api/leads` | The production middleware gated every non-public path before the route's `x-api-key` check. `/api/leads` is now in `PUBLIC_PATHS` while the route still calls `requireApiKey`; deploy this build. A per-deployment `*.vercel.app` preview can also be behind Vercel Deployment Protection — point `LEAD_URL` at the production alias or add a bypass secret. |
| `TypeError: fetch failed` on `/api/*` | The function could not reach `NEXT_PUBLIC_SUPABASE_URL` (offline sandbox, VPN, wrong project ref, or paused project). `/api/health` shows it as `"status":"degraded"` with the reason. |
| `upstream_error … Failed to list leads` | Migration `0002_leads_senders_proposals.sql` not applied yet (tables missing). |
| `Cannot save prompt overrides: the prompt_templates table is missing … apply supabase/migrations/0003_prompt_templates_review_flow.sql` (502 from `PUT /api/prompts`) | Migration **0003** not applied. Until then prompt reads fall back to the code defaults, generation still works, and the review stamp / custom-recipient provenance are dropped from the write with a `db_columns_missing` log line — but you cannot save edited prompts. |
| Two description-only payloads landed on the same lead | Pre-`computeDedupeKey` behaviour: with `job_id`, `job_url`, `job_title` and `client_name` all null the key used to be SHA-1 of the empty string. Current code hashes the post body instead — re-apply the payload after pulling, or move the rows by hand. |
| `q=blender` finds nothing although the post body says Blender | App-side `ilike` covers `job_description` regardless, but the `leads.search` tsvector only includes it after `0004_job_description_ingestion.sql`. |
| PDF arrives unchanged after you edited the PPD | Cannot happen by design: saving a PPD flips `pdf_status` back to `pending`, and the PDF is re-compiled from the stored document at the next preview or send. If `ppd_reviewed_at` never appears in the response, 0003 is missing. |
| An existing proposal PDF still stops at page two after upgrading | That file was rendered by the old two-page compiler. Open the proposal and press **Regenerate PDF** (or save the PPD) once; the new render keeps every page. |
| A draft send went out when you expected a dry run | `EMAIL_PROVIDER=log` is now a **hard stop**: with it set to `log`, a stored `senderAccountId` is not even decrypted and no SMTP socket is opened (`services/email.service.ts`). Set it back to `smtp` when you want real delivery. |
| The ChatGPT drawer says **Extension not connected** | Load `chatgpt-extension/` unpacked in the same browser profile, reload it, and check that `NEXT_PUBLIC_CHATGPT_EXTENSION_ID` matches the extension id. The exact preview origin `upwork-email-contact-coredev367.vercel.app` is included; if you deploy on another domain, add that exact origin to `externally_connectable` and reload the extension. |
| The extension is connected, but the job sits at **queued** | No signed-in ChatGPT tab was found, or the tab is showing a login/human check. Open chatgpt.com, finish the check, then press **Run** in the drawer; the prompt is saved server-side. |
| A job fails with `Could not establish connection. Receiving end does not exist.` right after reloading the extension | The open ChatGPT tab still holds the old, orphaned content script. Extension 1.0.5 clears its `already loaded` flag and re-injects (with one tab reload as a fallback), so just press **Run** again. On older builds, reload the ChatGPT tab first. |
| **Run** opens a new ChatGPT chat instead of using the conversation on screen | Fixed in extension 1.0.5. The current conversation is reused; the **New chat** control is only checked as a readiness signal and is never clicked. |
| The drawer says **The prompt is still in the message box…** | The tab was in the background, the composer was not the real one, or the send control was disabled. Extension 1.0.5 focuses the tab, scores the real composer, types once, then tries the send button, Enter and the form once each. It never types a second copy. If it still fails, click the composer once and press **Run** again; the message includes a `composer=… chars=… users=…` diagnostic line. |
| The drawer stays on **typing the prompt** after ChatGPT has started answering | The content script sends `waiting` immediately after the prompt is accepted and every five seconds while the answer is generating. The drawer also shows a timestamped **Extension log** (`Queue`, `Open`, `Prompt`, `Input`, `Sent`, `Wait`, `Answer`, `Copy`, `Handoff`, `Result`, `Done`) under the job and in **Details**. |
| ChatGPT answers but **Copy** gets nothing, or the answer arrives as plain text | Extension 1.0.8 waits for the stop control to disappear, focuses the ChatGPT tab, then clicks Copy up to three times. A clipboard entry is accepted only when it parses to the expected structured answer (`ppd.sections` or `email.subject`/`email.content`) and matches the current turn. Structured JSON visible in the page is the last fallback; an unstructured answer fails with a message instead of saving prose. |
| ChatGPT finished, but the dashboard never showed the PPD/draft | Extension 1.0.6 saves the answer under `upworkChatAnswer:<jobId>` and waits for the worker’s `CHATGPT_REPLY` acknowledgement before clearing the active job. A sleeping worker is retried; a page reload resends the saved answer instead of typing the prompt again. The drawer names the failed step (Handoff/Result) when it still cannot store it. |
| The ChatGPT tab shows a dimmed composer and nothing is typed | The page had not finished rendering, was discarded, or is signed out. The content script now waits 25 seconds for a visible composer and then fails with a clear reason instead of hanging; the worker also reloads a discarded tab. Reload chatgpt.com, stay signed in, then press **Run**. |
| ChatGPT answered but the PPD did not appear | The server rejected a non-JSON or incomplete answer. The drawer returns the job to **running** and the toast names the parse error; paste a corrected JSON answer with the manual-paste box, or press **Run** again. |
| `chatgpt_jobs` table missing / `0008` or `0009` error | Apply `supabase/migrations/0008_chatgpt_session_followups.sql`, then `0009_chatgpt_completion_claim.sql`; PPD, email and follow-up preparation all write there, and finalisation needs the `completing` state. |
| `lead_list_view_missing` in the logs, or pipeline filters feel slow on a large table | Migration **0007** is not applied. The list deliberately degrades instead of failing: date, sort and pagination use the old query, and a pipeline filter reads a bounded window and filters in memory. Apply 0007 for the correlated counts and the `created_at` index. |
| The same Upwork job appears twice in `/leads` | Pre-`src/lib/job-ref.ts` behaviour: dedupe compared `job_id` and the raw URL string, so one scrape with `~02…` in a link and another with `job_id` alone produced two rows. Now both are matched in canonical form, in either direction. Merge by hand: open the newer lead, note the older id, `DELETE /api/leads {"ids":[<newer>]}`. |
| `pdf_unavailable` (409) from `/api/leads/:id/pdf` | `PDF_PROVIDER=none`, or no proposal generated yet — retry `?render=true`. |
| A deleted row reappears in the list a second later | `GET /api/leads` sends `Cache-Control: private, max-age=10`, so a refetch after a mutation replayed the old page. `apiFetch`/`apiFetchBlob` now pass `cache: "no-store"` — keep it if you add another client-side cache. |
| Crash at import: *“'@pdfme/common' does not provide an export named 'createDynamicLayoutSplitRange'”* | pdfme version skew. Keep `@pdfme/common`, `@pdfme/generator`, `@pdfme/schemas` on the **same exact version** (pinned `6.2.8`, no caret). |
| 500 responses hide the real reason | Outside production, `withApi` now echoes the message + top of the stack in `error.details` so you can debug without attaching a logger. |
| Activity column reads **“not tracked”** on a message you know went out | Three different causes, and `/emails` says which: `EMAIL_PROVIDER=log` (nothing was delivered), the send predates `0005_email_tracking.sql`, or the body had no HTML to carry a pixel. `npm run check:tracking` probes the database and names the missing piece. |
| Opens and clicks are all zero, but the pixel URL returns 200 from your laptop | **Vercel Deployment Protection.** With "Real requests only" on, recipient traffic to `/o/*` and `/c/*` gets `401` before Next ever sees it. Exempt both prefixes (Settings → Deployment Protection → Protected Functions). Second candidate: `TRACKING_DOMAIN` left on `localhost` or `http://` — a mail client cannot reach either. |
| `upstream_error — Recording outcomes needs supabase/migrations/0005_email_tracking.sql` | The RPC is absent (or PostgREST cached the old schema). Apply 0005, then `notify pgrst, 'reload schema'` in the SQL editor. The route deliberately does not answer 404 here: the message row exists, the function does not. |
| One Gmail open shows up as two events | Expected, and not a bug: Gmail fetches the pixel through `googleimageproxy.com` **and** `googleusercontent.com`, twice each. The 60-second dedupe window is keyed on the truncated user-agent, so genuinely different clients still count separately — that is why "unique openers" counts *messages opened*, not requests. |
| A tracking link `302`s to the wrong host | It cannot. `validateDestination()` runs again at click time (and the stored URL was validated at send time), so a link edited straight in the database to a private/metadata address returns 400 instead of redirecting. |

In dev, `/api/*` is open when `API_MASTER_KEY` is empty. That open mode is
deliberate, but it is quiet: only the two receive events below reach the console;
the same config in production answers `403` until you set a key.

## 12. Security notes

* **Removal is id-scoped and reported.** `DELETE /api/leads` takes 1–100 exact
  uuids — never a filter, never a wildcard — and answers with what left and what
  was already gone. `lead_contacts`, `proposals`, `email_drafts` go by cascade;
  the storage objects under `proposals/{leadId}/` are deleted first, because an
  orphaned PDF is unrecoverable from the UI. Promoted CRM contacts and
  `email_logs` rows survive on purpose: the delivery record is evidence, not the
  lead's property.

* SMTP passwords are `v1:iv:tag:ciphertext` AES-256-GCM; without
  `APP_ENCRYPTION_KEY` they cannot be saved or decrypted (changing the key
  invalidates stored secrets — re-save the sender accounts).
* `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and is only read from `src/server/**`;
  RLS stays enabled on every table with no public policies.
* **The ChatGPT session belongs to the user, not the server.** The extension only
  accepts commands from the origins in `externally_connectable`, never exposes the
  session cookie, and sends prompt text plus the answer over a runtime port. Keep
  the allowed-origin list exact; do not widen it to `https://*.vercel.app/*`.
* The extension types into the user's own ChatGPT tab. Prompts and answers pass
  through ChatGPT under that account's data policy — do not send material the
  workspace is not allowed to put there.
* Email bodies, PPDs and raw payloads contain personal data — keep the bucket
  private, and add retention if your jurisdiction needs it.
* Generation is untrusted input → ChatGPT → stored text: the prompt forbids
  inventing prices/facts, and `sanitizePpd()`/`sanitizeEmail()` cap lengths; still,
  **a human reviews the draft before `POST /api/drafts/:id/send`**. Nothing sends
  automatically.
* **The tracking URLs are the only intentionally public endpoints**, so they carry the
  least information that still works: tokens are 24 random bytes (`crypto.randomUUID`
  grade, 184 bits) and unguessable; an unknown token is answered exactly like a known one;
  `tracking_events` has no IP column and truncates the user-agent to 300 characters; the
  three RPCs are `security definer` with `grant revoke from public, anon, authenticated`
  so only the service role can call them, and the routes are the only caller. A leaked
  `/o/<token>.gif` URL lets someone inflate one message's open count up to 40/day — it
  reveals nothing, because the response is the same 42-byte GIF regardless. Treat a token as a
  capability anyway: never log one at full length, and the retention purge removes the
  request history while keeping the counters.

## 13. Next steps

* [ ] Batch generation: a "generate these 10 leads" action on `/leads` would want a queue
      (Inngest/QStash) so one browser does not have to run ten prompts back to back
* [ ] Reply detection: IMAP polling or inbound webhook → the `reply` outcome is already modelled in
      `tracking_events`, so this becomes a writer rather than a schema change
* [ ] Follow-up nudges driven by the tracking data (opened 3× in 48 h and no reply → nudge queue)
* [x] Production gates the dashboard behind Supabase Auth automatically; development stays open.
      Set `REQUIRE_SESSION=true` to exercise the gate locally. `/o/*` and `/c/*` stay public so
      tracking links keep working
* [ ] Per-user/tenant ownership: leads, proposals, prompt templates and sender profiles are currently
      a shared workspace. The server uses the service-role client, so RLS does not isolate rows between
      signed-in people. Add `owner_id`/`workspace_id` + policies before inviting independent users;
      a shared team that trusts every member can keep the current model
