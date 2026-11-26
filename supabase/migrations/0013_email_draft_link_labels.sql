-- 0013_email_draft_link_labels.sql
-- Drop saved email-draft overrides that still use the old rules: "[URL](URL)" links,
-- em/en dashes, bold, or the old 2-4 link list. Those rows would keep overriding the
-- new spam-safe default. Overrides already rewritten are left alone. Same as
-- "Reset to default" in Settings.

delete from public.prompt_templates
where key = 'email_draft'
  and (
    system_text like '%[URL](URL)%' or user_template like '%[URL](URL)%'
    or system_text like '%—%' or user_template like '%—%'
    or system_text like '%–%' or user_template like '%–%'
    or system_text like '%**%' or user_template like '%**%'
  );
