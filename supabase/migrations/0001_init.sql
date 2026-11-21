-- =============================================================================
-- 0001_init.sql — Upwork email contact
-- Run: supabase db push   |   or paste into the Supabase SQL editor
-- =============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.contact_status as enum
    ('new', 'contacted', 'replied', 'no_reply', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.email_log_status as enum
    ('queued', 'sent', 'failed', 'bounced');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- contacts — the rows the dashboard lists
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(name) between 1 and 160),
  email             text not null,
  company           text,
  role              text,
  status            public.contact_status not null default 'new',
  source            text not null default 'manual',
  tags              text[] not null default '{}',
  notes             text,
  last_contacted_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- case-insensitive uniqueness on email
create unique index if not exists contacts_email_lower_key
  on public.contacts (lower(email));

create index if not exists contacts_status_idx      on public.contacts (status);
create index if not exists contacts_created_at_idx  on public.contacts (created_at desc);
create index if not exists contacts_tags_gin        on public.contacts using gin (tags);
create index if not exists contacts_search_trgm
  on public.contacts using gin (to_tsvector('simple', coalesce(name,'') || ' ' ||
                                            coalesce(company,'') || ' ' || email));

-- ---------------------------------------------------------------------------
-- email_logs — one row per recipient per send (API #2 writes these)
-- ---------------------------------------------------------------------------
create table if not exists public.email_logs (
  id                  uuid primary key default gen_random_uuid(),
  contact_id          uuid references public.contacts(id) on delete set null,
  to_email            text not null,
  from_email          text not null,
  subject             text not null,
  body_text           text not null default '',
  status              public.email_log_status not null default 'queued',
  provider            text not null default 'log',
  provider_message_id text,
  error               text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists email_logs_created_at_idx on public.email_logs (created_at desc);
create index if not exists email_logs_status_idx     on public.email_logs (status);
create index if not exists email_logs_contact_idx    on public.email_logs (contact_id);
create index if not exists email_logs_to_idx         on public.email_logs (lower(to_email));

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
--   The app reads/writes with the service-role key (bypasses RLS), so we
--   enable RLS and expose nothing to `anon` / `authenticated` by default.
--   Add policies below when you want the browser to query Supabase directly.
-- ---------------------------------------------------------------------------
alter table public.contacts  enable row level security;
alter table public.email_logs enable row level security;

-- Example (uncomment to let signed-in users manage their own rows):
-- create policy "authenticated read contacts" on public.contacts
--   for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Convenience view for the funnel
-- ---------------------------------------------------------------------------
create or replace view public.contact_funnel as
select
  status,
  count(*)                                                        as contacts,
  count(*) filter (where last_contacted_at is not null)           as touched,
  max(last_contacted_at)                                          as last_touch_at
from public.contacts
group by status
order by status;

comment on table public.contacts  is 'Outreach targets synced from Upwork leads';
comment on table public.email_logs is 'Delivery audit trail written by POST /api/email/send';
