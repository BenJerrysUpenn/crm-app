-- ============================================================================
-- Withers Time, rollback for migration 31 (the owner role)
--
-- Every owner goes back to 'manager' (what the two owners were before), the
-- owner guard and is_owner() are dropped, is_manager() goes back to testing
-- role = 'manager' only, and the role CHECK goes back to manager/employee.
--
-- WITH THE NEW CODE STILL LIVE. Every manager gate keeps working (a manager
-- is still a manager), but nobody is an owner any more, so the
-- personal-finance pages (/money, /dial, /safe) refuse everyone. Roll the CRM
-- back too if those pages are needed, or re-run migration_31.sql.
--
-- DATA LOST: none. Roles change from 'owner' to 'manager'; nothing else.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

drop trigger if exists profiles_owner_guard on public.profiles;
drop function if exists public.guard_owner_profiles();

update public.profiles set role = 'manager' where role = 'owner';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('manager', 'employee'));

create or replace function public.is_manager()
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager'
  );
$$;

drop function if exists public.is_owner();

commit;
