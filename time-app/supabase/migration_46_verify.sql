-- ============================================================================
-- Withers Time, verification for migration 46 (hourly payroll actuals)
--
-- Run by hand against a database with migration 46 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs a manager and an employee in
-- public.profiles. A clean run ends with "migration 46 verified". Every
-- name and figure below is invented.
--
-- WHAT IS CHECKED
--   1. The service role writes a paycheck and rewrites it on its key;
--      updated_at is the database's clock, whatever the writer sent. Two
--      paychecks for one person, period and pay date live side by side when
--      their year-to-date gross differs.
--   2. Shape: the source is 'paystub', a period does not end before it
--      starts, hours are not negative, a name is not blank, every figure is
--      present, and one key holds one row.
--   3. A manager reads the table; an employee does not; nobody signed in
--      writes, removes or empties it; anon reads nothing.
--   4. A profile link is cleared, not cascaded, if the profile goes.
--   5. labor_daily_actuals: written and rewritten on its day by the service
--      role only, its source, its day inside its period, hours not negative,
--      wages present; managers read, employees and anon do not.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  n        integer;
  t        timestamptz;
  refused  boolean;
  col      text;
  probe    jsonb;
  spare    uuid := gen_random_uuid();
  whole    jsonb := jsonb_build_object(
    'pay_date', '2018-07-18', 'period_start', '2018-07-02', 'period_end', '2018-07-15',
    'employee', 'Test Person', 'ytd_gross', 2.00, 'regular_hours', 1, 'regular_pay', 1,
    'overtime_hours', 0, 'overtime_pay', 0, 'catering_premium', 0, 'solo_close', 0,
    'source', 'paystub', 'built_by', 'verify-46-whole');
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. the service role writes, and rewrites on the key -----------------------------
  set local role service_role;
  insert into public.labor_paycheck_actuals
    (pay_date, period_start, period_end, employee, ytd_gross, profile_id,
     regular_hours, regular_pay, overtime_hours, overtime_pay,
     catering_premium, solo_close, source, built_by, updated_at)
  values (date '2018-06-20', date '2018-06-04', date '2018-06-17', 'Test Person',
          500.00, emp, 20.00, 300.00, 0, 0, 0, 30.00, 'paystub', 'verify-46',
          timestamptz '2001-01-01')
  returning updated_at into t;
  if t < now() - interval '1 minute' then raise exception 'updated_at was taken from the writer'; end if;

  insert into public.labor_paycheck_actuals
    (pay_date, period_start, period_end, employee, ytd_gross, profile_id,
     regular_hours, regular_pay, overtime_hours, overtime_pay,
     catering_premium, solo_close, source, built_by)
  values (date '2018-06-20', date '2018-06-04', date '2018-06-17', 'Test Person',
          500.00, emp, 21.00, 315.00, 0, 0, 0, 30.00, 'paystub', 'verify-46')
  on conflict (pay_date, period_start, period_end, employee, ytd_gross) do update
    set regular_hours = excluded.regular_hours, regular_pay = excluded.regular_pay,
        updated_at = timestamptz '2001-01-01';
  select count(*) into n from public.labor_paycheck_actuals
   where employee = 'Test Person' and regular_hours = 21.00
     and updated_at > now() - interval '1 minute';
  if n <> 1 then raise exception 'a rewritten paycheck did not take the database clock'; end if;

  -- A second paycheck the same day for the same period: a different ytd_gross.
  insert into public.labor_paycheck_actuals
    (pay_date, period_start, period_end, employee, ytd_gross,
     regular_hours, regular_pay, overtime_hours, overtime_pay,
     catering_premium, solo_close, source, built_by)
  values (date '2018-06-20', date '2018-06-04', date '2018-06-17', 'Test Person',
          650.00, 10.00, 150.00, 1.50, 33.75, 2.00, 0, 'paystub', 'verify-46');
  select count(*) into n from public.labor_paycheck_actuals where built_by = 'verify-46';
  if n <> 2 then raise exception 'two paychecks of one period and pay date did not both land'; end if;

  -- ---- 2. shape ----------------------------------------------------------------------
  -- Every figure is present: a whole paycheck lands, and the same paycheck
  -- missing any one figure is refused.
  insert into public.labor_paycheck_actuals
  select * from jsonb_populate_record(null::public.labor_paycheck_actuals, whole);
  delete from public.labor_paycheck_actuals where built_by = 'verify-46-whole';
  if not found then raise exception 'a whole paycheck did not land'; end if;
  foreach col in array array['ytd_gross', 'regular_hours', 'regular_pay', 'overtime_hours',
                             'overtime_pay', 'catering_premium', 'solo_close', 'source',
                             'built_by'] loop
    begin
      insert into public.labor_paycheck_actuals
      select * from jsonb_populate_record(null::public.labor_paycheck_actuals, whole - col);
      refused := false;
    exception when not_null_violation then
      refused := true;
    end;
    if not refused then raise exception 'a paycheck without its % was accepted', col; end if;
  end loop;
  -- Each check: the same whole paycheck with one field made wrong is refused.
  foreach probe in array array[
    jsonb_build_object('change', jsonb_build_object('source', 'schedule'),
                       'accepted', 'a source other than paystub was accepted'),
    jsonb_build_object('change', jsonb_build_object('period_start', '2018-07-16'),
                       'accepted', 'a period ending before it starts was accepted'),
    jsonb_build_object('change', jsonb_build_object('regular_hours', -1),
                       'accepted', 'negative regular hours were accepted'),
    jsonb_build_object('change', jsonb_build_object('overtime_hours', -1),
                       'accepted', 'negative overtime hours were accepted'),
    jsonb_build_object('change', jsonb_build_object('employee', '  '),
                       'accepted', 'a blank name was accepted')] loop
    begin
      insert into public.labor_paycheck_actuals
      select * from jsonb_populate_record(null::public.labor_paycheck_actuals,
                                          whole || (probe -> 'change'));
      refused := false;
    exception when check_violation then
      refused := true;
    end;
    if not refused then raise exception '%', probe ->> 'accepted'; end if;
  end loop;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-06-20', date '2018-06-04', date '2018-06-17', 'Test Person',
            500.00, 1, 1, 0, 0, 0, 0, 'paystub', 'verify-46');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'a second row for one paycheck was accepted'; end if;
  reset role;

  -- ---- 3. who reads ----------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.labor_paycheck_actuals where built_by = 'verify-46';
  if n <> 2 then raise exception 'a manager reads % of 2 paychecks', n; end if;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-07-04', date '2018-06-18', date '2018-07-01', 'Test Person',
            1.00, 1, 1, 0, 0, 0, 0, 'paystub', 'x');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager wrote a paycheck through the API'; end if;
  begin
    update public.labor_paycheck_actuals set regular_pay = 1 where built_by = 'verify-46';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager changed a paycheck through the API'; end if;
  begin
    delete from public.labor_paycheck_actuals where built_by = 'verify-46';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager removed a paycheck through the API'; end if;
  -- TRUNCATE skips row level security, so only the missing grant stops it.
  begin
    truncate public.labor_paycheck_actuals;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager emptied the paychecks'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.labor_paycheck_actuals;
  if n <> 0 then raise exception 'an employee can read paychecks'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if has_table_privilege('anon', 'public.labor_paycheck_actuals', 'select') then
    raise exception 'anon can read paychecks';
  end if;

  -- ---- 4. the profile link -----------------------------------------------------------------
  -- A login invented for this run gets a profile, a paycheck links to it, and
  -- the profile goes: the paycheck stays, unlinked.
  insert into auth.users (id, email, raw_user_meta_data)
  values (spare, 'verify-46@example.test', '{"full_name":"Verify 46"}');
  insert into public.labor_paycheck_actuals
    (pay_date, period_start, period_end, employee, ytd_gross, profile_id,
     regular_hours, regular_pay, overtime_hours, overtime_pay,
     catering_premium, solo_close, source, built_by)
  values (date '2018-07-18', date '2018-07-02', date '2018-07-15', 'Verify 46',
          100.00, spare, 1, 1, 0, 0, 0, 0, 'paystub', 'verify-46-link');
  delete from public.profiles where id = spare;
  select count(*) into n from public.labor_paycheck_actuals
   where built_by = 'verify-46-link' and profile_id is null;
  if n <> 1 then raise exception 'profile_id is not cleared when its profile goes'; end if;

  -- ---- 5. labor_daily_actuals -----------------------------------------------------------
  set local role service_role;
  insert into public.labor_daily_actuals
    (day, hours, wages, catering_premium, solo_close, period_start, period_end,
     source, built_by, updated_at)
  values (date '2018-06-05', 7.50, 112.50, 0, 0, date '2018-06-04', date '2018-06-17',
          'when_i_work', 'verify-46', timestamptz '2001-01-01')
  returning updated_at into t;
  if t < now() - interval '1 minute' then raise exception 'a day''s updated_at was taken from the writer'; end if;
  insert into public.labor_daily_actuals
    (day, hours, wages, catering_premium, solo_close, period_start, period_end,
     source, built_by)
  values (date '2018-06-05', 8.00, 120.00, 0, 30.00, date '2018-06-04', date '2018-06-17',
          'punches', 'verify-46')
  on conflict (day) do update
    set hours = excluded.hours, wages = excluded.wages, source = excluded.source;
  select count(*) into n from public.labor_daily_actuals
   where day = date '2018-06-05' and hours = 8.00 and source = 'punches';
  if n <> 1 then raise exception 'a day was not rewritten on its key'; end if;
  begin
    insert into public.labor_daily_actuals
      (day, hours, wages, catering_premium, solo_close, period_start, period_end,
       source, built_by)
    values (date '2018-06-06', 1, 1, 0, 0, date '2018-06-04', date '2018-06-17',
            'schedule', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day source other than when_i_work/punches was accepted'; end if;
  begin
    insert into public.labor_daily_actuals
      (day, hours, wages, catering_premium, solo_close, period_start, period_end,
       source, built_by)
    values (date '2018-06-20', 1, 1, 0, 0, date '2018-06-04', date '2018-06-17',
            'punches', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day outside its pay period was accepted'; end if;
  begin
    insert into public.labor_daily_actuals
      (day, hours, wages, catering_premium, solo_close, period_start, period_end,
       source, built_by)
    values (date '2018-06-06', -1, 1, 0, 0, date '2018-06-04', date '2018-06-17',
            'punches', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day with negative hours was accepted'; end if;
  begin
    insert into public.labor_daily_actuals
      (day, hours, catering_premium, solo_close, period_start, period_end,
       source, built_by)
    values (date '2018-06-06', 1, 0, 0, date '2018-06-04', date '2018-06-17',
            'punches', 'verify-46');
    refused := false;
  exception when not_null_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day without its wages was accepted'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.labor_daily_actuals where built_by = 'verify-46';
  if n <> 1 then raise exception 'a manager reads % of 1 day', n; end if;
  begin
    update public.labor_daily_actuals set wages = 1 where built_by = 'verify-46';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager changed a day through the API'; end if;
  begin
    truncate public.labor_daily_actuals;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager emptied the days'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.labor_daily_actuals;
  if n <> 0 then raise exception 'an employee can read days'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_table_privilege('anon', 'public.labor_daily_actuals', 'select') then
    raise exception 'anon can read days';
  end if;

  raise notice 'migration 46 verified';
end $$;

rollback;
