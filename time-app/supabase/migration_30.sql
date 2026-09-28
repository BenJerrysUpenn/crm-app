-- ============================================================================
-- Withers Time, migration 30: staff cannot write their own punches, and a
-- shift claim can set the claimer and nothing else
-- Run once in the Supabase SQL editor, after migration_29.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_30_verify.sql. ROLLBACK. supabase/migration_30_down.sql.
--
-- APPLY ORDER. Deploy the time app FIRST, then run this file. The old code
-- clocks employees in and out, and snoozes the clock-out nudge, through the
-- employee's own session, which this file refuses. The new code does those
-- three writes with the service role after its own checks, so it works with
-- or without this file applied. Running this file while the old code is live
-- stops every employee from clocking in or out on the web clock until the new
-- code is deployed. Fob taps on the Pi are not affected either way.
--
-- ---------------------------------------------------------------------------
-- HOLE 1 (audit H1). time_insert and time_update (migration.sql) let any
-- signed-in person insert a time_entries row for themselves, or update their
-- own rows, through /rest/v1/time_entries with the public key and their own
-- session. No column is restricted. An employee could insert a whole shift
-- they never worked, or move clock_in_at / clock_out_at on a real one. That
-- skips the geofence and the clock-in reminder gate in /api/clock, and payroll
-- reads time_entries.
--
-- FIX. Through RLS, only a manager may insert or update a time entry (the
-- Timesheets page: POST and PATCH /api/time-entries). Employees keep reading
-- their own rows (time_select is unchanged) and still cannot delete (migration
-- 12). Every legitimate employee write already goes through a server route or
-- the Pi, and those now use the service role:
--
--   writer                                   client          after this file
--   POST /api/clock  (in, out)               service role    unchanged
--   POST /api/time-entries/:id/clockout-     service role    unchanged
--        reminder (snooze, dismiss)
--   the Pi fob clock (listener.py)           service role    unchanged
--   GET  /api/cron/missed-clockins           service role    unchanged
--   POST/PATCH/DELETE /api/time-entries      manager session unchanged
--
-- The route stamps the clock-in and clock-out time itself (the column default
-- now(), and the server's clock on the way out), after the reminder gate and
-- the geofence. There is no RLS path left that lets an employee choose a time.
--
-- ---------------------------------------------------------------------------
-- HOLE 2 (audit M2). shifts_claim (migration_4.sql) lets a signed-in person
-- update an open, published shift as long as the result names them. It does
-- not restrict columns, so the same update could move starts_at and ends_at,
-- change the position, or re-point deal_id.
--
-- FIX. A BEFORE UPDATE guard on shifts. For a signed-in non-manager, the only
-- change allowed is employee_id going from empty to themselves; updated_at is
-- stamped now() by the guard whatever was sent. Managers (shifts_manager_all)
-- pass is_manager(); the service role (the shift-ack route, the catering
-- shift writer) and the SQL editor do not run as the authenticated role. All
-- of those are left alone.
-- The policy itself is kept as it is, so /api/shifts/:id/claim keeps working.
--
-- (select public.is_manager()) is wrapped in a scalar subquery everywhere in
-- this file: a bare is_manager() is re-evaluated per row and has caused
-- statement timeouts in this project (crm/004).
-- ============================================================================

begin;

-- ---------- time_entries: managers only through RLS -------------------------
drop policy if exists time_insert on public.time_entries;
create policy time_insert on public.time_entries for insert to authenticated
  with check ((select public.is_manager()));

drop policy if exists time_update on public.time_entries;
create policy time_update on public.time_entries for update to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

-- ---------- shifts: a claim sets the claimer, nothing else -----------------
-- The comparison is on the whole row minus the two columns a claim may touch,
-- so a column added to shifts later is covered without editing this function.
create or replace function public.guard_shift_claim()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Only a request that runs as the API's signed-in role is checked. The
  -- service role, the table owner in the SQL editor, and SECURITY DEFINER
  -- code run as other roles and are trusted. (Keying on current_user rather
  -- than auth.uid() alone also leaves migration_25_verify.sql working: it
  -- writes shifts as the owner with a JWT set, to test attribution.)
  if current_user <> 'authenticated' or (select public.is_manager()) then
    return new;
  end if;

  if old.employee_id is not null or new.employee_id is distinct from auth.uid() then
    raise exception 'You can only claim an open shift for yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if (to_jsonb(new) - 'employee_id' - 'updated_at')
       is distinct from (to_jsonb(old) - 'employee_id' - 'updated_at') then
    raise exception 'Claiming a shift cannot change its times, position or anything else'
      using errcode = 'insufficient_privilege';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function public.guard_shift_claim() is
  'BEFORE UPDATE on shifts: a signed-in non-manager may only set employee_id from null to themselves (shifts_claim). Migration 30.';

-- Trigger-only: keep it off /rest/v1/rpc.
revoke execute on function public.guard_shift_claim() from public, anon, authenticated, service_role;

drop trigger if exists shifts_claim_guard on public.shifts;
create trigger shifts_claim_guard
  before update on public.shifts
  for each row execute function public.guard_shift_claim();

commit;
