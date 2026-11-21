-- Demo rows for local development:  psql "$DB_URL" -f supabase/seed.sql
insert into public.contacts (name, email, company, role, status, source, tags, notes)
values
  ('Jane Cooper',      'jane@northwindlabs.io',  'Northwind Labs',  'Head of Growth', 'new',       'upwork', array['saas','us-market'],        'Replied to the CRM migration job post.'),
  ('Devon Lane',       'devon@brightpath.co',    'Brightpath',      'CTO',            'contacted', 'upwork', array['fintech'],                 null),
  ('Aisha Rahman',     'aisha@lumencare.health', 'Lumencare',       'Product Lead',   'replied',   'upwork', array['health','eu-market'],      'Wants a proposal before the board meeting.'),
  ('Marco Rossi',      'marco@veloce.dev',       'Veloce',          'Founder',        'no_reply',  'manual', array['devtools'],                'Follow-up scheduled for next week.'),
  ('Priya Nair',       'priya@atlasfleet.com',   'Atlas Fleet',     'Ops Manager',    'new',       'upwork', array['logistics'],               null),
  ('Sam Whitaker',     'sam@orbitpay.io',        'OrbitPay',        'CEO',            'contacted', 'upwork', array['fintech','us-market'],     null),
  ('Elena Petrova',    'elena@kiteanalytics.eu', 'Kite Analytics',  'Data Lead',      'archived',  'import', array['analytics'],               'Budget cut — revisit in Q4.')
on conflict (lower(email)) do nothing;
