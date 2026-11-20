-- Roles for the logins in users.sql, set after every migration has run, as
-- they are in production: one manager on the roster, the owners off it.
update public.profiles set role = 'manager' where id = '00000000-0000-0000-0000-00000000000a';
update public.profiles set active = false
 where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
