-- =============================================================================
-- 0008_chatgpt_session_followups.sql
--
-- PPD and email generation now runs in the signed-in ChatGPT tab the user
-- already has. The server prepares the prompt and validates/stores the answer;
-- it never receives an OpenAI API key and never calls a model API.
--
-- A job row is the durable hand-off:
--   prepare (server) -> queued -> running (extension) -> completed (server)
-- The prompt is stored on the job so a reloaded dashboard, a second tab or a
-- different signed-in user's browser can pick up exactly the same request.
--
-- Follow-up emails are separate drafts on the same lead/proposal, with a
-- sequence number and a link to the message they follow. Nothing overwrites
-- the first send, so a lead can carry as many touches as the conversation
-- needs.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ChatGPT session jobs
-- ---------------------------------------------------------------------------
create table if not exists public.chatgpt_jobs (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references public.leads(id) on delete cascade,
  proposal_id     uuid references public.proposals(id) on delete cascade,
  contact_id      uuid references public.lead_contacts(id) on delete set null,
  kind            text not null check (kind in ('ppd_document', 'email_draft', 'follow_up')),
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  prompt_key      text not null,
  prompt_label    text not null,
  prompt_system   text not null,
  prompt_user     text not null,
  prompt_meta     jsonb not null default '{}'::jsonb,
  context         jsonb not null default '{}'::jsonb,
  response_text   text,
  error           text,
  created_by      text not null default '',
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists chatgpt_jobs_lead_idx
  on public.chatgpt_jobs (lead_id, created_at desc);
create index if not exists chatgpt_jobs_status_idx
  on public.chatgpt_jobs (status, created_at desc);
-- One live request of each kind per lead: two PPD runs racing for the same
-- version would produce a duplicate proposal, and two email runs would race
-- for the same draft slot.
create unique index if not exists chatgpt_jobs_one_live_kind_idx
  on public.chatgpt_jobs (lead_id, kind)
  where status in ('queued', 'running');

drop trigger if exists chatgpt_jobs_set_updated_at on public.chatgpt_jobs;
create trigger chatgpt_jobs_set_updated_at
  before update on public.chatgpt_jobs
  for each row execute function public.set_updated_at();

alter table public.chatgpt_jobs enable row level security;
revoke all on table public.chatgpt_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.chatgpt_jobs to service_role;

comment on table public.chatgpt_jobs is
  'Durable hand-off between the app and the user ChatGPT session; prompts and responses are server-side only.';
comment on column public.chatgpt_jobs.context is
  'Finalisation data (contact, source, version lane, draft options) captured when the prompt was prepared.';

-- ---------------------------------------------------------------------------
-- Follow-up drafts
-- ---------------------------------------------------------------------------
alter table public.email_drafts
  add column if not exists sequence integer not null default 1;
alter table public.email_drafts
  add column if not exists parent_draft_id uuid;
alter table public.email_drafts
  add column if not exists purpose text not null default 'initial';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_drafts'::regclass
      and conname = 'email_drafts_parent_draft_id_fkey'
  ) then
    alter table public.email_drafts
      add constraint email_drafts_parent_draft_id_fkey
      foreign key (parent_draft_id) references public.email_drafts(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.email_drafts'::regclass
      and conname = 'email_drafts_purpose_check'
  ) then
    alter table public.email_drafts
      add constraint email_drafts_purpose_check
      check (purpose in ('initial', 'follow_up', 'manual'));
  end if;
end $$;

create index if not exists drafts_sequence_idx
  on public.email_drafts (lead_id, lead_contact_id, sequence desc);
create index if not exists drafts_parent_idx
  on public.email_drafts (parent_draft_id);

comment on column public.email_drafts.sequence is
  '1 = first contact, 2+ = follow-ups. Every touch is a separate draft, so sending more never rewrites an earlier mail.';
comment on column public.email_drafts.parent_draft_id is
  'The draft this follow-up replies to; null for an initial email.';
comment on column public.email_drafts.purpose is
  'initial, follow_up, or manual (typed by a person).';

-- ---------------------------------------------------------------------------
-- The follow-up prompt is editable like the other two
-- ---------------------------------------------------------------------------
alter table public.prompt_templates
  drop constraint if exists prompt_templates_key_check;
alter table public.prompt_templates
  add constraint prompt_templates_key_check
  check (key in ('ppd_document', 'email_draft', 'follow_up'));
