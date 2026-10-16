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
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  n        integer;
  t        timestamptz;
  refused  boolean;
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
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-07-04', date '2018-06-18', date '2018-07-01', 'Test Person',
            1.00, 1, 1, 0, 0, 0, 0, 'schedule', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a source other than paystub was accepted'; end if;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-07-04', date '2018-07-01', date '2018-06-18', 'Test Person',
            1.00, 1, 1, 0, 0, 0, 0, 'paystub', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a period ending before it starts was accepted'; end if;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-07-04', date '2018-06-18', date '2018-07-01', 'Test Person',
            1.00, -1, 1, 0, 0, 0, 0, 'paystub', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'negative hours were accepted'; end if;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-07-04', date '2018-06-18', date '2018-07-01', '  ',
            1.00, 1, 1, 0, 0, 0, 0, 'paystub', 'verify-46');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a blank name was accepted'; end if;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, overtime_hours, overtime_pay,
       catering_premium, solo_close, source, built_by)
    values (date '2018-07-04', date '2018-06-18', date '2018-07-01', 'Test Person',
            1.00, 1, 0, 0, 0, 0, 'paystub', 'verify-46');
    refused := false;
  exception when not_null_violation then
    refused := true;
  end;
  if not refused then raise exception 'a paycheck without its regular pay was accepted'; end if;
  begin
    insert into public.labor_paycheck_actuals
      (pay_date, period_start, period_end, employee, ytd_gross,
       regular_hours, regular_pay, overtime_hours, overtime_pay,
       catering_premium, solo_close, source)
    values (date '2018-07-04', date '2018-06-18', date '2018-07-01', 'Test Person',
            1.00, 1, 1, 0, 0, 0, 0, 'paystub');
    refused := false;
  exception when not_null_violation then
    refused := true;
  end;
  if not refused then raise exception 'a paycheck without built_by was accepted'; end if;
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
  select count(*) into n
    from information_schema.referential_constraints
   where constraint_schema = 'public'
     and constraint_name = 'labor_paycheck_actuals_profile_id_fkey'
     and delete_rule = 'SET NULL';
  if n <> 1 then raise exception 'profile_id is not cleared when its profile goes'; end if;

  raise notice 'migration 46 verified';
end $$;

rollback;
