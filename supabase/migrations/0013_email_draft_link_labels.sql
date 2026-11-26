-- 0013_email_draft_link_labels.sql
-- Drop saved email-draft overrides that still ask for the old "[URL](URL)" links.
-- Those rows would keep overriding the new default ([Label](URL)). Overrides that
-- were already rewritten are left alone. Same as "Reset to default" in Settings.

delete from public.prompt_templates
where key = 'email_draft'
  and (system_text like '%[URL](URL)%' or user_template like '%[URL](URL)%');
