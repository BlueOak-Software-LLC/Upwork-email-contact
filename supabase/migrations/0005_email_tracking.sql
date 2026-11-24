-- =============================================================================
-- 0005_email_tracking.sql — open pixel + link-click tracking
--
-- Ports the BlueOak Track mechanism onto this schema. The subject of tracking
-- here is `public.email_logs`, which already holds one row per recipient per
-- send, so a pixel hit identifies *which person* opened *which* message rather
-- than just "the draft was opened".
--
-- `email_logs.status` stays about DELIVERY (queued/sent/failed/bounced);
-- engagement is derived from the counters below, so no enum has to change and
-- nothing needs backfilling. Rows written before this migration simply have
-- `tracking_token is null` and report as "not tracked".
--
-- Run AFTER 0004. Safe to re-apply.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ── 1. delivery log gains its tracking identity + counters ──────────────────
alter table public.email_logs
  add column if not exists tracking_token      text,
  add column if not exists open_count          integer not null default 0,
  add column if not exists click_count         integer not null default 0,
  add column if not exists unique_click_count  integer not null default 0,
  add column if not exists first_open_at       timestamptz,
  add column if not exists last_open_at        timestamptz,
  add column if not exists first_click_at      timestamptz,
  add column if not exists last_click_at       timestamptz,
  add column if not exists last_event_at       timestamptz;

-- The pixel route resolves a token to a row on every image request.
create unique index if not exists email_logs_tracking_token_idx
  on public.email_logs (tracking_token)
  where tracking_token is not null;
-- "sent, never opened" and the default activity ordering.
create index if not exists email_logs_sent_at_idx
  on public.email_logs (sent_at desc)
  where status = 'sent';
create index if not exists email_logs_last_event_idx
  on public.email_logs (last_event_at desc nulls last);

