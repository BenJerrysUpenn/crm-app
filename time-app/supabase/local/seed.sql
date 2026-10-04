-- Invented people for supabase/local/verify.sh. handle_new_user makes their
-- profiles; the verify files need a manager and at least one employee.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'manager@example.test',  '{"full_name":"Test Manager"}'),
  ('00000000-0000-0000-0000-00000000000b', 'employee@example.test', '{"full_name":"Test Employee"}'),
  ('00000000-0000-0000-0000-00000000000c', 'second@example.test',   '{"full_name":"Second Employee"}');
update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-00000000000a';
