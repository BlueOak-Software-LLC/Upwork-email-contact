# Upwork Email Contact

Next.js 15 (App Router) project with **one codebase for both halves**:

| Half | Where | What it does |
| --- | --- | --- |
| Frontend | `src/app/(dashboard)`, `src/components` | Dashboard that reads contacts, funnel metrics and the delivery log from Supabase |
| Backend | `src/app/api`, `src/server` | Route Handlers: **API #1 `GET /api/contacts`** (JSON) and **API #2 `POST /api/email/send`** (send email) |

Data lives in **Supabase** (Postgres + Auth). Deploy target is **Vercel** (zero-config
Next.js; the API routes become server functions).

---

## 1. Stack

- **Next.js 15** App Router, React 19, TypeScript strict, `src/` + `@/*` path alias
- **Tailwind CSS v4** (`@tailwindcss/postcss`, no `tailwind.config.js`)
- **Supabase**: `@supabase/ssr` for cookie-based auth, `@supabase/supabase-js` service-role client for the API
- **TanStack Query v5** for the interactive table/mutations in the browser
- **Zod v4** for env validation and every request payload
- **Email providers** behind one interface: `resend` | `smtp` (nodemailer) | `log` (dry run)
- ESLint 9 flat config (`eslint-config-next`), Prettier + tailwind plugin

## 2. Project structure

```
.
├── supabase/
│   ├── migrations/0001_init.sql     # enums, contacts, email_logs, indexes, RLS, view
│   └── seed.sql                     # demo rows
├── src/
│   ├── app/
│   │   ├── layout.tsx               # root layout + React Query provider
│   │   ├── globals.css              # Tailwind v4 theme tokens
│   │   ├── (dashboard)/             # ← FRONTEND (route group, no URL segment)
│   │   │   ├── layout.tsx           # sidebar + topbar shell, reads Supabase session
│   │   │   ├── actions.ts           # server action (sign out)
│   │   │   ├── page.tsx             # overview: metrics, pipeline, latest contacts
│   │   │   ├── contacts/page.tsx    # data table (client island)
│   │   │   ├── emails/page.tsx      # delivery log (server rendered)
│   │   │   └── api-docs/page.tsx    # in-app endpoint reference
│   │   ├── api/                     # ← BACKEND (route handlers)
│   │   │   ├── health/route.ts      # GET  liveness + Supabase probe
│   │   │   ├── contacts/route.ts    # GET  JSON list · POST create
│   │   │   ├── contacts/[id]/route.ts # GET · PATCH · DELETE
│   │   │   ├── email/route.ts       # GET  delivery history
│   │   │   └── email/send/route.ts  # POST send email (API #2)
│   │   ├── login/page.tsx           # magic-link sign-in
│   │   ├── auth/callback/route.ts   # PKCE code exchange
│   │   └── not-found.tsx
│   ├── components/
│   │   ├── contacts/                # contacts-view, send-email-dialog, new-contact-dialog
│   │   ├── dashboard/               # metric cards + CSS sparkline
│   │   ├── layout/                  # sidebar, topbar
│   │   ├── providers/               # QueryProvider
│   │   └── ui/                      # button, card, input, table, badge, modal, skeleton
│   ├── lib/
│   │   ├── api/                     # browser fetch client + react-query hooks
│   │   ├── supabase/                # client.ts (browser) · server.ts (cookies) · admin.ts (service role) · middleware.ts
│   │   ├── validation/              # zod schemas shared by API + forms
│   │   ├── env.ts  logger.ts  utils.ts
│   ├── server/
│   │   ├── db/                      # contacts.repo.ts, email-logs.repo.ts  (only place SQL is called)
│   │   ├── http/                    # withApi wrapper, ApiError, auth, rate-limit, responses
│   │   ├── services/                # email.service.ts, providers, templates
│   │   └── queries.ts               # Server Component read helpers
│   ├── types/                       # database.ts (generated-style), domain.ts
│   └── middleware.ts                # refreshes Supabase cookies on every request
├── .env.example
├── next.config.ts  tsconfig.json  eslint.config.mjs  postcss.config.mjs
└── package.json
```

**Layering rule:** `app/api/*` (transport) → `server/services` + `server/db` (domain, data)
→ `lib/supabase` (driver). Components never call Supabase directly; they call our own
`/api` routes so auth, validation and logging stay in one place.

## 3. Setup

```bash
npm install
cp .env.example .env.local         # fill Supabase URL + anon + service-role keys
```

Apply the schema (choose one):

```bash
# a) Supabase CLI, linked project
supabase link --project-ref <ref>
supabase db push

# b) Dashboard: paste supabase/migrations/0001_init.sql into the SQL editor
# c) Local stack
supabase start && supabase db reset        # loads migrations + supabase/seed.sql
```

