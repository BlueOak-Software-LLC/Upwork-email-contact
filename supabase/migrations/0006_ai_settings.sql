-- 0006_ai_settings.sql
--
-- Per-provider AI configuration saved from /settings/models.
--
-- One row per provider, written only when the operator changes something.
-- An absent row means "use the environment variable, then the built-in free
-- default" — so an existing deployment keeps working without seeding anything,
-- and a provider with no key (row or env) is skipped by the generation chain.
--
-- The API key is encrypted with APP_ENCRYPTION_KEY (AES-256-GCM) exactly like
-- sender_accounts.smtp_password_cipher. The service role is the only reader;
-- there is no RLS policy because nothing with an anon key should see a key.

create table if not exists public.ai_settings (
  provider          text primary key,
  -- v1:<iv>:<tag>:<ciphertext>; null means "fall back to the env var".
  api_key_cipher    text,
  -- Null means "use the env var (PUTER_MODEL / GROQ_MODEL / GEMINI_MODEL),
  -- then the free default in src/lib/ai-models.ts".
  model             text,
  fallback_model    text,
  enabled           boolean not null default true,
  updated_at        timestamptz not null default now(),
  constraint ai_settings_provider_check check (provider in ('puter', 'groq', 'gemini'))
);

comment on table public.ai_settings is
  'Per-provider AI configuration saved from /settings/models. Absent row = env/default.';
comment on column public.ai_settings.api_key_cipher is
  'AES-256-GCM envelope (v1:...) of the provider credential; never returned to the browser.';
comment on column public.ai_settings.enabled is
  'false keeps the key but skips the provider in the generation chain.';

drop trigger if exists ai_settings_set_updated_at on public.ai_settings;
create trigger ai_settings_set_updated_at
  before update on public.ai_settings
  for each row execute function public.set_updated_at();

alter table public.ai_settings enable row level security;

-- Server-only, like tracked_links and the tracking RPCs: the service role is the
-- only principal that reads or writes this table.
revoke all on table public.ai_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_settings to service_role;
