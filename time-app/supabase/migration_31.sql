-- ============================================================================
-- Withers Time, migration 31: the owner role
-- Run once in the Supabase SQL editor, after migration_30.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_31_verify.sql. ROLLBACK. supabase/migration_31_down.sql.
--
-- APPLY ORDER. Deploy both apps (crm and time) FIRST, then run this file,
-- promptly.
--   * New code, old database: nobody has the owner role yet, so the
--     personal-finance pages (/money, /dial, /safe) refuse everyone until this
--     file runs. Every manager gate works as before. Nothing else changes.
--   * Old code, new database: the old code only lets role = 'manager' through,
--     so the two owners would be shut out of the CRM and the time app's
--     manager pages until the new code deploys. Do not run this file first.
--
-- WHAT THIS DOES
--   1. Refuses to run if any RLS policy in the database tests role = 'manager'
--      itself instead of calling is_manager(). Such a policy would stop
--      letting the owners in the moment their role changes. (None exist in
--      this repository; this covers tables created elsewhere.)
--   2. profiles.role may now be 'owner', 'manager' or 'employee'.
--   3. public.is_owner(): true only for an owner. Same shape as is_manager().
--   4. public.is_manager() is now true for owners as well as managers, so an
--      owner keeps every manager policy in the database without any policy
--      being edited.
--   5. guard_owner_profiles(), BEFORE INSERT/UPDATE/DELETE on profiles: a
--      signed-in person who is not an owner cannot create an owner, give or
--      take away the owner role, or change or delete an owner's row. Managers
--      reach every profile through profiles_manager_all, so without this the
--      Team page's API would be the only thing stopping them.
--   6. The two owners, keyed on their login emails, become 'owner'. If either
--      account is missing the whole file rolls back rather than leave one
--      owner in place.
--
-- NOT CHANGED. `active` still means "on the staff roster" and still plays no
-- part in access (audit H2); the owners stay off the roster.
--
-- (select public.is_owner()) and (select public.is_manager()) are wrapped in
-- scalar subqueries: a bare call is re-evaluated per row and has caused
-- statement timeouts in this project (crm/004).
-- ============================================================================

begin;

-- ---------- 1. no policy may test the role by hand ---------------------------
do $$
declare
  offenders text;
begin
  select string_agg(format('%I.%I policy %I', schemaname, tablename, policyname), ', ')
    into offenders
    from pg_policies
   where coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '''manager''';
  if offenders is not null then
    raise exception 'migration 31: these policies test role = ''manager'' directly and would shut the owners out once their role is ''owner'': %. Rewrite them to use (select public.is_manager()) first.', offenders;
  end if;
end $$;

-- ---------- 2. the role column ------------------------------------------------
-- migration.sql declared the check inline, so its name is whatever Postgres
-- chose (profiles_role_check). Drop every CHECK on profiles that mentions the
-- role column, whatever it is called, and put back one with a known name.
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~ '\mrole\M'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles add constraint profiles_role_check
  check (role in ('owner', 'manager', 'employee'));

-- ---------- 3 and 4. the helpers ---------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner'
  );
$$;

-- An owner is a manager for every manager policy in both apps.
create or replace function public.is_manager()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('manager', 'owner')
  );
$$;

-- ---------- 5. managers cannot touch the owner role --------------------------
-- Only a request running as the API's signed-in role is checked. The service
-- role (the invite route's upsert, offboarding), the SQL editor and SECURITY
-- DEFINER code are trusted, as in migration 30's claim guard. The invite and
-- re-invite routes refuse a manager themselves before they reach the service
-- role (lib/roles.ts).
create or replace function public.guard_owner_profiles()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'authenticated' or (select public.is_owner()) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'owner' then
      raise exception 'Only an owner can make someone an owner'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'owner' then
      raise exception 'Only an owner can remove an owner'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  -- UPDATE
  if old.role = 'owner' and to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'Only an owner can change an owner''s account'
      using errcode = 'insufficient_privilege';
  end if;
  if new.role = 'owner' and old.role is distinct from 'owner' then
    raise exception 'Only an owner can make someone an owner'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.guard_owner_profiles() is
  'BEFORE INSERT/UPDATE/DELETE on profiles: a signed-in non-owner cannot create, promote to, demote from, edit or delete an owner. Migration 31.';

revoke execute on function public.guard_owner_profiles() from public, anon, authenticated, service_role;

drop trigger if exists profiles_owner_guard on public.profiles;
create trigger profiles_owner_guard
  before insert or update or delete on public.profiles
  for each row execute function public.guard_owner_profiles();

-- ---------- 6. the owners -----------------------------------------------------
-- Their login emails are business addresses. `active` is left as it is.
do $$
declare
  missing text;
begin
  select string_agg(e, ', ')
    into missing
    from unnest(array['alina@withers-ventures.com', 'alex@withers-ventures.com']) as e
   where not exists (
     select 1 from auth.users u join public.profiles p on p.id = u.id
      where lower(u.email) = e
   );
  if missing is not null then
    raise exception 'migration 31: no profile for %. Nothing was changed.', missing;
  end if;

  update public.profiles p
     set role = 'owner'
    from auth.users u
   where u.id = p.id
     and lower(u.email) in ('alina@withers-ventures.com', 'alex@withers-ventures.com');
end $$;

commit;
