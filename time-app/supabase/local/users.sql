-- Logins for supabase/local/verify.sh, created BEFORE the migrations run, the
-- way a real project already had its users when migration.sql first ran (its
-- backfill makes their profiles). Invented names. The two owner addresses are
-- the ones migration 31 keys on; they are business addresses, not personal.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'alina@withers-ventures.com', '{"full_name":"Owner One"}'),
  ('00000000-0000-0000-0000-0000000000a2', 'alex@withers-ventures.com',  '{"full_name":"Owner Two"}'),
  ('00000000-0000-0000-0000-00000000000a', 'manager@example.test',       '{"full_name":"Test Manager"}'),
  ('00000000-0000-0000-0000-00000000000b', 'employee@example.test',      '{"full_name":"Test Employee"}'),
  ('00000000-0000-0000-0000-00000000000c', 'second@example.test',        '{"full_name":"Second Employee"}');