```bash
npm run dev        # http://localhost:3000
npm run check      # typecheck + lint
```

`EMAIL_PROVIDER=log` by default — emails print to the terminal, nothing is sent.

### Environment variables

| Var | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | public, guarded by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | server-only, bypasses RLS — never expose |
| `API_MASTER_KEY` | prod required | if set, `/api/*` demands `x-api-key` (or a signed-in Supabase session). Unset in **development** the routes are open for convenience; unset in **production** they answer `403` |
| `EMAIL_PROVIDER` | ✅ | `resend` \| `smtp` \| `log` |
| `EMAIL_FROM` / `EMAIL_REPLY_TO` | ✅ / – | e.g. `"Outreach" <hello@yourdomain.com>` |
| `RESEND_API_KEY` | if resend | |
| `SMTP_HOST/PORT/USER/PASS/SECURE` | if smtp | Vercel blocks port 25 — use 465 (`SECURE=true`) or 587 |
| `NEXT_PUBLIC_APP_URL` | – | metadata base + absolute redirects |

## 4. The two backend APIs

### API #1 — `GET /api/contacts` (JSON out of Supabase)

```bash
curl "http://localhost:3000/api/contacts?status=new&page=1&pageSize=20&q=northwind" \
  -H "x-api-key: $API_MASTER_KEY"
```

```json
{
  "data": [{ "id": "uuid", "name": "Jane Cooper", "email": "jane@northwindlabs.io",
             "company": "Northwind Labs", "status": "new", "tags": ["saas"],
             "last_contacted_at": null, "created_at": "…" }],
  "meta": { "page": 1, "pageSize": 20, "total": 128, "totalPages": 7 }
}
```

Also: `POST /api/contacts`, `GET|PATCH|DELETE /api/contacts/:id`, `GET /api/email` (history),
`GET /api/health`.

### API #2 — `POST /api/email/send` (send email to anyone)

```bash
curl -X POST http://localhost:3000/api/email/send \
  -H "content-type: application/json" \
  -H "x-api-key: $API_MASTER_KEY" \
  -d '{
        "to": ["client@acme.co"],
        "subject": "Quick question about your project",
        "text": "Hi Jane, are you free for a 15-min call?",
        "contactId": "0f0f…uuid",
        "updateContact": true
      }'
```

```json
{ "data": { "provider": "resend", "requested": 1, "delivered": 1, "failed": 0,
  "results": [{ "id": "log-uuid", "status": "sent", "to": "client@acme.co",
                "provider": "resend", "providerMessageId": "…" }] } }
```

Behaviour: one provider call **per recipient** (no leaked addresses), HTML generated from
`text` when not supplied, every attempt written to `email_logs`, and the contact is stamped
`status = contacted`, `last_contacted_at = now()` (a `replied` contact is never downgraded).
Rate limit: 10/min per credential + 30/min per IP (per-instance guard).

Errors are uniform:

```json
{ "error": { "code": "validation_error", "message": "…", "details": { "to": "Invalid email" } } }
```

`400` bad_request · `401` unauthorized · `403` forbidden · `404` not_found · `409` conflict
· `422` validation_error · `429` rate_limited · `502` upstream_error · `500` internal_error

## 5. Deploy to Vercel

```bash
npm i -g vercel && vercel          # or: push to GitHub → Import Project in vercel.com
```

1. Framework preset is auto-detected (**Next.js**); build command `npm run build`,
   output directory is empty — no `vercel.json` needed.
2. Project Settings → **Environment Variables**: add every var from `.env.example`
   for *Production* and *Preview* (copy values, never commit `.env.local`).
3. Generate the key: `openssl rand -hex 32` → `API_MASTER_KEY`.
4. Supabase → Authentication → **URL Configuration**: add
   `https://<your-app>.vercel.app/**` and `https://<your-app>.vercel.app/auth/callback`.
5. Deploy, then verify: `curl https://<app>/api/health` → `{"data":{"status":"ok"}}`.
6. Post-deploy: point the Vercel Firewall/Cron at `/api/health`, and keep the
   service-role key out of the client bundle (it is only read by `src/server/**`).

Node 20.9+ is required (`engines` in `package.json`); `.nvmrc` pins 22 for local parity.

## 6. Next steps

- [ ] Replace the sample `contacts` columns with your scraper's real fields, then `npm run db:types`
- [ ] Move API #2 behind a queue (Vercel QStash / Inngest) if you batch >100 sends
- [ ] Flip `REQUIRE_SESSION = true` in `src/lib/supabase/middleware.ts` once auth users exist
- [ ] Add RLS policies + `src/lib/supabase/client.ts` reads if the browser should query Supabase directly
