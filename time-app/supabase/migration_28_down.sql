-- ============================================================================
-- Withers Time — rollback for migration 28 (hourly_rate and active guard)
--
-- Puts guard_payroll_profile_columns() back to its migration 26 body: the
-- guard then covers role, qbo_employee_id and pay_type only, and an employee
-- can again change their OWN hourly_rate and active flag through
-- profiles_update_self, as before migration 28.
--
-- DATA LOST: none. Only the function body changes; the trigger, every column
-- and every row are left as they are.
--
-- To remove the guard altogether, roll back migration 26 as well
-- (migration_26_down.sql, after migration_27_down.sql). Run in the Supabase SQL
-- editor. Safe to re-run.
-- ============================================================================

begin;

-- Migration 26's function, verbatim.
create or replace function public.guard_payroll_profile_columns()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.qbo_employee_id is distinct from old.qbo_employee_id
      or new.pay_type is distinct from old.pay_type
      or new.role is distinct from old.role)
     and auth.uid() is not null
     and not (select public.is_manager()) then
    raise exception 'Only a manager may change role, qbo_employee_id or pay_type'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- Migration 26 set no comment on the function.
comment on function public.guard_payroll_profile_columns() is null;

revoke execute on function public.guard_payroll_profile_columns() from public, anon, authenticated, service_role;

commit;
