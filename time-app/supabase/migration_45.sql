-- ============================================================================
-- Withers Time, migration 45: profiles.is_overhead (left out of the payroll
-- target)
-- Run once in the Supabase SQL editor, after migrations 28 and 42. Safe to
-- re-run.
--
-- VERIFY. supabase/migration_45_verify.sql. ROLLBACK. supabase/migration_45_down.sql.
--
-- WHY. Some staff are overhead: their pay is not part of the payroll target
-- (bj-finance #692, ruled 2026-10-15, a yes/no per person). An overhead person
-- is left out of
--   * fixed payroll on the control board (lib/controlBoard/load.ts), and so
--     out of the hourly goal the schedule's targets are built from;
--   * the Schedule page's hourly labor hours and $ (lib/controlBoard/schedule.ts);
--   * the average active hourly rate that prices open shifts and turns a
--     day's target $ into target hours.
-- They stay on the schedule grid and in its total hours like anyone else.
--
-- WHO SETS IT. A manager, as with pay_type and hourly_rate: managers update
-- every profile column through profiles_manager_all (migration.sql), so no
-- policy changes. Two guards already on profiles decide the rest:
--   * guard_payroll_profile_columns (migrations 26 and 28) is widened here to
--     cover is_overhead, so nobody but a manager (or a server context with no
--     auth.uid()) changes it. Without this an employee could mark their own
--     row overhead through profiles_update_self and drop out of the target.
--   * guard_owner_profiles (migration 42) is unchanged: an owner's row stays
--     owner-only, this column included.
-- There is no control for it on the Team page yet (its redesign is
-- bj-finance #719); until then it is set in the SQL editor.
--
-- NOT NULL DEFAULT false, so adding the column marks nobody overhead and every
-- number stays as it was until someone is flagged.
--
-- APPLY ORDER. Run this file FIRST, then deploy the time app.
--   * Old code, new database: the old code never reads the column. Nothing
--     changes until someone is flagged.
--   * New code, old database: the control board's read of the salaried team
--     filters on is_overhead, so the Targets tab and the Schedule page's
--     labor line would say the team could not be read until this file runs.
-- ============================================================================

begin;

-- Migration 28's guard covers columns that migration 26 added, and migration
-- 42's owner guard must already sit on profiles. Refuse to run without them
-- rather than leave an unguarded column.
do $$
begin
  if not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles' and column_name = 'pay_type') then
    raise exception 'migration 45 needs migration 26 (profiles.pay_type). Apply migration_26.sql and migration_28.sql first.';
  end if;
  if to_regprocedure('public.guard_owner_profiles()') is null then
    raise exception 'migration 45 needs migration 42 (the owner guard). Apply migration_42.sql first.';
  end if;
end $$;

-- ---------- the column --------------------------------------------------------
alter table public.profiles
  add column if not exists is_overhead boolean not null default false;

comment on column public.profiles.is_overhead is
  'True when the person is overhead: left out of the payroll target (fixed payroll on the control board, the Schedule page''s hourly labor and its average hourly rate). Still scheduled and counted in total hours. Set by a manager; an owner''s row by an owner. Migration 45 (bj-finance #692).';

-- ---------- the guard, widened to is_overhead ----------------------------------
-- Migration 28's function with is_overhead added and nothing else changed.
-- CREATE OR REPLACE, so the trigger migration 26 made keeps firing and there
-- is still exactly one guard.
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
      or new.active is distinct from old.active
      or new.is_overhead is distinct from old.is_overhead)
     and auth.uid() is not null
     and not (select public.is_manager()) then
    raise exception 'Only a manager may change role, qbo_employee_id, pay_type, hourly_rate, active or is_overhead'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.guard_payroll_profile_columns() is
  'BEFORE UPDATE on profiles: only a manager (or a server context with no auth.uid()) may change role, qbo_employee_id, pay_type, hourly_rate, active or is_overhead. Migrations 26, 28 and 45.';

-- Trigger-only, as in migrations 26 and 28.
revoke execute on function public.guard_payroll_profile_columns() from public, anon, authenticated, service_role;

drop trigger if exists profiles_payroll_columns_guard on public.profiles;
create trigger profiles_payroll_columns_guard
  before update on public.profiles
  for each row execute function public.guard_payroll_profile_columns();

commit;
