-- ============================================================================
-- Withers Time, migration 34: staff cannot claim a catering shift
-- Run once in the Supabase SQL editor, after migration_33.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_34_verify.sql. ROLLBACK. supabase/migration_34_down.sql.
--
-- WHY. The CRM writes one open shift per crew member when a catering deal is
-- booked, stamped with shifts.deal_id. Since drafts were removed (migration
-- 33) those shifts are live, so staff could take one. Alina, 2026-10-03:
-- "they should wait to be assigned by a manager." The time app refuses it in
-- POST /api/shifts/:id/claim and /request-pickup (lib/managerAssigns.ts). This
-- file closes the other door: shifts_claim (migration_4.sql) still lets a
-- signed-in employee set employee_id to themselves on any open published shift
-- through /rest/v1/shifts with their own session.
--
-- WHAT THIS DOES. Adds one BEFORE UPDATE trigger on shifts. For a signed-in
-- non-manager, changing employee_id on a shift that has a deal_id is refused.
-- Managers (the schedule, approving requests), the service role (shift ack,
-- the catering shift writer) and the SQL editor are not checked, the same
-- split guard_shift_claim (migration 30) uses.
--
-- ADDITIVE ONLY. One new function and one new trigger. No table, column,
-- policy, existing function or row is changed. guard_shift_claim and
-- shifts_claim stay as they are, so a staff claim of an ordinary open shift
-- is unaffected.
--
-- APPLY ORDER. Either order with the code. The app checks first, so this only
-- ever refuses a write that went around it.
--
-- (select public.is_manager()) is wrapped in a scalar subquery, as everywhere
-- in this project (crm/004).
-- ============================================================================

begin;

create or replace function public.guard_catering_shift_claim()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'authenticated' or (select public.is_manager()) then
    return new;
  end if;
  if old.deal_id is not null and new.employee_id is distinct from old.employee_id then
    raise exception 'Catering shifts are assigned by a manager'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function public.guard_catering_shift_claim() is
  'BEFORE UPDATE on shifts: a signed-in non-manager may not change employee_id on a catering shift (deal_id set). A manager assigns those. Migration 34.';

-- Trigger-only: keep it off /rest/v1/rpc.
revoke execute on function public.guard_catering_shift_claim() from public, anon, authenticated, service_role;

drop trigger if exists shifts_catering_assign_guard on public.shifts;
create trigger shifts_catering_assign_guard
  before update on public.shifts
  for each row execute function public.guard_catering_shift_claim();

commit;
