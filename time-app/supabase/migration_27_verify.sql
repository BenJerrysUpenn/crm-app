-- ============================================================================
-- Withers Time — verification for migration 27 (payroll choices and submittal)
--
-- Run by hand against a database with migrations 25, 26 and 27 applied, the
-- same way as migration_25_verify.sql (see its header). Everything happens
-- inside one transaction that ends in ROLLBACK, including the submittal it
-- gives. It works on a pay period from 2019, which no real punch falls in, and
-- needs one active manager and one employee in public.profiles. A clean run
-- ends with "migration 27 verified".
--
-- WHAT IS CHECKED
--   1. Periods end every other Sunday on the 2026-09-20 cycle: an off-cycle
--      window_end is refused by the CHECK on both tables and by the trigger.
--   2. A period that has not ended cannot be submitted.
--   3. An open punch with no scheduled shift blocks the submittal (1.4); with
--      a shift it still blocks (1.1); closed, it does not.
--   4. A manager submits as themselves; the row is 'submitted_pending_stage'.
--   5. Submittal is final: an update or delete is refused, and so is a
--      second submittal.
--   6. Every choice dated inside the submitted run is locked.
--   7. No API role (anon, authenticated, service_role) can execute any
--      function this migration defines, so none is on /rest/v1/rpc.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  v_end    date := date '2026-09-20' - 14 * 200;  -- on the cycle, in 2019
  v_day    date;
  v_punch  bigint;
  v_shift  bigint;
  refused  boolean;
  n        integer;
  r        text;
  f        text;
begin
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need one active manager and one employee in profiles to run this file';
  end if;
  if extract(isodow from v_end) <> 7 then raise exception 'fixture: % is not a Sunday', v_end; end if;
  v_day := v_end - 3;

  -- ---- 1. the fortnightly cycle ------------------------------------------------
  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end + 7, mgr);
    refused := false;
  exception when check_violation or raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'an off-cycle window_end (%) was accepted as a submittal', v_end + 7; end if;

  begin
    insert into public.payroll_rulings (window_end, check_id, finding_key, choice)
    values (v_end + 7, '1.9', '1.9:' || v_day, 'skip');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'an off-cycle window_end was accepted on payroll_rulings'; end if;

  -- ---- 2. not before the period ends -------------------------------------------
  begin
    insert into public.payroll_run_submittals (window_end, submitted_by)
    values (date '2026-09-20' + 14 * 100, mgr);
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a period that has not ended was submitted'; end if;

  -- ---- 3. open punches ---------------------------------------------------------
  insert into public.time_entries (employee_id, clock_in_at, status)
  values (emp, (v_day + time '12:00') at time zone 'America/New_York', 'open')
  returning id into v_punch;

  select count(*) into n from public.payroll_punch_blockers(v_end) b
   where b.check_id = '1.4' and b.punch_id = v_punch;
  if n <> 1 then raise exception 'an open punch with no shift is not a 1.4 blocker'; end if;

  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a run with an open, unscheduled punch was submitted'; end if;

  insert into public.shifts (employee_id, starts_at, ends_at, position)
  values (emp, (v_day + time '11:00') at time zone 'America/New_York',
               (v_day + time '17:00') at time zone 'America/New_York', 'PENN Opener')
  returning id into v_shift;

  select count(*) into n from public.payroll_punch_blockers(v_end) b
   where b.check_id = '1.1' and b.punch_id = v_punch;
  if n <> 1 then raise exception 'an open punch with a shift does not block as 1.1'; end if;

  update public.time_entries
     set clock_out_at = (v_day + time '17:00') at time zone 'America/New_York', status = 'closed'
   where id = v_punch;

  select count(*) into n from public.payroll_punch_blockers(v_end);
  if n <> 0 then raise exception 'a normal closed punch still blocks (% rows)', n; end if;

  -- ---- 4. a manager submits, as themselves -------------------------------------
  -- A choice first, so the lock below has something to lock.
  insert into public.payroll_rulings (window_end, check_id, finding_key, choice)
  values (v_end, '1.9', '1.9:' || v_day, 'skip');

  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, emp);
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager submitted in somebody else''s name'; end if;

  insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
  reset role;

  if (select status from public.payroll_run_submittals where window_end = v_end) <> 'submitted_pending_stage' then
    raise exception 'the submittal is not submitted_pending_stage';
  end if;

  -- ---- 5. final ----------------------------------------------------------------
  begin
    update public.payroll_run_submittals set note = 'changed' where window_end = v_end;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a submittal was edited'; end if;

  begin
    delete from public.payroll_run_submittals where window_end = v_end;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a submittal was deleted'; end if;

  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
    refused := false;
  exception when unique_violation or raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a run was submitted twice'; end if;

  -- ---- 6. choices in the run are locked ----------------------------------------
  begin
    update public.payroll_rulings set choice = 'scheduled_closer' where finding_key = '1.9:' || v_day;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a choice in a submitted run was changed'; end if;

  -- ---- 7. nothing on /rest/v1/rpc ----------------------------------------------
  foreach f in array array[
    'public.payroll_case_date(text, text)',
    'public.payroll_submitted_window_for(date)',
    'public.payroll_punch_blockers(date)',
    'public.guard_payroll_ruling()',
    'public.guard_payroll_run_submittal()'
  ] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% can execute %', r, f;
      end if;
    end loop;
  end loop;

  raise notice 'migration 27 verified';
end $$;

rollback;
