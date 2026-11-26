-- 0012_sender_company_name.sql
-- Optional public company identity for the email signature.

alter table public.sender_accounts
  add column if not exists company_name text;

comment on column public.sender_accounts.company_name is
  'Company name shown as a linked label in the email signature (optional).';

notify pgrst, 'reload schema';
