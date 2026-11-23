-- =============================================================================
-- 0002_leads_senders_proposals.sql
-- Sender accounts (SMTP), ingested Upwork leads, contacts, PPD proposals, drafts
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin create type public.lead_confidence as enum ('HIGH','MEDIUM','LOW','UNIDENTIFIED');
  exception when duplicate_object then null; end $$;

do $$ begin create type public.lead_status as enum
  ('received','enriched','proposal_ready','draft_created','sent','failed','archived');
  exception when duplicate_object then null; end $$;

do $$ begin create type public.contact_list as enum
  ('verified','potential','company_page','linkedin','social','key_person');
  exception when duplicate_object then null; end $$;

do $$ begin create type public.channel_kind as enum ('email','phone','url','other');
  exception when duplicate_object then null; end $$;

do $$ begin create type public.sender_status as enum ('active','paused','error');
  exception when duplicate_object then null; end $$;

do $$ begin create type public.draft_status as enum
  ('draft','queued','sent','failed','cancelled');
  exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- sender_accounts — OUR sending identities (the two mailboxes) + SMTP config
--   smtp_password_cipher is AES-256-GCM ("v1:iv:tag:ciphertext") keyed by
--   APP_ENCRYPTION_KEY. Plaintext passwords never touch the database.
-- ---------------------------------------------------------------------------
create table if not exists public.sender_accounts (
  id                    uuid primary key default gen_random_uuid(),
  label                 text not null,
  from_email            text not null,
  display_name          text,
  reply_to              text,
  signature             text,
  smtp_host             text not null,
  smtp_port             integer not null default 587 check (smtp_port between 1 and 65535),
  smtp_secure           boolean not null default false,   -- true = implicit TLS (465)
  smtp_user             text,
  smtp_password_cipher  text,
  daily_limit           integer not null default 50,
  sent_count            integer not null default 0,
  status                public.sender_status not null default 'active',
  is_default            boolean not null default false,
  last_verified_at      timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists sender_accounts_email_lower
  on public.sender_accounts (lower(from_email));
-- at most one default sender
create unique index if not exists sender_accounts_single_default
  on public.sender_accounts (is_default) where is_default;

-- ---------------------------------------------------------------------------
-- leads — one row per ingested Upwork research payload
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id                 uuid primary key default gen_random_uuid(),
  dedupe_key         text not null unique,          -- job_id, or hash of job_url/title+client
  job_id             text,
  job_title          text,
  job_url            text,
  job_location       text,
  industry           text,
  company_mentioned  text,
  client_name        text,
  client_location    text,
  job_description    text,                          -- optional, posted alongside the payload
  overall_confidence public.lead_confidence not null default 'UNIDENTIFIED',
  key_people         jsonb not null default '[]'::jsonb,
  contact_information jsonb not null default '{}'::jsonb,
  raw_payload        jsonb not null,                -- exactly what the scraper sent us
  status             public.lead_status not null default 'received',
  error              text,
  received_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  search             tsvector generated always as (
                       to_tsvector('simple',
                         coalesce(job_title,'') || ' ' || coalesce(industry,'') || ' ' ||
                         coalesce(company_mentioned,'') || ' ' || coalesce(client_name,'') || ' ' ||
                         coalesce(job_location,''))
                     ) stored
);

create index if not exists leads_job_id_idx       on public.leads (job_id);
create index if not exists leads_status_idx       on public.leads (status);
create index if not exists leads_received_idx     on public.leads (received_at desc);
create index if not exists leads_confidence_idx   on public.leads (overall_confidence);
create index if not exists leads_search_gin       on public.leads using gin (search);

-- ---------------------------------------------------------------------------
-- lead_contacts — every contact/channel found under one lead
-- ---------------------------------------------------------------------------
create table if not exists public.lead_contacts (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references public.leads(id) on delete cascade,
  list_type       public.contact_list not null,
  name            text,
  role            text,
  company         text,
  contact_type    text,                       -- raw label from the payload ("Business email")
  channel         public.channel_kind not null default 'other',
  contact_value   text not null,
  normalized_value text,                      -- lower(email) or trimmed url
  confidence      public.lead_confidence,
  rationale       text,                       -- notes || reason from the payload
  source_url      text,
  is_email        boolean not null default false,
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now()
);

