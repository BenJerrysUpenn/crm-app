-- ============================================================================
-- Withers Time, verification for migration 53 (the QBO submit chain's outcome
-- on the submittal)
--
-- Run by hand against a database with migration 53 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK, including the submittal it gives. It works
-- on a pay period from 2019, which no real punch falls in, and needs one active
-- manager in public.profiles. It builds a clean pay table for each period it
-- submits (migration 36's gate). A clean run ends with "migration 53 verified".
--
-- WHAT IS CHECKED
--   1. A submittal still starts as 'submitted_pending_stage'.
--   2. It moves through the chain's statuses, and its qbo_outcome and
--      qbo_outcome_at can be written, while what was submitted stays frozen.
--   3. A status outside the list is refused.
--   4. 'qbo_submitted' only moves to 'qbo_paystubs_sent'; 'qbo_paystubs_sent'
--      never moves; no qbo_ status goes back to 'submitted_pending_stage'.
--   5. No API role can execute the new trigger function.
-- ============================================================================

begin;

do $$
declare
  mgr     uuid;
  v_end   date := date '2026-09-20' - 14 * 210;   -- on the cycle, in 2019
  v_st    text;
  refused boolean;
  r       text;
  f       text;
begin
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  if mgr is null then
    raise exception 'migration 53 verify needs one active manager in public.profiles';
  end if;

  -- Migration 36: a run is submitted over a clean pay table built for it.
  insert into public.payroll_sheets (window_end, status, started_at, built_by, source_fingerprint, sheet, open_items)
  values (v_end, 'built', now(), 'verify', 'v53', '{"open_items": []}'::jsonb, 0);
  insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
  select status into v_st from public.payroll_run_submittals where window_end = v_end;
  if v_st <> 'submitted_pending_stage' then
    raise exception '1: a new submittal reads %', v_st;
  end if;

  -- 2. Through the chain's statuses, with the outcome written each time.
  foreach v_st in array array['qbo_previewed', 'qbo_stopped', 'qbo_outcome_unknown',
                              'qbo_previewed', 'qbo_submitted', 'qbo_paystubs_sent'] loop
    update public.payroll_run_submittals
       set status = v_st, qbo_outcome = 'step ' || v_st, qbo_outcome_at = now()
     where window_end = v_end;
  end loop;
  if (select qbo_outcome from public.payroll_run_submittals where window_end = v_end)
     <> 'step qbo_paystubs_sent' then
    raise exception '2: qbo_outcome was not written';
  end if;
  refused := false;
  begin
    update public.payroll_run_submittals set snapshot = '[{"x":1}]'::jsonb where window_end = v_end;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception '2: the snapshot could be changed'; end if;

  -- 4. qbo_paystubs_sent never moves.
  foreach v_st in array array['qbo_submitted', 'qbo_previewed', 'submitted_pending_stage'] loop
    refused := false;
    begin
      update public.payroll_run_submittals set status = v_st where window_end = v_end;
    exception when raise_exception then refused := true;
    end;
    if not refused then raise exception '4: qbo_paystubs_sent moved to %', v_st; end if;
  end loop;
end;
$$;

do $$
declare
  mgr     uuid;
  v_end   date := date '2026-09-20' - 14 * 212;
  v_st    text;
  refused boolean;
  r       text;
  f       text;
begin
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  -- Migration 36: a run is submitted over a clean pay table built for it.
  insert into public.payroll_sheets (window_end, status, started_at, built_by, source_fingerprint, sheet, open_items)
  values (v_end, 'built', now(), 'verify', 'v53', '{"open_items": []}'::jsonb, 0);
  insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);

  -- 3. Outside the list.
  refused := false;
  begin
    update public.payroll_run_submittals set status = 'paid' where window_end = v_end;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '3: status ''paid'' was accepted'; end if;

  -- 4. Back to pending is refused from any qbo_ status.
  update public.payroll_run_submittals set status = 'qbo_previewed' where window_end = v_end;
  refused := false;
  begin
    update public.payroll_run_submittals set status = 'submitted_pending_stage' where window_end = v_end;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception '4: qbo_previewed went back to pending'; end if;

  -- 4. qbo_submitted only moves forward.
  update public.payroll_run_submittals set status = 'qbo_submitted' where window_end = v_end;
  foreach v_st in array array['qbo_stopped', 'qbo_previewed', 'qbo_outcome_unknown',
                              'submitted_pending_stage'] loop
    refused := false;
    begin
      update public.payroll_run_submittals set status = v_st where window_end = v_end;
    exception when raise_exception then refused := true;
    end;
    if not refused then raise exception '4: qbo_submitted moved to %', v_st; end if;
  end loop;
  update public.payroll_run_submittals set qbo_outcome = 'same status, new words' where window_end = v_end;

  -- 5. No API role can execute the trigger function.
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.guard_payroll_run_submittal_status()', 'execute') then
      raise exception '5: % can execute guard_payroll_run_submittal_status()', r;
    end if;
  end loop;
  raise notice 'migration 53 verified';
end;
$$;

rollback;
