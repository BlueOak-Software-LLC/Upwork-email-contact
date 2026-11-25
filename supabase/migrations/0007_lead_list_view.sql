-- ---------------------------------------------------------------------------
-- 0007_lead_list_view.sql — one row per lead, with the counts the list needs
--
-- Why a view instead of embedded PostgREST counts:
--   * the leads table is filtered by pipeline state ("doc ready", "both ready"),
--     which is a count predicate PostgREST cannot express on an embedded table;
--   * a view keeps the filter, exact count, sort and pagination in Postgres, so
--     page 2 is page 2 even while new leads arrive;
--   * the old public.lead_pipeline view multiplies proposals by contacts and
--     drafts because it joins three one-to-many relations at once.
--
-- Counts are correlated subqueries, not joins, so they stay correct and use the
-- existing proposals_lead_idx / drafts_lead_idx / lead_contacts_lead_idx.
-- ---------------------------------------------------------------------------

create index if not exists leads_created_at_idx
  on public.leads (created_at desc);

create or replace view public.lead_list as
select
  l.*,
  (select count(*)::int from public.lead_contacts c where c.lead_id = l.id) as contact_count,
  (select count(*)::int from public.proposals p where p.lead_id = l.id)     as proposal_count,
  (select count(*)::int from public.email_drafts d where d.lead_id = l.id)  as draft_count
from public.leads l;

comment on view public.lead_list is
  'Leads with contact/proposal/draft counts — filterable by pipeline state, sorted by created_at';

-- The app uses the service-role key. Do not expose lead data through anon/auth.
revoke all on public.lead_list from public;
revoke all on public.lead_list from anon, authenticated;
grant select on public.lead_list to service_role;
