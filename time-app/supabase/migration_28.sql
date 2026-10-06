-- ============================================================================
-- Withers Time — migration 28: employees cannot change their own hourly_rate
-- or active flag
-- Run once in the Supabase SQL editor, after migration_26.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_28_verify.sql. ROLLBACK. supabase/migration_28_down.sql.
--
-- THE HOLE. profiles_update_self (migration.sql) lets any signed-in person
-- update their OWN profile row, and it does not restrict columns. Migration 26
-- put a guard trigger on the three payroll columns it cared about (role,
-- qbo_employee_id, pay_type). Two more columns on the same row are pay:
--
--   hourly_rate — what the payroll sheet multiplies hours by. An employee
--                 could PATCH their own rate through /rest/v1/profiles.
--   active      — who is on the roster, the staff pickers (§3.5, §3.7) and
--                 the schedule. An employee could reactivate themselves after
--                 offboarding, or drop themselves off it.
--
-- THE FIX. The same guard, extended to five columns. CREATE OR REPLACE on the
-- function migration 26 made, so the trigger migration 26 made keeps firing
-- and there is still exactly one guard (bj-finance #519, 2026-09-27).
-- Migration 26 is not edited: it is applied, and this file is the change.
--
-- WHO STILL WRITES THESE COLUMNS, and why the guard does not stop them:
--   * a manager, through RLS (profiles_manager_all): the Team page PATCH
--     /api/profiles/:id, and the invite route's fallback upsert;
--   * the service role, where auth.uid() is null: the invite upsert
--     (POST /api/profiles, active = true and hourly_rate), and the staffing
--     forms' offboarding mark_inactive step (active = false; crm-app PR #19,
--     not merged yet), both behind a manager check in the route; and the SQL
--     editor.
-- An employee's own edits (AccountForm: full_name, phone, notif_prefs) never
-- touch a guarded column, and an update that writes a guarded column back
-- unchanged is not a change, so it is not refused.
-- ============================================================================

-- Migration 26 added two of the columns this function reads. Without them the
-- function would still compile (PL/pgSQL binds late) and then fail on EVERY
-- profile update, so refuse to run rather than break the Account page.
do $$
begin
  if not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles' and column_name = 'qbo_employee_id')
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles' and column_name = 'pay_type') then
    raise exception 'migration 28 needs migration 26 (profiles.qbo_employee_id, profiles.pay_type). Apply migration_26.sql first.';
  end if;
end $$;

create or replace function public.guard_payroll_profile_columns()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.qbo_employee_id is distinct from old.qbo_employee_id
      or new.pay_type is distinct from old.pay_type
      or new.role is distinct from old.role
      or new.hourly_rate is distinct from old.hourly_rate
      or new.active is distinct from old.active)
     and auth.uid() is not null
     and not (select public.is_manager()) then
    raise exception 'Only a manager may change role, qbo_employee_id, pay_type, hourly_rate or active'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.guard_payroll_profile_columns() is
  'BEFORE UPDATE on profiles: only a manager (or a server context with no auth.uid()) may change role, qbo_employee_id, pay_type, hourly_rate or active. Migrations 26 and 28.';

-- Trigger-only, as in migration 26. CREATE OR REPLACE keeps existing grants,
-- so this is belt and braces: it also covers a database where the function
-- was created by some other route.
revoke execute on function public.guard_payroll_profile_columns() from public, anon, authenticated, service_role;

-- The trigger itself is migration 26's and already points at this function.
-- Recreated here so a re-run, or a database where it was dropped by hand,
-- still ends with exactly one guard.
drop trigger if exists profiles_payroll_columns_guard on public.profiles;
create trigger profiles_payroll_columns_guard
  before update on public.profiles
  for each row execute function public.guard_payroll_profile_columns();