do $$ begin
  alter table public.email_logs
    add constraint email_logs_open_count_check check (open_count >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.email_logs
    add constraint email_logs_click_count_check check (click_count >= 0);
exception when duplicate_object then null; end $$;

-- ── 2. tracked links: /c/<token> → destination ──────────────────────────────
-- Per log row, not per draft: two recipients of the same draft each get their
-- own tokens, so a forward of one person's email cannot inflate another's counts.
create table if not exists public.tracked_links (
  id              uuid primary key default gen_random_uuid(),
  log_id          uuid not null references public.email_logs(id) on delete cascade,
  token           text not null,
  destination_url text not null,
  label           text not null default '',
  click_count     integer not null default 0 check (click_count >= 0),
  first_click_at  timestamptz,
  last_click_at   timestamptz,
  created_at      timestamptz not null default now()
);

create unique index if not exists tracked_links_token_idx on public.tracked_links (token);
create index if not exists tracked_links_log_idx          on public.tracked_links (log_id);

-- ── 3. the event stream (append-only, no raw IP addresses) ──────────────────
create table if not exists public.tracking_events (
  id          uuid primary key default gen_random_uuid(),
  log_id      uuid not null references public.email_logs(id) on delete cascade,
  link_id     uuid references public.tracked_links(id) on delete set null,
  event_type  text not null check (
    event_type in ('open', 'click', 'sent', 'reply', 'meeting', 'not_interested')
  ),
  occurred_at timestamptz not null default now(),
  user_agent  text,
  metadata    jsonb not null default '{}'::jsonb
);

create index if not exists tracking_events_log_idx     on public.tracking_events (log_id, occurred_at desc);
create index if not exists tracking_events_link_idx    on public.tracking_events (link_id);
create index if not exists tracking_events_type_idx    on public.tracking_events (event_type, occurred_at desc);
create index if not exists tracking_events_occurred_idx on public.tracking_events (occurred_at desc);

comment on table public.tracking_events is
  'Open rows are tracked-image requests, not confirmed human reads. Clicks come from /c/<token>. No IP addresses are stored; user_agent is truncated to 300 characters.';

-- ── 4. server-only RPCs ─────────────────────────────────────────────────────
-- Every one of these is called with the service-role key from `src/server/**`.
-- `security invoker` + the role guard means neither `anon` nor `authenticated`
-- can reach them through PostgREST, so the public tracking routes cannot become
-- a data oracle.

/**
 * The whole tracking hot path in ONE statement: lock the row, deduplicate,
 * apply the per-day cap, write the event and move the counters — atomically.
 *
 * Mirrors BlueOak Track's `record_tracking_event`, but keyed on email_logs:
 *   open  → email_logs.tracking_token
 *   click → tracked_links.token → its log_id
 *
 * Returns a compact jsonb on purpose: the full log row carries `body_text`
 * (up to 20 KB), which has no business being in a pixel response path.
 */
create or replace function public.record_tracking_event(
  p_kind text, p_token text, p_agent text, p_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  e public.email_logs;
  l public.tracked_links;
  v public.tracking_events;
  day_start timestamptz := date_trunc('day', p_at at time zone 'UTC') at time zone 'UTC';
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  if p_kind not in ('open', 'click') then raise exception 'invalid event'; end if;
  -- Rejected before touching the tables: a token is 16-128 URL-safe characters.
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{16,128}$' then
    return '{"found":false,"recorded":false}'::jsonb;
  end if;

  -- The retention job takes the exclusive version of this lock, so a purge can
  -- never recompute counters from rows it is halfway through deleting.
  perform pg_advisory_xact_lock_shared(7341002);

  if p_kind = 'open' then
    select * into e from public.email_logs where tracking_token = p_token for update;
  else
    select * into l from public.tracked_links where token = p_token;
    if not found then return '{"found":false,"recorded":false}'::jsonb; end if;
    select * into e from public.email_logs where id = l.log_id for update;
  end if;
  if not found then return '{"found":false,"recorded":false}'::jsonb; end if;

  if p_kind = 'open' then
    -- One image request per client per minute: Gmail/Outlook fetch the pixel
    -- repeatedly for the same view, and a prefetch is not three opens.
    if exists (
      select 1 from public.tracking_events
      where log_id = e.id and event_type = 'open'
        and user_agent = left(coalesce(p_agent, ''), 300)
        and occurred_at >= p_at - interval '60 seconds') then
      return '{"found":true,"recorded":false,"duplicate":true}'::jsonb;
    end if;
    if (select count(*) from public.tracking_events
        where log_id = e.id and event_type = 'open' and occurred_at >= day_start) >= 40 then
      return '{"found":true,"recorded":false,"capped":true}'::jsonb;
    end if;
  else
    select * into l from public.tracked_links where token = p_token for update;
    if not found then return '{"found":false,"recorded":false}'::jsonb; end if;
    if (select count(*) from public.tracking_events
        where link_id = l.id and event_type = 'click' and occurred_at >= day_start) >= 200 then
      return '{"found":true,"recorded":false,"capped":true}'::jsonb;
    end if;
  end if;

  insert into public.tracking_events (log_id, link_id, event_type, occurred_at, user_agent, metadata)
    values (e.id,
            case when p_kind = 'click' then l.id else null end,
            p_kind, p_at, left(coalesce(p_agent, ''), 300),
            jsonb_build_object('source', case when p_kind = 'click' then 'tracked-link' else 'tracking-pixel' end))
    returning * into v;

  -- least/greatest ignore NULL inputs, so the first event seeds both ends.
  if p_kind = 'open' then
    update public.email_logs set
      open_count     = open_count + 1,
      first_open_at  = least(first_open_at, p_at),
      last_open_at   = greatest(last_open_at, p_at),
      last_event_at  = greatest(last_event_at, p_at)
    where id = e.id returning * into e;
  else
    update public.email_logs set
      click_count        = click_count + 1,
      unique_click_count = unique_click_count + case when l.click_count = 0 then 1 else 0 end,
      first_click_at     = least(first_click_at, p_at),
      last_click_at      = greatest(last_click_at, p_at),
      last_event_at      = greatest(last_event_at, p_at)
    where id = e.id returning * into e;
    update public.tracked_links set
      click_count    = click_count + 1,
      first_click_at = least(first_click_at, p_at),
      last_click_at  = greatest(last_click_at, p_at)
    where id = l.id returning * into l;
  end if;

  return jsonb_build_object(
    'found', true, 'recorded', true,
    'log',   jsonb_build_object('id', e.id, 'status', e.status, 'to_email', e.to_email,
                                'subject', e.subject, 'contact_id', e.contact_id,
                                'open_count', e.open_count, 'click_count', e.click_count,
                                'unique_click_count', e.unique_click_count,
                                'first_open_at', e.first_open_at, 'last_open_at', e.last_open_at,
                                'first_click_at', e.first_click_at, 'last_click_at', e.last_click_at,
                                'last_event_at', e.last_event_at),
    'event', jsonb_build_object('id', v.id, 'log_id', v.log_id, 'link_id', v.link_id,
                                'event_type', v.event_type, 'occurred_at', v.occurred_at,
                                'user_agent', v.user_agent, 'metadata', v.metadata),
    'link',  case when p_kind = 'click'
             then jsonb_build_object('id', l.id, 'token', l.token,
                                     'destination_url', l.destination_url, 'label', l.label,
                                     'click_count', l.click_count)
             else null end);
end $$;

/**
 * A human says what happened: the client replied, a meeting happened, or they
 * are not interested. The app never reads a mailbox, so these are manual — but
 * recording them is what keeps the Overview reply rate honest.
 */
create or replace function public.record_log_outcome(
  p_log_id uuid, p_kind text, p_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  e public.email_logs;
  v public.tracking_events;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  if p_kind not in ('reply', 'meeting', 'not_interested') then
    raise exception 'invalid outcome';
  end if;

  select * into e from public.email_logs where id = p_log_id for update;
  if not found then return '{"found":false,"recorded":false}'::jsonb; end if;

  insert into public.tracking_events (log_id, event_type, occurred_at, metadata)
    values (e.id, p_kind, p_at, jsonb_build_object('source', 'manual'))
    returning * into v;

  update public.email_logs
  set last_event_at = greatest(last_event_at, p_at)
  where id = e.id;

  -- Fold the outcome into the CRM row, but never downgrade a real reply.
  update public.contacts
  set status = case when p_kind = 'not_interested'
                    then 'no_reply'::public.contact_status
                    else 'replied'::public.contact_status end,
      last_contacted_at = greatest(last_contacted_at, p_at)
  where id = e.contact_id
    and e.contact_id is not null
    and status <> 'replied'::public.contact_status;

  return jsonb_build_object(
    'found', true, 'recorded', true,
    'log_id', e.id,
    'event', jsonb_build_object('id', v.id, 'log_id', v.log_id, 'event_type', v.event_type,
                                'occurred_at', v.occurred_at, 'metadata', v.metadata));
end $$;

/**
 * Retention: drop old open/click rows, then rebuild every counter from what is
 * left. Outcomes (`reply`/`meeting`/`not_interested`) and the delivery log
 * itself are never deleted — the trail of *what we sent* survives, only the
 * high-volume pixel traffic ages out.
 */
create or replace function public.purge_tracking_events(p_before timestamptz)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  removed integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;

  -- Blocks the shared lock every event insert takes.
  perform pg_advisory_xact_lock(7341002);

  delete from public.tracking_events
  where occurred_at < p_before
    and event_type in ('open', 'click');
  get diagnostics removed = row_count;

  update public.tracked_links link
  set click_count    = stats.n,
      first_click_at = stats.first_at,
      last_click_at  = stats.last_at
  from (
    select link_id, count(*)::integer as n, min(occurred_at) as first_at, max(occurred_at) as last_at
    from public.tracking_events
    where event_type = 'click' and link_id is not null
    group by link_id
  ) stats
  where link.id = stats.link_id;

  update public.tracked_links link
  set click_count = 0, first_click_at = null, last_click_at = null
  where not exists (
    select 1 from public.tracking_events event
    where event.link_id = link.id and event.event_type = 'click'
  );

  update public.email_logs email
  set open_count    = (select count(*) from public.tracking_events event
                       where event.log_id = email.id and event.event_type = 'open'),
      first_open_at = (select min(occurred_at) from public.tracking_events event
                       where event.log_id = email.id and event.event_type = 'open'),
      last_open_at  = (select max(occurred_at) from public.tracking_events event
                       where event.log_id = email.id and event.event_type = 'open'),
      click_count   = (select count(*) from public.tracking_events event
                       where event.log_id = email.id and event.event_type = 'click'),
      first_click_at = (select min(occurred_at) from public.tracking_events event
                        where event.log_id = email.id and event.event_type = 'click'),
      last_click_at  = (select max(occurred_at) from public.tracking_events event
                        where event.log_id = email.id and event.event_type = 'click'),
      unique_click_count = (select count(*) from public.tracked_links link
                            where link.log_id = email.id and link.click_count > 0)
  where email.open_count > 0 or email.click_count > 0;

  update public.email_logs email
  set last_event_at = (select max(occurred_at) from public.tracking_events event where event.log_id = email.id)
  where exists (
    select 1 from public.tracking_events event where event.log_id = email.id
  )
    and last_event_at is distinct from (
      select max(occurred_at) from public.tracking_events event where event.log_id = email.id
    );

  update public.email_logs
  set last_event_at = null
  where last_event_at is not null
    and not exists (select 1 from public.tracking_events event where event.log_id = email_logs.id);

  return removed;
end $$;

-- ── 5. RLS: on, and nothing is readable without the service role ────────────
-- The public /o and /c routes go through the RPCs above with the service-role
-- key; no anon/authenticated policy is created on purpose.
alter table public.tracked_links   enable row level security;
alter table public.tracking_events enable row level security;

revoke all on function public.record_tracking_event(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_log_outcome(uuid, text, timestamptz)          from public, anon, authenticated;
revoke all on function public.purge_tracking_events(timestamptz)                   from public, anon, authenticated;
grant execute on function public.record_tracking_event(text, text, text, timestamptz) to service_role;
grant execute on function public.record_log_outcome(uuid, text, timestamptz)          to service_role;
grant execute on function public.purge_tracking_events(timestamptz)                  to service_role;

comment on column public.email_logs.tracking_token is
  'Pixel secret for this recipient: /o/<token>.gif. Null on rows sent before tracking was enabled.';
comment on table public.tracked_links is
  'Per-recipient redirect targets for /c/<token>. Destinations are validated at click time, not just at send time.';
