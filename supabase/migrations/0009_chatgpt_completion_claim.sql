-- =============================================================================
-- 0009 — claim finalisation before writing the proposal/draft
-- =============================================================================
-- Two dashboard tabs can receive the same ChatGPT answer (a reloaded page, a
-- manual paste racing the extension, or two people watching one lead). The
-- conditional queued/running → completing update in `chatgptJobsRepo` is the
-- lock: only the winner writes the proposal/draft. Without it, both requests
-- could insert a proposal version or a follow-up before either marked the job
-- completed.
-- =============================================================================

alter table public.chatgpt_jobs
  drop constraint if exists chatgpt_jobs_status_check;
alter table public.chatgpt_jobs
  add constraint chatgpt_jobs_status_check
  check (status in (
    'queued', 'running', 'completing', 'completed', 'failed', 'cancelled'
  ));

-- `completing` still occupies the live slot: a second run must not start while
-- the first answer is being parsed and stored.
drop index if exists public.chatgpt_jobs_one_live_kind_idx;
create unique index if not exists chatgpt_jobs_one_live_kind_idx
  on public.chatgpt_jobs (lead_id, kind)
  where status in ('queued', 'running', 'completing');

comment on column public.chatgpt_jobs.status is
  'queued/running = browser work; completing = one server request is parsing and writing the result; completed/failed/cancelled = terminal.';