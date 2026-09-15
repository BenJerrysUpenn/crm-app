-- ============================================================================
-- Withers Time — migration 21: stop using the login email as a person's name
-- Run once in the Supabase SQL editor, after migration_20.sql. Safe to re-run.
--
-- handle_new_user (the on_auth_user_created trigger on auth.users) used to do
--   coalesce(raw_user_meta_data ->> 'full_name', new.email)
-- so any account created without a name in its metadata got its email address
-- as profiles.full_name. Accounts made in the Supabase dashboard (Add user ->
-- Create new user) never carry metadata, and the Team page's add form used to
-- make the name optional, so new hires showed up as an email everywhere.
--
-- From now on the trigger stores the name from the metadata (full_name, else
-- name), trimmed, or null. It never falls back to the email, and a value that
-- looks like an email counts as no name. The Team page's add form now
-- requires a name.
--
-- No RLS changes.
-- ============================================================================

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_name text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), '')
  );
  if strpos(v_name, '@') > 0 then
    v_name := null;
  end if;

  insert into public.profiles (id, full_name)
  values (new.id, v_name)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Backfill the one person whose real name we know. Guarded on the current
-- value, so a re-run (or a name a manager has since corrected) is left alone.
update public.profiles
   set full_name = 'Davianna Shirdan'
 where id = '28858f87-0cb6-477b-8e02-15a383cf6fb8'
   and full_name = 'doshirdan05@gmail.com';

-- Still holding an email as their name after this migration, all inactive.
-- Their real names aren't on record, so they are NOT guessed here. Tracked as
-- bj-finance #468 Withers-time name display and validation follow-ups:
--   56f2823b-66d6-4be0-9c1a-27740df214bc  chavi@withers-ventures.com
--   2bf58dbb-54d9-4765-b3e4-0a5e2bbb07e4  reylanas@icloud.com
--   e0474a0f-e2a0-41d6-b6ef-bf1249a05cba  josephpettine@gmail.com

commit;
