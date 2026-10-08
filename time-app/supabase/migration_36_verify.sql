-- ============================================================================
-- Withers Time, verification for migration 36 (the pay table on the payroll page)
--
-- Run by hand against a database with migration 36 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK, including the submittal it gives. It works
-- on a pay period from 2019, which no real punch falls in, and needs one active
-- manager and one employee in public.profiles. A clean run ends with
-- "migration 36 verified".
--
-- Inside one transaction now() does not move, so "changed after the build"
-- is staged with row_audit rows dated by hand, never by waiting.
--
-- WHAT IS CHECKED
--   1. Managers read payroll_sheets; an employee reads nothing; nobody signed
--      in can insert, update or delete a row, not even a manager.
--   2. A request is queued with nothing but its period; one per period in
--      flight; off-cycle periods are refused.
--   3. Claiming stamps started_at; finishing stamps built_at; a built row is
--      frozen and no row can be deleted. A failed build says why and carries
--      no sheet.
--   4. A build by hand needs started_at, not in the future.
--   5. Choices are audited: a reset (DELETE) leaves a row_audit row.
--   6. payroll_inputs_changed_at() counts a punch or shift from the day before
--      the period to 05:00 the day after it, and a choice for the period;
--      nothing else.
--   7. The submittal is refused with no pay table, over one with open items,
--      and over one built before the latest change; accepted over a fresh one.
--   8. No API role can execute any function this migration defines.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  v_end    date := date '2026-09-20' - 14 * 202;  -- on the cycle, in 2018
  v_day    date;
  v_req    bigint;
  v_id     bigint;
  v_audit  bigint;
  v_at     timestamptz;
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

  -- ---- 2. a request ---------------------------------------------------------------
  insert into public.payroll_sheets (window_end, requested_by) values (v_end, mgr)
  returning id into v_req;
  if (select status from public.payroll_sheets where id = v_req) <> 'queued' then
    raise exception 'a request is not queued';
  end if;

  begin
    insert into public.payroll_sheets (window_end, requested_by) values (v_end, mgr);
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'two requests for one period were in flight'; end if;

  begin
    insert into public.payroll_sheets (window_end, sheet) values (v_end - 14, '{}'::jsonb);
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a request was inserted carrying a sheet'; end if;

  begin
    insert into public.payroll_sheets (window_end) values (v_end + 7);
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'an off-cycle period was accepted'; end if;

  -- ---- 1. who may read and write ----------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.payroll_sheets where id = v_req;
  if n <> 1 then raise exception 'a manager cannot read payroll_sheets'; end if;
  begin
    insert into public.payroll_sheets (window_end, requested_by) values (v_end - 14, mgr);
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager inserted into payroll_sheets directly'; end if;
  begin
    update public.payroll_sheets set status = 'building' where id = v_req;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager updated payroll_sheets directly'; end if;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.payroll_sheets;
  reset role;
  if n <> 0 then raise exception 'an employee can read payroll_sheets'; end if;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 3. claim, build, freeze ------------------------------------------------------
  update public.payroll_sheets set status = 'building' where id = v_req;
  if (select started_at from public.payroll_sheets where id = v_req) is null then
    raise exception 'claiming a request did not stamp started_at';
  end if;

  begin
    update public.payroll_sheets set status = 'built' where id = v_req;
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a build was finished with no sheet'; end if;

  update public.payroll_sheets
     set status = 'built', built_by = 'verify', source_fingerprint = 'x',
         sheet = '{"open_items": [{"code": "roster.unmapped"}]}'::jsonb, open_items = 1
   where id = v_req;
  if (select built_at from public.payroll_sheets where id = v_req) is null then
    raise exception 'finishing a build did not stamp built_at';
  end if;

  begin
    update public.payroll_sheets set open_items = 0 where id = v_req;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a built pay table was changed'; end if;

  begin
    delete from public.payroll_sheets where id = v_req;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a pay table build was deleted'; end if;

  insert into public.payroll_sheets (window_end) values (v_end) returning id into v_id;
  update public.payroll_sheets set status = 'building' where id = v_id;
  begin
    update public.payroll_sheets set status = 'failed' where id = v_id;
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a build failed without saying why'; end if;
  update public.payroll_sheets set status = 'failed', error = 'boom' where id = v_id;
  begin
    update public.payroll_sheets set status = 'building' where id = v_id;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a failed build was restarted'; end if;

  -- ---- 4. a build by hand -----------------------------------------------------------
  begin
    insert into public.payroll_sheets (window_end, status, built_by, source_fingerprint, sheet, open_items)
    values (v_end, 'built', 'verify', 'x', '{}'::jsonb, 0);
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a build by hand was accepted with no started_at'; end if;
  begin
    insert into public.payroll_sheets (window_end, status, started_at, built_by, source_fingerprint, sheet, open_items)
    values (v_end, 'built', now() + interval '1 hour', 'verify', 'x', '{}'::jsonb, 0);
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a build by hand was accepted starting in the future'; end if;

  -- ---- 7a. no pay table, open items ------------------------------------------------
  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end - 14, mgr);
    refused := false;
  exception when raise_exception then
    refused := sqlerrm like 'Build the pay table%';
  end;
  if not refused then raise exception 'a run with no pay table was submitted'; end if;

  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
    refused := false;
  exception when raise_exception then
    refused := sqlerrm like '%1 open item%';
  end;
  if not refused then raise exception 'a run was submitted over a pay table with open items'; end if;

  -- ---- 5. choices are audited ------------------------------------------------------
  insert into public.payroll_rulings (window_end, check_id, finding_key, choice)
  values (v_end, '1.9', '1.9:' || v_day, 'skip')
  returning id into v_id;
  delete from public.payroll_rulings where id = v_id;
  select count(*) into n from public.row_audit
   where table_name = 'payroll_rulings' and row_id = v_id and op in ('INSERT', 'DELETE');
  if n <> 2 then raise exception 'payroll_rulings writes are not audited (% rows)', n; end if;

  -- ---- 6. what bears on the period --------------------------------------------------
  -- Synthetic audit rows, an hour ahead so they outrank everything above.
  v_at := now() + interval '1 hour';
  insert into public.row_audit (table_name, row_id, op, at, db_role, after_image)
  values ('time_entries', -1, 'INSERT', v_at, 'verify',
          jsonb_build_object('clock_in_at', ((v_end + 1) + time '10:00') at time zone 'America/New_York'))
  returning id into v_audit;
  if public.payroll_inputs_changed_at(v_end) >= v_at then
    raise exception 'a Monday-morning punch after the period made its pay table stale';
  end if;
  update public.row_audit
     set after_image = jsonb_build_object('clock_in_at', ((v_end + 1) + time '04:30') at time zone 'America/New_York')
   where id = v_audit;
  if public.payroll_inputs_changed_at(v_end) is distinct from v_at then
    raise exception 'a punch before 05:00 the day after the period was not counted';
  end if;
  update public.row_audit
     set table_name = 'shifts',
         after_image = null,
         before_image = jsonb_build_object('starts_at', ((v_end - 14) + time '18:00') at time zone 'America/New_York')
   where id = v_audit;
  if public.payroll_inputs_changed_at(v_end) is distinct from v_at then
    raise exception 'a deleted shift on the day before the period was not counted';
  end if;
  update public.row_audit
     set before_image = jsonb_build_object('starts_at', ((v_end - 15) + time '18:00') at time zone 'America/New_York')
   where id = v_audit;
  if public.payroll_inputs_changed_at(v_end) >= v_at then
    raise exception 'a shift two days before the period was counted';
  end if;
  update public.row_audit
     set table_name = 'payroll_rulings',
         before_image = jsonb_build_object('window_end', v_end + 14, 'case_date', v_day)
   where id = v_audit;
  if public.payroll_inputs_changed_at(v_end) is distinct from v_at then
    raise exception 'a choice dated inside the period was not counted';
  end if;

  -- ---- 7b. stale, then fresh -------------------------------------------------------
  insert into public.payroll_sheets (window_end, status, started_at, built_by, source_fingerprint, sheet, open_items)
  values (v_end, 'built', now(), 'verify', 'y', '{"open_items": []}'::jsonb, 0);

  begin
    insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
    refused := false;
  exception when raise_exception then
    refused := sqlerrm like '%after the pay table was built%';
  end;
  if not refused then raise exception 'a run was submitted over a stale pay table'; end if;

  delete from public.row_audit where id = v_audit;
  insert into public.payroll_run_submittals (window_end, submitted_by) values (v_end, mgr);
  if not exists (select 1 from public.payroll_run_submittals where window_end = v_end) then
    raise exception 'a run with a fresh, clean pay table was not submitted';
  end if;

  -- ---- 8. nothing on /rest/v1/rpc ------------------------------------------------
  foreach f in array array[
    'public.guard_payroll_sheet()',
    'public.payroll_inputs_changed_at(date)',
    'public.guard_payroll_run_submittal()'
  ] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% can execute %', r, f;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.payroll_sheets', 'insert')
       or has_table_privilege(r, 'public.payroll_sheets', 'update')
       or has_table_privilege(r, 'public.payroll_sheets', 'delete') then
      raise exception '% can write payroll_sheets', r;
    end if;
  end loop;

  raise notice 'migration 36 verified';
end $$;

rollback;
