-- ============================================================================
-- Withers Time, rollback for migration 45 (profiles.is_overhead)
--
-- DATA LOST: who is marked overhead. Save it first if it is wanted back:
--   copy (select id from public.profiles where is_overhead) to stdout with csv header;
--
-- Puts guard_payroll_profile_columns() back to its migration 28 body (role,
-- qbo_employee_id, pay_type, hourly_rate, active) and drops the column.
--
-- Roll back the time app's code FIRST: the code from migration 45 on filters
-- the control board's salaried team on is_overhead, and that read fails once
-- the column is gone.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

-- Migration 28's function, verbatim. It must be in place before the column
-- goes: the migration 45 body reads new.is_overhead on every profile update.
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

revoke execute on function public.guard_payroll_profile_columns() from public, anon, authenticated, service_role;

alter table public.profiles drop column if exists is_overhead;

commit;
