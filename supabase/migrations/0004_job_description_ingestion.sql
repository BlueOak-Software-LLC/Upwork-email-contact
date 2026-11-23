-- 0004: job_information.job_description as a first-class field
--
-- The scraper now sends the post text inside job_information
-- (`job_description`). It was already stored in leads.job_description and already
-- feeds both Groq prompts; this migration makes it searchable and gives the
-- recipient-less proposal lane its own version numbering.
--
-- Run AFTER 0003 (the operations view below reads proposals.ppd_reviewed_at).

-- ── 1. full-text search has to see the post body ───────────────────────────
-- `search` is a generated tsvector, so it must be dropped and re-created with
-- the extra column. Column order in leads is unchanged; the GIN index is rebuilt.
alter table public.leads drop column if exists search;

alter table public.leads add column search tsvector generated always as (
  to_tsvector(
    'simple',
    coalesce(job_title, '') || ' ' || coalesce(industry, '') || ' ' ||
    coalesce(company_mentioned, '') || ' ' || coalesce(client_name, '') || ' ' ||
    coalesce(job_location, '') || ' ' || coalesce(job_description, '')
  )
) stored;

create index if not exists leads_search_gin on public.leads using gin (search);

comment on column public.leads.job_description is
  'job_information.job_description, verbatim from the payload. Primary source of facts for the PPD and the email draft; a payload with no contacts still gets a document written from this text.';

comment on column public.leads.search is
  'generated tsvector over title, industry, company, client, location and the post body (0004)';

-- ── 2. recipient-less proposals ───────────────────────────────────────────
-- A contact-less document is a normal state now, not a broken join. 0002 keeps
-- `proposals_contact_version` (unique per recipient); this is its null twin.
create unique index if not exists proposals_lead_nocontact_version
  on public.proposals (lead_id, version)
  where lead_contact_id is null;

-- ── 3. leads waiting only on an address are easy to find ──────────────────
-- Operations view for "PPD written, no recipient yet": these are ready for the
-- email step with a custom toEmail.
create or replace view public.leads_awaiting_recipient as
select
  l.id,
  l.job_title,
  l.company_mentioned,
  l.client_name,
  l.status,
  length(coalesce(l.job_description, '')) as description_chars,
  (p.id is not null)                       as ppd_written,
  p.ppd_reviewed_at,
  p.updated_at                             as proposal_updated_at
from public.leads l
left join lateral (
  select id, ppd_reviewed_at, updated_at
  from public.proposals pr
  where pr.lead_id = l.id and pr.lead_contact_id is null
  order by pr.version desc
  limit 1
) p on true
where not exists (
  select 1
  from public.lead_contacts lc
  where lc.lead_id = l.id and lc.is_email
);

comment on view public.leads_awaiting_recipient is
  'Leads with no email contact; ppd_written says whether a recipient-less document already exists';