create unique index if not exists lead_contacts_unique
  on public.lead_contacts (lead_id, list_type, lower(contact_value));
create index if not exists lead_contacts_email_idx  on public.lead_contacts (is_email);
create index if not exists lead_contacts_value_idx  on public.lead_contacts (normalized_value);
create index if not exists lead_contacts_lead_idx   on public.lead_contacts (lead_id);

-- ---------------------------------------------------------------------------
-- proposals — Groq output: PPD (pdfme JSON script) + email subject/content
-- ---------------------------------------------------------------------------
create table if not exists public.proposals (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.leads(id) on delete cascade,
  lead_contact_id  uuid references public.lead_contacts(id) on delete set null,
  version          integer not null default 1,
  provider         text not null default 'groq',
  model            text,
  ppd              jsonb not null,            -- Professional Proposal Document (JSON script)
  email_subject    text not null,
  email_content    text not null,             -- plain text body
  email_html       text,
  pdf_path         text,                      -- storage object: proposals/{leadId}/{proposalId}.pdf
  pdf_status       text not null default 'pending',  -- pending|ready|failed|skipped
  prompt_tokens    integer,
  completion_tokens integer,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists proposals_lead_idx    on public.proposals (lead_id, version desc);
create unique index if not exists proposals_contact_version
  on public.proposals (lead_contact_id, version) where lead_contact_id is not null;

-- ---------------------------------------------------------------------------
-- email_drafts — draft first, send later over the stored SMTP account
-- ---------------------------------------------------------------------------
create table if not exists public.email_drafts (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references public.leads(id) on delete cascade,
  lead_contact_id    uuid references public.lead_contacts(id) on delete set null,
  proposal_id        uuid references public.proposals(id) on delete set null,
  sender_account_id  uuid references public.sender_accounts(id) on delete set null,
  to_email           text not null,
  cc                 jsonb not null default '[]'::jsonb,
  subject            text not null,
  body_text          text not null,
  body_html          text,
  attachments        jsonb not null default '[]'::jsonb,   -- [{ path, filename, contentType }]
  status             public.draft_status not null default 'draft',
  scheduled_at       timestamptz,
  sent_at            timestamptz,
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists drafts_lead_idx    on public.email_drafts (lead_id, created_at desc);
create index if not exists drafts_status_idx  on public.email_drafts (status);
create index if not exists drafts_sender_idx  on public.email_drafts (sender_account_id);

-- Link the delivery log to everything that produced it.
alter table public.email_logs
  add column if not exists draft_id          uuid references public.email_drafts(id) on delete set null,
  add column if not exists proposal_id       uuid references public.proposals(id) on delete set null,
  add column if not exists sender_account_id uuid references public.sender_accounts(id) on delete set null;

create index if not exists email_logs_draft_idx on public.email_logs (draft_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sender_accounts','leads','proposals','email_drafts'] loop
    execute format('drop trigger if exists %1$s_set_updated_at on public.%1$s', t);
    execute format(
      'create trigger %1$s_set_updated_at before update on public.%1$s
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: the app uses the service-role key; nothing public by default
-- ---------------------------------------------------------------------------
alter table public.sender_accounts enable row level security;
alter table public.leads           enable row level security;
alter table public.lead_contacts   enable row level security;
alter table public.proposals       enable row level security;
alter table public.email_drafts    enable row level security;

-- ---------------------------------------------------------------------------
-- Storage bucket for generated proposal PDFs (private; service role writes)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('proposals', 'proposals', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Views the dashboard can use later
-- ---------------------------------------------------------------------------
create or replace view public.lead_pipeline as
select
  l.id,
  l.job_title,
  l.company_mentioned,
  l.client_name,
  l.overall_confidence,
  l.status,
  l.received_at,
  count(c.id) filter (where c.is_email)               as email_contacts,
  count(p.id)                                         as proposals,
  count(d.id) filter (where d.status = 'sent')        as sent,
  count(d.id) filter (where d.status = 'draft')       as drafts
from public.leads l
left join public.lead_contacts c on c.lead_id = l.id
left join public.proposals      p on p.lead_id = l.id
left join public.email_drafts   d on d.lead_id = l.id
group by l.id;

comment on table public.sender_accounts is 'Our sending mailboxes + SMTP config (password stored encrypted)';
comment on column public.proposals.ppd  is 'Professional Proposal Document as JSON, rendered by the pdfme template';
