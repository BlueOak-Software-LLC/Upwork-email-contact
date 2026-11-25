-- 0010_sender_profile.sql
--
-- The PPD and every email sign-off are written in a person's own name, not a
-- company's. These columns are that person's public profile: the only source
-- the server stamps onto a proposal, and the only experience the email writer
-- is allowed to claim.

alter table public.sender_accounts
  add column if not exists role_title text,
  add column if not exists phone text,
  add column if not exists whatsapp text,
  add column if not exists linkedin_url text,
  add column if not exists website text,
  add column if not exists location text,
  add column if not exists experience_summary text,
  add column if not exists skills text;

comment on column public.sender_accounts.role_title is
  'Role printed under the name in the PPD and sign-off, e.g. Senior Software Engineer.';
comment on column public.sender_accounts.phone is
  'Phone number printed on the PPD (optional).';
comment on column public.sender_accounts.whatsapp is
  'WhatsApp number or wa.me link printed on the PPD (optional).';
comment on column public.sender_accounts.linkedin_url is
  'LinkedIn profile URL printed on the PPD and email sign-off (optional).';
comment on column public.sender_accounts.website is
  'Personal/portfolio website printed on the PPD (optional).';
comment on column public.sender_accounts.location is
  'City / timezone line printed on the PPD (optional).';
comment on column public.sender_accounts.experience_summary is
  'The real experience of this sender. The email prompt may use it; the model must not invent it.';
comment on column public.sender_accounts.skills is
  'Comma- or newline-separated skills used to select relevant experience for an email.';

-- No RLS change here: sender accounts already follow the dashboard's existing
-- access model. Do not add a public read policy; the API returns only the
-- public columns above and never the SMTP cipher.

notify pgrst, 'reload schema';
