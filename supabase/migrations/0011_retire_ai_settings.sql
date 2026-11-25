-- 0011_retire_ai_settings.sql
--
-- The PPD and email writers now run inside the signed-in ChatGPT tab. The
-- server never calls a model API, so the old per-provider key table has no
-- reader left. Drop it rather than leave encrypted credentials behind, and
-- make new proposals record the real provider by default.

drop table if exists public.ai_settings;

alter table public.proposals
  alter column provider set default 'chatgpt-session';

comment on column public.proposals.provider is
  'chatgpt-session for documents written through the browser extension';

notify pgrst, 'reload schema';