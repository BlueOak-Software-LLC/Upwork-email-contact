-- =============================================================================
-- 0003_prompt_templates_review_flow.sql
-- Editable Groq prompts + explicit review steps in the proposal pipeline
--
-- New flow (nothing auto-attaches a PDF any more):
--   1. POST /api/leads/:id/generate        → PPD JSON only        (pdf_status = pending)
--   2. PATCH /api/proposals/:id            → human edits the PPD  (ppd_reviewed_at set)
--   3. POST /api/leads/:id/generate-email  → subject/body + draft (custom recipient allowed)
--   4. POST /api/drafts/:id/send           → renders the PDF, attaches it, sends
-- =============================================================================

-- ---------------------------------------------------------------------------
-- prompt_templates — the two system/user prompt pairs the dashboard shows and
-- lets you edit. Rows only exist once a human edits them: with no row the code
-- default in `src/server/services/prompts/proposal.prompt.ts` is used, and
-- "Reset to default" simply deletes the row. That keeps one source of truth.
-- ---------------------------------------------------------------------------
create table if not exists public.prompt_templates (
  key             text primary key check (key in ('ppd_document', 'email_draft')),
  label           text        not null,
  system_text     text        not null,
  user_template   text        not null,
  temperature     numeric(4,3) not null default 0.45,
  -- NULL ⇒ fall back to GROQ_MAX_TOKENS / GROQ_REASONING_EFFORT
  max_tokens      integer     check (max_tokens is null or max_tokens between 512 and 65536),
  reasoning_effort text       check (reasoning_effort is null or reasoning_effort in ('low','medium','high')),
  note            text,
  updated_at      timestamptz not null default now()
);

drop trigger if exists prompt_templates_set_updated_at on public.prompt_templates;
create trigger prompt_templates_set_updated_at
  before update on public.prompt_templates
  for each row execute function public.set_updated_at();

alter table public.prompt_templates enable row level security;

-- ---------------------------------------------------------------------------
-- Review markers
-- ---------------------------------------------------------------------------
-- When the human saved the PPD (step 2). Drives the "reviewed" badge and tells
-- the renderer that the stored PPD is approval-worthy.
alter table public.proposals
  add column if not exists ppd_reviewed_at timestamptz;

-- The PDF is deliberately generated late (send time or an explicit preview),
-- so record when it actually happened.
alter table public.proposals
  add column if not exists pdf_generated_at timestamptz;

-- Who the draft is addressed to: an address from the lead's contacts, or one a
-- human typed in. Purely informational — `to_email` is authoritative either way.
alter table public.email_drafts
  add column if not exists recipient_source text not null default 'lead_contact'
    check (recipient_source in ('lead_contact', 'custom'));

create index if not exists proposals_lead_reviewed_idx
  on public.proposals (lead_id, ppd_reviewed_at desc nulls last);
